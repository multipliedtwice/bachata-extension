const assert = require("node:assert/strict");
const test = require("node:test");

const {
  INTERVENTION_CONSENT,
  continueNeedsInterventionConsent,
  gateDecidedRecord,
  humanGateDecisionRefusal,
  humanGateResolution,
} = require("../dist/runtime/humanGateDecision.js");

const gate = (overrides = {}) => ({
  stepId: "step-2",
  stepName: "Review",
  reason: "afterStep",
  allowedActions: ["continue", "rollback", "cancel"],
  rollbackTargets: [{ id: "step-1", name: "Implement" }],
  ...overrides,
});

const refusal = (overrides = {}) =>
  humanGateDecisionRefusal({
    waiting: true,
    busy: false,
    pendingGate: gate(),
    action: "continue",
    ...overrides,
  });

test("a decision with no gate waiting is refused first", () => {
  assert.equal(refusal({ waiting: false, busy: true }), "No human gate is waiting");
});

test("direct agent traffic must finish before a gate is answered", () => {
  assert.equal(refusal({ busy: true }), "Wait for direct agent messages to finish before continuing");
});

test("an action the gate does not offer is refused by name", () => {
  assert.equal(refusal({ action: "skip" }), "skip is not available for the current human gate");
  assert.equal(refusal({ pendingGate: undefined }), "continue is not available for the current human gate");
});

test("a rollback needs a target the gate actually offers", () => {
  assert.equal(refusal({ action: "rollback" }), "Select a valid rollback target");
  assert.equal(refusal({ action: "rollback", targetStepId: "step-9" }), "Select a valid rollback target");
  assert.equal(refusal({ action: "rollback", targetStepId: "step-1" }), undefined);
});

test("an offered action with nothing in the way is not refused", () => {
  assert.equal(refusal(), undefined);
  assert.equal(refusal({ action: "cancel", targetStepId: "ignored" }), undefined);
});

test("only continuing past corrections needs consent", () => {
  assert.equal(continueNeedsInterventionConsent({ action: "continue", interventionCount: 2 }), true);
  assert.equal(continueNeedsInterventionConsent({ action: "continue", interventionCount: 0 }), false);
  assert.equal(continueNeedsInterventionConsent({ action: "rollback", interventionCount: 2 }), false);
  assert.match(INTERVENTION_CONSENT.message, /without rerunning the configured review step/u);
  assert.equal(INTERVENTION_CONSENT.confirm, "Continue anyway");
});

test("the ledger records the gate answered, the action, the target and the corrections carried", () => {
  assert.deepEqual(
    gateDecidedRecord({
      pendingGate: gate(),
      action: "rollback",
      targetStepId: "step-1",
      interventionIds: ["i-1", "i-2"],
    }),
    {
      text: "Human gate decision: rollback",
      step: "Review",
      payload: {
        stepId: "step-2",
        reason: "afterStep",
        action: "rollback",
        targetStepId: "step-1",
        interventionIds: ["i-1", "i-2"],
      },
    },
  );
  assert.equal(gateDecidedRecord({ pendingGate: gate(), action: "continue", interventionIds: [] }).payload.targetStepId, null);
});

test("the pipeline receives the decision with no target key unless one was chosen", () => {
  const interventions = [{ id: "i-1", text: "fix the test" }];
  assert.deepEqual(humanGateResolution({ action: "continue", interventions }), {
    action: "continue",
    interventions,
  });
  assert.deepEqual(humanGateResolution({ action: "rollback", targetStepId: "step-1", interventions: [] }), {
    action: "rollback",
    targetStepId: "step-1",
    interventions: [],
  });
});

// EX-3. Opening a gate: the record the panel is shown, the broker's question, the answer's decision.
const {
  ROLLBACK_OPTION_PREFIX,
  gateOpenedRecord,
  humanGateDecisionFromResponse,
  humanGateInteractionAsk,
  pendingGateFrom,
} = require("../dist/runtime/humanGateDecision.js");

const request = (overrides = {}) => ({
  step: { id: "step-2", name: "Review" },
  reason: "afterStep",
  allowedActions: ["continue", "rollback", "cancel"],
  rollbackTargets: [{ id: "step-1", name: "Implement" }],
  ...overrides,
});

test("the pending gate carries round and detail only when the request has them", () => {
  assert.deepEqual(pendingGateFrom(request()), {
    stepId: "step-2",
    stepName: "Review",
    reason: "afterStep",
    allowedActions: ["continue", "rollback", "cancel"],
    rollbackTargets: [{ id: "step-1", name: "Implement" }],
  });
  const full = pendingGateFrom(request({ round: 2, detail: "Consensus was not reached" }));
  assert.equal(full.round, 2);
  assert.equal(full.detail, "Consensus was not reached");
});

test("the broker is asked with every non-rollback action and one option per rollback target", () => {
  const ask = humanGateInteractionAsk(request({ round: 3, detail: "Two reviewers disagree" }), { taskId: "task-1", leadAgentId: "lead" });
  assert.equal(ask.sourceKey, "human-gate:task-1:step-2:afterStep:3");
  assert.equal(ask.kind, "humanGate");
  assert.equal(ask.title, "Review");
  assert.equal(ask.prompt, "Two reviewers disagree\n\nAdditional instructions are sent to Lead.");
  assert.deepEqual(ask.options, [
    { id: "continue", label: "continue" },
    { id: "cancel", label: "cancel" },
    { id: "rollback:step-1", label: "Rollback to Implement" },
  ]);
  assert.equal(ask.allowFreeText, true);
  assert.equal(ask.secret, false);
});

test("without a Lead the question is the waiting reason alone, and free text is not offered", () => {
  const ask = humanGateInteractionAsk(request(), { taskId: "task-1" });
  assert.equal(ask.prompt, "Pipeline is waiting: afterStep");
  assert.equal(ask.allowFreeText, false);
  assert.equal(ask.sourceKey, "human-gate:task-1:step-2:afterStep:0");
  assert.equal(humanGateInteractionAsk(request(), { taskId: "t", leadAgentId: "" }).allowFreeText, false);
});

const decide = (response, overrides = {}) =>
  humanGateDecisionFromResponse(response, {
    allowedActions: ["continue", "rollback", "cancel"],
    stepName: "Review",
    interventionId: "i-1",
    now: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

test("the first selection is the action, and a rollback option names its target", () => {
  assert.deepEqual(decide({ selected: ["continue"], freeText: "" }), { action: "continue" });
  assert.deepEqual(decide({ selected: [`${ROLLBACK_OPTION_PREFIX}step-1`], freeText: "" }), {
    action: "rollback",
    targetStepId: "step-1",
  });
});

test("a selection the gate did not offer, or none at all, is a cancel", () => {
  assert.deepEqual(decide({ selected: ["skip"], freeText: "" }), { action: "cancel" });
  assert.deepEqual(decide({ selected: [], freeText: "" }), { action: "cancel" });
});

test("free text becomes an intervention for the Lead, and only when there is a Lead", () => {
  assert.deepEqual(decide({ selected: ["continue"], freeText: "  tighten the tests  " }, { leadAgentId: "lead" }), {
    action: "continue",
    interventions: [{
      id: "i-1",
      agentId: "lead",
      prompt: "Human instructions for Review",
      answer: "tighten the tests",
      createdAt: "2026-01-01T00:00:00.000Z",
    }],
  });
  assert.equal("interventions" in decide({ selected: ["continue"], freeText: "tighten" }), false);
  assert.equal("interventions" in decide({ selected: ["continue"], freeText: "   " }, { leadAgentId: "lead" }), false);
  assert.equal(decide({ selected: ["rollback:step-1"], freeText: "note" }, { leadAgentId: "lead" }).interventions.length, 1);
});

test("the ledger records an opened gate in full, with absent round and detail as null", () => {
  assert.deepEqual(gateOpenedRecord(request()), {
    text: "Human gate opened: afterStep",
    step: "Review",
    payload: {
      stepId: "step-2",
      reason: "afterStep",
      round: null,
      detail: null,
      allowedActions: ["continue", "rollback", "cancel"],
      rollbackTargets: [{ id: "step-1", name: "Implement" }],
    },
  });
  assert.equal(gateOpenedRecord(request({ round: 1, detail: "d" })).payload.round, 1);
});
