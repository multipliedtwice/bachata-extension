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
