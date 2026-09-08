const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const { captureManagedRepositoryBaseline } = require("../dist/browser/managedTurn.js");

test("managed repository baseline supports Git before the first commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-unborn-git-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    fs.writeFileSync(path.join(root, "tracked.ts"), "export const tracked = true;\n");
    fs.writeFileSync(path.join(root, "scratch.ts"), "export const scratch = true;\n");
    execFileSync("git", ["add", "tracked.ts"], { cwd: root });

    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    assert.equal(baseline.isGitRepository, true);
    assert.equal(baseline.head, "");
    assert.deepEqual(baseline.entries.map((entry) => entry.path), ["scratch.ts", "tracked.ts"]);
    assert.equal(baseline.entries.every((entry) => entry.fingerprint.startsWith("file:")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("managed repository baseline remains explicit outside Git", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-non-git-"));
  try {
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    assert.deepEqual(baseline, { isGitRepository: false, head: "", entries: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// EX-G6-10. `git diff` names paths from the repository root and `git ls-files --others` names
// them from the directory it runs in. In a workspace folder nested inside its repository the two
// halves of the inventory therefore speak different languages, and everything downstream resolves
// them against the workspace folder: a tracked edit in `repo/packages/app` arrived as
// `packages/app/src/a.ts`, resolved to `packages/app/packages/app/src/a.ts`, and fingerprinted as
// missing. The change was invisible and the path the write policy judged did not exist.
test("a workspace nested inside its repository reports its own paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-nested-workspace-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git("init", "--quiet");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    fs.mkdirSync(path.join(root, "packages", "app", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "app", "src", "a.ts"), "export const a = 1;\n");
    fs.writeFileSync(path.join(root, "outside.ts"), "export const outside = true;\n");
    git("add", "--all");
    git("commit", "--quiet", "-m", "initial");

    const workspace = path.join(root, "packages", "app");
    const signal = new AbortController().signal;
    assert.deepEqual(
      (await captureManagedRepositoryBaseline(workspace, signal)).entries,
      [],
      "a clean nested workspace reported changes",
    );

    fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 2;\n");
    fs.writeFileSync(path.join(workspace, "src", "b.ts"), "export const b = 3;\n");
    const changed = await captureManagedRepositoryBaseline(workspace, signal);
    assert.deepEqual(
      changed.entries.map((entry) => entry.path),
      ["src/a.ts", "src/b.ts"],
      "the tracked edit was reported at a path relative to the repository, not the workspace",
    );
    assert.equal(
      changed.entries.every((entry) => entry.fingerprint.startsWith("file:")),
      true,
      "a change inside the workspace fingerprinted as missing, so it could not be seen at all",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
