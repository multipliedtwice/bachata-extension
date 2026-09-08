const assert = require("node:assert/strict");
const test = require("node:test");

const {
  approvalIsStale,
  discardReturnsToIdle,
  resultIsStale,
  resumeRefusal,
  taskResetBaseline,
  taskResetClearedKeys,
} = require("../dist/runtime/recoveryTransition.js");

// EX-AUD-12. What survives a reset or a cancellation, and what may not come back afterwards.
// Each of these was a comparison written beside the write it guards, at a dozen call sites.

test("a reset ends the task and leaves the session it ran in alone", () => {
  const baseline = taskResetBaseline();
  assert.deepEqual(baseline, {
    transcript: [],
    transcriptTotal: 0,
    transcriptHasMore: false,
    approvals: [],
    attachments: [],
    queuedMessages: [],
    queuePaused: false,
    roles: {},
    running: false,
    workflowStatus: "idle",
  });
  // Nothing about the workspace, the selected pipeline or the agents: a reset ends a task.
  for (const key of ["workingDirectory", "selectedPipelineId", "agents", "browserBridge", "taskId"]) {
    assert.equal(key in baseline, false, key);
  }
  // Each call is its own value, so applying it to one task cannot alias another's arrays.
  assert.notEqual(taskResetBaseline().transcript, baseline.transcript);
});

test("the keys a reset removes are removed, not blanked", () => {
  assert.deepEqual([...taskResetClearedKeys], [
    "transcriptError",
    "activeStep",
    "activeStepId",
    "consensusRound",
    "pendingGate",
    "resumableWorkflow",
  ]);
  // What the runtime does with the list: an absent key, not a key holding undefined.
  const state = {
    transcriptError: "boom",
    activeStep: "implement",
    activeStepId: "step-3",
    consensusRound: 2,
    pendingGate: { stepId: "review" },
    resumableWorkflow: { nextStepIndex: 1 },
    workingDirectory: "/repo",
  };
  Object.assign(state, taskResetBaseline());
  taskResetClearedKeys.forEach((key) => {
    Reflect.deleteProperty(state, key);
  });
  taskResetClearedKeys.forEach((key) => {
    assert.equal(key in state, false, key);
  });
  assert.equal(state.workingDirectory, "/repo");
  assert.equal(state.workflowStatus, "idle");
});

test("a result from the task that is running now, uncancelled, is not stale", () => {
  assert.equal(resultIsStale({ operationTaskId: "task-1", currentTaskId: "task-1" }), false);
  assert.equal(
    resultIsStale({ operationTaskId: "task-1", currentTaskId: "task-1", aborted: false }),
    false,
  );
});

test("a result from a task the user already reset writes nothing further", () => {
  assert.equal(resultIsStale({ operationTaskId: "task-1", currentTaskId: "task-2" }), true);
  // Including one that never carried a task at all: an unattributed write is not this task's.
  assert.equal(resultIsStale({ operationTaskId: undefined, currentTaskId: "task-2" }), true);
});

test("a cancelled operation's result is stale even inside its own task", () => {
  assert.equal(
    resultIsStale({ operationTaskId: "task-1", currentTaskId: "task-1", aborted: true }),
    true,
  );
});

test("an approval answered against a newer operation authorizes nothing", () => {
  const base = {
    resolverTaskId: "task-1",
    currentTaskId: "task-1",
    resolverOperationOwnerId: "operation-1",
    activeOperationOwnerId: "operation-1",
  };
  assert.equal(approvalIsStale(base), false);
  assert.equal(approvalIsStale({ ...base, activeOperationOwnerId: "operation-2" }), true);
  assert.equal(approvalIsStale({ ...base, activeOperationOwnerId: undefined }), true);
  assert.equal(approvalIsStale({ ...base, currentTaskId: "task-2" }), true);
});

test("an approval recorded without an operation is judged on its task alone", () => {
  assert.equal(
    approvalIsStale({
      resolverTaskId: "task-1",
      currentTaskId: "task-1",
      activeOperationOwnerId: "operation-9",
    }),
    false,
  );
  assert.equal(
    approvalIsStale({ resolverTaskId: "task-1", currentTaskId: "task-2" }),
    true,
  );
});

test("a checkpoint with work left, and nothing running, resumes", () => {
  assert.equal(
    resumeRefusal({ checkpoint: { nextStepIndex: 3, totalSteps: 8 }, workflowActive: false }),
    undefined,
  );
});

test("a run cannot be resumed while one is already running", () => {
  assert.equal(
    resumeRefusal({ checkpoint: { nextStepIndex: 3, totalSteps: 8 }, workflowActive: true }),
    "workflow-active",
  );
});

test("no checkpoint and a finished checkpoint are refused differently", () => {
  assert.equal(resumeRefusal({ workflowActive: false }), "no-recoverable-workflow");
  assert.equal(
    resumeRefusal({ checkpoint: { nextStepIndex: 8, totalSteps: 8 }, workflowActive: false }),
    "already-completed",
  );
  assert.equal(
    resumeRefusal({ checkpoint: { nextStepIndex: 9, totalSteps: 8 }, workflowActive: false }),
    "already-completed",
  );
});

test("discarding a checkpoint returns only an interrupted or failed run to idle", () => {
  assert.equal(discardReturnsToIdle("interrupted"), true);
  assert.equal(discardReturnsToIdle("error"), true);
  assert.equal(discardReturnsToIdle("idle"), false);
  assert.equal(discardReturnsToIdle("running"), false);
  assert.equal(discardReturnsToIdle("completed"), false);
});
