const assert = require("node:assert/strict");
const test = require("node:test");

const { gitReadinessFrom } = require("../dist/readiness/gitReadiness.js");

// EX-3. Four probe outcomes, four different things to tell the reader. These lived beside the two
// `checkCommand` calls in the runtime, so the difference between "Git is not there", "Git is too
// old" and "this root is not a repository" could only be reached by running Git.

test("a version probe that did not run reports its own failure and nothing about a repository", () => {
  assert.deepEqual(
    gitReadinessFrom({ outcome: "versionFailed", error: new Error("spawn git ENOENT") }),
    { available: false, detail: "spawn git ENOENT" },
  );
  // A rejection that is not an Error is still reported as text rather than as "[object Object]".
  assert.deepEqual(
    gitReadinessFrom({ outcome: "versionFailed", error: "killed" }),
    { available: false, detail: "killed" },
  );
});

test("a Git this product will not drive is a requirement, not an error", () => {
  assert.deepEqual(
    gitReadinessFrom({ outcome: "unsupported", requirementText: "Git 2.20 or newer is required" }),
    { available: false, detail: "Git 2.20 or newer is required" },
  );
});

test("a root that is not a repository says so beside the failure Git gave", () => {
  const readiness = gitReadinessFrom({
    outcome: "statusFailed",
    error: new Error("fatal: not a git repository"),
  });
  assert.deepEqual(readiness, {
    available: false,
    detail: "fatal: not a git repository",
    statusDetail: "The selected root is not a usable Git repository",
  });
  assert.equal("dirtyPaths" in readiness, false, "a status nobody read reported a clean tree");
  assert.deepEqual(
    gitReadinessFrom({ outcome: "statusFailed", error: 17 }),
    {
      available: false,
      detail: "17",
      statusDetail: "The selected root is not a usable Git repository",
    },
  );
});

test("a clean worktree is clean, and its empty dirty list is present rather than absent", () => {
  const readiness = gitReadinessFrom({ outcome: "status", version: "git version 2.44.0", status: "" });
  assert.deepEqual(readiness, {
    available: true,
    detail: "git version 2.44.0",
    clean: true,
    statusDetail: "Workspace is clean",
    dirtyPaths: [],
  });
});

test("a dirty worktree names every path once, renames included", () => {
  const readiness = gitReadinessFrom({
    outcome: "status",
    version: "git version 2.44.0",
    status: " M src/a.ts\0?? src/a.ts\0R  src/new.ts\0src/old.ts\0",
  });
  assert.equal(readiness.available, true);
  assert.equal(readiness.clean, false);
  assert.equal(readiness.statusDetail, "Workspace has uncommitted changes");
  assert.deepEqual(readiness.dirtyPaths, ["src/a.ts", "src/new.ts", "src/old.ts"]);
});
