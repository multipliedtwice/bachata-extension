const assert = require("node:assert/strict");
const test = require("node:test");

const {
  browserActionPolicySetting,
  browserActionPreApproval,
  managedBrowserActionPreApproval,
} = require("../dist/runtime/browserActionPolicy.js");

// EX-AUD-12. These decisions used to live inside `createRuntime`, where reaching one meant
// standing up a runtime, a configuration and an approval channel. They decide whether a
// model-authored action runs without asking anyone, so each branch gets its own case.

test("each risk level is governed by its own setting", () => {
  assert.equal(browserActionPolicySetting("readOnly"), "browserActionReadOnlyPolicy");
  assert.equal(browserActionPolicySetting("mutating"), "browserActionMutationPolicy");
  assert.equal(browserActionPolicySetting("destructive"), "browserActionDestructivePolicy");
});

const candidate = (overrides = {}) => ({
  kind: "workspace.read",
  origin: "structured",
  confidence: "explicit",
  riskPolicy: "auto",
  ...overrides,
});

test("a shell action is refused whatever the policy says", () => {
  for (const riskPolicy of ["auto", "ask", "disabled", "anything"]) {
    assert.equal(
      browserActionPreApproval(candidate({ kind: "shell.run", riskPolicy })),
      "reject",
      `shell.run was not refused under ${riskPolicy}`,
    );
  }
});

test("a disabled policy refuses every action kind", () => {
  assert.equal(
    browserActionPreApproval(candidate({ riskPolicy: "disabled" })),
    "reject",
  );
  assert.equal(
    browserActionPreApproval(
      candidate({ riskPolicy: "disabled", origin: "heuristic", confidence: "medium" }),
    ),
    "reject",
  );
});

test("automatic approval needs the auto policy, a structured origin and explicit confidence", () => {
  assert.equal(browserActionPreApproval(candidate()), "approve");
  assert.equal(browserActionPreApproval(candidate({ riskPolicy: "ask" })), "ask");
  assert.equal(browserActionPreApproval(candidate({ origin: "heuristic" })), "ask");
  assert.equal(browserActionPreApproval(candidate({ origin: "semantic" })), "ask");
  assert.equal(browserActionPreApproval(candidate({ confidence: "high" })), "ask");
  assert.equal(browserActionPreApproval(candidate({ confidence: "medium" })), "ask");
});

test("an unknown policy value asks rather than assuming anything", () => {
  assert.equal(browserActionPreApproval(candidate({ riskPolicy: "" })), "ask");
  assert.equal(browserActionPreApproval(candidate({ riskPolicy: "Auto" })), "ask");
});

test("a managed turn approves only a structured, explicit, non-shell action", () => {
  const managed = (overrides = {}) => ({
    autoApprove: true,
    kind: "workspace.write",
    origin: "structured",
    confidence: "explicit",
    ...overrides,
  });
  assert.equal(managedBrowserActionPreApproval(managed()), "approve");
  assert.equal(managedBrowserActionPreApproval(managed({ autoApprove: false })), "defer");
  assert.equal(managedBrowserActionPreApproval(managed({ kind: "shell.run" })), "defer");
  assert.equal(managedBrowserActionPreApproval(managed({ origin: "heuristic" })), "defer");
  assert.equal(managedBrowserActionPreApproval(managed({ confidence: "high" })), "defer");
});

test("a managed turn never refuses on its own; it defers to the configured policy", () => {
  const outcomes = new Set();
  for (const autoApprove of [true, false]) {
    for (const kind of ["shell.run", "workspace.delete"]) {
      outcomes.add(
        managedBrowserActionPreApproval({
          autoApprove,
          kind,
          origin: "structured",
          confidence: "explicit",
        }),
      );
    }
  }
  assert.equal(outcomes.has("reject"), false);
});

// EX-3. What the ordinary browser action loop decides between reading a response and running it.
const {
  browserActionBudgetRefusal,
  browserActionLimits,
  browserActionMutationContext,
  browserActionRejection,
} = require("../dist/runtime/browserActionPolicy.js");

test("a refused action is still recorded, and stop ends the round as well", () => {
  assert.deepEqual(browserActionRejection("reject"), { reason: "Rejected by user", stopLoop: false });
  assert.deepEqual(browserActionRejection("stop"), {
    reason: "Rejected by user; action loop stopped",
    stopLoop: true,
  });
});

const budget = (over = {}) =>
  browserActionBudgetRefusal({
    actionCount: 0,
    pendingActions: 1,
    maximumActions: 10,
    maximumRounds: 5,
    terminalOnlyRound: false,
    ...over,
  });

test("a round that produced only terminal responses is reported before the action count", () => {
  const refusal = budget({ terminalOnlyRound: true, actionCount: 99, pendingActions: 99 });
  assert.equal(refusal.message, "Browser action round budget exhausted with unexecuted actions (5 rounds)");
  assert.equal(refusal.event, "Browser action loop exhausted 5 action rounds with unexecuted actions.");
  assert.deepEqual(refusal.payload, { maximumRounds: 5, attemptedActions: 99 });
});

test("the action budget counts what has run plus what is pending", () => {
  assert.equal(budget({ actionCount: 9, pendingActions: 1 }), undefined);
  const refusal = budget({ actionCount: 9, pendingActions: 2 });
  assert.equal(refusal.message, "Browser action budget exhausted with unexecuted actions (10 actions)");
  assert.equal(refusal.event, "Browser action loop stopped after reaching 10 actions.");
  assert.deepEqual(refusal.payload, { maximumActions: 10 });
});

test("a loop inside both budgets is not refused", () => {
  assert.equal(budget(), undefined);
});

test("every limit is clamped up, so a zero setting bounds an action instead of refusing it", () => {
  assert.deepEqual(
    browserActionLimits({ timeoutMs: 0, terminateGraceMs: 5_000, maxOutputBytes: 0, maxReadBytes: 0, maxSearchResults: 0 }),
    { timeoutMs: 1_000, terminateGraceMs: 5_000, maxOutputBytes: 65_536, maxReadBytes: 65_536, maxSearchResults: 10 },
  );
  assert.deepEqual(
    browserActionLimits({ timeoutMs: 120_000, terminateGraceMs: 5_000, maxOutputBytes: 1_048_576, maxReadBytes: 1_048_576, maxSearchResults: 500 }),
    { timeoutMs: 120_000, terminateGraceMs: 5_000, maxOutputBytes: 1_048_576, maxReadBytes: 1_048_576, maxSearchResults: 500 },
  );
});

test("a browser action never commits, whatever the run's own commit mode says", () => {
  const context = browserActionMutationContext({ allowedPaths: ["/repo/src"], protectedPaths: ["/repo/.git"], readOnly: true });
  assert.equal(context.commitMode, "never");
  assert.deepEqual(context.allowedPaths, ["/repo/src"]);
  assert.deepEqual(context.restrictedPaths, ["/repo/.git"]);
  assert.equal(context.readOnly, true);
});

test("an action with no declared paths is scoped to nothing and is not read-only by default", () => {
  const context = browserActionMutationContext({});
  assert.deepEqual(context.allowedPaths, []);
  assert.equal("restrictedPaths" in context, false);
  assert.equal(context.readOnly, false);
  assert.equal(context.commitMode, "never");
});

test("the path lists are copies, so a later edit cannot widen an action already scoped", () => {
  const allowedPaths = ["/repo"];
  const context = browserActionMutationContext({ allowedPaths });
  allowedPaths.push("/elsewhere");
  assert.deepEqual(context.allowedPaths, ["/repo"]);
});
