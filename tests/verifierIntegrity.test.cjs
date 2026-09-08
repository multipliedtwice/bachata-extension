const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseVerifierRegistry,
  verifierCommand,
  verifierOutcome,
  VERIFIER_REGISTRY_PATH,
} = require("../dist/orchestrator/verifierRegistry.js");
const {
  repositoryVerifierApprovalDetail,
  repositoryVerifiersApproved,
  verifierRegistryDigest,
  withoutRepositoryVerifierApproval,
  withRepositoryVerifierApproval,
} = require("../dist/orchestrator/verifierApproval.js");
const { runVerificationChecks } = require("../dist/orchestrator/commandRunner.js");
const { createWorktreeManager } = require("../dist/orchestrator/worktreeManager.js");
const { createRepository, gitWorktreeSkip } = require("./support/orchestration.cjs");
const { removeScratch, scratchRoot } = require("./support/scratch.cjs");

const descriptor = (overrides = {}) => ({
  id: "suite",
  description: "The repository's own suite",
  executable: "npx",
  args: ["tsc", "--noEmit"],
  workingDirectory: ".",
  environmentAllowlist: ["CI"],
  timeoutMs: 60000,
  maxOutputBytes: 65536,
  expect: { exitCode: 0 },
  ...overrides,
});

const registryOf = (...verifiers) => ({ version: 1, verifiers });

const parsed = (value) => {
  const result = parseVerifierRegistry(value);
  assert.deepEqual(result.errors, []);
  return result.registry;
};

const digestOf = (...verifiers) => verifierRegistryDigest(parsed(registryOf(...verifiers)));

const writeRegistry = async (root, ...verifiers) => {
  await fs.mkdir(path.join(root, ".bachata"), { recursive: true });
  await fs.writeFile(
    path.join(root, VERIFIER_REGISTRY_PATH),
    JSON.stringify(registryOf(...verifiers)),
    "utf8",
  );
};

const checkOptions = (root, overrides = {}) => ({
  cwd: root,
  timeoutMs: 30_000,
  maxOutputBytes: 65_536,
  autonomous: true,
  ...overrides,
});

// A runner that exits 0 and reports its failures in text is the shape `stdoutExcludes` exists
// for. The bound keeps the head of stdout and drops the tail, so the marker that decides the
// verdict is exactly what a long run loses.
test("a truncated stream cannot satisfy an expectation that reads stdout", () => {
  const excludes = descriptor({ expect: { exitCode: 0, stdoutExcludes: "FAILED" } });
  assert.deepEqual(verifierOutcome(excludes, { exitCode: 0, stdout: "all good" }), { passed: true });
  assert.equal(
    verifierOutcome(excludes, { exitCode: 0, stdout: "all good", stdoutTruncated: true }).passed,
    false,
    "a dropped tail was read as the absence of the marker it may have carried",
  );
  assert.match(
    verifierOutcome(excludes, { exitCode: 0, stdout: "all good", stdoutTruncated: true }).reason,
    /could not be ruled out/u,
  );
  assert.match(
    verifierOutcome(excludes, { exitCode: 0, stdout: "FAILED", stdoutTruncated: true }).reason,
    /output contained "FAILED"/u,
  );

  const includes = descriptor({ expect: { exitCode: 0, stdoutIncludes: "READY" } });
  assert.deepEqual(
    verifierOutcome(includes, { exitCode: 0, stdout: "READY", stdoutTruncated: true }),
    { passed: true },
    "a marker found in the retained head was seen, so it decides",
  );
  assert.match(
    verifierOutcome(includes, { exitCode: 0, stdout: "nothing", stdoutTruncated: true }).reason,
    /could not be looked for/u,
  );
  assert.match(
    verifierOutcome(includes, { exitCode: 0, stdout: "nothing" }).reason,
    /did not contain "READY"/u,
  );

  // An exit-code expectation reads nothing the bound could have dropped.
  assert.deepEqual(
    verifierOutcome(descriptor(), { exitCode: 0, stdout: "x", stdoutTruncated: true }),
    { passed: true },
  );
});

test("a verifier whose failure marker overflows the bound is not recorded as passed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-verifier-truncation-"));
  try {
    await writeRegistry(
      root,
      descriptor({
        id: "loud-suite",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('.'.repeat(4000) + 'FAILED')"],
        maxOutputBytes: 1024,
        expect: { exitCode: 0, stdoutExcludes: "FAILED" },
      }),
      descriptor({
        id: "quiet-suite",
        executable: process.execPath,
        args: ["-e", "process.stdout.write('all good')"],
        maxOutputBytes: 1024,
        expect: { exitCode: 0, stdoutExcludes: "FAILED" },
      }),
    );
    const options = checkOptions(root, { repositoryVerifiers: "humanApproved" });

    const [truncated] = await runVerificationChecks([verifierCommand("loud-suite")], options);
    assert.equal(
      truncated.status,
      "failed",
      "a failure marker the bound dropped was reported as a pass",
    );
    assert.match(truncated.stderr, /could not be ruled out/u);

    const [quiet] = await runVerificationChecks([verifierCommand("quiet-suite")], options);
    assert.equal(quiet.status, "passed", quiet.stderr);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// `bachata.todoCheckMaxOutputBytes` is a user setting, and it bounds these Git enumerations too.
// A changed-file list that does not fit is not a changed-file list.
test("workspace integrity fails when the changed-file list is truncated", async () => {
  const root = await scratchRoot("bachata-integrity-truncation-");
  try {
    const files = Object.fromEntries(
      Array.from({ length: 60 }, (_unused, index) => [
        `src/module-with-a-deliberately-long-name-${String(index).padStart(3, "0")}.ts`,
        "export const value = 1;\n",
      ]),
    );
    const repository = await createRepository(root, undefined, files);
    for (const relative of Object.keys(files)) {
      await fs.writeFile(path.join(repository, relative), "export const value = 2;\n", "utf8");
    }

    const [bounded] = await runVerificationChecks(
      ["bachata:workspace-integrity"],
      checkOptions(repository, { maxOutputBytes: 1024 }),
    );
    assert.equal(
      bounded.status,
      "failed",
      "files the bound dropped were certified as clean without being read",
    );
    assert.match(bounded.stderr, /exceeded 1024 bytes/u);

    const [complete] = await runVerificationChecks(
      ["bachata:workspace-integrity"],
      checkOptions(repository),
    );
    assert.equal(complete.status, "passed", complete.stderr);
    assert.match(complete.stdout, /passed for 60 changed file\(s\)/u);
  } finally {
    await removeScratch(root);
  }
});

test("an approval names the descriptor set it approved, not only the repository", () => {
  const typecheck = descriptor({ id: "typecheck" });
  const lint = descriptor({ id: "lint", args: ["eslint", "."] });
  const approved = digestOf(typecheck, lint);

  // Cosmetic edits are not a different set of checks: key order, descriptor order, a reworded
  // description and a default written out all describe the same executions.
  assert.equal(digestOf(lint, typecheck), approved);
  assert.equal(
    digestOf(
      { ...typecheck, description: "Types, checked", workingDirectory: undefined },
      { expect: { exitCode: 0 }, args: ["eslint", "."], ...lint },
    ),
    approved,
  );

  // What runs is not.
  assert.notEqual(digestOf(typecheck), approved);
  assert.notEqual(digestOf({ ...typecheck, executable: "node" }, lint), approved);
  assert.notEqual(digestOf({ ...typecheck, args: ["scripts/publish.js"] }, lint), approved);
  assert.notEqual(digestOf({ ...typecheck, workingDirectory: "tools" }, lint), approved);
  assert.notEqual(
    digestOf({ ...typecheck, expect: { exitCode: 0, stdoutExcludes: "FAIL" } }, lint),
    approved,
  );

  const stored = withRepositoryVerifierApproval(undefined, "/work", approved);
  assert.equal(repositoryVerifiersApproved(stored, "/work", approved), true);
  assert.equal(
    repositoryVerifiersApproved(stored, "/work", digestOf(typecheck)),
    false,
    "a registry rewritten after the approval was honoured by the approval",
  );
  assert.equal(repositoryVerifiersApproved(stored, "/work"), true);
  assert.equal(repositoryVerifiersApproved(stored, "/other", approved), false);
  assert.equal(withoutRepositoryVerifierApproval(stored, "/work"), undefined);

  // An approval recorded before the binding existed names no descriptor set, so it answers for
  // none: the person is asked again, which is the fail-safe direction.
  const unbound = withRepositoryVerifierApproval(undefined, "/work");
  assert.equal(repositoryVerifiersApproved(unbound, "/work", approved), false);
  assert.equal(repositoryVerifiersApproved(unbound, "/work"), true);
  assert.equal(repositoryVerifiersApproved({ "/work": "not a digest" }, "/work"), false);
});

test("a registry that changed after the approval runs nothing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-verifier-binding-"));
  const marker = path.join(root, "rewritten-descriptor-ran");
  try {
    const declared = descriptor({
      id: "suite",
      executable: process.execPath,
      args: ["-e", "process.stdout.write('READY')"],
      expect: { exitCode: 0, stdoutIncludes: "READY" },
    });
    await writeRegistry(root, declared);
    const approved = digestOf(declared);

    const [passed] = await runVerificationChecks(
      [verifierCommand("suite")],
      checkOptions(root, {
        repositoryVerifiers: "humanApproved",
        approvedVerifierRegistryDigest: approved,
      }),
    );
    assert.equal(passed.status, "passed", passed.stderr);

    // The registry is read at execution time from the run's own worktree, so this is what a
    // teammate's commit, a checkout or a merge does to the set the person approved.
    await writeRegistry(
      root,
      descriptor({
        ...declared,
        args: ["-e", `require('node:fs').writeFileSync('${marker}', 'ran')`],
        expect: { exitCode: 0 },
      }),
    );
    const [refused] = await runVerificationChecks(
      [verifierCommand("suite")],
      checkOptions(root, {
        repositoryVerifiers: "humanApproved",
        approvedVerifierRegistryDigest: approved,
      }),
    );
    assert.equal(refused.status, "failed");
    assert.match(refused.stderr, /different set of checks from the one that was approved/u);
    assert.equal(
      existsSync(marker),
      false,
      "a descriptor nobody approved was started unattended",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("the approval prompt names the executable, not only the descriptor id", () => {
  const declared = parsed(registryOf(
    descriptor({ id: "typecheck" }),
    descriptor({ id: "publish", executable: "node", args: ["scripts/publish.js"], workingDirectory: "tools" }),
  )).verifiers;
  const detail = repositoryVerifierApprovalDetail({
    workspaceRoot: "/work",
    commands: declared.map((entry) => verifierCommand(entry.id)),
    descriptors: declared,
  });
  assert.match(detail, /- bachata:verifier:typecheck: npx tsc --noEmit/u);
  assert.match(detail, /- bachata:verifier:publish: node scripts\/publish\.js \(in tools\)/u);
});

// The links are the deliberate trade-off that lets a fresh worktree run checks at all. What must
// not stay silent is that they leave the worktree: the run reports them so its record can name
// what its isolation does not cover.
test("a task worktree reports the dependency directories it shares with the repository", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-shared-dependencies-");
  try {
    const repository = await createRepository(root, undefined, {
      ".gitignore": "node_modules\n",
      "package.json": JSON.stringify({ name: "dependency-fixture" }),
    });
    await fs.mkdir(path.join(repository, "node_modules", ".bin"), { recursive: true });
    await fs.writeFile(path.join(repository, "node_modules", ".bin", "check"), "fixture\n", "utf8");

    const manager = createWorktreeManager(path.join(root, "storage"));
    const run = await manager.prepareRun(repository, "run-shared-dependencies");
    const task = await manager.prepareTask(run, "TASK_SHARED");
    assert.deepEqual(task.sharedDependencies, ["node_modules"]);

    const escaped = path.join(task.worktreePath, "node_modules", ".bin", "written-by-the-run");
    await fs.writeFile(escaped, "written\n", "utf8");
    assert.equal(
      existsSync(path.join(repository, "node_modules", ".bin", "written-by-the-run")),
      true,
      "the fixture no longer reproduces a write that leaves the worktree",
    );
    assert.equal(
      (await manager.changedFiles(task)).includes("node_modules/.bin/written-by-the-run"),
      false,
      "the run's change detection cannot name a write that left the worktree",
    );

    const validation = await manager.prepareValidation(run, task.worktreePath, "shared-check");
    assert.deepEqual(validation.sharedDependencies, ["node_modules"]);

    await manager.removeValidation(run, validation);
    await manager.removeTask(run, task);
    await manager.abandonRun(run);
    assert.equal(
      existsSync(path.join(repository, "node_modules", ".bin", "written-by-the-run")),
      true,
      "abandoning the run removed worktrees, not the bytes a link wrote outside them",
    );
  } finally {
    await removeScratch(root);
  }
});
