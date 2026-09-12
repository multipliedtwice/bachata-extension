const assert = require("node:assert/strict");
const test = require("node:test");
const { consensusAcceptanceFor, matchesConsensusAcceptance, parseConsensusAcceptance } = require("../dist/pipeline/consensusPromotion.js");
const { buildDecisionArtifact, parseDecisionParticipant } = require("../dist/pipeline/output.js");
const { executePipeline } = require("../dist/pipeline/runner.js");
const { validatePipelineDefinition } = require("../dist/pipeline/schema.js");
const { declaredArtifactSourcesFor } = require("../dist/longitudinal/declaredArtifactSources.js");
const { produceDeclaredArtifact } = require("../dist/longitudinal/artifacts.js");
const { parseRecordProvenance } = require("../dist/longitudinal/parse.js");
const preset = require("../presets/feature-delivery.pipeline.json");
const candidate = { title: "Bound retries", requirements: [{ id: "retry-limit", disposition: "accepted", statement: "Stop after the requested attempts", acceptanceCriteria: ["Two requested attempts make two calls"], evidence: ["src/retry.ts"], challenges: [] }] };
const response = (value = candidate) => JSON.stringify({ candidate: value, accepted: true });
const decision = (overrides = {}) => buildDecisionArtifact({
  stepId: "requirement-consensus", round: 2, policy: "unanimous",
  participants: ["codex", "claude"].map((id) => parseDecisionParticipant(id, response(), { candidateField: "candidate", acceptedField: "accepted", acceptedValue: true })),
  ...overrides,
});
const receipt = () => consensusAcceptanceFor(decision(), candidate, "requirement-consensus");

test("consensus receipt binds exact content, participants, ruling and round", () => {
  const accepted = receipt();
  assert.equal(accepted.round, 2);
  assert.equal(accepted.ruling, "accepted");
  assert.deepEqual(accepted.participantIds, ["codex", "claude"]);
  assert.equal(matchesConsensusAcceptance(accepted, { requirements: candidate.requirements, title: candidate.title }, "requirement-consensus"), true);
  assert.equal(matchesConsensusAcceptance(accepted, { ...candidate, summary: "Added after agreement" }, "requirement-consensus"), false);
  assert.equal(matchesConsensusAcceptance(accepted, candidate, "another-step"), false);
  assert.deepEqual(parseRecordProvenance({ authoredBy: "model", participantIds: ["codex", "claude"], consensusAcceptance: accepted }).consensusAcceptance, accepted);
  assert.equal(parseRecordProvenance({ authoredBy: "model", participantIds: [] }).consensusAcceptance, undefined);
});

for (const [name, mutate] of [
  ["pending ruling", (value) => { value.status = "pending"; }],
  ["mismatched content", (value) => { value.candidate.title = "Changed"; }],
  ["mismatched participant", (value) => { value.participants[0].candidateHash = "b".repeat(64); }],
  ["duplicate participants", (value) => { value.participants.push(value.participants[0]); }],
  ["invalid participant", (value) => { value.participants[1].validationErrors = ["Invalid candidate"]; }],
  ["invalid round", (value) => { value.round = 0; }],
  ["unissued step", (value) => { value.stepId = "other"; }],
  ["malformed digest", (value) => { value.candidateHash = value.candidateHash.toUpperCase(); }],
]) test(`consensus promotion refuses ${name}`, () => {
  const value = structuredClone(decision());
  mutate(value);
  assert.equal(consensusAcceptanceFor(value, candidate, "requirement-consensus"), undefined);
});

test("arbiter provenance requires the accepted participant who actually ruled", () => {
  const value = decision({ policy: "arbiter", ruledBy: "claude" });
  assert.equal(consensusAcceptanceFor(value, candidate, value.stepId).ruledBy, "claude");
  value.ruledBy = "unissued";
  assert.equal(consensusAcceptanceFor(value, candidate, value.stepId), undefined);
});

test("consensus boundary refuses huge and cyclic values", () => {
  assert.equal(consensusAcceptanceFor(decision(), "x".repeat(300_000), "requirement-consensus"), undefined);
  const cycle = {}; cycle.self = cycle;
  assert.equal(consensusAcceptanceFor(decision(), cycle, "requirement-consensus"), undefined);
  assert.equal(parseConsensusAcceptance({ ...receipt(), participantIds: Array(65).fill("codex") }), undefined);
});

const sourceInput = () => ({
  definition: preset,
  outputs: [{ outputRef: "O1", name: "featureRequirements.codex", value: { stepId: "requirement-record", name: "featureRequirements", agentId: "codex", validationErrors: [], value: structuredClone(candidate) } }],
  outputRefs: new Set(["O1"]), decisions: [decision()],
});

test("current controller decision supplies promotion provenance; stale or missing acceptance refuses", () => {
  const input = sourceInput();
  const sources = declaredArtifactSourcesFor(input);
  assert.equal(sources.length, 1);
  assert.deepEqual(sources[0].participantIds, ["codex", "claude"]);
  assert.deepEqual(sources[0].consensusAcceptance, receipt());
  for (const decisions of [[], [decision(), { ...decision(), status: "pending", round: 3 }]]) {
    assert.deepEqual(declaredArtifactSourcesFor({ ...input, decisions }), []);
  }
  input.outputs[0].value.value.title = "Recorder substituted content";
  assert.deepEqual(declaredArtifactSourcesFor(input), []);
});

test("durable artifact producer independently enforces consensus binding", () => {
  const [source] = declaredArtifactSourcesFor(sourceInput());
  const input = { ...source, createId: () => "T1", initiativeId: "N1", cycleId: "Y1", runRef: "R1", recordedAt: "2026-09-12T00:00:00.000Z" };
  const produced = produceDeclaredArtifact(input);
  assert.deepEqual(produced.artifact.provenance.consensusAcceptance, receipt());
  assert.deepEqual(JSON.parse(produced.artifact.body), candidate);
  assert.equal(produceDeclaredArtifact({ ...input, consensusAcceptance: undefined }), undefined);
  assert.equal(produceDeclaredArtifact({ ...input, output: { ...candidate, title: "Different" } }), undefined);
});

for (const mismatch of [false, true]) test(`Feature Delivery recorder ${mismatch ? "cannot change" : "preserves"} consensus content before any write turn`, async () => {
  const definition = structuredClone(preset);
  definition.steps = definition.steps.slice(0, 3);
  const called = [];
  const published = [];
  const run = executePipeline(definition, "Repair retry handling", [], async (agentId, prompt, step) => {
    called.push({ agentId, stepId: step.id });
    return { status: "completed", answer: step.id === "requirement-consensus" ? response() : step.id === "requirement-record" ? JSON.stringify({ ...candidate, ...(mismatch ? { title: "Altered by recorder" } : {}) }) : "Inspect retry handling" };
  }, { onStep() {}, onRoles() {}, onOutput: (value) => published.push(value), waitForHumanGate: async () => ({ action: "continue" }) });
  if (mismatch) {
    await assert.rejects(run, /does not match the latest accepted consensus candidate/);
    assert.ok(published[0].validationErrors.length > 0);
  } else {
    assert.equal((await run).status, "completed");
    assert.deepEqual(published[0].value, candidate);
  }
  assert.equal(called.filter((entry) => entry.stepId === "requirement-consensus").length, 2);
});

test("pipeline schema requires a prior enabled consensus source and output", () => {
  assert.equal(validatePipelineDefinition(preset).success, true);
  for (const source of ["missing", "design-record", "requirement-record"]) {
    const copy = structuredClone(preset);
    copy.steps[2].artifactPromotion.fromConsensusStep = source;
    assert.equal(validatePipelineDefinition(copy).success, false);
  }
  const copy = structuredClone(preset);
  copy.steps[1].enabled = false;
  assert.equal(validatePipelineDefinition(copy).success, false);
});
