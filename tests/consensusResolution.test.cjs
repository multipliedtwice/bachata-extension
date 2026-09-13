const assert = require("node:assert/strict");
const test = require("node:test");
const { executePipeline } = require("../dist/pipeline/runner.js");
const { parsePendingConsensus } = require("../dist/pipeline/consensusCheckpoint.js");
const { humanGateDecisionFromResponse, humanGateInteractionAsk } = require("../dist/runtime/humanGateDecision.js");
const { humanResolutionSummary } = require("../dist/conversations/runResultProjection.js");
const { modelFindingsFromDecisionArtifact } = require("../dist/results/modelFindings.js");

const reviewPipeline = (maxRounds = 1) => ({
  version: 1,
  id: "review",
  name: "Review",
  agents: [
    { id: "a", name: "Usability reviewer", adapter: "mock" },
    { id: "b", name: "Accessibility reviewer", adapter: "mock" },
  ],
  steps: [
    {
      id: "review",
      type: "agent",
      name: "Reconcile findings",
      enabled: true,
      participants: ["a", "b"],
      promptTemplate: "Task {{userPrompt}}; peer={{peerAnswer}}; corrections={{interventionAnswers}}",
      parallel: true,
      consensus: true,
      consensusConfig: { mode: "unanimous", maxRounds, resultFormat: "json", resultField: "consensus", acceptedValue: true },
      humanGate: "after",
    },
    {
      id: "later",
      type: "agent",
      name: "Implementation",
      enabled: true,
      participants: ["a"],
      promptTemplate: "Implement",
      parallel: false,
      consensus: false,
      humanGate: "none",
    },
  ],
});

const answer = (agentId) => ({ status: "completed", answer: JSON.stringify({ consensus: false, answer: `${agentId} conclusion`, objections: [`${agentId} objection`] }) });
const callbacks = (waitForHumanGate, extras = {}) => ({ onStep() {}, onRoles() {}, waitForHumanGate, ...extras });

test("human unresolved completion preserves both conclusions, rationale and stops later steps", async () => {
  const calls = [];
  const published = [];
  let checkpoint;
  const result = await executePipeline(reviewPipeline(), "Review UI", [], async (agentId, _prompt, step) => {
    calls.push(step.id);
    return answer(agentId);
  }, callbacks(async (request) => {
    assert.equal(request.reason, "maxConsensusRounds");
    assert.equal(request.decisionRound, 1);
    assert.deepEqual(request.conclusionOptions.map((item) => item.agentId), ["a", "b"]);
    return { action: "acceptUnresolved", rationale: "Keep both findings for manual resolution" };
  }, { onDecision: (artifact) => published.push(artifact), onCheckpoint: (value) => { checkpoint = structuredClone(value); } }));
  assert.deepEqual(calls, ["review", "review"]);
  assert.equal(result.status, "completed");
  assert.equal(result.completionReason, "humanDecision");
  assert.equal(result.answers.review.a, answer("a").answer);
  assert.equal(result.answers.review.b, answer("b").answer);
  assert.equal(published.at(-1).status, "resolved");
  assert.equal(published.at(-1).humanResolution.rationale, "Keep both findings for manual resolution");
  assert.equal(published.at(-1).humanResolution.action, "acceptUnresolved");
  assert.equal(checkpoint.nextStepIndex, 2);
  assert.deepEqual(checkpoint.snapshot.pendingConsensus, {});
  assert.match(humanResolutionSummary(published.at(-1)), /Keep both findings/u);
});

test("selecting a participant produces a human ruling with no additional provider calls", async () => {
  let calls = 0;
  const result = await executePipeline(reviewPipeline(), "Review UI", [], async (agentId) => {
    calls += 1;
    return answer(agentId);
  }, callbacks(async () => ({ action: "acceptParticipant", selectedParticipant: "b", rationale: "Accessibility is the acceptance criterion" })));
  assert.equal(calls, 2);
  const decision = result.decisions.review.at(-1);
  assert.equal(decision.status, "ruled");
  assert.equal(decision.ruledBy, undefined);
  assert.equal(decision.candidate, "b conclusion");
  assert.equal(decision.humanResolution.selectedParticipant, "b");
  assert.equal(decision.rulingProvenance.kind, "humanResolution");
  assert.equal(decision.rulingProvenance.resolvedBy, "You");
  assert.equal(decision.participants.length, 2);
});

test("a human-selected conclusion aligns its supporting objections", async () => {
  const definition = reviewPipeline();
  definition.steps[0].consensusConfig.objectionsField = "objections";
  const result = await executePipeline(definition, "Review UI", [], async (agentId) => answer(agentId), callbacks(async () => ({ action: "acceptParticipant", selectedParticipant: "b" })));
  const decision = result.decisions.review.at(-1);
  assert.deepEqual(decision.objections.map(({ agentId, accepted }) => ({ agentId, accepted })), [
    { agentId: "a", accepted: false },
    { agentId: "b", accepted: true },
  ]);
});

test("a valid conclusion remains selectable beside malformed peer output", async () => {
  let calls = 0;
  const result = await executePipeline(reviewPipeline(), "Review UI", [], async (agentId) => {
    calls += 1;
    return agentId === "a" ? { status: "completed", answer: "malformed provider output" } : answer(agentId);
  }, callbacks(async (request) => {
    assert.equal(request.reason, "invalidConsensus");
    assert.deepEqual(request.conclusionOptions.map((option) => option.agentId), ["b"]);
    const ask = humanGateInteractionAsk(request, { taskId: "task" });
    assert.ok(ask.options.some((option) => option.id === "acceptParticipant:b"));
    assert.ok(!ask.options.some((option) => option.id === "acceptParticipant:a"));
    assert.ok(!request.allowedActions.includes("acceptUnresolved"));
    return { action: "acceptParticipant", selectedParticipant: "b", rationale: "Keep the validated conclusion" };
  }));
  assert.equal(calls, 2);
  assert.equal(result.completionReason, "humanDecision");
  const decision = result.decisions.review.at(-1);
  assert.equal(decision.candidate, "b conclusion");
  assert.equal(decision.participants.find((participant) => participant.agentId === "a").valid, false);
});

test("a human decision cannot select malformed peer output", async () => {
  await assert.rejects(executePipeline(reviewPipeline(), "Review UI", [], async (agentId) => agentId === "a"
    ? { status: "completed", answer: "malformed provider output" }
    : answer(agentId), callbacks(async () => ({ action: "acceptParticipant", selectedParticipant: "a" }))), /valid participant conclusion/u);
});

test("leaving a disagreement persists its exact decision and resumes without any provider calls", async () => {
  let checkpoint;
  let originalRequest;
  const first = await executePipeline(reviewPipeline(), "Review UI", [], async (agentId) => answer(agentId), callbacks(async (request) => {
    originalRequest = request;
    return { action: "cancel" };
  }, { onCheckpoint: (value) => { checkpoint = JSON.parse(JSON.stringify(value)); } }));
  assert.equal(first.status, "interrupted");
  assert.equal(checkpoint.snapshot.pendingConsensus.review.round, 2);
  assert.equal(checkpoint.snapshot.pendingConsensus.review.gateReason, "maxConsensusRounds");
  const resumed = await executePipeline(reviewPipeline(), "Review UI", [], async () => {
    throw new Error("Deferral must not invoke a participant");
  }, callbacks(async (request) => {
    assert.deepEqual(request, originalRequest);
    return { action: "acceptUnresolved", rationale: "Preserve the available findings" };
  }), undefined, checkpoint);
  assert.equal(resumed.completionReason, "humanDecision");
  assert.deepEqual(resumed.answers.review, first.answers.review);
});

test("one requested round sends instructions without a Lead and retains peer conclusions", async () => {
  const prompts = [];
  const requests = [];
  const result = await executePipeline(reviewPipeline(2), "Review UI", [], async (agentId, prompt) => {
    prompts.push({ agentId, prompt });
    return answer(agentId);
  }, callbacks(async (request) => {
    requests.push(request);
    return requests.length === 1 ? humanGateDecisionFromResponse({ selected: ["retry"], freeText: "Resolve only the keyboard focus disagreement" }, {
      allowedActions: request.allowedActions,
      stepName: request.step.name,
      interventionId: "instruction-1",
      now: "2026-09-13T00:00:00.000Z",
    }) : { action: "acceptUnresolved" };
  }));
  assert.equal(result.completionReason, "humanDecision");
  assert.equal(prompts.length, 6);
  assert.deepEqual(requests.map((request) => request.round), [3, 4]);
  for (const item of prompts.slice(4)) {
    assert.match(item.prompt, /Resolve only the keyboard focus disagreement/u);
    assert.match(item.prompt, item.agentId === "a" ? /b conclusion/u : /a conclusion/u);
    assert.match(item.prompt, /this one additional round/u);
  }
});

test("retry corrections and peer answers survive deferral before the next decision", async () => {
  let checkpoint;
  let requests = 0;
  await executePipeline(reviewPipeline(), "Review UI", [], async (agentId) => answer(agentId), callbacks(async () => {
    requests += 1;
    return requests === 1 ? { action: "retry", reviewInstructions: "Compare keyboard support", interventions: [{ id: "i", agentId: "a", prompt: "Correction", answer: "Keep keyboard navigation", createdAt: "2026-09-13" }] } : { action: "cancel" };
  }, { onCheckpoint: (value) => { checkpoint = JSON.parse(JSON.stringify(value)); } }));
  assert.deepEqual(checkpoint.snapshot.pendingConsensus.review.reviewInstructions, ["Compare keyboard support"]);
  assert.equal(checkpoint.snapshot.latestInterventions.values.a, "Keep keyboard navigation");
  assert.equal(checkpoint.snapshot.pendingConsensus.review.sourceAnswers.values.b, answer("b").answer);
  let gates = 0;
  const prompts = [];
  await executePipeline(reviewPipeline(), "Review UI", [], async (agentId, prompt) => {
    prompts.push(prompt);
    return answer(agentId);
  }, callbacks(async () => ++gates === 1 ? { action: "retry", reviewInstructions: "Prefer the smaller change" } : { action: "acceptUnresolved" }), undefined, checkpoint);
  assert.equal(prompts.length, 2);
  prompts.forEach((prompt) => {
    assert.match(prompt, /Compare keyboard support/u);
    assert.match(prompt, /Prefer the smaller change/u);
    assert.match(prompt, /Keep keyboard navigation/u);
  });
});

test("invalid consensus also resumes at its existing gate", async () => {
  let checkpoint;
  const definition = { ...reviewPipeline(), steps: [{ ...reviewPipeline().steps[0], humanGate: "none" }] };
  await executePipeline(definition, "Review UI", [], async () => ({ status: "completed", answer: "not valid JSON" }), callbacks(async () => ({ action: "cancel" }), { onCheckpoint: (value) => { checkpoint = structuredClone(value); } }));
  assert.equal(checkpoint.snapshot.pendingConsensus.review.gateReason, "invalidConsensus");
  const result = await executePipeline(definition, "Review UI", [], async () => {
    throw new Error("Existing invalid output must not be rerun");
  }, callbacks(async (request) => {
    assert.equal(request.reason, "invalidConsensus");
    return { action: "discardStep" };
  }), undefined, checkpoint);
  assert.equal(result.status, "completed");
});

test("corrupt and mismatched pending checkpoints are refused before provider execution", async () => {
  assert.equal(parsePendingConsensus({ review: { round: 2 } }), undefined);
  let checkpoint;
  await executePipeline(reviewPipeline(), "Review UI", [], async (agentId) => answer(agentId), callbacks(async () => ({ action: "cancel" }), { onCheckpoint: (value) => { checkpoint = structuredClone(value); } }));
  const corrupt = structuredClone(checkpoint.snapshot.pendingConsensus);
  corrupt.review.results.order.push("missing");
  assert.equal(parsePendingConsensus(corrupt), undefined);
  checkpoint.snapshot.decisions.review[0].round = 9;
  await assert.rejects(executePipeline(reviewPipeline(), "Review UI", [], async () => { throw new Error("Unexpected call"); }, callbacks(async () => ({ action: "cancel" })), undefined, checkpoint), /does not match/u);
});

test("participant selection must be a conclusion offered by the current gate", () => {
  const context = { allowedActions: ["acceptParticipant", "retry", "cancel"], stepName: "Review", interventionId: "i", now: "now", conclusionOptions: [{ agentId: "a", label: "Usability reviewer" }] };
  assert.deepEqual(humanGateDecisionFromResponse({ selected: ["acceptParticipant:a"], freeText: "Clarity wins" }, context), { action: "acceptParticipant", selectedParticipant: "a", rationale: "Clarity wins" });
  assert.equal(humanGateDecisionFromResponse({ selected: ["acceptParticipant:b"], freeText: "" }, context).action, "cancel");
  const request = { step: { id: "review", name: "Review" }, reason: "maxConsensusRounds", round: 3, decisionRound: 2, allowedActions: context.allowedActions, rollbackTargets: [], conclusionOptions: context.conclusionOptions };
  const ask = humanGateInteractionAsk(request, { taskId: "task" });
  assert.deepEqual(ask.humanGate, { stepId: "review", reason: "maxConsensusRounds", round: 3, decisionRound: 2 });
  assert.equal(ask.options.find((option) => option.id === "retry").label, "Request one more round");
  assert.match(ask.options.find((option) => option.id === "acceptParticipant:a").label, /Usability reviewer/u);
});

test("unresolved findings remain explicitly unresolved in the completed result", () => {
  const findings = modelFindingsFromDecisionArtifact({ stepId: "review", status: "resolved", humanResolution: { action: "acceptUnresolved" }, participants: ["a", "b"].map((agentId) => ({ agentId, candidate: { findings: [{ id: "focus", subject: "Focus", message: `${agentId} focus finding`, disposition: "accepted" }] } })) });
  assert.equal(findings.length, 2);
  assert.ok(findings.every((finding) => finding.disposition === "unresolved"));
  assert.ok(findings.every((finding) => finding.provenance.decisionStatus === "resolved"));
});

test("a failed pending-decision checkpoint cannot open a gate or request additional calls", async () => {
  let calls = 0;
  let gates = 0;
  await assert.rejects(executePipeline(reviewPipeline(), "Review UI", [], async (agentId) => {
    calls += 1;
    return answer(agentId);
  }, callbacks(async () => {
    gates += 1;
    return { action: "retry" };
  }, { onCheckpoint: (checkpoint) => {
    if (checkpoint.snapshot.pendingConsensus?.review?.gateReason) throw new Error("Checkpoint storage unavailable");
  } })), /Checkpoint storage unavailable/u);
  assert.equal(calls, 2);
  assert.equal(gates, 0);
});

test("a failed human-decision checkpoint does not publish successful resolution", async () => {
  const published = [];
  let checkpoint;
  await assert.rejects(executePipeline(reviewPipeline(), "Review UI", [], async (agentId) => answer(agentId), callbacks(async () => ({ action: "acceptUnresolved", rationale: "Keep findings" }), {
    onDecision: (artifact) => published.push(artifact),
    onCheckpoint: (value) => {
      if (value.nextStepIndex === 2) throw new Error("Decision persistence unavailable");
      checkpoint = structuredClone(value);
    },
  })), /Decision persistence unavailable/u);
  assert.equal(published.at(-1).status, "pending");
  assert.equal(checkpoint.snapshot.pendingConsensus.review.gateReason, "maxConsensusRounds");
});
