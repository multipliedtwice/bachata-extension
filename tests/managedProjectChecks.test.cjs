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
  taskId: "project-checks",
  originalTask: "type-check the project",
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

const createProject = (prefix, files) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "bachata@example.invalid"]);
  git(root, ["config", "user.name", "Bachata Test"]);
  for (const [relative, contents] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), contents);
  }
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", "baseline"]);
  return root;
};

const TSCONFIG = `${JSON.stringify({
  compilerOptions: { strict: true, noEmit: true, target: "ES2022", module: "commonjs" },
  include: ["src"],
}, undefined, 2)}\n`;

const runProjectChecks = async (root, changedFiles) => {
  const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
  const turn = createTurn(root, changedFiles);
  const [result] = await runManagedControllerVerification(turn, options(root, baseline), ["project-checks"]);
  return result;
};

// EX-A5-R08. Deleting an imported module breaks the importer nobody touched. The deleted path was
// filtered out before the project compiler was selected, so the compile never ran and the check
// recorded a pass for a workspace that no longer builds.
test("deleting an imported TypeScript module fails the project check", async () => {
  const root = createProject("bachata-managed-delete-", {
    "tsconfig.json": TSCONFIG,
    "src/dependency.ts": "export const value = 1;\n",
    "src/consumer.ts": 'import { value } from "./dependency";\nexport const doubled = value * 2;\n',
  });
  try {
    fs.rmSync(path.join(root, "src", "dependency.ts"));
    const deleted = await runProjectChecks(root, ["src/dependency.ts"]);
    assert.equal(
      deleted.status,
      "failed",
      `a deletion that broke an untouched importer was reported as ${deleted.status}: ${deleted.summary}`,
    );
    assert.match(deleted.summary, /dependency/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// EX-A5-R08. A rename is a deletion and an addition, and the deletion half is the one that used
// to be dropped: the new module compiles, the importer still names the old one.
test("renaming a TypeScript module away from its importers fails the project check", async () => {
  const root = createProject("bachata-managed-rename-", {
    "tsconfig.json": TSCONFIG,
    "src/dependency.ts": "export const value = 1;\n",
    "src/consumer.ts": 'import { value } from "./dependency";\nexport const doubled = value * 2;\n',
  });
  try {
    fs.renameSync(path.join(root, "src", "dependency.ts"), path.join(root, "src", "renamed.ts"));
    const renamed = await runProjectChecks(root, ["src/dependency.ts", "src/renamed.ts"]);
    assert.equal(renamed.status, "failed", renamed.summary);
    assert.match(renamed.summary, /dependency/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// EX-A5-R09. The managed check used to resolve and run the reviewed repository's own
// `node_modules/.bin/tsc`, checking only that the link landed inside the dependency directory.
// Containment is not identity: a dependency directory is still the reviewed repository's code.
test("the project check runs Bachata's pinned compiler, never the workspace's own", async () => {
  const root = createProject("bachata-managed-compiler-", {
    "tsconfig.json": TSCONFIG,
    // A genuine type error. Bachata's own compiler reports it; the impostor below does not.
    "src/broken.ts": "export const broken: number = \"not a number\";\n",
  });
  const marker = path.join(root, "impostor-ran.txt");
  try {
    const binDirectory = path.join(root, "node_modules", ".bin");
    const packageDirectory = path.join(root, "node_modules", "typescript", "bin");
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.mkdirSync(packageDirectory, { recursive: true });
    // A compiler the reviewed repository supplies, inside its own dependency directory, that
    // passes everything and records that it was asked.
    fs.writeFileSync(
      path.join(packageDirectory, "tsc"),
      [
        "#!/usr/bin/env node",
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran\\n");`,
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    fs.symlinkSync(path.join("..", "typescript", "bin", "tsc"), path.join(binDirectory, "tsc"));

    const result = await runProjectChecks(root, ["src/broken.ts"]);
    assert.equal(
      fs.existsSync(marker),
      false,
      "the project check executed a compiler the reviewed repository supplied",
    );
    assert.equal(
      result.status,
      "failed",
      `a workspace-supplied compiler passed a project that does not type-check: ${result.summary}`,
    );
    assert.match(result.summary, /broken\.ts/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
