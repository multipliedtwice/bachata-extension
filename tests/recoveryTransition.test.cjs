const assert = require("node:assert/strict");
const test = require("node:test");

const {
  approvalIsStale,
  discardReturnsToIdle,
  exposedRecoveryOutcome,
  failedRunWorkflowStatus,
  parseRecoveryFailureScope,
  parseRecoveryRecordOutcome,
  recoveryFailureScope,
  recoveryWorkflowStatus,
  restartSurvivesFolderChange,
  restoredRecoveryOutcome,
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

test("a checkpoint names how its run ended, and one the host lost mid-run reads as an interruption", () => {
  for (const value of ["running", "stoppedByUser", "failed"]) {
    assert.equal(parseRecoveryRecordOutcome(value), value);
  }
  for (const value of ["interrupted", undefined, "legacy", 3]) {
    assert.equal(parseRecoveryRecordOutcome(value), "interrupted");
  }
  assert.equal(parseRecoveryFailureScope("run"), "run");
  assert.equal(parseRecoveryFailureScope("step"), "step");
  assert.equal(parseRecoveryFailureScope("other"), undefined);
  assert.equal(parseRecoveryFailureScope(undefined), undefined);
  assert.equal(restoredRecoveryOutcome("running"), "interrupted");
  for (const outcome of ["stoppedByUser", "interrupted", "failed"]) {
    assert.equal(restoredRecoveryOutcome(outcome), outcome);
  }
});

test("a live run's checkpoint is never offered as recovery, and an ended one restores its own status", () => {
  assert.equal(exposedRecoveryOutcome("running"), undefined);
  for (const outcome of ["stoppedByUser", "interrupted", "failed"]) {
    assert.equal(exposedRecoveryOutcome(outcome), outcome);
  }
  assert.equal(recoveryWorkflowStatus(undefined), "idle");
  assert.equal(recoveryWorkflowStatus("failed"), "error");
  assert.equal(recoveryWorkflowStatus("stoppedByUser"), "interrupted");
  assert.equal(recoveryWorkflowStatus("interrupted"), "interrupted");
  assert.equal(recoveryWorkflowStatus("running"), "interrupted");
});

test("a stop by the user stays an interruption and never becomes a failure", () => {
  assert.equal(failedRunWorkflowStatus("interrupted"), "interrupted");
  for (const status of ["error", "running", "idle", "completed", "paused"]) {
    assert.equal(failedRunWorkflowStatus(status), "error", status);
  }
});

test("only a failure after a participant started has a step to retry, and only one before any start survives a folder change", () => {
  assert.equal(recoveryFailureScope(true), "step");
  assert.equal(recoveryFailureScope(false), "run");
  assert.equal(restartSurvivesFolderChange({ outcome: "failed", failureScope: "run" }), true);
  assert.equal(restartSurvivesFolderChange({ outcome: "failed", failureScope: "step" }), false);
  assert.equal(restartSurvivesFolderChange({ outcome: "failed" }), false);
  assert.equal(restartSurvivesFolderChange({ outcome: "stoppedByUser", failureScope: "run" }), false);
  assert.equal(restartSurvivesFolderChange(undefined), false);
});
