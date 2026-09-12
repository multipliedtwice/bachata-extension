const assert = require("node:assert/strict");
const test = require("node:test");

const {
  adapterAcceptsModel,
  assignedAgentDefinition,
  assignedPipelineDefinition,
  assignmentRefusals,
  assignmentSlots,
  isWellFormedAssignmentModel,
  parseScopedAgentAssignments,
  usableAssignments,
} = require("../dist/pipeline/agentAssignment.js");
const { parseWebviewMessage } = require("../dist/webview/protocol.js");
const {
  parseCodexModelList,
  providerModelRefusal,
} = require("../dist/adapters/providerModels.js");
const { recoveryCheckpointIsUsable } = require("../dist/runtime/recoveryCheckpoint.js");

const knownAdapter = (adapter) =>
  ["codex-app-server", "claude-code", "chatgpt-browser", "claude-browser"].includes(adapter);

const pipeline = (agents) => ({
  id: "review",
  name: "Review",
  version: 1,
  agents,
  steps: [
    {
      id: "s1",
      name: "Review",
      enabled: true,
      humanGate: "none",
      type: "agent",
      parallel: false,
      consensus: false,
      participants: ["codex"],
      promptTemplate: "{{userPrompt}}",
    },
  ],
});

test("a model name is validated by shape, never by a catalog this build ships", () => {
  for (const value of ["gpt-6-astra", "claude-opus-5", "glm-4.6", "o4-mini", "vendor/model:1"]) {
    assert.equal(isWellFormedAssignmentModel(value), true, value);
  }
  for (const value of ["", " gpt-6-astra", "gpt-6-astra ", "-leading", "a b", "a;rm -rf /", "a\nb", "x".repeat(201)]) {
    assert.equal(isWellFormedAssignmentModel(value), false, JSON.stringify(value));
  }
});

test("agents.model.select accepts a well-formed model, an absent model, and refuses anything else", () => {
  assert.deepEqual(
    parseWebviewMessage({ type: "agents.model.select", agentId: "codex", model: "gpt-6-astra" }),
    { success: true, message: { type: "agents.model.select", agentId: "codex", model: "gpt-6-astra" } },
  );
  // Absent means "provider default": the reader clearing their own choice, not Bachata choosing.
  assert.deepEqual(
    parseWebviewMessage({ type: "agents.model.select", agentId: "codex" }),
    { success: true, message: { type: "agents.model.select", agentId: "codex" } },
  );
  for (const model of ["", "  ", "gpt 6", "gpt-6; rm -rf /", 7, null]) {
    const parsed = parseWebviewMessage({ type: "agents.model.select", agentId: "codex", model });
    assert.equal(parsed.success, false, JSON.stringify(model));
    assert.match(parsed.error, /invalid model/u, JSON.stringify(model));
  }
  const extra = parseWebviewMessage({
    type: "agents.model.select",
    agentId: "codex",
    model: "a",
    extra: 1,
  });
  assert.equal(extra.success, false);
  assert.match(extra.error, /Invalid agents\.model\.select message/u);
});

test("a model reaches the definition the run executes, on the pipeline's provider and on a new one", () => {
  const definition = { id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5.5" };
  assert.equal(
    assignedAgentDefinition(definition, { adapter: "codex-app-server", model: "gpt-6-astra" }).model,
    "gpt-6-astra",
  );
  // Same provider, no model named: the pipeline's own model stays.
  assert.equal(assignedAgentDefinition(definition, { adapter: "codex-app-server" }), definition);
  // A different provider with a model named for it takes that model and nothing else.
  const moved = assignedAgentDefinition(definition, { adapter: "claude-code", model: "claude-opus-5" });
  assert.equal(moved.adapter, "claude-code");
  assert.equal(moved.model, "claude-opus-5");
});

test("changing provider leaves the old provider's model behind unless one is named for the new one", () => {
  const definition = { id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5.5" };
  const moved = assignedAgentDefinition(definition, { adapter: "claude-code" });
  assert.equal(moved.adapter, "claude-code");
  assert.equal(moved.model, undefined, "a Codex model must never reach Claude");
});

test("a browser participant is refused a model, because the website owns the selection", () => {
  assert.equal(adapterAcceptsModel("codex-app-server"), true);
  assert.equal(adapterAcceptsModel("claude-code"), true);
  assert.equal(adapterAcceptsModel("chatgpt-browser"), false);
  const refusals = assignmentRefusals(
    pipeline([{ id: "codex", name: "Codex", adapter: "codex-app-server" }]),
    { codex: { adapter: "chatgpt-browser", model: "gpt-6-astra" } },
  );
  assert.equal(refusals.length, 1);
  assert.match(refusals[0].reason, /whatever model the website has selected/u);
  assert.deepEqual(
    usableAssignments(
      pipeline([{ id: "codex", name: "Codex", adapter: "codex-app-server" }]),
      { codex: { adapter: "chatgpt-browser", model: "gpt-6-astra" } },
    ),
    {},
  );
  // The definition transform never smuggles it through either.
  const executed = assignedPipelineDefinition(
    pipeline([{ id: "codex", name: "Codex", adapter: "codex-app-server" }]),
    { codex: { adapter: "chatgpt-browser" } },
  );
  assert.equal(executed.agents[0].model, undefined);
});

test("a malformed model is refused rather than silently rewritten", () => {
  const refusals = assignmentRefusals(
    pipeline([{ id: "codex", name: "Codex", adapter: "codex-app-server" }]),
    { codex: { adapter: "codex-app-server", model: "gpt 6" } },
  );
  assert.deepEqual(refusals.map((entry) => entry.agentId), ["codex"]);
  assert.match(refusals[0].reason, /not a usable model name/u);
});

test("a stored assignment keeps a usable model and drops one that can no longer mean anything", () => {
  const restored = parseScopedAgentAssignments(
    {
      scopeKey: "workspace",
      pipelineId: "review",
      assignments: {
        codex: { adapter: "codex-app-server", model: "gpt-6-astra" },
        lead: { adapter: "chatgpt-browser", model: "gpt-6-astra" },
        qa: { adapter: "claude-code", model: "bad model" },
      },
    },
    knownAdapter,
  );
  assert.equal(restored.assignments.codex.model, "gpt-6-astra");
  assert.equal(restored.assignments.lead.model, undefined, "a browser row keeps no model");
  assert.equal(restored.assignments.lead.adapter, "chatgpt-browser");
  assert.equal(restored.assignments.qa.model, undefined, "a malformed name is dropped, the slot is not");
  assert.equal(restored.assignments.qa.adapter, "claude-code");
});

test("a slot reports the pipeline's model so the editor can name what the default resolves to", () => {
  const slots = assignmentSlots(
    pipeline([{ id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5.5" }]),
  );
  assert.equal(slots.slots[0].defaultModel, "gpt-5.5");
});

const checkpoint = (assignments) => ({
  pipelineId: "review",
  pipelineHash: "hash",
  totalSteps: 1,
  nextStepIndex: 0,
  attachmentIds: [],
  prompt: "go",
  assignments,
  pipelineSnapshot: {
    definition: pipeline([{ id: "codex", name: "Codex", adapter: "codex-app-server" }]),
    hash: "hash",
    source: "builtin",
  },
});

test("recovery pins the provider and the model, so a resumed run is the run that was interrupted", () => {
  const snapshot = {
    definition: pipeline([{ id: "codex", name: "Codex", adapter: "codex-app-server" }]),
    hash: "hash",
    source: "builtin",
  };
  const usable = (currentAssignments) =>
    recoveryCheckpointIsUsable({
      checkpoint: checkpoint({ codex: { adapter: "claude-code", model: "claude-opus-5" } }),
      selectedSnapshot: snapshot,
      availableAttachmentIds: new Set(),
      currentAssignments,
    });
  assert.equal(usable({ codex: { adapter: "claude-code", model: "claude-opus-5" } }), true);
  assert.equal(usable({ codex: { adapter: "claude-code", model: "claude-opus-4" } }), false);
  assert.equal(usable({ codex: { adapter: "claude-code" } }), false);
  assert.equal(usable({ codex: { adapter: "codex-app-server", model: "claude-opus-5" } }), false);
});

test("a Codex model list is read from what the server reported, hidden rows excluded", () => {
  assert.deepEqual(
    parseCodexModelList({
      data: [
        { id: "gpt-5.6-sol", model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", hidden: false, isDefault: true },
        { id: "gpt-5.5", model: "gpt-5.5", displayName: "GPT-5.5", hidden: false },
        { id: "internal", hidden: true },
        { displayName: "no id" },
      ],
    }),
    [
      { id: "gpt-5.6-sol", label: "GPT-5.6-Sol", isDefault: true },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ],
  );
  // Not a list is not an empty list: it means the question went unanswered.
  assert.equal(parseCodexModelList({}), undefined);
  assert.equal(parseCodexModelList(null), undefined);
  assert.deepEqual(parseCodexModelList({ data: [] }), []);
});

test("only a catalog the provider actually reported can refuse a model", () => {
  const listed = {
    supported: true,
    models: [{ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }, { id: "gpt-5.5", label: "GPT-5.5" }],
  };
  const refusal = providerModelRefusal({
    providerLabel: "Codex",
    commandPath: "/Users/reader/.local/bin/codex",
    runtimeVersion: "0.146.0",
    selectedModel: "gpt-6-astra",
    catalog: listed,
  });
  assert.match(refusal, /\/Users\/reader\/\.local\/bin\/codex/u);
  assert.match(refusal, /0\.146\.0/u);
  assert.match(refusal, /gpt-6-astra/u);
  assert.match(refusal, /gpt-5\.6-sol, gpt-5\.5/u);
  assert.match(refusal, /does not switch the executable or the model for you/u);

  assert.equal(
    providerModelRefusal({
      providerLabel: "Codex",
      commandPath: "codex",
      selectedModel: "gpt-5.5",
      catalog: listed,
    }),
    undefined,
    "a listed model is not refused",
  );
  assert.equal(
    providerModelRefusal({
      providerLabel: "Codex",
      commandPath: "codex",
      selectedModel: "gpt-6-astra",
      catalog: { supported: false, reason: "no model/list" },
    }),
    undefined,
    "a provider that cannot list proves nothing about a model",
  );
  assert.equal(
    providerModelRefusal({
      providerLabel: "Codex",
      commandPath: "codex",
      selectedModel: "gpt-6-astra",
      catalog: { supported: true, models: [] },
    }),
    undefined,
    "an empty reported catalog is a provider quirk, not evidence against this model",
  );
  assert.equal(
    providerModelRefusal({
      providerLabel: "Codex",
      commandPath: "codex",
      selectedModel: undefined,
      catalog: listed,
    }),
    undefined,
    "no model was selected, so nothing can be incompatible",
  );
});
