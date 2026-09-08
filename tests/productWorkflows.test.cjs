const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { validatePipelineDefinition } = require("../dist/pipeline/schema.js");
const { resolveCandidateShape } = require("../dist/pipeline/candidateShapes.js");
const { validateJsonOutput } = require("../dist/pipeline/output.js");
const {
  buildDecisionArtifact,
  parseDecisionParticipant,
} = require("../dist/pipeline/output.js");
const { declaredArtifactSourcesFor } = require("../dist/longitudinal/declaredArtifactSources.js");
const { produceDeclaredArtifact } = require("../dist/longitudinal/artifacts.js");
const { workflowCards, resolveWorkflowCards } = require("../dist/workflows/catalog.js");
const { directionView } = require("../dist/longitudinal/direction.js");

const preset = (id) => JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "presets", `${id}.pipeline.json`), "utf8"),
);

const productReview = preset("product-review");
const featureDelivery = preset("feature-delivery");

const stepById = (pipeline, id) => pipeline.steps.find((step) => step.id === id);

const recommendation = (id, disposition) => ({
  id,
  subject: `subject ${id}`,
  statement: `statement ${id}`,
  rationale: `rationale ${id}`,
  disposition,
  evidence: ["src/a.ts"],
  challenges: [],
});

const requirement = (id, disposition) => ({
  id,
  statement: `statement ${id}`,
  acceptanceCriteria: ["the run records it"],
  disposition,
  evidence: ["src/a.ts"],
  challenges: [],
});

const consensusOf = (pipeline) => pipeline.steps.find((step) => step.consensus === true);

const decisionConfig = (pipeline) => {
  const config = consensusOf(pipeline).consensusConfig;
  return {
    candidateField: config.candidateField,
    acceptedField: config.acceptedField,
    acceptedValue: config.acceptedValue,
    objectionsField: config.objectionsField,
    risksField: config.risksField,
    candidateShape: config.candidateShape,
  };
};

const answer = (candidate, accepted, extra = {}) =>
  JSON.stringify({ candidate, accepted, objections: [], unresolvedRisks: [], ...extra });

test("both product presets are valid, initiative-bound pipelines", () => {
  for (const pipeline of [productReview, featureDelivery]) {
    const result = validatePipelineDefinition(pipeline);
    assert.deepEqual(result.errors ?? [], [], `${pipeline.id} does not validate`);
    assert.equal(result.success, true, `${pipeline.id} does not validate`);
    assert.equal(pipeline.longitudinalIntent, "initiativeRequired");
  }
});

test("both presets are reachable as first-class goals, not only as schema", () => {
  const cards = workflowCards();
  assert.equal(
    cards.find((card) => card.id === "productReview").pipelineIds.includes("product-review"),
    true,
  );
  assert.equal(
    cards.find((card) => card.id === "featureDelivery").pipelineIds.includes("feature-delivery"),
    true,
  );
  const projected = resolveWorkflowCards(cards, [
    { pipelineId: "product-review", status: "ready", findings: [] },
    { pipelineId: "feature-delivery", status: "needsSetup", findings: [{ status: "needsSetup", detail: "Claude missing" }] },
  ], { "product-review": "Product review", "feature-delivery": "Feature delivery" });
  const product = projected.find((card) => card.id === "productReview");
  const feature = projected.find((card) => card.id === "featureDelivery");
  assert.equal(product.status, "ready");
  assert.equal(product.pipelineId, "product-review");
  assert.match(feature.readinessDetail, /Feature delivery: Claude missing/u);
});

test("each preset converges on one cross-checked candidate and bounds its rounds", () => {
  for (const pipeline of [productReview, featureDelivery]) {
    const step = consensusOf(pipeline);
    assert.equal(step.parallel, true, `${pipeline.id} must cross-check in parallel`);
    assert.equal(step.participants.length >= 2, true, `${pipeline.id} must have two participants`);
    assert.equal(step.consensusConfig.mode, "unanimous");
    assert.ok(Number.isInteger(step.consensusConfig.maxRounds) && step.consensusConfig.maxRounds > 0);
    assert.equal(step.consensusConfig.onMaxRounds, "humanGate", `${pipeline.id} must escalate to a human`);
    assert.equal(step.humanGate, "after", `${pipeline.id} must stop for the human after converging`);
    assert.notEqual(resolveCandidateShape(step.consensusConfig.candidateShape), undefined);
  }
});

test("a product review converges only when both participants accept the same recommendations", () => {
  const config = decisionConfig(productReview);
  const candidate = { recommendations: [recommendation("r1", "accepted")] };
  const agreed = buildDecisionArtifact({
    stepId: "recommendation-consensus",
    round: 1,
    policy: "unanimous",
    participants: [
      parseDecisionParticipant("codex", answer(candidate, true), config),
      parseDecisionParticipant("claude", answer(candidate, true), config),
    ],
  });
  assert.equal(agreed.status, "accepted");
  assert.notEqual(agreed.candidateHash, undefined);

  const differing = buildDecisionArtifact({
    stepId: "recommendation-consensus",
    round: 1,
    policy: "unanimous",
    participants: [
      parseDecisionParticipant("codex", answer(candidate, true), config),
      parseDecisionParticipant(
        "claude",
        answer({ recommendations: [recommendation("r1", "unresolved")] }, true),
        config,
      ),
    ],
  });
  assert.equal(differing.status, "pending", "two different candidates must not read as agreement");
  assert.equal(differing.candidateHash, undefined);
});

test("a feature delivery refuses a requirement with no disposition or acceptance criteria", () => {
  const config = decisionConfig(featureDelivery);
  const missingDisposition = { ...requirement("q1", "accepted") };
  delete missingDisposition.disposition;
  const invalid = parseDecisionParticipant(
    "codex",
    answer({ requirements: [missingDisposition] }, true),
    config,
  );
  assert.equal(invalid.valid, false);
  assert.equal(invalid.validationErrors.length > 0, true);

  const emptyCriteria = { ...requirement("q2", "accepted"), acceptanceCriteria: [] };
  const refused = parseDecisionParticipant(
    "codex",
    answer({ requirements: [emptyCriteria] }, true),
    config,
  );
  assert.equal(refused.valid, false);
});

test("a non-converging round escalates to the human rather than accepting a majority", () => {
  const config = decisionConfig(productReview);
  const artifact = buildDecisionArtifact({
    stepId: "recommendation-consensus",
    round: consensusOf(productReview).consensusConfig.maxRounds,
    policy: "unanimous",
    participants: [
      parseDecisionParticipant("codex", answer({ recommendations: [recommendation("r1", "accepted")] }, true), config),
      parseDecisionParticipant("claude", answer({ recommendations: [recommendation("r1", "accepted")] }, false), config),
    ],
  });
  assert.equal(artifact.status, "pending");
  assert.equal(consensusOf(productReview).consensusConfig.onMaxRounds, "humanGate");
});

test("the recorded product recommendations become a durable recommendation artifact", () => {
  const step = stepById(productReview, "recommendation-record");
  assert.equal(step.artifactPromotion.type, "recommendation");
  const value = {
    title: "Onboarding promises a workflow that does not ship",
    summary: "Two of the three offered workflows cannot run.",
    evidence: ["src/workflows/catalog.ts"],
    recommendations: [recommendation("r1", "accepted")],
  };
  assert.deepEqual(validateJsonOutput(value, resolveCandidateShape(step.output.shape), "$"), []);
  const sources = declaredArtifactSourcesFor({
    definition: productReview,
    outputs: [{
      outputRef: "O1",
      name: `${step.output.name}.codex`,
      value: {
        stepId: step.id,
        name: step.output.name,
        agentId: "codex",
        validationErrors: [],
        value,
      },
    }],
    outputRefs: new Set(["O1"]),
  });
  assert.equal(sources.length, 1);
  const produced = produceDeclaredArtifact({
    createId: () => "T1",
    initiativeId: "I1",
    cycleId: "C1",
    runRef: "R1",
    recordedAt: "2026-08-30T00:00:00.000Z",
    promotion: sources[0].promotion,
    output: sources[0].output,
    fallbackTitle: "Product review",
    participantIds: ["codex", "claude"],
    stepId: step.id,
  });
  assert.equal(produced.artifact.type, "recommendation");
  assert.equal(produced.artifact.title, value.title);
  assert.deepEqual(produced.artifact.evidence, value.evidence);
  assert.equal(produced.artifact.state, "proposed");
});

test("feature delivery records requirements and a design as separate durable artifacts", () => {
  const requirementStep = stepById(featureDelivery, "requirement-record");
  const designStep = stepById(featureDelivery, "design-record");
  assert.equal(requirementStep.artifactPromotion.type, "requirement");
  assert.equal(designStep.artifactPromotion.type, "design");
  const sources = declaredArtifactSourcesFor({
    definition: featureDelivery,
    outputs: [
      {
        outputRef: "O1",
        name: `${requirementStep.output.name}.codex`,
        value: {
          stepId: requirementStep.id,
          name: requirementStep.output.name,
          agentId: "codex",
          validationErrors: [],
          value: {
            title: "Replay must reuse recorded settings",
            evidence: ["src/export/runBundleImport.ts"],
            requirements: [requirement("q1", "accepted")],
          },
        },
      },
      {
        outputRef: "O2",
        name: `${designStep.output.name}.codex`,
        value: {
          stepId: designStep.id,
          name: designStep.output.name,
          agentId: "codex",
          validationErrors: [],
          value: {
            title: "Pin the snapshot at run start",
            summary: "Capture once, restore on resume.",
            evidence: ["src/runtime/settingsSnapshot.ts"],
            steps: [{ id: "s1", intent: "capture", files: ["src/runtime/createRuntime.ts"] }],
          },
        },
      },
    ],
    outputRefs: new Set(["O1", "O2"]),
  });
  assert.deepEqual(
    sources.map((source) => source.promotion.type).sort(),
    ["design", "requirement"],
  );
});

test("an output that failed its own schema never becomes a durable artifact", () => {
  const step = stepById(productReview, "recommendation-record");
  const sources = declaredArtifactSourcesFor({
    definition: productReview,
    outputs: [{
      outputRef: "O1",
      name: `${step.output.name}.codex`,
      value: {
        stepId: step.id,
        name: step.output.name,
        agentId: "codex",
        validationErrors: ["$.recommendations must be an array"],
        value: { recommendations: "not a list" },
      },
    }],
    outputRefs: new Set(["O1"]),
  });
  assert.deepEqual(sources, []);
});

test("both presets leave the human the next action when they surface a decision", () => {
  for (const pipeline of [productReview, featureDelivery]) {
    const step = pipeline.steps.find((candidate) => candidate.coreDecisionOutput !== undefined);
    assert.notEqual(step, undefined, `${pipeline.id} declares no core decision output`);
    assert.equal(step.output.shape, "longitudinalDecisionSet");
  }
  const view = directionView({
    initiative: {
      id: "I1",
      repositoryId: "repo",
      goal: "Ship the feature",
      desiredOutcome: "Requirements met",
      acceptanceCriteria: ["tests pass"],
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
    },
    decisions: [{
      id: "D1",
      initiativeId: "I1",
      subject: "Ship without the design step",
      question: "Do we ship without a recorded design?",
      affectedScope: ["src"],
      evidence: ["src/a.ts"],
      state: "proposed",
      revision: 1,
      recordedAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      runRefs: ["R1"],
    }],
    history: [],
    artifacts: [],
    saturation: { saturated: false, reasons: ["a fresh review has not been quiet twice"], quietFreshReviews: 0 },
  });
  assert.equal(view.nextAction.kind, "resolveDecisions");
  assert.match(view.nextAction.detail, /Ship without the design step/u);
});
