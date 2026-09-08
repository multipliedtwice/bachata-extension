const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ts } = require("ts-morph");
const {
  contextDependencies,
  contextDependentsPage,
  selectInitialContext,
} = require("../dist/context/tsJsContext.js");
const { extractTaskContextSeeds } = require("../dist/browser/managedTurn.js");

const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const sourceIndex = (relativePath, text, imports = []) => ({
  path: relativePath,
  sha256: hash(text),
  version: 1,
  declarations: [],
  imports: imports.map((specifier) => ({ specifier, names: [] })),
  exports: [],
  reExports: [],
  text,
  sizeBytes: Buffer.byteLength(text),
  mtimeMs: Date.now(),
});

const makeIndex = (root, inventory, files) => ({
  workspaceRoot: root,
  allowedPaths: ["talents-backend/src"],
  revision: 1,
  files: new Map(files.map((file) => [file.path, file])),
  inventory: new Set(inventory),
  skippedTooLargePaths: new Set(),
  skippedUnreadablePaths: new Set(),
  skippedBudgetPaths: new Set(),
  skippedFileLimitPaths: new Set(inventory.filter((entry) => !files.some((file) => file.path === entry))),
  coverage: {
    inventoryCount: inventory.length,
    maxInventoryFiles: 100000,
    inventoryTruncated: false,
    inventoryTimedOut: false,
    ignoreFileCount: 0,
    indexedCount: files.length,
    maxFiles: 5000,
    maxFileBytes: 1048576,
    maxTotalBytes: 134217728,
    indexedBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    indexingTimedOut: false,
    truncated: files.length !== inventory.length,
    skippedTooLarge: 0,
    skippedUnreadable: 0,
    skippedBudget: 0,
    skippedFileLimit: inventory.length - files.length,
  },
  compilerOptions: { allowJs: true, moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext },
  ignoreScopes: [],
  inventoryTimeoutMs: 30000,
  indexingTimeoutMs: 30000,
});

test("explicit task directories seed the requested subtree instead of relying on word scoring", () => {
  const root = path.resolve("/tmp/bachata-explicit-seed");
  const inventory = [
    "talents-backend/src/routes/jobs.ts",
    "talents-backend/src/routes/candidates.ts",
    "talents-backend/src/services/jobService.ts",
  ];
  const index = makeIndex(root, inventory, []);
  const seeds = extractTaskContextSeeds(index, root, "let's fix bug blah blah blah in talents-backend/src/routes");
  assert.deepEqual([...seeds].sort(), [
    "talents-backend/src/routes/candidates.ts",
    "talents-backend/src/routes/jobs.ts",
  ]);
});

test("nonresident dependencies are promoted and dependents can be discovered without preloading the repository", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-dependency-"));
  try {
    const paths = {
      route: "talents-backend/src/routes/jobs.ts",
      service: "talents-backend/src/services/jobService.ts",
      repository: "talents-backend/src/repositories/jobRepository.ts",
      consumer: "talents-backend/src/controllers/jobController.ts",
    };
    for (const relative of Object.values(paths)) fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    const routeText = "import { jobService } from '../services/jobService';\nexport const route = jobService;\n";
    const serviceText = "import { repo } from '../repositories/jobRepository';\nexport const jobService = repo;\n";
    const repositoryText = "export const repo = 1;\n";
    const consumerText = "import { jobService } from '../services/jobService';\nexport const controller = jobService;\n";
    fs.writeFileSync(path.join(root, paths.route), routeText);
    fs.writeFileSync(path.join(root, paths.service), serviceText);
    fs.writeFileSync(path.join(root, paths.repository), repositoryText);
    fs.writeFileSync(path.join(root, paths.consumer), consumerText);

    const route = sourceIndex(paths.route, routeText, ["../services/jobService"]);
    const index = makeIndex(root, Object.values(paths), [route]);

    const dependencies = await contextDependencies(index, paths.route);
    assert.deepEqual(dependencies, [{ path: paths.service, specifiers: ["../services/jobService"] }]);
    assert.equal(index.files.has(paths.service), true);

    const nested = await contextDependencies(index, paths.service);
    assert.deepEqual(nested, [{ path: paths.repository, specifiers: ["../repositories/jobRepository"] }]);
    assert.equal(index.files.has(paths.repository), true);

    const dependents = await contextDependentsPage(index, paths.service, {
      maxScanFiles: 100,
      maxScanBytes: 1048576,
      maxFileScanBytes: 1048576,
      timeoutMs: 5000,
    });
    assert.deepEqual(dependents.results.map((entry) => entry.path), [paths.consumer, paths.route]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explicit task seeds outrank generic task-token matches", () => {
  const root = path.resolve("/tmp/bachata-seed-ranking");
  const seedPath = "talents-backend/src/routes/jobs.ts";
  const noisyPath = "other/routes/routes-routes.ts";
  const seed = sourceIndex(seedPath, "export const jobs = 1;\n");
  const noisy = sourceIndex(noisyPath, "export const routes = 'routes routes routes';\n");
  const index = makeIndex(root, [seedPath, noisyPath], [seed, noisy]);
  const selected = selectInitialContext(index, {
    task: "fix the bug in talents-backend/src/routes",
    changedFiles: [],
    seedFiles: [seedPath],
    maxBytes: 65536,
    maxSnippets: 1,
  });
  assert.equal(selected.snippets[0].path, seedPath);
  assert.ok(selected.snippets[0].reason.includes("explicit-task-path"));
});

test("managed structured write and delete use the existing guarded filesystem engine", async () => {
  const { executeManagedBrowserEnvelope } = require("../dist/browser/managedTurn.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-write-delete-"));
  try {
    fs.mkdirSync(path.join(root, "talents-backend/src/routes"), { recursive: true });
    const target = "talents-backend/src/routes/newRoute.ts";
    const index = makeIndex(root, [], []);
    const turn = {
      index,
      snippets: new Map(),
      verification: [],
      workspaceRevision: 1,
      changedFiles: [],
      preexistingChangedFiles: [],
      repositoryPolicyViolations: [],
      diff: "",
      diffOmittedFileCount: 0,
      initialContextOmitted: [],
      initialContextOmittedTotal: 0,
      prompt: "",
    };
    const signal = new AbortController().signal;
    const options = {
      taskId: "mutation-test",
      originalTask: "create a route",
      role: "worker",
      workingDirectory: root,
      readPaths: ["talents-backend/src"],
      allowedPaths: ["talents-backend/src/routes"],
      protectedPaths: [],
      commitMode: "never",
      readOnly: false,
      verificationChecks: [],
      maxRevisionCycles: 1,
      deadlineAt: Date.now() + 60000,
      continuationMaxBytes: 65536,
      handoffTotalBudgetBytes: 262144,
      dependencyDepth: 2,
      promotionMaxBytes: 786432,
      signal,
      executor: { timeoutMs: 5000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
      contextIndex: { maxInventoryFiles: 100000, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
      contextSearch: { maxFiles: 2000, maxBytes: 67108864, maxFileBytes: 8388608, timeoutMs: 15000 },
    };

    const created = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "applyPatch",
      actions: [{ kind: "workspace.write", path: target, content: "export const route = true;\n", expectedFiles: [] }],
      summary: "create route",
      objections: [],
      unresolved: [],
    }, turn, options, async () => "approve");
    assert.equal(fs.readFileSync(path.join(root, target), "utf8"), "export const route = true;\n");
    assert.match(created.nextPrompt, /"status": "completed"/u);

    const sha256 = hash(fs.readFileSync(path.join(root, target)));
    const deleted = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "applyPatch",
      actions: [{ kind: "workspace.delete", path: target, expectedFiles: [{ path: target, sha256 }] }],
      summary: "remove route",
      objections: [],
      unresolved: [],
    }, turn, options, async () => "approve");
    assert.equal(fs.existsSync(path.join(root, target)), false);
    assert.match(deleted.nextPrompt, /"status": "completed"/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed mutation failures expose typed stale-file errors without changing the target", async () => {
  const { executeManagedBrowserEnvelope } = require("../dist/browser/managedTurn.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-stale-"));
  try {
    const target = "talents-backend/src/routes/jobs.ts";
    fs.mkdirSync(path.dirname(path.join(root, target)), { recursive: true });
    fs.writeFileSync(path.join(root, target), "export const jobs = 1;\n");
    const resident = sourceIndex(target, "export const jobs = 1;\n");
    const index = makeIndex(root, [target], [resident]);
    const turn = {
      index,
      snippets: new Map(),
      verification: [],
      workspaceRevision: 1,
      changedFiles: [],
      preexistingChangedFiles: [],
      repositoryPolicyViolations: [],
      diff: "",
      diffOmittedFileCount: 0,
      initialContextOmitted: [],
      initialContextOmittedTotal: 0,
      prompt: "",
    };
    const signal = new AbortController().signal;
    const options = {
      taskId: "stale-test",
      originalTask: "fix jobs route",
      role: "worker",
      workingDirectory: root,
      readPaths: ["talents-backend/src"],
      allowedPaths: ["talents-backend/src/routes"],
      protectedPaths: [],
      commitMode: "never",
      readOnly: false,
      verificationChecks: [],
      maxRevisionCycles: 1,
      deadlineAt: Date.now() + 60000,
      continuationMaxBytes: 65536,
      handoffTotalBudgetBytes: 262144,
      dependencyDepth: 2,
      promotionMaxBytes: 786432,
      signal,
      executor: { timeoutMs: 5000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
      contextIndex: { maxInventoryFiles: 100000, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
      contextSearch: { maxFiles: 2000, maxBytes: 67108864, maxFileBytes: 8388608, timeoutMs: 15000 },
    };
    const result = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "applyPatch",
      actions: [{ kind: "workspace.write", path: target, content: "export const jobs = 2;\n", expectedFiles: [{ path: target, sha256: "f".repeat(64) }] }],
      summary: "stale replacement",
      objections: [],
      unresolved: [],
    }, turn, options, async () => "approve");
    assert.match(result.nextPrompt, /STALE_FILE/u);
    assert.equal(fs.readFileSync(path.join(root, target), "utf8"), "export const jobs = 1;\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
