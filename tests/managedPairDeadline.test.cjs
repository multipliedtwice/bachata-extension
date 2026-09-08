const assert = require("node:assert/strict");
const test = require("node:test");

const {
  advanceManagedPair,
  createManagedPairCheckpoint,
  computeManagedWorkspaceFingerprint,
  parseManagedPairCheckpoint,
} = require("../dist/orchestrator/managedPair.js");

test("managed pair preserves one absolute deadline across role-state transitions", () => {
  const deadlineAt = Date.now() + 60000;
  let checkpoint = createManagedPairCheckpoint({
    taskId: "deadline-task",
    originalTask: "change source",
    worktreePath: "/tmp/work",
    writeScope: "configured",
    allowedPaths: ["src"],
    requiredVerificationCheckIds: ["build"],
    deadlineAt,
  });
  assert.equal(checkpoint.deadlineAt, deadlineAt);

  checkpoint = advanceManagedPair(checkpoint, { type: "prepared" });
  const repositoryBaseline = { isGitRepository: false, head: "", entries: [] };
  const workspaceFingerprint = computeManagedWorkspaceFingerprint({
    taskHash: checkpoint.taskHash,
    repositoryBaseline,
  });
  checkpoint = advanceManagedPair(checkpoint, {
    type: "verificationCompleted",
    workspaceFingerprint,
    repositoryBaseline,
    verification: [{ id: "build", status: "passed", summary: "ok", workspaceFingerprint }],
  });
  checkpoint = advanceManagedPair(checkpoint, { type: "workerDone" });
  assert.equal(checkpoint.deadlineAt, deadlineAt);
  assert.equal(parseManagedPairCheckpoint(JSON.parse(JSON.stringify(checkpoint))).deadlineAt, deadlineAt);
  const { deadlineAt: _removed, ...legacy } = checkpoint;
  assert.equal(parseManagedPairCheckpoint(legacy), undefined);
});
