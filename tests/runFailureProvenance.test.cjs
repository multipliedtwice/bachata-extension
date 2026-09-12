const assert = require("node:assert/strict");
const test = require("node:test");

const {
  failedBeforeRulingSummary,
  mergeRunResults,
  projectRunResult,
  runFailureFrom,
} = require("../dist/results/projectResult.js");

const executed = [
  { agentId: "builder", name: "Builder", adapter: "claude-code", model: "claude-opus-5" },
  { agentId: "lead", name: "Lead", adapter: "codex-app-server", model: "gpt-6-astra" },
];

const errorEntry = (overrides) => ({
  id: "e1",
  kind: "error",
  text: "Codex rejected the model",
  createdAt: new Date().toISOString(),
  ...overrides,
});

test("a failure is attributed to the provider that actually ran, not to the pipeline's default", () => {
  const failure = runFailureFrom([errorEntry({ agentId: "lead", step: "Cross-check" })], executed);
  assert.deepEqual(failure, {
    error: "Codex rejected the model",
    agentId: "lead",
    step: "Cross-check",
    participant: "Lead",
    adapter: "codex-app-server",
    model: "gpt-6-astra",
  });
});

test("a recovered error is not what ended the run, and the last unrecovered one is", () => {
  const transcript = [
    errorEntry({ id: "e1", agentId: "builder", step: "Build", text: "transient" }),
    { id: "r1", kind: "event", eventType: "agent.recovered", agentId: "builder", step: "Build", text: "recovered", createdAt: new Date().toISOString() },
    errorEntry({ id: "e2", agentId: "lead", step: "Cross-check", text: "fatal" }),
  ];
  assert.equal(runFailureFrom(transcript, executed).error, "fatal");
  assert.equal(runFailureFrom([transcript[0], transcript[1]], executed), undefined);
});

test("a run that dies before a ruling says so, and is never dressed as an ordinary assessment", () => {
  const result = projectRunResult({
    status: "error",
    transcript: [errorEntry({ agentId: "lead", step: "Cross-check" })],
    providers: executed,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  assert.equal(result.finalAssessment.outcome, "failedBeforeRuling");
  assert.notEqual(result.finalAssessment.outcome, "inconclusive");
  assert.match(result.finalAssessment.summary, /^Failed before final ruling/u);
  assert.match(result.finalAssessment.summary, /Lead \(codex-app-server · gpt-6-astra\)/u);
  assert.match(result.finalAssessment.summary, /at step Cross-check/u);
  assert.equal(result.finalAssessment.failure.adapter, "codex-app-server");
  assert.equal(result.failure.model, "gpt-6-astra");
});

test("a terminal run with no error is still inconclusive rather than a failure", () => {
  const result = projectRunResult({
    status: "interrupted",
    transcript: [],
    providers: executed,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  assert.equal(result.finalAssessment.outcome, "inconclusive");
  assert.equal(result.failure, undefined);
});

test("a failure summary states only what the run recorded", () => {
  assert.equal(
    failedBeforeRulingSummary({ error: "the run died" }),
    "Failed before final ruling: the run died",
  );
  assert.equal(
    failedBeforeRulingSummary({ error: "boom", agentId: "lead" }),
    "Failed before final ruling: lead — boom",
  );
  assert.equal(
    failedBeforeRulingSummary({ error: "boom", participant: "Lead", provider: "chatgpt" }),
    "Failed before final ruling: Lead (chatgpt) — boom",
  );
});

test("a finished run's provenance is not rewritten by a later reassignment", () => {
  const persisted = projectRunResult({
    status: "completed",
    transcript: [],
    providers: executed,
    changedFiles: [],
    expectations: { changedFiles: false, verification: false, finalRuling: false },
    executionRef: "E10",
  });
  // The live projection is rebuilt from whatever the conversation is assigned now. A reader who
  // reassigns after the run must not thereby restate which providers produced it.
  const live = projectRunResult({
    status: "completed",
    transcript: [],
    providers: [{ agentId: "builder", name: "Builder", adapter: "chatgpt-browser" }],
    changedFiles: [],
    expectations: { changedFiles: false, verification: false, finalRuling: false },
    executionRef: "E10",
  });
  const merged = mergeRunResults(persisted, live);
  assert.deepEqual(merged.providers.map((provider) => provider.adapter), [
    "claude-code",
    "codex-app-server",
  ]);
});
