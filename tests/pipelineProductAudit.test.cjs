const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { validatePipelineDefinition } = require("../dist/pipeline/schema.js");
const { assignmentSlots } = require("../dist/pipeline/agentAssignment.js");
const { executePipeline } = require("../dist/pipeline/runner.js");
const load = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, "../presets", `${name}.pipeline.json`), "utf8"));

test("every shipped pipeline title and participant label describes work independently of providers", () => {
  const names = fs.readdirSync(path.join(__dirname, "../presets")).filter((name) => name.endsWith(".pipeline.json"));
  for (const name of names) {
    const pipeline = JSON.parse(fs.readFileSync(path.join(__dirname, "../presets", name), "utf8"));
    assert.doesNotMatch(pipeline.name, /Codex|Claude|ChatGPT|\bGPT\b|Grok|Z\.AI/iu, name);
    for (const agent of pipeline.agents) assert.doesNotMatch(agent.name, /Codex|Claude|ChatGPT|\bGPT\b|Grok|Z\.AI/iu, name);
    for (const step of pipeline.steps) assert.doesNotMatch(step.name, /Codex|Claude|ChatGPT|\bGPT\b|Grok|Z\.AI/iu, name);
    const valid = validatePipelineDefinition(pipeline);
    assert.equal(valid.success, true, `${name}: ${JSON.stringify(valid.errors)}`);
  }
});

test("UI/UX review has no write phase and refuses to infer a visual verdict from code alone", () => {
  const pipeline = load("ui-ux-review");
  assert.equal(pipeline.longitudinalIntent, "runLocal");
  assert.equal(pipeline.steps.length, 2);
  assert.equal(pipeline.steps[1].consensusConfig.maxRounds, 4);
  assert.match(pipeline.steps[0].promptTemplate, /do not invent a visual verdict/u);
  for (const step of pipeline.steps) {
    assert.equal(step.type, "agent");
    assert.deepEqual(Object.values(step.permissionModes).sort(), ["plan", "readOnly"]);
  }
});

test("UI/UX review produces a shared report without changing its review authority or human gates", async () => {
  const pipeline = load("ui-ux-review");
  const reconciliation = pipeline.steps[1];
  assert.equal(reconciliation.consensusConfig.mode, "unanimous");
  assert.equal(reconciliation.consensusConfig.arbiter, undefined);
  assert.equal(reconciliation.consensusConfig.onMaxRounds, "humanGate");
  assert.equal(reconciliation.humanGate, "after");
  assert.match(reconciliation.promptTemplate, /candidate must be \{"summary":"\.\.\.","findings":\[\.\.\.\]\}/u);
  assert.match(reconciliation.promptTemplate, /what converged, what was rejected, what remains unresolved, and why/u);
  assert.match(reconciliation.promptTemplate, /Do not invent agreement or turn unresolved findings into confirmed defects/u);
  const candidate = { summary: "No defect was confirmed. Visual acceptance remains unresolved because screenshots are missing.", findings: [] };
  const decisions = [];
  const gates = [];
  const calls = [];
  const result = await executePipeline(pipeline, "Review the interface", [], async (agentId, prompt, step, options) => {
    calls.push({ agentId, stepId: step.id, options });
    return { status: "completed", answer: step.consensus
      ? JSON.stringify({ candidate, accepted: true, objections: [], unresolvedRisks: ["Visual acceptance is unverified"] })
      : "No screenshots were supplied; code inspection does not establish visual acceptance." };
  }, {
    onStep: () => {},
    onRoles: () => {},
    onDecision: (decision) => decisions.push(decision),
    waitForHumanGate: async (gate) => { gates.push(gate); return { action: "continue" }; },
  }, new AbortController().signal);
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 4);
  assert.deepEqual([...new Set(calls.map((call) => call.stepId))], ["independent-review", "review-consensus"]);
  assert.equal(calls.every((call) => call.options.readOnly), true);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].status, "accepted");
  assert.equal(decisions[0].rulingProvenance.kind, "unanimousConsensus");
  assert.deepEqual(decisions[0].candidate, candidate);
  assert.deepEqual(decisions[0].unresolvedRisks, ["Visual acceptance is unverified"]);
  assert.equal(gates.length, 1);
  assert.equal(gates[0].reason, "afterStep");
});

test("code refinement reviews first, writes serially, then performs one explicit revision and final review", async () => {
  const pipeline = load("code-review-refine");
  assert.equal(pipeline.longitudinalIntent, "runLocal");
  assert.equal(pipeline.managedPolicy.commitMode, "never");
  assert.deepEqual(pipeline.managedPolicy.allowedPaths, ["src", "tests"]);
  assert.equal(pipeline.managedPolicy.maxRevisionCycles, undefined);
  assert.deepEqual(assignmentSlots(pipeline).slots.map((slot) => slot.agentId), ["implementer", "reviewer"]);
  const calls = [];
  let writers = 0;
  let maximumWriters = 0;
  const result = await executePipeline(pipeline, "Review the interrupt race and refine confirmed defects", [], async (agentId, prompt, step, options) => {
    calls.push({ agentId, step: step.id, options });
    if (options.managedRole === "worker") { writers += 1; maximumWriters = Math.max(maximumWriters, writers); }
    await Promise.resolve();
    if (options.managedRole === "worker") writers -= 1;
    return { status: "completed", answer: step.consensus ? JSON.stringify({ candidate: { findings: [] }, accepted: true, objections: [], unresolvedRisks: [] }) : "Inspected the declared scope." };
  }, { onStep: () => {}, onRoles: () => {}, waitForHumanGate: async () => ({ action: "continue" }) }, new AbortController().signal);
  assert.equal(result.status, "completed");
  const order = [...new Set(calls.map((call) => call.step))];
  assert.deepEqual(order, ["independent-review", "review-consensus", "worker-turn", "lead-review", "worker-revision", "lead-final-review"]);
  assert.equal(maximumWriters, 1);
  assert.equal(calls.filter((call) => call.step === "worker-revision").length, 1);
  for (const call of calls.filter((call) => call.options.managedRole === "lead")) assert.equal(call.options.readOnly, true);
});
