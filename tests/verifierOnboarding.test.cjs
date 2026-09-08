const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const { repositoryVerifierFinding } = require("../dist/commands/doctorReport.js");
const { remediationPlan } = require("../dist/readiness/remediation.js");

test("a repository with a declared suite and no approved verifier is reported, never blocked", () => {
  const finding = repositoryVerifierFinding({
    registryPresent: false,
    proposalCount: 3,
    declaredVerifierIds: [],
  });
  assert.equal(finding.blocking, false, "heuristic discovery must never block a run");
  assert.equal(finding.ok, false);
  assert.match(finding.detail, /no repository test suite runs/u);
  assert.match(finding.detail, /integrity, syntax and types/u);
  assert.equal(finding.remediationId, "verifier.bootstrap");
});

test("an approved verifier is named rather than summarised", () => {
  const finding = repositoryVerifierFinding({
    registryPresent: true,
    proposalCount: 2,
    declaredVerifierIds: ["npm-test", "npm-lint"],
  });
  assert.equal(finding.ok, true);
  assert.equal(finding.blocking, false);
  assert.match(finding.detail, /npm-test, npm-lint/u);
  assert.equal(finding.remediationId, undefined);
});

test("a repository with nothing to propose says so without implying tests ran", () => {
  const finding = repositoryVerifierFinding({
    registryPresent: false,
    proposalCount: 0,
    declaredVerifierIds: [],
  });
  assert.equal(finding.ok, true);
  assert.equal(finding.blocking, false);
  assert.doesNotMatch(finding.detail, /\bverified\b/u);
});

test("the remediation offers the existing preview-and-confirm bootstrap", () => {
  const plan = remediationPlan("verifier.bootstrap", {});
  assert.match(plan.title, /No repository check is approved/u);
  const commands = plan.actions
    .filter((action) => action.kind === "runCommand")
    .map((action) => action.command);
  assert.ok(commands.includes("bachata.bootstrapConfiguration"));
  assert.ok(commands.includes("bachata.verifiers"));
  assert.match(plan.steps.join(" "), /writes nothing until you confirm/u);
  assert.match(plan.steps.join(" "), /never proposed/u);
});

test("Setup and Doctor reach the bootstrap, and neither writes the registry itself", () => {
  const commands = read("src/commands/registerCommands.ts");
  assert.match(commands, /bachata\.bootstrapConfiguration/u);
  assert.doesNotMatch(
    commands,
    /verifierRegistryDocument|writeFile\([^)]*verifiers\.json/u,
    "only the bootstrap command may write .bachata/verifiers.json",
  );
  assert.match(commands, /No repository test suite runs until you approve a verifier/u);
});

test("a recorded approval can actually be removed, and the prompt says how", async () => {
  const source = read("src/policy/registerConfigurationAuthoring.ts");
  const {
    REPOSITORY_VERIFIER_APPROVAL_KEY,
    repositoryVerifierApprovalDetail,
  } = require("../dist/orchestrator/verifierApproval.js");

  // The approval prompt must name a removal route that exists.
  const detail = repositoryVerifierApprovalDetail({
    workspaceRoot: "/work",
    commands: ["bachata:verifier:unit-tests"],
  });
  assert.match(detail, /Bachata: Repository Verifiers/u);
  assert.match(detail, /Remove this workspace's approval/u);
  assert.match(detail, /not proof/u);
  assert.match(source, /Remove this workspace's approval/u);
  assert.match(source, /approval\?\.remove\(\)/u);
  assert.match(source, /approval\?\.isRecorded\(\) === true/u);

  // And the extension must supply a control that clears the very approval the run authority
  // reads. EX-G6-08: that approval names a repository, so both halves name the same one.
  const extension = read("src/extension.ts");
  assert.match(extension, /isRecorded: \(\) => \{[\s\S]{0,300}repositoryVerifiersApproved\([\s\S]{0,200}path\.resolve\(workspaceRoot\(\)\)/u);
  assert.match(
    extension,
    /remove: async \(\) => \{[\s\S]{0,400}withoutRepositoryVerifierApproval\([\s\S]{0,200}path\.resolve\(workspaceRoot\(\)\)/u,
  );
  assert.match(
    extension,
    /approvedRepositoryVerifiers: \(repositoryRoot\) =>[\s\S]{0,240}repositoryVerifiersApproved\(/u,
    "the run authority no longer reads the same approval the control removes",
  );
  assert.equal(typeof REPOSITORY_VERIFIER_APPROVAL_KEY, "string");
});

// EX-G6-08. One window can hold more than one repository. The approval a person gave for the
// executables one of them declares says nothing about the executables another one declares, and
// the stored value used to be a single boolean with no repository in it at all.
test("repository verifier approval is recorded per repository", () => {
  const {
    approvedRepositoryRoots,
    repositoryVerifiersApproved,
    withRepositoryVerifierApproval,
    withoutRepositoryVerifierApproval,
  } = require("../dist/orchestrator/verifierApproval.js");

  const first = withRepositoryVerifierApproval(undefined, "/work/first");
  assert.equal(repositoryVerifiersApproved(first, "/work/first"), true);
  assert.equal(
    repositoryVerifiersApproved(first, "/work/second"),
    false,
    "approving one repository approved another",
  );

  const both = withRepositoryVerifierApproval(first, "/work/second");
  assert.deepEqual(approvedRepositoryRoots(both), ["/work/first", "/work/second"]);
  assert.deepEqual(withoutRepositoryVerifierApproval(both, "/work/first"), { "/work/second": true });
  assert.equal(
    withoutRepositoryVerifierApproval(first, "/work/first"),
    undefined,
    "removing the last approval left an empty record behind",
  );

  // The older shape named no repository, so it cannot be honoured for one: it reads as no
  // approval and the person is asked again, which is the fail-safe direction.
  for (const stored of [true, false, null, "yes", ["/work/first"], { "/work/first": "yes" }]) {
    assert.equal(
      repositoryVerifiersApproved(stored, "/work/first"),
      false,
      JSON.stringify(stored ?? null),
    );
  }
});
