const assert = require("node:assert/strict");
const test = require("node:test");

const {
  preflightResourceDependencies,
  resourceDependencyProvenance,
  roleMayUseDependency,
} = require("../dist/pipeline/resourceDependencies.js");

const dependency = (overrides = {}) => ({
  id: "docs",
  kind: "mcpServer",
  name: "docs-server",
  required: true,
  ...overrides,
});

test("a required dependency that is absent refuses the run before it starts", () => {
  const preflight = preflightResourceDependencies(
    [dependency()],
    [{ id: "docs", available: false, detail: "not configured" }],
  );
  assert.equal(preflight.statuses[0].available, false);
  assert.equal(preflight.statuses[0].reproducible, false);
  assert.equal(preflight.refusals.length, 1);
  assert.match(preflight.refusals[0], /mcpServer docs-server is declared and required/u);
  assert.match(preflight.refusals[0], /not configured/u);
});

test("an optional dependency is reported but never refuses the run", () => {
  const preflight = preflightResourceDependencies(
    [dependency({ required: false })],
    [{ id: "docs", available: false }],
  );
  assert.deepEqual(preflight.refusals, []);
  assert.equal(preflight.statuses[0].available, false);
});

test("a declared version or configuration must be the one that answered", () => {
  const wrongVersion = preflightResourceDependencies(
    [dependency({ version: "2.0.0" })],
    [{ id: "docs", available: true, version: "1.4.0" }],
  );
  assert.equal(wrongVersion.refusals.length, 1);
  assert.match(wrongVersion.refusals[0], /answered version 1\.4\.0/u);

  const wrongDigest = preflightResourceDependencies(
    [dependency({ configurationDigest: "abc" })],
    [{ id: "docs", available: true, configurationDigest: "def" }],
  );
  assert.equal(wrongDigest.refusals.length, 1);
  assert.match(wrongDigest.refusals[0], /different configuration/u);
});

test("a required dependency whose declared fingerprint cannot be confirmed refuses", () => {
  const unverified = preflightResourceDependencies(
    [dependency({ version: "2.0.0" })],
    [{ id: "docs", available: true }],
  );
  assert.equal(
    unverified.refusals.length,
    1,
    "a required exact version that could not be confirmed was allowed to run",
  );
  assert.match(unverified.refusals[0], /cannot be confirmed/u);
  assert.equal(unverified.statuses[0].available, true);
  assert.equal(
    unverified.statuses[0].reproducible,
    false,
    "a resource whose declared version could not be confirmed was called reproducible",
  );

  // An optional dependency reports the same gap without refusing.
  const optional = preflightResourceDependencies(
    [dependency({ version: "2.0.0", required: false })],
    [{ id: "docs", available: true }],
  );
  assert.deepEqual(optional.refusals, []);
  assert.equal(optional.statuses[0].reproducible, false);

  const confirmed = preflightResourceDependencies(
    [dependency({ version: "2.0.0", configurationDigest: "abc" })],
    [{ id: "docs", available: true, version: "2.0.0", configurationDigest: "abc" }],
  );
  assert.equal(confirmed.statuses[0].reproducible, true);
});

test("execution provenance records what actually answered", () => {
  const preflight = preflightResourceDependencies(
    [dependency({ version: "2.0.0" })],
    [{ id: "docs", available: true, version: "2.0.0" }],
  );
  assert.deepEqual(resourceDependencyProvenance(preflight.statuses), [{
    id: "docs",
    kind: "mcpServer",
    name: "docs-server",
    reproducible: true,
    version: "2.0.0",
  }]);
});

test("a dependency is bound to the roles that may use it", () => {
  assert.equal(roleMayUseDependency(dependency(), "worker"), true);
  assert.equal(roleMayUseDependency(dependency({ allowedRoles: ["lead"] }), "worker"), false);
  assert.equal(roleMayUseDependency(dependency({ allowedRoles: ["lead"] }), "lead"), true);
});

test("a pipeline that declares no dependencies refuses nothing", () => {
  assert.deepEqual(preflightResourceDependencies([], []), { statuses: [], refusals: [] });
});
