const assert = require("node:assert/strict");
const test = require("node:test");

const {
  legacyRulingProvenance,
  parseRulingProvenance,
  rulingProvenanceDetail,
  rulingProvenanceRuledBy,
} = require("../dist/results/rulingProvenance.js");
const {
  mergeRunResults,
  parseRunResult,
  projectRunResult,
} = require("../dist/results/projectResult.js");
const {
  buildDecisionArtifact,
  decisionRulingProvenance,
} = require("../dist/pipeline/output.js");

const providers = [
  { name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" },
  { name: "Claude", adapter: "claude-code" },
];

const identities = {
  codex: { agentId: "codex", provider: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" },
  claude: { agentId: "claude", provider: "Claude", adapter: "claude-code" },
};

const participant = (agentId, overrides = {}) => ({
  agentId,
  valid: true,
  accepted: true,
  candidate: { findings: [] },
  candidateHash: "hash-a",
  objections: [],
  unresolvedRisks: [],
  validationErrors: [],
  ...overrides,
});

const consensusProvenance = {
  kind: "unanimousConsensus",
  participants: [identities.codex, identities.claude],
};

test("a unanimous decision records participant identities without naming a ruler", () => {
  const artifact = buildDecisionArtifact({
    stepId: "review-consensus",
    round: 1,
    policy: "unanimous",
    participants: [participant("codex"), participant("claude")],
    identities,
  });
  assert.equal(artifact.status, "accepted");
  assert.equal(artifact.ruledBy, undefined);
  assert.equal(artifact.rulingProvenance.kind, "unanimousConsensus");
  assert.deepEqual(
    artifact.rulingProvenance.participants.map((item) => item.agentId),
    ["codex", "claude"],
  );
  assert.equal(artifact.rulingProvenance.participants[0].provider, "Codex");
  assert.equal(artifact.rulingProvenance.participants[0].model, "gpt-5-codex");
  assert.equal(artifact.rulingProvenance.ruledBy, undefined);
  assert.equal(rulingProvenanceRuledBy(artifact.rulingProvenance), undefined);
});

test("a single participant decision is a single-provider result, not a consensus", () => {
  const artifact = buildDecisionArtifact({
    stepId: "solo",
    round: 1,
    policy: "unanimous",
    participants: [participant("claude")],
    identities,
  });
  assert.equal(artifact.rulingProvenance.kind, "singleProvider");
  assert.equal(rulingProvenanceRuledBy(artifact.rulingProvenance), "claude");
});

test("an arbiter ruling stays distinct from unanimous consensus", () => {
  const artifact = buildDecisionArtifact({
    stepId: "arbiter-step",
    round: 2,
    policy: "arbiter",
    participants: [participant("claude")],
    ruledBy: "claude",
    identities,
  });
  assert.equal(artifact.status, "ruled");
  assert.equal(artifact.rulingProvenance.kind, "arbiterRuling");
  assert.equal(artifact.rulingProvenance.ruledBy, "claude");
  assert.match(rulingProvenanceDetail(artifact.rulingProvenance), /^Arbiter ruling by Claude/u);
  assert.notEqual(artifact.rulingProvenance.kind, consensusProvenance.kind);
});

test("a pending decision publishes no ruling provenance", () => {
  const artifact = buildDecisionArtifact({
    stepId: "review-consensus",
    round: 1,
    policy: "unanimous",
    participants: [participant("codex"), participant("claude", { accepted: false })],
    identities,
  });
  assert.equal(artifact.status, "pending");
  assert.equal(artifact.rulingProvenance, undefined);
  assert.equal(
    decisionRulingProvenance({
      status: "pending",
      participants: [participant("codex")],
    }),
    undefined,
  );
});

test("a valid two-provider consensus is conclusive instead of inconclusive", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    finalRuling: "Both providers accepted the same candidate",
    rulingProvenance: consensusProvenance,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  assert.equal(result.rulingBy, undefined);
  assert.deepEqual(result.evidenceGaps, []);
  assert.equal(result.finalAssessment.outcome, "completed");
  assert.equal(result.finalAssessment.method, "consensus");
  assert.equal(
    result.evidence.find((entry) => entry.kind === "rulingProvenance").detail,
    "Unanimous consensus of Codex (codex-app-server · gpt-5-codex), Claude (claude-code)",
  );
});

test("typed arbiter provenance overrides stale legacy consensus flags", () => {
  const arbiterProvenance = {
    kind: "arbiterRuling",
    participants: [identities.codex, identities.claude],
    ruledBy: "claude",
  };
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    finalRuling: "Claude ruled after disagreement",
    rulingProvenance: arbiterProvenance,
    consensusRuling: true,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  assert.equal(result.consensusRuling, undefined);
  assert.equal(result.finalAssessment.method, "arbiter");

  const restored = parseRunResult({ ...result, consensusRuling: true });
  assert.equal(restored.consensusRuling, undefined);
  assert.equal(restored.finalAssessment.method, "arbiter");
});

test("legacy consensus survives persistence without typed provenance", () => {
  const projected = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    finalRuling: "Models aligned",
    rulingBy: "claude",
    consensusRuling: true,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  const restored = parseRunResult(projected);
  assert.equal(restored.consensusRuling, true);
  assert.equal(restored.rulingProvenance, undefined);
  assert.equal(restored.rulingBy, "claude");
  assert.equal(restored.finalAssessment.method, "consensus");
});

test("ruling provenance survives persistence and restart", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    providers,
    finalRuling: "Accepted",
    rulingProvenance: consensusProvenance,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  const restored = parseRunResult(JSON.parse(JSON.stringify(result)));
  assert.deepEqual(restored.rulingProvenance, consensusProvenance);
  assert.equal(restored.finalAssessment.method, "consensus");
  assert.deepEqual(restored.evidenceGaps, []);
});

test("a rerun does not inherit the previous execution's ruling provenance", () => {
  const first = projectRunResult({
    status: "completed",
    transcript: [],
    executionRef: "E1",
    providers,
    finalRuling: "Accepted by consensus",
    rulingProvenance: consensusProvenance,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  const rerunWithNewRuling = projectRunResult({
    status: "completed",
    transcript: [],
    executionRef: "E1",
    providers,
    finalRuling: "Arbiter decided",
    rulingProvenance: {
      kind: "arbiterRuling",
      participants: [identities.claude],
      ruledBy: "claude",
    },
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  const merged = mergeRunResults(first, rerunWithNewRuling);
  assert.equal(merged.rulingProvenance.kind, "arbiterRuling");
  assert.equal(merged.rulingBy, "claude");
  assert.equal(merged.consensusRuling, undefined);
  assert.equal(merged.finalAssessment.method, "arbiter");

  const laterExecution = projectRunResult({
    status: "completed",
    transcript: [],
    executionRef: "E2",
    providers,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  const across = mergeRunResults(first, laterExecution);
  assert.equal(across.rulingProvenance, undefined);
  assert.equal(across.rulingBy, undefined);
});

test("legacy persisted results parse safely", () => {
  const legacy = parseRunResult({
    status: "completed",
    changedFiles: [],
    checks: [],
    finalRuling: "Accepted",
    rulingBy: "claude",
    providers,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  assert.equal(legacy.rulingBy, "claude");
  assert.equal(legacy.rulingProvenance.kind, "arbiterRuling");
  assert.equal(
    legacy.evidence.find((entry) => entry.kind === "rulingProvenance").state,
    "recorded",
  );

  const malformed = parseRunResult({
    status: "completed",
    finalRuling: "Accepted",
    rulingProvenance: { kind: "unanimousConsensus", participants: [{ agentId: "solo" }] },
    providers,
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  assert.equal(malformed.rulingProvenance, undefined);
  assert.deepEqual(malformed.evidenceGaps, ["The ruling provider was not recorded"]);
});

test("ruling provenance rejects incoherent shapes", () => {
  assert.equal(parseRulingProvenance(undefined), undefined);
  assert.equal(parseRulingProvenance({ kind: "unknownKind", participants: [] }), undefined);
  assert.equal(
    parseRulingProvenance({ kind: "arbiterRuling", participants: [{ agentId: "a" }], ruledBy: "b" }),
    undefined,
  );
  assert.equal(
    parseRulingProvenance({ kind: "unanimousConsensus", participants: [{ agentId: "a" }, { agentId: "b" }], ruledBy: "a" }),
    undefined,
  );
  assert.equal(parseRulingProvenance({ kind: "humanResolution", participants: [] }), undefined);
  assert.equal(parseRulingProvenance({ kind: "singleProvider", participants: [{}] }), undefined);
  assert.deepEqual(
    parseRulingProvenance({ kind: "controllerVerification" }),
    { kind: "controllerVerification", participants: [] },
  );
  assert.equal(
    rulingProvenanceDetail({ kind: "controllerVerification", participants: [] }),
    "Controller verification",
  );
  assert.equal(
    rulingProvenanceDetail({ kind: "humanResolution", participants: [], resolvedBy: "owner" }),
    "Human resolution by owner",
  );
  assert.equal(legacyRulingProvenance(undefined), undefined);
});
