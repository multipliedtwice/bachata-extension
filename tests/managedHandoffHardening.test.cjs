const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { spawnScopedProviderProcess } = require("../dist/process/processScope.js");
const { gitProcessEnvironment } = require("../dist/process/safeEnvironment.js");
const { runProcess } = require("../dist/orchestrator/commandRunner.js");
const { terminateProcessTree } = require("../dist/process/terminateProcessTree.js");

const {
  captureManagedRepositoryBaseline,
  runManagedControllerVerification,
} = require("../dist/browser/managedTurn.js");
const { MANAGED_PROJECT_CHECKS_COMMAND } = require("../dist/orchestrator/verificationPolicy.js");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });

const createTurn = (root, changedFiles) => ({
  index: {
    root,
    workspaceRoot: root,
    allowedPaths: ["."],
    revision: 0,
    files: new Map(),
    inventory: new Set(),
    skippedTooLargePaths: new Set(),
    skippedUnreadablePaths: new Set(),
    skippedBudgetPaths: new Set(),
    skippedFileLimitPaths: new Set(),
    coverage: {
      inventoryCount: 0,
      maxInventoryFiles: 100000,
      inventoryTruncated: false,
      inventoryTimedOut: false,
      ignoreFileCount: 0,
      indexedCount: 0,
      maxFiles: 5000,
      maxFileBytes: 1048576,
      maxTotalBytes: 134217728,
      indexedBytes: 0,
      indexingTimedOut: false,
      truncated: false,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
      skippedBudget: 0,
      skippedFileLimit: 0,
    },
    compilerOptions: {},
    ignoreScopes: [],
    inventoryTimeoutMs: 30000,
    indexingTimeoutMs: 30000,
  },
  snippets: new Map(),
  verification: [],
  workspaceRevision: 0,
  changedFiles,
  preexistingChangedFiles: [],
  repositoryPolicyViolations: [],
  diff: "",
  diffOmittedFileCount: 0,
  initialContextOmitted: [],
  initialContextOmittedTotal: 0,
  prompt: "",
});

const options = (root, baseline) => ({
  taskId: "handoff-hardening",
  originalTask: "edit a tracked file",
  role: "worker",
  workingDirectory: root,
  allowedPaths: ["."],
  protectedPaths: [],
  commitMode: "never",
  readOnly: false,
  verificationChecks: [{ id: "project-checks", command: MANAGED_PROJECT_CHECKS_COMMAND }],
  maxRevisionCycles: 1,
  deadlineAt: Date.now() + 120000,
  continuationMaxBytes: 65536,
  handoffTotalBudgetBytes: 262144,
  dependencyDepth: 2,
  promotionMaxBytes: 786432,
  repositoryBaseline: baseline,
  signal: new AbortController().signal,
  executor: { timeoutMs: 120000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
  contextIndex: { maxInventoryFiles: 100000, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
  contextSearch: { maxFiles: 2000, maxBytes: 67108864, maxFileBytes: 8388608, timeoutMs: 15000 },
});

const createProject = (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "bachata@example.invalid"]);
  git(root, ["config", "user.name", "Bachata Test"]);
  fs.writeFileSync(path.join(root, "notes.txt"), "baseline\n");
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "baseline"]);
  fs.writeFileSync(path.join(root, "notes.txt"), "baseline\nchanged\n");
  return root;
};

const realGit = () => {
  const lookup = process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT, "System32", "where.exe")
    : "which";
  const found = execFileSync(lookup, [process.platform === "win32" ? "git.exe" : "git"], {
    encoding: "utf8",
    timeout: 10_000,
  }).trim().split(/\r?\n/u)[0];
  assert.ok(found && path.isAbsolute(found), "Git lookup did not return an absolute executable path");
  return found;
};

const writeWindowsGitShim = (directory, logDirectory, executable) => {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  const compiler = ["Framework64", "Framework"].map((framework) =>
    path.join(systemRoot, "Microsoft.NET", framework, "v4.0.30319", "csc.exe"),
  ).find((candidate) => fs.existsSync(candidate));
  assert.ok(compiler, "The Windows Git shim requires the bundled .NET Framework C# compiler");
  const literal = (value) => `@"${value.replaceAll('"', '""')}"`;
  const source = path.join(path.dirname(logDirectory), "git-shim.cs");
  const runner = fs.readFileSync(path.join(__dirname, "..", "scripts", "windows-job-runner.ps1"), "utf8");
  const quote = runner.match(/    private static string Quote\(string value\)[\s\S]*?(?=    private static uint ActiveProcesses)/u)?.[0];
  assert.ok(quote, "The Windows process runner's argument quotation function is unavailable");
  fs.writeFileSync(source, `
using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Text;
class GitShim {
${quote}
  static int Main(string[] args) {
    StringBuilder record = new StringBuilder("BEGIN\\n");
    record.Append("ARGS ").Append(String.Join(" ", args)).Append('\\n');
    foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
      if (entry.Key.ToString().StartsWith("GIT_", StringComparison.Ordinal))
        record.Append(entry.Key).Append('=').Append(entry.Value).Append('\\n');
    }
    record.Append("END\\n");
    File.WriteAllText(Path.Combine(${literal(logDirectory)}, Guid.NewGuid().ToString("N") + ".log"), record.ToString());
    ProcessStartInfo start = new ProcessStartInfo(${literal(executable)}, String.Join(" ", Array.ConvertAll(args, Quote)));
    start.UseShellExecute = false;
    using (Process child = Process.Start(start)) {
      child.WaitForExit();
      return child.ExitCode;
    }
  }
}
`);
  execFileSync(compiler, ["/nologo", "/target:exe", `/out:${path.join(directory, "git.exe")}`, source], {
    timeout: 30_000,
    maxBuffer: 65_536,
    stdio: ["ignore", "pipe", "pipe"],
  });
};

// A stand-in for git that records the argument vector and the GIT_* environment it was handed,
// then hands the work to the real one so the verification still reaches its real conclusion.
const writeGitShim = (directory, logDirectory) => {
  fs.mkdirSync(logDirectory, { recursive: true });
  const executable = realGit();
  if (process.platform === "win32") {
    writeWindowsGitShim(directory, logDirectory, executable);
    return;
  }
  fs.writeFileSync(
    path.join(directory, "git"),
    [
      "#!/bin/sh",
      `record=$(mktemp ${JSON.stringify(path.join(logDirectory, "invocation.XXXXXX"))}) || exit 1`,
      "{",
      "  printf 'BEGIN\\n'",
      "  printf 'ARGS %s\\n' \"$*\"",
      "  env | grep '^GIT_' | sort",
      "  printf 'END\\n'",
      '} > "$record"',
      `exec ${JSON.stringify(executable)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
};

const clearInvocations = (logDirectory) => {
  for (const entry of fs.readdirSync(logDirectory)) fs.unlinkSync(path.join(logDirectory, entry));
};

const readInvocations = (logDirectory) => {
  if (!fs.existsSync(logDirectory)) return [];
  return fs.readdirSync(logDirectory).map((entry) => {
    const record = fs.readFileSync(path.join(logDirectory, entry), "utf8");
    assert.ok(record.startsWith("BEGIN\n") && record.endsWith("END\n"), `incomplete Git invocation record: ${entry}`);
    const lines = record.split("\n").filter((line) => line.length > 0 && line !== "BEGIN" && line !== "END");
    const args = (lines.find((line) => line.startsWith("ARGS ")) ?? "ARGS ").slice(5);
    const environment = Object.fromEntries(
      lines
        .filter((line) => line.startsWith("GIT_"))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    return { args, environment };
  });
};

const runProjectChecks = async (root, changedFiles, pathPrefix) => {
  const original = process.env.PATH;
  if (pathPrefix !== undefined) process.env.PATH = `${pathPrefix}${path.delimiter}${original ?? ""}`;
  try {
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root, changedFiles);
    const [result] = await runManagedControllerVerification(turn, options(root, baseline), ["project-checks"]);
    return result;
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
};

// The git that inspects a repository must not be a program that repository supplies. The
// diff-check half of the managed handoff rebuilt its environment from scratch and threw away the
// PATH sanitization the probe two lines above it had just applied.
test("native managed diff checks never run a git the workspace put on PATH", async (context) => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-git-shim-log-"));
  const logDirectory = path.join(logRoot, "invocations");
  const root = createProject("bachata-handoff-path-");
  const processScope = require("../dist/process/processScope.js");
  const spawnScope = processScope.spawnProcessScope;
  const ownedScopes = [];
  let bodyCompleted = false;
  let bodyFailure;
  context.mock.method(processScope, "spawnProcessScope", (...args) => {
    const scope = spawnScope(...args);
    ownedScopes.push(scope);
    return scope;
  });
  context.after(async () => {
    try {
      for (const scope of ownedScopes) {
        assert.equal(await terminateProcessTree(scope.child, 5_000), true, "the fixture must stop its own process scope before removing scratch");
        let timeout;
        try {
          const result = await Promise.race([
            scope.result,
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error("The fixture process scope did not close")), 5_000);
            }),
          ]);
          assert.equal(result.cleanupConfirmed, true, "the fixture process scope must confirm cleanup");
        } finally {
          clearTimeout(timeout);
        }
      }
      const removalOptions = {
        recursive: true,
        force: true,
        ...(process.platform === "win32" ? { maxRetries: 5, retryDelay: 100 } : {}),
      };
      await fs.promises.rm(root, removalOptions);
      await fs.promises.rm(logRoot, removalOptions);
    } catch (cleanupFailure) {
      throw new AggregateError(
        bodyFailure === undefined ? [cleanupFailure] : [bodyFailure, cleanupFailure],
        bodyCompleted ? "Native managed Git assertions completed, but fixture cleanup failed" : "Native managed Git assertions and fixture cleanup failed",
      );
    }
    if (bodyFailure !== undefined) throw bodyFailure;
    assert.equal(bodyCompleted, true, "the native managed Git assertions did not complete");
  });
  try {
    writeGitShim(root, logDirectory);
    execFileSync("git", ["--version"], { env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}` } });
    assert.equal(
      readInvocations(logDirectory).some((invocation) => invocation.args === "--version"),
      true,
      "the workspace-supplied git was not reachable, so this test proves nothing",
    );
    for (const pathPrefix of [root, undefined]) {
      clearInvocations(logDirectory);
      const result = await runProjectChecks(root, ["notes.txt"], pathPrefix);
      assert.equal(result.status, "passed", result.summary);
      assert.match(result.summary, /git diff --check passed/u);

      assert.deepEqual(readInvocations(logDirectory), [], "managed checks must never launch a workspace-supplied git");
    }
    clearInvocations(logDirectory);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = root;
      const filtered = gitProcessEnvironment(root);
      const absentPath = Object.fromEntries(Object.entries(filtered).filter(([key]) => key.toUpperCase() !== "PATH"));
      for (const environment of [filtered, absentPath]) {
        const description = Object.hasOwn(environment, "PATH") ? "empty requested PATH" : "absent requested PATH";
        const result = await runProcess("git", ["--version"], {
          cwd: root,
          environment,
          timeoutMs: 10_000,
          maxOutputBytes: 1_024,
        });
        assert.equal(result.cleanupConfirmed, true, `${description}: ${result.stderr}`);
        assert.equal(result.timedOut, false, `${description}: ${result.stderr}`);
        if (process.platform === "win32") {
          assert.equal(result.exitCode, undefined);
          assert.match(result.stderr, /ENOENT/u);
        } else {
          assert.equal(result.exitCode, 0, result.stderr);
          assert.match(result.stdout, /^git version /u);
        }
      }
      assert.deepEqual(readInvocations(logDirectory), [], "removing every PATH entry must not enable implicit workspace lookup");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    bodyCompleted = true;
  } catch (error) {
    bodyFailure = error;
    throw error;
  }
});

test("native provider command lookup excludes implicit cwd but preserves explicit executable and PATH choices", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-provider-lookup-"));
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-provider-lookup-log-"));
  const logDirectory = path.join(logRoot, "invocations");
  const gitDirectory = path.dirname(realGit());
  const trustedPath = [gitDirectory, gitProcessEnvironment(root).PATH].filter(Boolean).join(path.delimiter);
  const explicit = path.join(root, process.platform === "win32" ? "git.exe" : "git");
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"));
  const input = "provider streaming input\n";
  const expected = createHash("sha1").update(`blob ${Buffer.byteLength(input)}\0${input}`).digest("hex");
  let active;
  try {
    writeGitShim(root, logDirectory);
    for (const [command, searchPath, intercepted] of [
      ["git", trustedPath, false],
      [explicit, trustedPath, true],
      ["git", `${root}${path.delimiter}${trustedPath}`, true],
    ]) {
      clearInvocations(logDirectory);
      active = spawnScopedProviderProcess(command, ["hash-object", "--stdin"], {
        cwd: root,
        env: { ...inherited, PATH: searchPath },
      });
      const { child } = active;
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const completed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
      });
      child.stdin.end(input);
      assert.equal(await completed, 0, stderr);
      assert.equal(stderr, "");
      assert.equal(stdout.trim(), expected);
      assert.equal(await active.terminate(1_000), true);
      active = undefined;
      assert.equal(readInvocations(logDirectory).length, intercepted ? 1 : 0);
    }
  } finally {
    if (active) await active.terminate(1_000);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(logRoot, { recursive: true, force: true });
  }
});

// Every git the product runs is hardened against the configuration of the machine it runs on:
// the recorded claim "git diff --check passed" has to mean the same thing on the reviewer's
// machine as on the author's, and a system gitconfig that relaxes core.whitespace must not
// silently narrow what the check covered.
test("every git the managed handoff runs carries the git hardening", async () => {
  const shimRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-git-shim-"));
  const logDirectory = path.join(shimRoot, "invocations");
  const root = createProject("bachata-handoff-hardening-");
  try {
    writeGitShim(shimRoot, logDirectory);
    const result = await runProjectChecks(root, ["notes.txt"], shimRoot);
    assert.equal(result.status, "passed", result.summary);

    const invocations = readInvocations(logDirectory);
    assert.ok(invocations.length > 0, "no git invocation was observed");
    for (const invocation of invocations) {
      assert.equal(invocation.environment.GIT_CONFIG_NOSYSTEM, "1", invocation.args);
      assert.equal(invocation.environment.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null", invocation.args);
      assert.equal(invocation.environment.GIT_TERMINAL_PROMPT, "0", invocation.args);
      assert.equal(invocation.environment.GIT_OPTIONAL_LOCKS, "0", invocation.args);
    }

    const diffCheck = invocations.filter((invocation) => /(?:^|\s)--check(?:\s|$)/u.test(invocation.args));
    assert.equal(diffCheck.length > 0, true, "the diff check never ran");
    for (const invocation of diffCheck) {
      assert.ok(invocation.environment.GIT_INDEX_FILE, invocation.args);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(shimRoot, { recursive: true, force: true });
  }
});

test("Git shim records concurrent invocations separately and delegates every command", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-git-shim-concurrent-"));
  const logDirectory = path.join(root, "invocations");
  try {
    writeGitShim(root, logDirectory);
    const executable = path.join(root, process.platform === "win32" ? "git.exe" : "git");
    const cases = Array.from({ length: 8 }, (_, index) => `case-${index}`);
    const results = await Promise.allSettled(cases.map((value) => runProcess(executable, ["-c", `bachata.fixture=${value}`, "--version"], {
      cwd: root,
      environment: { ...gitProcessEnvironment(root), GIT_BACHATA_SHIM_CASE: value },
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    })));
    for (const outcome of results) {
      if (outcome.status === "rejected") throw outcome.reason;
      const result = outcome.value;
      assert.equal(result.cleanupConfirmed, true, result.stderr);
      assert.equal(result.timedOut, false, result.stderr);
      assert.equal(result.exitCode, 0, result.stderr);
      assert.match(result.stdout, /^git version /u);
    }
    const invocations = readInvocations(logDirectory);
    assert.equal(invocations.length, cases.length);
    assert.deepEqual(invocations.map(({ environment }) => environment.GIT_BACHATA_SHIM_CASE).sort(), cases);
    for (const { args, environment } of invocations) {
      assert.equal(args, `-c bachata.fixture=${environment.GIT_BACHATA_SHIM_CASE} --version`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
