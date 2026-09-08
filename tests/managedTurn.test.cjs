const assert = require("node:assert/strict");
const test = require("node:test");

const {
  managedCheckpointSteps,
  managedContextActionKinds,
  managedNextPrompt,
  managedTerminalAdvances,
  managedTurnContinues,
  managedTurnObjections,
  managedTurnReadsContext,
  managedTurnRequestsVerification,
  managedTurnWritesWorkspace,
} = require("../dist/runtime/managedTurn.js");

// EX-AUD-12. What a managed browser turn's own result means. Every one of these judgements sat
// between the transcript write and the provider call that surround it, so reaching one meant
// driving a whole managed run against a real browser.

const envelope = (overrides = {}) => ({
  status: "done",
  summary: "",
  objections: [],
  unresolved: [],
  actions: [],
  ...overrides,
});

const actions = (...kinds) => kinds.map((kind) => ({ kind }));

test("objections and unresolved points are one list, counted once", () => {
  assert.deepEqual(
    managedTurnObjections(envelope({ objections: ["a", "b"], unresolved: ["b", "c"] })),
    ["a", "b", "c"],
  );
  assert.deepEqual(managedTurnObjections(undefined), []);
  assert.deepEqual(managedTurnObjections(envelope()), []);
});

test("a turn that only reads the workspace is a read, not work", () => {
  for (const kind of managedContextActionKinds) {
    assert.equal(managedTurnReadsContext(envelope({ actions: actions(kind) })), true, kind);
    assert.equal(managedTurnWritesWorkspace(envelope({ actions: actions(kind) })), false, kind);
  }
  assert.equal(managedTurnReadsContext(envelope({ actions: actions("workspace.write") })), false);
  // Both halves of the list are the same list: the Worker branch and the Lead branch cannot
  // disagree about what counts as reading.
  assert.equal(managedContextActionKinds.length, new Set(managedContextActionKinds).size);
});

test("a turn that changes the workspace, or asks to verify it, is recognised as such", () => {
  for (const kind of ["workspace.applyPatch", "workspace.write", "workspace.delete"]) {
    assert.equal(managedTurnWritesWorkspace(envelope({ actions: actions(kind) })), true, kind);
  }
  assert.equal(managedTurnRequestsVerification(envelope({ actions: actions("verification.run") })), true);
  assert.equal(managedTurnRequestsVerification(envelope({ actions: actions("context.read") })), false);
});

test("a terminal claim advances only when the verification gate is not holding it", () => {
  assert.equal(managedTerminalAdvances({ terminal: true, verificationGateHolds: false }), true);
  assert.equal(managedTerminalAdvances({ terminal: true, verificationGateHolds: true }), false);
  assert.equal(managedTerminalAdvances({ terminal: false, verificationGateHolds: false }), false);
});

const workerTurn = (overrides = {}) => ({
  role: "worker",
  state: "WORKER_NEEDS_CONTEXT",
  envelope: envelope(),
  anyActionCompleted: true,
  isRevision: false,
  terminal: false,
  verificationGateHolds: false,
  ...overrides,
});

test("a Worker turn records a read, then a patch, then verification, in that order", () => {
  assert.deepEqual(
    managedCheckpointSteps(
      workerTurn({
        envelope: envelope({
          actions: actions("context.read", "workspace.applyPatch", "verification.run"),
        }),
        terminal: true,
      }),
    ),
    [
      { event: "workerNeedsContext" },
      { event: "workerRequestedPatch" },
      { event: "patchApplied" },
      { event: "verificationCompleted" },
      { event: "workerDone" },
    ],
  );
});

test("a patch whose actions all failed is not an applied patch", () => {
  assert.deepEqual(
    managedCheckpointSteps(
      workerTurn({
        envelope: envelope({ actions: actions("workspace.write") }),
        anyActionCompleted: false,
      }),
    ),
    [],
  );
});

test("a Worker answering a revision records the revision, not a first patch", () => {
  assert.deepEqual(
    managedCheckpointSteps(
      workerTurn({
        state: "WORKER_REVISE",
        isRevision: true,
        envelope: envelope({ actions: actions("workspace.applyPatch") }),
      }),
    ),
    [{ event: "workerRequestedPatch" }, { event: "revisionApplied" }],
  );
});

test("a Worker cannot finish while the verification gate holds its terminal turn", () => {
  assert.deepEqual(
    managedCheckpointSteps(workerTurn({ terminal: true, verificationGateHolds: true })),
    [],
  );
  assert.deepEqual(managedCheckpointSteps(workerTurn({ terminal: true })), [{ event: "workerDone" }]);
});

test("a Worker that blocks records why, preferring its objections over its summary", () => {
  assert.deepEqual(
    managedCheckpointSteps(
      workerTurn({
        terminal: true,
        envelope: envelope({ status: "blocked", objections: ["no build"], unresolved: ["no build", "no tests"], summary: "stuck" }),
      }),
    ),
    [{ event: "blocked", reason: "no build; no tests" }],
  );
  assert.deepEqual(
    managedCheckpointSteps(
      workerTurn({ terminal: true, envelope: envelope({ status: "blocked", summary: "stuck" }) }),
    ),
    [{ event: "blocked", reason: "stuck" }],
  );
  assert.deepEqual(
    managedCheckpointSteps(workerTurn({ terminal: true, envelope: envelope({ status: "blocked" }) })),
    [{ event: "blocked", reason: "Worker blocked the task" }],
  );
});

test("a Worker turn arriving after the pair moved to the Lead records nothing", () => {
  assert.deepEqual(
    managedCheckpointSteps(
      workerTurn({
        state: "LEAD_REVIEW",
        terminal: true,
        envelope: envelope({ actions: actions("context.read") }),
      }),
    ),
    [],
  );
});

const leadTurn = (overrides = {}) => ({
  role: "lead",
  state: "LEAD_REVIEW",
  envelope: envelope(),
  anyActionCompleted: true,
  isRevision: false,
  terminal: false,
  verificationGateHolds: false,
  ...overrides,
});

test("a Lead that read the workspace records the read before it decides", () => {
  assert.deepEqual(
    managedCheckpointSteps(
      leadTurn({ envelope: envelope({ actions: actions("context.tree") }), terminal: true }),
    ),
    [{ event: "leadNeedsContext" }, { event: "leadAccepted" }],
  );
});

test("a Lead accepts only with nothing outstanding, and otherwise asks for a revision", () => {
  assert.deepEqual(managedCheckpointSteps(leadTurn({ terminal: true })), [{ event: "leadAccepted" }]);
  assert.deepEqual(
    managedCheckpointSteps(
      leadTurn({ terminal: true, envelope: envelope({ unresolved: ["missing test"] }) }),
    ),
    [{ event: "leadRequestedRevision", objections: ["missing test"] }],
  );
  assert.deepEqual(
    managedCheckpointSteps(
      leadTurn({
        terminal: true,
        envelope: envelope({ objections: ["a"], unresolved: ["a", "b"] }),
      }),
    ),
    [{ event: "leadRequestedRevision", objections: ["a", "b"] }],
  );
});

test("a Lead that blocks is blocked, whatever it also objected to", () => {
  assert.deepEqual(
    managedCheckpointSteps(
      leadTurn({ terminal: true, envelope: envelope({ status: "blocked", objections: ["cannot verify"] }) }),
    ),
    [{ event: "blocked", reason: "cannot verify" }],
  );
  assert.deepEqual(
    managedCheckpointSteps(leadTurn({ terminal: true, envelope: envelope({ status: "blocked" }) })),
    [{ event: "blocked", reason: "Lead blocked the task" }],
  );
});

test("a Lead held by the verification gate accepts nothing and objects to nothing", () => {
  assert.deepEqual(
    managedCheckpointSteps(leadTurn({ terminal: true, verificationGateHolds: true })),
    [],
  );
  assert.deepEqual(
    managedCheckpointSteps(leadTurn({ state: "WORKER_VERIFY", terminal: true })),
    [],
  );
});

test("a held turn is told which checks are not passing and what its role may do", () => {
  const worker = managedNextPrompt({
    verificationGateHolds: true,
    role: "worker",
    issues: ["project-checks: failed", "workspace-integrity: not run"],
    protocolPrompt: "PROTOCOL",
    nextPrompt: "carry on",
  });
  assert.match(worker, /Required verification: project-checks: failed, workspace-integrity: not run/u);
  assert.match(worker, /request verification\.run for every required check before returning done/u);
  assert.match(worker, /PROTOCOL$/u);
  assert.equal(worker.includes("carry on"), false, "a held turn was sent its own next prompt");

  const lead = managedNextPrompt({
    verificationGateHolds: true,
    role: "lead",
    issues: ["project-checks: failed"],
    protocolPrompt: "PROTOCOL",
  });
  assert.match(lead, /Do not approve the task while verification is missing or failing/u);
});

test("a turn the gate is not holding keeps the prompt the controller produced", () => {
  assert.equal(
    managedNextPrompt({
      verificationGateHolds: false,
      role: "worker",
      issues: [],
      protocolPrompt: "PROTOCOL",
      nextPrompt: "carry on",
    }),
    "carry on",
  );
  assert.equal(
    managedNextPrompt({ verificationGateHolds: false, role: "worker", issues: [], protocolPrompt: "PROTOCOL" }),
    undefined,
  );
});

test("the loop runs again only while there is something to say and nothing has stopped it", () => {
  const base = { terminal: false, verificationGateHolds: false, nextPrompt: "carry on", aborted: false };
  assert.equal(managedTurnContinues(base), true);
  assert.equal(managedTurnContinues({ ...base, aborted: true }), false);
  assert.equal(managedTurnContinues({ ...base, nextPrompt: undefined }), false);
  assert.equal(managedTurnContinues({ ...base, nextPrompt: "" }), false);
  assert.equal(managedTurnContinues({ ...base, terminal: true }), false);
  // A terminal turn the gate is holding is not finished: it has a prompt waiting.
  assert.equal(managedTurnContinues({ ...base, terminal: true, verificationGateHolds: true }), true);
});
