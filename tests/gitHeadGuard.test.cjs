const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const run = promisify(execFile);
const { captureGitHeadSnapshot, assertGitHeadUnchanged } = require("../dist/adapters/gitHeadGuard.js");

test("no-commit guard detects an indirect commit after a native turn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-git-head-"));
  try {
    await run("git", ["init"], { cwd: root });
    await run("git", ["config", "user.email", "bachata@example.invalid"], { cwd: root });
    await run("git", ["config", "user.name", "Bachata"], { cwd: root });
    await fs.writeFile(path.join(root, "value.txt"), "one\n");
    await run("git", ["add", "value.txt"], { cwd: root });
    await run("git", ["commit", "-m", "initial"], { cwd: root });
    const baseline = await captureGitHeadSnapshot(root);
    await fs.writeFile(path.join(root, "value.txt"), "two\n");
    await run("git", ["add", "value.txt"], { cwd: root });
    await run("git", ["commit", "-m", "forbidden"], { cwd: root });
    await assert.rejects(assertGitHeadUnchanged(root, baseline), /Git HEAD changed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("no-commit guard detects the first commit in an unborn repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-git-head-unborn-"));
  try {
    await run("git", ["init"], { cwd: root });
    await run("git", ["config", "user.email", "bachata@example.invalid"], { cwd: root });
    await run("git", ["config", "user.name", "Bachata"], { cwd: root });
    const baseline = await captureGitHeadSnapshot(root);
    assert.ok(baseline);
    assert.equal(baseline.head, "");
    await fs.writeFile(path.join(root, "value.txt"), "one\n");
    await run("git", ["add", "value.txt"], { cwd: root });
    await run("git", ["commit", "-m", "forbidden-first"], { cwd: root });
    await assert.rejects(assertGitHeadUnchanged(root, baseline), /Git HEAD changed/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
