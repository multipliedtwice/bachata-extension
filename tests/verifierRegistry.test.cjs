const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  findVerifier,
  parseVerifierRegistry,
  verifierCommand,
  verifierOutcome,
  VERIFIER_REGISTRY_PATH,
} = require("../dist/orchestrator/verifierRegistry.js");
const { loadVerifierRegistry } = require("../dist/orchestrator/verifierRegistryStore.js");
const {
  autonomousVerificationRefusal,
  isControllerVerificationCommand,
  isDeclarableVerificationCommand,
} = require("../dist/orchestrator/verificationPolicy.js");
const { isRestrictedWorkspacePath } = require("../dist/browser/mutationPolicy.js");
const { runVerificationChecks } = require("../dist/orchestrator/commandRunner.js");

const descriptor = (overrides = {}) => ({
  id: "unit-tests",
  description: "Node test runner",
  executable: "node",
  args: ["--version"],
  workingDirectory: ".",
  environmentAllowlist: ["CI"],
  timeoutMs: 60000,
  maxOutputBytes: 65536,
  expect: { exitCode: 0 },
  ...overrides,
});

const registryOf = (...verifiers) => ({ version: 1, verifiers });

test("a valid registry parses into fixed descriptors", () => {
  const parsed = parseVerifierRegistry(registryOf(descriptor()));
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.registry.verifiers.length, 1);
  assert.equal(findVerifier(parsed.registry, "bachata:verifier:unit-tests").executable, "node");
  assert.equal(findVerifier(parsed.registry, "bachata:verifier:missing"), undefined);
});

test("shell wrappers, metacharacters, and traversal are refused", () => {
  const cases = [
    { executable: "bash", args: ["-c", "echo hi"] },
    { executable: "/bin/sh" },
    { executable: "powershell.exe" },
    { executable: "npm; rm -rf /" },
    { executable: "tool$(id)" },
    { executable: "../../bin/evil" },
    { args: ["run", "test && curl http://x"] },
    { workingDirectory: "../outside" },
    { workingDirectory: "/etc" },
    { environmentAllowlist: ["path"] },
    { timeoutMs: 10 },
    { timeoutMs: 7_200_000 },
    { maxOutputBytes: 4 },
    { id: "Bad Id" },
    { expect: { exitCode: 300 } },
    { expect: { unknown: 1 } },
  ];
  cases.forEach((overrides) => {
    const parsed = parseVerifierRegistry(registryOf(descriptor(overrides)));
    assert.equal(parsed.registry, undefined, `accepted ${JSON.stringify(overrides)}`);
    assert.ok(parsed.errors.length > 0);
  });
});

test("unknown keys, duplicate ids, and a wrong version fail the whole file", () => {
  assert.ok(parseVerifierRegistry({ version: 2, verifiers: [] }).errors.length > 0);
  assert.ok(parseVerifierRegistry({ version: 1, verifiers: [], extra: true }).errors.length > 0);
  assert.ok(parseVerifierRegistry(registryOf(descriptor({ shell: true }))).errors.length > 0);
  const duplicate = parseVerifierRegistry(registryOf(descriptor(), descriptor()));
  assert.equal(duplicate.registry, undefined);
  assert.ok(duplicate.errors.some((error) => error.includes("more than once")));
});

test("autonomous verification accepts a declared descriptor and refuses everything else", () => {
  const registry = parseVerifierRegistry(registryOf(descriptor())).registry;
  assert.equal(isControllerVerificationCommand("bachata:workspace-integrity"), true);
  assert.equal(isControllerVerificationCommand("bachata:verifier:unit-tests"), false);
  assert.equal(isControllerVerificationCommand("bachata:verifier:unit-tests", registry), true);
  // Without a workspace approval no descriptor executes at all, whatever the registry says.
  assert.match(
    autonomousVerificationRefusal("bachata:verifier:unit-tests", registry),
    /never starts one unattended/u,
  );
  assert.equal(
    autonomousVerificationRefusal("bachata:verifier:unit-tests", registry, "humanApproved"),
    undefined,
  );
  assert.match(
    autonomousVerificationRefusal("bachata:verifier:other", registry, "humanApproved"),
    /is not declared in \.bachata\/verifiers\.json, or the registry failed validation/u,
  );
  assert.match(autonomousVerificationRefusal("npm test"), /Arbitrary repository commands/u);
  assert.match(
    autonomousVerificationRefusal("npm test", registry, "humanApproved"),
    /Arbitrary repository commands/u,
  );
});

test("declaration syntax is accepted before the registry is read", () => {
  assert.equal(isDeclarableVerificationCommand("bachata:verifier:unit-tests"), true);
  assert.equal(isDeclarableVerificationCommand("bachata:verifier:Bad Id"), false);
  assert.equal(isDeclarableVerificationCommand("npm test"), false);
});

test("expectations decide the outcome, not only the exit code", () => {
  const spec = descriptor({ expect: { exitCode: 0, stdoutIncludes: "ok", stdoutExcludes: "FAIL" } });
  assert.deepEqual(verifierOutcome(spec, { exitCode: 0, stdout: "all ok" }), { passed: true });
  assert.equal(verifierOutcome(spec, { exitCode: 1, stdout: "all ok" }).passed, false);
  assert.equal(verifierOutcome(spec, { exitCode: 0, stdout: "nothing" }).passed, false);
  assert.equal(verifierOutcome(spec, { exitCode: 0, stdout: "ok but FAIL" }).passed, false);
});

test("the registry directory is restricted for managed and autonomous mutation", () => {
  assert.equal(isRestrictedWorkspacePath(VERIFIER_REGISTRY_PATH), true);
  assert.equal(isRestrictedWorkspacePath(".bachata/pipelines/a.json"), true);
  assert.equal(isRestrictedWorkspacePath("src/a.ts"), false);
});

test("a missing or invalid registry blocks the run instead of executing anything", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-verifiers-"));
  try {
    const missing = await loadVerifierRegistry(root);
    assert.deepEqual(missing, { present: false, errors: [] });

    const results = await runVerificationChecks([verifierCommand("unit-tests")], {
      cwd: root,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      autonomous: true,
      repositoryVerifiers: "humanApproved",
    });
    assert.equal(results[0].status, "failed");
    assert.match(results[0].stderr, /does not exist in this repository/u);

    await fs.mkdir(path.join(root, ".bachata"), { recursive: true });
    await fs.writeFile(path.join(root, VERIFIER_REGISTRY_PATH), "{ not json", "utf8");
    const broken = await loadVerifierRegistry(root);
    assert.equal(broken.present, true);
    assert.ok(broken.errors[0].includes("not valid JSON"));

    await fs.writeFile(
      path.join(root, VERIFIER_REGISTRY_PATH),
      JSON.stringify(registryOf(descriptor({ executable: "bash", args: ["-c", "id"] }))),
      "utf8",
    );
    const refused = await runVerificationChecks([verifierCommand("unit-tests")], {
      cwd: root,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      autonomous: true,
      repositoryVerifiers: "humanApproved",
    });
    assert.equal(refused[0].status, "failed");
    assert.match(refused[0].stderr, /shell or process wrapper/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a declared descriptor runs with its own bounds and its expectations decide the result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-verifiers-run-"));
  try {
    await fs.mkdir(path.join(root, ".bachata"), { recursive: true });
    await fs.writeFile(
      path.join(root, VERIFIER_REGISTRY_PATH),
      JSON.stringify(registryOf(
        descriptor({
          id: "version",
          executable: process.execPath,
          args: ["-e", "process.stdout.write('READY')"],
          expect: { exitCode: 0, stdoutIncludes: "READY" },
        }),
        descriptor({
          id: "expects-more",
          executable: process.execPath,
          args: ["-e", "process.stdout.write('READY')"],
          expect: { exitCode: 0, stdoutIncludes: "NEVER" },
        }),
      )),
      "utf8",
    );
    const passed = await runVerificationChecks([verifierCommand("version")], {
      cwd: root,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      autonomous: true,
      repositoryVerifiers: "humanApproved",
    });
    assert.equal(passed[0].status, "passed");
    assert.match(passed[0].stdout, /READY/u);

    const failed = await runVerificationChecks([verifierCommand("expects-more")], {
      cwd: root,
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
      autonomous: true,
      repositoryVerifiers: "humanApproved",
    });
    assert.equal(failed[0].status, "failed");
    assert.match(failed[0].stderr, /did not contain "NEVER"/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an unattended run refuses a declared descriptor before reading the registry", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "bachata-verifier-authority-")));
  await fs.mkdir(path.join(root, ".bachata"), { recursive: true });
  await fs.writeFile(path.join(root, VERIFIER_REGISTRY_PATH), "{ not json", "utf8");
  const refused = await runVerificationChecks([verifierCommand("unit-tests")], {
    cwd: root,
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
    autonomous: true,
  });
  assert.equal(refused[0].status, "failed");
  assert.match(refused[0].stderr, /never starts one unattended/u);
  assert.doesNotMatch(
    refused[0].stderr,
    /not valid JSON/u,
    "the boundary is stated, not a registry defect: the registry is never read",
  );
});

test("built-in controller commands are unaffected by the descriptor refusal", () => {
  assert.equal(autonomousVerificationRefusal("bachata:workspace-integrity"), undefined);
  assert.equal(autonomousVerificationRefusal("bachata:project-checks"), undefined);
  assert.match(autonomousVerificationRefusal("bachata:verifier:anything"), /never starts one unattended/u);
  assert.equal(
    autonomousVerificationRefusal(
      "bachata:verifier:unit-tests",
      parseVerifierRegistry(registryOf(descriptor())).registry,
      "humanApproved",
    ),
    undefined,
  );
});
