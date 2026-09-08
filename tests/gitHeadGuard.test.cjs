const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const run = promisify(execFile);
const { captureGitHeadSnapshot, assertGitHeadUnchanged } = require("../dist/adapters/gitHeadGuard.js");
const { captureCycleBaseline, resolveRepositoryTopLevel } = require("../dist/longitudinal/repositoryBaseline.js");

test("native Git snapshots ignore an implicit working-directory executable shadow", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-git-head-shadow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await run("git", ["init"], { cwd: root });
  await run("git", ["config", "user.email", "bachata@example.invalid"], { cwd: root });
  await run("git", ["config", "user.name", "Bachata"], { cwd: root });
  await fs.writeFile(path.join(root, "value.txt"), "baseline\n");
  await run("git", ["add", "value.txt"], { cwd: root });
  await run("git", ["commit", "-m", "initial"], { cwd: root });
  const expectedHead = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const environmentBefore = { ...process.env };
  await fs.writeFile(path.join(root, "git.exe"), "workspace file must never become the Git executable\n");
  await fs.writeFile(path.join(root, "git"), "#!/bin/sh\nexit 77\n", { mode: 0o755 });

  const snapshot = await captureGitHeadSnapshot(root);
  assert.ok(snapshot, "the HEAD guard must resolve the installed Git despite the workspace shadow");
  assert.equal(snapshot.head, expectedHead);
  await assertGitHeadUnchanged(root, snapshot);
  assert.equal(await fs.realpath(await resolveRepositoryTopLevel(root)), await fs.realpath(root));
  const baseline = await captureCycleBaseline(root, "2026-09-08T00:00:00.000Z");
  assert.ok(baseline, "repository baseline capture must resolve the installed Git");
  assert.equal(baseline.commit, expectedHead);
  assert.equal(baseline.contentComplete, true);
  assert.deepEqual({ ...process.env }, environmentBefore, "executable lookup must not change the host environment");
});

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
