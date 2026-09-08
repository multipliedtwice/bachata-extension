const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");

const { createWorktreeManager } = require("../dist/orchestrator/worktreeManager.js");
const { createRepository, git, gitWorktreeSkip } = require("./support/orchestration.cjs");
const { removeScratch, scratchRoot } = require("./support/scratch.cjs");

// P3. The retention lifecycle, against a real repository and the real worktree manager.
//
// A managed run's output is kept in its own worktree until a person applies or discards it. What
// had never been asserted end to end: that the selected workspace is untouched until Apply, that
// Apply stages the work without committing it, that a second Apply cannot consume the same work
// twice, that a refused Apply leaves the retained output recoverable, and that discarding is the
// only thing that removes it.

const scratch = async () => await scratchRoot("bachata-retention-");

/**
 * A repository, a prepared run, and one change written inside the run's own worktree. Nothing
 * here touches the repository's working tree: that is the point of the retained worktree.
 */
const preparedRun = async (root, options = {}) => {
  const repository = await createRepository(root, undefined, {
    "src/feature.ts": "export const feature = 1;\n",
    "src/untouched.ts": "export const untouched = 1;\n",
  });
  const storageRoot = path.join(root, "storage");
  const manager = createWorktreeManager(storageRoot, { lockTimeoutMs: () => 20_000 });
  const run = await manager.prepareRun(repository, options.runId ?? "retained-run");
  const target = path.join(run.integrationWorktree, "src/feature.ts");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, options.contents ?? "export const feature = 2;\n", "utf8");
  // The run's output is recorded as a tree rather than a commit: `commitMode` is "never", so
  // nothing the run produces is ever committed anywhere. This is the step the controller takes
  // when a managed turn finishes, and without it the run has produced nothing to retain.
  run.integrationTree = await manager.integrationCommit(run);
  return { repository, storageRoot, manager, run };
};

test("a run's output is retained in its own worktree and the workspace is untouched", gitWorktreeSkip, async () => {
  const root = await scratch();
  try {
    const { repository, manager, run } = await preparedRun(root);
    assert.equal(existsSync(run.integrationWorktree), true, "the run worktree was not retained");
    // The change exists only in the retained worktree.
    assert.deepEqual(await manager.runChangedPaths(run), ["src/feature.ts"]);
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 1;\n",
      "the run changed the selected workspace before Apply",
    );
    assert.equal(git(repository, "status", "--porcelain"), "", "the workspace was left dirty");
    // And the retained patch describes it, so a person can read what is waiting.
    assert.match(await manager.runPatch(run), /src\/feature\.ts/u);
  } finally {
    await removeScratch(root);
  }
});

test("a retained run survives being read again, which is what a reload does", gitWorktreeSkip, async () => {
  const root = await scratch();
  try {
    const { storageRoot, manager, run } = await preparedRun(root);
    // A second manager over the same storage root is what a reloaded extension has: the run is
    // addressed by its recorded identity, not by anything held in memory.
    const reloaded = createWorktreeManager(storageRoot, { lockTimeoutMs: () => 20_000 });
    assert.deepEqual(await reloaded.runChangedPaths(run), ["src/feature.ts"]);
    assert.equal(existsSync(run.integrationWorktree), true);
    assert.deepEqual(await manager.runChangedPaths(run), ["src/feature.ts"]);
  } finally {
    await removeScratch(root);
  }
});

test("Apply stages the retained work on the checked-out branch and makes no commit", gitWorktreeSkip, async () => {
  const root = await scratch();
  try {
    const { repository, manager, run } = await preparedRun(root);
    const before = git(repository, "rev-parse", "HEAD");
    const result = await manager.applyRun(run);
    assert.equal(result.applied, true, result.reason);
    assert.deepEqual(result.stagedFiles, ["src/feature.ts"]);
    assert.equal(result.conflicts.length, 0);
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 2;\n",
    );
    // Staged, not committed: the commit is the person's to make.
    assert.equal(git(repository, "rev-parse", "HEAD"), before, "Apply created a commit");
    assert.match(git(repository, "status", "--porcelain"), /^M {2}src\/feature\.ts$/mu);
    // A file this run did not touch is not touched by applying it.
    assert.equal(
      await readFile(path.join(repository, "src/untouched.ts"), "utf8"),
      "export const untouched = 1;\n",
    );
  } finally {
    await removeScratch(root);
  }
});

test("a second Apply of the same retained run is refused rather than applied twice", gitWorktreeSkip, async () => {
  const root = await scratch();
  try {
    const { repository, manager, run } = await preparedRun(root);
    assert.equal((await manager.applyRun(run)).applied, true);
    const second = await manager.applyRun(run);
    assert.equal(second.applied, false, "the same retained work was applied twice");
    // The refusal names the working tree it will not write over, rather than failing silently.
    assert.match(second.reason, /Commit, stash, or discard the working tree first/u);
    assert.match(second.reason, /src\/feature\.ts/u);
    // Nothing was undone by the refusal: the first Apply's work is still staged.
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 2;\n",
    );
    // And the retained worktree is still there to apply again or discard.
    assert.equal(existsSync(run.integrationWorktree), true);
  } finally {
    await removeScratch(root);
  }
});

test("an Apply that no longer fits the branch is refused and keeps the retained output", gitWorktreeSkip, async () => {
  const root = await scratch();
  try {
    const { repository, manager, run } = await preparedRun(root);
    // The branch moves on with a conflicting change of its own, and it is committed, so the
    // working tree is clean and the refusal is about the patch rather than about dirt.
    await writeFile(path.join(repository, "src/feature.ts"), "export const feature = 99;\n", "utf8");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "diverge");

    const result = await manager.applyRun(run);
    assert.equal(result.applied, false, "a conflicting patch was applied anyway");
    assert.match(result.reason, /no longer applies cleanly|no longer contains the commit/u);
    // The working tree was not touched, and the retained work is still recoverable.
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 99;\n",
    );
    assert.equal(git(repository, "status", "--porcelain"), "");
    assert.equal(existsSync(run.integrationWorktree), true, "a refused Apply discarded the run");
    assert.deepEqual(await manager.runChangedPaths(run), ["src/feature.ts"]);
    assert.match(await manager.runPatch(run), /export const feature = 2;/u);
  } finally {
    await removeScratch(root);
  }
});

test("Apply is refused on a branch Bachata owns, and on a detached head", gitWorktreeSkip, async () => {
  const root = await scratch();
  try {
    const { repository, manager, run } = await preparedRun(root);
    git(repository, "checkout", "-b", "bachata/integration/someone-elses");
    const owned = await manager.applyRun(run);
    assert.equal(owned.applied, false);
    assert.match(owned.reason, /extension-owned branch/u);

    git(repository, "checkout", "--detach");
    const detached = await manager.applyRun(run);
    assert.equal(detached.applied, false);
    assert.match(detached.reason, /HEAD is detached/u);
    assert.equal(existsSync(run.integrationWorktree), true);
  } finally {
    await removeScratch(root);
  }
});

test("Apply refuses paths the run did not change rather than writing them", gitWorktreeSkip, async () => {
  const root = await scratch();
  try {
    const { repository, manager, run } = await preparedRun(root);
    const result = await manager.applyRun(run, { paths: ["src/untouched.ts"] });
    assert.equal(result.applied, false);
    assert.match(result.reason, /refuses to apply paths this run did not change/u);
    assert.deepEqual(result.conflicts, ["src/untouched.ts"]);
    assert.equal(git(repository, "status", "--porcelain"), "");
  } finally {
    await removeScratch(root);
  }
});

test("a run that changed nothing has nothing to apply, and says so", gitWorktreeSkip, async () => {
  const root = await scratch();
  try {
    const { manager, run } = await preparedRun(root, {
      contents: "export const feature = 1;\n",
    });
    const result = await manager.applyRun(run);
    assert.equal(result.applied, false);
    assert.match(result.reason, /changed nothing, so there is nothing to apply/u);
  } finally {
    await removeScratch(root);
  }
});

test("discarding a retained run is what removes it, and only that", gitWorktreeSkip, async () => {
  const root = await scratch();
  try {
    const { repository, manager, run } = await preparedRun(root);
    // Reading it, applying it and being refused all leave it in place; discarding does not.
    await manager.runChangedPaths(run);
    await manager.applyRun(run, { paths: ["src/untouched.ts"] });
    assert.equal(existsSync(run.integrationWorktree), true);

    await manager.abandonRun(run);
    assert.equal(existsSync(run.integrationWorktree), false, "discard left the worktree behind");
    // The repository itself is untouched by the discard.
    assert.equal(git(repository, "status", "--porcelain"), "");
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 1;\n",
    );
  } finally {
    await removeScratch(root);
  }
});

// --- verification bound to Apply ------------------------------------------------------------
//
// P3. Everything above drives the worktree manager: what a retained run holds and what Apply
// does with it. What follows drives the controller, because Apply's precondition is the run's own
// declared verification, and only the controller knows what a run declared.

const { writeFile: writeWorkspaceFile } = require("node:fs/promises");

const {
  completedPipeline,
  createController,
  createFakeConversationManager,
} = require("./support/orchestration.cjs");

/**
 * A completed retained run that declares controller-owned checks, over a real repository.
 *
 * The task check and the final check are the two controller-owned commands this product ships,
 * so what the run declares is what a real managed pipeline declares.
 */
const retainedRunWithChecks = async (root, { finalVerify = "bachata:project-checks" } = {}) => {
  const repository = await createRepository(root, [
    "- [ ] [T1] Retained run with declared checks",
    "  - Paths: src",
    "  - Verify: bachata:workspace-integrity",
    `  - Verify Final: ${finalVerify}`,
    "",
  ].join("\n"), { "src/feature.ts": "export const feature = 1;\n" });
  const manager = createFakeConversationManager(async ({ options }) => {
    await writeWorkspaceFile(
      path.join(options.workingDirectory, "src", "feature.ts"),
      "export const feature = 2;\n",
      "utf8",
    );
    return completedPipeline();
  });
  const controller = createController(root, repository, manager, { todoRetries: 0 });
  const run = await controller.start();
  assert.equal(run.status, "completed", run.error ?? "");
  return { repository, controller, run };
};

test("a completed run cannot be applied until every declared check has passed on its candidate", gitWorktreeSkip, async () => {
  const root = await scratch();
  const { repository, controller, run } = await retainedRunWithChecks(root);
  try {
    // The run's final checks ran against the candidate; its task check ran against a task
    // worktree that no longer exists. Complete evidence for the candidate is what Apply needs,
    // and a check that has not been run on it is missing evidence rather than an absence of bad
    // news.
    await assert.rejects(
      controller.applyRetained(run.runId),
      /Required verification: bachata:workspace-integrity: not run/u,
    );
    // A blocked Apply changes nothing: the retained output is still there, and the workspace is
    // still exactly as it was.
    assert.equal(existsSync(run.integrationWorktree), true);
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 1;\n",
    );
    assert.equal(git(repository, "status", "--porcelain"), "");

    const rechecked = await controller.rerunRetainedChecks(run.runId);
    assert.deepEqual(
      rechecked.map((check) => check.command).sort(),
      ["bachata:project-checks", "bachata:workspace-integrity"],
      "a rerun must cover every command the run declared, not the final checks alone",
    );
    rechecked.forEach((check) => assert.equal(check.status, "passed", check.stderr));

    const applied = await controller.applyRetained(run.runId);
    assert.equal(applied.applied, true, applied.reason ?? "");
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 2;\n",
    );
    // Still no commit: Apply stages, and the controller never commits for the user.
    assert.equal(git(repository, "rev-list", "--count", "HEAD"), "1");
    // And the same retained work cannot be applied a second time.
    const second = await controller.applyRetained(run.runId);
    assert.equal(second.applied, false);
  } finally {
    await controller.dispose();
    await removeScratch(root);
  }
});

test("verified evidence survives a reload and still authorizes Apply", gitWorktreeSkip, async () => {
  const root = await scratch();
  const { repository, controller, run } = await retainedRunWithChecks(root);
  let second;
  try {
    (await controller.rerunRetainedChecks(run.runId)).forEach((check) =>
      assert.equal(check.status, "passed", check.stderr),
    );
    await controller.dispose();
    const manager = createFakeConversationManager(async () => completedPipeline());
    second = createController(root, repository, manager, { todoRetries: 0 });
    // A second controller over the same storage finds the run, and the evidence it earned, by
    // loading them: the snapshot is published after initialization, so what proves the reload is
    // that Apply is authorized rather than that a list is already populated.
    const applied = await second.applyRetained(run.runId);
    assert.equal(applied.applied, true, applied.reason ?? "");
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 2;\n",
    );
  } finally {
    await second?.dispose();
    await removeScratch(root);
  }
});

test("applying part of a retained run needs verification of that part", gitWorktreeSkip, async () => {
  const root = await scratch();
  const { repository, controller, run } = await retainedRunWithChecks(root);
  const selection = { paths: ["src/feature.ts"] };
  try {
    // Verifying the whole candidate does not verify a selection of it: the patch a selective
    // Apply carries is a different patch.
    (await controller.rerunRetainedChecks(run.runId)).forEach((check) =>
      assert.equal(check.status, "passed", check.stderr),
    );
    await assert.rejects(
      controller.applyRetained(run.runId, selection),
      /no complete passing verification for the retained run as it stands/u,
    );
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 1;\n",
    );
    const verified = await controller.verifyRetainedSelection(run.runId, selection);
    verified.forEach((check) => assert.equal(check.status, "passed", check.stderr));
    const applied = await controller.applyRetained(run.runId, selection);
    assert.equal(applied.applied, true, applied.reason ?? "");
    assert.equal(
      await readFile(path.join(repository, "src/feature.ts"), "utf8"),
      "export const feature = 2;\n",
    );
  } finally {
    await controller.dispose();
    await removeScratch(root);
  }
});

test("an unverified retained run is still discardable, and discarding is what removes it", gitWorktreeSkip, async () => {
  const root = await scratch();
  const { repository, controller, run } = await retainedRunWithChecks(root);
  try {
    await assert.rejects(
      controller.applyRetained(run.runId),
      /no complete passing verification for its current candidate/u,
    );
    assert.equal(git(repository, "status", "--porcelain"), "");
    await controller.cleanupRetained(run.runId);
    assert.equal(existsSync(run.integrationWorktree), false);
    assert.deepEqual(controller.getSnapshot().retainedRuns, []);
  } finally {
    await controller.dispose();
    await removeScratch(root);
  }
});
