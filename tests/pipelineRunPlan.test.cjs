const assert = require("node:assert/strict");
const test = require("node:test");

const {
  checkpointAppliesTo,
  droppedRunSettings,
  droppedRunSettingsNotice,
  pipelineFailurePlan,
  pipelineTerminalPlan,
  resolvedRunConstraints,
  resumableWorkflowFrom,
  workspaceChangeFrom,
} = require("../dist/runtime/pipelineRunPlan.js");

const checkpoint = { version: 1, nextStepIndex: 2, snapshot: { roles: {} } };
const snapshot = () => ({
  hash: "hash-1",
  definition: { id: "review", name: "Review", steps: [] },
  dependencies: {},
});
const runSettings = {
  schema: "bachata.run-settings.v1",
  values: {},
  recorded: {},
  authority: {},
  secretReferences: [],
};

const workflow = (overrides = {}) =>
  resumableWorkflowFrom({
    pipelineId: "review",
    pipelineName: "Review",
    pipelineHash: "hash-1",
    totalSteps: 4,
    userPrompt: "look at this",
    attachmentIds: ["a1"],
    checkpoint,
    pipelineSnapshot: snapshot(),
    runSettings,
    constraints: {},
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

test("a caller's constraints win per key, and the resume fills the rest", () => {
  assert.deepEqual(
    resolvedRunConstraints({
      allowedPaths: ["/repo/docs"],
      writeScope: "task",
      resume: { allowedPaths: ["/repo/src"], writeScope: "workspace", commitMode: "never" },
    }),
    { allowedPaths: ["/repo/docs"], writeScope: "task", commitMode: "never" },
  );
  assert.deepEqual(
    resolvedRunConstraints({
      commitMode: "allow",
      resume: { commitMode: "never" },
    }),
    { commitMode: "allow" },
  );
});

test("a resume supplies every constraint the caller left open", () => {
  assert.deepEqual(
    resolvedRunConstraints({
      resume: { allowedPaths: ["/repo/src"], writeScope: "workspace", commitMode: "allow" },
    }),
    { allowedPaths: ["/repo/src"], writeScope: "workspace", commitMode: "allow" },
  );
});

test("a constraint nobody set stays absent rather than present and undefined", () => {
  const constraints = resolvedRunConstraints({});
  assert.deepEqual(constraints, {});
  assert.equal("allowedPaths" in constraints, false);
  assert.equal("writeScope" in constraints, false);
  assert.equal("commitMode" in constraints, false);
});

test("the allowed-path list is copied, not shared with the caller", () => {
  const allowedPaths = ["/repo"];
  const constraints = resolvedRunConstraints({ allowedPaths, commitMode: "allow" });
  allowedPaths.push("/elsewhere");
  assert.deepEqual(constraints.allowedPaths, ["/repo"]);
  assert.equal(constraints.commitMode, "allow");
});

test("the resumable record states the run it can be resumed into", () => {
  const record = workflow();
  assert.deepEqual(record, {
    runSettings,
    pipelineId: "review",
    pipelineName: "Review",
    pipelineHash: "hash-1",
    userPrompt: "look at this",
    attachmentIds: ["a1"],
    nextStepIndex: 2,
    totalSteps: 4,
    updatedAt: "2026-01-01T00:00:00.000Z",
    checkpoint,
    pipelineSnapshot: snapshot(),
  });
});

test("the record's snapshot is a clone, so a later catalog edit cannot rewrite history", () => {
  const pipelineSnapshot = snapshot();
  const record = workflow({ pipelineSnapshot });
  pipelineSnapshot.definition.name = "Renamed";
  assert.equal(record.pipelineSnapshot.definition.name, "Review");
});

test("the record's attachment list is a copy", () => {
  const attachmentIds = ["a1"];
  const record = workflow({ attachmentIds });
  attachmentIds.push("a2");
  assert.deepEqual(record.attachmentIds, ["a1"]);
});

test("resolved constraints travel into the record", () => {
  const record = workflow({
    constraints: { allowedPaths: ["/repo"], writeScope: "task", commitMode: "never" },
  });
  assert.deepEqual(record.allowedPaths, ["/repo"]);
  assert.equal(record.writeScope, "task");
  assert.equal(record.commitMode, "never");
});

test("the queue message a run came from is kept, the caller's before the resumed one", () => {
  assert.equal(
    workflow({ sourceQueueMessageId: "m-2", resumeSourceQueueMessageId: "m-1" })
      .sourceQueueMessageId,
    "m-2",
  );
  assert.equal(
    workflow({ resumeSourceQueueMessageId: "m-1" }).sourceQueueMessageId,
    "m-1",
  );
  assert.equal("sourceQueueMessageId" in workflow(), false);
});

test("dropped settings are the resumed refusals then the recorder's, in that order", () => {
  assert.deepEqual(
    droppedRunSettings([{ key: "a", reason: "not applicable" }], [{ key: "b", reason: "stale" }]),
    [{ key: "a", reason: "not applicable" }, { key: "b", reason: "stale" }],
  );
  assert.deepEqual(droppedRunSettings(undefined, [{ key: "b", reason: "stale" }]), [
    { key: "b", reason: "stale" },
  ]);
});

test("nothing is said when nothing was dropped", () => {
  assert.equal(droppedRunSettingsNotice([]), undefined);
});

test("the dropped-settings notice counts, names and reasons each refusal", () => {
  assert.equal(
    droppedRunSettingsNotice([{ key: "bachata.model", reason: "is not a known value" }]),
    "Bachata could not apply 1 recorded setting from this run's saved input, and used the current"
      + " value instead: bachata.model is not a known value.",
  );
  assert.match(
    droppedRunSettingsNotice([
      { key: "bachata.model", reason: "is not a known value" },
      { key: "bachata.timeout", reason: "is out of range" },
    ]),
    /2 recorded settings from .* instead: bachata\.model is not a known value; bachata\.timeout is out of range\.$/u,
  );
});

test("a checkpoint applies only to the record for the same pipeline at the same hash", () => {
  const run = { pipelineId: "review", pipelineHash: "hash-1" };
  assert.equal(checkpointAppliesTo({ pipelineId: "review", pipelineHash: "hash-1" }, run), true);
  assert.equal(checkpointAppliesTo({ pipelineId: "other", pipelineHash: "hash-1" }, run), false);
  assert.equal(checkpointAppliesTo({ pipelineId: "review", pipelineHash: "hash-2" }, run), false);
  assert.equal(checkpointAppliesTo(undefined, run), false);
});

const baseline = (overrides = {}) => ({
  isGitRepository: true,
  head: "abc",
  entries: [{ path: "src/a.ts", status: "M" }],
  ...overrides,
});

test("a workspace whose head or entries moved is reported as changed", () => {
  const change = workspaceChangeFrom({
    before: baseline(),
    after: baseline({ head: "def" }),
  });
  assert.equal(change.workspaceChanged, true);
  assert.match(change.workspaceFingerprint, /^[0-9a-f]{64}$/u);
});

test("an untouched workspace is reported unchanged with the same fingerprint", () => {
  const after = baseline();
  const change = workspaceChangeFrom({ before: baseline(), after });
  assert.equal(change.workspaceChanged, false);
  assert.equal(
    change.workspaceFingerprint,
    workspaceChangeFrom({ before: after, after }).workspaceFingerprint,
  );
});

test("nothing is claimed when either reading is missing or is not a repository", () => {
  assert.equal(workspaceChangeFrom({ before: undefined, after: baseline() }), undefined);
  assert.equal(workspaceChangeFrom({ before: baseline(), after: undefined }), undefined);
  assert.equal(
    workspaceChangeFrom({ before: baseline({ isGitRepository: false }), after: baseline() }),
    undefined,
  );
  assert.equal(
    workspaceChangeFrom({ before: baseline(), after: baseline({ isGitRepository: false }) }),
    undefined,
  );
});

test("an interrupted run keeps the record that is the only way back into it", () => {
  assert.deepEqual(pipelineTerminalPlan("interrupted"), {
    runStatus: "interrupted",
    keepResumable: true,
    statusText: "Pipeline interrupted.",
  });
});

test("a completed run drops its resumable record", () => {
  assert.deepEqual(pipelineTerminalPlan("completed"), {
    runStatus: "completed",
    keepResumable: false,
    statusText: "Pipeline completed.",
  });
});

test("a failure before acceptance and before recovery is not reported as a failed run", () => {
  assert.deepEqual(
    pipelineFailurePlan({ accepted: false, recoveryEstablished: false, resuming: false }),
    { recordFailure: false, restoreResume: false },
  );
});

test("acceptance alone, or a recovery record alone, makes the failure worth recording", () => {
  assert.equal(
    pipelineFailurePlan({ accepted: true, recoveryEstablished: false, resuming: false })
      .recordFailure,
    true,
  );
  assert.equal(
    pipelineFailurePlan({ accepted: false, recoveryEstablished: true, resuming: false })
      .recordFailure,
    true,
  );
});

test("a resume that failed before replacing its own record puts that record back", () => {
  assert.equal(
    pipelineFailurePlan({ accepted: false, recoveryEstablished: false, resuming: true })
      .restoreResume,
    true,
  );
  assert.equal(
    pipelineFailurePlan({ accepted: true, recoveryEstablished: true, resuming: true })
      .restoreResume,
    false,
  );
});
