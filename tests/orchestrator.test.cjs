const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync, realpathSync, writeFileSync } = require("node:fs");
const { chmod, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const shellNodeExecutable = (process.versions.electron
  ? process.platform === "win32" ? 'set "ELECTRON_RUN_AS_NODE=1" && ' : "ELECTRON_RUN_AS_NODE=1 "
  : "") + (process.platform === "win32" ? `"${process.execPath}"` : JSON.stringify(process.execPath));

const { resolveCommandShell, runCommand, runProcess, runVerificationChecks } = require("../dist/orchestrator/commandRunner.js");
const { selectRunnableTasks, taskPathsConflict } = require("../dist/orchestrator/scheduler.js");
const { createTodoOrchestrator } = require("../dist/orchestrator/controller.js");
const { verifierRegistryDigest } = require("../dist/orchestrator/verifierApproval.js");
const { loadVerifierRegistry } = require("../dist/orchestrator/verifierRegistryStore.js");
const { createOrchestrationStore } = require("../dist/orchestrator/store.js");
const {
  markTodoTaskCompleted,
  normalizeCheckResourceNames,
  parseTodoDocument,
} = require("../dist/orchestrator/todoParser.js");
const { createWorktreeManager, GitCommandError, taskStorageIdentity } = require("../dist/orchestrator/worktreeManager.js");
const { createResourceBroker, ResourceAcquireTimeoutError } = require("../dist/concurrency/resourceBroker.js");
const { repositoryCheckClaim, resolveWorkingResourceIdentity } = require("../dist/concurrency/repositoryResources.js");
const {
  createPipelineExecutionSnapshot,
  createPipelineSnapshot,
} = require("../dist/pipeline/identity.js");
const {
  completedPipeline,
  createController,
  createFakeConversationManager,
  createRepository,
  git,
  gitWorktreeSkip,
  masterPipeline,
  pipelineDefinitionFor,
  pipelineSnapshotFor,
  reviewPipeline,
  scopeResolutions,
} = require("./support/orchestration.cjs");

const commitEnabledPipelineSnapshotFor = (pipelineId) => {
  const definition = pipelineDefinitionFor(pipelineId);
  if (pipelineId === "todo-implementation") {
    definition.managedPolicy = {
      ...(definition.managedPolicy ?? {}),
      commitMode: "allow",
    };
  }
  return createPipelineSnapshot(definition, "builtin");
};


const waitForProcessNotRunning = async (pid) => {
  const fs = require("node:fs");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
      if (process.platform === "linux") {
        try {
          const status = fs.readFileSync(`/proc/${String(pid)}/status`, "utf8");
          if (/^State:\s+Z/mu.test(status)) {
            return;
          }
        } catch (error) {
          if (error?.code === "ENOENT") {
            return;
          }
        }
      }
    } catch (error) {
      if (error?.code === "ESRCH") {
        return;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${String(pid)} is still running`);
};

test("Windows verification resolves cmd.exe from the active system root", () => {
  assert.equal(
    resolveCommandShell("win32", { SystemRoot: String.raw`D:\Windows` }),
    String.raw`D:\Windows\System32\cmd.exe`,
  );
  assert.equal(
    resolveCommandShell("win32", { WINDIR: String.raw`E:\Windows` }),
    String.raw`E:\Windows\System32\cmd.exe`,
  );
  assert.equal(
    resolveCommandShell("win32", { SYSTEMROOT: String.raw`F:\Windows` }),
    String.raw`F:\Windows\System32\cmd.exe`,
  );
  assert.throws(
    () => resolveCommandShell("win32", { SystemRoot: "relative\Windows" }),
    /SystemRoot is unavailable or invalid/u,
  );
  assert.equal(resolveCommandShell("linux", {}), "/bin/sh");
});

const task = (id, paths, dependsOn = [], priority = 0) => ({
  spec: {
    id,
    title: id,
    description: "",
    completed: false,
    line: Number(id.replace(/\D/gu, "")) || 1,
    explicitId: true,
    dependsOn,
    pipelineId: "todo-implementation",
    pipelineSnapshot: pipelineSnapshotFor("todo-implementation"),
    paths,
    checks: ["true"],
    checksDeclared: true,
    priority,
    retries: 1,
  },
  status: "pending",
  attempts: 0,
});

const ledger = (tasks, maxConcurrency = 2) => ({
  version: 1,
  runId: "run-1",
  title: "[R23456789] Test run",
  status: "running",
  workspaceRoot: "/workspace",
  sourceKind: "todoFile",
  todoPath: "/workspace/TODO.md",
  todoSourceHash: "hash",
  integrationBranch: "bachata/integration/run-1",
  integrationWorktree: "/integration",
  baselineCommit: "base",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  maxConcurrency,
  masterPipelineId: "todo-master",
  masterPipelineSnapshot: pipelineSnapshotFor("todo-master"),
  masterChecks: [],
  tasks: Object.fromEntries(tasks.map((value) => [value.spec.id, value])),
  finalChecks: [],
});

const persistedLedger = (storageRoot, tasks, maxConcurrency = 2) => ({
  ...ledger(tasks, maxConcurrency),
  todoSourceHash: "b".repeat(64),
  integrationWorktree: path.join(storageRoot, "orchestration", "runs", "run-1", "integration"),
  baselineCommit: "a".repeat(40),
});


test("TODO parser reads deterministic metadata and explicit no-check declarations", () => {
  const source = [
    "- [ ] [BACHATA-001] Build parser",
    "  - Paths: src/parser.ts, tests/parser.test.ts",
    "  - Verify: npm test",
    "  - Priority: 5",
    "- [ ] [BACHATA-002] Documentation",
    "  - Depends on: BACHATA-001",
    "  - Verify: none",
    "",
  ].join("\n");
  const parsed = parseTodoDocument("/workspace/TODO.md", source, {
    pipelineId: "todo-implementation",
    retries: 1,
  });
  assert.equal(parsed.tasks.length, 2);
  assert.deepEqual(parsed.tasks[0].paths, ["src/parser.ts", "tests/parser.test.ts"]);
  assert.deepEqual(parsed.tasks[0].checks, ["npm test"]);
  assert.equal(parsed.tasks[0].checksDeclared, true);
  assert.deepEqual(parsed.tasks[1].dependsOn, ["BACHATA-001"]);
  assert.deepEqual(parsed.tasks[1].checks, []);
  assert.equal(parsed.tasks[1].checksDeclared, true);
  assert.match(markTodoTaskCompleted(source, parsed.tasks[0]), /- \[x\] \[BACHATA-001\] Build parser/u);
});

test("TODO parser separates task and final checks with explicit shared resources", () => {
  const parsed = parseTodoDocument("/workspace/TODO.md", [
    "- [ ] [BACHATA-001] Protected verification",
    "  - Paths: src",
    "  - Verify: npm test",
    "  - Resources: database:e2e, port:4173",
    "  - Verify Final: npm run e2e",
    "  - Final Resources: database:e2e, browser:chromium",
    "",
  ].join("\n"), {
    pipelineId: "todo-implementation",
    retries: 1,
  });
  assert.deepEqual(parsed.tasks[0].checks, ["npm test"]);
  assert.deepEqual(parsed.tasks[0].checkResources, ["database:e2e", "port:4173"]);
  assert.deepEqual(parsed.tasks[0].finalChecks, ["npm run e2e"]);
  assert.deepEqual(parsed.tasks[0].finalCheckResources, ["database:e2e", "browser:chromium"]);
});



test("TODO parser rejects misspelled, duplicate, and malformed metadata", () => {
  const parse = (metadata) => parseTodoDocument(
    "/workspace/TODO.md",
    ["- [ ] [T1] Protected task", ...metadata.map((line) => `  - ${line}`), ""].join("\n"),
    { pipelineId: "todo-implementation", retries: 1 },
  );

  assert.throws(
    () => parse(["Resoruces: global:database:e2e"]),
    /TODO\.md:2[\s\S]*Unknown key "Resoruces"[\s\S]*Did you mean "Resources"/u,
  );
  for (const key of ["Check-Resources", "Check_Resources", "Resources2", "Resourc.es"]) {
    assert.throws(
      () => parse([`${key}: global:database:e2e`]),
      new RegExp(`Unknown key "${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}"`, "u"),
    );
  }
  assert.throws(
    () => parse(["Resource Pool: database:e2e"]),
    /Unknown key "Resource Pool"/u,
  );
  assert.throws(
    () => parse(["Priority: 2junk"]),
    /Priority must be a complete integer/u,
  );
  assert.throws(
    () => parse(["Priority: 1001"]),
    /Priority must be between -1000 and 1000/u,
  );
  assert.throws(
    () => parse(["Retries: -1"]),
    /Retries must be between 0 and 10/u,
  );
  assert.throws(
    () => parse(["Paths: src", "Scope: tests"]),
    /Scope duplicates metadata declared on line 2/u,
  );
  assert.throws(
    () => parse(["Resources: global:"]),
    /invalid resource name: global:/u,
  );
  assert.throws(
    () => parse(["Verify: none", "Check: npm test"]),
    /conflicts with an earlier none declaration/u,
  );
  assert.throws(
    () => parse(["Verify: none", "Resources: global:database:e2e"]),
    /Resources requires at least one Verify command/u,
  );
  assert.throws(
    () => parse(["Verify Final: none", "Final Resources: global:database:e2e"]),
    /Final Resources requires at least one Verify Final command/u,
  );
  assert.throws(
    () => parse(["Verify: npm test", "Resources: Global:database:e2e"]),
    /exact lowercase global: prefix/u,
  );
  assert.throws(
    () => parse(["Verify: npm test", "Check: npm test"]),
    /duplicates an existing command/u,
  );
});

test("TODO parser rejects known metadata keys without nested list markers", () => {
  const keys = [
    ["Resources", "global:database:e2e"],
    ["Final Resources", "global:database:e2e"],
    ["Verify", "npm test"],
    ["Verify Final", "npm run e2e"],
    ["Depends on", "T0"],
    ["Pipeline", "todo-implementation"],
    ["Paths", "src"],
    ["Priority", "1"],
    ["Retries", "1"],
    ["Description", "details"],
  ];
  for (const [key, value] of keys) {
    const source = [
      "- [ ] [T1] Protected task",
      "  - Verify: npm test",
      `    ${key}: ${value}`,
      "",
    ].join("\n");
    assert.throws(
      () => parseTodoDocument("/workspace/TODO.md", source, {
        pipelineId: "todo-implementation",
        retries: 1,
      }),
      new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} must be a nested list item beginning with \"- \"`, "u"),
    );
  }
});

test("TODO parser keeps explicit descriptions and distinct repeated checks", () => {
  const parsed = parseTodoDocument("/workspace/TODO.md", [
    "- [ ] [T1] Protected task",
    "  - Description: First line",
    "  - Notes: Second line",
    "  - Verify: npm run lint",
    "  - Check: npm test",
    "  Plain continuation",
    "",
  ].join("\n"), { pipelineId: "todo-implementation", retries: 1 });
  assert.equal(parsed.tasks[0].description, "First line\nSecond line\nPlain continuation");
  assert.deepEqual(parsed.tasks[0].checks, ["npm run lint", "npm test"]);
});

test("check resource normalization rejects unsafe persisted resource names", () => {
  assert.deepEqual(
    normalizeCheckResourceNames(["database:e2e", "database:e2e", "port:4173"]),
    ["database:e2e", "port:4173"],
  );
  assert.throws(() => normalizeCheckResourceNames(["global:"]), /invalid resource name/u);
  assert.throws(() => normalizeCheckResourceNames(["contains whitespace"]), /invalid resource name/u);
  assert.throws(() => normalizeCheckResourceNames([""]), /invalid resource name/u);
});

test("TODO parser normalizes repository-wide scope and rejects escaping scopes", () => {
  const document = parseTodoDocument(
    "/workspace/TODO.md",
    "- [ ] [T1] Whole repository\n  - Paths: .\n  - Verify: true\n",
    { pipelineId: "todo-implementation", retries: 1 },
  );
  assert.deepEqual(document.tasks[0].paths, [""]);
  const futureDirectory = parseTodoDocument(
    "/workspace/TODO.md",
    "- [ ] [T2] Future directory\n  - Paths: src/new-feature/\n  - Verify: true\n",
    { pipelineId: "todo-implementation", retries: 1 },
  );
  assert.deepEqual(futureDirectory.tasks[0].paths, ["src/new-feature/"]);
  assert.throws(
    () => parseTodoDocument(
      "/workspace/TODO.md",
      "- [ ] [T1] Escape\n  - Paths: ../outside\n  - Verify: true\n",
      { pipelineId: "todo-implementation", retries: 1 },
    ),
    /Invalid repository path/,
  );
  assert.throws(
    () => parseTodoDocument(
      "/workspace/TODO.md",
      "- [ ] [T1] Absolute\n  - Paths: /outside\n  - Verify: true\n",
      { pipelineId: "todo-implementation", retries: 1 },
    ),
    /Invalid repository path/,
  );
});

test("TODO parser rejects unknown dependencies and cycles", () => {
  assert.throws(
    () => parseTodoDocument("/workspace/TODO.md", "- [ ] [A] A\n  - Depends on: B\n", { pipelineId: "p", retries: 0 }),
    /unknown task B/u,
  );
  assert.throws(
    () => parseTodoDocument("/workspace/TODO.md", "- [ ] [A] A\n  - Depends on: B\n- [ ] [B] B\n  - Depends on: A\n", { pipelineId: "p", retries: 0 }),
    /dependency cycle/u,
  );
});

test("scheduler respects dependencies, path conflicts, priority, and concurrency", () => {
  const first = task("T1", ["src/a"], [], 1);
  const second = task("T2", ["src/b"], [], 10);
  const conflict = task("T3", ["src/a/file.ts"], [], 20);
  const dependent = task("T4", ["src/c"], ["T1"], 30);
  const current = ledger([first, second, conflict, dependent], 2);
  assert.equal(taskPathsConflict(first, conflict), true);
  assert.equal(taskPathsConflict(first, second), false);
  assert.equal(taskPathsConflict(task("T5", ["src/Foo"], [], 0), task("T6", ["src/foo/bar.ts"], [], 0)), true);
  assert.deepEqual(selectRunnableTasks(current).map((value) => value.spec.id), ["T3", "T2"]);
  first.status = "done";
  conflict.status = "done";
  second.status = "done";
  assert.deepEqual(selectRunnableTasks(current).map((value) => value.spec.id), ["T4"]);
});

test("native verification commands stop at the first deterministic failure", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bachata-checks-"));
  try {
    const results = await runVerificationChecks([
      `${shellNodeExecutable} -e "process.stdout.write('ok')"`,
      `${shellNodeExecutable} -e "process.stderr.write('bad'); process.exit(3)"`,
      `${shellNodeExecutable} -e "require('node:fs').writeFileSync('must-not-run.txt', 'ran')"`,
    ], {
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
    });
    assert.deepEqual(results.map((value) => value.status), ["passed", "failed"], JSON.stringify(results));
    assert.equal(results[1].exitCode, 3);
    assert.equal(existsSync(path.join(cwd, "must-not-run.txt")), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("command runner terminates descendants after a successful direct parent exit", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process group test");
    return;
  }
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bachata-command-success-cleanup-"));
  const pidFile = path.join(cwd, "child.pid");
  const fixture = path.join(__dirname, "fixtures", "mock-parent-exits-child-survives.cjs");
  try {
    const execution = await runProcess(process.execPath, [fixture, pidFile], {
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
    });
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.cleanupConfirmed, true);
    const pid = Number(await readFile(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
    await rm(pidFile, { force: true });

    const verification = await runVerificationChecks([
      `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} ${JSON.stringify(pidFile)}`,
    ], {
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
    });
    assert.equal(verification[0].status, "passed");
    assert.equal(verification[0].cleanupConfirmed, true);
    const verificationPid = Number(await readFile(pidFile, "utf8"));
    await waitForProcessNotRunning(verificationPid);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("command runner terminates descendants that create a new POSIX session", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Linux setsid regression test");
    return;
  }
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bachata-command-detached-session-"));
  const pidFile = path.join(cwd, "child.pid");
  const fixture = path.join(__dirname, "fixtures", "mock-parent-exits-detached-session.cjs");
  try {
    const execution = await runProcess(process.execPath, [fixture, pidFile], {
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
    });
    assert.equal(execution.exitCode, 0);
    assert.equal(execution.cleanupConfirmed, true);
    const pid = Number(await readFile(pidFile, "utf8"));
    await waitForProcessNotRunning(pid);
    await rm(pidFile, { force: true });

    const verification = await runVerificationChecks([
      `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} ${JSON.stringify(pidFile)}`,
    ], {
      cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 10_000,
    });
    assert.equal(verification[0].status, "passed");
    assert.equal(verification[0].cleanupConfirmed, true);
    const verificationPid = Number(await readFile(pidFile, "utf8"));
    await waitForProcessNotRunning(verificationPid);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("command runner drains normal stdout before resolving", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bachata-command-drain-"));
  try {
    const expected = "x".repeat(131_072);
    for (let index = 0; index < 10; index += 1) {
      const result = await runProcess(
        process.execPath,
        ["-e", `process.stdout.write("x".repeat(${expected.length}))`],
        { cwd, timeoutMs: 5_000, maxOutputBytes: expected.length + 1_024 },
      );
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, expected);
      assert.equal(result.stderr, "");
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("command runner closes inherited output pipes by terminating scoped descendants", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bachata-command-background-pipe-"));
  try {
    const script = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', 'inherit', 'inherit'] }); child.unref();",
    ].join("\n");
    const started = Date.now();
    const result = await runProcess(
      process.execPath,
      ["-e", script],
      { cwd, timeoutMs: 5_000, maxOutputBytes: 10_000 },
    );
    assert.equal(result.timedOut, false);
    assert.equal(result.cleanupConfirmed, true);
    assert.equal(result.exitCode, 0);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("command runner terminates timed-out checks", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bachata-timeout-"));
  try {
    const result = await runCommand(
      `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 10000)"`,
      { cwd, timeoutMs: 50, maxOutputBytes: 10_000 },
    );
    assert.equal(result.timedOut, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});



test("Git cleanup reaps inherited descendants without quarantining the administration resource", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-git-cleanup-quarantine-"));
  try {
    const repository = path.join(root, "repository");
    const storageRoot = path.join(root, "storage");
    const scriptPath = path.join(root, "fake-git.cjs");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await writeFile(scriptPath, `
      const { spawn } = require('node:child_process');
      const args = process.argv.slice(2);
      if (args[0] === '--version') {
        process.stdout.write('git version 2.39.5\\n');
        process.exit(0);
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        process.stdout.write('.git\\n');
        process.exit(0);
      }
      if (args[0] === 'worktree' && args[1] === 'prune') {
        spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        process.exit(0);
      }
      process.exit(0);
    `, "utf8");
    const resourceBroker = createResourceBroker({
      databasePath: path.join(root, "resources.sqlite"),
      ownerId: "git-cleanup-test",
      pollIntervalMs: 10,
    });
    const manager = createWorktreeManager(storageRoot, {
      resourceBroker,
      lockTimeoutMs: () => 2_000,
      gitExecutable: process.execPath,
      gitArgumentsPrefix: [scriptPath],
    });
    const run = {
      repositoryRoot: repository,
      baselineCommit: "a".repeat(40),
      integrationBranch: "bachata/integration/run-uncertain",
      integrationWorktree: path.join(storageRoot, "orchestration", "runs", "run-uncertain", "integration"),
    };

    await manager.cleanupRun(run);
    assert.deepEqual(resourceBroker.listQuarantine(), []);
    await resourceBroker.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-A5-R02. Machine-readable Git output is read through one bound. A status inventory larger
// than that bound used to come back as a shorter list with the overflow silently gone and the
// last surviving entry a fragment of a filename, so the caller acted on an inventory that was
// missing exactly the files it would have protected.
test("a truncated machine-readable Git inventory is a failed read, not a shorter one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-git-truncated-"));
  try {
    const repository = path.join(root, "repository");
    const storageRoot = path.join(root, "storage");
    const scriptPath = path.join(root, "fake-git.cjs");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await writeFile(scriptPath, `
      const args = process.argv.slice(2);
      if (args[0] === '--version') {
        process.stdout.write('git version 2.39.5\\n');
        process.exit(0);
      }
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        process.stdout.write(${JSON.stringify(repository)} + '\\n');
        process.exit(0);
      }
      if (args[0] === 'status') {
        // One modified file per record, more of them than the bound can hold. Written with a
        // blocking write so the whole inventory reaches the pipe before this process exits.
        const records = [];
        let index = 0;
        while (index < 200000) {
          records.push(' M src/generated/file-' + String(index) + '.ts\\u0000');
          index += 1;
        }
        require('node:fs').writeSync(1, records.join(''));
        process.exit(0);
      }
      process.exit(0);
    `, "utf8");
    const manager = createWorktreeManager(storageRoot, {
      gitExecutable: process.execPath,
      gitArgumentsPrefix: [scriptPath],
    });
    await assert.rejects(
      manager.dirtyRepositoryPaths(repository),
      /truncated, so it cannot be parsed/u,
      "a status inventory past the output bound was parsed as a complete one",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("nested Git cleanup fallbacks reap inherited descendants without quarantine", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-git-nested-quarantine-"));
  try {
    const repository = path.join(root, "repository");
    const storageRoot = path.join(root, "storage");
    const marker = path.join(root, "primary-failed");
    const scriptPath = path.join(root, "fake-git.cjs");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await writeFile(scriptPath, `
      const { existsSync, mkdirSync, writeFileSync } = require('node:fs');
      const { spawn } = require('node:child_process');
      const args = process.argv.slice(2);
      if (args[0] === '--version') {
        process.stdout.write('git version 2.39.5\\n');
        process.exit(0);
      }
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') {
        process.stdout.write('.git\\n');
        process.exit(0);
      }
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
        process.stdout.write(${JSON.stringify(repository)} + '\\n');
        process.exit(0);
      }
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        process.stdout.write('a'.repeat(40) + '\\n');
        process.exit(0);
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        if (existsSync(${JSON.stringify(marker)})) {
          process.stderr.write('cleanup listing failed\\n');
          process.exit(1);
        }
        process.exit(0);
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(args[4], { recursive: true });
        writeFileSync(${JSON.stringify(marker)}, '1');
        spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
          stdio: ['ignore', 'inherit', 'inherit'],
        });
        process.exit(0);
      }
      if (args[0] === 'write-tree') {
        process.stdout.write('b'.repeat(40) + '\\n');
        process.exit(0);
      }
      process.exit(0);
    `, "utf8");
    const resourceBroker = createResourceBroker({
      databasePath: path.join(root, "resources.sqlite"),
      ownerId: "git-nested-cleanup-test",
      pollIntervalMs: 10,
    });
    const manager = createWorktreeManager(storageRoot, {
      resourceBroker,
      lockTimeoutMs: () => 2_000,
      gitExecutable: process.execPath,
      gitArgumentsPrefix: [scriptPath],
    });

    await manager.prepareRun(repository, "run-nested-uncertain");
    assert.deepEqual(resourceBroker.listQuarantine(), []);
    await resourceBroker.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup rollback failure quarantines full TODO lifecycle ownership", async () => {
  const source = await readFile(
    path.join(__dirname, "..", "src", "orchestrator", "controller.ts"),
    "utf8",
  );
  assert.match(source, /startup rollback cleanup was not confirmed/u);
  assert.match(source, /await quarantineOrchestrationOwner\(reason\)/u);
  assert.match(source, /retainUnsafeOwner = true/u);
});

test("orchestration store persists ledgers and the active run atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-store-"));
  try {
    const store = createOrchestrationStore(root);
    const current = persistedLedger(root, [task("T1", ["src"])]);
    await store.save(current);
    await store.setActiveRun(current.runId);
    assert.equal(await store.getActiveRun(), current.runId);
    assert.deepEqual(await store.load(current.runId), current);
    await store.setActiveRun(undefined);
    assert.equal(await store.getActiveRun(), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestration store persists and validates pending integration rollback commits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-store-rollback-"));
  try {
    const store = createOrchestrationStore(root);
    const current = persistedLedger(root, [task("T1", ["src"])]);
    current.tasks.T1.integrationRollbackCommit = "c".repeat(40);
    await store.save(current);
    assert.equal(
      (await store.load(current.runId)).tasks.T1.integrationRollbackCommit,
      "c".repeat(40),
    );
    current.tasks.T1.integrationRollbackCommit = "not-a-commit";
    assert.throws(
      () => store.save(current),
      /integrationRollbackCommit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestration store rejects dependency bundles in unattended task and Master snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-store-pipeline-bundle-"));
  try {
    const store = createOrchestrationStore(root);
    const current = persistedLedger(root, [task("T1", ["src"])]);
    const rootSnapshot = pipelineSnapshotFor("todo-implementation");
    const bundled = createPipelineExecutionSnapshot(rootSnapshot, {
      child: pipelineSnapshotFor("child"),
    });
    current.tasks.T1.spec.pipelineSnapshot = bundled;
    assert.throws(
      () => store.save(current),
      /pipelineSnapshot/u,
    );
    current.tasks.T1.spec.pipelineSnapshot = rootSnapshot;
    current.masterPipelineSnapshot = bundled;
    assert.throws(
      () => store.save(current),
      /masterPipelineSnapshot/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller does not suppress task cleanup or rollback-ledger persistence failures", async () => {
  const source = await readFile(
    path.join(__dirname, "..", "src", "orchestrator", "controller.ts"),
    "utf8",
  );
  assert.doesNotMatch(source, /removeTask\([^;]+\)\.catch\(\(\) => undefined\)/su);
  assert.doesNotMatch(source, /await save\(current\)\.catch\(\(\) => undefined\)/u);
  assert.match(source, /const rollbackFailures: unknown\[\] = \[error, rollbackError\]/u);
  assert.match(source, /rollbackFailures\.push\(persistenceError\)/u);
});

test("orchestration store lists retained run ledgers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-store-list-"));
  try {
    const store = createOrchestrationStore(root);
    const current = persistedLedger(root, [task("T1", ["src"])]);
    await store.save(current);
    assert.deepEqual(await store.listRunIds(), [current.runId]);
    await store.remove(current.runId);
    assert.deepEqual(await store.listRunIds(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test("orchestration store serializes concurrent snapshots in invocation order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-store-order-"));
  try {
    const store = createOrchestrationStore(root);
    const current = persistedLedger(root, [task("T1", ["src"])]);
    const writes = [];
    for (let index = 0; index < 25; index += 1) {
      current.error = `snapshot-${String(index)}`;
      writes.push(store.save(current));
    }
    await Promise.all(writes);
    assert.equal((await store.load(current.runId)).error, "snapshot-24");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git administration preserves the operation error when lease release fails", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-worktree-release-failure-"));
  const quarantined = [];
  try {
    const repository = await createRepository(root, "# TODO\n", { "dirty.txt": "clean\n" });
    await writeFile(path.join(repository, "dirty.txt"), "dirty\n", "utf8");
    const releaseError = new Error("simulated administration release failure");
    const manager = createWorktreeManager(path.join(root, "storage"), {
      resourceBroker: {
        ownerId: "fake-owner",
        acquire: async ({ resources }) => ({
          id: "fake-lease",
          resources,
          release: async () => { throw releaseError; },
          quarantine: async (reason) => { quarantined.push(reason); },
        }),
        listQuarantine: () => [],
        clearQuarantine: () => 0,
        dispose: async () => undefined,
      },
    });

    await assert.rejects(
      manager.prepareRun(repository, "run-release-failure"),
      (error) => {
        assert.equal(error instanceof AggregateError, true);
        assert.equal(error.errors.some((item) => /repository must be clean/u.test(item.message)), true);
        assert.equal(error.errors.includes(releaseError), true);
        return true;
      },
    );
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0], /lease release was not confirmed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree manager isolates and integrates a task without commits", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-worktree-"));
  const repository = path.join(root, "repository");
  const storage = path.join(root, "storage");
  await mkdir(path.join(repository, "src"), { recursive: true });
  try {
    git(root, "init", repository);
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(repository, "TODO.md"), "- [ ] [T1] Change file\n  - Verify: bachata:workspace-integrity\n", "utf8");
    await writeFile(path.join(repository, "src", "value.txt"), "before\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "run-1", [], "never");
    const prepared = await manager.prepareTask(run, "T1");
    await writeFile(path.join(prepared.worktreePath, "src", "value.txt"), "after\n", "utf8");
    assert.deepEqual(await manager.changedFiles(prepared), ["src/value.txt"]);
    assert.equal(await manager.commitTask(prepared, "Change file"), undefined);
    const integrationTree = await manager.integrateTask(run, prepared, "Change file");
    assert.match(integrationTree, /^[0-9a-f]{40}$/u);
    assert.equal(git(prepared.worktreePath, "rev-parse", "HEAD"), prepared.baseCommit);
    assert.equal(git(run.integrationWorktree, "rev-parse", "HEAD"), run.baselineCommit);
    assert.equal(await readFile(path.join(run.integrationWorktree, "src", "value.txt"), "utf8"), "after\n");
    await manager.removeTask(run, prepared);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task and validation worktrees reuse ignored workspace dependencies", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-worktree-dependencies-"));
  const repository = path.join(root, "repository");
  const storage = path.join(root, "storage");
  await mkdir(path.join(repository, "node_modules", ".bin"), { recursive: true });
  try {
    git(root, "init", repository);
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(repository, ".gitignore"), "node_modules/\n", "utf8");
    await writeFile(path.join(repository, "package.json"), JSON.stringify({ name: "dependency-fixture", scripts: { check: "bachata-check" } }), "utf8");
    await writeFile(path.join(repository, "node_modules", ".bin", "bachata-check"), "fixture dependency\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "run-dependencies");
    const task = await manager.prepareTask(run, "TASK_DEPENDENCIES");
    assert.equal(await readFile(path.join(task.worktreePath, "node_modules", ".bin", "bachata-check"), "utf8"), "fixture dependency\n");

    const validation = await manager.prepareValidation(run, task.worktreePath, "dependency-check");
    assert.equal(await readFile(path.join(validation.worktreePath, "node_modules", ".bin", "bachata-check"), "utf8"), "fixture dependency\n");

    await manager.removeValidation(run, validation);
    await manager.removeTask(run, task);
    await manager.abandonRun(run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("task no-commit policy cannot be overridden by deployment commit capability", gitWorktreeSkip, async () => {
  const previousManagedCommitMode = process.env.BACHATA_MANAGED_COMMIT_MODE;
  process.env.BACHATA_MANAGED_COMMIT_MODE = "allow";
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-worktree-no-commit-"));
  const repository = path.join(root, "repository");
  const storage = path.join(root, "storage");
  await mkdir(path.join(repository, "src"), { recursive: true });
  try {
    git(root, "init", repository);
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(repository, "TODO.md"), "- [ ] [T1] Change file\n  - Verify: true\n", "utf8");
    await writeFile(path.join(repository, "src", "value.txt"), "before\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "run-no-commit", [], "never");
    const prepared = await manager.prepareTask(run, "T1");
    await writeFile(path.join(prepared.worktreePath, "src", "value.txt"), "after\n", "utf8");
    git(prepared.worktreePath, "add", "--all");
    git(prepared.worktreePath, "commit", "-m", "model-created commit");
    const commit = await manager.commitTask(prepared, "Change file");
    assert.equal(commit, undefined);
    assert.equal(git(prepared.worktreePath, "rev-parse", "HEAD"), prepared.baseCommit);
    assert.equal(await readFile(path.join(prepared.worktreePath, "src", "value.txt"), "utf8"), "after\n");
    await manager.removeTask(run, prepared);
  } finally {
    if (previousManagedCommitMode === undefined) delete process.env.BACHATA_MANAGED_COMMIT_MODE;
    else process.env.BACHATA_MANAGED_COMMIT_MODE = previousManagedCommitMode;
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree changed-file detection preserves exact names and both rename paths", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-worktree-paths-"));
  const repository = path.join(root, "repository");
  const storage = path.join(root, "storage");
  await mkdir(path.join(repository, "src"), { recursive: true });
  try {
    git(root, "init", repository);
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(repository, "TODO.md"), "- [ ] [T1] Rename\n  - Verify: true\n", "utf8");
    await writeFile(path.join(repository, "src", "old name.txt"), "before\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "run-paths", true);
    const prepared = await manager.prepareTask(run, "T1");
    await rename(
      path.join(prepared.worktreePath, "src", "old name.txt"),
      path.join(prepared.worktreePath, "src", "new name.txt"),
    );
    await writeFile(path.join(prepared.worktreePath, "src", "naïve file.txt"), "new\n", "utf8");
    assert.deepEqual(await manager.changedFiles(prepared), [
      "src/naïve file.txt",
      "src/new name.txt",
      "src/old name.txt",
    ]);
    await manager.removeTask(run, prepared);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


const waitFor = async (predicate, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const createMutationGate = () => {
  let mutationCount = 0;
  let failure;
  return {
    run: async (operation) => {
      mutationCount += 1;
      if (failure?.mutation === mutationCount && failure.phase === "before") {
        const error = failure.error;
        failure = undefined;
        throw error;
      }
      const result = await operation();
      if (failure?.mutation === mutationCount && failure.phase === "after") {
        const error = failure.error;
        failure = undefined;
        throw error;
      }
      return result;
    },
    failBefore: (offset, error) => {
      failure = { mutation: mutationCount + offset, phase: "before", error };
    },
    failAfter: (offset, error) => {
      failure = { mutation: mutationCount + offset, phase: "after", error };
    },
    count: () => mutationCount,
  };
};

test("controller prevents task-title command injection and integrates scoped changes", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-injection-"));
  const marker = path.join(root, "injected-marker");
  try {
    const repository = await createRepository(root, [
      `- [ ] [T1] $(touch ${marker})`,
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const result = await controller.start();
    assert.equal(result.status, "completed");
    await assert.rejects(readFile(marker, "utf8"), /ENOENT/);
    assert.equal(await readFile(path.join(result.integrationWorktree, "src", "value.txt"), "utf8"), "after\n");
    assert.match(await readFile(path.join(result.integrationWorktree, "TODO.md"), "utf8"), /- \[x\] \[T1\]/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("completed TODO runs survive restart and can be cleaned up independently", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-retained-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Retained run",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    let execution = 0;
    const manager = createFakeConversationManager(async ({ options }) => {
      execution += 1;
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), `after-${String(execution)}\n`, "utf8");
      return completedPipeline();
    });

    const firstController = createController(root, repository, manager, { todoRetries: 0 });
    const first = await firstController.start();
    assert.equal(first.status, "completed");
    assert.deepEqual(firstController.getSnapshot().retainedRuns.map((item) => item.runId), [first.runId]);
    await firstController.dispose();

    const secondController = createController(root, repository, manager, { todoRetries: 0 });
    assert.equal(await secondController.resolveRetainedWorktree(first.runId), first.integrationWorktree);
    const second = await secondController.start();
    assert.equal(second.status, "completed");
    assert.deepEqual(
      new Set(secondController.getSnapshot().retainedRuns.map((item) => item.runId)),
      new Set([first.runId, second.runId]),
    );

    await secondController.cleanupRetained(first.runId);
    await assert.rejects(readFile(path.join(first.integrationWorktree, "TODO.md"), "utf8"), /ENOENT/u);
    assert.throws(
      () => git(repository, "show-ref", "--verify", `refs/heads/${first.integrationBranch}`),
      /Command failed/u,
    );
    assert.equal(await readFile(path.join(second.integrationWorktree, "src", "value.txt"), "utf8"), "after-2\n");
    assert.equal(git(repository, "show-ref", "--verify", `refs/heads/${second.integrationBranch}`).length > 0, true);
    assert.deepEqual(secondController.getSnapshot().retainedRuns.map((item) => item.runId), [second.runId]);
    await secondController.dispose();

    const thirdController = createController(root, repository, manager, { todoRetries: 0 });
    assert.equal(await thirdController.resolveRetainedWorktree(second.runId), second.integrationWorktree);
    await thirdController.cleanupRetained(second.runId);
    assert.deepEqual(thirdController.getSnapshot().retainedRuns, []);
    await thirdController.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Master checks execution state only and blocks a reported deviation", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-master-"));
  const masterPrompts = [];
  let taskRuns = 0;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Execute one task",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "private-file-content\n" });
    const manager = createFakeConversationManager(
      async () => {
        taskRuns += 1;
        return completedPipeline();
      },
      async ({ prompt }) => {
        masterPrompts.push(prompt);
        return masterPipeline({
          status: "deviation",
          deviations: [{
            taskId: "T1",
            kind: "todoState",
            details: "Controller state does not match the task plan.",
          }],
        });
      },
    );
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const result = await controller.start();
    assert.equal(result.status, "blocked");
    assert.equal(taskRuns, 0);
    assert.equal(result.masterChecks.length, 1);
    assert.equal(result.masterChecks[0].status, "deviation");
    const masterRoom = [...manager.rooms.values()].find((options) => options.pipelineId === "todo-master");
    assert.ok(masterRoom);
    assert.notEqual(masterRoom.workingDirectory, repository);
    assert.equal(path.basename(masterRoom.workingDirectory), "master");
    assert.equal(path.basename(path.dirname(masterRoom.workingDirectory)), "orchestration");
    assert.match(masterPrompts[0], /T1/u);
    assert.doesNotMatch(masterPrompts[0], /private-file-content/u);
    assert.equal(await readFile(path.join(result.integrationWorktree, "src", "value.txt"), "utf8"), "private-file-content\n");
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller rejects a Master deviation for an unknown task", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-master-invalid-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Execute one task",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(
      async () => completedPipeline(),
      async () => masterPipeline({
        status: "deviation",
        deviations: [{
          taskId: "UNKNOWN",
          kind: "wrongTask",
          details: "Unknown task.",
        }],
      }),
    );
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const result = await controller.start();
    assert.equal(result.status, "failed");
    assert.match(result.error, /unknown task UNKNOWN/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller executes a selected generated checklist without rewriting TODO.md", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-generated-"));
  const prompts = [];
  try {
    const repository = await createRepository(root, "# Existing TODO\n", {
      "src/a.txt": "before-a\n",
      "src/b.txt": "before-b\n",
    });
    const manager = createFakeConversationManager(async ({ prompt, options }) => {
      prompts.push(prompt);
      assert.equal(options.parentConversationId, "R8765432A");
      if (prompt.includes("Task ID: A")) {
        await writeFile(path.join(options.workingDirectory, "src", "a.txt"), "after-a\n", "utf8");
      } else {
        await writeFile(path.join(options.workingDirectory, "src", "b.txt"), "after-b\n", "utf8");
      }
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const result = await controller.startChecklist({
      workspaceRoot: repository,
      parentRunRef: "R23456789",
      parentConversationId: "R8765432A",
      title: "Review src",
      pipelineId: "todo-implementation",
      pipelineSnapshot: pipelineSnapshotFor("todo-implementation"),
      issues: [
        {
          id: "A",
          title: "Fix A",
          details: "Update A.",
          dependencies: [],
          paths: ["src/a.txt"],
        },
        {
          id: "B",
          title: "Fix B",
          details: "Update B.",
          dependencies: ["A"],
          paths: ["src/b.txt"],
        },
      ],
      selectedIssueIds: ["A", "B"],
      userNote: "Keep compatibility.",
      allowedPaths: ["."],
      checks: [],
      allowNoChecks: true,
      retries: 0,
      maxConcurrency: 2,
    });
    assert.equal(result.status, "completed");
    assert.equal(result.sourceKind, "generatedChecklist");
    assert.equal(result.parentRunRef, "R23456789");
    assert.equal(result.parentConversationId, "R8765432A");
    assert.equal(await readFile(path.join(result.integrationWorktree, "src", "a.txt"), "utf8"), "after-a\n");
    assert.equal(await readFile(path.join(result.integrationWorktree, "src", "b.txt"), "utf8"), "after-b\n");
    assert.equal(await readFile(path.join(result.integrationWorktree, "TODO.md"), "utf8"), "# Existing TODO\n");
    assert.equal(prompts.every((prompt) => prompt.includes("## User instructions\nKeep compatibility.")), true);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller sees and integrates commits created by the model", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-model-commit-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Model commit",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "model commit\n", "utf8");
      git(options.workingDirectory, "add", "--all");
      git(options.workingDirectory, "commit", "-m", "model-created commit");
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const result = await controller.start();
    assert.equal(result.status, "completed");
    assert.deepEqual(result.tasks.T1.result.changedFiles, ["src/value.txt"]);
    assert.equal(await readFile(path.join(result.integrationWorktree, "src", "value.txt"), "utf8"), "model commit\n");
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller rejects arbitrary verification commands before task execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-check-scope-"));
  let modelCalls = 0;
  let controller;
  try {
    const command = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('outside.txt','x')"`;
    const repository = await createRepository(root, [
      "- [ ] [T1] Check scope",
      "  - Paths: src",
      `  - Verify: ${command}`,
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async () => {
      modelCalls += 1;
      return completedPipeline();
    });
    controller = createController(root, repository, manager, { todoRetries: 0 });
    await assert.rejects(controller.start(), /Verify commands must be bachata:workspace-integrity, bachata:project-checks, or bachata:verifier:<id>/u);
    assert.equal(modelCalls, 0);
    await assert.rejects(readFile(path.join(repository, "outside.txt"), "utf8"), /ENOENT/u);
    assert.equal(await readFile(path.join(repository, "src", "value.txt"), "utf8"), "before\n");
  } finally {
    await controller?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("stop blocks late completion, preserves recovery, retains history, and resume reruns the task", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-stop-"));
  let releaseFirst;
  let calls = 0;
  let taskResolutionCount = 0;
  let controller;
  let starting;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const taskRuns = [];
  const acceptedTaskSnapshot = pipelineSnapshotFor("todo-implementation");
  const changedTaskSnapshot = createPipelineSnapshot(
    { ...pipelineDefinitionFor("todo-implementation"), name: "Changed after stop" },
    "builtin",
  );
  const firstTurn = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Stop safely",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(
      async ({ options, runOptions }) => {
        calls += 1;
        taskRuns.push(runOptions.pipelineSnapshot);
        if (calls === 1) {
          markFirstStarted();
          await firstTurn;
        }
        await writeFile(path.join(options.workingDirectory, "src", "value.txt"), `after-${String(calls)}\n`, "utf8");
        return completedPipeline();
      },
      async () => masterPipeline(),
      async ({ pipelineId }) => {
        if (pipelineId === "todo-master") {
          return pipelineSnapshotFor("todo-master");
        }
        taskResolutionCount += 1;
        return taskResolutionCount === 1
          ? acceptedTaskSnapshot
          : changedTaskSnapshot;
      },
    );
    controller = createController(root, repository, manager, { todoRetries: 0 });
    starting = controller.start();
    await Promise.race([
      firstStarted,
      starting.then(() => { throw new Error("The run finished before its first task started"); }),
    ]);
    const stopping = controller.stop();
    releaseFirst();
    await stopping;
    const stopped = await starting;
    assert.equal(stopped.status, "stopped");
    assert.notEqual(stopped.tasks.T1.status, "done");
    assert.equal(await readFile(path.join(stopped.integrationWorktree, "src", "value.txt"), "utf8"), "before\n");
    assert.match(await readFile(path.join(stopped.integrationWorktree, "TODO.md"), "utf8"), /- \[ \] \[T1\]/u);
    const staleConversationId = stopped.tasks.T1.conversationId;
    const store = createOrchestrationStore(path.join(root, "storage"));
    assert.equal(await store.getActiveRun(), stopped.runId);

    const resumed = await controller.resume();
    assert.equal(resumed.status, "completed");
    assert.equal(calls, 2);
    assert.equal(taskResolutionCount, 1);
    assert.equal(taskRuns.length, 2);
    taskRuns.forEach((snapshot) => {
      assert.equal(snapshot.hash, acceptedTaskSnapshot.hash);
      assert.equal(snapshot.definition.name, acceptedTaskSnapshot.definition.name);
    });
    assert.equal(manager.closed.includes(staleConversationId), false);
    assert.equal(manager.rooms.has(staleConversationId), true);
    assert.notEqual(resumed.tasks.T1.conversationId, staleConversationId);
    assert.equal(await readFile(path.join(resumed.integrationWorktree, "src", "value.txt"), "utf8"), "after-2\n");
    assert.equal(await store.getActiveRun(), undefined);
    await controller.dispose();
  } finally {
    releaseFirst();
    await controller?.dispose();
    await starting?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("controller rejects commit-enabled task pipelines before model execution", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-no-commit-pipeline-"));
  let modelCalls = 0;
  let controller;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] No commits",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(
      async () => {
        modelCalls += 1;
        return completedPipeline();
      },
      undefined,
      async ({ pipelineId }) => commitEnabledPipelineSnapshotFor(pipelineId),
    );
    controller = createController(root, repository, manager, { todoRetries: 0 });
    await assert.rejects(controller.start(), /pipelineSnapshot|commitMode/u);
    assert.equal(modelCalls, 0);
    assert.equal(await readFile(path.join(repository, "src", "value.txt"), "utf8"), "before\n");
  } finally {
    await controller?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("final changed-file validation rejects restricted generated output", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-final-boundary-"));
  let controller;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Final boundary",
      "  - Paths: src",
      "  - Verify: bachata:workspace-integrity",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      await mkdir(path.join(options.workingDirectory, "dist"), { recursive: true });
      await writeFile(path.join(options.workingDirectory, "dist", "generated.js"), "generated\n", "utf8");
      return completedPipeline();
    });
    controller = createController(root, repository, manager, { todoRetries: 0 });
    const result = await controller.start();
    assert.equal(result.status, "failed");
    assert.equal(result.tasks.T1.status, "failed");
    assert.equal(await readFile(path.join(result.integrationWorktree, "src", "value.txt"), "utf8"), "before\n");
    await assert.rejects(readFile(path.join(result.integrationWorktree, "dist", "generated.js"), "utf8"), /ENOENT/u);
    assert.match(await readFile(path.join(result.integrationWorktree, "TODO.md"), "utf8"), /- \[ \] \[T1\]/u);
  } finally {
    await controller?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("controller-owned task and final checks execute in their declared phases", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-check-phases-"));
  let controller;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Check phases",
      "  - Paths: src",
      "  - Verify: bachata:workspace-integrity",
      "  - Verify Final: bachata:workspace-integrity",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    controller = createController(root, repository, manager, { todoRetries: 0 });
    const result = await controller.start();
    assert.equal(
      result.status,
      "completed",
      JSON.stringify({ error: result.error, task: result.tasks.T1, finalChecks: result.finalChecks }),
    );
    assert.equal(result.tasks.T1.result.checks.length, 1);
    assert.equal(result.tasks.T1.result.checks[0].command, "bachata:workspace-integrity");
    assert.equal(result.tasks.T1.result.checks[0].status, "passed");
    assert.equal(result.finalChecks.length, 1);
    assert.equal(result.finalChecks[0].command, "bachata:workspace-integrity");
    assert.equal(result.finalChecks[0].status, "passed");
    // The validation worktree is built by overlaying the candidate as plain files, so its index
    // tree is the fetched HEAD and names the same value for every candidate and every revision.
    // A check record names no tree rather than one the check never ran against.
    assert.equal(result.tasks.T1.result.checks[0].candidateTree, undefined);
    assert.equal(result.finalChecks[0].candidateTree, undefined);
  } finally {
    await controller?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("resource timeout preserves implementation and resume verifies without another model pass", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-verification-resume-"));
  const databasePath = path.join(root, "global", "resources.sqlite");
  const holder = createResourceBroker({ databasePath, ownerId: "holder", pollIntervalMs: 10 });
  const controllerBroker = createResourceBroker({ databasePath, ownerId: "controller", pollIntervalMs: 10 });
  let controller;
  let held;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Resume verification",
      "  - Paths: src",
      "  - Verify: bachata:workspace-integrity",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const identity = await resolveWorkingResourceIdentity(repository);
    held = await holder.acquire({
      resources: [repositoryCheckClaim(identity)],
      deadlineAt: Date.now() + 1000,
    });
    let modelCalls = 0;
    const manager = createFakeConversationManager(async ({ options }) => {
      modelCalls += 1;
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    controller = createController(root, repository, manager, {
      todoRetries: 0,
      todoCheckSlotTimeoutMs: 2000,
    }, controllerBroker);
    const blocked = await controller.start();
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.tasks.T1.implementationComplete, true);
    assert.equal(modelCalls, 1);
    await held.release();
    held = undefined;
    const completed = await controller.resume();
    assert.equal(
      completed.status,
      "completed",
      JSON.stringify({ error: completed.error, task: completed.tasks.T1, finalChecks: completed.finalChecks }),
    );
    assert.equal(modelCalls, 1);
    assert.equal(await readFile(path.join(completed.integrationWorktree, "src", "value.txt"), "utf8"), "after\n");
  } finally {
    await held?.release().catch(() => undefined);
    await controller?.dispose().catch(() => undefined);
    await holder.dispose().catch(() => undefined);
    await controllerBroker.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a verification checkpoint save failure releases its acquired resource lease", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-checkpoint-release-"));
  const databasePath = path.join(root, "global", "resources.sqlite");
  const underlying = createResourceBroker({ databasePath, ownerId: "checkpoint-controller", pollIntervalMs: 10 });
  const observer = createResourceBroker({ databasePath, ownerId: "checkpoint-observer", pollIntervalMs: 10 });
  const storageRoot = path.join(root, "storage");
  let controller;
  let settlement;
  let sabotagedPath;
  let backupPath;
  const broker = {
    ownerId: underlying.ownerId,
    listQuarantine: underlying.listQuarantine,
    clearQuarantine: underlying.clearQuarantine,
    dispose: underlying.dispose,
    acquire: async (request) => {
      const lease = await underlying.acquire(request);
      if (!String(request.label ?? "").startsWith("TODO verification ")) {
        return lease;
      }
      const active = JSON.parse(await readFile(
        path.join(storageRoot, "orchestration", "active-run.json"),
        "utf8",
      ));
      sabotagedPath = path.join(storageRoot, "orchestration", "runs", active.runId);
      backupPath = `${sabotagedPath}.backup`;
      await rename(sabotagedPath, backupPath);
      await writeFile(sabotagedPath, "not a directory", "utf8");
      const restore = async () => {
        await rm(sabotagedPath, { force: true });
        await rename(backupPath, sabotagedPath);
      };
      return {
        ...lease,
        release: async () => {
          settlement = "released";
          await restore();
          await lease.release();
        },
        quarantine: async (reason) => {
          settlement = "quarantined";
          await restore();
          await lease.quarantine(reason);
        },
      };
    },
  };
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Save checkpoint",
      "  - Paths: src",
      "  - Verify: bachata:workspace-integrity",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    controller = createController(root, repository, manager, {
      todoRetries: 0,
      todoCheckSlotTimeoutMs: 1000,
    }, broker);
    const result = await controller.start();
    assert.equal(result.status, "failed");
    assert.equal(result.tasks.T1.status, "failed");
    assert.equal(settlement, "released");
    const identity = await resolveWorkingResourceIdentity(repository);
    const lease = await observer.acquire({
      resources: [repositoryCheckClaim(identity)],
      deadlineAt: Date.now() + 500,
      label: "verify released checkpoint resource",
    });
    await lease.release();
  } finally {
    if (sabotagedPath && backupPath) {
      await rm(sabotagedPath, { force: true }).catch(() => undefined);
      await rename(backupPath, sabotagedPath).catch(() => undefined);
    }
    await controller?.dispose().catch(() => undefined);
    await underlying.dispose().catch(() => undefined);
    await observer.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("task storage identities remain distinct after lossy filename normalization", gitWorktreeSkip, async () => {
  assert.notEqual(taskStorageIdentity("A/B"), taskStorageIdentity("A?B"));
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-worktree-identities-"));
  const repository = path.join(root, "repository");
  const storage = path.join(root, "storage");
  await mkdir(repository, { recursive: true });
  try {
    git(root, "init", repository);
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(repository, "value.txt"), "before\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "run-identities");
    const first = await manager.prepareTask(run, "A/B");
    const second = await manager.prepareTask(run, "A?B");
    assert.notEqual(first.worktreePath, second.worktreePath);
    assert.notEqual(first.branch, second.branch);
    assert.equal(git(first.worktreePath, "rev-parse", "HEAD"), run.baselineCommit);
    assert.equal(git(second.worktreePath, "rev-parse", "HEAD"), run.baselineCommit);
    await manager.removeTask(run, first);
    await manager.removeTask(run, second);
    await manager.abandonRun(run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worktree cleanup accepts exact legacy task identities", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-worktree-legacy-"));
  const repository = path.join(root, "repository");
  const storage = path.join(root, "storage");
  await mkdir(repository, { recursive: true });
  try {
    git(root, "init", repository);
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(repository, "value.txt"), "before\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "run-legacy-task");
    const runPart = run.integrationBranch.slice("bachata/integration/".length);
    const legacyPath = path.join(path.dirname(run.integrationWorktree), "tasks", "T1");
    const legacyBranch = `bachata/task/${runPart}/T1`;
    await mkdir(path.dirname(legacyPath), { recursive: true });
    git(repository, "worktree", "add", "-b", legacyBranch, legacyPath, run.baselineCommit);

    await manager.removeTask(run, {
      taskId: "T1",
      branch: legacyBranch,
      worktreePath: legacyPath,
      baseCommit: run.baselineCommit,
    });

    await assert.rejects(readFile(path.join(legacyPath, "value.txt"), "utf8"), /ENOENT/u);
    assert.throws(
      () => git(repository, "show-ref", "--verify", `refs/heads/${legacyBranch}`),
      /Command failed/u,
    );
    await manager.abandonRun(run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verification repositories have independent Git state and cannot mutate the task worktree", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-validation-repository-"));
  const repository = path.join(root, "repository");
  const storage = path.join(root, "storage");
  await mkdir(repository, { recursive: true });
  try {
    git(root, "init", repository);
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(repository, "value.txt"), "before\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "run-validation");
    const taskWorktree = await manager.prepareTask(run, "TASK_A");
    await writeFile(path.join(taskWorktree.worktreePath, "value.txt"), "after\n", "utf8");
    const sourceState = await manager.worktreeState(taskWorktree.worktreePath);
    const validation = await manager.prepareValidation(run, taskWorktree.worktreePath, "task-check");
    const sourceCommonDir = path.resolve(
      taskWorktree.worktreePath,
      git(taskWorktree.worktreePath, "rev-parse", "--git-common-dir"),
    );
    const validationCommonDir = path.resolve(
      validation.worktreePath,
      git(validation.worktreePath, "rev-parse", "--git-common-dir"),
    );
    assert.notEqual(validationCommonDir, sourceCommonDir);
    assert.equal(
      path.relative(path.dirname(run.integrationWorktree), validation.worktreePath).startsWith(".."),
      true,
    );
    assert.equal(await readFile(path.join(validation.worktreePath, "value.txt"), "utf8"), "after\n");

    git(validation.worktreePath, "config", "user.name", "Validation");
    git(validation.worktreePath, "config", "user.email", "validation@example.invalid");
    await writeFile(path.join(validation.worktreePath, "value.txt"), "validation commit\n", "utf8");
    git(validation.worktreePath, "add", "--all");
    git(validation.worktreePath, "commit", "-m", "validation-owned commit");
    git(validation.worktreePath, "reset", "--hard", "HEAD^");

    assert.deepEqual(await manager.worktreeState(taskWorktree.worktreePath), sourceState);
    assert.equal(await readFile(path.join(taskWorktree.worktreePath, "value.txt"), "utf8"), "after\n");
    await manager.removeValidation(run, validation);
    await manager.removeTask(run, taskWorktree);
    await manager.abandonRun(run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



// EX-G6-01. The verification snapshot is a fresh checkout of the source worktree's HEAD with
// the candidate's changes overlaid. The overlay enumerates `ls-files --cached --others`, and
// neither of those can name a path that is gone from the index and from the working tree at
// once — which is exactly what a staged deletion is. The path is never visited, HEAD's copy
// stays, and every check then runs against bytes the candidate removed.
test("a deletion the candidate staged stays deleted in the verification snapshot", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-validation-deletion-"));
  const repository = path.join(root, "repository");
  const storage = path.join(root, "storage");
  await mkdir(repository, { recursive: true });
  try {
    git(root, "init", repository);
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    await mkdir(path.join(repository, "src"), { recursive: true });
    await writeFile(path.join(repository, "src", "staged.txt"), "removed by the candidate\n", "utf8");
    await writeFile(path.join(repository, "src", "unstaged.txt"), "also removed\n", "utf8");
    await writeFile(path.join(repository, "src", "kept.txt"), "before\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "run-validation-deletion");
    const task = await manager.prepareTask(run, "TASK_DELETE");
    // One deletion staged, one left only in the working tree, and one file edited: all three
    // have to reach the snapshot as the candidate left them.
    git(task.worktreePath, "rm", "--quiet", "--", "src/staged.txt");
    await rm(path.join(task.worktreePath, "src", "unstaged.txt"));
    await writeFile(path.join(task.worktreePath, "src", "kept.txt"), "after\n", "utf8");

    const validation = await manager.prepareValidation(run, task.worktreePath, "deletion-check");
    assert.equal(
      existsSync(path.join(validation.worktreePath, "src", "staged.txt")),
      false,
      "a staged deletion was restored, so checks can read the bytes the candidate removed",
    );
    assert.equal(
      existsSync(path.join(validation.worktreePath, "src", "unstaged.txt")),
      false,
      "an unstaged deletion was restored",
    );
    assert.equal(
      await readFile(path.join(validation.worktreePath, "src", "kept.txt"), "utf8"),
      "after\n",
      "the candidate's edit did not reach the snapshot",
    );
    await manager.removeValidation(run, validation);
    await manager.removeTask(run, task);
    await manager.abandonRun(run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TODO lifecycle ownership quarantines instead of masking a completed run when release fails", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-owner-release-"));
  const quarantined = [];
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Complete safely",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    const broker = {
      ownerId: "owner-release-test",
      acquire: async ({ resources }) => {
        const lifecycle = resources.some((claim) => claim.key.startsWith("todo-orchestration-owner:"));
        return {
          id: lifecycle ? "lifecycle" : `lease-${Math.random()}`,
          resources,
          release: async () => {
            if (lifecycle) {
              throw new Error("simulated lifecycle release failure");
            }
          },
          quarantine: async (reason) => {
            if (lifecycle) {
              quarantined.push(reason);
            }
          },
        };
      },
      listQuarantine: () => [],
      clearQuarantine: () => 0,
      dispose: async () => undefined,
    };
    const controller = createController(root, repository, manager, { todoRetries: 0 }, broker);

    const result = await controller.start();
    assert.equal(result.status, "completed");
    assert.equal(quarantined.length, 1);
    assert.match(quarantined[0], /lifecycle owner release was not confirmed/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("separate controllers cannot own one repository orchestration at the same time", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-owner-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Hold orchestration ownership",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    let enteredResolve;
    let releaseResolve;
    const entered = new Promise((resolve) => { enteredResolve = resolve; });
    const release = new Promise((resolve) => { releaseResolve = resolve; });
    const manager = createFakeConversationManager(async () => {
      enteredResolve();
      await release;
      return completedPipeline();
    });
    const databasePath = path.join(root, "resources.sqlite");
    const firstBroker = createResourceBroker({
      databasePath,
      ownerId: "todo-owner-first",
      pollIntervalMs: 10,
    });
    const secondBroker = createResourceBroker({
      databasePath,
      ownerId: "todo-owner-second",
      pollIntervalMs: 10,
    });
    const values = { todoRetries: 0, todoOwnerTimeoutMs: 500, todoStopTimeoutMs: 1_000 };
    const first = createController(root, repository, manager, values, firstBroker);
    const second = createController(root, repository, manager, values, secondBroker);
    const running = first.start();
    await entered;

    await assert.rejects(second.start(), ResourceAcquireTimeoutError);
    const stopping = first.stop();
    releaseResolve();
    await stopping;
    const stopped = await running;
    assert.equal(stopped.status, "stopped");

    await Promise.all([first.dispose(), second.dispose()]);
    await Promise.all([firstBroker.dispose(), secondBroker.dispose()]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestrator claims startup before asynchronous preparation", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-start-claim-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Run once",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async () => completedPipeline());
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const first = controller.start();
    await assert.rejects(controller.start(), /already active/u);
    const result = await first;
    assert.equal(result.status, "completed");
    assert.equal(manager.rooms.size, 2);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TODO orchestration resolves each immutable task and Master snapshot once", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-pipeline-snapshots-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Update one",
      "  - Paths: src/one.txt",
      "  - Verify: none",
      "- [ ] [T2] Update two",
      "  - Paths: src/two.txt",
      "  - Verify: none",
      "",
    ].join("\n"), {
      "src/one.txt": "before-one\n",
      "src/two.txt": "before-two\n",
    });
    const taskSnapshot = pipelineSnapshotFor("todo-implementation");
    const changedTaskSnapshot = createPipelineSnapshot(
      { ...pipelineDefinitionFor("todo-implementation"), name: "Changed task pipeline" },
      "builtin",
    );
    const masterSnapshot = pipelineSnapshotFor("todo-master");
    const changedMasterSnapshot = createPipelineSnapshot(
      { ...pipelineDefinitionFor("todo-master"), name: "Changed Master pipeline" },
      "builtin",
    );
    let taskResolutionCount = 0;
    let masterResolutionCount = 0;
    const taskRuns = [];
    const masterRuns = [];
    const manager = createFakeConversationManager(
      async ({ options, runOptions }) => {
        taskRuns.push({ options, runOptions });
        const target = options.orchestrationTaskId === "T1" ? "one.txt" : "two.txt";
        await writeFile(path.join(options.workingDirectory, "src", target), `after-${target}\n`, "utf8");
        return completedPipeline();
      },
      async ({ runOptions }) => {
        masterRuns.push(runOptions);
        return masterPipeline();
      },
      async ({ pipelineId }) => {
        if (pipelineId === "todo-master") {
          masterResolutionCount += 1;
          return masterResolutionCount === 1 ? masterSnapshot : changedMasterSnapshot;
        }
        taskResolutionCount += 1;
        return taskResolutionCount === 1 ? taskSnapshot : changedTaskSnapshot;
      },
    );
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const result = await controller.start();

    assert.equal(result.status, "completed");
    assert.equal(taskResolutionCount, 1);
    assert.equal(masterResolutionCount, 1);
    assert.equal(taskRuns.length, 2);
    taskRuns.forEach(({ options, runOptions }) => {
      assert.equal(options.pipelineSnapshot.hash, taskSnapshot.hash);
      assert.equal(runOptions.pipelineSnapshot.hash, taskSnapshot.hash);
      assert.equal(runOptions.pipelineSnapshot.definition.name, taskSnapshot.definition.name);
    });
    assert.equal(masterRuns.length > 0, true);
    masterRuns.forEach((runOptions) => {
      assert.equal(runOptions.pipelineSnapshot.hash, masterSnapshot.hash);
      assert.equal(runOptions.pipelineSnapshot.definition.name, masterSnapshot.definition.name);
    });
    assert.equal(result.tasks.T1.spec.pipelineSnapshot.hash, taskSnapshot.hash);
    assert.equal(result.tasks.T2.spec.pipelineSnapshot.hash, taskSnapshot.hash);
    assert.equal(result.masterPipelineSnapshot.hash, masterSnapshot.hash);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task retries reuse the exact accepted task-pipeline snapshot", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-retry-snapshot-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Retry with one pipeline",
      "  - Paths: src/value.txt",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const acceptedSnapshot = pipelineSnapshotFor("todo-implementation");
    const changedSnapshot = createPipelineSnapshot(
      { ...pipelineDefinitionFor("todo-implementation"), name: "Changed during retry" },
      "builtin",
    );
    let taskResolutionCount = 0;
    const taskRuns = [];
    const manager = createFakeConversationManager(
      async ({ options, runOptions }) => {
        taskRuns.push({ options, runOptions });
        if (taskRuns.length === 1) {
          throw new Error("first attempt failed");
        }
        await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
        return completedPipeline();
      },
      async () => masterPipeline(),
      async ({ pipelineId }) => {
        if (pipelineId === "todo-master") {
          return pipelineSnapshotFor("todo-master");
        }
        taskResolutionCount += 1;
        return taskResolutionCount === 1 ? acceptedSnapshot : changedSnapshot;
      },
    );
    const controller = createController(root, repository, manager, { todoRetries: 1 });
    const result = await controller.start();

    assert.equal(result.status, "completed");
    assert.equal(taskResolutionCount, 1);
    assert.equal(taskRuns.length, 2);
    taskRuns.forEach(({ options, runOptions }) => {
      assert.equal(options.pipelineSnapshot.hash, acceptedSnapshot.hash);
      assert.equal(runOptions.pipelineSnapshot.hash, acceptedSnapshot.hash);
    });
    assert.equal(result.tasks.T1.spec.pipelineSnapshot.hash, acceptedSnapshot.hash);
    assert.equal(result.tasks.T1.attempts, 2);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume does not grant another attempt to a terminally failed task", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-retry-budget-"));
  let calls = 0;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Fail once",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async () => {
      calls += 1;
      throw new Error("persistent failure");
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const failed = await controller.start();
    assert.equal(failed.status, "failed");
    assert.equal(failed.tasks.T1.attempts, 1);
    assert.equal(calls, 1);
    const staleConversationId = failed.tasks.T1.conversationId;

    const resumed = await controller.resume();
    assert.equal(resumed.status, "failed");
    assert.equal(resumed.tasks.T1.attempts, 1);
    assert.equal(calls, 1);
    assert.equal(manager.closed.includes(staleConversationId), false);
    assert.equal(manager.rooms.has(staleConversationId), true);
    assert.equal(resumed.tasks.T1.conversationId, undefined);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume cleans stale worktrees and retains conversations for completed tasks", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-done-cleanup-"));
  let calls = 0;
  try {
    const repository = await createRepository(root, "# Existing TODO\n", {
      "src/value.txt": "before\n",
    });
    const manager = createFakeConversationManager(async ({ options }) => {
      calls += 1;
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "unfinished\n", "utf8");
      throw new Error("simulated interruption");
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const failed = await controller.startChecklist({
      workspaceRoot: repository,
      parentRunRef: "R23456789",
      parentConversationId: "R8765432A",
      title: "Cleanup recovery",
      pipelineId: "todo-implementation",
      pipelineSnapshot: pipelineSnapshotFor("todo-implementation"),
      issues: [{
        id: "TASK_A",
        title: "Task A",
        details: "Recover task A.",
        dependencies: [],
        paths: ["src/value.txt"],
      }],
      selectedIssueIds: ["TASK_A"],
      userNote: "",
      allowedPaths: ["src"],
      checks: [],
      allowNoChecks: true,
      retries: 0,
      maxConcurrency: 1,
    });
    assert.equal(failed.status, "failed");
    const taskState = failed.tasks.TASK_A;
    const staleWorktree = taskState.worktreePath;
    const staleBranch = taskState.branch;
    const staleConversationId = taskState.conversationId;
    taskState.status = "done";
    taskState.completedAt = new Date().toISOString();
    taskState.lastError = undefined;
    taskState.result = {
      status: "done",
      summary: "Persisted as complete before cleanup.",
      changedFiles: [],
      checks: [],
      blockers: [],
    };
    const store = createOrchestrationStore(path.join(root, "storage"));
    await store.save(failed);
    const archivedBefore = manager.archived.filter((id) => id === staleConversationId).length;

    const resumed = await controller.resume();
    assert.equal(resumed.status, "completed");
    assert.equal(calls, 1);
    assert.equal(manager.archived.filter((id) => id === staleConversationId).length, archivedBefore);
    assert.equal(manager.rooms.has(staleConversationId), true);
    assert.equal(resumed.tasks.TASK_A.conversationId, staleConversationId);
    await assert.rejects(readFile(path.join(staleWorktree, "src", "value.txt"), "utf8"), /ENOENT/u);
    assert.throws(
      () => git(repository, "show-ref", "--verify", `refs/heads/${staleBranch}`),
      /Command failed/u,
    );
    assert.equal(resumed.tasks.TASK_A.worktreePath, undefined);
    assert.equal(resumed.tasks.TASK_A.branch, undefined);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestration store rejects persisted commit-enabled task snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-store-no-commit-"));
  try {
    const storageRoot = path.join(root, "storage");
    const current = persistedLedger(storageRoot, [task("T1", ["src"])]);
    current.commitMode = "allow";
    current.tasks.T1.spec.pipelineSnapshot = commitEnabledPipelineSnapshotFor("todo-implementation");
    const store = createOrchestrationStore(storageRoot);
    await assert.rejects(Promise.resolve().then(() => store.save(current)), /pipelineSnapshot|commitMode/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("controller refuses a commit-enabled resolved snapshot before creating a task turn", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-resolved-no-commit-"));
  let modelCalls = 0;
  let controller;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Reject commit pipeline",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(
      async () => {
        modelCalls += 1;
        return completedPipeline();
      },
      undefined,
      async ({ pipelineId }) => commitEnabledPipelineSnapshotFor(pipelineId),
    );
    controller = createController(root, repository, manager, { todoRetries: 0 });
    await assert.rejects(controller.start(), /pipelineSnapshot|commitMode/u);
    assert.equal(modelCalls, 0);
    assert.equal(await readFile(path.join(repository, "src", "value.txt"), "utf8"), "before\n");
  } finally {
    await controller?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("abandon removes owned Git resources and retains orchestration conversations", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-abandon-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Fail then abandon",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "failed change\n", "utf8");
      throw new Error("fail before integration");
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const failed = await controller.start();
    assert.equal(failed.status, "failed");
    const integrationWorktree = failed.integrationWorktree;
    const integrationBranch = failed.integrationBranch;
    const taskBranch = failed.tasks.T1.branch;
    const taskConversationId = failed.tasks.T1.conversationId;
    const masterConversationId = failed.masterConversationId;

    await controller.abandon();
    await assert.rejects(readFile(path.join(integrationWorktree, "TODO.md"), "utf8"), /ENOENT/u);
    assert.throws(
      () => git(repository, "show-ref", "--verify", `refs/heads/${integrationBranch}`),
      /Command failed/u,
    );
    assert.throws(
      () => git(repository, "show-ref", "--verify", `refs/heads/${taskBranch}`),
      /Command failed/u,
    );
    assert.equal(manager.closed.includes(taskConversationId), false);
    assert.equal(manager.closed.includes(masterConversationId), false);
    assert.equal(manager.rooms.has(taskConversationId), true);
    assert.equal(manager.rooms.has(masterConversationId), true);
    const store = createOrchestrationStore(path.join(root, "storage"));
    assert.equal(await store.getActiveRun(), undefined);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("abandon preserves an invalid recovery pointer without touching Git resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-corrupt-pointer-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Keep repository untouched",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const storageRoot = path.join(root, "storage");
    const store = createOrchestrationStore(storageRoot);
    await mkdir(store.root, { recursive: true });
    await writeFile(
      path.join(store.root, "active-run.json"),
      JSON.stringify({ version: 1, runId: "../escape" }),
      "utf8",
    );
    const messages = [];
    const controller = createTodoOrchestrator({
      storageRoot,
      workspaceRoot: () => repository,
      isWorkspaceTrusted: () => true,
      configuration: () => ({ get: (_key, fallback) => fallback }),
      output: { appendLine: (message) => messages.push(message) },
      manager: createFakeConversationManager(async () => completedPipeline()),
    });

    await assert.rejects(
      controller.abandon(),
      /Cannot abandon invalid orchestration recovery state without verified Git ownership/u,
    );
    await assert.rejects(store.getActiveRun(), /Invalid orchestration run id/u);
    assert.equal(await readFile(path.join(repository, "src", "value.txt"), "utf8"), "before\n");
    assert.deepEqual(messages, [
      "Could not load retained TODO runs: Invalid orchestration run id: ../escape",
    ]);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("abandon preserves an invalid active ledger without touching Git resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-corrupt-ledger-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Keep repository untouched",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const storageRoot = path.join(root, "storage");
    const store = createOrchestrationStore(storageRoot);
    await store.setActiveRun("run-1");
    await mkdir(path.dirname(store.ledgerPath("run-1")), { recursive: true });
    await writeFile(store.ledgerPath("run-1"), "{not-json", "utf8");
    const messages = [];
    const controller = createTodoOrchestrator({
      storageRoot,
      workspaceRoot: () => repository,
      isWorkspaceTrusted: () => true,
      configuration: () => ({ get: (_key, fallback) => fallback }),
      output: { appendLine: (message) => messages.push(message) },
      manager: createFakeConversationManager(async () => completedPipeline()),
    });

    await assert.rejects(
      controller.abandon(),
      /Cannot abandon invalid orchestration recovery state without verified Git ownership/u,
    );
    assert.equal(await store.getActiveRun(), "run-1");
    assert.equal(await readFile(path.join(repository, "src", "value.txt"), "utf8"), "before\n");
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Ignored invalid orchestration ledger run-1/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TODO completion preserves CRLF line endings", () => {
  const source = [
    "- [ ] [T1] Preserve endings",
    "  - Paths: src",
    "  - Verify: none",
    "",
  ].join("\r\n");
  const parsed = parseTodoDocument("/workspace/TODO.md", source, {
    pipelineId: "todo-implementation",
    retries: 0,
  });
  const updated = markTodoTaskCompleted(source, parsed.tasks[0]);
  assert.equal(updated, source.replace("- [ ]", "- [x]"));
  assert.equal(/(^|[^\r])\n/u.test(updated), false);
});

test("orchestration store rejects paths, branches, cycles, and active pointers outside owned state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-store-validation-"));
  try {
    const store = createOrchestrationStore(root);
    const outside = persistedLedger(root, [task("T1", ["src"])]);
    outside.integrationWorktree = path.join(root, "outside", "integration");
    await assert.rejects(async () => store.save(outside), /integrationWorktree/u);

    const wrongTask = persistedLedger(root, [task("T1", ["src"])]);
    wrongTask.tasks.T1.worktreePath = path.join(
      root,
      "orchestration",
      "runs",
      "run-1",
      "tasks",
      "T2",
    );
    wrongTask.tasks.T1.branch = "bachata/task/run-1/T2";
    wrongTask.tasks.T1.baseCommit = "c".repeat(40);
    await assert.rejects(async () => store.save(wrongTask), /worktreePath|branch/u);

    const mixedTaskIdentity = persistedLedger(root, [task("T1", ["src"])]);
    mixedTaskIdentity.tasks.T1.worktreePath = path.join(
      root,
      "orchestration",
      "runs",
      "run-1",
      "tasks",
      "T1",
    );
    mixedTaskIdentity.tasks.T1.branch = `bachata/task/run-1/${taskStorageIdentity("T1")}`;
    mixedTaskIdentity.tasks.T1.baseCommit = "c".repeat(40);
    await assert.rejects(async () => store.save(mixedTaskIdentity), /branch/u);

    const cyclic = persistedLedger(root, [task("T1", ["src"], ["T2"]), task("T2", ["src2"], ["T1"])]);
    await assert.rejects(async () => store.save(cyclic), /dependency cycle/u);

    await mkdir(store.root, { recursive: true });
    await writeFile(path.join(store.root, "active-run.json"), JSON.stringify({ version: 1, runId: "../escape" }), "utf8");
    await assert.rejects(store.getActiveRun(), /Invalid orchestration run id/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orchestration store accepts pipeline identifiers with a leading underscore and preserves generated scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-store-generated-scope-"));
  try {
    const store = createOrchestrationStore(root);
    const current = persistedLedger(root, [task("T1", ["src"])]);
    current.sourceKind = "generatedChecklist";
    delete current.todoPath;
    delete current.todoSourceHash;
    current.generatedAllowedPaths = ["src"];
    current.tasks.T1.spec.pipelineId = "_private_pipeline";
    current.tasks.T1.spec.pipelineSnapshot = pipelineSnapshotFor("_private_pipeline");
    await store.save(current);
    const loaded = await store.load(current.runId);
    assert.equal(loaded.tasks.T1.spec.pipelineId, "_private_pipeline");
    assert.deepEqual(loaded.generatedAllowedPaths, ["src"]);

    const escaped = structuredClone(current);
    escaped.tasks.T1.spec.paths = ["tests"];
    await assert.rejects(
      async () => store.save(escaped),
      /exceeds persisted allowed paths/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume does not refund a completed failed attempt recorded as cancelled", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-cancelled-failure-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Do not retry",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const storageRoot = path.join(root, "storage");
    const worktrees = createWorktreeManager(storageRoot);
    const run = await worktrees.prepareRun(repository, "run-cancelled-failure");
    const integrationTree = await worktrees.integrationCommit(run);
    const parsed = parseTodoDocument(path.join(repository, "TODO.md"), await readFile(path.join(repository, "TODO.md"), "utf8"), {
      pipelineId: "todo-implementation",
      retries: 0,
    });
    const now = new Date().toISOString();
    const current = {
      version: 1,
      runId: "run-cancelled-failure",
      title: "[R23456789] Cancelled failure",
      status: "stopped",
      workspaceRoot: repository,
      ownerWorkspaceRoot: repository,
      sourceKind: "todoFile",
      todoPath: path.join(repository, "TODO.md"),
      todoSourceHash: "b".repeat(64),
      integrationBranch: run.integrationBranch,
      integrationWorktree: run.integrationWorktree,
      baselineCommit: run.baselineCommit,
      integrationTree,
      createdAt: now,
      updatedAt: now,
      maxConcurrency: 1,
      masterPipelineId: "todo-master",
      masterPipelineSnapshot: pipelineSnapshotFor("todo-master"),
      masterChecks: [],
      tasks: {
        T1: {
          spec: {
            ...parsed.tasks[0],
            pipelineSnapshot: pipelineSnapshotFor(parsed.tasks[0].pipelineId),
          },
          status: "cancelled",
          attempts: 1,
          completedAt: now,
          result: {
            status: "failed",
            summary: "Verification failed before stop.",
            changedFiles: [],
            checks: [],
            blockers: ["failed"],
          },
        },
      },
      finalChecks: [],
    };
    const store = createOrchestrationStore(storageRoot);
    await store.save(current);
    await store.setActiveRun(current.runId);
    let taskCalls = 0;
    const manager = createFakeConversationManager(async () => {
      taskCalls += 1;
      return completedPipeline();
    });
    const controller = createTodoOrchestrator({
      storageRoot,
      workspaceRoot: () => repository,
      isWorkspaceTrusted: () => true,
      configuration: () => ({ get: (_key, fallback) => fallback }),
      output: { appendLine: () => undefined },
      manager,
    });

    const resumed = await controller.resume();
    assert.equal(resumed.status, "failed");
    assert.equal(resumed.tasks.T1.status, "failed");
    assert.equal(resumed.tasks.T1.attempts, 1);
    assert.equal(taskCalls, 0);
    await controller.abandon();
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume rejects a persisted run owned by another workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-owner-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Owner check",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const storageRoot = path.join(root, "storage");
    const current = persistedLedger(storageRoot, [task("T1", ["src"])]);
    current.workspaceRoot = repository;
    current.todoPath = path.join(repository, "TODO.md");
    current.ownerWorkspaceRoot = path.join(root, "different-workspace");
    const store = createOrchestrationStore(storageRoot);
    await store.save(current);
    await store.setActiveRun(current.runId);
    const manager = createFakeConversationManager(async () => completedPipeline());
    const controller = createTodoOrchestrator({
      storageRoot,
      workspaceRoot: () => repository,
      isWorkspaceTrusted: () => true,
      configuration: () => ({ get: (_key, fallback) => fallback }),
      output: { appendLine: () => undefined },
      manager,
    });

    await assert.rejects(controller.resumeIfAvailable(), /belongs to a different workspace/u);
    assert.equal(manager.rooms.size, 0);
    assert.equal(await store.getActiveRun(), current.runId);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native orchestration checks do not inherit arbitrary extension secrets", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "bachata-command-environment-"));
  const previous = process.env.BACHATA_ORCHESTRATION_SECRET;
  process.env.BACHATA_ORCHESTRATION_SECRET = "must-not-leak";
  try {
    // This asserts environment isolation, not process latency. The ceiling only has to
    // exceed the time a loaded machine needs to start one Node process, so it is generous
    // enough that a slow start cannot turn an isolation check into a timeout.
    const result = await runCommand(
      `${shellNodeExecutable} -e "process.stdout.write(process.env.BACHATA_ORCHESTRATION_SECRET || '')"`,
      { cwd, timeoutMs: 120_000, maxOutputBytes: 10_000 },
    );
    assert.equal(result.timedOut ?? false, false, "the isolation check must complete, not time out");
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.stdout, "");
  } finally {
    if (previous === undefined) {
      delete process.env.BACHATA_ORCHESTRATION_SECRET;
    } else {
      process.env.BACHATA_ORCHESTRATION_SECRET = previous;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});

test("generated checklist execution enforces explicit checks, ids, and user-owned path scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-generated-boundaries-"));
  try {
    const repository = await createRepository(root, "# Existing TODO\n", {
      "src/a.txt": "before\n",
    });
    const manager = createFakeConversationManager(async () => completedPipeline());
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const request = {
      workspaceRoot: repository,
      parentRunRef: "R23456789",
      parentConversationId: "R8765432A",
      title: "Review src",
      pipelineId: "todo-implementation",
      pipelineSnapshot: pipelineSnapshotFor("todo-implementation"),
      issues: [
        {
          id: "ISSUE_A",
          title: "Fix A",
          details: "Update A.",
          dependencies: [],
          paths: ["src/a.txt"],
        },
      ],
      selectedIssueIds: ["ISSUE_A"],
      userNote: "",
      allowedPaths: ["src"],
      checks: [],
      allowNoChecks: false,
      retries: 0,
      maxConcurrency: 1,
    };
    await assert.rejects(controller.startChecklist(request), /requires user-authored checks/u);
    await assert.rejects(
      controller.startChecklist({
        ...request,
        allowNoChecks: true,
        issues: [{ ...request.issues[0], paths: ["tests/a.test.ts"] }],
      }),
      /exceeds the user-authored scope/u,
    );
    await assert.rejects(
      controller.startChecklist({
        ...request,
        allowNoChecks: true,
        issues: [{ ...request.issues[0], id: "ISSUE/A" }],
        selectedIssueIds: ["ISSUE/A"],
      }),
      /task id is invalid/u,
    );
    await assert.rejects(
      controller.startChecklist({
        ...request,
        allowNoChecks: true,
        issues: [{ ...request.issues[0], paths: ["C:\\outside"] }],
      }),
      process.platform === "win32" ? /Invalid generated task path/u : /exceeds the user-authored scope/u,
    );
    await assert.rejects(
      controller.startChecklist({
        ...request,
        allowNoChecks: true,
        issues: [{ ...request.issues[0], paths: ["C:/outside"] }],
      }),
      /Invalid generated task path/u,
    );
    await assert.rejects(
      controller.startChecklist({ ...request, allowNoChecks: true, allowedPaths: [] }),
      /requires at least one user-authored allowed path/u,
    );
    assert.equal(manager.rooms.size, 0);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generated checklist execution rejects a different Git repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-generated-repository-owner-"));
  try {
    const ownerRepository = await createRepository(path.join(root, "owner"), "# Owner\n", {
      "src/value.txt": "owner\n",
    });
    const targetRepository = await createRepository(path.join(root, "target"), "# Target\n", {
      "src/value.txt": "target\n",
    });
    const manager = createFakeConversationManager(async () => completedPipeline());
    const controller = createController(root, ownerRepository, manager, { todoRetries: 0 });

    await assert.rejects(
      controller.startChecklist({
        workspaceRoot: targetRepository,
        parentRunRef: "R23456789",
        parentConversationId: "R8765432A",
        title: "Wrong repository",
        pipelineId: "todo-implementation",
        pipelineSnapshot: pipelineSnapshotFor("todo-implementation"),
        issues: [{
          id: "TASK_A",
          title: "Task A",
          details: "Update A.",
          dependencies: [],
          paths: ["src/value.txt"],
        }],
        selectedIssueIds: ["TASK_A"],
        userNote: "",
        allowedPaths: ["src"],
        checks: [],
        allowNoChecks: true,
        retries: 0,
        maxConcurrency: 1,
      }),
      /repository does not match the current workspace repository/u,
    );
    assert.equal(manager.rooms.size, 0);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resume rejects a ledger redirected to another Git repository before restore", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-resume-repository-owner-"));
  try {
    const ownerRepository = await createRepository(path.join(root, "owner"), "# Owner\n", {
      "src/value.txt": "owner\n",
    });
    const targetRepository = await createRepository(path.join(root, "target"), "# Target\n", {
      "src/value.txt": "target\n",
    });
    const manager = createFakeConversationManager(async () => {
      throw new Error("leave recoverable state");
    });
    const controller = createController(root, ownerRepository, manager, { todoRetries: 0 });
    const failed = await controller.startChecklist({
      workspaceRoot: ownerRepository,
      parentRunRef: "R23456789",
      parentConversationId: "R8765432A",
      title: "Recoverable run",
      pipelineId: "todo-implementation",
      pipelineSnapshot: pipelineSnapshotFor("todo-implementation"),
      issues: [{
        id: "TASK_A",
        title: "Task A",
        details: "Update A.",
        dependencies: [],
        paths: ["src/value.txt"],
      }],
      selectedIssueIds: ["TASK_A"],
      userNote: "",
      allowedPaths: ["src"],
      checks: [],
      allowNoChecks: true,
      retries: 0,
      maxConcurrency: 1,
    });
    assert.equal(failed.status, "failed");
    const store = createOrchestrationStore(path.join(root, "storage"));
    const redirected = await store.load(failed.runId);
    redirected.workspaceRoot = targetRepository;
    await store.save(redirected);
    const integrationHeadBefore = git(ownerRepository, "rev-parse", redirected.integrationBranch);

    await assert.rejects(
      controller.resumeIfAvailable(),
      /repository does not match the current workspace repository/u,
    );
    assert.equal(git(ownerRepository, "rev-parse", redirected.integrationBranch), integrationHeadBefore);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("abandon persists cleanup intent before Git deletion and startup reconciliation completes it", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-abandon-reconcile-"));
  const gate = createMutationGate();
  let secondController;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Fail and reconcile abandon",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "failed change\n", "utf8");
      throw new Error("fail before integration");
    });
    const firstController = createController(
      root,
      repository,
      manager,
      { todoRetries: 0 },
      undefined,
      { withWorkspaceMutation: gate.run },
    );
    const failed = await firstController.start();
    assert.equal(failed.status, "failed");
    const integrationWorktree = failed.integrationWorktree;
    const taskWorktree = failed.tasks.T1.worktreePath;

    gate.failBefore(2, new Error("Simulated final abandon persistence failure"));
    await assert.rejects(
      firstController.abandon(),
      /Simulated final abandon persistence failure/u,
    );

    await assert.rejects(readFile(path.join(integrationWorktree, "TODO.md"), "utf8"), /ENOENT/u);
    if (taskWorktree) {
      await assert.rejects(readFile(path.join(taskWorktree, "TODO.md"), "utf8"), /ENOENT/u);
    }
    const store = createOrchestrationStore(path.join(root, "storage"));
    const pending = await store.load(failed.runId);
    assert.equal(pending.status, "abandoning");
    assert.equal(await store.getActiveRun(), failed.runId);
    assert.equal(firstController.getSnapshot().run.status, "abandoning");
    await firstController.dispose();

    secondController = createController(root, repository, manager, { todoRetries: 0 });
    assert.equal(await secondController.resumeIfAvailable(), undefined);
    const reconciled = await store.load(failed.runId);
    assert.equal(reconciled.status, "abandoned");
    assert.equal(reconciled.tasks.T1.worktreePath, undefined);
    assert.equal(reconciled.tasks.T1.branch, undefined);
    assert.equal(await store.getActiveRun(), undefined);
    assert.equal(secondController.getSnapshot().run, undefined);
  } finally {
    await secondController?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("retained cleanup persists intent before Git deletion and restart removes the pending ledger", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-retained-reconcile-"));
  const gate = createMutationGate();
  let secondController;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Complete and reconcile cleanup",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    const firstController = createController(
      root,
      repository,
      manager,
      { todoRetries: 0 },
      undefined,
      { withWorkspaceMutation: gate.run },
    );
    const completed = await firstController.start();
    assert.equal(completed.status, "completed");

    gate.failBefore(2, new Error("Simulated retained-ledger removal failure"));
    await assert.rejects(
      firstController.cleanupRetained(completed.runId),
      /Simulated retained-ledger removal failure/u,
    );

    await assert.rejects(
      readFile(path.join(completed.integrationWorktree, "TODO.md"), "utf8"),
      /ENOENT/u,
    );
    const store = createOrchestrationStore(path.join(root, "storage"));
    const pending = await store.load(completed.runId);
    assert.equal(pending.status, "cleanupPending");
    assert.deepEqual(
      firstController.getSnapshot().retainedRuns.map((run) => [run.runId, run.status]),
      [[completed.runId, "cleanupPending"]],
    );
    await firstController.dispose();

    secondController = createController(root, repository, manager, { todoRetries: 0 });
    assert.equal(await secondController.resumeIfAvailable(), undefined);
    assert.deepEqual(secondController.getSnapshot().retainedRuns, []);
    assert.deepEqual(await store.listRunIds(), []);
    assert.equal(await store.getActiveRun(), undefined);
  } finally {
    await secondController?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("TODO Git preflight allows only the selected custom-pipeline catalog", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-worktree-preflight-catalog-"));
  try {
    const repository = await createRepository(root, "# TODO\n", {
      "src/value.txt": "clean\n",
    });
    const catalogDirectory = path.join(repository, ".bachata", "pipelines");
    await mkdir(catalogDirectory, { recursive: true });
    await writeFile(
      path.join(catalogDirectory, "custom.pipeline.json"),
      "{}\n",
      "utf8",
    );
    const manager = createWorktreeManager(path.join(root, "storage"));
    await manager.preflightRun(repository, [catalogDirectory]);
    await assert.rejects(
      manager.preflightRun(repository),
      /Dirty paths: \.bachata\/pipelines\/custom\.pipeline\.json/u,
    );
    await writeFile(path.join(repository, "src", "value.txt"), "dirty\n", "utf8");
    await assert.rejects(
      manager.preflightRun(repository, [catalogDirectory]),
      /Dirty paths: src\/value\.txt/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TODO Git preflight allows tracked catalog edits but rejects renames leaving that catalog", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-worktree-preflight-rename-"));
  try {
    const repository = await createRepository(root, "# TODO\n", {
      ".bachata/pipelines/custom.pipeline.json": "{\"name\":\"original\"}\n",
      "src/value.txt": "clean\n",
    });
    const catalogDirectory = path.join(repository, ".bachata", "pipelines");
    const source = path.join(catalogDirectory, "custom.pipeline.json");
    const destination = path.join(repository, "src", "custom.pipeline.json");
    const manager = createWorktreeManager(path.join(root, "storage"));
    await writeFile(source, "{\"name\":\"changed\"}\n", "utf8");
    await manager.preflightRun(repository, [catalogDirectory]);
    git(repository, "checkout", "--", ".bachata/pipelines/custom.pipeline.json");
    await rename(source, destination);
    git(repository, "add", "--all");
    await assert.rejects(
      manager.preflightRun(repository, [catalogDirectory]),
      /src\/custom\.pipeline\.json/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TODO readiness reports the full orchestration preflight", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-todo-readiness-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Implement value",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async () => completedPipeline());
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    try {
      scopeResolutions.length = 0;
      const ready = await controller.inspectStartReadiness();
      assert.equal(ready.status, "ready");
      assert.ok(scopeResolutions.length >= 2);
      assert.ok(scopeResolutions.every((entry) => entry.pipelineScopeRoot === repository));
      assert.deepEqual(
        scopeResolutions.map((entry) => entry.pipelineId).sort(),
        ["todo-implementation", "todo-master"],
      );
      assert.equal(ready.contract.todoFile, "TODO.md");
      assert.deepEqual(ready.contract.taskIds, ["T1"]);
      assert.deepEqual(ready.contract.taskPipelineIds, ["todo-implementation"]);
      assert.equal(ready.contract.masterPipelineId, "todo-master");
      assert.deepEqual(ready.contract.writablePaths, ["src"]);
      assert.equal(ready.contract.commitPolicy, "never");
      // What the person confirms has to name the exemption: the dependency directories are
      // shared with their checkout, so a write through one lands outside everything the run
      // can show them, take back, or apply.
      assert.match(ready.contract.isolation, /node_modules, \.venv, venv and vendor are shared/u);
      assert.match(ready.contract.isolation, /not undone by abandoning the run/u);
      assert.ok(ready.contract.completion.some((entry) => entry.includes("TODO.md")));
      assert.ok(ready.findings.some((finding) => finding.id === "todo.tasks" && finding.status === "ready"));
      assert.ok(ready.findings.some((finding) => finding.id === "todo.git" && finding.status === "ready"));

      await writeFile(path.join(repository, "src", "value.txt"), "dirty\n", "utf8");
      const dirty = await controller.inspectStartReadiness();
      assert.equal(dirty.status, "blocked");
      assert.match(
        dirty.findings.find((finding) => finding.id === "todo.git").detail,
        /must be clean/u,
      );

      await rm(path.join(repository, "TODO.md"));
      const missing = await controller.inspectStartReadiness();
      assert.equal(missing.status, "blocked");
      const missingTasks = missing.findings.find((finding) => finding.id === "todo.tasks");
      assert.equal(missingTasks.status, "blocked");
      assert.equal(missingTasks.label, "TODO.md");
    } finally {
      await controller.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("TODO readiness blocks when the TODO root lacks a task pipeline another root provides", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-todo-scope-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Implement value",
      "  - Paths: src",
      "  - Pipeline: root-scoped-task",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const otherRoot = path.join(root, "other-root");

    const manager = createFakeConversationManager(
      async () => completedPipeline(),
      async () => masterPipeline(),
      async ({ pipelineScopeRoot, pipelineId }) => {
        if (pipelineId === "root-scoped-task" && pipelineScopeRoot !== repository) {
          throw new Error(`Unknown pipeline: ${pipelineId}`);
        }
        return pipelineSnapshotFor(pipelineId === "root-scoped-task" ? "todo-implementation" : pipelineId);
      },
    );

    const controller = createController(root, repository, manager, { todoRetries: 0 });
    try {
      const ready = await controller.inspectStartReadiness();
      const pipelineFinding = ready.findings.find(
        (finding) => finding.id === "todo.pipeline.root-scoped-task",
      );
      assert.equal(pipelineFinding.status, "ready");
      assert.equal(ready.status, "ready");
    } finally {
      await controller.dispose();
    }

    const strayManager = createFakeConversationManager(
      async () => completedPipeline(),
      async () => masterPipeline(),
      async ({ pipelineScopeRoot, pipelineId }) => {
        if (pipelineId === "root-scoped-task" && pipelineScopeRoot !== otherRoot) {
          throw new Error(`Unknown pipeline: ${pipelineId}`);
        }
        return pipelineSnapshotFor("todo-implementation");
      },
    );
    const strayController = createController(root, repository, strayManager, { todoRetries: 0 });
    try {
      const blocked = await strayController.inspectStartReadiness();
      const pipelineFinding = blocked.findings.find(
        (finding) => finding.id === "todo.pipeline.root-scoped-task",
      );
      assert.equal(pipelineFinding.status, "needsSetup");
      assert.match(pipelineFinding.detail, /Unknown pipeline: root-scoped-task/u);
      assert.equal(blocked.status, "needsSetup");
    } finally {
      await strayController.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a retained recheck verifies the exported bytes, not the mutable worktree", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-recheck-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Retained recheck",
      "  - Paths: src",
      "  - Verify: bachata:workspace-integrity",
      "  - Verify Final: bachata:project-checks",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const run = await controller.start();
    assert.equal(run.status, "completed");

    await writeFile(path.join(run.integrationWorktree, "src", "value.txt"), "corrupted   \n", "utf8");

    const rechecked = await controller.rerunRetainedChecks(run.runId);
    assert.deepEqual(
      rechecked.map((check) => check.command).sort(),
      ["bachata:project-checks", "bachata:workspace-integrity"],
      "a recheck must run every recorded command, not the final checks alone",
    );
    rechecked.forEach((check) => {
      assert.equal(
        check.status,
        "passed",
        `${check.command} judged the mutated worktree instead of the exported bytes: ${check.stderr}`,
      );
    });
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial selection is verified against exactly the bytes it would stage", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-selection-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Move both sides together",
      "  - Paths: src",
      "  - Verify: none",
      "  - Verify Final: bachata:verifier:bachata-consistency",
      "",
    ].join("\n"), {
      "src/version.txt": "1\n",
      "src/expected.txt": "1\n",
      "tools/check-consistency.mjs": [
        'import { readFile } from "node:fs/promises";',
        'const left = (await readFile("src/version.txt", "utf8")).trim();',
        'const right = (await readFile("src/expected.txt", "utf8")).trim();',
        'if (left !== right) {',
        '  console.error(`version ${left} does not match expected ${right}`);',
        '  process.exit(1);',
        '}',
        'console.log("consistent");',
        "",
      ].join("\n"),
      ".bachata/verifiers.json": `${JSON.stringify({
        version: 1,
        verifiers: [{
          id: "bachata-consistency",
          description: "src/version.txt and src/expected.txt must move together",
          executable: process.execPath,
          args: ["tools/check-consistency.mjs"],
          workingDirectory: ".",
          timeoutMs: 60_000,
          maxOutputBytes: 65_536,
          expect: { exitCode: 0 },
        }],
      }, undefined, 2)}\n`,
    });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "version.txt"), "2\n", "utf8");
      await writeFile(path.join(options.workingDirectory, "src", "expected.txt"), "2\n", "utf8");
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 }, undefined, {
      approvedRepositoryVerifiers: () => true,
    });
    const improved = await controller.improve();
    const run = improved.ledger;
    assert.equal(improved.path, "existingTodo");
    assert.equal(run.status, "completed", run.error ?? "");

    const whole = await controller.verifyRetainedSelection(run.runId, {
      paths: ["src/version.txt", "src/expected.txt"],
    });
    assert.deepEqual(whole.map((check) => check.status), ["passed"]);

    const subset = await controller.verifyRetainedSelection(run.runId, { paths: ["src/version.txt"] });
    assert.deepEqual(
      subset.map((check) => check.status),
      ["failed"],
      "a subset that breaks a dependency the whole run satisfied was reported as verified",
    );
    assert.match(subset[0].stderr, /version 2 does not match expected 1/u);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-G6-08. The approval a person gave names the descriptor set they saw. The registry these
// checks read comes out of the run's own worktree, which a task can rewrite, and comparing that
// file against itself proves nothing, so the digest travels from the stored approval with the
// authority. Without it the enforcement in the command runner never fires.
test("an approved run refuses a registry that differs from the approved descriptor set", gitWorktreeSkip, async () => {
  const source = [
    "- [ ] [T1] Move the value",
    "  - Paths: src",
    "  - Verify: none",
    "  - Verify Final: bachata:verifier:bachata-consistency",
    "",
  ].join("\n");
  const files = {
    "src/value.txt": "before\n",
    "tools/check-consistency.mjs": 'console.log("consistent");\n',
    ".bachata/verifiers.json": `${JSON.stringify({
      version: 1,
      verifiers: [{
        id: "bachata-consistency",
        description: "A benign repository check",
        executable: process.execPath,
        args: ["tools/check-consistency.mjs"],
        workingDirectory: ".",
        timeoutMs: 60_000,
        maxOutputBytes: 65_536,
        expect: { exitCode: 0 },
      }],
    }, undefined, 2)}\n`,
  };
  const writingWorker = () => async ({ options }) => {
    await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
    return completedPipeline();
  };

  const otherRoot = await mkdtemp(path.join(os.tmpdir(), "bachata-verifier-digest-other-"));
  try {
    const repository = await createRepository(otherRoot, source, files);
    const manager = createFakeConversationManager(writingWorker());
    // An approval recorded for a different descriptor set: what a teammate's commit, a branch
    // checkout or a merge leaves behind.
    const controller = createController(otherRoot, repository, manager, { todoRetries: 0 }, undefined, {
      approvedRepositoryVerifiers: () => ({
        approved: true,
        registryDigest: verifierRegistryDigest(undefined),
      }),
    });
    const run = (await controller.improve()).ledger;
    assert.equal(run.repositoryVerifierAuthority, "humanApproved");
    assert.equal(run.status, "failed");
    assert.match(
      run.error ?? "",
      /declares a different set of checks from the one that was approved/u,
    );
    await controller.dispose();
  } finally {
    await rm(otherRoot, { recursive: true, force: true });
  }

  const sameRoot = await mkdtemp(path.join(os.tmpdir(), "bachata-verifier-digest-same-"));
  try {
    const repository = await createRepository(sameRoot, source, files);
    const manager = createFakeConversationManager(writingWorker());
    const approved = verifierRegistryDigest((await loadVerifierRegistry(repository)).registry);
    const controller = createController(sameRoot, repository, manager, { todoRetries: 0 }, undefined, {
      approvedRepositoryVerifiers: () => ({ approved: true, registryDigest: approved }),
    });
    const run = (await controller.improve()).ledger;
    assert.equal(run.status, "completed", run.error ?? "");
    assert.deepEqual(
      run.finalChecks.map((check) => `${check.command}:${check.status}`),
      ["bachata:verifier:bachata-consistency:passed"],
      "the approved descriptor set was refused against its own digest",
    );
    await controller.dispose();
  } finally {
    await rm(sameRoot, { recursive: true, force: true });
  }
});

// The links are what let a fresh worktree run checks at all, and they leave the worktree: the
// run has to name them, or its record claims an isolation it does not have.
test("a run records the dependency directories its tasks shared with the repository", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-run-shared-dependencies-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Move the value",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), {
      ".gitignore": "node_modules\n",
      "src/value.txt": "before\n",
    });
    await mkdir(path.join(repository, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(repository, "node_modules", ".bin", "check"), "fixture\n", "utf8");
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const run = await controller.start();
    assert.equal(run.status, "completed", run.error ?? "");
    assert.deepEqual(
      run.tasks.T1.sharedDependencies,
      ["node_modules"],
      "the run record does not name what its task worktree shared with the repository",
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-G6-05 / EX-A5-R12. `runLoop`'s failure branch used to mark the run failed and remove its
// worktrees while sibling tasks were still driving providers into them. Two awaits in
// `executeTask` sit outside its provider `try` and reject the whole task promise: the worktree
// removal at the top of a retry attempt, and every save on a terminal branch.
// `beforeOrchestrationOperation` is the seam that makes one of them fail at a chosen moment
// without also failing `runLoop`'s own trailing save, which filesystem sabotage could not do.
test("an orchestration operation that rejects while a sibling runs drains it before the run is closed out", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-undrained-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Fast task",
      "  - Paths: src/fast.txt",
      "  - Verify: none",
      "",
      "- [ ] [T2] Slow sibling",
      "  - Paths: src/slow.txt",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/fast.txt": "1\n", "src/slow.txt": "1\n" });

    const events = [];
    let siblingStarted = () => undefined;
    const siblingHasStarted = new Promise((resolve) => { siblingStarted = resolve; });
    // The sibling must still be running at the exact moment T1's retry removal rejects the run, so
    // the drain path is what keeps its worktree alive. A fixed sleep raced that moment under load
    // (a slow retry could finish after the timer); block on the removal instead so the ordering is
    // deterministic without weakening what the test proves.
    let removalRejected = () => undefined;
    const removalHasRejected = new Promise((resolve) => { removalRejected = resolve; });
    const manager = createFakeConversationManager(async ({ options }) => {
      if (options.orchestrationTaskId === "T2") {
        events.push("sibling:start");
        siblingStarted();
        await removalHasRejected;
        // Still writing into the run's worktree. If cleanup has already run, it is gone.
        events.push(
          existsSync(options.workingDirectory) ? "sibling:end" : "sibling:end-worktree-removed",
        );
        await writeFile(path.join(options.workingDirectory, "src", "slow.txt"), "2\n", "utf8");
        return completedPipeline();
      }
      await siblingHasStarted;
      events.push("fast:end");
      // The first attempt fails, so the second one begins by removing this task's worktree.
      throw new Error("first attempt failed");
    });

    const controller = createController(
      root,
      repository,
      manager,
      { todoRetries: 1, todoMaxConcurrency: 2 },
      undefined,
      {
        beforeOrchestrationOperation: (operation, detail) => {
          // The worktree removal at the top of T1's retry attempt. It is outside `executeTask`'s
          // provider `try`, so it rejects the task promise itself rather than becoming a failed
          // task, and `Promise.race(active.values())` rejects with T2 still in `active`.
          if (operation === "removeTask" && detail.taskId === "T1") {
            // Release the sibling only now: it stays active through the removal rejection, so the
            // run must drain it rather than tear its worktree out from under it.
            removalRejected();
            throw new Error("run worktree store rejected the removal");
          }
        },
      },
    );
    const run = await controller.start();
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /run worktree store rejected the removal/u);
    assert.deepEqual(
      events.filter((entry) => entry.startsWith("sibling:end")),
      ["sibling:end"],
      "the run was closed out before its sibling stopped writing, or its worktrees were removed under it",
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-A5-R01. A retained run's checks ran against one state of the receiving branch. A patch that
// still applies cleanly says nothing about everything outside it, so a branch that moved after the
// checks is a composition this run has no evidence about at all.
test("applying a verified run refuses a receiving branch that moved after the checks ran", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-target-drift-"));
  try {
    // EX-A5-R01 residue. The verifier records every invocation outside the repository, so "no
    // checks ran" is a fact this test can read rather than an absence of output.
    const invocationLog = path.join(root, "verifier-invocations.log");
    const repository = await createRepository(root, [
      "- [ ] [T1] Raise the consumer",
      "  - Paths: src/consumer.txt",
      "  - Verify: none",
      "  - Verify Final: bachata:verifier:bachata-budget",
      "",
    ].join("\n"), {
      "src/consumer.txt": "1\n",
      "src/dependency.txt": "5\n",
      "tools/check-budget.mjs": [
        'import { appendFileSync } from "node:fs";',
        'import { readFile } from "node:fs/promises";',
        'appendFileSync(process.argv[2], "ran\\n");',
        'const consumer = Number((await readFile("src/consumer.txt", "utf8")).trim());',
        'const dependency = Number((await readFile("src/dependency.txt", "utf8")).trim());',
        'if (consumer > dependency) {',
        '  console.error(`consumer ${consumer} exceeds dependency ${dependency}`);',
        '  process.exit(1);',
        '}',
        'console.log("within budget");',
        "",
      ].join("\n"),
      ".bachata/verifiers.json": `${JSON.stringify({
        version: 1,
        verifiers: [{
          id: "bachata-budget",
          description: "src/consumer.txt must not exceed src/dependency.txt",
          executable: process.execPath,
          args: ["tools/check-budget.mjs", invocationLog],
          workingDirectory: ".",
          timeoutMs: 60_000,
          maxOutputBytes: 65_536,
          expect: { exitCode: 0 },
        }],
      }, undefined, 2)}\n`,
    });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "consumer.txt"), "4\n", "utf8");
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 }, undefined, {
      approvedRepositoryVerifiers: () => true,
    });
    const improved = await controller.improve();
    const run = improved.ledger;
    assert.equal(improved.path, "existingTodo");
    assert.equal(run.status, "completed", run.error ?? "");

    const checks = await controller.rerunRetainedChecks(run.runId);
    assert.deepEqual(checks.map((check) => check.status), ["passed"]);

    // Somebody else lowers the dependency on the receiving branch. Nothing in this run's patch
    // touches that file, so the patch still applies cleanly and the checks are none the wiser.
    await writeFile(path.join(repository, "src", "dependency.txt"), "2\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "lower the dependency");

    await assert.rejects(
      controller.applyRetained(run.runId),
      /verified against a different state of the receiving branch/u,
      "work verified against an older branch state was applied to the moved branch",
    );
    assert.equal(
      readFileSync(path.join(repository, "src", "consumer.txt"), "utf8"),
      "1\n",
      "a refused Apply wrote to the working tree anyway",
    );

    // EX-A5-R01 residue, reopened. A recheck cannot rescue this, and it may not pretend to. Its
    // validation tree is composed on the commit the run started from — `prepareExportValidation`
    // fetches exactly `baselineCommit` and checks it out — so re-running the checks re-verifies
    // the old composition and labels the result with the branch's new HEAD. That is why the old
    // behaviour passed here: the candidate raises the consumer to 4 against a dependency the
    // branch has since lowered to 2, and the composition it actually ran cannot see it. It
    // refuses now, before anything is composed, acquired or run.
    const invocationsBefore = readFileSync(invocationLog, "utf8");
    await assert.rejects(
      controller.rerunRetainedChecks(run.runId),
      /Rebase this work onto the branch and start a new run/u,
      "a recheck composed on the run's own baseline ran against a branch that had moved",
    );
    assert.equal(
      readFileSync(invocationLog, "utf8"),
      invocationsBefore,
      "a refused recheck ran its checks anyway",
    );

    // Nothing was recorded and nothing relabelled: back on the branch the run was authorized
    // against, the run's original evidence is what authorizes Apply.
    git(repository, "reset", "--hard", run.baselineCommit);
    const applied = await controller.applyRetained(run.runId);
    assert.equal(applied.applied, true, applied.reason ?? "");
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-A5-R01. The receiving HEAD is read before the checks are composed, again after they finish
// and again immediately before the evidence is written, and evidence is recorded only when all
// three agree. A branch that moves *while* the checks run leaves them evidence about a
// composition that no longer exists, and relabelling them with the HEAD the branch has reached
// would hand Apply a verification of somebody else's commit.
test("a receiving branch that moves while the checks run records no evidence at all", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-target-during-"));
  try {
    const repository = path.join(root, "repository");
    const created = await createRepository(root, [
      "- [ ] [T1] Raise the consumer",
      "  - Paths: src/consumer.txt",
      "  - Verify: none",
      "  - Verify Final: bachata:verifier:bachata-mover",
      "",
    ].join("\n"), {
      "src/consumer.txt": "1\n",
      // The check itself is what moves the branch, which is the only way to be inside the window
      // rather than beside it: it commits to the receiving repository and then passes.
      "tools/move-branch.mjs": [
        'import { execFileSync } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        `const repository = ${JSON.stringify(repository)};`,
        'const run = (...args) => execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });',
        'writeFileSync(`${repository}/src/unrelated.txt`, `${Date.now()}\n`);',
        'run("add", "--all");',
        'run("-c", "user.name=Other", "-c", "user.email=other@example.invalid", "commit", "-m", "someone else commits");',
        'console.log("moved");',
        "",
      ].join("\n"),
      ".bachata/verifiers.json": `${JSON.stringify({
        version: 1,
        verifiers: [{
          id: "bachata-mover",
          description: "moves the receiving branch while it runs",
          executable: process.execPath,
          args: ["tools/move-branch.mjs"],
          workingDirectory: ".",
          timeoutMs: 60_000,
          maxOutputBytes: 65_536,
          expect: { exitCode: 0 },
        }],
      }, undefined, 2)}\n`,
    });
    assert.equal(created, repository);
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "consumer.txt"), "4\n", "utf8");
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 }, undefined, {
      approvedRepositoryVerifiers: () => true,
    });
    const improved = await controller.improve();
    const run = improved.ledger;
    assert.equal(run.status, "completed", run.error ?? "");
    const headAfterRun = git(repository, "rev-parse", "HEAD");

    // The run's own final checks moved the branch, so nothing they proved may be recorded.
    assert.equal(
      (run.retainedEvidence ?? []).length,
      0,
      "checks that moved the branch underneath themselves were recorded as evidence",
    );

    // EX-A5-R01 residue. While the branch is still where the run's own checks left it, a recheck
    // is refused before it composes anything at all: the tree it would build is the run's
    // baseline, not the branch as it stands.
    await assert.rejects(
      controller.rerunRetainedChecks(run.runId),
      /Rebase this work onto the branch and start a new run/u,
      "a recheck was composed against a branch its tree cannot represent",
    );

    // Back on the commit the run was authorized against, the recheck is composable — and now the
    // only thing that moves the branch is the check itself, which is the window under test.
    git(repository, "reset", "--hard", run.baselineCommit);
    await assert.rejects(
      controller.rerunRetainedChecks(run.runId),
      /receiving branch moved from [0-9a-f]{12} to [0-9a-f]{12} while its checks were running/u,
      "a recheck the branch moved underneath was recorded anyway",
    );
    // Apply has nothing to stand on, and says so in the words that name the missing verification
    // rather than in the words that name a moved branch: a refused recheck wrote no evidence.
    await assert.rejects(
      controller.applyRetained(run.runId),
      /no complete passing verification/u,
    );
    assert.notEqual(
      git(repository, "rev-parse", "HEAD"),
      headAfterRun,
      "the check never moved the branch, so nothing was proved",
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-A5-R01 residue. Two facts about the label a run's evidence carries. It names the commit the
// validation tree is actually composed on, because `prepareExportValidation` fetches
// `baselineCommit` and checks it out; and the reading taken immediately before the record is
// written closes the one remaining window, between the last check finishing and the write.
test("retained evidence names the composed commit, and a branch moving before the write records nothing", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-target-before-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Raise the consumer",
      "  - Paths: src/consumer.txt",
      "  - Verify: none",
      "  - Verify Final: bachata:verifier:bachata-budget",
      "",
    ].join("\n"), {
      "src/consumer.txt": "1\n",
      "src/dependency.txt": "5\n",
      "tools/check-budget.mjs": [
        'import { readFile } from "node:fs/promises";',
        'const consumer = Number((await readFile("src/consumer.txt", "utf8")).trim());',
        'const dependency = Number((await readFile("src/dependency.txt", "utf8")).trim());',
        'if (consumer > dependency) {',
        '  console.error(`consumer ${consumer} exceeds dependency ${dependency}`);',
        '  process.exit(1);',
        '}',
        'console.log("within budget");',
        "",
      ].join("\n"),
      ".bachata/verifiers.json": `${JSON.stringify({
        version: 1,
        verifiers: [{
          id: "bachata-budget",
          description: "src/consumer.txt must not exceed src/dependency.txt",
          executable: process.execPath,
          args: ["tools/check-budget.mjs"],
          workingDirectory: ".",
          timeoutMs: 60_000,
          maxOutputBytes: 65_536,
          expect: { exitCode: 0 },
        }],
      }, undefined, 2)}\n`,
    });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "consumer.txt"), "4\n", "utf8");
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 }, undefined, {
      approvedRepositoryVerifiers: () => true,
    });
    const improved = await controller.improve();
    const run = improved.ledger;
    assert.equal(run.status, "completed", run.error ?? "");
    const recorded = (run.retainedEvidence ?? [])[0];
    assert.equal(
      recorded?.target,
      run.baselineCommit,
      "the evidence names a commit its validation tree was never composed on",
    );
    assert.equal(git(repository, "rev-parse", "HEAD"), run.baselineCommit);
    await controller.dispose();

    // The window the second reading exists for: after the checks have finished and before the
    // record is written. The hook stands in it, and moves the branch from there.
    let moved = 0;
    const persisting = createController(root, repository, manager, { todoRetries: 0 }, undefined, {
      approvedRepositoryVerifiers: () => true,
      beforeOrchestrationOperation: (operation) => {
        if (operation !== "retainedEvidence" || moved > 0) return;
        moved += 1;
        writeFileSync(path.join(repository, "src", "unrelated.txt"), "noted\n");
        git(repository, "add", "--all");
        git(repository, "-c", "user.name=Other", "-c", "user.email=other@example.invalid", "commit", "-m", "unrelated");
      },
    });
    await assert.rejects(
      persisting.rerunRetainedChecks(run.runId),
      /receiving branch moved from [0-9a-f]{12} to [0-9a-f]{12} before its verification was recorded/u,
      "a branch that moved before the write had its verification recorded anyway",
    );
    assert.equal(moved, 1, "the window under test was never entered");

    // Nothing was written in that window, so the run still carries exactly the record it had —
    // and it still names the commit its checks were composed on.
    git(repository, "reset", "--hard", run.baselineCommit);
    const applied = await persisting.applyRetained(run.runId);
    assert.equal(applied.applied, true, applied.reason ?? "");
    await persisting.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-A5-R01 residue. The composition itself, read directly. A validation checkout is the run's
// own baseline plus its candidate, whatever the repository HEAD has become since, which is why
// evidence produced in it may only ever be labelled with that baseline.
test("an export validation checkout is composed on the run's baseline, not on the repository HEAD", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-validation-base-"));
  const repository = path.join(root, "repository");
  const storage = path.join(root, "storage");
  await mkdir(path.join(repository, "src"), { recursive: true });
  try {
    git(root, "init", repository);
    git(repository, "config", "user.name", "Test");
    git(repository, "config", "user.email", "test@example.invalid");
    await writeFile(path.join(repository, "src", "value.txt"), "before\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "run-validation-base", [], "never");
    const prepared = await manager.prepareTask(run, "T1");
    await writeFile(path.join(prepared.worktreePath, "src", "value.txt"), "after\n", "utf8");
    await manager.commitTask(prepared, "Change file");
    run.integrationTree = await manager.integrateTask(run, prepared, "Change file");
    await manager.removeTask(run, prepared);

    // The receiving branch moves. Nothing about the run changes with it.
    await writeFile(path.join(repository, "src", "unrelated.txt"), "noted\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "unrelated");
    const movedHead = git(repository, "rev-parse", "HEAD");
    assert.notEqual(movedHead, run.baselineCommit);
    assert.equal(await manager.targetHead(run), movedHead);

    const prepared2 = await manager.prepareExportValidation(run, "validation");
    try {
      assert.equal(
        git(prepared2.worktreePath, "rev-parse", "HEAD"),
        run.baselineCommit,
        "the validation checkout was composed on something other than the run's baseline",
      );
      assert.equal(
        await readFile(path.join(prepared2.worktreePath, "src", "value.txt"), "utf8"),
        "after\n",
      );
      assert.equal(
        existsSync(path.join(prepared2.worktreePath, "src", "unrelated.txt")),
        false,
        "the validation checkout carried a commit the run was never composed against",
      );
    } finally {
      await rm(prepared2.worktreePath, { recursive: true, force: true });
    }
    await manager.abandonRun(run);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-A5-R06. The repository an operation was approved against is the repository it must execute
// in. Improve checked the requested root once and then, after asynchronous work, resolved the
// active editor's root again for startup — so an editor that moved in between selected a
// different repository to run, and the human's approval named the one it did not.
test("an editor that moves after approval does not change which repository Improve runs", gitWorktreeSkip, async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-root-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-root-b-"));
  try {
    const repositoryA = await createRepository(rootA, [
      "- [ ] [A1] Change the A repository",
      "  - Paths: src/value.txt",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "a-before\n" });
    const repositoryB = await createRepository(rootB, [
      "- [ ] [B1] Change the B repository",
      "  - Paths: src/value.txt",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "b-before\n" });

    // The editor moves to B between Improve's own check of the approved repository and the
    // startup that follows it. Trust is asked once by each, which puts the move exactly in the
    // window the approval used to be lost in.
    let editorRoot = repositoryA;
    let trustReads = 0;
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    const controller = createController(rootA, repositoryA, manager, { todoRetries: 0 }, undefined, {
      workspaceRoot: () => editorRoot,
      isWorkspaceTrusted: () => {
        trustReads += 1;
        // Read one is Improve's own; read two is the startup that used to resolve the editor
        // again. The move lands between them.
        if (trustReads === 2) editorRoot = repositoryB;
        return true;
      },
    });

    const improved = await controller.improve({ workspaceRoot: repositoryA });
    assert.ok(trustReads >= 2, "the move never landed inside the startup window");
    assert.equal(editorRoot, repositoryB, "the test never moved the editor");
    const canonical = (value) => realpathSync.native(value);
    assert.equal(
      canonical(improved.ledger.workspaceRoot),
      canonical(repositoryA),
      "the run executed the repository the editor moved to instead of the approved one",
    );
    assert.equal(improved.ledger.status, "completed", improved.ledger.error ?? "");
    assert.ok(
      canonical(improved.ledger.integrationWorktree).startsWith(canonical(rootA)),
      `the run worktree was created outside the approved repository: ${improved.ledger.integrationWorktree}`,
    );
    assert.equal(
      readFileSync(path.join(repositoryB, "src", "value.txt"), "utf8"),
      "b-before\n",
      "the repository the editor moved to was written to",
    );
    assert.equal(
      git(repositoryB, "status", "--porcelain=v1"),
      "",
      "the repository the editor moved to was left dirty",
    );
    await controller.dispose();
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("a disposed controller refuses retained maintenance instead of racing its own cleanup", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-disposed-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Retained",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(path.join(options.workingDirectory, "src", "value.txt"), "after\n", "utf8");
      return completedPipeline();
    });
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const run = await controller.start();
    assert.equal(run.status, "completed");
    await controller.dispose();

    await assert.rejects(controller.rerunRetainedChecks(run.runId), /disposed/u);
    await assert.rejects(controller.applyRetained(run.runId), /disposed/u);
    await assert.rejects(controller.retainedRunPatch(run.runId), /disposed/u);
    await assert.rejects(controller.cleanupRetained(run.runId), /disposed/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-G6-02. A sealed run's patch is `inputTree..candidate`: the sealed files are the baseline
// the work was written against, not lines of the work, so they appear nowhere in it. Apply
// checked only that the branch still contained the run's baseline commit, and `git apply
// --check` cannot object to a file that is in no hunk — so work depending on a sealed untracked
// module could be staged into a target that never had it.
test("applying a sealed run refuses a target that no longer holds the sealed input", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-sealed-apply-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Build on the prepared start point",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/base.txt": "committed\n" });

    await writeFile(path.join(repository, "src", "base.txt"), "sealed input\n", "utf8");
    await writeFile(path.join(repository, "src", "helper.txt"), "the dependency\n", "utf8");

    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(
        path.join(options.workingDirectory, "src", "run.txt"),
        "needs src/helper.txt\n",
        "utf8",
      );
      return completedPipeline();
    });

    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const run = await controller.start({ sealedInputPaths: ["src/base.txt", "src/helper.txt"] });
    assert.equal(run.status, "completed", run.error ?? "");

    // Tidying up before applying: the untracked dependency the run was given is discarded, and
    // so is the sealed edit. The tree is clean, so every other Apply precondition holds.
    await rm(path.join(repository, "src", "helper.txt"));
    git(repository, "checkout", "--", "src/base.txt");
    assert.equal(await readFile(path.join(repository, "src", "base.txt"), "utf8"), "committed\n", "restoring the fixture must preserve its committed line endings");
    assert.equal(git(repository, "status", "--porcelain=v1"), "", "the tidy-up left the tree dirty");

    const refused = await controller.applyRetained(run.runId);
    assert.equal(
      refused.applied,
      false,
      "work written against sealed input was applied to a target that no longer holds it",
    );
    assert.match(refused.reason, /no longer holds the input this run was sealed with/u);
    assert.deepEqual([...refused.conflicts].sort(), ["src/base.txt", "src/helper.txt"]);
    assert.equal(existsSync(path.join(repository, "src", "run.txt")), false, "a refusal wrote anyway");

    // The same run, once the target actually holds what the run was sealed with.
    await writeFile(path.join(repository, "src", "base.txt"), "sealed input\n", "utf8");
    await writeFile(path.join(repository, "src", "helper.txt"), "the dependency\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "commit the sealed input");

    const applied = await controller.applyRetained(run.runId);
    assert.equal(applied.applied, true, applied.reason ?? "");
    assert.equal(applied.stagedFiles.includes("src/run.txt"), true);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// EX-A5-R03. The sealed-input check compared `rev-parse tree:path` object ids. A blob id covers
// content and nothing else, so a sealed file whose mode is executable and whose target copy is
// not compares equal — and the exported patch deliberately excludes sealed input, so the mode
// never reaches the receiving branch either. The applied program is then a text file the shell
// refuses with exit 126. What has to match is the whole tree entry: mode, type and presence.
test("applying a sealed run refuses a target whose sealed input lost its executable mode", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-sealed-mode-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Build on the prepared start point",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/base.txt": "committed\n", "src/run.sh": "#!/bin/sh\necho hello\n" });

    // The only difference the seal carries is the mode. The bytes are already committed.
    if (process.platform === "win32") {
      git(repository, "update-index", "--chmod=+x", "src/run.sh");
    } else {
      await chmod(path.join(repository, "src", "run.sh"), 0o755);
    }
    assert.match(git(repository, "status", "--porcelain=v1"), /src\/run\.sh/u, "the mode change is not dirty");

    const manager = createFakeConversationManager(async ({ options }) => {
      await writeFile(
        path.join(options.workingDirectory, "src", "caller.txt"),
        "runs src/run.sh\n",
        "utf8",
      );
      return completedPipeline();
    });

    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const run = await controller.start({ sealedInputPaths: ["src/run.sh"] });
    assert.equal(run.status, "completed", run.error ?? "");

    git(repository, "restore", "--source=HEAD", "--staged", "--worktree", "--", "src/run.sh");
    assert.equal(await readFile(path.join(repository, "src", "run.sh"), "utf8"), "#!/bin/sh\necho hello\n", "restoring the mode must not introduce a content change");
    assert.equal(git(repository, "status", "--porcelain=v1"), "", "the tidy-up left the tree dirty");

    const refused = await controller.applyRetained(run.runId);
    assert.equal(
      refused.applied,
      false,
      "work written against an executable sealed input was applied to a target that holds it unexecutable",
    );
    assert.match(refused.reason, /no longer holds the input this run was sealed with/u);
    assert.deepEqual(refused.conflicts, ["src/run.sh"]);

    if (process.platform === "win32") {
      git(repository, "update-index", "--chmod=+x", "src/run.sh");
    } else {
      await chmod(path.join(repository, "src", "run.sh"), 0o755);
    }
    git(repository, "add", "--", "src/run.sh");
    git(repository, "commit", "-m", "restore the executable mode");
    assert.equal(git(repository, "status", "--porcelain=v1"), "", "restoring the mode left the tree dirty");
    const applied = await controller.applyRetained(run.runId);
    assert.equal(applied.applied, true, applied.reason ?? "");
    assert.equal(applied.stagedFiles.includes("src/caller.txt"), true);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a sealed working-tree input starts the run without touching the branch or the index", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-sealed-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Build on the prepared start point",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/base.txt": "committed\n" });

    await writeFile(path.join(repository, "src", "base.txt"), "sealed input\n", "utf8");
    await writeFile(path.join(repository, "src", "new.txt"), "brand new\n", "utf8");
    const headBefore = git(repository, "rev-parse", "HEAD");
    const statusBefore = git(repository, "status", "--porcelain=v1");

    const observed = [];
    const manager = createFakeConversationManager(async ({ options }) => {
      observed.push({
        base: await readFile(path.join(options.workingDirectory, "src", "base.txt"), "utf8"),
        added: await readFile(path.join(options.workingDirectory, "src", "new.txt"), "utf8"),
      });
      await writeFile(path.join(options.workingDirectory, "src", "run.txt"), "run output\n", "utf8");
      return completedPipeline();
    });

    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const run = await controller.start({ sealedInputPaths: ["src/base.txt", "src/new.txt"] });
    assert.equal(run.status, "completed", run.error ?? "");
    assert.deepEqual(run.sealedInputPaths, ["src/base.txt", "src/new.txt"]);
    assert.equal(typeof run.inputTree, "string");

    assert.deepEqual(observed, [{ base: "sealed input\n", added: "brand new\n" }]);

    assert.equal(git(repository, "rev-parse", "HEAD"), headBefore, "sealing moved the branch");
    assert.equal(git(repository, "status", "--porcelain=v1"), statusBefore, "sealing changed the working tree");

    const patch = await controller.retainedRunPatch(run.runId);
    assert.match(patch, /src\/run\.txt/u);
    assert.doesNotMatch(patch, /sealed input/u, "the run patch re-applied the user's own sealed change");
    assert.doesNotMatch(patch, /brand new/u, "the run patch re-applied the user's own untracked file");

    const files = await controller.retainedRunPatchFiles(run.runId);
    assert.equal(files.some((file) => file.path === "src/run.txt"), true);
    assert.equal(files.some((file) => file.path === "src/base.txt"), false);
    assert.equal(files.some((file) => file.path === "src/new.txt"), false);
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sealing refuses a path the working tree did not change", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-sealed-unknown-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Anything",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/base.txt": "committed\n" });
    await writeFile(path.join(repository, "src", "base.txt"), "changed\n", "utf8");
    const manager = createFakeConversationManager(async () => completedPipeline());
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    await assert.rejects(
      controller.start({ sealedInputPaths: ["src/base.txt", "src/never-touched.txt"] }),
      /refuses to seal paths that are not changed/u,
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unsealed dirty path still blocks the run", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-unsealed-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Anything",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/base.txt": "committed\n", "src/other.txt": "committed\n" });
    await writeFile(path.join(repository, "src", "base.txt"), "changed\n", "utf8");
    await writeFile(path.join(repository, "src", "other.txt"), "also changed\n", "utf8");
    const manager = createFakeConversationManager(async () => completedPipeline());
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    await assert.rejects(
      controller.start({ sealedInputPaths: ["src/base.txt"] }),
      /must be clean before starting TODO orchestration.*src\/other\.txt/su,
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sealing refuses an untracked symbolic link instead of dereferencing it", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-sealed-link-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Anything",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/base.txt": "committed\n" });
    const outside = path.join(root, "outside-secret.txt");
    await writeFile(outside, "not part of this repository\n", "utf8");
    await symlink(outside, path.join(repository, "src", "link.txt"));

    const manager = createFakeConversationManager(async () => completedPipeline());
    const controller = createController(root, repository, manager, { todoRetries: 0 });
    await assert.rejects(
      controller.start({ sealedInputPaths: ["src/link.txt"] }),
      /refuses to seal a symbolic link/u,
    );
    await controller.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposal during startup cancels it and never releases ownership under a hung drain", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-dispose-startup-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Slow start",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });

    let releaseMaster = () => undefined;
    const masterGate = new Promise((resolve) => {
      releaseMaster = resolve;
    });
    const manager = createFakeConversationManager(async () => completedPipeline());
    const originalCreate = manager.createConversation.bind(manager);
    manager.createConversation = async (...args) => {
      const created = await originalCreate(...args);
      await masterGate;
      return created;
    };

    const controller = createController(root, repository, manager, { todoRetries: 0 });
    const started = controller.start().then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const disposal = controller.dispose();
    releaseMaster();
    const outcome = await started;
    await disposal;

    assert.notEqual(outcome, "resolved", "startup completed after the controller was disposed");
    assert.equal(
      git(repository, "for-each-ref", "--format=%(refname:short)", "refs/heads/bachata/integration/").length,
      0,
      "a cancelled startup left an integration branch behind",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disposal between the ledger write and begin leaves no active run behind", gitWorktreeSkip, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-store-race-"));
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Slow persist",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/value.txt": "before\n" });
    const manager = createFakeConversationManager(async () => completedPipeline());

    let releaseSave = () => undefined;
    const saveGate = new Promise((resolve) => {
      releaseSave = resolve;
    });
    let gated = false;
    const withWorkspaceMutation = async (operation) => {
      const result = await operation();
      if (!gated) {
        gated = true;
        await saveGate;
      }
      return result;
    };

    const controller = createController(root, repository, manager, { todoRetries: 0 }, undefined, {
      withWorkspaceMutation,
    });
    const started = controller.start().then(
      () => "resolved",
      (error) => (error instanceof Error ? error.message : String(error)),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    const disposal = controller.dispose();
    releaseSave();
    const outcome = await started;
    await disposal;

    assert.notEqual(outcome, "resolved", "startup completed after disposal");
    const store = createOrchestrationStore(path.join(root, "storage"));
    assert.equal(
      await store.getActiveRun(),
      undefined,
      "a cancelled startup left an active-run pointer behind",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const assertSealedInputReplacement = async (replaceDirectory) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-controller-sealed-swap-"));
  const filesystem = require("node:fs/promises");
  const originalOpen = filesystem.open;
  let controller;
  let swapped = false;
  let opened = 0;
  let read = 0;
  let closed = 0;
  try {
    const repository = await createRepository(root, [
      "- [ ] [T1] Anything",
      "  - Paths: src",
      "  - Verify: none",
      "",
    ].join("\n"), { "src/base.txt": "committed\n" });
    const outside = path.join(root, "outside", "swap.txt");
    await mkdir(path.dirname(outside));
    await writeFile(outside, "not part of this repository\n", "utf8");
    const untracked = path.join(repository, "src", "nested", "swap.txt");
    await mkdir(path.dirname(untracked));
    await writeFile(untracked, "real content\n", "utf8");
    const sourcePath = realpathSync.native(untracked);

    const manager = createFakeConversationManager(async () => completedPipeline());
    controller = createController(root, repository, manager, { todoRetries: 0 });
    filesystem.open = async (candidate, flags, ...args) => {
      if (typeof candidate !== "string" || path.relative(sourcePath, candidate) !== "") {
        return originalOpen(candidate, flags, ...args);
      }
      assert.equal(swapped, false);
      swapped = true;
      if (replaceDirectory) {
        await rename(path.dirname(untracked), path.join(root, "original-source"));
        await symlink(path.dirname(outside), path.dirname(untracked), process.platform === "win32" ? "junction" : "dir");
      } else {
        await rm(untracked);
        await symlink(outside, untracked);
      }
      const handle = await originalOpen(candidate, flags & ~(filesystem.constants.O_NOFOLLOW ?? 0), ...args);
      opened += 1;
      const readFile = handle.readFile.bind(handle);
      const close = handle.close.bind(handle);
      handle.readFile = (...readArgs) => { read += 1; return readFile(...readArgs); };
      handle.close = async () => { await close(); closed += 1; };
      return handle;
    };
    await assert.rejects(
      controller.start({ sealedInputPaths: ["src/nested/swap.txt"] }),
      replaceDirectory ? /refuses to seal a path that changed while it was opened/u : /refuses to seal a symbolic link/u,
    );
    assert.equal(swapped, true, "the replacement must occur after validation and before opening");
    assert.equal(opened, 1, "the fallback must be exercised without O_NOFOLLOW");
    assert.equal(read, 0, "outside bytes must not be read");
    assert.equal(closed, opened, "the rejected descriptor must be closed");
    assert.equal(await createOrchestrationStore(path.join(root, "storage")).getActiveRun(), undefined);
  } finally {
    filesystem.open = originalOpen;
    await controller?.dispose();
    await rm(root, { recursive: true, force: true });
  }
};

test("sealing refuses a path replaced by a symbolic link after it was listed", gitWorktreeSkip, async (context) => {
  await context.test("the selected file becomes a symbolic link", () => assertSealedInputReplacement(false));
  await context.test("the parent becomes an outside directory link", () => assertSealedInputReplacement(true));
});
