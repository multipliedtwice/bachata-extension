const assert = require("node:assert/strict");
const test = require("node:test");

const {
  impliedWriteScope,
  isPairPipeline,
  iterationEndEvent,
  iterationFailurePlan,
  iterationStartEvent,
  pairRecordFrom,
} = require("../dist/conversations/iterationExecution.js");

test("a managed task is a pair run; so is a pipeline that names both worker and lead", () => {
  assert.equal(isPairPipeline({ orchestrationTaskId: "t-1" }), true);
  assert.equal(isPairPipeline({ roles: [{ id: "worker" }, { id: "lead" }] }), true);
  assert.equal(isPairPipeline({ roles: [{ id: "worker" }] }), false);
  assert.equal(isPairPipeline({ roles: [{ id: "lead" }] }), false);
  assert.equal(isPairPipeline({}), false);
});

test("a requested write scope wins; task paths imply task scope; a root path implies the workspace", () => {
  assert.equal(impliedWriteScope({ requested: "configured", orchestrationPaths: ["."] }), "configured");
  assert.equal(impliedWriteScope({ orchestrationPaths: ["src/a.ts"] }), "task");
  assert.equal(impliedWriteScope({ orchestrationPaths: ["src/a.ts", ""] }), "workspace");
  assert.equal(impliedWriteScope({ orchestrationPaths: ["."] }), "workspace");
  assert.equal(impliedWriteScope({ orchestrationPaths: [] }), undefined);
  assert.equal(impliedWriteScope({}), undefined);
});

test("a task's pair row names its worktree and scope; a plain pair run has neither", () => {
  assert.deepEqual(
    pairRecordFrom({
      runRef: "run-1",
      iterationRef: "it-1",
      orchestrationTaskId: "t-1",
      orchestrationBranch: "bachata/task/t-1",
      orchestrationBaseCommit: "abc",
      orchestrationPaths: ["src"],
      workingDirectory: "/wt/t-1",
    }),
    {
      runRef: "run-1",
      iterationRef: "it-1",
      taskId: "t-1",
      workingRoot: "/wt/t-1",
      worktreePath: "/wt/t-1",
      branch: "bachata/task/t-1",
      baseCommit: "abc",
      scope: { taskId: "t-1", paths: ["src"] },
      status: "running",
    },
  );
  const plain = pairRecordFrom({ runRef: "run-2", iterationRef: "it-2", workingDirectory: "/repo" });
  assert.equal(plain.worktreePath, undefined);
  assert.equal(plain.scope, undefined);
  assert.equal(plain.workingRoot, "/repo");
  assert.deepEqual(pairRecordFrom({ runRef: "r", iterationRef: "i", orchestrationTaskId: "t", workingDirectory: "/w" }).scope, { taskId: "t", paths: [] });
});

test("iteration events say which pass this is and how it ended", () => {
  assert.deepEqual(iterationStartEvent({ resume: false, displayIndex: 2, requestedIterations: 3 }), {
    type: "iteration.started",
    title: "Iteration 2 of 3",
  });
  assert.equal(iterationStartEvent({ resume: true, displayIndex: 1, requestedIterations: 1 }).type, "iteration.resumed");
  assert.deepEqual(iterationEndEvent({ status: "completed", displayIndex: 2 }), { type: "iteration.completed", title: "Iteration 2 completed" });
  assert.deepEqual(iterationEndEvent({ status: "interrupted", displayIndex: 2 }), { type: "iteration.interrupted", title: "Iteration 2 interrupted" });
});

test("a resume that failed while a recoverable workflow remains is an interruption that keeps its queued directory", () => {
  assert.deepEqual(iterationFailurePlan({ resume: true, hasResumableWorkflow: true, displayIndex: 3, error: new Error("boom") }), {
    status: "interrupted",
    workflowStatus: "interrupted",
    eventType: "iteration.resume.failed",
    title: "Iteration 3 resume failed",
    message: "boom",
    dropPendingWorkingDirectory: false,
  });
});

test("every other failure is a failure that drops the queued directory", () => {
  for (const input of [
    { resume: false, hasResumableWorkflow: true },
    { resume: true, hasResumableWorkflow: false },
    { resume: false, hasResumableWorkflow: false },
  ]) {
    const plan = iterationFailurePlan({ ...input, displayIndex: 1, error: "text" });
    assert.equal(plan.status, "failed", JSON.stringify(input));
    assert.equal(plan.workflowStatus, "error");
    assert.equal(plan.eventType, "iteration.failed");
    assert.equal(plan.title, "Iteration 1 failed");
    assert.equal(plan.message, "text");
    assert.equal(plan.dropPendingWorkingDirectory, true);
  }
});
