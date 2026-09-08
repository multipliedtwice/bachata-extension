const assert = require("node:assert/strict");
const test = require("node:test");

const { declaredArtifactSourcesFor } = require("../dist/longitudinal/declaredArtifactSources.js");
const { produceDeclaredArtifact } = require("../dist/longitudinal/artifacts.js");

// The exact shape savePipelineOutput writes: name is "<name>.<agentId>" and value wraps the
// StepOutputArtifact whose own `value` is the structured payload.
const storedOutput = (overrides = {}) => ({
  outputRef: "O1",
  name: "requirements.codex",
  value: {
    stepId: "converge",
    agentId: "codex",
    name: "requirements",
    hash: "h1",
    validationErrors: [],
    value: { title: "Bounded retry", body: "Every retry is bounded", evidence: ["src/retry.ts:23"] },
    ...(overrides.value ?? {}),
  },
  ...(overrides.outer ?? {}),
});

const definition = (promotion, participants = ["codex"]) => ({
  id: "p",
  steps: [{
    type: "agent",
    id: "converge",
    name: "Converge",
    participants,
    output: { name: "requirements" },
    ...(promotion === undefined ? {} : { artifactPromotion: promotion }),
  }],
});

test("a stored step output reaches promotion through the name the manager actually writes", () => {
  const sources = declaredArtifactSourcesFor({
    definition: definition({
      type: "requirement",
      titleField: "title",
      bodyField: "body",
      evidenceField: "evidence",
    }),
    outputs: [storedOutput()],
    outputRefs: new Set(["O1"]),
  });
  assert.equal(sources.length, 1, "the stored output was not matched to its declared promotion");
  assert.deepEqual(
    sources[0].output,
    { title: "Bounded retry", body: "Every retry is bounded", evidence: ["src/retry.ts:23"] },
    "the wrapper was promoted instead of its structured value",
  );
  assert.equal(sources[0].stepId, "converge");
  assert.deepEqual(sources[0].participantIds, ["codex"]);

  // End to end: that source produces the artifact the workflow declared.
  const production = produceDeclaredArtifact({
    createId: () => "A1",
    initiativeId: "I1",
    cycleId: "Y1",
    runRef: "R1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    ...sources[0],
  });
  assert.equal(production.artifact.type, "requirement");
  assert.equal(production.artifact.title, "Bounded retry");
  assert.deepEqual(production.artifact.evidence, ["src/retry.ts:23"]);
});

test("a step that declared no promotion contributes nothing", () => {
  assert.deepEqual(
    declaredArtifactSourcesFor({
      definition: definition(undefined),
      outputs: [storedOutput()],
      outputRefs: new Set(["O1"]),
    }),
    [],
  );
});

test("an output from another step or another run is never promoted", () => {
  const otherStep = declaredArtifactSourcesFor({
    definition: definition({ type: "plan", bodyField: "body" }),
    outputs: [storedOutput({ value: { stepId: "somewhere-else" } })],
    outputRefs: new Set(["O1"]),
  });
  assert.deepEqual(otherStep, [], "an output from a different step was promoted");

  const otherRound = declaredArtifactSourcesFor({
    definition: definition({ type: "plan", bodyField: "body" }),
    outputs: [storedOutput()],
    outputRefs: new Set(),
  });
  assert.deepEqual(otherRound, [], "an output from an earlier round was promoted");
});

test("an output that failed its own schema never becomes durable state", () => {
  assert.deepEqual(
    declaredArtifactSourcesFor({
      definition: definition({ type: "plan", bodyField: "body" }),
      outputs: [storedOutput({ value: { validationErrors: ["missing body"] } })],
      outputRefs: new Set(["O1"]),
    }),
    [],
  );
});

test("a paired step promotes only the named producer's answer", () => {
  const outputs = [
    storedOutput({
      outer: { outputRef: "O1", name: "requirements.codex" },
      value: { agentId: "codex", value: { body: "codex answer" } },
    }),
    storedOutput({
      outer: { outputRef: "O2", name: "requirements.claude" },
      value: { agentId: "claude", value: { body: "claude answer" } },
    }),
  ];
  const sources = declaredArtifactSourcesFor({
    definition: definition(
      { type: "requirement", bodyField: "body", producedBy: "claude" },
      ["codex", "claude"],
    ),
    outputs,
    outputRefs: new Set(["O1", "O2"]),
  });
  assert.equal(sources.length, 1);
  assert.deepEqual(
    sources[0].output,
    { body: "claude answer" },
    "the named producer's answer was not the one promoted",
  );
  assert.deepEqual(sources[0].participantIds, ["claude"]);
});

test("two answers with no named producer promote nothing rather than the last one stored", () => {
  const outputs = [
    storedOutput({
      outer: { outputRef: "O1", name: "requirements.codex" },
      value: { agentId: "codex", value: { body: "codex answer" } },
    }),
    storedOutput({
      outer: { outputRef: "O2", name: "requirements.claude" },
      value: { agentId: "claude", value: { body: "claude answer" } },
    }),
  ];
  assert.deepEqual(
    declaredArtifactSourcesFor({
      definition: definition({ type: "requirement", bodyField: "body" }, ["codex", "claude"]),
      outputs,
      outputRefs: new Set(["O1", "O2"]),
    }),
    [],
    "an ambiguous paired promotion silently chose one answer",
  );
});

test("a named producer that answered nothing promotes nothing", () => {
  assert.deepEqual(
    declaredArtifactSourcesFor({
      definition: definition(
        { type: "requirement", bodyField: "body", producedBy: "claude" },
        ["codex", "claude"],
      ),
      outputs: [storedOutput({ value: { agentId: "codex" } })],
      outputRefs: new Set(["O1"]),
    }),
    [],
  );
});

test("the fixture matches how the manager actually stores a step output", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "conversations", "createConversationManager.ts"),
    "utf8",
  );
  // If the encoder changes, this fixture stops describing reality and the promotion tests
  // above would keep passing against a shape nothing writes.
  assert.match(
    source,
    /name: `\$\{artifact\.name\}\.\$\{artifact\.agentId\}`/u,
    "the stored output name no longer matches the fixture these tests decode",
  );
  assert.match(
    source,
    /saveStructuredOutput\(\{[\s\S]*?value: artifact,/u,
    "the stored output value is no longer the StepOutputArtifact wrapper these tests decode",
  );
  const wrapperFields = ["stepId", "agentId", "name", "value", "hash", "validationErrors"];
  const artifactType = fs.readFileSync(
    path.join(__dirname, "..", "src", "pipeline", "types.ts"),
    "utf8",
  );
  const declared = /export type StepOutputArtifact = \{([\s\S]*?)\};/u.exec(artifactType);
  assert.ok(declared, "StepOutputArtifact is no longer a type this guard can read");
  wrapperFields.forEach((field) => {
    assert.match(
      declared[1],
      new RegExp(`\\b${field}\\b`, "u"),
      `StepOutputArtifact no longer carries ${field}, which promotion decodes`,
    );
  });
});

test("a promotion naming a role matches the agent that role resolved to", () => {
  const outputs = [
    storedOutput({
      outer: { outputRef: "O1", name: "requirements.codex" },
      value: { agentId: "codex", participant: "worker", value: { body: "worker answer" } },
    }),
    storedOutput({
      outer: { outputRef: "O2", name: "requirements.claude" },
      value: { agentId: "claude", participant: "lead", value: { body: "lead answer" } },
    }),
  ];
  const sources = declaredArtifactSourcesFor({
    definition: definition(
      { type: "requirement", bodyField: "body", producedBy: "lead" },
      ["worker", "lead"],
    ),
    outputs,
    outputRefs: new Set(["O1", "O2"]),
  });
  assert.equal(sources.length, 1, "a role-named promotion produced nothing");
  assert.deepEqual(sources[0].output, { body: "lead answer" });
  assert.deepEqual(
    sources[0].participantIds,
    ["claude"],
    "provenance lost the agent that actually answered",
  );
});

test("the runner records the declared participant beside the agent that answered", () => {
  const { parseStepOutput } = require("../dist/pipeline/output.js");
  const artifact = parseStepOutput(
    "converge",
    "claude",
    "requirements",
    JSON.stringify({ body: "x" }),
    { type: "object", properties: { body: { type: "string" } }, required: ["body"] },
    "lead",
  );
  assert.equal(artifact.agentId, "claude");
  assert.equal(artifact.participant, "lead", "the declared participant was not preserved");
  assert.deepEqual(artifact.validationErrors, []);
});
