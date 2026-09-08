const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { executeManagedBrowserEnvelope } = require("../dist/browser/managedTurn.js");

test("managed continuation stays within its aggregate local bound", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-continuation-"));
  try {
    const actions = [];
    for (let index = 0; index < 16; index += 1) {
      const file = `src/file-${String(index)}.ts`;
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.writeFileSync(path.join(root, file), `${"export const value = '" + "x".repeat(180) + "';\n"}`.repeat(400));
      actions.push({ kind: "context.readFile", path: file });
    }

    const turn = {
      index: {
        root,
        files: new Map(),
        byBasename: new Map(),
        bySymbol: new Map(),
        coverage: {
          inventoryCount: 16,
          maxInventoryFiles: 100000,
          inventoryTruncated: false,
          indexedCount: 0,
          maxFiles: 5000,
          maxFileBytes: 1048576,
          maxTotalBytes: 134217728,
          indexedBytes: 0,
          truncated: false,
          skippedTooLarge: 0,
          skippedUnreadable: 0,
          skippedBudget: 0,
          skippedFileLimit: 0,
        },
      },
      snippets: new Map(),
      verification: [],
      workspaceRevision: 0,
      changedFiles: [],
      preexistingChangedFiles: [],
      repositoryPolicyViolations: [],
      diff: "",
      diffOmittedFileCount: 0,
      initialContextOmitted: [],
      prompt: "",
    };
    const controller = new AbortController();
    const execution = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "needContext",
      actions,
      summary: "read bounded context",
      objections: [],
      unresolved: [],
    }, turn, {
      taskId: "task",
      originalTask: "inspect files",
      role: "worker",
      workingDirectory: root,
      allowedPaths: ["src"],
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
      signal: controller.signal,
      executor: { timeoutMs: 5000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
      contextIndex: { maxInventoryFiles: 100000, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
      contextSearch: { maxFiles: 2000, maxBytes: 67108864, maxFileBytes: 8388608, timeoutMs: 15000 },
    }, async () => "approve");

    assert.equal(execution.recognized, true);
    assert.ok(execution.nextPrompt);
    assert.ok(Buffer.byteLength(execution.nextPrompt, "utf8") <= 65536);
    assert.match(execution.nextPrompt, /resultPayloadTruncated/u);
    assert.match(execution.nextPrompt, /omittedResultCount/u);
    assert.equal(turn.snippets.size, 16);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed handoff task and metadata truncation remain retrievable in bounded pages", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-handoff-pages-"));
  try {
    const originalTask = `${"ก".repeat(12000)}\n${"task-tail".repeat(3000)}`;
    const preexistingChangedFiles = Array.from({ length: 300 }, (_, index) => `src/preexisting-${String(index).padStart(4, "0")}.ts`);
    const turn = {
      index: {
        root,
        files: new Map(),
        byBasename: new Map(),
        bySymbol: new Map(),
        coverage: {
          inventoryCount: 300,
          maxInventoryFiles: 100000,
          inventoryTruncated: false,
          indexedCount: 0,
          maxFiles: 5000,
          maxFileBytes: 1048576,
          maxTotalBytes: 134217728,
          indexedBytes: 0,
          truncated: false,
          skippedTooLarge: 0,
          skippedUnreadable: 0,
          skippedBudget: 0,
          skippedFileLimit: 0,
        },
      },
      snippets: new Map(),
      verification: [],
      workspaceRevision: 0,
      changedFiles: [],
      preexistingChangedFiles,
      repositoryPolicyViolations: [],
      diff: "",
      diffOmittedFileCount: 0,
      initialContextOmitted: [],
      prompt: "",
    };
    const controller = new AbortController();
    const options = {
      taskId: "task-pages",
      originalTask,
      role: "worker",
      workingDirectory: root,
      allowedPaths: ["src"],
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
      signal: controller.signal,
      executor: { timeoutMs: 5000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
      contextIndex: { maxInventoryFiles: 100000, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
      contextSearch: { maxFiles: 2000, maxBytes: 67108864, maxFileBytes: 8388608, timeoutMs: 15000 },
      initialUnresolved: ["retain unresolved state"],
    };
    const execution = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "needContext",
      actions: [
        { kind: "context.readTask", offsetBytes: 16384, maxBytes: 4096 },
        { kind: "context.readMetadata", field: "preexistingChangedFiles", offset: 128, limit: 32 },
        { kind: "context.readMetadata", field: "unresolved", offset: 0, limit: 8 },
      ],
      summary: "retrieve omitted handoff state",
      objections: [],
      unresolved: [],
    }, turn, options, async () => "approve");

    assert.equal(execution.recognized, true);
    assert.ok(execution.nextPrompt);
    assert.ok(Buffer.byteLength(execution.nextPrompt, "utf8") <= 65536);
    assert.match(execution.nextPrompt, /context\.readTask/u);
    assert.match(execution.nextPrompt, /nextOffsetBytes/u);
    assert.match(execution.nextPrompt, /preexisting-0128\.ts/u);
    assert.match(execution.nextPrompt, /retain unresolved state/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed context.list pages directories larger than ten thousand entries without rescanning the whole directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-wide-directory-"));
  try {
    const wide = path.join(root, "wide");
    fs.mkdirSync(wide, { recursive: true });
    for (let index = 0; index < 10025; index += 1) {
      fs.writeFileSync(path.join(wide, `file-${String(index).padStart(5, "0")}.ts`), "");
    }
    const turn = {
      index: {
        root,
        workspaceRoot: root,
        allowedPaths: ["wide"],
        revision: 0,
        files: new Map(),
        inventory: new Set(),
        skippedTooLargePaths: new Set(),
        skippedUnreadablePaths: new Set(),
        skippedBudgetPaths: new Set(),
        skippedFileLimitPaths: new Set(),
        coverage: {
          inventoryCount: 10025,
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
          truncated: true,
          skippedTooLarge: 0,
          skippedUnreadable: 0,
          skippedBudget: 0,
          skippedFileLimit: 10025,
        },
        compilerOptions: {},
        ignoreScopes: [],
        inventoryTimeoutMs: 30000,
        indexingTimeoutMs: 30000,
      },
      snippets: new Map(),
      verification: [],
      workspaceRevision: 0,
      changedFiles: [],
      preexistingChangedFiles: [],
      repositoryPolicyViolations: [],
      diff: "",
      diffOmittedFileCount: 0,
      initialContextOmitted: [],
      initialContextOmittedTotal: 0,
      prompt: "",
    };
    const controller = new AbortController();
    const managedOptions = {
      taskId: "wide-list",
      originalTask: "list a very wide directory",
      role: "worker",
      workingDirectory: root,
      allowedPaths: ["wide"],
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
      signal: controller.signal,
      executor: { timeoutMs: 5000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
      contextIndex: { maxInventoryFiles: 100000, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
      contextSearch: { maxFiles: 2000, maxBytes: 67108864, maxFileBytes: 8388608, timeoutMs: 15000 },
    };

    const first = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "needContext",
      actions: [{ kind: "context.list", path: "wide", limit: 2 }],
      summary: "first page",
      objections: [],
      unresolved: [],
    }, turn, managedOptions, async () => "approve");
    assert.match(first.nextPrompt, /"nextCursor": "2"/u);

    const second = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "needContext",
      actions: [{ kind: "context.list", path: "wide", cursor: "2", limit: 2 }],
      summary: "second page",
      objections: [],
      unresolved: [],
    }, turn, managedOptions, async () => "approve");
    assert.match(second.nextPrompt, /"nextCursor": "4"/u);

    await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "done",
      actions: [],
      summary: "complete",
      objections: [],
      unresolved: [],
    }, turn, managedOptions, async () => "approve");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed reads may cross the writable boundary while mutations remain scoped", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-read-write-scope-"));
  try {
    fs.mkdirSync(path.join(root, "talents-backend/src/routes"), { recursive: true });
    fs.mkdirSync(path.join(root, "talents-backend/src/services"), { recursive: true });
    fs.writeFileSync(path.join(root, "talents-backend/src/services/jobService.ts"), "export const jobService = 1;\n");
    const turn = {
      index: {
        workspaceRoot: root,
        allowedPaths: ["talents-backend/src"],
        revision: 1,
        files: new Map(),
        inventory: new Set(["talents-backend/src/services/jobService.ts"]),
        skippedTooLargePaths: new Set(),
        skippedUnreadablePaths: new Set(),
        skippedBudgetPaths: new Set(),
        skippedFileLimitPaths: new Set(),
        coverage: {
          inventoryCount: 1,
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
          truncated: true,
          skippedTooLarge: 0,
          skippedUnreadable: 0,
          skippedBudget: 0,
          skippedFileLimit: 1,
        },
        compilerOptions: {},
        ignoreScopes: [],
        inventoryTimeoutMs: 30000,
        indexingTimeoutMs: 30000,
      },
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
    const controller = new AbortController();
    const options = {
      taskId: "scope-test",
      originalTask: "fix the route bug",
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
      signal: controller.signal,
      executor: { timeoutMs: 5000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
      contextIndex: { maxInventoryFiles: 100000, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
      contextSearch: { maxFiles: 2000, maxBytes: 67108864, maxFileBytes: 8388608, timeoutMs: 15000 },
    };

    const read = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "needContext",
      actions: [{ kind: "context.readFile", path: "talents-backend/src/services/jobService.ts" }],
      summary: "inspect dependency",
      objections: [],
      unresolved: [],
    }, turn, options, async () => "approve");
    assert.match(read.nextPrompt, /jobService/u);
    assert.doesNotMatch(read.nextPrompt, /PATH_OUTSIDE_READ_SCOPE/u);

    const write = await executeManagedBrowserEnvelope({
      protocol: "bachata-browser-turn-v1",
      status: "applyPatch",
      actions: [{
        kind: "workspace.write",
        path: "talents-backend/src/services/jobService.ts",
        content: "export const jobService = 2;\n",
        expectedFiles: [],
      }],
      summary: "attempt out-of-scope write",
      objections: [],
      unresolved: [],
    }, turn, options, async () => "approve");
    assert.match(write.nextPrompt, /PATH_OUTSIDE_WRITE_SCOPE/u);
    assert.equal(fs.readFileSync(path.join(root, "talents-backend/src/services/jobService.ts"), "utf8"), "export const jobService = 1;\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
