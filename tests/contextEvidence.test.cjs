const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildManagedTaskHandoff,
  renderManagedTaskHandoff,
} = require("../dist/context/taskHandoff.js");
const {
  collectContextSyntaxCheck,
} = require("../dist/context/tsJsContext.js");

test("managed handoff exposes diff and initial-context omissions", () => {
  const handoff = buildManagedTaskHandoff("worker", {
    taskId: "task",
    originalTask: "change source",
    constraints: ["Do not commit"],
    commitMode: "never",
    readOnly: false,
    allowedPaths: ["src"],
    requiredVerificationCheckIds: ["project-checks"],
    worktreePath: "/tmp/work",
    workspaceRevision: 1,
    changedFiles: ["src/a.ts"],
    preexistingChangedFiles: [],
    repositoryPolicyViolations: [],
    diff: "d".repeat(100_000),
    diffOmittedFileCount: 4,
    initialContextOmitted: [
      { path: "src/omitted.ts", score: 10, reason: ["budget"] },
    ],
    snippets: [],
    contextCoverage: {
      inventoryCount: 2,
      maxInventoryFiles: 100_000,
      inventoryTruncated: false,
      indexedCount: 2,
      maxFiles: 5_000,
      maxFileBytes: 1_048_576,
      maxTotalBytes: 1_000_000,
      indexedBytes: 100,
      truncated: false,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
      skippedBudget: 0,
      skippedFileLimit: 0,
    },
    verification: [],
    unresolved: [],
  }, {
    totalBudgetBytes: 20_000,
    diffBudgetBytes: 10_000,
  });

  assert.equal(handoff.repository.diffTruncated, true);
  assert.equal(handoff.repository.diffOriginalBytes, 100_000);
  assert.ok(handoff.repository.diffRetainedBytes > 0);
  assert.ok(handoff.repository.diffRetainedBytes < handoff.repository.diffOriginalBytes);
  assert.equal(handoff.repository.diffOmittedFileCount, 4);
  assert.equal(handoff.contextSelection.omittedCount, 1);
  assert.equal(handoff.contextSelection.omitted[0].path, "src/omitted.ts");
  assert.ok(Buffer.byteLength(renderManagedTaskHandoff(handoff), "utf8") <= 20_000);
});

test("syntax evidence reports exactly checked and skipped changed paths", () => {
  const file = (path, text) => ({
    path,
    text,
    sha256: "hash",
    version: 1,
    declarations: [],
    imports: [],
    exports: [],
    reExports: [],
  });
  const result = collectContextSyntaxCheck({
    files: new Map([
      ["src/a.ts", file("src/a.ts", "const value: number = 1;")],
      ["src/bad.json", file("src/bad.json", '{"value":}')],
    ]),
  }, ["src/a.ts", "src/bad.json", "src/oversized.ts"]);

  assert.deepEqual(result.checkedPaths, ["src/a.ts", "src/bad.json"]);
  assert.deepEqual(result.skippedPaths, ["src/oversized.ts"]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].path, "src/bad.json");
});

test("managed handoff bounds large dirty metadata while retaining source context", () => {
  const paths = Array.from({ length: 10_000 }, (_, index) => `packages/workspace-${String(index).padStart(5, "0")}/src/generated-or-preexisting-file-${String(index).padStart(5, "0")}.ts`);
  const snippetText = "export const releaseCriticalValue = 42;\n".repeat(200);
  const handoff = buildManagedTaskHandoff("worker", {
    taskId: "large-dirty-task",
    originalTask: "Fix the release-critical source without touching unrelated pre-existing changes.",
    constraints: ["Do not commit"],
    commitMode: "never",
    readOnly: false,
    allowedPaths: ["packages"],
    requiredVerificationCheckIds: ["workspace-integrity", "project-checks"],
    worktreePath: "/tmp/large-worktree",
    workspaceRevision: 5,
    changedFiles: ["packages/app/src/release.ts"],
    preexistingChangedFiles: paths,
    repositoryPolicyViolations: [],
    diff: "",
    diffOmittedFileCount: 0,
    initialContextOmitted: [],
    snippets: [{
      id: "release-critical",
      path: "packages/app/src/release.ts",
      startLine: 1,
      endLine: 200,
      sha256: "a".repeat(64),
      hashScope: "file",
      reason: ["task-term"],
      text: snippetText,
    }],
    contextCoverage: {
      inventoryCount: 10_001,
      maxInventoryFiles: 100_000,
      inventoryTruncated: false,
      indexedCount: 5_000,
      maxFiles: 5_000,
      maxFileBytes: 1_048_576,
      maxTotalBytes: 134_217_728,
      indexedBytes: 10_000_000,
      truncated: true,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
      skippedBudget: 5_001,
      skippedFileLimit: 0,
    },
    verification: [],
    unresolved: [],
  });

  assert.ok(handoff.metadataCoverage.preexistingChangedFiles.omitted > 0);
  assert.equal(handoff.metadataCoverage.preexistingChangedFiles.total, 10_000);
  assert.deepEqual(handoff.metadataCoverage.preexistingChangedFiles.retrieval, {
    kind: "context.readMetadata",
    field: "preexistingChangedFiles",
    nextOffset: handoff.metadataCoverage.preexistingChangedFiles.included,
    workspaceRevision: 5,
  });
  assert.ok(handoff.context.some((snippet) => snippet.id === "release-critical"));
  assert.ok(Buffer.byteLength(renderManagedTaskHandoff(handoff), "utf8") <= 96_000);
});

test("managed handoff includes byte-capped context manifest", () => {
  const manifest = Array.from({ length: 500 }, (_, index) => ({
    path: `src/module-${String(index).padStart(4, "0")}/service-with-a-reasonably-long-name.ts`,
    lineCount: 120,
    exports: ["handleRequest", "handleResponse", "router", "middleware", "constants"],
  }));
  const handoff = buildManagedTaskHandoff("worker", {
    taskId: "manifest-task",
    originalTask: "review module wiring",
    constraints: [],
    commitMode: "never",
    readOnly: false,
    allowedPaths: ["src"],
    requiredVerificationCheckIds: [],
    worktreePath: "/tmp/work",
    workspaceRevision: 2,
    changedFiles: [],
    preexistingChangedFiles: [],
    repositoryPolicyViolations: [],
    diff: "",
    diffOmittedFileCount: 0,
    initialContextOmitted: [],
    snippets: [],
    contextManifest: manifest,
    contextCoverage: {
      inventoryCount: 500,
      maxInventoryFiles: 100_000,
      inventoryTruncated: false,
      indexedCount: 500,
      maxFiles: 5_000,
      maxFileBytes: 1_048_576,
      maxTotalBytes: 134_217_728,
      indexedBytes: 1_000_000,
      truncated: false,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
      skippedBudget: 0,
      skippedFileLimit: 0,
    },
    verification: [],
    unresolved: [],
  });

  assert.equal(handoff.contextManifestCoverage.total, 500);
  assert.ok(handoff.contextManifestCoverage.included > 0);
  assert.ok(handoff.contextManifestCoverage.included < 500);
  assert.equal(handoff.contextManifestCoverage.truncated, true);
  assert.ok(handoff.contextManifestCoverage.retainedBytes <= 8 * 1024);
  assert.deepEqual(handoff.contextManifest[0], {
    path: "src/module-0000/service-with-a-reasonably-long-name.ts",
    lineCount: 120,
    exports: ["handleRequest", "handleResponse", "router", "middleware", "constants"],
  });
  assert.ok(Buffer.byteLength(renderManagedTaskHandoff(handoff), "utf8") <= 96_000);
});

test("context manifest scales with handoff budget fractions", () => {
  const baseInput = {
    taskId: "fraction-task",
    originalTask: "task",
    constraints: [],
    commitMode: "never",
    readOnly: false,
    allowedPaths: ["src"],
    requiredVerificationCheckIds: [],
    worktreePath: "/tmp/work",
    workspaceRevision: 1,
    changedFiles: [],
    preexistingChangedFiles: [],
    repositoryPolicyViolations: [],
    diff: "",
    diffOmittedFileCount: 0,
    initialContextOmitted: [],
    snippets: [],
    contextCoverage: {
      inventoryCount: 0,
      maxInventoryFiles: 100_000,
      inventoryTruncated: false,
      indexedCount: 0,
      maxFiles: 5_000,
      maxFileBytes: 1_048_576,
      maxTotalBytes: 1_000_000,
      indexedBytes: 0,
      truncated: false,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
      skippedBudget: 0,
      skippedFileLimit: 0,
    },
    verification: [],
    unresolved: [],
  };
  const optionsFor = (totalBudgetBytes) => ({
    totalBudgetBytes,
    diffBudgetBytes: Math.floor((totalBudgetBytes * 32_000) / 262_144),
    snippetBudgetBytes: Math.floor((totalBudgetBytes * 176_000) / 262_144),
  });
  const atDefault = buildManagedTaskHandoff("worker", baseInput, optionsFor(262_144));
  const atMax = buildManagedTaskHandoff("worker", baseInput, optionsFor(512_000));

  assert.ok(Buffer.byteLength(renderManagedTaskHandoff(atDefault), "utf8") <= 262_144);
  assert.ok(Buffer.byteLength(renderManagedTaskHandoff(atMax), "utf8") <= 512_000);
  const bigDiff = "d".repeat(60_000);
  const withDiff = buildManagedTaskHandoff("worker", { ...baseInput, diff: bigDiff }, optionsFor(512_000));
  assert.equal(withDiff.repository.diffOriginalBytes, 60_000);
  assert.equal(withDiff.repository.diffTruncated, false, "diff budget scales with total budget");
});
