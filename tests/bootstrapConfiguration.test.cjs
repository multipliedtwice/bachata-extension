const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  discoverVerifiers,
  verifierRegistryDocument,
} = require("../dist/bootstrap/discoverVerifiers.js");
const { policyDocument, policyTemplates } = require("../dist/bootstrap/policyTemplates.js");
const { parseVerifierRegistry, verifierCommand } = require("../dist/orchestrator/verifierRegistry.js");
const { parseRepositoryPolicy } = require("../dist/policy/repositoryPolicy.js");

const withRepository = async (files, body) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-bootstrap-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }
    return await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("bootstrap proposes only checks the repository already declares", async () => {
  await withRepository({
    "package.json": JSON.stringify({
      name: "example",
      scripts: {
        test: "node --test tests",
        lint: "eslint .",
        "check-types": "tsc --noEmit",
        start: "node server.js",
        deploy: "./deploy.sh",
      },
    }),
  }, async (root) => {
    const discovery = await discoverVerifiers(root);
    assert.deepEqual(
      discovery.proposals.map((proposal) => proposal.descriptor.id).sort(),
      ["npm-check-types", "npm-lint", "npm-test"],
    );
    const unit = discovery.proposals.find((proposal) => proposal.descriptor.id === "npm-test");
    assert.equal(unit.descriptor.executable, "npm");
    assert.deepEqual(unit.descriptor.args, ["test"]);
    assert.equal(unit.confidence, "declared");
    const lint = discovery.proposals.find((proposal) => proposal.descriptor.id === "npm-lint");
    assert.deepEqual(lint.descriptor.args, ["run", "lint"]);
  });
});

const humanOnlyScriptName = ["test", ["e", "2", "e"].join("")].join(":");
const humanOnlyScriptBody = `${["cy", "press"].join("")} run`;

test("bootstrap never proposes a human-only browser acceptance script", async () => {
  await withRepository({
    "package.json": JSON.stringify({
      name: "example",
      scripts: {
        [humanOnlyScriptName]: humanOnlyScriptBody,
        test: "node --test tests",
      },
    }),
  }, async (root) => {
    const discovery = await discoverVerifiers(root);
    assert.deepEqual(discovery.proposals.map((proposal) => proposal.descriptor.id), ["npm-test"]);
    assert.equal(
      discovery.skipped.some((reason) =>
        reason.includes(humanOnlyScriptName) && reason.includes("human-only")),
      true,
      `the human-only script was not reported as skipped: ${discovery.skipped.join("; ")}`,
    );
  });
});

test("bootstrap proposes conventional checks for non-JavaScript projects", async () => {
  await withRepository({ "Cargo.toml": "[package]\nname = \"example\"\n" }, async (root) => {
    const discovery = await discoverVerifiers(root);
    assert.deepEqual(
      discovery.proposals.map((proposal) => proposal.descriptor.id).sort(),
      ["cargo-clippy", "cargo-test"],
    );
    discovery.proposals.forEach((proposal) => {
      assert.equal(proposal.confidence, "conventional");
    });
  });
});

test("every proposed registry validates against the descriptor rules", async () => {
  await withRepository({
    "package.json": JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
    "go.mod": "module example\n",
    "pyproject.toml": "[tool.ruff]\n",
  }, async (root) => {
    const discovery = await discoverVerifiers(root);
    const document = verifierRegistryDocument(discovery.proposals.map((proposal) => proposal.descriptor));
    const parsed = parseVerifierRegistry(JSON.parse(document));
    assert.deepEqual(parsed.errors, [], "the bootstrap proposed a registry Bachata itself refuses");
    assert.equal(parsed.registry.verifiers.length, discovery.proposals.length);
    parsed.registry.verifiers.forEach((descriptor) => {
      assert.equal(["", "."].includes(descriptor.workingDirectory), true);
      assert.equal(descriptor.expect.exitCode, 0);
    });
  });
});

test("every policy template narrows authority and validates", () => {
  assert.ok(policyTemplates.length >= 3);
  policyTemplates.forEach((template) => {
    const policy = template.policy([verifierCommand("npm-test")]);
    const parsed = parseRepositoryPolicy(JSON.parse(policyDocument(policy)));
    assert.deepEqual(parsed.errors, [], `${template.id} produced an invalid policy`);
    assert.equal(parsed.policy.commitMode, "never", `${template.id} allows commits`);
    assert.notEqual(parsed.policy.maxWriteScope, "workspace", `${template.id} does not narrow write scope`);
    if (parsed.policy.allowedVerifiers) {
      assert.equal(
        parsed.policy.allowedVerifiers.includes("bachata:verifier:npm-test"),
        true,
        `${template.id} dropped the verifier it was given`,
      );
    }
  });
});

test("the read-only template approves no writing pipeline", () => {
  const template = policyTemplates.find((candidate) => candidate.id === "read-only");
  const policy = template.policy([]);
  assert.equal(policy.maxWriteScope, "readOnly");
  assert.equal(policy.approvedPipelineIds.includes("managed-fix"), false);
  assert.equal(policy.approvedPipelineIds.includes("paired-managed-fix"), false);
});

test("the isolated template approves only workflows that keep work outside the branch", () => {
  const template = policyTemplates.find((candidate) => candidate.id === "isolated-changes");
  const policy = template.policy([]);
  assert.equal(policy.maxWriteScope, "task");
  assert.equal(policy.approvedPipelineIds.includes("paired-managed-fix"), true);
  assert.equal(policy.approvedPipelineIds.includes("managed-fix"), false);
  assert.equal(policy.approvedPipelineIds.includes("debug"), false);
});

const builtInPipelines = () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const presets = path.join(__dirname, "..", "presets");
  return fs.readdirSync(presets)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(fs.readFileSync(path.join(presets, name), "utf8")));
};

test("a template that names its approved pipelines refuses none of them", () => {
  const { policyTemplateRefusals } = require("../dist/bootstrap/policyTemplates.js");
  const pipelines = builtInPipelines();
  policyTemplates
    .filter((template) => template.policy([]).approvedPipelineIds !== undefined)
    .forEach((template) => {
      const policy = template.policy([verifierCommand("npm-test")]);
      const refused = policyTemplateRefusals(policy, pipelines);
      assert.deepEqual(
        refused.map((entry) => `${entry.pipelineId}: ${entry.reasons.join("; ")}`),
        [],
        `${template.id} approves pipelines its own rules then refuse`,
      );
      policy.approvedPipelineIds.forEach((pipelineId) => {
        assert.equal(
          pipelines.some((pipeline) => pipeline.id === pipelineId),
          true,
          `${template.id} approves ${pipelineId}, which is not a built-in pipeline`,
        );
      });
    });
});

test("the verified-changes template refuses exactly the pipelines that write outside a declared scope", () => {
  const { policyTemplateRefusals } = require("../dist/bootstrap/policyTemplates.js");
  const template = policyTemplates.find((candidate) => candidate.id === "verified-changes");
  const refused = policyTemplateRefusals(template.policy([]), builtInPipelines());
  assert.ok(refused.length > 0, "the profile constrains nothing");
  refused.forEach((entry) => {
    assert.match(
      entry.reasons.join("; "),
      /caps the write scope/u,
      `${entry.pipelineId} was refused for a reason the profile does not advertise: ${entry.reasons.join("; ")}`,
    );
  });
});
