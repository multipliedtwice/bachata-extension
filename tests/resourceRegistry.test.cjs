const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseResourceRegistry,
  resourceAvailabilityFromRegistry,
  loadResourceRegistry,
  RESOURCE_REGISTRY_PATH,
} = require("../dist/pipeline/resourceRegistry.js");
const { preflightResourceDependencies } = require("../dist/pipeline/resourceDependencies.js");

const dependency = (overrides = {}) => ({
  id: "docs", kind: "mcpServer", name: "docs-server", required: true, ...overrides,
});

test("a repository registry satisfies a declared dependency end to end", () => {
  const { registry, errors } = parseResourceRegistry({
    version: 1,
    resources: [{ id: "docs", kind: "mcpServer", name: "docs-server", version: "2.0.0", configurationDigest: "abc" }],
  });
  assert.deepEqual(errors, []);
  const observed = resourceAvailabilityFromRegistry(registry, [dependency()]);
  const preflight = preflightResourceDependencies(
    [dependency({ version: "2.0.0", configurationDigest: "abc" })],
    observed,
  );
  assert.deepEqual(preflight.refusals, [], "a satisfied dependency refused the run");
  assert.equal(preflight.statuses[0].available, true);
  assert.equal(preflight.statuses[0].reproducible, true);
});

test("a dependency the repository does not declare refuses, and says which file to fix", () => {
  const { registry } = parseResourceRegistry({ version: 1, resources: [] });
  const preflight = preflightResourceDependencies(
    [dependency()],
    resourceAvailabilityFromRegistry(registry, [dependency()]),
  );
  assert.equal(preflight.refusals.length, 1);
  assert.match(preflight.refusals[0], new RegExp(RESOURCE_REGISTRY_PATH.replace(/[.]/gu, "\\.")));
});

test("a registry version mismatch is reported, not silently accepted", () => {
  const { registry } = parseResourceRegistry({
    version: 1,
    resources: [{ id: "docs", kind: "mcpServer", name: "docs-server", version: "1.0.0" }],
  });
  const preflight = preflightResourceDependencies(
    [dependency({ version: "2.0.0" })],
    resourceAvailabilityFromRegistry(registry, [dependency()]),
  );
  assert.equal(preflight.refusals.length, 1);
  assert.match(preflight.refusals[0], /answered version 1\.0\.0/u);
});

test("a malformed registry is refused rather than half-read", () => {
  assert.match(parseResourceRegistry({ version: 2, resources: [] }).errors.join("\n"), /version must be 1/u);
  assert.match(parseResourceRegistry({ version: 1, resources: {} }).errors.join("\n"), /must be an array/u);
  assert.match(
    parseResourceRegistry({ version: 1, resources: [{ id: "a", kind: "tool", name: "a" }, { id: "a", kind: "tool", name: "a" }] }).errors.join("\n"),
    /duplicates resource a/u,
  );
  assert.match(
    parseResourceRegistry({ version: 1, resources: [{ id: "a", kind: "tool", name: "a", secret: "x" }] }).errors.join("\n"),
    /is not a known key/u,
  );
  assert.equal(parseResourceRegistry({ version: 1, resources: [{ id: "a", kind: "tool", name: "a", secret: "x" }] }).registry, undefined);
});

test("a repository with no registry reports every dependency as undeclared", async () => {
  const missing = await loadResourceRegistry("/nowhere", async () => {
    throw Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
  });
  assert.equal(missing.status, "absent");
  const observed = resourceAvailabilityFromRegistry(undefined, [dependency()]);
  assert.equal(observed[0].available, false);
  assert.match(observed[0].detail, /declares no resources/u);
});

test("the registry loader reads and parses the declared file", async () => {
  const registry = await loadResourceRegistry("/repo", async (candidate) => {
    assert.equal(candidate, `/repo/${RESOURCE_REGISTRY_PATH}`);
    return JSON.stringify({ version: 1, resources: [{ id: "docs", kind: "mcpServer", name: "docs-server", version: "2.0.0" }] });
  });
  assert.equal(registry.status, "valid");
  assert.deepEqual(registry.registry.resources, [{ id: "docs", kind: "mcpServer", name: "docs-server", version: "2.0.0" }]);
});

test("a registry entry must corroborate the dependency's kind and name, not just its id", () => {
  const { registry } = parseResourceRegistry({
    version: 1,
    resources: [{ id: "docs", kind: "mcpServer", name: "docs-server" }],
  });
  const renamed = resourceAvailabilityFromRegistry(registry, [
    dependency({ name: "a-different-server" }),
  ]);
  assert.equal(renamed[0].available, false, "a dependency kept its id and changed its name");
  assert.match(renamed[0].detail, /declares docs as mcpServer docs-server/u);

  const rekinded = resourceAvailabilityFromRegistry(registry, [dependency({ kind: "skill" })]);
  assert.equal(rekinded[0].available, false, "a dependency kept its id and changed its kind");

  const matching = resourceAvailabilityFromRegistry(registry, [dependency()]);
  assert.equal(matching[0].available, true);
});

test("a registry entry without kind or name is refused", () => {
  assert.match(
    parseResourceRegistry({ version: 1, resources: [{ id: "docs" }] }).errors.join("\n"),
    /kind is required/u,
  );
  assert.match(
    parseResourceRegistry({ version: 1, resources: [{ id: "docs", kind: "tool" }] }).errors.join("\n"),
    /name is required/u,
  );
});

test("an unreadable or malformed registry is invalid, never absent", async () => {
  const malformed = await loadResourceRegistry("/repo", async () => "{ not json");
  assert.equal(malformed.status, "invalid");
  assert.match(malformed.errors.join("\n"), /is not valid JSON/u);

  const schemaInvalid = await loadResourceRegistry("/repo", async () =>
    JSON.stringify({ version: 2, resources: [] }));
  assert.equal(schemaInvalid.status, "invalid");
  assert.match(schemaInvalid.errors.join("\n"), /version must be 1/u);
});

test("a broken registry refuses even a run whose dependencies are all optional", () => {
  const preflight = preflightResourceDependencies(
    [dependency({ required: false })],
    [{ id: "docs", available: false, configurationError: ".bachata/resources.json could not be read" }],
  );
  assert.equal(
    preflight.refusals.length,
    1,
    "a repository that mis-declared its resources ran anyway because nothing was required",
  );
  assert.match(preflight.refusals[0], /could not be read/u);
});

test("a registry that exists but cannot be read is invalid, never absent", async () => {
  for (const code of ["EACCES", "EPERM", "EISDIR", "EIO"]) {
    const failure = Object.assign(new Error(`${code}: cannot read`), { code });
    const load = await loadResourceRegistry("/repo", async () => {
      throw failure;
    });
    assert.equal(load.status, "invalid", `${code} was treated as an absent registry`);
    assert.match(load.errors.join("\n"), /could not be read/u);
  }
});

test("only a genuinely missing path means absent", async () => {
  for (const code of ["ENOENT", "ENOTDIR"]) {
    const failure = Object.assign(new Error(`${code}: missing`), { code });
    const load = await loadResourceRegistry("/repo", async () => {
      throw failure;
    });
    assert.equal(load.status, "absent", `${code} should mean no registry was declared`);
  }
});

test("an unreadable registry refuses a run whose dependencies are all optional", async () => {
  const failure = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const load = await loadResourceRegistry("/repo", async () => {
    throw failure;
  });
  assert.equal(load.status, "invalid");
  const preflight = preflightResourceDependencies(
    [dependency({ required: false })],
    [{ id: "docs", available: false, configurationError: load.errors.join("; ") }],
  );
  assert.equal(
    preflight.refusals.length,
    1,
    "a run proceeded on a registry nobody could read because nothing was required",
  );
});

// EX-3. What a registry load says about the dependencies a workflow declared.
const { resourceAvailabilityForLoad } = require("../dist/pipeline/resourceRegistry.js");

const dependencies = [
  { id: "postgres", kind: "database", name: "Primary" },
  { id: "redis", kind: "cache" },
];

test("a registry the repository never wrote declares nothing, and each dependency is judged alone", () => {
  const absent = resourceAvailabilityForLoad({ status: "absent" }, dependencies);
  assert.equal(absent.length, 2);
  absent.forEach((entry) => {
    assert.equal(entry.available, false);
    assert.equal(entry.configurationError, undefined, "an absent registry is not a configuration error");
  });
});

test("a broken registry refuses every dependency and says which file could not be read", () => {
  const invalid = resourceAvailabilityForLoad(
    { status: "invalid", errors: ["resources[0].id is required", "resources[1] is not an object"] },
    dependencies,
  );
  assert.deepEqual(invalid.map((entry) => entry.id), ["postgres", "redis"]);
  invalid.forEach((entry) => {
    assert.equal(entry.available, false);
    assert.equal(
      entry.configurationError,
      ".bachata/resources.json could not be read: resources[0].id is required; resources[1] is not an object",
    );
  });
});

test("a registry that parses is compared entry by entry", () => {
  const valid = resourceAvailabilityForLoad(
    {
      status: "valid",
      registry: { resources: [{ id: "postgres", kind: "database", name: "Primary" }] },
    },
    dependencies,
  );
  assert.equal(valid.find((entry) => entry.id === "postgres").available, true);
  assert.equal(valid.find((entry) => entry.id === "redis").available, false);
  valid.forEach((entry) => { assert.equal(entry.configurationError, undefined); });
});
