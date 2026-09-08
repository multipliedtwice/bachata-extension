const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  loadRepositoryPolicy,
  narrowLocalCommitMode,
  narrowLocalWriteScope,
  parseRepositoryPolicy,
  repositoryPolicyRefusals,
  REPOSITORY_POLICY_PATH,
} = require("../dist/policy/repositoryPolicy.js");
const { buildExecutionContract } = require("../dist/contract/executionContract.js");

const policy = (overrides = {}) => parseRepositoryPolicy({
  version: 1,
  approvedPipelineIds: ["managed-fix", "codex-review"],
  maxWriteScope: "configured",
  commitMode: "never",
  allowedVerifiers: ["bachata:project-checks", "bachata:workspace-integrity"],
  protectedPaths: [".git"],
  requireHumanGate: true,
  ...overrides,
}).policy;

const subject = (overrides = {}) => ({
  pipelineId: "managed-fix",
  writeScope: "configured",
  commitPolicy: "never",
  verification: ["bachata:project-checks"],
  protectedPaths: [".git"],
  humanGateCount: 1,
  ...overrides,
});

test("the repository policy is validated strictly", () => {
  assert.deepEqual(parseRepositoryPolicy({ version: 1 }).errors, []);
  assert.ok(parseRepositoryPolicy({ version: 2 }).errors.length > 0);
  assert.ok(parseRepositoryPolicy({ version: 1, unknown: true }).errors.some((error) =>
    error.includes("unknown key: unknown")));
  assert.ok(parseRepositoryPolicy({ version: 1, maxWriteScope: "everything" }).errors.length > 0);
  assert.ok(parseRepositoryPolicy({ version: 1, commitMode: "sometimes" }).errors.length > 0);
  assert.ok(parseRepositoryPolicy({ version: 1, approvedPipelineIds: [""] }).errors.length > 0);
  assert.ok(parseRepositoryPolicy({ version: 1, requireHumanGate: "yes" }).errors.length > 0);
  assert.ok(parseRepositoryPolicy("not an object").errors.length > 0);
});

test("a compliant run is not refused", () => {
  assert.deepEqual(repositoryPolicyRefusals(policy(), subject()), []);
  assert.deepEqual(repositoryPolicyRefusals(undefined, subject()), []);
});

test("every policy dimension refuses independently and names the file", () => {
  const cases = [
    [subject({ pipelineId: "debug" }), /is not approved for this repository/u],
    [subject({ writeScope: "workspace" }), /caps the write scope at configured/u],
    [subject({ commitPolicy: "allow" }), /forbids commits/u],
    [subject({ verification: ["bachata:verifier:custom"] }), /does not allow the verification operation/u],
    [subject({ protectedPaths: [] }), /protects \.git/u],
    [subject({ humanGateCount: 0 }), /requires at least one human gate/u],
  ];
  for (const [candidate, pattern] of cases) {
    const refusals = repositoryPolicyRefusals(policy(), candidate);
    assert.equal(refusals.length, 1, JSON.stringify(candidate));
    assert.match(refusals[0], pattern);
    assert.ok(refusals[0].includes(REPOSITORY_POLICY_PATH));
  }
});

test("local settings only narrow repository policy, never widen it", () => {
  assert.equal(narrowLocalWriteScope(policy(), "workspace"), "configured");
  assert.equal(narrowLocalWriteScope(policy(), "task"), "task");
  assert.equal(narrowLocalWriteScope(undefined, "workspace"), "workspace");
  assert.equal(narrowLocalCommitMode(policy(), "allow"), "never");
  assert.equal(narrowLocalCommitMode(policy({ commitMode: "allow" }), "never"), "never");
  assert.equal(narrowLocalCommitMode(undefined, "allow"), "allow");
});

test("an unreadable or invalid policy file is reported, never ignored", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-policy-"));
  try {
    assert.deepEqual(await loadRepositoryPolicy(root), { present: false, errors: [] });
    await fs.mkdir(path.join(root, ".bachata"), { recursive: true });
    await fs.writeFile(path.join(root, REPOSITORY_POLICY_PATH), "{ broken", "utf8");
    const broken = await loadRepositoryPolicy(root);
    assert.equal(broken.present, true);
    assert.equal(broken.policy, undefined);
    assert.match(broken.errors[0], /not valid JSON/u);
    await fs.writeFile(path.join(root, REPOSITORY_POLICY_PATH), JSON.stringify({ version: 1, maxWriteScope: "task" }), "utf8");
    const loaded = await loadRepositoryPolicy(root);
    assert.deepEqual(loaded.policy, { version: 1, maxWriteScope: "task" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the execution contract carries policy refusals as blockers", () => {
  const pipeline = {
    version: 1,
    id: "debug",
    name: "Debug",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
    steps: [{
      id: "fix", name: "Fix", enabled: true, humanGate: "none", type: "agent",
      participants: ["codex"], promptTemplate: "x", parallel: false, consensus: false,
    }],
  };
  const contract = buildExecutionContract({
    pipeline,
    maxIterations: 10,
    repositoryPolicy: policy(),
    repositoryPolicyErrors: [`${REPOSITORY_POLICY_PATH}: stale note`],
  });
  assert.ok(contract.policyRefusals.includes(`${REPOSITORY_POLICY_PATH}: stale note`));
  assert.ok(contract.policyRefusals.some((refusal) => refusal.includes("is not approved")));
  assert.ok(contract.policyRefusals.some((refusal) => refusal.includes("caps the write scope")));
  assert.ok(contract.policyRefusals.some((refusal) => refusal.includes("requires at least one human gate")));
  contract.policyRefusals.forEach((refusal) => assert.ok(contract.blockers.includes(refusal)));

  const unpoliced = buildExecutionContract({ pipeline, maxIterations: 10 });
  assert.deepEqual(unpoliced.policyRefusals, []);
});
