const assert = require("node:assert/strict");
const test = require("node:test");

const {
  configurationDiagnostics,
  declaredVerifiers,
  diagnosticLine,
  bachataConfigurationFile,
  BACHATA_CONFIGURATION_FILES,
  VERIFIER_REGISTRY_TEMPLATE,
} = require("../dist/policy/configurationDiagnostics.js");
const { parseVerifierRegistry } = require("../dist/orchestrator/verifierRegistry.js");

test("only Bachata configuration files are recognised", () => {
  assert.equal(bachataConfigurationFile("/repo/.bachata/verifiers.json"), ".bachata/verifiers.json");
  assert.equal(bachataConfigurationFile("/repo/.bachata/policy.json"), ".bachata/policy.json");
  assert.equal(bachataConfigurationFile("/repo/.bachata/export-policy.json"), ".bachata/export-policy.json");
  assert.equal(bachataConfigurationFile("/repo/package.json"), undefined);
  assert.equal(bachataConfigurationFile("/repo/.pairx/policy.json"), undefined);
  assert.equal(BACHATA_CONFIGURATION_FILES.length, 3);
});

test("invalid JSON reports one diagnostic on the first line", () => {
  const diagnostics = configurationDiagnostics(".bachata/policy.json", "{ broken");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].line, 1);
  assert.match(diagnostics[0].message, /not valid JSON/u);
});

test("each parser's errors become diagnostics anchored near the offending key", () => {
  const source = JSON.stringify({ version: 1, maxWriteScope: "everything" }, undefined, 2);
  const diagnostics = configurationDiagnostics(".bachata/policy.json", source);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /maxWriteScope must be/u);
  assert.equal(source.split("\n")[diagnostics[0].line - 1].includes("maxWriteScope"), true);

  assert.deepEqual(configurationDiagnostics(".bachata/policy.json", JSON.stringify({ version: 1 })), []);
  assert.ok(configurationDiagnostics(".bachata/export-policy.json", JSON.stringify({ version: 2 })).length > 0);
  assert.ok(configurationDiagnostics(".bachata/verifiers.json", JSON.stringify({ version: 1 })).length > 0);
});

test("a message naming no known key still anchors to a real line", () => {
  assert.equal(diagnosticLine("{\n}\n", "something went wrong"), 1);
});

test("the shipped verifier template is valid and is discoverable", () => {
  assert.deepEqual(configurationDiagnostics(".bachata/verifiers.json", VERIFIER_REGISTRY_TEMPLATE), []);
  assert.deepEqual(parseVerifierRegistry(JSON.parse(VERIFIER_REGISTRY_TEMPLATE)).errors, []);
  assert.deepEqual(declaredVerifiers(VERIFIER_REGISTRY_TEMPLATE), [{
    id: "unit-tests",
    description: "Node test runner over tests/",
    command: "bachata:verifier:unit-tests",
  }]);
  assert.deepEqual(declaredVerifiers("{ broken"), []);
  assert.deepEqual(declaredVerifiers(JSON.stringify({ version: 1, verifiers: [{ id: "BAD" }] })), []);
});
