const assert = require("node:assert/strict");
const test = require("node:test");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");

const {
  buildTsJsContextIndex,
  refreshContextFiles,
} = require("../dist/context/tsJsContext.js");

const withWorkspace = async (files, fn) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-context-ignore-"));
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

test("nested ignore files retain directory scope, override order, and escaped patterns", async () => {
  await withWorkspace({
    ".gitignore": "keep.ts\n",
    "root.ts": "export const root = true;\n",
    "packages/app/.gitignore": [
      "generated.ts",
      "!keep.ts",
      "/anchored.ts",
      "\\#literal.ts",
      "\\!literal.ts",
      "blocked/",
    ].join("\n"),
    "packages/app/sub/.gitignore": "!generated.ts\n",
    "packages/app/blocked/.gitignore": "!inside.ts\n",
    "packages/app/generated.ts": "export const ignored = true;\n",
    "packages/app/sub/generated.ts": "export const restored = true;\n",
    "packages/other/generated.ts": "export const outsideScope = true;\n",
    "packages/app/keep.ts": "export const childOverride = true;\n",
    "packages/other/keep.ts": "export const rootIgnored = true;\n",
    "packages/app/anchored.ts": "export const anchoredIgnored = true;\n",
    "packages/app/sub/anchored.ts": "export const nestedAnchored = true;\n",
    "packages/app/#literal.ts": "export const hashLiteral = true;\n",
    "packages/app/!literal.ts": "export const bangLiteral = true;\n",
    "packages/app/blocked/inside.ts": "export const blocked = true;\n",
  }, async (workspaceRoot) => {
    const index = await buildTsJsContextIndex({
      workspaceRoot,
      maxFiles: 100,
      maxInventoryFiles: 1_000,
    });

    assert.equal(index.coverage.inventoryTruncated, false);
    assert.equal(index.coverage.ignoreFileCount, 3);
    assert.equal(index.inventory.has("root.ts"), true);
    assert.equal(index.inventory.has("packages/app/generated.ts"), false);
    assert.equal(index.inventory.has("packages/app/sub/generated.ts"), true);
    assert.equal(index.inventory.has("packages/other/generated.ts"), true);
    assert.equal(index.inventory.has("packages/app/keep.ts"), true);
    assert.equal(index.inventory.has("packages/other/keep.ts"), false);
    assert.equal(index.inventory.has("packages/app/anchored.ts"), false);
    assert.equal(index.inventory.has("packages/app/sub/anchored.ts"), true);
    assert.equal(index.inventory.has("packages/app/#literal.ts"), false);
    assert.equal(index.inventory.has("packages/app/!literal.ts"), false);
    assert.equal(index.inventory.has("packages/app/blocked/inside.ts"), false);
  });
});

test("restricted context scope reads only relevant ancestor and descendant ignore files", async () => {
  await withWorkspace({
    ".gitignore": "*.root-ignored.ts\n",
    "packages/.gitignore": "package-ignored.ts\n",
    "packages/app/.gitignore": "app-ignored.ts\n",
    "packages/app/source.ts": "export const source = true;\n",
    "packages/app/app-ignored.ts": "export const ignored = true;\n",
    "packages/app/package-ignored.ts": "export const ignoredByAncestor = true;\n",
    "packages/other/.gitignore": "source.ts\n",
    "packages/other/source.ts": "export const other = true;\n",
  }, async (workspaceRoot) => {
    const index = await buildTsJsContextIndex({
      workspaceRoot,
      allowedPaths: ["packages/app/"],
      maxFiles: 100,
    });

    assert.equal(index.coverage.ignoreFileCount, 3);
    assert.deepEqual([...index.inventory], ["packages/app/source.ts"]);
  });
});

test("changing a nested ignore file rebuilds inventory without retaining ignored resident files", async () => {
  await withWorkspace({
    "packages/app/source.ts": "export const source = true;\n",
    "packages/app/generated.ts": "export const generated = true;\n",
  }, async (workspaceRoot) => {
    const index = await buildTsJsContextIndex({ workspaceRoot, maxFiles: 100 });
    assert.equal(index.files.has("packages/app/generated.ts"), true);

    await fs.writeFile(path.join(workspaceRoot, "packages/app/.gitignore"), "generated.ts\n");
    await refreshContextFiles(index, ["packages/app/.gitignore"]);

    assert.equal(index.coverage.ignoreFileCount, 1);
    assert.equal(index.inventory.has("packages/app/generated.ts"), false);
    assert.equal(index.files.has("packages/app/generated.ts"), false);
    assert.equal(index.inventory.has("packages/app/source.ts"), true);
  });
});

test("context index cache is discarded when repository inventory changes", async () => {
  await withWorkspace({
    "a.ts": "export const a = true;\n",
    "b.ts": "export const b = true;\n",
  }, async (workspaceRoot) => {
    const first = await buildTsJsContextIndex({ workspaceRoot, maxFiles: 2 });
    assert.deepEqual([...first.files.keys()].sort(), ["a.ts", "b.ts"]);

    await fs.rm(path.join(workspaceRoot, "a.ts"));
    await fs.writeFile(path.join(workspaceRoot, "c.ts"), "export const c = true;\n");

    const second = await buildTsJsContextIndex({ workspaceRoot, maxFiles: 2 });
    assert.deepEqual([...second.inventory].sort(), ["b.ts", "c.ts"]);
    assert.deepEqual([...second.files.keys()].sort(), ["b.ts", "c.ts"]);
    assert.equal(second.coverage.indexedCount, 2);
  });
});

test("context index cache reloads compiler settings even when config files are nonresident", async () => {
  await withWorkspace({
    "a.ts": "export const a = true;\n",
    "b.ts": "export const b = true;\n",
    "c.ts": "export const c = true;\n",
    "tsconfig.json": JSON.stringify({ compilerOptions: { module: "CommonJS" } }),
  }, async (workspaceRoot) => {
    const typescript = require("typescript");
    const first = await buildTsJsContextIndex({ workspaceRoot, maxFiles: 1 });
    assert.equal(first.files.has("tsconfig.json"), false);
    assert.equal(first.compilerOptions.module, typescript.ModuleKind.CommonJS);

    await fs.writeFile(
      path.join(workspaceRoot, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "ESNext" } }),
    );

    const second = await buildTsJsContextIndex({ workspaceRoot, maxFiles: 1 });
    assert.equal(second.compilerOptions.module, typescript.ModuleKind.ESNext);
  });
});
test("context index cache backfills resident capacity after a cached file becomes ineligible", async () => {
  await withWorkspace({
    "a.ts": "export const a = true;\n",
    "b.ts": "export const b = true;\n",
    "c.ts": "export const c = true;\n",
  }, async (workspaceRoot) => {
    const first = await buildTsJsContextIndex({
      workspaceRoot,
      maxFiles: 2,
      maxFileBytes: 128,
      maxTotalBytes: 256,
    });
    assert.deepEqual([...first.files.keys()].sort(), ["a.ts", "c.ts"]);

    await fs.writeFile(path.join(workspaceRoot, "a.ts"), "x".repeat(256));

    const second = await buildTsJsContextIndex({
      workspaceRoot,
      maxFiles: 2,
      maxFileBytes: 128,
      maxTotalBytes: 256,
    });
    assert.deepEqual([...second.files.keys()].sort(), ["b.ts", "c.ts"]);
    assert.equal(second.skippedTooLargePaths.has("a.ts"), true);
    assert.equal(second.coverage.indexedCount, 2);
  });
});

test("changing an ignore file backfills newly unignored files into available resident capacity", async () => {
  await withWorkspace({
    "packages/app/.gitignore": "generated.ts\n",
    "packages/app/source.ts": "export const source = true;\n",
    "packages/app/stable.ts": "export const stable = true;\n",
    "packages/app/generated.ts": "export const generated = true;\n",
  }, async (workspaceRoot) => {
    const index = await buildTsJsContextIndex({ workspaceRoot, maxFiles: 3 });
    assert.deepEqual([...index.files.keys()].sort(), [
      "packages/app/source.ts",
      "packages/app/stable.ts",
    ]);

    await fs.writeFile(path.join(workspaceRoot, "packages/app/.gitignore"), "");
    await refreshContextFiles(index, ["packages/app/.gitignore"]);

    assert.deepEqual([...index.inventory].sort(), [
      "packages/app/generated.ts",
      "packages/app/source.ts",
      "packages/app/stable.ts",
    ]);
    assert.deepEqual([...index.files.keys()].sort(), [
      "packages/app/generated.ts",
      "packages/app/source.ts",
      "packages/app/stable.ts",
    ]);
  });
});

test("a timed-out cache refresh cannot leave the prior snapshot reusable", async () => {
  await withWorkspace({
    "a.ts": "export const a = 1;\n",
    "b.ts": "export const b = 1;\n",
  }, async (workspaceRoot) => {
    const first = await buildTsJsContextIndex({
      workspaceRoot,
      maxFiles: 2,
      indexingTimeoutMs: 1_000,
    });
    assert.equal(first.files.get("a.ts")?.version, 1);

    await fs.writeFile(path.join(workspaceRoot, "a.ts"), "export const a = 222;\n");
    const originalLstat = fs.lstat;
    let delayedCalls = 0;
    fs.lstat = async (...args) => {
      if (delayedCalls < 2) {
        delayedCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 600));
      }
      return await originalLstat(...args);
    };
    try {
      const timedOut = await buildTsJsContextIndex({
        workspaceRoot,
        maxFiles: 2,
        indexingTimeoutMs: 1_000,
      });
      assert.equal(timedOut.coverage.indexingTimedOut, true);
    } finally {
      fs.lstat = originalLstat;
    }

    const rebuilt = await buildTsJsContextIndex({
      workspaceRoot,
      maxFiles: 2,
      indexingTimeoutMs: 1_000,
    });
    assert.equal(rebuilt.files.get("a.ts")?.version, 1);
    assert.match(rebuilt.files.get("a.ts")?.text ?? "", /222/);
  });
});
