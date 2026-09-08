const assert = require("node:assert/strict");
const test = require("node:test");

const { coreDecisionSourceFrom, mergeDecisionSources } =
  require("../dist/longitudinal/coreDecisionSources.js");

const decision = (overrides = {}) => ({
  subject: "Retry ownership",
  question: "Who owns the retry budget?",
  affectedScope: ["src/retry.ts"],
  evidence: ["Both traced the unbounded loop"],
  ...overrides,
});

// Exactly what savePipelineOutput writes.
const storedOutput = (overrides = {}) => ({
  outputRef: overrides.outputRef ?? "O1",
  name: "coreDecisions.codex",
  value: {
    stepId: "core-decisions",
    agentId: "codex",
    participant: "codex",
    name: "coreDecisions",
    hash: "h1",
    validationErrors: [],
    value: { decisions: overrides.decisions ?? [decision()] },
    ...(overrides.wrapper ?? {}),
  },
});

const definition = (step = {}) => ({
  id: "review-only",
  longitudinalIntent: "initiativeRequired",
  steps: [{
    type: "agent",
    id: "core-decisions",
    name: "Surface material decisions",
    participants: ["codex"],
    output: { name: "coreDecisions" },
    coreDecisionOutput: { field: "decisions" },
    ...step,
  }],
});

const sourceFor = (outputs, definitionOverride) => coreDecisionSourceFrom({
  definition: definitionOverride ?? definition(),
  outputs,
  outputRefs: new Set(outputs.map((output) => output.outputRef)),
});

test("an ordinary workflow's declared output becomes a core-decision source", () => {
  const result = sourceFor([storedOutput()]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.source.stepId, "core-decisions");
  assert.deepEqual(result.source.participantIds, ["codex"]);
  assert.equal(result.source.candidates.length, 1);
  assert.equal(result.source.candidates[0].subject, "Retry ownership");
  assert.deepEqual(result.source.candidates[0].affectedScope, ["src/retry.ts"]);
});

test("no material decision produces no decision source and no error", () => {
  const empty = sourceFor([storedOutput({ decisions: [] })]);
  assert.equal(empty.source, undefined, "an empty list produced a decision");
  assert.deepEqual(empty.errors, []);
});

test("a step that declared nothing contributes nothing", () => {
  const undeclared = definition({ coreDecisionOutput: undefined });
  delete undeclared.steps[0].coreDecisionOutput;
  const result = sourceFor([storedOutput()], undeclared);
  assert.equal(result.source, undefined, "an undeclared consensus ruling became a decision");
  assert.deepEqual(result.errors, []);
});

test("an incomplete candidate is refused and states exactly what is missing", () => {
  const result = sourceFor([storedOutput({
    decisions: [{ subject: "Retry ownership", question: "Who owns it?" }],
  })]);
  assert.equal(result.source, undefined, "an incomplete decision became durable");
  assert.ok(result.errors.some((error) => /has no affected scope/u.test(error)));
  assert.ok(result.errors.some((error) => /has no evidence/u.test(error)));
});

test("structurally unusable output becomes an evidence gap, never a decision", () => {
  const notAList = sourceFor([storedOutput({ decisions: undefined, wrapper: {
    value: { decisions: "two of them" },
  } })]);
  assert.equal(notAList.source, undefined);
  assert.ok(notAList.errors.some((error) => /is not a list/u.test(error)));

  const malformed = sourceFor([storedOutput({ decisions: ["just a string"] })]);
  assert.equal(malformed.source, undefined);
  assert.ok(malformed.errors.some((error) => /is not a decision object/u.test(error)));
});

test("an output that failed its own schema contributes nothing", () => {
  const result = sourceFor([storedOutput({ wrapper: { validationErrors: ["bad shape"] } })]);
  assert.equal(result.source, undefined);
  assert.deepEqual(result.errors, []);
});

test("nothing is invented: optional judgment material stays absent", () => {
  const result = sourceFor([storedOutput()]);
  const candidate = result.source.candidates[0];
  assert.deepEqual(candidate.options, [], "options were invented");
  assert.deepEqual(candidate.tradeOffs, [], "trade-offs were invented");
  assert.equal(candidate.recommendation, undefined, "a recommendation was invented");
});

test("a paired step promotes only the named participant's judgment", () => {
  const paired = definition({
    participants: ["codex", "claude"],
    coreDecisionOutput: { field: "decisions", producedBy: "claude" },
  });
  const outputs = [
    storedOutput({ outputRef: "O1" }),
    {
      outputRef: "O2",
      name: "coreDecisions.claude",
      value: {
        stepId: "core-decisions",
        agentId: "claude",
        participant: "claude",
        name: "coreDecisions",
        hash: "h2",
        validationErrors: [],
        value: { decisions: [decision({ subject: "Cancellation ownership" })] },
      },
    },
  ];
  const result = coreDecisionSourceFrom({
    definition: paired,
    outputs,
    outputRefs: new Set(["O1", "O2"]),
  });
  assert.equal(result.source.candidates.length, 1);
  assert.equal(result.source.candidates[0].subject, "Cancellation ownership");
});

test("merging sources never repeats one subject and scope", () => {
  const consensus = { source: { stepId: "s", participantIds: ["claude"], candidates: [decision()] }, errors: [] };
  const declared = sourceFor([storedOutput()]);
  const merged = mergeDecisionSources(consensus, declared);
  assert.equal(
    merged.source.candidates.length,
    1,
    "a replayed or duplicated decision was carried twice",
  );
  assert.deepEqual(merged.source.participantIds.sort(), ["claude", "codex"]);
});
