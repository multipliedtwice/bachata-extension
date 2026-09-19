const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { production, managedPair, before, after, withRepository } = require("./support/managedRepository.cjs");
const { workspaceChangeFrom } = require("../dist/runtime/pipelineRunPlan.js");

test("F1 missing action baseline is rejected before filesystem mutation", async () => {
  await withRepository(async ({ directory, turn, options, envelope }) => {
    delete options.repositoryBaseline;
    const result = await production.executeManagedBrowserEnvelope(envelope, turn, options, async () => "approve");
    assert.equal(result.actionResults[0].status, "rejected");
    assert.match(result.actionResults[0].stderr ?? result.actionResults[0].summary, /baseline.*missing/i);
    assert.equal(await fs.readFile(path.join(directory, "answer.ts"), "utf8"), before);
    assert.deepEqual(turn.changedFiles, []);
  });
});

test("F1/F2 managed write records its changes while retaining the task-start baseline", async () => {
  await withRepository(async ({ directory, baseline, turn, options, envelope }) => {
    await production.executeManagedBrowserEnvelope(envelope, turn, options, async () => "approve");
    assert.equal(await fs.readFile(path.join(directory, "answer.ts"), "utf8"), after);
    assert.deepEqual(turn.changedFiles, ["answer.ts"]);
    assert.equal(turn.repositoryBaseline, baseline);
    assert.equal(options.repositoryBaseline, baseline);
    assert.notDeepEqual(turn.workspaceSnapshot, baseline);
    assert.match(turn.diff, /answer = 42/);
    assert.deepEqual(managedPair.parseManagedRepositoryBaseline(turn.workspaceSnapshot), turn.workspaceSnapshot);
  });
});

test("F1 Git-ignored mutation target is denied before writing", async () => {
  await withRepository(async ({ directory, turn, options, envelope }) => {
    envelope.actions = [{ kind: "workspace.write", path: "ignored.ts", content: after, expectedFiles: [{ path: "ignored.ts", sha256: null }] }];
    await production.executeManagedBrowserEnvelope(envelope, turn, options, async () => "approve");
    await assert.rejects(fs.stat(path.join(directory, "ignored.ts")), { code: "ENOENT" });
    assert.deepEqual(turn.changedFiles, []);
  });
});

test("F2 Worker mutation, checkpoint round-trip, and Lead state retain the original diff", async () => {
  await withRepository(async ({ directory, baseline, turn, options, envelope, checkpoint, signal }) => {
    await production.executeManagedBrowserEnvelope(envelope, turn, options, async () => "approve");
    checkpoint.repositoryBaseline = baseline;
    checkpoint.workspaceSnapshot = baseline;
    checkpoint.workspaceFingerprint = managedPair.computeManagedWorkspaceFingerprint({ taskHash: checkpoint.taskHash, repositoryBaseline: baseline });
    let next = managedPair.advanceManagedPair(checkpoint, { type: "prepared" });
    next = managedPair.advanceManagedPair(next, { type: "workerRequestedPatch" });
    next = managedPair.advanceManagedPair(next, { type: "patchApplied", changedFiles: turn.changedFiles, diffSummary: turn.diff,
      repositoryBaseline: baseline, workspaceSnapshot: turn.workspaceSnapshot, workspaceFingerprint: turn.workspaceFingerprint });
    next = managedPair.advanceManagedPair(next, { type: "verificationCompleted", verification: [],
      repositoryBaseline: baseline, workspaceSnapshot: turn.workspaceSnapshot, workspaceFingerprint: turn.workspaceFingerprint });
    const restored = managedPair.parseManagedPairCheckpoint(JSON.parse(JSON.stringify(next)));
    assert.ok(restored);
    assert.deepEqual(restored.repositoryBaseline, baseline);
    assert.deepEqual(restored.workspaceSnapshot, turn.workspaceSnapshot);
    const leadState = await production.repositoryState(directory, [], signal, restored.repositoryBaseline, restored.changedFiles);
    assert.deepEqual(leadState.changedFiles, ["answer.ts"]);
    assert.match(leadState.diff, /answer = 42/);
    assert.deepEqual(leadState.preexistingChangedFiles, []);
  });
});

test("F2 subsequent fingerprint refresh invalidates verification without changing task attribution", async () => {
  await withRepository(async ({ directory, baseline, turn, options, envelope }) => {
    await production.executeManagedBrowserEnvelope(envelope, turn, options, async () => "approve");
    const oldFingerprint = turn.workspaceFingerprint;
    turn.verification = [{ id: "check", status: "passed", workspaceFingerprint: oldFingerprint }];
    await fs.writeFile(path.join(directory, "answer.ts"), "export const answer = 43;\n");
    await production.refreshManagedWorkspaceFingerprint(turn, options);
    assert.notEqual(turn.workspaceFingerprint, oldFingerprint);
    assert.deepEqual(turn.verification, []);
    assert.equal(turn.repositoryBaseline, baseline);
    const current = await production.repositoryState(directory, [], options.signal, turn.repositoryBaseline, turn.changedFiles);
    assert.deepEqual(current.changedFiles, ["answer.ts"]);
    assert.match(current.diff, /answer = 43/);
  });
});

test("R2 an edit before interruption counts against the persisted iteration baseline", async () => {
  await withRepository(async ({ directory, baseline, signal }) => {
    await fs.writeFile(path.join(directory, "answer.ts"), after);
    const atResume = await production.captureManagedRepositoryBaseline(directory, signal);
    const afterResume = await production.captureManagedRepositoryBaseline(directory, signal);
    assert.equal(workspaceChangeFrom({ before: baseline, after: afterResume }).workspaceChanged, true);
    assert.equal(workspaceChangeFrom({ before: atResume, after: afterResume }).workspaceChanged, false);
    assert.equal(workspaceChangeFrom({ before: undefined, after: afterResume }), undefined);
  });
});
