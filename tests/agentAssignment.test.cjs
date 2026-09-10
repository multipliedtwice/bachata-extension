const assert = require("node:assert/strict");
const test = require("node:test");

const {
  adapterTypeForBrowserProvider,
  assignedAgentDefinition,
  assignedPipelineDefinition,
  assignmentLockReason,
  assignmentRefusals,
  assignmentSlots,
  parseScopedAgentAssignments,
  roleBindingsByStep,
  translatedPermissionMode,
  usableAssignments,
} = require("../dist/pipeline/agentAssignment.js");

const step = (overrides) => ({
  enabled: true,
  humanGate: "none",
  type: "agent",
  parallel: false,
  consensus: false,
  promptTemplate: "{{userPrompt}}",
  ...overrides,
});

test("a browser session's provider decides its adapter, and an unknown provider is generic", () => {
  assert.equal(adapterTypeForBrowserProvider("chatgpt"), "chatgpt-browser");
  assert.equal(adapterTypeForBrowserProvider("claude"), "claude-browser");
  assert.equal(adapterTypeForBrowserProvider("generic"), "generic-browser");
  assert.equal(adapterTypeForBrowserProvider("gemini"), "generic-browser");
});

test("a native permission word is carried across as intent in both directions", () => {
  assert.deepEqual(
    translatedPermissionMode({ fromAdapter: "codex-app-server", toAdapter: "claude-code", mode: "readOnly" }),
    { kind: "rewrite", intent: "read", mode: "plan" },
  );
  assert.deepEqual(
    translatedPermissionMode({ fromAdapter: "claude-code", toAdapter: "codex-app-server", mode: "plan" }),
    { kind: "rewrite", intent: "read", mode: "readOnly" },
  );
  assert.deepEqual(
    translatedPermissionMode({ fromAdapter: "claude-code", toAdapter: "codex-app-server", mode: "acceptEdits" }),
    { kind: "rewrite", intent: "write", mode: "workspaceWrite" },
  );
  assert.deepEqual(
    translatedPermissionMode({ fromAdapter: "codex-app-server", toAdapter: "claude-code", mode: "workspaceWrite" }),
    { kind: "rewrite", intent: "write", mode: "acceptEdits" },
  );
});

test("a semantic word is written in the receiving adapter's own words, and an unplaceable word is refused", () => {
  assert.deepEqual(
    translatedPermissionMode({ fromAdapter: "codex-app-server", toAdapter: "claude-code", mode: "read" }),
    { kind: "rewrite", intent: "read", mode: "plan" },
  );
  const refused = translatedPermissionMode({
    fromAdapter: "codex-app-server",
    toAdapter: "claude-code",
    mode: "workspceWrite",
  });
  assert.equal(refused.kind, "refuse");
});

test("moving to a provider with no permission concept refuses a read restriction and drops a write", () => {
  const readRestriction = translatedPermissionMode({
    fromAdapter: "codex-app-server",
    toAdapter: "generic-browser",
    mode: "readOnly",
  });
  assert.equal(readRestriction.kind, "refuse");
  assert.match(readRestriction.reason, /no permission mode to enforce it/u);
  assert.deepEqual(
    translatedPermissionMode({
      fromAdapter: "codex-app-server",
      toAdapter: "generic-browser",
      mode: "workspaceWrite",
    }),
    { kind: "drop" },
  );
});

const cliPipeline = {
  version: 1,
  id: "review-only",
  name: "Review only",
  agents: [
    {
      id: "codex",
      name: "Codex",
      adapter: "codex-app-server",
      model: "gpt-5",
      command: "/usr/local/bin/codex",
      resourceId: "res-1",
      capabilities: ["passiveActionLoop"],
      permissionMode: "readOnly",
      approvalPolicy: "onRequest",
      workingDirectory: "/work",
    },
    { id: "claude", name: "Claude", adapter: "claude-code", permissionMode: "acceptEdits" },
  ],
  steps: [
    step({
      id: "review",
      name: "Review",
      participants: ["codex", "claude"],
      permissionModes: { codex: "readOnly", claude: "acceptEdits" },
      approvalPolicies: { codex: "onRequest" },
    }),
  ],
};

test("a read-only Codex slot moved to Claude keeps the restriction and leaves every Codex field behind", () => {
  const assigned = assignedPipelineDefinition(cliPipeline, { codex: { adapter: "claude-code" } });
  const codex = assigned.agents.find((agent) => agent.id === "codex");
  assert.deepEqual(codex, {
    id: "codex",
    name: "Codex",
    adapter: "claude-code",
    workingDirectory: "/work",
    permissionMode: "plan",
  });
  assert.equal(assigned.steps[0].permissionModes.codex, "plan");
  assert.equal(assigned.steps[0].permissionModes.claude, "acceptEdits");
  // Approval policies are Codex's alone; the slot that left Codex loses it, the one that stayed
  // would keep it, and here only the Codex slot moved.
  assert.equal(assigned.steps[0].approvalPolicies, undefined);
});

test("a write-intent Claude slot moved to Codex keeps its write authority", () => {
  const assigned = assignedPipelineDefinition(cliPipeline, {
    claude: { adapter: "codex-app-server" },
  });
  assert.equal(assigned.agents.find((agent) => agent.id === "claude").permissionMode, "workspaceWrite");
  assert.equal(assigned.steps[0].permissionModes.claude, "workspaceWrite");
  assert.equal(assigned.steps[0].permissionModes.codex, "readOnly");
  assert.deepEqual(assigned.steps[0].approvalPolicies, { codex: "onRequest" });
});

test("a read-only CLI slot cannot move to a browser conversation", () => {
  const refusals = assignmentRefusals(cliPipeline, { codex: { adapter: "generic-browser" } });
  assert.equal(refusals.length > 0, true);
  assert.equal(refusals[0].agentId, "codex");
  assert.match(refusals[0].reason, /no permission mode to enforce it/u);
  // The refusal is honoured by dropping the override, never by executing the pipeline with the
  // restriction quietly removed.
  assert.deepEqual(usableAssignments(cliPipeline, { codex: { adapter: "generic-browser" } }), {});
  assert.equal(
    assignedPipelineDefinition(cliPipeline, { codex: { adapter: "generic-browser" } }),
    cliPipeline,
  );
});

test("a write-intent slot may move to a browser conversation, dropping the inert declaration", () => {
  assert.deepEqual(assignmentRefusals(cliPipeline, { claude: { adapter: "chatgpt-browser" } }), []);
  const assigned = assignedPipelineDefinition(cliPipeline, {
    claude: { adapter: "chatgpt-browser" },
  });
  assert.equal(assigned.agents.find((agent) => agent.id === "claude").permissionMode, undefined);
  assert.deepEqual(assigned.steps[0].permissionModes, { codex: "readOnly" });
});

test("no override, and an override naming the pipeline's own adapter, change nothing", () => {
  assert.equal(assignedPipelineDefinition(cliPipeline, {}), cliPipeline);
  assert.equal(
    assignedPipelineDefinition(cliPipeline, { codex: { adapter: "codex-app-server" } }),
    cliPipeline,
  );
  const agent = cliPipeline.agents[0];
  assert.equal(assignedAgentDefinition(agent, undefined), agent);
  assert.equal(assignedAgentDefinition(agent, { adapter: "codex-app-server" }), agent);
});

test("an override naming a participant this pipeline does not declare is ignored", () => {
  assert.deepEqual(usableAssignments(cliPipeline, { stranger: { adapter: "claude-code" } }), {});
});

const rolePipeline = {
  version: 1,
  id: "specialist",
  name: "Specialist",
  agents: [
    { id: "gpt-builder", name: "Builder participant", adapter: "chatgpt-browser" },
    { id: "claude-lead", name: "Lead participant", adapter: "claude-browser" },
    { id: "spare", name: "Spare participant", adapter: "claude-browser" },
  ],
  roles: [
    { id: "builder", name: "Builder", instructions: "Build." },
    { id: "lead", name: "Lead", instructions: "Lead." },
  ],
  steps: [
    {
      id: "assign",
      name: "Assign",
      enabled: true,
      humanGate: "none",
      type: "assignRoles",
      roleAssignments: [
        { agentId: "gpt-builder", role: "builder" },
        { agentId: "claude-lead", role: "lead" },
      ],
    },
    step({ id: "work", name: "Work", participants: ["builder", "lead"], parallel: true }),
    step({ id: "off", name: "Disabled", enabled: false, participants: ["spare"] }),
  ],
};

test("a role is offered under its own name, and a participant no enabled step uses is not offered", () => {
  const { slots, constraint } = assignmentSlots(rolePipeline);
  assert.deepEqual(
    slots.map((slot) => [slot.agentId, slot.responsibility, slot.roleId]),
    [
      ["gpt-builder", "Builder", "builder"],
      ["claude-lead", "Lead", "lead"],
    ],
  );
  assert.equal(constraint, undefined);
});

test("a role that changes hands between steps is stated as a constraint, not offered as one control", () => {
  const handover = {
    ...rolePipeline,
    steps: [
      ...rolePipeline.steps.slice(0, 2),
      {
        id: "reassign",
        name: "Reassign",
        enabled: true,
        humanGate: "none",
        type: "assignRoles",
        roleAssignments: [{ agentId: "spare", role: "builder" }],
      },
      step({ id: "second", name: "Second", participants: ["builder"] }),
    ],
  };
  const { slots, constraint } = assignmentSlots(handover);
  assert.match(constraint, /Builder/u);
  // The Lead role still resolves to one agent, so it keeps its role name; the two agents that held
  // Builder are offered individually under their own names instead.
  assert.deepEqual(
    slots.map((slot) => [slot.agentId, slot.responsibility]),
    [
      ["gpt-builder", "Builder participant"],
      ["claude-lead", "Lead"],
      ["spare", "Spare participant"],
    ],
  );
});

test("a step's role key resolves to the agent holding the role at that step, not the final holder", () => {
  const handover = {
    ...rolePipeline,
    steps: [
      ...rolePipeline.steps.slice(0, 2),
      {
        id: "reassign",
        name: "Reassign",
        enabled: true,
        humanGate: "none",
        type: "assignRoles",
        roleAssignments: [{ agentId: "spare", role: "builder" }],
      },
      step({ id: "second", name: "Second", participants: ["builder"] }),
    ],
  };
  const byStep = roleBindingsByStep(handover);
  assert.equal(byStep.get("work").get("builder"), "gpt-builder");
  assert.equal(byStep.get("second").get("builder"), "spare");
});

test("a pipeline with no roles offers each participating agent under its own name", () => {
  const { slots } = assignmentSlots(cliPipeline);
  assert.deepEqual(
    slots.map((slot) => [slot.agentId, slot.responsibility, slot.roleId]),
    [
      ["codex", "Codex", undefined],
      ["claude", "Claude", undefined],
    ],
  );
});

test("reassignment keeps identity, roles, step order and prompts", () => {
  const assigned = assignedPipelineDefinition(rolePipeline, {
    "gpt-builder": { adapter: "codex-app-server" },
  });
  assert.equal(assigned.id, rolePipeline.id);
  assert.deepEqual(assigned.roles, rolePipeline.roles);
  assert.deepEqual(
    assigned.steps.map((entry) => entry.id),
    rolePipeline.steps.map((entry) => entry.id),
  );
  assert.equal(assigned.steps[1].promptTemplate, rolePipeline.steps[1].promptTemplate);
  assert.equal(assigned.agents[0].adapter, "codex-app-server");
  assert.equal(assigned.agents[1].adapter, "claude-browser");
});

test("a persisted assignment map keeps its pipeline identity and drops unknown adapters", () => {
  const parsed = parseScopedAgentAssignments(
    {
      scopeKey: "workspace:/repo",
      pipelineId: "review-only",
      assignments: {
        keep: { adapter: "claude-code", browserSessionId: "s1" },
        unknown: { adapter: "ghost-adapter" },
        malformed: 7,
        missing: { browserSessionId: "s2" },
      },
    },
    (adapter) => adapter === "claude-code",
  );
  assert.deepEqual(parsed, {
    scopeKey: "workspace:/repo",
    pipelineId: "review-only",
    assignments: { keep: { adapter: "claude-code", browserSessionId: "s1" } },
  });
});

test("an assignment map with no pipeline identity is discarded", () => {
  assert.equal(
    parseScopedAgentAssignments({ assignments: { codex: { adapter: "claude-code" } } }, () => true),
    undefined,
  );
  assert.equal(parseScopedAgentAssignments(null, () => true), undefined);
  assert.equal(
    parseScopedAgentAssignments(
      { scopeKey: "s", pipelineId: "p", assignments: { codex: { adapter: "gone" } } },
      () => false,
    ),
    undefined,
  );
});

test("reassignment is refused for committed work and allowed once the run is idle", () => {
  const idle = { busy: false, workflowStatus: "idle", queuedCount: 0, hasResumable: false };
  assert.equal(assignmentLockReason(idle), undefined);
  assert.match(assignmentLockReason({ ...idle, busy: true }), /active operation/u);
  assert.match(assignmentLockReason({ ...idle, workflowStatus: "paused" }), /Reset this run/u);
  assert.match(assignmentLockReason({ ...idle, queuedCount: 1 }), /queue/u);
  assert.match(assignmentLockReason({ ...idle, hasResumable: true }), /interrupted workflow/u);
  assert.equal(assignmentLockReason({ ...idle, catalogError: "catalog broken" }), "catalog broken");
});

test("the reassigned review-only pipeline passes the adapter registry's own option validation", () => {
  const { createAdapterRegistry } = require("../dist/adapters/registry.js");
  const reviewOnly = JSON.parse(
    require("node:fs").readFileSync(
      require("node:path").join(__dirname, "..", "presets", "review-only.pipeline.json"),
      "utf8",
    ),
  );
  const registry = createAdapterRegistry();
  assert.deepEqual(registry.validatePipeline(reviewOnly), []);
  // Codex declares readOnly and a Codex approval policy. Forwarding either to Claude is what the
  // registry rejects, so a clean result here is the proof that authority was translated.
  const reassigned = assignedPipelineDefinition(reviewOnly, {
    codex: { adapter: "claude-code" },
  });
  assert.deepEqual(registry.validatePipeline(reassigned), []);
  assert.equal(reassigned.agents.find((agent) => agent.id === "codex").permissionMode, "plan");
  assert.equal(reassigned.steps[0].permissionModes.codex, "plan");
  assert.equal(reassigned.steps[0].approvalPolicies, undefined);
});

test("a role-keyed permission entry stays adapter-independent while an agent-keyed one becomes native", () => {
  const mixed = {
    version: 1,
    id: "mixed",
    name: "Mixed keys",
    agents: [{ id: "worker", name: "Worker", adapter: "codex-app-server" }],
    roles: [{ id: "builder", name: "Builder", instructions: "Build." }],
    steps: [
      {
        id: "assign",
        name: "Assign",
        enabled: true,
        humanGate: "none",
        type: "assignRoles",
        roleAssignments: [{ agentId: "worker", role: "builder" }],
      },
      step({
        id: "work",
        name: "Work",
        participants: ["builder"],
        permissionModes: { builder: "read", worker: "readOnly" },
      }),
    ],
  };
  const assigned = assignedPipelineDefinition(mixed, { worker: { adapter: "claude-code" } });
  const work = assigned.steps.find((entry) => entry.id === "work");
  // A role key is a claim about whichever candidate holds the role, so it keeps the neutral word;
  // an agent key names one adapter and takes that adapter's own.
  assert.equal(work.permissionModes.builder, "read");
  assert.equal(work.permissionModes.worker, "plan");
  const { createAdapterRegistry } = require("../dist/adapters/registry.js");
  assert.deepEqual(createAdapterRegistry().validatePipeline(assigned), []);
});
