const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildDecisionArtifact,
  decisionCandidateErrors,
  parseDecisionParticipant,
} = require("../dist/pipeline/output.js");
const { executePipeline } = require("../dist/pipeline/runner.js");
const { validatePipelineDefinition } = require("../dist/pipeline/schema.js");
const {
  modelFindingsFromDecisionArtifact,
  modelFindingsFromStepOutputArtifact,
} = require("../dist/results/modelFindings.js");
const {
  CANDIDATE_SHAPE_NAMES,
  resolveCandidateShape,
} = require("../dist/pipeline/candidateShapes.js");

const decisionFields = {
  candidateField: "candidate",
  acceptedField: "accepted",
  acceptedValue: true,
  objectionsField: "objections",
  risksField: "unresolvedRisks",
  candidateShape: "ruledModelFindingSet",
};

const ruledFinding = (overrides = {}) => ({
  id: "f1",
  subject: "Cancellation guard",
  message: "Cancellation bypasses cleanup",
  disposition: "accepted",
  evidence: ["Both participants traced the bypass"],
  challenges: ["The finally block was inspected"],
  location: { file: "src/a.ts", startLine: 12, endLine: 12 },
  ...overrides,
});

const answer = (candidate, accepted = true) =>
  JSON.stringify({ candidate, accepted, objections: [], unresolvedRisks: [] });

test("the typed finding shape is declared once and resolved by name", () => {
  assert.deepEqual(CANDIDATE_SHAPE_NAMES.sort(), [
    "featureRequirementSet",
    "initiativePlan",
    "longitudinalDecisionSet",
    "productRecommendationSet",
    "proposedModelFindingSet",
    "repositoryAudit",
    "ruledModelFindingSet",
    "selfImprovementTaskPlan",
    "taskReviewVerdict",
  ]);
  assert.equal(resolveCandidateShape("nope"), undefined);
  assert.equal(resolveCandidateShape(undefined), undefined);
  assert.equal(resolveCandidateShape("ruledModelFindingSet").required[0], "findings");
  assert.equal(resolveCandidateShape("longitudinalDecisionSet").required[0], "decisions");
  assert.equal(resolveCandidateShape("productRecommendationSet").required[0], "recommendations");
  assert.equal(resolveCandidateShape("featureRequirementSet").required[0], "requirements");
});

test("a malformed consensus candidate makes the participant decision invalid", () => {
  const record = parseDecisionParticipant(
    "codex",
    answer({ findings: [{ id: "f1", subject: "x" }] }),
    decisionFields,
  );
  assert.equal(record.valid, false);
  assert.equal(record.accepted, false);
  assert.ok(record.validationErrors.length > 0);
  assert.ok(
    record.validationErrors.some((message) => message.includes("$.candidate.findings[0].message")),
    record.validationErrors.join("\n"),
  );
});

test("malformed findings produce explicit validation evidence instead of silent drops", () => {
  const errors = decisionCandidateErrors(
    { findings: [{ ...ruledFinding(), disposition: "proposed" }] },
    "candidate",
    "ruledModelFindingSet",
  );
  assert.deepEqual(errors, ["$.candidate.findings[0].disposition is not an allowed value"]);
  assert.deepEqual(
    decisionCandidateErrors({ findings: "not-a-list" }, "candidate", "ruledModelFindingSet"),
    ["$.candidate.findings must be array"],
  );
  assert.deepEqual(decisionCandidateErrors({ findings: [] }, "candidate", undefined), []);
});

test("a valid empty finding set is still an acceptable candidate", () => {
  const record = parseDecisionParticipant("codex", answer({ findings: [] }), decisionFields);
  assert.equal(record.valid, true);
  assert.equal(record.accepted, true);
  assert.deepEqual(record.validationErrors, []);
});

test("a malformed candidate cannot produce a completed decision with zero findings", () => {
  const malformed = parseDecisionParticipant(
    "codex",
    answer({ findings: [{ id: "f1" }] }),
    decisionFields,
  );
  const valid = parseDecisionParticipant(
    "claude",
    answer({ findings: [ruledFinding()] }),
    decisionFields,
  );
  const artifact = buildDecisionArtifact({
    stepId: "review-consensus",
    round: 1,
    policy: "unanimous",
    participants: [malformed, valid],
  });
  assert.equal(artifact.status, "pending");
  assert.equal(artifact.rulingProvenance, undefined);
  assert.deepEqual(modelFindingsFromDecisionArtifact(artifact), []);
});

test("an invalid arbiter ruling cannot complete the run", async () => {
  await assert.rejects(
    executePipeline(
      {
        version: 1,
        id: "arbiter-shape",
        name: "Arbiter shape",
        agents: [
          { id: "a", name: "A", adapter: "mock" },
          { id: "b", name: "B", adapter: "mock" },
        ],
        steps: [
          {
            id: "decision",
            type: "agent",
            name: "Decision",
            enabled: true,
            participants: ["a", "b"],
            promptTemplate: "decide",
            parallel: true,
            consensus: true,
            consensusConfig: {
              mode: "arbiter",
              maxRounds: 1,
              candidateField: "candidate",
              acceptedField: "accepted",
              arbiter: "b",
              onMaxRounds: "requestArbiterRuling",
              candidateShape: "ruledModelFindingSet",
            },
            humanGate: "none",
          },
        ],
      },
      "TASK",
      [],
      async () => ({
        status: "completed",
        answer: answer({ findings: [{ id: "f1", subject: "only a subject" }] }),
      }),
      {
        onStep: () => undefined,
        onRoles: () => undefined,
        onDecision: () => undefined,
        waitForHumanGate: async () => ({ action: "continue" }),
      },
    ),
    /did not publish an accepted valid decision/u,
  );
});

test("a well-formed unanimous run publishes accepted consensus findings", async () => {
  const decisions = [];
  const result = await executePipeline(
    {
      version: 1,
      id: "unanimous-shape",
      name: "Unanimous shape",
      agents: [
        { id: "a", name: "A", adapter: "mock" },
        { id: "b", name: "B", adapter: "mock" },
      ],
      steps: [
        {
          id: "review-consensus",
          type: "agent",
          name: "Consensus",
          enabled: true,
          participants: ["a", "b"],
          promptTemplate: "decide",
          parallel: true,
          consensus: true,
          consensusConfig: {
            mode: "unanimous",
            maxRounds: 2,
            candidateField: "candidate",
            acceptedField: "accepted",
            candidateShape: "ruledModelFindingSet",
          },
          humanGate: "none",
        },
      ],
    },
    "TASK",
    [],
    async () => ({ status: "completed", answer: answer({ findings: [ruledFinding()] }) }),
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      onDecision: (decision) => decisions.push(decision),
      waitForHumanGate: async () => ({ action: "continue" }),
    },
  );
  assert.equal(result.status, "completed");
  const artifact = decisions.at(-1);
  assert.equal(artifact.status, "accepted");
  assert.equal(artifact.rulingProvenance.kind, "unanimousConsensus");
  const findings = modelFindingsFromDecisionArtifact(artifact);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].disposition, "accepted");
});

test("single-provider proposed findings stay separate from accepted consensus findings", () => {
  const proposed = modelFindingsFromStepOutputArtifact({
    stepId: "review",
    agentId: "claude",
    value: { findings: [ruledFinding({ id: "solo", disposition: "accepted" })] },
  });
  assert.equal(proposed.length, 1);
  assert.equal(proposed[0].disposition, "proposed");
  assert.deepEqual(proposed[0].provenance.participantIds, ["claude"]);
  assert.equal(proposed[0].provenance.source, "stepOutput");
});

test("pipeline schema rejects unknown candidate and output shapes", () => {
  const preset = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "presets", "review-only.pipeline.json"), "utf8"),
  );
  const consensusStep = preset.steps.find((step) => step.id === "review-consensus");
  assert.equal(consensusStep.consensusConfig.candidateShape, "ruledModelFindingSet");
  consensusStep.consensusConfig.candidateShape = "notAShape";
  const rejected = validatePipelineDefinition(preset);
  assert.equal(rejected.success, false);
  assert.ok(rejected.errors.some((message) => message.includes("candidateShape must be one of")));
});

test("a step output declares exactly one of schema or shape", () => {
  const preset = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "presets", "claude-review.pipeline.json"), "utf8"),
  );
  const step = preset.steps.find((item) => item.output !== undefined);
  assert.equal(step.output.shape, "proposedModelFindingSet");
  assert.equal(step.output.schema, undefined);

  step.output.schema = { type: "object" };
  const both = validatePipelineDefinition(preset);
  assert.equal(both.success, false);
  assert.ok(both.errors.some((message) => message.includes("only one of schema or shape")));

  delete step.output.schema;
  delete step.output.shape;
  const neither = validatePipelineDefinition(preset);
  assert.equal(neither.success, false);
  assert.ok(neither.errors.some((message) => message.includes("must declare schema or shape")));
});

test("JSON is extracted from an answer the model framed, and only real JSON is accepted", () => {
  const { parseJsonResponse } = require("../dist/pipeline/output.js");
  // A model asked for JSON only still sometimes frames it. Refusing those throws away work
  // that is otherwise exactly right.
  assert.deepEqual(
    parseJsonResponse('Have enough. Repo tiny:\n\n```json\n{"status":"assessed"}\n```\n\nNote: tools were limited.'),
    { status: "assessed" },
  );
  assert.deepEqual(parseJsonResponse('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonResponse('  {"a":1}  '), { a: 1 });
  assert.deepEqual(parseJsonResponse('prefix {"a":"}"} suffix'), { a: "}" });
  assert.deepEqual(parseJsonResponse('lead [1,2] trail'), [1, 2]);
  // Nothing is repaired: an answer with no JSON is still a failure.
  assert.throws(() => parseJsonResponse("no json here"));
  assert.throws(() => parseJsonResponse('{"a":'));
});
