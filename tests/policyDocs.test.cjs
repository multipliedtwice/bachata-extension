const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const load = () => import(`file://${path.join(root, "scripts", "lib", "policyDocs.mjs")}`);

const {
  CONTROLLER_VERIFICATION_COMMANDS,
} = require("../dist/orchestrator/verificationPolicy.js");
const {
  VERIFIER_COMMAND_PREFIX,
  VERIFIER_REGISTRY_PATH,
} = require("../dist/orchestrator/verifierRegistry.js");

const documents = ["README.md", "docs/PIPELINES.md", "docs/ORCHESTRATION.md", "docs/VERIFIERS.md"];

test("policy prose is generated from the same constants execution uses", async () => {
  const { policyBlocks } = await load();
  const blocks = policyBlocks({
    controllerCommands: [...CONTROLLER_VERIFICATION_COMMANDS],
    verifierCommandPrefix: VERIFIER_COMMAND_PREFIX,
    verifierRegistryPath: VERIFIER_REGISTRY_PATH,
  });
  for (const command of CONTROLLER_VERIFICATION_COMMANDS) {
    assert.ok(blocks["verification-policy"].includes(command));
    assert.ok(blocks["verification-operations"].includes(command));
  }
  assert.ok(blocks["verification-policy"].includes(`${VERIFIER_COMMAND_PREFIX}<id>`));
  assert.ok(blocks["verification-policy"].includes(VERIFIER_REGISTRY_PATH));
});

test("every policy document carries the generated regions and no stale claim", () => {
  for (const relative of documents) {
    const document = fs.readFileSync(path.join(root, relative), "utf8");
    assert.ok(
      document.includes("<!-- generated:verification-policy -->"),
      `${relative} has no generated verification-policy region`,
    );
    assert.ok(
      document.includes(`${VERIFIER_COMMAND_PREFIX}<id>`),
      `${relative} does not mention repository verifiers`,
    );
    assert.doesNotMatch(
      document,
      /accepts only the controller-owned verification operations/u,
      `${relative} still claims only two verification operations are accepted`,
    );
  }
});

test("regeneration is idempotent and drift is detectable", async () => {
  const { policyBlocks, renderGeneratedRegions } = await load();
  const blocks = policyBlocks({
    controllerCommands: [...CONTROLLER_VERIFICATION_COMMANDS],
    verifierCommandPrefix: VERIFIER_COMMAND_PREFIX,
    verifierRegistryPath: VERIFIER_REGISTRY_PATH,
  });
  for (const relative of documents) {
    const document = fs.readFileSync(path.join(root, relative), "utf8");
    assert.equal(renderGeneratedRegions(document, blocks), document, `${relative} is out of date`);
  }
  const drifted = "<!-- generated:verification-policy -->\nstale\n<!-- /generated:verification-policy -->";
  assert.notEqual(renderGeneratedRegions(drifted, blocks), drifted);
});

test("the policy documentation gate runs in the test suite", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts.test, /check:policy-docs/u);
});
