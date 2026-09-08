const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const {
  captureManagedRepositoryBaseline,
  executeManagedBrowserEnvelope,
} = require("../dist/browser/managedTurn.js");

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });

const createTurn = (root) => ({
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
  changedFiles: ["task.ts"],
  preexistingChangedFiles: [],
  repositoryPolicyViolations: [],
  diff: "",
  diffOmittedFileCount: 0,
  initialContextOmitted: [],
  initialContextOmittedTotal: 0,
  prompt: "",
});

const options = (root, baseline, command) => ({
  taskId: "verification-isolation",
  originalTask: "verify without side effects",
  role: "worker",
  workingDirectory: root,
  allowedPaths: ["."],
  protectedPaths: [],
  commitMode: "never",
  readOnly: false,
  verificationChecks: [{ id: "configured", command }],
  maxRevisionCycles: 1,
  deadlineAt: Date.now() + 60000,
  continuationMaxBytes: 65536,
  handoffTotalBudgetBytes: 262144,
  dependencyDepth: 2,
  promotionMaxBytes: 786432,
  repositoryBaseline: baseline,
  signal: new AbortController().signal,
  executor: { timeoutMs: 5000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
  contextIndex: { maxInventoryFiles: 100000, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
  contextSearch: { maxFiles: 2000, maxBytes: 67108864, maxFileBytes: 8388608, timeoutMs: 15000 },
});

test("managed verification rejects arbitrary mutation commands before process launch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-verification-isolation-"));
  try {
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "bachata@example.invalid"]);
    git(root, ["config", "user.name", "Bachata Test"]);
    fs.writeFileSync(path.join(root, "task.ts"), "export const task = 1;\n");
    fs.writeFileSync(path.join(root, "clean.ts"), "export const clean = 1;\n");
    git(root, ["add", "task.ts", "clean.ts"]);
    git(root, ["commit", "--quiet", "-m", "baseline"]);
    fs.writeFileSync(path.join(root, "task.ts"), "export const task = 2;\n");

    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const statusBefore = git(root, ["status", "--porcelain=v1"]);
    const taskBefore = fs.readFileSync(path.join(root, "task.ts"), "utf8");
    const cleanBefore = fs.readFileSync(path.join(root, "clean.ts"), "utf8");
    const script = [
      "const fs=require('node:fs')",
      "fs.writeFileSync('task.ts','verification overwrote task\\n')",
      "fs.writeFileSync('clean.ts','verification overwrote clean\\n')",
      "fs.writeFileSync('generated.tmp','verification artifact\\n')",
    ].join(";");

    const turn = createTurn(root);
    const execution = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "needContext",
      actions: [{ kind: "verification.run", checkIds: ["configured"] }],
      summary: "run configured verification",
      objections: [],
      unresolved: [],
    }, turn, options(root, baseline, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`), async () => "approve");

    assert.equal(execution.recognized, true);
    assert.equal(turn.verification.length, 1);
    assert.equal(turn.verification[0].status, "failed");
    assert.match(turn.verification[0].summary, /does not execute repository commands or shell wrappers/u);
    assert.equal(fs.readFileSync(path.join(root, "task.ts"), "utf8"), taskBefore);
    assert.equal(fs.readFileSync(path.join(root, "clean.ts"), "utf8"), cleanBefore);
    assert.equal(fs.existsSync(path.join(root, "generated.tmp")), false);
    assert.equal(git(root, ["status", "--porcelain=v1"]), statusBefore);
    assert.deepEqual(
      await captureManagedRepositoryBaseline(root, new AbortController().signal),
      baseline,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed verification refuses E2E before the command can run", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-e2e-refusal-"));
  try {
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "bachata@example.invalid"]);
    git(root, ["config", "user.name", "Bachata Test"]);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { e2e: "node -e \\\"require('node:fs').writeFileSync('e2e-ran','yes')\\\"" } }));
    git(root, ["add", "package.json"]);
    git(root, ["commit", "--quiet", "-m", "baseline"]);
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);
    turn.changedFiles = [];

    await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "needContext",
      actions: [{ kind: "verification.run", checkIds: ["configured"] }],
      summary: "attempt E2E",
      objections: [],
      unresolved: [],
    }, turn, options(root, baseline, "npm run e2e"), async () => "approve");

    assert.equal(turn.verification[0].status, "failed");
    assert.match(turn.verification[0].summary, /does not execute repository commands or shell wrappers/u);
    assert.equal(fs.existsSync(path.join(root, "e2e-ran")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed verification rejects package wrappers before Git metadata can change", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-verification-metadata-"));
  try {
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "bachata@example.invalid"]);
    git(root, ["config", "user.name", "Bachata Test"]);
    fs.writeFileSync(path.join(root, "task.ts"), "export const task = 1;\n");
    git(root, ["add", "task.ts"]);
    git(root, ["commit", "--quiet", "-m", "baseline"]);
    fs.writeFileSync(path.join(root, "task.ts"), "export const task = 2;\n");

    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
      scripts: { verify: "git add task.ts && git branch verification-temp" },
    }));
    git(root, ["add", "package.json"]);
    git(root, ["commit", "--quiet", "-m", "verification package script"]);
    fs.writeFileSync(path.join(root, "task.ts"), "export const task = 2;\n");
    const verificationBaseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const verificationStatusBefore = git(root, ["status", "--porcelain=v1"]);
    const verificationBranchBefore = git(root, ["symbolic-ref", "HEAD"]).trim();

    const turn = createTurn(root);
    await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "needContext",
      actions: [{ kind: "verification.run", checkIds: ["configured"] }],
      summary: "attempt metadata mutation",
      objections: [],
      unresolved: [],
    }, turn, options(root, verificationBaseline, "npm run verify"), async () => "approve");

    assert.equal(turn.verification[0].status, "failed");
    assert.match(turn.verification[0].summary, /does not execute repository commands or shell wrappers/u);
    assert.equal(git(root, ["status", "--porcelain=v1"]), verificationStatusBefore);
    assert.equal(git(root, ["symbolic-ref", "HEAD"]).trim(), verificationBranchBefore);
    assert.equal(git(root, ["branch", "--list", "verification-temp"]).trim(), "");
    assert.deepEqual(
      await captureManagedRepositoryBaseline(root, new AbortController().signal),
      verificationBaseline,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
