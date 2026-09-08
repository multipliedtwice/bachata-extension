const assert = require("node:assert/strict");
const test = require("node:test");

const {
  gateMovement,
  iterationOutcome,
  iterationPlan,
  managedTransition,
} = require("../dist/pipeline/stepTransitions.js");

// EX-AUD-12. Where a pipeline run goes next. Each of these was an index change made inline in
// the runner beside the snapshot restore, the transcript write and the provider call around it,
// so reaching one meant running a pipeline. They are decisions about an index, driven here as
// decisions about an index.

test("a cancelled gate ends the run wherever the gate was", () => {
  for (const reason of ["before", "after"]) {
    assert.deepEqual(gateMovement({ action: "cancel" }, reason), { movement: "interrupt" });
  }
});

test("a skip before a step leaves it behind; after a step there is nothing to skip", () => {
  assert.deepEqual(gateMovement({ action: "skip" }, "before"), { movement: "advance" });
  assert.deepEqual(gateMovement({ action: "skip" }, "after"), { movement: "proceed" });
});

test("continuing at a gate runs, or finishes, the step the loop is on", () => {
  assert.deepEqual(gateMovement({ action: "continue" }, "before"), { movement: "proceed" });
  assert.deepEqual(gateMovement({ action: "continue" }, "after"), { movement: "proceed" });
});

test("a rerun repeats the step from its own snapshot; a repeated consensus does not", () => {
  assert.deepEqual(gateMovement({ action: "rerunStep" }, "after"), {
    movement: "repeat",
    restoreSnapshot: true,
  });
  assert.deepEqual(gateMovement({ action: "repeatConsensus" }, "after"), {
    movement: "repeat",
    restoreSnapshot: false,
  });
  // Neither is offered before a step has run, so neither moves the run there.
  assert.deepEqual(gateMovement({ action: "rerunStep" }, "before"), { movement: "proceed" });
});

test("a rollback carries its target, and a rollback with no target is refused", () => {
  assert.deepEqual(gateMovement({ action: "rollback", targetStepId: "plan" }, "after"), {
    movement: "rollback",
    targetStepId: "plan",
  });
  for (const decision of [
    { action: "rollback" },
    { action: "rollback", targetStepId: "" },
    { action: "rollback", targetStepId: undefined },
  ]) {
    assert.throws(
      () => gateMovement(decision, "before"),
      /A rollback gate decision names no target step/u,
      JSON.stringify(decision),
    );
  }
});

const managed = (overrides = {}) => ({
  managedState: "WORKER_REVISE",
  managedRole: "lead",
  bounds: { start: 2, end: 6 },
  index: 4,
  isEnabledWorkerStep: () => false,
  ...overrides,
});

test("a step with no managed result of its own simply advances", () => {
  assert.deepEqual(managedTransition(managed({ managedState: undefined })), { movement: "advance" });
  assert.deepEqual(managedTransition(managed({ managedRole: undefined })), { movement: "advance" });
  assert.deepEqual(managedTransition(managed({ bounds: undefined })), { movement: "advance" });
});

test("a finalized managed turn leaves the whole block, not the step", () => {
  assert.deepEqual(
    managedTransition(managed({ managedState: "FINALIZE" })),
    { movement: "jump", index: 6 },
  );
  // Whichever role reported it: the block's work is what finished.
  assert.deepEqual(
    managedTransition(managed({ managedState: "FINALIZE", managedRole: "worker" })),
    { movement: "jump", index: 6 },
  );
});

test("a managed state that moves nothing advances one step", () => {
  assert.deepEqual(managedTransition(managed({ managedState: "CONTINUE" })), { movement: "advance" });
  // A Worker cannot send itself back for revision: only a Lead's revision moves the run.
  assert.deepEqual(managedTransition(managed({ managedRole: "worker" })), { movement: "advance" });
});

test("a Lead's revision goes forward to a Worker in the same block before it goes back", () => {
  assert.deepEqual(
    managedTransition(managed({ isEnabledWorkerStep: (index) => index === 5 || index === 3 })),
    { movement: "jump", index: 5 },
  );
  assert.deepEqual(
    managedTransition(managed({ isEnabledWorkerStep: (index) => index === 3 })),
    { movement: "jump", index: 3 },
  );
  // The nearest Worker behind, not the first one in the block.
  assert.deepEqual(
    managedTransition(managed({ isEnabledWorkerStep: (index) => index === 2 || index === 3 })),
    { movement: "jump", index: 3 },
  );
});

test("a revision never leaves the block it was requested in", () => {
  assert.deepEqual(
    managedTransition(managed({ isEnabledWorkerStep: (index) => index === 6 || index === 1 })),
    { movement: "fail", reason: "no-managed-worker" },
  );
});

test("a Lead's revision with no enabled Worker to carry it out fails rather than advancing", () => {
  assert.deepEqual(managedTransition(managed()), { movement: "fail", reason: "no-managed-worker" });
});

test("a run's pass count and clean-pass target are clamped, not trusted", () => {
  assert.deepEqual(iterationPlan({}), { iterations: 1, targetCleanPasses: 2 });
  assert.deepEqual(iterationPlan({ iterationCount: 7, requiredCleanPasses: 3 }), {
    iterations: 7,
    targetCleanPasses: 3,
  });
  for (const value of [0, -4]) {
    assert.equal(iterationPlan({ iterationCount: value }).iterations, 1, String(value));
    assert.equal(iterationPlan({ requiredCleanPasses: value }).targetCleanPasses, 1, String(value));
  }
  // A value that is not a number at all falls back to the default rather than to the floor: a
  // saved run that lost its count is a run of one pass, not a run of zero.
  for (const value of [Number.NaN, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY]) {
    assert.equal(iterationPlan({ iterationCount: value }).iterations, 1, String(value));
    assert.equal(iterationPlan({ requiredCleanPasses: value }).targetCleanPasses, 2, String(value));
  }
  assert.equal(iterationPlan({ iterationCount: 5_000 }).iterations, 50);
  assert.equal(iterationPlan({ requiredCleanPasses: 5_000 }).targetCleanPasses, 10);
  assert.equal(iterationPlan({ iterationCount: 3.9 }).iterations, 3);
  assert.equal(iterationPlan({ iterationCount: 9, maximumIterations: 4 }).iterations, 4);
  assert.equal(iterationPlan({ requiredCleanPasses: 9, maximumCleanPasses: 4 }).targetCleanPasses, 4);
});

test("a fixed run makes the passes it was asked for and stops for nothing", () => {
  assert.deepEqual(
    iterationOutcome({ mode: "fixed", cleanPasses: 5, workspaceChanged: false, targetCleanPasses: 2 }),
    { cleanPasses: 5, exhausted: false },
  );
});

test("an until-clean run needs consecutive quiet passes, and one change resets the count", () => {
  assert.deepEqual(
    iterationOutcome({ mode: "untilClean", cleanPasses: 0, workspaceChanged: false, targetCleanPasses: 2 }),
    { cleanPasses: 1, exhausted: false },
  );
  assert.deepEqual(
    iterationOutcome({ mode: "untilClean", cleanPasses: 1, workspaceChanged: false, targetCleanPasses: 2 }),
    { cleanPasses: 2, exhausted: true },
  );
  assert.deepEqual(
    iterationOutcome({ mode: "untilClean", cleanPasses: 1, workspaceChanged: true, targetCleanPasses: 2 }),
    { cleanPasses: 0, exhausted: false },
  );
});

test("a pass whose effect is unknown is not evidence of quiet", () => {
  assert.deepEqual(
    iterationOutcome({ mode: "untilClean", cleanPasses: 1, targetCleanPasses: 2 }),
    { cleanPasses: 0, exhausted: false },
  );
});
