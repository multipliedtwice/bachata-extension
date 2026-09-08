const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildTsJsContextIndex,
  promoteContextDependencies,
} = require("../dist/context/tsJsContext.js");

const withImportChain = async (run) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-depth-"));
  await fs.writeFile(path.join(root, "entry.ts"), 'import { one } from "./one";\nexport const entry = one;\n');
  await fs.writeFile(path.join(root, "one.ts"), 'import { two } from "./two";\nexport const one = two;\n');
  await fs.writeFile(path.join(root, "two.ts"), 'import { three } from "./three";\nexport const two = three;\n');
  await fs.writeFile(path.join(root, "three.ts"), 'export const three = 3;\n');
  try {
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

const promoteAtDepth = async (root, depth) => {
  const index = await buildTsJsContextIndex({ workspaceRoot: root, maxFiles: 1 });
  return await promoteContextDependencies(index, ["entry.ts"], undefined, depth);
};

test("initial context expands through indexed imports to the default depth", async () => {
  await withImportChain(async (root) => {
    const promoted = await promoteAtDepth(root, 2);
    assert.deepEqual(promoted, ["one.ts", "two.ts"]);
    assert.ok(!promoted.includes("three.ts"), "depth 2 must not reach the third hop");
  });
});

test("dependency expansion depth is configurable in both directions", async () => {
  await withImportChain(async (root) => {
    assert.deepEqual(await promoteAtDepth(root, 1), ["one.ts"]);
    assert.deepEqual(await promoteAtDepth(root, 3), ["one.ts", "three.ts", "two.ts"]);
  });
});

test("zero and negative depth promote nothing instead of inverting the bound", async () => {
  await withImportChain(async (root) => {
    assert.deepEqual(await promoteAtDepth(root, 0), []);
    assert.deepEqual(await promoteAtDepth(root, -5), []);
  });
});
