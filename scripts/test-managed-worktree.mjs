import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

import { acquireWorktreeLock } from "./lib/worktreeLock.mjs";

// This gate loads the built tree, so it holds the same worktree lock the build takes.
// The lock is held for the whole gate and released explicitly below. Nothing releases
// it on a signal: a run that dies without reaching the release leaves the lock for an
// operator, because its child processes may still be working in this worktree.
const worktreeLock = await acquireWorktreeLock({ label: "managed worktree checks" });
try {
  const root = process.cwd();
  const require = createRequire(import.meta.url);
  const { createWorktreeManager } = require(path.join(root, "dist", "orchestrator", "worktreeManager.js"));
  const { gitProcessEnvironment } = require(path.join(root, "dist", "process", "safeEnvironment.js"));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-managed-worktree-"));
  const repository = path.join(temporary, "repo");
  const storage = path.join(temporary, "storage");
  const gitAt = (cwd, ...args) => execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitProcessEnvironment(cwd),
    timeout: 120_000,
  }).trim();
  const git = (...args) => gitAt(repository, ...args);

  try {
    fs.mkdirSync(repository, { recursive: true });
    git("init", "--quiet");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.invalid");
    fs.writeFileSync(path.join(repository, "a.txt"), "one\n");
    git("add", "a.txt");
    git("commit", "--quiet", "-m", "baseline");
    const baseline = git("rev-parse", "HEAD");

    const manager = createWorktreeManager(storage);
    const run = await manager.prepareRun(repository, "managed-no-commit");
    assert.ok(run.integrationTree);
    const task = await manager.prepareTask(run, "task-1");
    assert.ok(task.baseTree);
    fs.writeFileSync(path.join(task.worktreePath, "a.txt"), "two\n");
    fs.writeFileSync(path.join(task.worktreePath, "b.txt"), "new\n");
    assert.deepEqual(await manager.changedFiles(task), ["a.txt", "b.txt"]);
    assert.equal(await manager.commitTask(task, "change files"), undefined);

    const before = await manager.integrationCommit(run);
    const integratedTree = await manager.integrateTask(run, task, "change files");
    assert.notEqual(integratedTree, before);
    assert.equal(fs.readFileSync(path.join(run.integrationWorktree, "a.txt"), "utf8"), "two\n");
    assert.equal(fs.readFileSync(path.join(run.integrationWorktree, "b.txt"), "utf8"), "new\n");

    await manager.resetIntegration(run, before);
    assert.equal(fs.readFileSync(path.join(run.integrationWorktree, "a.txt"), "utf8"), "one\n");
    assert.equal(fs.existsSync(path.join(run.integrationWorktree, "b.txt")), false);

    const restoredTree = await manager.integrateTask(run, task, "change files");
    run.integrationTree = restoredTree;
    await manager.restoreRun(run);
    assert.equal(fs.readFileSync(path.join(run.integrationWorktree, "a.txt"), "utf8"), "two\n");
    assert.equal(fs.readFileSync(path.join(run.integrationWorktree, "b.txt"), "utf8"), "new\n");

    const taskWithCommit = await manager.prepareTask(run, "task-2");
    fs.writeFileSync(path.join(taskWithCommit.worktreePath, "c.txt"), "accidental commit\n");
    gitAt(taskWithCommit.worktreePath, "config", "user.name", "Test");
    gitAt(taskWithCommit.worktreePath, "config", "user.email", "test@example.invalid");
    gitAt(taskWithCommit.worktreePath, "add", "c.txt");
    gitAt(taskWithCommit.worktreePath, "commit", "--quiet", "-m", "agent-created commit");
    const accidentalHead = gitAt(taskWithCommit.worktreePath, "rev-parse", "HEAD");
    assert.notEqual(accidentalHead, taskWithCommit.baseCommit);
    assert.equal(await manager.commitTask(taskWithCommit, "recover accidental commit"), undefined);
    const rewoundHead = gitAt(taskWithCommit.worktreePath, "rev-parse", "HEAD");
    assert.equal(rewoundHead, taskWithCommit.baseCommit);
    const recoveredTree = await manager.integrateTask(run, taskWithCommit, "recover accidental commit");
    run.integrationTree = recoveredTree;
    assert.equal(fs.readFileSync(path.join(run.integrationWorktree, "c.txt"), "utf8"), "accidental commit\n");

    const refs = git("for-each-ref", "--format=%(objecttype) %(objectname) %(refname)").split(/\r?\n/).filter(Boolean);
    const commitRefs = refs.filter((line) => line.startsWith("commit "));
    assert.equal(commitRefs.every((line) => line.split(" ")[1] === baseline), true);
    const stateRef = refs.find((line) => line.includes(" refs/bachata/state/"));
    assert.ok(stateRef?.startsWith(`tree ${run.integrationTree} `));

    const patch = await manager.runPatch(run);
    assert.match(patch, /a\/a\.txt/);
    assert.match(patch, /b\.txt/);
    assert.match(patch, /c\.txt/);

    fs.writeFileSync(path.join(repository, "dirty.txt"), "uncommitted\n");
    const dirtyRefusal = await manager.applyRun(run);
    assert.equal(dirtyRefusal.applied, false);
    assert.match(dirtyRefusal.reason, /Commit, stash, or discard the working tree first/);
    fs.rmSync(path.join(repository, "dirty.txt"));

    const defaultBranch = git("rev-parse", "--abbrev-ref", "HEAD");
    git("checkout", "--quiet", "-b", "bachata/integration/spoof");
    const ownedBranchRefusal = await manager.applyRun(run);
    assert.equal(ownedBranchRefusal.applied, false);
    assert.match(ownedBranchRefusal.reason, /extension-owned branch/);
    git("checkout", "--quiet", defaultBranch);
    git("branch", "--quiet", "-D", "bachata/integration/spoof");

    assert.deepEqual((await manager.runChangedPaths(run)).sort(), ["a.txt", "b.txt", "c.txt"]);
    const selectedPatch = await manager.runPatch(run, { paths: ["b.txt"] });
    assert.match(selectedPatch, /b\.txt/);
    assert.doesNotMatch(selectedPatch, /a\/a\.txt/);
    const unknownSelection = await manager.applyRun(run, { paths: ["not-in-this-run.txt"] });
    assert.equal(unknownSelection.applied, false);
    assert.match(unknownSelection.reason, /refuses to apply paths this run did not change/);
    assert.deepEqual(unknownSelection.conflicts, ["not-in-this-run.txt"]);
    const selectiveApply = await manager.applyRun(run, { paths: ["b.txt"] });
    assert.equal(selectiveApply.applied, true, selectiveApply.reason);
    assert.deepEqual(selectiveApply.stagedFiles, ["b.txt"]);
    assert.equal(fs.readFileSync(path.join(repository, "a.txt"), "utf8"), "one\n", "an unselected file must stay untouched");
    git("reset", "--quiet", "--hard", baseline);
    fs.rmSync(path.join(repository, "b.txt"), { force: true });

    const applied = await manager.applyRun(run);
    assert.equal(applied.applied, true, applied.reason);
    assert.deepEqual(applied.conflicts, []);
    assert.deepEqual(applied.stagedFiles, ["a.txt", "b.txt", "c.txt"]);
    assert.equal(fs.readFileSync(path.join(repository, "a.txt"), "utf8"), "two\n");
    assert.equal(git("rev-parse", "HEAD"), baseline, "apply must not create a commit");
    assert.equal(fs.existsSync(path.join(run.integrationWorktree, "b.txt")), true, "apply must keep the run worktree");

    git("reset", "--quiet", "--hard", baseline);
    fs.rmSync(path.join(repository, "b.txt"), { force: true });
    fs.rmSync(path.join(repository, "c.txt"), { force: true });
    fs.writeFileSync(path.join(repository, "a.txt"), "diverged\n");
    git("add", "a.txt");
    git("commit", "--quiet", "-m", "diverge");
    const conflicted = await manager.applyRun(run);
    assert.equal(conflicted.applied, false);
    assert.match(conflicted.reason, /no longer applies cleanly/);
    assert.deepEqual(conflicted.conflicts, ["a.txt"]);
    assert.equal(fs.readFileSync(path.join(repository, "a.txt"), "utf8"), "diverged\n");
    assert.equal(git("status", "--porcelain=v1"), "", "a refused apply must not touch the working tree");
    assert.equal(fs.existsSync(path.join(run.integrationWorktree, "b.txt")), true);
    assert.deepEqual(
      fs.readdirSync(path.dirname(run.integrationWorktree)).filter((entry) => entry.endsWith(".patch")),
      [],
      "a refused apply left a patch file behind",
    );

    git("reset", "--quiet", "--hard", baseline);

    const hunkRun = await manager.prepareRun(repository, "managed-hunks");
    const hunkTask = await manager.prepareTask(hunkRun, "hunk-task");
    fs.writeFileSync(
      path.join(hunkTask.worktreePath, "wide.txt"),
      Array.from({ length: 40 }, (_value, index) => `line ${String(index)}`).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(hunkTask.worktreePath, "logo.bin"), Buffer.from([0, 1, 2, 3, 0, 255]));
    await manager.commitTask(hunkTask, "seed");
    hunkRun.integrationTree = await manager.integrateTask(hunkRun, hunkTask, "seed");
    const seeded = await manager.applyRun(hunkRun);
    assert.equal(seeded.applied, true, seeded.reason);
    git("commit", "--quiet", "-m", "seed wide file");
    const seedCommit = git("rev-parse", "HEAD");

    const editRun = await manager.prepareRun(repository, "managed-hunk-edit");
    const editTask = await manager.prepareTask(editRun, "hunk-edit");
    const wide = path.join(editTask.worktreePath, "wide.txt");
    const lines = fs.readFileSync(wide, "utf8").split("\n");
    lines[2] = "TOP CHANGE";
    lines[35] = "BOTTOM CHANGE";
    fs.writeFileSync(wide, lines.join("\n"));
    fs.renameSync(path.join(editTask.worktreePath, "logo.bin"), path.join(editTask.worktreePath, "renamed.bin"));
    fs.writeFileSync(path.join(editTask.worktreePath, "renamed.bin"), Buffer.from([9, 9, 9, 0, 1]));
    await manager.commitTask(editTask, "edit");
    editRun.integrationTree = await manager.integrateTask(editRun, editTask, "edit");

    const files = await manager.runPatchFiles(editRun);
    const wideFile = files.find((file) => file.path === "wide.txt");
    assert.ok(wideFile, "the authoritative diff did not include wide.txt");
    assert.equal(wideFile.wholeFileOnly, false);
    assert.equal(wideFile.hunks.length >= 2, true, "expected two separate hunks");
    const binaryFile = files.find((file) => file.binary || file.renamed);
    assert.ok(binaryFile, "the authoritative diff did not describe the binary or renamed file");
    assert.equal(binaryFile.wholeFileOnly, true);

    const partial = await manager.runPatch(editRun, { hunks: [{ path: "wide.txt", index: 0 }] });
    assert.match(partial, /TOP CHANGE/);
    assert.doesNotMatch(partial, /BOTTOM CHANGE/);
    assert.doesNotMatch(partial, /renamed\.bin/);

    const invalidHunk = await manager.applyRun(editRun, { hunks: [{ path: "wide.txt", index: 99 }] });
    assert.equal(invalidHunk.applied, false);
    assert.match(invalidHunk.reason, /not part of this run's diff/);

    const unknownHunkPath = await manager.applyRun(editRun, { hunks: [{ path: "never.txt", index: 0 }] });
    assert.equal(unknownHunkPath.applied, false);
    assert.match(unknownHunkPath.reason, /refuses to apply paths this run did not change/);

    const splitBinary = await manager.applyRun(editRun, { hunks: [{ path: binaryFile.path, index: 0 }] });
    assert.equal(splitBinary.applied, false);
    assert.match(splitBinary.reason, /part of a binary or renamed file/);

    const hunkApply = await manager.applyRun(editRun, { hunks: [{ path: "wide.txt", index: 0 }] });
    assert.equal(hunkApply.applied, true, hunkApply.reason);
    assert.deepEqual(hunkApply.stagedFiles, ["wide.txt"]);
    const appliedWide = fs.readFileSync(path.join(repository, "wide.txt"), "utf8");
    assert.match(appliedWide, /TOP CHANGE/);
    assert.doesNotMatch(appliedWide, /BOTTOM CHANGE/);
    assert.equal(fs.existsSync(path.join(repository, "renamed.bin")), false, "an unselected file must stay untouched");
    assert.equal(git("rev-parse", "HEAD"), seedCommit, "a hunk apply must not create a commit");
    git("reset", "--quiet", "--hard", seedCommit);

    fs.writeFileSync(path.join(repository, "wide.txt"), "rewritten\n");
    git("add", "wide.txt");
    git("commit", "--quiet", "-m", "rewrite wide");
    const conflictedHunk = await manager.applyRun(editRun, { hunks: [{ path: "wide.txt", index: 0 }] });
    assert.equal(conflictedHunk.applied, false);
    assert.match(conflictedHunk.reason, /The retained work no longer applies cleanly/);
    assert.equal(git("status", "--porcelain=v1"), "", "a refused hunk apply must not touch the working tree");
    assert.equal(fs.readFileSync(path.join(repository, "wide.txt"), "utf8"), "rewritten\n");

    const renameRun = await manager.prepareRun(repository, "managed-rename");
    const renameSeed = await manager.prepareTask(renameRun, "rename-seed");
    fs.writeFileSync(path.join(renameSeed.worktreePath, "old name.txt"), "one\ntwo\n");
    await manager.commitTask(renameSeed, "seed rename");
    renameRun.integrationTree = await manager.integrateTask(renameRun, renameSeed, "seed rename");
    const renameSeeded = await manager.applyRun(renameRun);
    assert.equal(renameSeeded.applied, true, renameSeeded.reason);
    git("commit", "--quiet", "-m", "seed spaced file");
    const renameBase = git("rev-parse", "HEAD");

    const renameEdit = await manager.prepareRun(repository, "managed-rename-edit");
    const renameTask = await manager.prepareTask(renameEdit, "rename-edit");
    fs.renameSync(
      path.join(renameTask.worktreePath, "old name.txt"),
      path.join(renameTask.worktreePath, "new name.txt"),
    );
    await manager.commitTask(renameTask, "rename");
    renameEdit.integrationTree = await manager.integrateTask(renameEdit, renameTask, "rename");

    const renameFiles = await manager.runPatchFiles(renameEdit);
    const renamed = renameFiles.find((file) => file.renamed) ?? renameFiles[0];
    assert.equal(renamed.path, "new name.txt", `pure rename resolved to ${renamed.path}`);
    assert.equal(renamed.oldPath, "old name.txt");
    assert.equal(renamed.wholeFileOnly, true);

    const renameSplit = await manager.applyRun(renameEdit, { hunks: [{ path: "new name.txt", index: 0 }] });
    assert.equal(renameSplit.applied, false);
    assert.match(renameSplit.reason, /part of a binary or renamed file/);

    const renameApply = await manager.applyRun(renameEdit, { paths: ["new name.txt"] });
    assert.equal(renameApply.applied, true, renameApply.reason);
    assert.equal(fs.existsSync(path.join(repository, "new name.txt")), true);
    assert.equal(fs.existsSync(path.join(repository, "old name.txt")), false);
    assert.equal(git("rev-parse", "HEAD"), renameBase, "a rename apply must not create a commit");
    git("reset", "--quiet", "--hard", renameBase);
    await manager.abandonRun(renameEdit);
    await manager.abandonRun(renameRun);

    const bigRun = await manager.prepareRun(repository, "managed-big-diff");
    const bigTask = await manager.prepareTask(bigRun, "big-task");
    const bigLines = Array.from({ length: 60_000 }, (_value, index) => `line ${String(index)} ${"x".repeat(60)}`);
    fs.writeFileSync(path.join(bigTask.worktreePath, "big.txt"), `${bigLines.join("\n")}\n`);
    await manager.commitTask(bigTask, "big file");
    bigRun.integrationTree = await manager.integrateTask(bigRun, bigTask, "big file");

    const bigPatch = await manager.runPatch(bigRun);
    assert.ok(
      Buffer.byteLength(bigPatch, "utf8") > 2 * 1024 * 1024,
      `the run patch was ${String(Buffer.byteLength(bigPatch, "utf8"))} bytes, so the process buffer truncated it`,
    );
    assert.doesNotMatch(bigPatch, /\[output truncated\]/, "the run patch carried a truncation marker");
    assert.equal(bigPatch.trimEnd().endsWith(`+${bigLines.at(-1)}`), true, "the run patch lost its final line");

    const bigFiles = await manager.runPatchFiles(bigRun);
    const bigFile = bigFiles.find((file) => file.path === "big.txt");
    assert.ok(bigFile, "the inventory lost the large file");
    assert.equal(bigFile.hunks.length >= 1, true);

    const bigApply = await manager.applyRun(bigRun);
    assert.equal(bigApply.applied, true, bigApply.reason);
    assert.deepEqual(bigApply.stagedFiles, ["big.txt"]);
    assert.equal(
      fs.readFileSync(path.join(repository, "big.txt"), "utf8").trimEnd().split("\n").length,
      bigLines.length,
      "a truncated patch applied an incomplete file",
    );
    git("reset", "--quiet", "--hard", "HEAD");
    fs.rmSync(path.join(repository, "big.txt"), { force: true });
    await manager.abandonRun(bigRun);

    const modeRun = await manager.prepareRun(repository, "managed-mode");
    const modeSeed = await manager.prepareTask(modeRun, "mode-seed");
    fs.writeFileSync(path.join(modeSeed.worktreePath, "s.sh"), "one\ntwo\nthree\n");
    await manager.commitTask(modeSeed, "seed mode file");
    modeRun.integrationTree = await manager.integrateTask(modeRun, modeSeed, "seed mode file");
    const modeSeeded = await manager.applyRun(modeRun);
    assert.equal(modeSeeded.applied, true, modeSeeded.reason);
    git("commit", "--quiet", "-m", "seed mode file");
    const modeBase = git("rev-parse", "HEAD");
    assert.match(git("ls-files", "--stage", "s.sh"), /^100644 /u);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(path.join(repository, "s.sh")).mode & 0o111, 0);
    }

    const modeEdit = await manager.prepareRun(repository, "managed-mode-edit");
    const modeTask = await manager.prepareTask(modeEdit, "mode-edit");
    const modeTarget = path.join(modeTask.worktreePath, "s.sh");
    fs.writeFileSync(modeTarget, "one\nCHANGED\nthree\n");
    if (process.platform === "win32") {
      gitAt(modeTask.worktreePath, "update-index", "--chmod=+x", "s.sh");
    } else {
      fs.chmodSync(modeTarget, 0o755);
    }
    await manager.commitTask(modeTask, "mode and content");
    modeEdit.integrationTree = await manager.integrateTask(modeEdit, modeTask, "mode and content");

    const modeFiles = await manager.runPatchFiles(modeEdit);
    const modeFile = modeFiles.find((file) => file.path === "s.sh");
    assert.ok(modeFile, "the inventory lost the mode-changing file");
    assert.equal(modeFile.modeChanged, true);
    assert.equal(modeFile.wholeFileOnly, true, "a mode-changing file stayed hunk-selectable");

    const modeSplit = await manager.applyRun(modeEdit, { hunks: [{ path: "s.sh", index: 0 }] });
    assert.equal(modeSplit.applied, false);
    assert.match(modeSplit.reason, /permissions this run also changed/);
    assert.match(git("ls-files", "--stage", "s.sh"), /^100644 /u);
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.join(repository, "s.sh")).mode & 0o111,
        0,
        "a refused partial apply changed file permissions",
      );
    }

    const modeApply = await manager.applyRun(modeEdit, { paths: ["s.sh"] });
    assert.equal(modeApply.applied, true, modeApply.reason);
    assert.match(fs.readFileSync(path.join(repository, "s.sh"), "utf8"), /CHANGED/);
    assert.match(git("ls-files", "--stage", "s.sh"), /^100755 /u);
    if (process.platform !== "win32") {
      assert.notEqual(fs.statSync(path.join(repository, "s.sh")).mode & 0o111, 0);
    }
    git("reset", "--quiet", "--hard", modeBase);
    await manager.abandonRun(modeEdit);
    await manager.abandonRun(modeRun);

    git("checkout", "--quiet", "--orphan", "unrelated");
    git("rm", "-rq", "--cached", ".");
    fs.readdirSync(repository)
      .filter((entry) => entry !== ".git")
      .forEach((entry) => fs.rmSync(path.join(repository, entry), { recursive: true, force: true }));
    fs.writeFileSync(path.join(repository, "only.txt"), "unrelated\n");
    git("add", "only.txt");
    git("commit", "--quiet", "-m", "unrelated root");
    const staleBase = await manager.applyRun(editRun);
    assert.equal(staleBase.applied, false);
    assert.match(staleBase.reason, /no longer contains the commit this run started from/);

    await manager.abandonRun(editRun);
    await manager.abandonRun(hunkRun);
    git("checkout", "--quiet", "-f", defaultBranch);
    git("reset", "--quiet", "--hard", baseline);

    await manager.abandonRun(run);
    const remainingRefs = git("for-each-ref", "--format=%(refname)").split(/\r?\n/).filter(Boolean);
    assert.equal(remainingRefs.some((ref) => ref.startsWith("refs/bachata/")), false);
    console.log("Managed no-commit worktree checks passed");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
} finally {
  await worktreeLock.release();
}
