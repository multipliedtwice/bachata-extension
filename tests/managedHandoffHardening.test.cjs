const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

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

const realGit = execFileSync("/bin/sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// A stand-in for git that records the argument vector and the GIT_* environment it was handed,
// then hands the work to the real one so the verification still reaches its real conclusion.
const writeGitShim = (directory, logPath) => {
  fs.writeFileSync(
    path.join(directory, "git"),
    [
      "#!/bin/sh",
      "{",
      "  printf 'BEGIN\\n'",
      "  printf 'ARGS %s\\n' \"$*\"",
      "  env | grep '^GIT_' | sort",
      "  printf 'END\\n'",
      `} >> ${JSON.stringify(logPath)}`,
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
};

const readInvocations = (logPath) => {
  if (!fs.existsSync(logPath)) return [];
  return fs.readFileSync(logPath, "utf8")
    .split("BEGIN\n")
    .filter((block) => block.includes("END"))
    .map((block) => {
      const lines = block.split("\n").filter((line) => line.length > 0 && line !== "END");
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
  process.env.PATH = `${pathPrefix}${path.delimiter}${original ?? ""}`;
  try {
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root, changedFiles);
    const [result] = await runManagedControllerVerification(turn, options(root, baseline), ["project-checks"]);
    return result;
  } finally {
    process.env.PATH = original;
  }
};

// The git that inspects a repository must not be a program that repository supplies. The
// diff-check half of the managed handoff rebuilt its environment from scratch and threw away the
// PATH sanitization the probe two lines above it had just applied.
test("the managed diff check never runs a git the workspace put on PATH", async () => {
  const logRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-git-shim-log-"));
  const logPath = path.join(logRoot, "invocations.log");
  const root = createProject("bachata-handoff-path-");
  try {
    writeGitShim(root, logPath);
    execFileSync("git", ["--version"], { env: { ...process.env, PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}` } });
    assert.equal(
      readInvocations(logPath).some((invocation) => invocation.args === "--version"),
      true,
      "the workspace-supplied git was not reachable, so this test proves nothing",
    );
    fs.writeFileSync(logPath, "");

    const result = await runProjectChecks(root, ["notes.txt"], root);
    assert.equal(result.status, "passed", result.summary);
    assert.match(result.summary, /git diff --check passed/u);

    for (const invocation of readInvocations(logPath)) {
      assert.equal(
        /(?:^|\s)(?:read-tree|add|--check)(?:\s|$)/u.test(invocation.args),
        false,
        `the managed diff check ran a workspace-supplied git: ${invocation.args}`,
      );
    }
  } finally {
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
  const logPath = path.join(shimRoot, "invocations.log");
  const root = createProject("bachata-handoff-hardening-");
  try {
    writeGitShim(shimRoot, logPath);
    const result = await runProjectChecks(root, ["notes.txt"], shimRoot);
    assert.equal(result.status, "passed", result.summary);

    const invocations = readInvocations(logPath);
    assert.ok(invocations.length > 0, "no git invocation was observed");
    for (const invocation of invocations) {
      assert.equal(invocation.environment.GIT_CONFIG_NOSYSTEM, "1", invocation.args);
      assert.equal(invocation.environment.GIT_CONFIG_GLOBAL, "/dev/null", invocation.args);
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
