const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createAdapterRegistry } = require("../dist/adapters/registry.js");
const { validatePipelineDefinition } = require("../dist/pipeline/schema.js");
const validatePipeline = (value, name) => {
  const result = validatePipelineDefinition(value);
  assert.ok(result.success, `${name}: ${(result.errors ?? []).join("; ")}`);
  return result.data;
};
const {
  adapterHasApprovalVocabulary,
  adapterHasPermissionVocabulary,
  effectivePermissionMode,
} = require("../dist/pipeline/permissionModes.js");
const { removeScratchSync, scratchRootSync } = require("./support/scratch.cjs");
const { loadRuntimeHarness } = require("./support/runtimeHarness.cjs");

const presetsDirectory = path.resolve(__dirname, "..", "presets");
const presetNames = fs
  .readdirSync(presetsDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();
const readPreset = (name) =>
  JSON.parse(fs.readFileSync(path.join(presetsDirectory, name), "utf8"));

test("every shipped preset validates through the real schema and the real adapter registry", () => {
  // WHY BOTH, AND WHY THE REGISTRY. `feature-delivery` shipped a step permission mode of
  // `acceptEdits` on its Worker ROLE, and that role's first candidate is Codex, which has
  // `readOnly` and `workspaceWrite` and no third option. The schema was happy — the value is a
  // string keyed by a declared participant — and the registry was the gate that refused it. That
  // refusal threw out of the built-in loader, so the visible symptom was not "one preset is
  // wrong" but "the extension has no default pipelines at all".
  assert.ok(presetNames.length > 0, "no presets were found to validate");
  const registry = createAdapterRegistry();
  const failures = [];
  for (const name of presetNames) {
    let definition;
    try {
      definition = validatePipeline(readPreset(name), name);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const errors = registry.validatePipeline(definition);
    if (errors.length > 0) failures.push(`${name}: ${errors.join("; ")}`);
  }
  assert.deepEqual(failures, []);
});

test("every permitted role-to-agent assignment resolves to a mode that agent's adapter accepts", () => {
  // The registry validates a role against every candidate, but only for the steps a preset
  // declares. This asserts the same property one level down and for every role in the catalogue:
  // whichever candidate the run picks, the mode the adapter is SENT is a mode it accepts. A
  // pipeline may only be checked against the assignment it happens to declare if reassignment is
  // impossible, and reassignment is exactly what `candidateAgentIds` is for.
  const registry = createAdapterRegistry();
  const failures = [];
  for (const name of presetNames) {
    const definition = validatePipeline(readPreset(name), name);
    const agents = new Map(definition.agents.map((agent) => [agent.id, agent]));
    for (const role of definition.roles ?? []) {
      const candidates = (role.candidateAgentIds ?? []).filter((id) => agents.has(id));
      assert.ok(
        (role.candidateAgentIds ?? []).length === candidates.length,
        `${name}: role ${role.id} names a candidate that is not an agent`,
      );
      for (const candidateId of candidates) {
        const agent = agents.get(candidateId);
        for (const step of definition.steps) {
          if (step.type !== "agent" && step.type !== "checklist") continue;
          if (!(step.participants ?? []).includes(role.id)) continue;
          const declared = step.permissionModes?.[role.id];
          if (declared !== undefined && !adapterHasPermissionVocabulary(agent.adapter)) continue;
          const permissionMode = effectivePermissionMode({
            adapter: agent.adapter,
            requested: declared ?? agent.permissionMode,
            roleReadOnly: role.readOnly === true,
          });
          if (permissionMode === undefined) continue;
          const errors = registry.validatePipeline({
            ...definition,
            steps: [{ ...step, participants: [candidateId], permissionModes: { [candidateId]: permissionMode } }],
          });
          if (errors.length > 0) {
            failures.push(`${name} ${step.id} ${role.id} as ${candidateId}: ${errors.join("; ")}`);
          }
          // A read-only role never resolves to a writing mode, whichever provider holds it.
          if (role.readOnly === true) {
            assert.ok(
              permissionMode === "plan" || permissionMode === "readOnly",
              `${name} ${step.id}: read-only role ${role.id} as ${candidateId} resolved to ${permissionMode}`,
            );
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test("the shipped Worker and Lead roles resolve correctly on both candidate providers", () => {
  // The two concrete cases from the defect, named rather than implied by a sweep: Codex must get
  // its own vocabulary and Claude must get its own, for the same declared role mode.
  const definition = validatePipeline(readPreset("feature-delivery.pipeline.json"), "feature-delivery");
  const step = definition.steps.find((entry) => entry.id === "implement");
  const review = definition.steps.find((entry) => entry.id === "lead-review");
  const worker = (definition.roles ?? []).find((role) => role.id === "worker");
  const lead = (definition.roles ?? []).find((role) => role.id === "lead");
  const resolve = (adapter, requested, roleReadOnly) =>
    effectivePermissionMode({ adapter, requested, roleReadOnly });

  assert.equal(resolve("codex-app-server", step.permissionModes.worker, worker.readOnly === true), "workspaceWrite");
  assert.equal(resolve("claude-code", step.permissionModes.worker, worker.readOnly === true), "acceptEdits");
  assert.equal(resolve("codex-app-server", review.permissionModes.lead, lead.readOnly === true), "readOnly");
  assert.equal(resolve("claude-code", review.permissionModes.lead, lead.readOnly === true), "plan");
  // And the declared words themselves are adapter-independent, so a reader cannot tell which
  // provider the preset was written against.
  assert.equal(step.permissionModes.worker, "write");
  assert.equal(review.permissionModes.lead, "read");
});

const presetRoot = (files) => {
  const extensionRoot = scratchRootSync("bachata-preset-catalog-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(extensionRoot, "presets", name),
      typeof contents === "string" ? contents : JSON.stringify(contents),
      "utf8",
    );
  }
  return extensionRoot;
};

test("one unusable preset is quarantined and every valid default still loads", async () => {
  // THE FAILURE THIS PINS. The loader wrote each preset into the shared map as it went and threw
  // on the first one that would not validate, so a single bad file removed every default pipeline
  // from the editor — and because "already loaded" was read as `size > 0`, whatever had been
  // added before the throw stayed behind and was served as a complete catalog afterwards.
  const good = readPreset("cross-reference.pipeline.json");
  const alsoGood = readPreset("todo-implementation.pipeline.json");
  const broken = { ...structuredClone(good), id: "broken", steps: [{ id: "nope" }] };
  const extensionRoot = presetRoot({
    "a-broken.pipeline.json": broken,
    "b-good.pipeline.json": good,
    "c-good.pipeline.json": alsoGood,
  });
  const harness = loadRuntimeHarness({ extensionRoot });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const state = harness.runtime.getState();
    const ids = state.pipelines.map((pipeline) => pipeline.id).sort();
    // The broken file is alphabetically first, so a loader that stopped at the first failure
    // would publish nothing at all.
    assert.deepEqual(ids, [good.id, alsoGood.id].sort());
    assert.equal(state.catalogError, undefined, String(state.catalogError ?? ""));
    // The file is not dropped in silence: it is named, with the reason, on the output channel.
    const said = harness.outputLines.join("\n");
    assert.match(said, /Quarantined built-in pipeline preset a-broken\.pipeline\.json/u);
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

const duplicateCatalog = async (files, assertions) => {
  const extensionRoot = presetRoot(files);
  const harness = loadRuntimeHarness({ extensionRoot });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await assertions(harness);
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
};

test("two files claiming one pipeline id quarantine both, whatever order they are read in", async () => {
  // THE FAILURE THIS PINS. The loader kept the first definition it saw for an id and quarantined
  // the second, so `readdir` order decided which of two conflicting files the editor served. The
  // conflict is a defect in both files, and neither is more correct for having been enumerated
  // first, so both are quarantined and the surviving catalog is the same on every machine.
  const good = readPreset("cross-reference.pipeline.json");
  const alsoGood = readPreset("todo-implementation.pipeline.json");
  const first = { ...structuredClone(good), id: "clash", name: "First claim" };
  const second = { ...structuredClone(good), id: "clash", name: "Second claim" };
  const check = async (harness) => {
    const state = harness.runtime.getState();
    assert.deepEqual(state.pipelines.map((pipeline) => pipeline.id), [alsoGood.id]);
    assert.equal(state.catalogError, undefined, String(state.catalogError ?? ""));
    const said = harness.outputLines.join("\n");
    // Both filenames are named, in both messages, so a reader is not left to guess the other one.
    assert.match(said, /Quarantined built-in pipeline preset a-clash\.pipeline\.json: duplicate pipeline id clash, also declared by z-clash\.pipeline\.json/u);
    assert.match(said, /Quarantined built-in pipeline preset z-clash\.pipeline\.json: duplicate pipeline id clash, also declared by a-clash\.pipeline\.json/u);
  };
  await duplicateCatalog({
    "a-clash.pipeline.json": first,
    "m-good.pipeline.json": alsoGood,
    "z-clash.pipeline.json": second,
  }, check);
  // The reversed pair is the same catalog: enumeration order is not a tie-breaker.
  await duplicateCatalog({
    "a-clash.pipeline.json": second,
    "m-good.pipeline.json": alsoGood,
    "z-clash.pipeline.json": first,
  }, check);
});

test("three files claiming one id name every conflicting file", async () => {
  const good = readPreset("cross-reference.pipeline.json");
  const alsoGood = readPreset("todo-implementation.pipeline.json");
  const clash = (name) => ({ ...structuredClone(good), id: "clash", name });
  await duplicateCatalog({
    "a-clash.pipeline.json": clash("A"),
    "b-clash.pipeline.json": clash("B"),
    "c-clash.pipeline.json": clash("C"),
    "m-good.pipeline.json": alsoGood,
  }, async (harness) => {
    assert.deepEqual(
      harness.runtime.getState().pipelines.map((pipeline) => pipeline.id),
      [alsoGood.id],
    );
    const said = harness.outputLines.join("\n");
    assert.match(said, /a-clash\.pipeline\.json: duplicate pipeline id clash, also declared by b-clash\.pipeline\.json, c-clash\.pipeline\.json/u);
    assert.match(said, /b-clash\.pipeline\.json: duplicate pipeline id clash, also declared by a-clash\.pipeline\.json, c-clash\.pipeline\.json/u);
    assert.match(said, /c-clash\.pipeline\.json: duplicate pipeline id clash, also declared by a-clash\.pipeline\.json, b-clash\.pipeline\.json/u);
  });
});

test("a catalog whose every id collides publishes nothing rather than one arbitrary winner", async () => {
  const good = readPreset("cross-reference.pipeline.json");
  const extensionRoot = presetRoot({
    "a-clash.pipeline.json": { ...structuredClone(good), id: "clash", name: "A" },
    "b-clash.pipeline.json": { ...structuredClone(good), id: "clash", name: "B" },
  });
  const harness = loadRuntimeHarness({ extensionRoot });
  try {
    await assert.rejects(
      () => harness.runtime.handleMessage({ type: "ready" }),
      (error) =>
        /No pipeline preset could be loaded/u.test(error.message) &&
        /a-clash\.pipeline\.json/u.test(error.message) &&
        /b-clash\.pipeline\.json/u.test(error.message),
    );
    assert.deepEqual(harness.runtime.getState().pipelines, []);
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("a catalog in which nothing loads publishes nothing rather than part of itself", async () => {
  const good = readPreset("cross-reference.pipeline.json");
  const extensionRoot = presetRoot({
    "a-broken.pipeline.json": { ...structuredClone(good), id: "one", steps: [{ id: "nope" }] },
    "b-broken.pipeline.json": "{ not json",
  });
  const harness = loadRuntimeHarness({ extensionRoot });
  try {
    // Nothing loaded, so nothing is published and the failure is stated rather than absorbed.
    await assert.rejects(
      () => harness.runtime.handleMessage({ type: "ready" }),
      /No pipeline preset could be loaded/u,
    );
    assert.deepEqual(harness.runtime.getState().pipelines, []);
    // Both files are named, so the reason is not lost behind whichever one failed first.
    await assert.rejects(
      () => harness.runtime.handleMessage({ type: "ready" }),
      (error) =>
        /a-broken\.pipeline\.json/u.test(error.message) && /b-broken\.pipeline\.json/u.test(error.message),
    );
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

const baseAgent = (id, adapter, command) => ({
  id,
  name: id,
  adapter,
  command,
});

const permissionCase = (input) => {
  // A role is only a usable participant once an enabled `assignRoles` step has assigned it, so a
  // case that declares roles and no assignment gets each role's first candidate.
  const assign = input.assign ?? (input.roles === undefined
    ? undefined
    : input.roles.map((role) => ({ role: role.id, agentId: role.candidateAgentIds[0] })));
  const definition = {
    version: 1,
    id: "permission-case",
    name: "Permission case",
    description: "A pipeline built only to be judged by the adapter registry.",
    longitudinalIntent: "initiativeRequired",
    agents: input.agents,
    ...(input.roles === undefined ? {} : { roles: input.roles }),
    steps: [
      ...(assign === undefined ? [] : [{
        id: "assign-roles",
        name: "Assign roles",
        enabled: true,
        humanGate: "none",
        type: "assignRoles",
        roleAssignments: assign,
      }]),
      {
        id: "work",
        name: "Work",
        enabled: true,
        humanGate: "none",
        type: "agent",
        participants: input.participants,
        promptTemplate: "{{userPrompt}}",
        parallel: false,
        consensus: false,
        ...(input.permissionModes === undefined ? {} : { permissionModes: input.permissionModes }),
        ...(input.approvalPolicies === undefined ? {} : { approvalPolicies: input.approvalPolicies }),
        attachments: "none",
      },
    ],
  };
  return createAdapterRegistry().validatePipeline(
    validatePipeline(definition, "permission-case"),
  );
};

const codexAgent = baseAgent("codex", "codex-app-server", "codex");
const claudeAgent = baseAgent("claude", "claude-code", "claude");
const zaiAgent = baseAgent("zai", "zai-glm", "claude");
const browserAgent = { id: "gpt", name: "gpt", adapter: "chatgpt-browser" };

test("an agent-keyed permission mode is judged in that adapter's own vocabulary", () => {
  // THE FAILURE THIS PINS. Every declared word used to be run through the semantic translation
  // before any adapter saw it, so `grantsNoWrite` said "not read-only" for a typo and handed the
  // adapter its own write mode instead. `workspceWrite` validated, and the author got a writing
  // agent from a line that says nothing of the sort.
  assert.deepEqual(
    permissionCase({
      agents: [codexAgent],
      participants: ["codex"],
      permissionModes: { codex: "workspceWrite" },
    }),
    ["Step work, codex: unsupported Codex permission mode workspceWrite"],
  );
  // The same mistake in the other direction: a Claude word on a Codex agent.
  assert.deepEqual(
    permissionCase({
      agents: [codexAgent],
      participants: ["codex"],
      permissionModes: { codex: "acceptEdits" },
    }),
    ["Step work, codex: unsupported Codex permission mode acceptEdits"],
  );
  // And a Codex word on a Claude agent.
  assert.deepEqual(
    permissionCase({
      agents: [claudeAgent],
      participants: ["claude"],
      permissionModes: { claude: "workspaceWrite" },
    }),
    ["Step work, claude: unsupported Claude permission mode workspaceWrite"],
  );
  // A native word is still accepted, and so is the adapter-independent one.
  assert.deepEqual(
    permissionCase({
      agents: [codexAgent],
      participants: ["codex"],
      permissionModes: { codex: "workspaceWrite" },
    }),
    [],
  );
  assert.deepEqual(
    permissionCase({
      agents: [codexAgent],
      participants: ["codex"],
      permissionModes: { codex: "write" },
    }),
    [],
  );
});

test("a role-keyed permission mode may only be read or write", () => {
  // A role names whichever agent the run assigns to it, so a provider's own word there is a claim
  // about an adapter that has not been chosen. It is rejected at authoring time rather than
  // silently rewritten into whichever vocabulary the candidate happens to speak.
  assert.deepEqual(
    permissionCase({
      agents: [codexAgent, claudeAgent],
      roles: [{ id: "worker", name: "Worker", instructions: "Do the work.", candidateAgentIds: ["codex", "claude"] }],
      participants: ["worker"],
      permissionModes: { worker: "acceptEdits" },
    }),
    ["Step work, worker: a role permission mode must be read or write, not acceptEdits"],
  );
  assert.deepEqual(
    permissionCase({
      agents: [codexAgent, claudeAgent],
      roles: [{ id: "worker", name: "Worker", instructions: "Do the work.", candidateAgentIds: ["codex", "claude"] }],
      participants: ["worker"],
      permissionModes: { worker: "readOnly" },
    }),
    ["Step work, worker: a role permission mode must be read or write, not readOnly"],
  );
  // A participant assigned by `assignRoles` with no RoleDefinition is a role key too: which agent
  // holds it is still a run-time decision.
  assert.deepEqual(
    permissionCase({
      agents: [claudeAgent],
      assign: [{ role: "worker", agentId: "claude" }],
      participants: ["worker"],
      permissionModes: { worker: "acceptEdits" },
    }),
    ["Step work, worker: a role permission mode must be read or write, not acceptEdits"],
  );
  // The semantic words are accepted for every candidate, including one whose adapter has no
  // permission concept at all.
  assert.deepEqual(
    permissionCase({
      agents: [codexAgent, claudeAgent, browserAgent],
      roles: [{ id: "worker", name: "Worker", instructions: "Do the work.", candidateAgentIds: ["codex", "claude", "gpt"] }],
      participants: ["worker"],
      permissionModes: { worker: "write" },
    }),
    [],
  );
});

test("Z.AI GLM takes Claude's vocabulary, so a semantic mode reaches it as a mode it accepts", () => {
  // THE FAILURE THIS PINS. `zai-glm` was absent from the vocabulary table, so `write` was passed
  // to it verbatim and its validator — which only knows Claude's words — rejected it. Every
  // adapter-independent declaration was unusable for a zAI candidate.
  assert.equal(
    effectivePermissionMode({ adapter: "zai-glm", requested: "write", roleReadOnly: false }),
    "acceptEdits",
  );
  assert.equal(
    effectivePermissionMode({ adapter: "zai-glm", requested: "read", roleReadOnly: false }),
    "plan",
  );
  assert.equal(
    effectivePermissionMode({ adapter: "zai-glm", requested: "write", roleReadOnly: true }),
    "plan",
  );
  assert.ok(adapterHasPermissionVocabulary("zai-glm"));
  assert.deepEqual(
    permissionCase({
      agents: [zaiAgent],
      roles: [{ id: "worker", name: "Worker", instructions: "Do the work.", candidateAgentIds: ["zai"] }],
      participants: ["worker"],
      permissionModes: { worker: "write" },
    }),
    [],
  );
  // Its own vocabulary is still judged for an agent-keyed declaration.
  assert.deepEqual(
    permissionCase({
      agents: [zaiAgent],
      participants: ["zai"],
      permissionModes: { zai: "workspaceWrite" },
    }),
    ["Step work, zai: unsupported Z.AI GLM permission mode workspaceWrite"],
  );
});

test("permission and approval are separate capabilities", () => {
  // THE FAILURE THIS PINS. One test decided whether a role-keyed option was inert, so a Codex
  // approval policy became an error the moment a Claude candidate could hold the role — Claude
  // has permission modes, therefore the option was judged, and Claude has no approval policies,
  // therefore it failed. The two questions are now asked separately.
  assert.ok(adapterHasApprovalVocabulary("codex-app-server"));
  assert.equal(adapterHasApprovalVocabulary("claude-code"), false);
  assert.equal(adapterHasApprovalVocabulary("zai-glm"), false);
  assert.deepEqual(
    permissionCase({
      agents: [codexAgent, claudeAgent],
      roles: [{ id: "lead", name: "Lead", instructions: "Review the work.", candidateAgentIds: ["codex", "claude"], readOnly: true }],
      participants: ["lead"],
      permissionModes: { lead: "read" },
      approvalPolicies: { lead: "onRequest" },
    }),
    [],
  );
  // An approval policy written against an agent id names one adapter, and is still judged there.
  assert.deepEqual(
    permissionCase({
      agents: [claudeAgent],
      participants: ["claude"],
      approvalPolicies: { claude: "onRequest" },
    }),
    ["Step work, claude: Claude does not support Codex approval policies"],
  );
  // A Codex policy Codex accepts is accepted.
  assert.deepEqual(
    permissionCase({
      agents: [codexAgent],
      participants: ["codex"],
      approvalPolicies: { codex: "unlessTrusted" },
    }),
    [],
  );
});
