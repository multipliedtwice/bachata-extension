const assert = require("node:assert/strict");
const test = require("node:test");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const {
  buildTsJsContextIndex,
  searchContextIndexPage,
} = require("../dist/context/tsJsContext.js");

const withWorkspace = async (files, fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-context-search-"));
  try {
    for (const [relativePath, contents] of Object.entries(files)) {
      const absolute = path.join(root, relativePath);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, contents);
    }
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

test("repository search stops at the path budget and resumes with a query-bound cursor", async () => {
  await withWorkspace({
    "a.ts": "export const alpha = 1;\n",
    "b.ts": "export const beta = 2;\n",
    "c.ts": "export const targetNeedle = 3;\n",
  }, async (workspaceRoot) => {
    const index = await buildTsJsContextIndex({ workspaceRoot, maxFiles: 1 });
    const first = await searchContextIndexPage(index, {
      query: "targetNeedle",
      maxScanFiles: 1,
      maxScanBytes: 1024 * 1024,
      maxFileScanBytes: 1024 * 1024,
      timeoutMs: 5_000,
    });
    assert.equal(first.scan.pathsExamined, 1);
    assert.ok(first.scan.filesScanned <= 1);
    assert.equal(first.scan.stoppedBy, "fileLimit");
    assert.ok(first.nextCursor);
    assert.equal(first.snippets.some((snippet) => snippet.path === "c.ts"), false);

    const second = await searchContextIndexPage(index, {
      query: "targetNeedle",
      cursor: first.nextCursor,
      maxScanFiles: 1,
      maxScanBytes: 1024 * 1024,
      maxFileScanBytes: 1024 * 1024,
      timeoutMs: 5_000,
    });
    assert.equal(second.scan.pathsExamined, 1);
    assert.equal(second.scan.filesScanned, 1);
    assert.equal(second.scan.exhausted, true);
    assert.equal(second.snippets.some((snippet) => snippet.path === "c.ts"), true);

    await assert.rejects(
      searchContextIndexPage(index, {
        query: "differentNeedle",
        cursor: first.nextCursor,
      }),
      /cursor does not match/i,
    );
  });
});

test("bounded omitted-file search can discover source files larger than the resident-file limit", async () => {
  const largeText = `${"x".repeat(1024 * 1024 + 64 * 1024)}\nexport const largeFileNeedle = true;\n`;
  await withWorkspace({
    "a-resident.ts": "export const resident = true;\n",
    "z-large.ts": largeText,
  }, async (workspaceRoot) => {
    const index = await buildTsJsContextIndex({
      workspaceRoot,
      maxFiles: 1,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
    });
    const result = await searchContextIndexPage(index, {
      query: "largeFileNeedle",
      maxScanFiles: 4,
      maxScanBytes: 4 * 1024 * 1024,
      maxFileScanBytes: 3 * 1024 * 1024,
      timeoutMs: 5_000,
    });
    assert.equal(result.snippets.some((snippet) => snippet.path === "z-large.ts"), true);
    assert.ok(result.scan.bytesScanned > 1024 * 1024);
  });
});

test("inventory enumeration is bounded while explicitly requested files can still be promoted", async () => {
  const { refreshContextFiles } = require("../dist/context/tsJsContext.js");
  await withWorkspace({
    "a.ts": "export const a = 1;\n",
    "b.ts": "export const b = 2;\n",
    "c.ts": "export const promotedNeedle = 3;\n",
  }, async (workspaceRoot) => {
    const index = await buildTsJsContextIndex({
      workspaceRoot,
      maxFiles: 1,
      maxInventoryFiles: 2,
    });
    assert.equal(index.coverage.inventoryCount, 2);
    assert.equal(index.coverage.maxInventoryFiles, 2);
    assert.equal(index.coverage.inventoryTruncated, true);
    await refreshContextFiles(index, ["c.ts"]);
    assert.equal(index.inventory.has("c.ts"), true);
    assert.equal(index.files.has("c.ts"), true);
    assert.equal(index.coverage.inventoryTruncated, true);
  });
});

test("search result pagination does not discard resident or omitted matches", async () => {
  await withWorkspace({
    "a.ts": "export const sharedNeedleA = true;\n",
    "b.ts": "export const sharedNeedleB = true;\n",
    "c.ts": "export const sharedNeedleC = true;\n",
    "d.ts": "export const sharedNeedleD = true;\n",
  }, async (workspaceRoot) => {
    const index = await buildTsJsContextIndex({ workspaceRoot, maxFiles: 1 });
    const paths = new Set();
    let cursor;
    for (let page = 0; page < 10; page += 1) {
      const result = await searchContextIndexPage(index, {
        query: "sharedNeedle",
        cursor,
        maxSnippets: 1,
        maxScanFiles: 10,
        maxScanBytes: 1024 * 1024,
        maxFileScanBytes: 1024 * 1024,
        timeoutMs: 5_000,
      });
      for (const snippet of result.snippets) paths.add(snippet.path);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual([...paths].sort(), ["a.ts", "b.ts", "c.ts", "d.ts"]);
    assert.equal(cursor, undefined);
  });
});

test("search ranking bounds model-generated token fanout", async () => {
  const tokens = Array.from({ length: 70 }, (_, index) => `s${String(index).padStart(3, "0")}`);
  const relativePath = `${tokens.join("/")}/target.ts`;
  await withWorkspace({
    [relativePath]: "export const target = true;\n",
  }, async (workspaceRoot) => {
    const index = await buildTsJsContextIndex({ workspaceRoot, maxFiles: 1 });
    const result = await searchContextIndexPage(index, {
      query: tokens.join(" "),
      maxSnippets: 1,
      timeoutMs: 5_000,
    });
    const snippet = result.snippets.find((entry) => entry.path === relativePath);
    assert.ok(snippet);
    assert.equal(snippet.reason.filter((reason) => reason.startsWith("path:")).length, 64);
  });
});
