const assert = require("node:assert/strict");
const test = require("node:test");

const {
  addCustomPipelines,
  createPipelineValidator,
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
