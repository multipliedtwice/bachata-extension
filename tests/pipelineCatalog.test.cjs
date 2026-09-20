const assert = require("node:assert/strict");
const test = require("node:test");

const {
  addCustomPipelines,
  createPipelineValidator,
  pipelineSummary,
  pipelinePresentation,
  planLegacyCustomPipelineMigration,
  readBuiltInPipelineCatalog,
  readCustomPipelineCatalog,
  resetPipelineCatalog,
} = require("../dist/pipeline/pipelineCatalog.js");
const { pipelineDefinitionHash } = require("../dist/pipeline/identity.js");

// EX-3. Reading a pipeline catalog: which files become the catalog, which are quarantined and
// why, and what a reload leaves behind. Every one of these was a branch inside `createRuntime`,
// reachable only by standing up a workspace, an extension context and an adapter registry, so a
// duplicate id or a partly-read directory could only be observed by driving the whole runtime.

const definition = (id, overrides = {}) => ({
  version: 1,
  id,
  name: id,
  agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", command: "codex" }],
  steps: [
    {
      id: "one",
      name: "One",
      enabled: true,
      type: "agent",
      participants: ["codex"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
      humanGate: "none",
    },
  ],
  ...overrides,
});

const entry = (name, isFile = true) => ({ name, isFile: () => isFile });
const acceptEverything = createPipelineValidator(() => []);
const passThrough = (value) => value;

const catalogMaps = () => ({
  pipelines: new Map(),
  hashes: new Map(),
  customIds: new Set(),
  customFiles: new Map(),
});

test("pipeline summaries preserve picker, participant, step, and workspace scope metadata", () => {
  const builtIn = definition("ui-ux-review", {
    description: "Inspect the interface",
    agents: [
      { id: "ux", name: "UX", adapter: "claude-code", command: "claude" },
      { id: "a11y", name: "Accessibility", adapter: "codex-app-server", command: "codex" },
    ],
    steps: [
      {
        id: "review",
        name: "Review",
        enabled: true,
        type: "agent",
        participants: ["ux", "a11y"],
        promptTemplate: "{{userPrompt}}",
        parallel: true,
        consensus: false,
        humanGate: "none",
      },
      {
        id: "disabled",
        name: "Disabled",
        enabled: false,
        type: "agent",
        participants: ["ux"],
        promptTemplate: "{{userPrompt}}",
        parallel: false,
        consensus: false,
        humanGate: "none",
      },
    ],
  });
  assert.deepEqual(pipelineSummary(builtIn, false, "built-in-hash", {
    key: "workspace:/ignored",
    root: "/ignored",
    directory: "/ignored/.bachata/pipelines",
  }), {
    id: "ui-ux-review",
    name: "ui-ux-review",
    description: "Inspect the interface",
    editable: false,
    hash: "built-in-hash",
    scopeKey: "builtin",
    prominentOrder: 6,
    pickerCategory: "common",
    participantCount: 2,
    participantNames: ["UX", "Accessibility"],
    writesCode: true,
    stepCount: 1,
    presentation: {
      promptPlaceholder: "Review this interface for usability, accessibility, and visual hierarchy…",
      icon: "search",
    },
    details: {
      roleProviders: [
        { role: "UX", provider: "Claude Code" },
        { role: "Accessibility", provider: "Codex CLI" },
      ],
      authorities: [{
        role: "Pipeline",
        managed: false,
        readOnly: false,
        writeScope: "workspace",
        writablePaths: [],
        protectedPaths: [],
        commitMode: "never",
        checks: [],
      }],
      limits: [],
      humanDecisions: [],
    },
  });

  assert.deepEqual(pipelineSummary(definition("workspace-review"), true, "workspace-hash", {
    key: "workspace:/project",
    root: "/project",
    directory: "/project/.bachata/pipelines",
  }), {
    id: "workspace-review",
    name: "workspace-review",
    editable: true,
    hash: "workspace-hash",
    scopeKey: "workspace:/project",
    pickerCategory: "custom",
    participantCount: 1,
    participantNames: ["Codex"],
    writesCode: true,
    stepCount: 1,
    presentation: {
      promptPlaceholder: "Describe the outcome for workspace-review…",
      icon: "symbol-method",
    },
    details: {
      roleProviders: [{ role: "Codex", provider: "Codex CLI" }],
      authorities: [{
        role: "Pipeline",
        managed: false,
        readOnly: false,
        writeScope: "workspace",
        writablePaths: [],
        protectedPaths: [],
        commitMode: "never",
        checks: [],
      }],
      limits: [],
      humanDecisions: [],
    },
    scopeRoot: "/project",
  });
});

test("pipeline summaries expose only compact picker details", () => {
  const pipeline = definition("managed-review", {
    managedPolicy: {
      writeScope: "configured",
      allowedPaths: ["src", "tests"],
      protectedPaths: [".git"],
      commitMode: "never",
      verificationChecks: [{ id: "project", command: "bachata:project-checks" }],
      maxRevisionCycles: 1,
    },
    roles: [{ id: "worker", name: "Worker", instructions: "Implement", model: "gpt-6-astra", managed: true }],
    steps: [
      {
        id: "assign",
        name: "Assign",
        enabled: true,
        type: "assignRoles",
        humanGate: "none",
        roleAssignments: [{ agentId: "codex", role: "worker" }],
      },
      {
        id: "review",
        name: "Review",
        enabled: true,
        type: "agent",
        participants: ["worker"],
        promptTemplate: "{{userPrompt}}",
        parallel: false,
        consensus: true,
        consensusConfig: { mode: "unanimous", maxRounds: 4, onMaxRounds: "humanGate" },
        humanGate: "after",
      },
    ],
  });
  const details = pipelineSummary(pipeline, false, "hash", {
    key: "workspace:/project",
    root: "/project",
    directory: "/project/.bachata/pipelines",
  }).details;
  assert.deepEqual(details.roleProviders, [{ role: "Worker", provider: "Codex CLI", model: "gpt-6-astra" }]);
  assert.deepEqual(details.authorities, [{
    role: "Worker",
    managed: true,
    readOnly: false,
    writeScope: "configured",
    writablePaths: ["src", "tests"],
    protectedPaths: [".git"],
    commitMode: "never",
    checks: ["bachata:project-checks"],
  }]);
  assert.deepEqual(details.limits, [
    { kind: "consensusRounds", value: 4, stepName: "Review" },
    { kind: "revisionCycles", value: 1 },
  ]);
  assert.deepEqual(details.humanDecisions, [
    { stepName: "Review", timing: "after" },
    { stepName: "Review", timing: "consensusLimit" },
  ]);

  const readOnlyDetails = pipelineSummary(definition("read-only", {
    managedPolicy: { writeScope: "readOnly" },
    roles: [{ id: "reviewer", name: "Reviewer", instructions: "Review", managed: true }],
  }), false, "hash", {
    key: "builtin",
    directory: "/presets",
  }).details;
  assert.equal(readOnlyDetails.authorities[0].readOnly, true);
  assert.equal(readOnlyDetails.authorities[0].writeScope, "readOnly");
});

test("pipeline summaries derive code-writing capability from every declared execution path", () => {
  const scope = { key: "builtin", directory: "/presets" };
  const writesCode = (pipeline) => pipelineSummary(pipeline, false, `${pipeline.id}-hash`, scope).writesCode;
  const agent = { id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "workspaceWrite" };
  const step = definition("base").steps[0];

  assert.equal(writesCode(definition("read-only", {
    agents: [{ ...agent, permissionMode: "readOnly" }],
  })), false);
  assert.equal(writesCode(definition("writer", { agents: [agent] })), true);
  assert.equal(writesCode(definition("policy-refusal", {
    managedPolicy: { writeScope: "readOnly" },
    agents: [agent],
  })), false);
  assert.equal(writesCode(definition("policy-writer", {
    managedPolicy: { writeScope: "configured" },
    agents: [{ ...agent, permissionMode: "readOnly" }],
  })), true);
  assert.equal(writesCode(definition("checklist-writer", {
    agents: [agent],
    steps: [{
      id: "execute",
      name: "Execute",
      enabled: true,
      type: "executeChecklist",
      humanGate: "none",
      inputName: "work",
      pipelineId: "worker",
      allowedPaths: ["src"],
      checks: [],
    }],
  })), true);
  assert.equal(writesCode(definition("assignment-only", {
    agents: [agent],
    steps: [{
      id: "assign",
      name: "Assign",
      enabled: true,
      type: "assignRoles",
      humanGate: "none",
      roleAssignments: [],
    }],
  })), false);
  assert.equal(writesCode(definition("disabled-and-overridden", {
    agents: [agent],
    steps: [
      { ...step, enabled: false },
      { ...step, id: "read", permissionModes: { codex: "readOnly" } },
    ],
  })), false);
  assert.equal(writesCode(definition("missing-participant", {
    agents: [agent],
    steps: [{ ...step, participants: ["missing"] }],
  })), false);

  const role = {
    id: "reviewer",
    name: "Reviewer",
    instructions: "Review the change",
    candidateAgentIds: ["codex"],
    readOnly: true,
  };
  const roleSteps = [
    {
      id: "assign",
      name: "Assign",
      enabled: true,
      type: "assignRoles",
      humanGate: "none",
      roleAssignments: [{ agentId: "codex", role: "reviewer" }],
    },
    { ...step, id: "review", participants: ["reviewer"] },
  ];
  assert.equal(writesCode(definition("role-reader", { agents: [agent], roles: [role], steps: roleSteps })), false);
  assert.equal(writesCode(definition("role-writer", {
    agents: [agent],
    roles: [{ ...role, readOnly: false }],
    steps: [roleSteps[0], { ...roleSteps[1], permissionModes: { reviewer: "write" } }],
  })), true);
});

test("every shipped pipeline has distinct prompt copy and custom pipelines use their name", async () => {
  const { readdir, readFile } = require("node:fs/promises");
  const { join } = require("node:path");
  const presetRoot = join(__dirname, "..", "presets");
  const files = (await readdir(presetRoot)).filter((name) => name.endsWith(".pipeline.json"));
  const pipelines = await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(presetRoot, name), "utf8"))));
  const presentations = pipelines.map((pipeline) => pipelinePresentation(pipeline, false));
  assert.equal(presentations.length, files.length);
  assert.equal(new Set(presentations.map((item) => item.promptPlaceholder)).size, presentations.length);
  for (const item of presentations) {
    assert.match(item.promptPlaceholder, /…$/u);
    assert.ok(item.icon.length > 0);
  }
  assert.deepEqual(pipelinePresentation({ id: "mine", name: "Security pass" }, true), {
    promptPlaceholder: "Describe the outcome for Security pass…",
    icon: "symbol-method",
  });
  assert.deepEqual(pipelinePresentation({ id: "browser-check", name: "Browser check" }, false), {
    promptPlaceholder: "Describe the outcome for Browser check…",
    icon: "globe",
  });
});

test("a preset that cannot be parsed costs its own file, never the catalog", async () => {
  // WHY. One shipped preset taking a Codex-incompatible permission mode used to throw out of the
  // read loop, so every default pipeline disappeared from the editor because of one file.
  const result = await readBuiltInPipelineCatalog({
    readDirectory: async () => [entry("good.json"), entry("broken.json"), entry("notes.md")],
    readText: async (name) => (name === "broken.json" ? "{" : JSON.stringify(definition("good"))),
    validate: passThrough,
  });
  assert.deepEqual([...result.loaded.keys()], ["good"]);
  assert.equal(result.quarantined.length, 1);
  assert.match(result.quarantined[0], /^broken\.json: /);
});

test("a non-Error preset failure is quarantined with its exact reason", async () => {
  const result = await readBuiltInPipelineCatalog({
    readDirectory: async () => [entry("broken.json"), entry("keep.json")],
    readText: async (name) => {
      if (name === "broken.json") throw "catalog unavailable";
      return JSON.stringify(definition("keep"));
    },
    validate: passThrough,
  });
  assert.deepEqual(result.quarantined, ["broken.json: catalog unavailable"]);
});

test("two presets claiming one id quarantine both and name each other", async () => {
  // WHY BOTH. Keeping the first made directory order decide which definition the editor served,
  // so the same two files could ship different behaviour on two machines.
  const result = await readBuiltInPipelineCatalog({
    readDirectory: async () => [entry("b.json"), entry("a.json"), entry("keep.json")],
    readText: async (name) =>
      JSON.stringify(definition(name === "keep.json" ? "keep" : "clash")),
    validate: passThrough,
  });
  assert.deepEqual([...result.loaded.keys()], ["keep"]);
  assert.deepEqual(result.quarantined, [
    "a.json: duplicate pipeline id clash, also declared by b.json",
    "b.json: duplicate pipeline id clash, also declared by a.json",
  ]);
});

test("a directory that yields no usable preset is a hard failure, not an empty catalog", async () => {
  await assert.rejects(
    readBuiltInPipelineCatalog({
      readDirectory: async () => [entry("broken.json")],
      readText: async () => "{",
      validate: passThrough,
    }),
    /No pipeline preset could be loaded: broken\.json: /,
  );
  await assert.rejects(
    readBuiltInPipelineCatalog({
      readDirectory: async () => [],
      readText: async () => "",
      validate: passThrough,
    }),
    /No pipeline presets were found/,
  );
});

test("a non-file, a misnamed file and a built-in collision are all reported together", async () => {
  const result = await readCustomPipelineCatalog({
    readDirectory: async () => [
      entry("directory.pipeline.json", false),
      entry("wrong-name.pipeline.json"),
      entry("shadow.pipeline.json"),
      entry("ignored.txt"),
    ],
    resolveFile: (name) => `/catalog/${name}`,
    readText: async (filePath) =>
      JSON.stringify(definition(filePath.endsWith("shadow.pipeline.json") ? "shadow" : "other")),
    validate: passThrough,
    isBuiltIn: (id) => id === "shadow",
  });
  assert.equal(result.loaded.length, 0);
  assert.match(result.error, /Pipeline path directory\.pipeline\.json is not a regular file/);
  assert.match(result.error, /wrong-name\.pipeline\.json must be named other\.pipeline\.json/);
  assert.match(result.error, /Custom pipeline shadow conflicts with a built-in preset/);
});

test("two custom files claiming one id are refused by id, naming both paths", async () => {
  // WHY BY ID. The filename check catches a file named for the wrong pipeline; it cannot catch a
  // copy correctly named for a pipeline another correctly named file already declares.
  const result = await readCustomPipelineCatalog({
    readDirectory: async () => [entry("twin.pipeline.json"), entry("twin.pipeline.json")],
    resolveFile: (name) => `/catalog/${name}`,
    readText: async () => JSON.stringify(definition("twin")),
    validate: passThrough,
    isBuiltIn: () => false,
  });
  assert.equal(
    result.error,
    "Custom pipeline catalog is invalid: Duplicate custom pipeline id twin: "
      + "/catalog/twin.pipeline.json, /catalog/twin.pipeline.json",
  );
});

test("a file that changes underneath the read is reported, not silently skipped", async () => {
  const result = await readCustomPipelineCatalog({
    readDirectory: async () => [entry("gone.pipeline.json")],
    resolveFile: (name) => name,
    readText: async () => undefined,
    validate: passThrough,
    isBuiltIn: () => false,
  });
  assert.match(result.error, /gone\.pipeline\.json changed while the catalog was loading/);
});

test("a valid custom catalog is read in name order and hashed by definition", async () => {
  const result = await readCustomPipelineCatalog({
    readDirectory: async () => [entry("zulu.pipeline.json"), entry("alpha.pipeline.json")],
    resolveFile: (name) => `/catalog/${name}`,
    readText: async (filePath) =>
      JSON.stringify(definition(filePath.includes("zulu") ? "zulu" : "alpha")),
    validate: passThrough,
    isBuiltIn: () => false,
  });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.loaded.map((item) => item.pipeline.id), ["alpha", "zulu"]);
  assert.deepEqual(result.loaded.map((item) => item.filePath), [
    "/catalog/alpha.pipeline.json",
    "/catalog/zulu.pipeline.json",
  ]);
  assert.equal(result.loaded[0].hash, pipelineDefinitionHash(definition("alpha")));
});

test("a reload refills the same map instances and drops the previous custom entries", () => {
  // WHY THE SAME INSTANCES. Other parts of the runtime hold these maps directly, so replacing
  // them on reload would leave those readers on a catalog nobody updates again.
  const catalog = catalogMaps();
  const { pipelines, hashes, customIds, customFiles } = catalog;
  addCustomPipelines(catalog, [
    { pipeline: definition("stale"), filePath: "/old/stale.pipeline.json", hash: "h" },
  ]);
  resetPipelineCatalog(catalog, new Map([["builtin", definition("builtin")]]));
  assert.equal(catalog.pipelines, pipelines);
  assert.equal(catalog.hashes, hashes);
  assert.equal(catalog.customIds, customIds);
  assert.equal(catalog.customFiles, customFiles);
  assert.deepEqual([...pipelines.keys()], ["builtin"]);
  assert.equal(hashes.get("builtin"), pipelineDefinitionHash(definition("builtin")));
  assert.equal(customIds.size, 0);
  assert.equal(customFiles.size, 0);
});

test("custom entries override nothing built-in but are marked custom with their file", () => {
  const catalog = catalogMaps();
  resetPipelineCatalog(catalog, new Map([["builtin", definition("builtin")]]));
  addCustomPipelines(catalog, [
    { pipeline: definition("mine"), filePath: "/catalog/mine.pipeline.json", hash: "hash" },
  ]);
  assert.deepEqual([...catalog.pipelines.keys()].sort(), ["builtin", "mine"]);
  assert.deepEqual([...catalog.customIds], ["mine"]);
  assert.equal(catalog.customFiles.get("mine"), "/catalog/mine.pipeline.json");
  assert.equal(catalog.hashes.get("mine"), "hash");
});

test("a legacy value that was never an array yields no plan at all", () => {
  for (const value of [undefined, null, {}, "[]", 3]) {
    assert.equal(planLegacyCustomPipelineMigration(value, passThrough, () => false), undefined);
  }
});

test("a legacy entry shadowing a built-in id is ignored with its reason, not migrated", () => {
  const plan = planLegacyCustomPipelineMigration(
    [definition("keep"), definition("builtin")],
    passThrough,
    (id) => id === "builtin",
  );
  assert.deepEqual(plan.pipelines.map((item) => item.id), ["keep"]);
  assert.deepEqual(plan.ignored, [
    "Ignored legacy custom pipeline builtin: the id belongs to a built-in preset",
  ]);
});

test("a legacy entry that will not validate is reported by its position and skipped", () => {
  const plan = planLegacyCustomPipelineMigration(
    [definition("first"), "not a pipeline"],
    (value, source) => {
      if (typeof value !== "object") throw new Error(`Invalid pipeline ${source}: not an object`);
      return value;
    },
    () => false,
  );
  assert.deepEqual(plan.pipelines.map((item) => item.id), ["first"]);
  assert.deepEqual(plan.ignored, ["Invalid pipeline legacy custom 2: not an object"]);
});

test("the validator refuses on schema errors and on adapter errors, naming the source", () => {
  assert.throws(
    () => acceptEverything({ id: "no-steps" }, "presets/x.json"),
    /^Error: Invalid pipeline presets\/x\.json: /,
  );
  const adapterRefusal = createPipelineValidator(() => ["step one wants an unknown adapter"]);
  assert.throws(
    () => adapterRefusal(definition("fine"), "custom.pipeline.json"),
    /Invalid pipeline custom\.pipeline\.json: step one wants an unknown adapter/,
  );
  assert.equal(createPipelineValidator(() => [])(definition("fine"), "ok").id, "fine");
});

test("catalog owns picker order and categories without classifying from display text", () => {
  const { pipelinePickerMetadata } = require("../dist/pipeline/pipelineCatalog.js");
  const ordered = [
    "code-review-refine",
    "feature-delivery",
    "debug",
    "paired-managed-fix",
    "review-only",
    "plan",
    "ui-ux-review",
    "fix",
    "review",
    "implementation-plan",
    "managed-fix",
  ];
  for (const [position, id] of ordered.entries()) {
    assert.deepEqual(pipelinePickerMetadata(id, false), { pickerCategory: "common", prominentOrder: position });
    assert.deepEqual(pipelinePickerMetadata(id, true), { pickerCategory: "custom" });
  }
  assert.deepEqual(pipelinePickerMetadata("new-specialized-workflow", false), { pickerCategory: "specialized" });
  assert.deepEqual(pipelinePickerMetadata("todo-master", false), { pickerCategory: "internal" });
  assert.deepEqual(pipelinePickerMetadata("custom-review", true), { pickerCategory: "custom" });
});
