const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { validatePipelineDefinition } = require("../dist/pipeline/schema.js");
const {
  createPipelineExecutionSnapshot,
  createPipelineSnapshot,
  parsePipelineSnapshot,
  pipelineDefinitionHash,
  pipelineSnapshotRootsEqual,
  pipelineSnapshotsEqual,
} = require("../dist/pipeline/identity.js");
const { renderTemplate } = require("../dist/pipeline/template.js");

const presetPath = path.join(
  __dirname,
  "..",
  "presets",
  "cross-reference.pipeline.json",
);

const readPreset = () => JSON.parse(fs.readFileSync(presetPath, "utf8"));

const todoPresetPath = path.join(
  __dirname,
  "..",
  "presets",
  "todo-implementation.pipeline.json",
);

const readTodoPreset = () => JSON.parse(fs.readFileSync(todoPresetPath, "utf8"));

const browserPresetPath = path.join(
  __dirname,
  "..",
  "presets",
  "chatgpt-browser-spike.pipeline.json",
);


test("pipeline identity is canonical, tamper-evident, and scope-aware", () => {
  const definition = readPreset();
  const reordered = {
    steps: definition.steps,
    agents: definition.agents,
    description: definition.description,
    name: definition.name,
    id: definition.id,
    version: definition.version,
    ...(definition.roles ? { roles: definition.roles } : {}),
    ...(definition.longitudinalIntent
      ? { longitudinalIntent: definition.longitudinalIntent }
      : {}),
    ...(definition.resourceDependencies
      ? { resourceDependencies: definition.resourceDependencies }
      : {}),
  };
  assert.equal(pipelineDefinitionHash(reordered), pipelineDefinitionHash(definition));

  const workspaceSnapshot = createPipelineSnapshot(
    definition,
    "workspace:/one",
    "/one",
  );
  assert.deepEqual(parsePipelineSnapshot(workspaceSnapshot), workspaceSnapshot);
  assert.equal(
    parsePipelineSnapshot({
      ...workspaceSnapshot,
      definition: { ...workspaceSnapshot.definition, name: "Tampered" },
    }),
    undefined,
  );
  assert.equal(
    pipelineSnapshotsEqual(
      workspaceSnapshot,
      createPipelineSnapshot(definition, "workspace:/two", "/two"),
    ),
    false,
  );
});

test("pipeline execution snapshots freeze and authenticate task-pipeline dependencies", () => {
  const root = createPipelineSnapshot(readPreset(), "workspace:/root", "/root");
  const childDefinition = readTodoPreset();
  const child = createPipelineSnapshot(childDefinition, "builtin");
  const snapshot = createPipelineExecutionSnapshot(root, {
    [childDefinition.id]: child,
  });

  assert.deepEqual(parsePipelineSnapshot(snapshot), snapshot);
  assert.equal(pipelineSnapshotRootsEqual(root, snapshot), true);
  assert.equal(pipelineSnapshotsEqual(root, snapshot), false);

  const changedChild = createPipelineSnapshot(
    { ...childDefinition, name: "Changed task pipeline" },
    "builtin",
  );
  const changed = createPipelineExecutionSnapshot(root, {
    [childDefinition.id]: changedChild,
  });
  assert.equal(pipelineSnapshotsEqual(snapshot, changed), false);

  assert.equal(
    parsePipelineSnapshot({
      ...snapshot,
      dependencies: {
        ...snapshot.dependencies,
        [childDefinition.id]: {
          ...snapshot.dependencies[childDefinition.id],
          definition: {
            ...snapshot.dependencies[childDefinition.id].definition,
            name: "Tampered task pipeline",
          },
        },
      },
    }),
    undefined,
  );
});

test("browser transport spike preset validates", () => {
  const result = validatePipelineDefinition(
    JSON.parse(fs.readFileSync(browserPresetPath, "utf8")),
  );
  assert.equal(result.success, true, result.success ? undefined : result.errors.join("\n"));
});


test("every bundled pipeline preset validates", () => {
  const directory = path.join(__dirname, "..", "presets");
  for (const name of fs.readdirSync(directory).filter((value) => value.endsWith(".json"))) {
    const pipeline = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    const result = validatePipelineDefinition(pipeline);
    assert.equal(
      result.success,
      true,
      result.success ? undefined : `${name}: ${result.errors.join("\n")}`,
    );
  }
});

test("full cross-reference preset validates", () => {
  const result = validatePipelineDefinition(readPreset());
  assert.equal(result.success, true, result.success ? undefined : result.errors.join("\n"));
});

test("pipeline validation rejects unknown participants", () => {
  const pipeline = readPreset();
  pipeline.steps[0].participants.push("missing-agent");
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /unknown agent or role/);
});

test("pipeline validation rejects malformed consensus configuration", () => {
  const pipeline = readPreset();
  pipeline.steps.find((step) => step.id === "converge").consensusConfig.maxRounds = 0;
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /positive integer/);
});

test("pipeline validation rejects unknown properties", () => {
  const pipeline = readPreset();
  pipeline.steps[0].hiddenContext = true;
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /is not supported/);
});

test("template renderer performs exact explicit replacement", () => {
  assert.equal(
    renderTemplate("Before\n{{peerAnswer}}\nAfter", {
      peerAnswer: "RAW ANSWER",
    }),
    "Before\nRAW ANSWER\nAfter",
  );
});

test("template renderer supports escaped literal double braces", () => {
  assert.equal(
    renderTemplate("Example: {{{{value}}}} and {{actual}}", { actual: "resolved" }),
    "Example: {{value}} and resolved",
  );
});

test("template renderer preserves brace sequences supplied by values", () => {
  assert.equal(
    renderTemplate("{{actual}}", { actual: "{{literal}}" }),
    "{{literal}}",
  );
});

test("template renderer rejects missing values", () => {
  assert.throws(
    () => renderTemplate("{{missing}}", {}),
    /Missing template value: missing/,
  );
});


test("template renderer does not invent a userMessage value", () => {
  assert.throws(
    () => renderTemplate("{{userMessage}}", { userPrompt: "TASK" }),
    /Missing template value: userMessage/,
  );
});

test("pipeline validation allows roles to be reassigned without collapsing participants", () => {
  const pipeline = readTodoPreset();
  const reassignmentIndex = pipeline.steps.findIndex(
    (step) => step.id === "worker-implementation",
  );
  pipeline.steps.splice(reassignmentIndex, 0, {
    id: "reassign-roles",
    type: "assignRoles",
    name: "Reassign roles",
    enabled: true,
    humanGate: "none",
    roleAssignments: [
      { agentId: "claude", role: "lead" },
      { agentId: "codex", role: "worker" },
    ],
  });

  const result = validatePipelineDefinition(pipeline);
  assert.equal(
    result.success,
    true,
    result.success ? undefined : result.errors.join("\n"),
  );
});

test("pipeline validation rejects role reassignment that collapses participants", () => {
  const pipeline = readTodoPreset();
  const reassignmentIndex = pipeline.steps.findIndex(
    (step) => step.id === "worker-implementation",
  );
  pipeline.steps.splice(reassignmentIndex, 0, {
    id: "reassign-lead",
    type: "assignRoles",
    name: "Reassign lead",
    enabled: true,
    humanGate: "none",
    roleAssignments: [{ agentId: "claude", role: "lead" }],
  });
  pipeline.steps[reassignmentIndex + 1].participants = ["lead", "worker"];

  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /resolve more than once to the same agent/);
});

test("pipeline validation rejects an enabled step that depends on a disabled role assignment", () => {
  const pipeline = readTodoPreset();
  const assignment = pipeline.steps.find((step) => step.id === "assign-roles");
  assignment.enabled = false;

  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /unknown agent or role: worker/);
});


test("pipeline validation accepts two independent browser agents and arbitrary custom roles", () => {
  const pipeline = {
    version: 1,
    id: "custom-browser-team",
    name: "Custom browser team",
    agents: [
      { id: "gpt-qa", name: "GPT QA", adapter: "chatgpt-browser" },
      { id: "gpt-ux", name: "GPT UX", adapter: "chatgpt-browser" },
    ],
    roles: [
      {
        id: "qa",
        name: "Quality assurance",
        instructions: "Reproduce defects and report exact evidence.",
        requiredCapabilities: ["browserSessionSelection"],
      },
      {
        id: "ux",
        name: "User experience",
        instructions: "Review interaction clarity and accessibility.",
        preferredAdapters: ["chatgpt-browser", "claude-browser"],
      },
    ],
    steps: [
      {
        id: "assign-specialists",
        type: "assignRoles",
        name: "Assign specialists",
        enabled: true,
        humanGate: "none",
        roleAssignments: [
          { agentId: "gpt-qa", role: "qa" },
          { agentId: "gpt-ux", role: "ux" },
        ],
      },
      {
        id: "review",
        type: "agent",
        name: "Review",
        enabled: true,
        humanGate: "none",
        participants: ["qa", "ux"],
        promptTemplate: "{{userPrompt}}",
        parallel: true,
        consensus: false,
        attachments: "none",
      },
    ],
  };

  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, true, result.success ? undefined : result.errors.join("\n"));
});

test("pipeline runner applies first-class role instructions exactly once", async () => {
  const { executePipeline } = require("../dist/pipeline/runner.js");
  const prompts = [];
  const pipeline = {
    version: 1,
    id: "role-prompt",
    name: "Role prompt",
    agents: [{ id: "gpt", name: "GPT", adapter: "chatgpt-browser" }],
    roles: [
      {
        id: "qa",
        name: "Quality assurance",
        instructions: "Inspect edge cases and reproduce defects.",
      },
    ],
    steps: [
      {
        id: "assign",
        type: "assignRoles",
        name: "Assign",
        enabled: true,
        humanGate: "none",
        roleAssignments: [{ agentId: "gpt", role: "qa" }],
      },
      {
        id: "review",
        type: "agent",
        name: "Review",
        enabled: true,
        humanGate: "none",
        participants: ["qa"],
        promptTemplate: "{{roleInstructions}}\n{{roleName}}|{{roleId}}|{{currentParticipant}}|{{userPrompt}}",
        parallel: false,
        consensus: false,
        attachments: "none",
      },
    ],
  };

  const result = await executePipeline(
    pipeline,
    "Review the implementation.",
    [],
    async (_agentId, prompt) => {
      prompts.push(prompt);
      return { status: "completed", answer: "reviewed" };
    },
    {
      onStep: () => undefined,
      onRoles: () => undefined,
      waitForHumanGate: async () => ({ action: "continue" }),
    },
  );

  assert.equal(result.status, "completed");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /^Role: Quality assurance \(qa\)/);
  assert.match(prompts[0], /Quality assurance\|qa\|qa\|Review the implementation\./);
  assert.equal(
    prompts[0].split("Inspect edge cases and reproduce defects.").length - 1,
    1,
  );
});

test("role capability requirements apply to the currently assigned agent", () => {
  const { validatePipelineCapabilities } = require("../dist/pipeline/runner.js");
  const pipeline = {
    version: 1,
    id: "role-capabilities",
    name: "Role capabilities",
    agents: [{ id: "agent", name: "Agent", adapter: "mock" }],
    roles: [
      {
        id: "qa",
        name: "Quality assurance",
        instructions: "Inspect browser behavior.",
        requiredCapabilities: ["browserSessionSelection"],
      },
    ],
    steps: [
      {
        id: "assign",
        type: "assignRoles",
        name: "Assign",
        enabled: true,
        humanGate: "none",
        roleAssignments: [{ agentId: "agent", role: "qa" }],
      },
      {
        id: "review",
        type: "agent",
        name: "Review",
        enabled: true,
        humanGate: "none",
        participants: ["qa"],
        promptTemplate: "review",
        parallel: false,
        consensus: false,
      },
    ],
  };
  const capabilities = {
    streaming: true,
    resume: true,
    interrupt: true,
    attachments: false,
    repositoryTools: true,
    browserSessionSelection: false,
    passiveActionLoop: true,
  };

  assert.deepEqual(validatePipelineCapabilities(pipeline, { agent: capabilities }, false), [
    'Step "Review" needs a selected browser conversation from Agent (mock), which this provider does not offer here. Select a provider that supports it or remove the requirement from the step.',
  ]);
  assert.deepEqual(
    validatePipelineCapabilities(
      pipeline,
      { agent: { ...capabilities, browserSessionSelection: true } },
      false,
    ),
    [],
  );
});

test("pipeline validation rejects Codex never approval policy", () => {
  const pipeline = readPreset();
  pipeline.agents[0].approvalPolicy = "never";
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /onRequest or unlessTrusted/);
});

test("checklist execution must be the final enabled pipeline step", () => {
  const pipeline = readPreset();
  pipeline.steps.push(
    {
      id: "execute-checklist",
      name: "Execute selected issues",
      enabled: true,
      humanGate: "none",
      type: "executeChecklist",
      inputName: "executionChecklist",
      pipelineId: "todo-implementation",
      checks: [],
      retries: 1,
      maxConcurrency: 1,
      allowedPaths: ["."],
      allowNoChecks: true,
    },
    {
      id: "after-execution",
      type: "agent",
      name: "After execution",
      enabled: true,
      humanGate: "none",
      participants: [pipeline.agents[0].id],
      promptTemplate: "This must not run after checklist execution.",
      parallel: false,
      consensus: false,
    },
  );
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /must be the final enabled pipeline step/);
});

test("default review pipeline converges once and prepares work without modifying the repository", () => {
  const pipeline = readPreset();
  assert.deepEqual(
    pipeline.steps.map((step) => [step.id, step.type]),
    [
      ["review", "agent"],
      ["converge", "agent"],
      ["execution-checklist", "checklist"],
    ],
  );
  assert.equal(pipeline.steps.some((step) => step.type === "executeChecklist"), false);
  assert.match(pipeline.description, /without modifying the repository/u);
});

test("role assignment steps reject agent-turn fields instead of discarding prompts", () => {
  const pipeline = readTodoPreset();
  const roleStep = pipeline.steps.find((step) => step.id === "assign-roles");
  roleStep.promptTemplate = "THIS MUST NOT BE IGNORED";
  roleStep.participants = ["codex"];
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /promptTemplate is not supported/);
  assert.match(result.errors.join("\n"), /participants is not supported/);
});

test("capability validation rejects incompatible assigned adapters before execution", () => {
  const { validatePipelineCapabilities } = require("../dist/pipeline/runner.js");
  const errors = validatePipelineCapabilities(
    {
      version: 1,
      id: "capabilities",
      name: "Capabilities",
      agents: [{ id: "a", name: "A", adapter: "mock" }],
      steps: [
        {
          type: "agent",
          id: "browser",
          name: "Browser",
          enabled: true,
          participants: ["a"],
          promptTemplate: "prompt",
          parallel: false,
          consensus: false,
          humanGate: "none",
          requiredCapabilities: ["browserSessionSelection"],
        },
      ],
    },
    {
      a: {
        streaming: true,
        resume: true,
        interrupt: true,
        attachments: false,
        repositoryTools: true,
        browserSessionSelection: false,
        passiveActionLoop: false,
      },
    },
    false,
  );
  assert.deepEqual(errors, [
    'Step "Browser" needs a selected browser conversation from A (mock), which this provider does not offer here. Select a provider that supports it or remove the requirement from the step.',
  ]);
});

test("pipeline validation rejects unknown template values before execution", () => {
  const pipeline = readPreset();
  pipeline.steps[0].promptTemplate = "{{answes.codex}}";
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /unknown template value: answes\.codex/);
});

test("pipeline validation accepts explicit tagged and intervention values", () => {
  const pipeline = readPreset();
  pipeline.steps[0].promptTemplate = [
    "{{peerAnswersTagged}}",
    "{{peerAnswersJson}}",
    "{{previousStepAnswer}}",
    "{{previousStepAnswers}}",
    "{{latestAgentAnswer}}",
    "{{interventionAnswer}}",
    "{{interventionAnswers}}",
    "{{interventionAnswersTagged}}",
    "{{answers.codex}}",
    "{{interventions.claude}}",
  ].join("\n");
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, true, result.success ? undefined : result.errors.join("\n"));
});

test("adapter registry rejects provider-specific options before execution", () => {
  const { createAdapterRegistry } = require("../dist/adapters/registry.js");
  const registry = createAdapterRegistry();
  const pipeline = {
    version: 1,
    id: "bad-adapter-options",
    name: "Bad adapter options",
    agents: [
      {
        id: "browser",
        name: "Browser",
        adapter: "chatgpt-browser",
        permissionMode: "workspaceWrite",
      },
    ],
    steps: [
      {
        type: "agent",
        id: "turn",
        name: "Turn",
        enabled: true,
        participants: ["browser"],
        promptTemplate: "prompt",
        parallel: false,
        consensus: false,
        humanGate: "none",
      },
    ],
  };
  assert.deepEqual(registry.validatePipeline(pipeline), [
    "Agent browser adapter chatgpt-browser does not support permissionMode",
    "Step turn, browser: ChatGPT Browser does not support permission modes",
  ]);
});


test("pipeline validation rejects identifiers that can corrupt dictionary state", () => {
  for (const identifier of ["__proto__", "constructor", "step.with.dot", "agent:request"]) {
    const pipeline = readPreset();
    pipeline.steps[0].id = identifier;
    const result = validatePipelineDefinition(pipeline);
    assert.equal(result.success, false, identifier);
    assert.match(result.errors.join("\n"), /contain only letters, numbers, underscores, or hyphens/);
  }
});

test("pipeline validation rejects malformed placeholders", () => {
  const pipeline = readPreset();
  pipeline.steps[0].promptTemplate = "Review {{userPrompt";
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /malformed placeholder/);
  assert.throws(
    () => renderTemplate("Review {{userPrompt", { userPrompt: "TASK" }),
    /malformed placeholder/,
  );
});


test("template renderer rejects inherited object properties", () => {
  assert.throws(
    () => renderTemplate("{{toString}}", {}),
    /Missing template value: toString/,
  );
});

test("pipeline validation accepts one-participant checklist steps", () => {
  const result = validatePipelineDefinition({
    version: 1,
    id: "checklist-pipeline",
    name: "Checklist pipeline",
    agents: [{ id: "lead", name: "Lead", adapter: "mock" }],
    steps: [
      {
        id: "prepare-execution",
        type: "checklist",
        name: "Prepare execution checklist",
        enabled: true,
        participants: ["lead"],
        promptTemplate: "Use {{userPrompt}}",
        outputName: "execution",
        timeoutMs: 120000,
        humanGate: "none",
      },
    ],
  });
  assert.equal(result.success, true, result.success ? undefined : result.errors.join("\n"));
});

test("pipeline validation rejects ambiguous checklist summarizers", () => {
  const result = validatePipelineDefinition({
    version: 1,
    id: "bad-checklist-pipeline",
    name: "Bad checklist pipeline",
    agents: [
      { id: "a", name: "A", adapter: "mock" },
      { id: "b", name: "B", adapter: "mock" },
    ],
    steps: [
      {
        id: "prepare-execution",
        type: "checklist",
        name: "Prepare execution checklist",
        enabled: true,
        participants: ["a", "b"],
        promptTemplate: "Prepare",
        outputName: "execution",
        humanGate: "none",
      },
    ],
  });
  assert.equal(result.success, false);
  assert.match(result.errors.join("\n"), /exactly one summarizer/);
});

test("managed verification accepts only controller-owned commands", () => {
  const pipeline = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "presets", "gpt-pair.pipeline.json"), "utf8"));
  pipeline.managedPolicy.verificationChecks[0].command = "bachata:project-checks";
  const configured = validatePipelineDefinition(pipeline);
  assert.equal(configured.success, true, configured.success ? undefined : configured.errors.join("\n"));

  pipeline.managedPolicy.verificationChecks[0].command = "npm test";
  const repositoryCommand = validatePipelineDefinition(pipeline);
  assert.equal(repositoryCommand.success, false);
  assert.match(repositoryCommand.errors.join("\n"), /bachata:workspace-integrity, bachata:project-checks, or bachata:verifier:<id>/u);

  pipeline.managedPolicy.verificationChecks[0].command = "bachata:unregistered-check";
  const reserved = validatePipelineDefinition(pipeline);
  assert.equal(reserved.success, false);
  assert.match(reserved.errors.join("\n"), /bachata:workspace-integrity, bachata:project-checks, or bachata:verifier:<id>/u);

  pipeline.managedPolicy.verificationChecks[0].command = "bachata:verifier:unit-tests";
  const declared = validatePipelineDefinition(pipeline);
  assert.equal(declared.success, true, declared.success ? undefined : declared.errors.join("\n"));

  pipeline.managedPolicy.verificationChecks[0].command = "bachata:verifier:Not An Id";
  const malformed = validatePipelineDefinition(pipeline);
  assert.equal(malformed.success, false);
});

test("managed read scope is independent from writable scope", () => {
  const pipeline = readTodoPreset();
  pipeline.managedPolicy = {
    ...(pipeline.managedPolicy ?? {}),
    readPaths: ["talents-backend/src"],
    allowedPaths: ["talents-backend/src/routes"],
  };
  const result = validatePipelineDefinition(pipeline);
  assert.equal(result.success, true, result.success ? undefined : result.errors.join("\n"));

  pipeline.managedPolicy.readPaths = ["talents-backend/src", "talents-backend/src"];
  const duplicate = validatePipelineDefinition(pipeline);
  assert.equal(duplicate.success, false);
  assert.match(duplicate.errors.join("\n"), /managedPolicy\.readPaths must not contain duplicates/u);
});

test("capability errors name the provider, the step, and the missing ability", () => {
  const { validatePipelineCapabilities } = require("../dist/pipeline/runner.js");
  const pipeline = {
    version: 1,
    id: "compatibility",
    name: "Compatibility",
    agents: [
      { id: "worker", name: "Worker", adapter: "generic-browser" },
      { id: "lead", name: "Lead", adapter: "codex-app-server" },
    ],
    steps: [
      {
        type: "agent",
        id: "implement",
        name: "Implement",
        enabled: true,
        participants: ["worker"],
        promptTemplate: "prompt",
        parallel: false,
        consensus: false,
        humanGate: "none",
        requiredCapabilities: ["passiveActionLoop", "attachments"],
      },
      {
        type: "agent",
        id: "review",
        name: "Review",
        enabled: true,
        participants: ["lead"],
        promptTemplate: "prompt",
        parallel: false,
        consensus: false,
        humanGate: "none",
      },
    ],
  };

  const errors = validatePipelineCapabilities(
    pipeline,
    {
      worker: {
        streaming: true,
        resume: false,
        interrupt: false,
        attachments: false,
        repositoryTools: false,
        browserSessionSelection: true,
        passiveActionLoop: false,
      },
    },
    false,
  );

  assert.equal(errors.length, 3);
  assert.match(errors[0], /Step "Implement" needs the autonomous action loop from Worker \(generic-browser\)/u);
  assert.match(errors[1], /Step "Implement" needs image attachments from Worker \(generic-browser\)/u);
  assert.match(errors[2], /Step "Review" cannot run: Lead \(codex-app-server\) reported no capabilities/u);
  assert.match(errors[2], /Bachata: Doctor/u);
});

test("a declared artifact promotion validates and an undeclared one is refused", () => {
  const withPromotion = readPreset();
  withPromotion.steps[0].artifactPromotion = {
    type: "requirement",
    titleField: "title",
    bodyField: "body",
    evidenceField: "evidence",
    producedBy: withPromotion.steps[0].participants[0],
  };
  const accepted = validatePipelineDefinition(withPromotion);
  assert.equal(accepted.success, true, accepted.success ? undefined : accepted.errors.join("\n"));

  const unknownType = readPreset();
  unknownType.steps[0].artifactPromotion = {
    type: "model", producedBy: unknownType.steps[0].participants[0],
  };
  const rejectedType = validatePipelineDefinition(unknownType);
  assert.equal(rejectedType.success, false, "an artifact type the union does not declare was accepted");
  assert.match(rejectedType.errors.join("\n"), /artifactPromotion\.type must be one of/u);

  const namelessCustom = readPreset();
  namelessCustom.steps[0].artifactPromotion = {
    type: "custom", producedBy: namelessCustom.steps[0].participants[0],
  };
  const rejectedCustom = validatePipelineDefinition(namelessCustom);
  assert.equal(rejectedCustom.success, false, "a custom artifact with no name was accepted");
  assert.match(rejectedCustom.errors.join("\n"), /customType is required/u);

  const strayCustomType = readPreset();
  strayCustomType.steps[0].artifactPromotion = {
    type: "plan", customType: "whatever", producedBy: strayCustomType.steps[0].participants[0],
  };
  assert.equal(validatePipelineDefinition(strayCustomType).success, false);

  const unknownKey = readPreset();
  unknownKey.steps[0].artifactPromotion = {
    type: "plan", bodyfield: "body", producedBy: unknownKey.steps[0].participants[0],
  };
  const rejectedKey = validatePipelineDefinition(unknownKey);
  assert.equal(rejectedKey.success, false, "an unknown promotion key was accepted");
  assert.match(rejectedKey.errors.join("\n"), /is not a known key/u);
});

test("a pipeline that declares no artifact promotion stays valid and run-local", () => {
  const pipeline = readPreset();
  assert.equal(pipeline.steps.every((step) => step.artifactPromotion === undefined), true);
  assert.equal(validatePipelineDefinition(pipeline).success, true);
});

test("declared resource dependencies validate, and a malformed one is refused", () => {
  const declared = readPreset();
  declared.resourceDependencies = [{
    id: "docs",
    kind: "mcpServer",
    name: "docs-server",
    version: "2.0.0",
    configurationDigest: "abc123",
    required: true,
    allowedRoles: [declared.agents[0].id],
  }];
  const accepted = validatePipelineDefinition(declared);
  assert.equal(accepted.success, true, accepted.success ? undefined : accepted.errors.join("\n"));

  const badKind = readPreset();
  badKind.resourceDependencies = [{ id: "docs", kind: "database", name: "x", required: true }];
  assert.match(
    validatePipelineDefinition(badKind).errors.join("\n"),
    /kind must be one of/u,
  );

  const unknownRole = readPreset();
  unknownRole.resourceDependencies = [{
    id: "docs", kind: "skill", name: "x", required: true, allowedRoles: ["nobody"],
  }];
  assert.match(
    validatePipelineDefinition(unknownRole).errors.join("\n"),
    /is not an agent or role in this pipeline/u,
  );

  const duplicate = readPreset();
  duplicate.resourceDependencies = [
    { id: "docs", kind: "tool", name: "a", required: true },
    { id: "docs", kind: "tool", name: "b", required: false },
  ];
  assert.match(validatePipelineDefinition(duplicate).errors.join("\n"), /duplicates dependency/u);

  const missingRequired = readPreset();
  missingRequired.resourceDependencies = [{ id: "docs", kind: "tool", name: "a" }];
  assert.match(
    validatePipelineDefinition(missingRequired).errors.join("\n"),
    /required must be a boolean/u,
  );

  const strayKey = readPreset();
  strayKey.resourceDependencies = [{
    id: "docs", kind: "tool", name: "a", required: true, secret: "value",
  }];
  const rejectedKey = validatePipelineDefinition(strayKey);
  assert.equal(rejectedKey.success, false, "an undeclared key was accepted onto a dependency");
  assert.match(rejectedKey.errors.join("\n"), /is not a known key/u);
});

test("a legacy pipeline that declares no dependencies still validates", () => {
  const pipeline = readPreset();
  assert.equal(pipeline.resourceDependencies, undefined);
  assert.equal(validatePipelineDefinition(pipeline).success, true);
});

test("a role may name its own model, and the pipeline still validates without one", () => {
  const withModel = readPreset();
  withModel.roles = [{
    id: "lead",
    name: "Lead",
    instructions: "Review the worker's result.",
    model: "a-stronger-model",
  }];
  const accepted = validatePipelineDefinition(withModel);
  assert.equal(accepted.success, true, accepted.success ? undefined : accepted.errors.join("\n"));

  const emptyModel = readPreset();
  emptyModel.roles = [{ id: "lead", name: "Lead", instructions: "Review.", model: "" }];
  assert.equal(
    validatePipelineDefinition(emptyModel).success,
    false,
    "an empty role model was accepted instead of being left unset",
  );

  const noModel = readPreset();
  noModel.roles = [{ id: "lead", name: "Lead", instructions: "Review." }];
  assert.equal(validatePipelineDefinition(noModel).success, true);
});

test("a promotion on a paired step must name which participant produces the artifact", () => {
  const paired = readPreset();
  const step = paired.steps.find((item) => (item.participants ?? []).length > 1);
  assert.ok(step, "this preset has no paired step to exercise");

  step.artifactPromotion = { type: "requirement", bodyField: "body" };
  const ambiguous = validatePipelineDefinition(paired);
  assert.equal(ambiguous.success, false, "an ambiguous paired promotion was accepted");
  assert.match(ambiguous.errors.join("\n"), /producedBy is required because this step has/u);

  step.artifactPromotion = { type: "requirement", bodyField: "body", producedBy: "nobody" };
  assert.match(
    validatePipelineDefinition(paired).errors.join("\n"),
    /producedBy must name one of this step's participants/u,
  );

  step.artifactPromotion = {
    type: "requirement", bodyField: "body", producedBy: step.participants[1],
  };
  const named = validatePipelineDefinition(paired);
  assert.equal(named.success, true, named.success ? undefined : named.errors.join("\n"));
});

test("longitudinal intent is declared, and durable promotion cannot claim run-local", () => {
  const runLocal = readPreset();
  runLocal.longitudinalIntent = "runLocal";
  delete runLocal.steps[0].artifactPromotion;
  assert.equal(validatePipelineDefinition(runLocal).success, true);

  const contradiction = readPreset();
  contradiction.longitudinalIntent = "runLocal";
  contradiction.steps[0].artifactPromotion = {
    type: "requirement",
    bodyField: "body",
    producedBy: contradiction.steps[0].participants[0],
  };
  const refused = validatePipelineDefinition(contradiction);
  assert.equal(refused.success, false, "a run-local pipeline was allowed to write durable state");
  assert.match(refused.errors.join("\n"), /longitudinalIntent is runLocal, but a step declares artifactPromotion/u);

  const undeclared = readPreset();
  delete undeclared.longitudinalIntent;
  undeclared.steps[0].artifactPromotion = {
    type: "requirement",
    bodyField: "body",
    producedBy: undeclared.steps[0].participants[0],
  };
  assert.match(
    validatePipelineDefinition(undeclared).errors.join("\n"),
    /longitudinalIntent must be initiativeRequired/u,
  );

  const badValue = readPreset();
  badValue.longitudinalIntent = "sometimes";
  assert.match(
    validatePipelineDefinition(badValue).errors.join("\n"),
    /longitudinalIntent must be/u,
  );

  // A legacy pipeline that declares nothing and writes nothing keeps working.
  const legacy = readPreset();
  delete legacy.longitudinalIntent;
  delete legacy.steps[0].artifactPromotion;
  assert.equal(legacy.longitudinalIntent, undefined);
  assert.equal(
    validatePipelineDefinition(legacy).success,
    true,
    "a legacy pipeline with no durable output stopped validating",
  );
});

test("every shipped preset declares its longitudinal intent", () => {
  const directory = path.join(__dirname, "..", "presets");
  const journeyWorkflows = new Set([
    "review-only", "codex-review", "claude-review", "plan", "codex-plan", "claude-plan",
    "debug", "managed-fix", "paired-managed-fix", "codex-fix", "claude-fix",
    "core-decisions", "cross-reference-development", "specialist-browser-review",
  ]);
  for (const name of fs.readdirSync(directory).filter((value) => value.endsWith(".json"))) {
    const pipeline = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    assert.ok(
      pipeline.longitudinalIntent === "initiativeRequired" ||
        pipeline.longitudinalIntent === "runLocal",
      `${name} declares no longitudinal intent`,
    );
    if (journeyWorkflows.has(pipeline.id)) {
      assert.equal(
        pipeline.longitudinalIntent,
        "initiativeRequired",
        `${name} is a user-facing journey workflow but records nothing`,
      );
    }
  }
});

test("a core decision has one durable representation, not two", () => {
  const duplicate = readPreset();
  duplicate.steps[0].artifactPromotion = {
    type: "decision",
    bodyField: "body",
    producedBy: duplicate.steps[0].participants[0],
  };
  const refused = validatePipelineDefinition(duplicate);
  assert.equal(refused.success, false, "a decision was promotable as a generic artifact");
  assert.match(refused.errors.join("\n"), /cannot be decision/u);
  assert.match(refused.errors.join("\n"), /recorded as a DecisionRecord/u);
});
