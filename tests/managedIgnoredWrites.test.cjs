const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { execFileSync } = require("node:child_process");

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

const {
  captureManagedRepositoryBaseline,
  executeManagedBrowserEnvelope,
  prepareManagedBrowserTurn,
  runManagedControllerVerification,
  MANAGED_WORKSPACE_INTEGRITY_COMMAND,
} = require("../dist/browser/managedTurn.js");

// EX-G6-09. A controller write, delete or patch to a Git-ignored path is refused before it reaches
// disk, because Git names no ignored path in diff or ls-files and it could never enter the candidate
// patch or verification. The one case a pre-disk guard cannot cover — the task hides a change it
// already made by editing an ignore rule — is surfaced as a policy violation using only paths the
// task already changed, never a filesystem scan.

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });

// Git's own inventory, so tests assert invisibility from Git rather than from the controller's
// changedFiles: the untracked set Git would surface, and whether Git ignores a specific path.
const gitUntracked = (cwd) =>
  git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
const gitIgnored = (cwd, relative) => {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", relative], { cwd });
    return true;
  } catch {
    return false;
  }
};

const setupRepository = (root, gitignore) => {
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.email", "bachata@example.invalid"]);
  git(root, ["config", "user.name", "Bachata Test"]);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), gitignore);
  fs.writeFileSync(path.join(root, "src", "tracked.ts"), "export const tracked = 1;\n");
  git(root, ["add", ".gitignore", "src/tracked.ts"]);
  git(root, ["commit", "--quiet", "-m", "baseline"]);
};

const createTurn = (root) => ({
  index: {
    root,
    workspaceRoot: root,
    allowedPaths: ["src"],
    revision: 0,
    files: new Map(),
    inventory: new Set(),
    skippedTooLargePaths: new Set(),
    skippedUnreadablePaths: new Set(),
    skippedBudgetPaths: new Set(),
    skippedFileLimitPaths: new Set(),
    coverage: {
      inventoryCount: 0,
      maxInventoryFiles: 100000,
      inventoryTruncated: false,
      inventoryTimedOut: false,
      ignoreFileCount: 0,
      indexedCount: 0,
      maxFiles: 5000,
      maxFileBytes: 1048576,
      maxTotalBytes: 134217728,
      indexedBytes: 0,
      indexingTimedOut: false,
      truncated: false,
      skippedTooLarge: 0,
      skippedUnreadable: 0,
      skippedBudget: 0,
      skippedFileLimit: 0,
    },
    compilerOptions: {},
    ignoreScopes: [],
    inventoryTimeoutMs: 30000,
    indexingTimeoutMs: 30000,
  },
  snippets: new Map(),
  verification: [],
  workspaceRevision: 0,
  changedFiles: [],
  preexistingChangedFiles: [],
  repositoryPolicyViolations: [],
  diff: "",
  diffOmittedFileCount: 0,
  initialContextOmitted: [],
  initialContextOmittedTotal: 0,
  prompt: "",
});

const options = (root, baseline) => ({
  taskId: "ignored-writes",
  originalTask: "edit the workspace",
  role: "worker",
  workingDirectory: root,
  readPaths: ["src"],
  allowedPaths: ["src"],
  protectedPaths: [],
  commitMode: "never",
  readOnly: false,
  verificationChecks: [{ id: "integrity", command: MANAGED_WORKSPACE_INTEGRITY_COMMAND }],
  maxRevisionCycles: 1,
  deadlineAt: Date.now() + 60000,
  continuationMaxBytes: 65536,
  handoffTotalBudgetBytes: 262144,
  dependencyDepth: 2,
  promotionMaxBytes: 786432,
  repositoryBaseline: baseline,
  signal: new AbortController().signal,
  executor: { timeoutMs: 5000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
  contextIndex: { maxInventoryFiles: 100000, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
  contextSearch: { maxFiles: 2000, maxBytes: 67108864, maxFileBytes: 8388608, timeoutMs: 15000 },
});

const write = (path_, content) => ({ kind: "workspace.write", path: path_, content, expectedFiles: [] });
const applyPatch = (patch) => ({ kind: "workspace.applyPatch", patch, expectedFiles: [] });
const verify = () => ({ kind: "verification.run", checkIds: ["integrity"] });
const envelope = (actions, summary) => ({
  protocol: "bachata-browser-turn-v1",
  status: "applyPatch",
  actions,
  summary,
  objections: [],
  unresolved: [],
});

test("a controller write to a git-ignored path is refused before it reaches disk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-ignored-write-"));
  try {
    setupRepository(root, "src/generated.ts\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);

    const execution = await executeManagedBrowserEnvelope(
      envelope(
        [write("src/generated.ts", "export const generated = 1;\n"), verify()],
        "write an ignored file then verify",
      ),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    assert.equal(execution.recognized, true);
    // pass-after: the write was refused before it changed disk, so no ignored bytes were laid down.
    const rejected = execution.actionResults.find((entry) => entry.status === "rejected");
    assert.ok(rejected, "the ignored write was not rejected");
    assert.match(rejected.summary, /Git ignores/u);
    assert.equal(fs.existsSync(path.join(root, "src", "generated.ts")), false, "the ignored write reached disk");
    assert.equal(turn.changedFiles.includes("src/generated.ts"), false);
    // Nothing invisible landed, so the workspace stays clean and integrity passes.
    const integrity = turn.verification.find((record) => record.id === "integrity");
    assert.ok(integrity, "workspace integrity did not run");
    assert.equal(integrity.status, "passed");

    // Persisted old-state compatibility: the fingerprint baseline never enumerated the ignored
    // file, and the refused write did not change any baseline entry a persisted record was bound to.
    const after = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    assert.deepEqual(after.entries, baseline.entries);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a controller delete of a git-ignored path is refused before it changes disk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-ignored-delete-"));
  try {
    setupRepository(root, "src/generated.ts\n");
    // A build or the OS left an ignored file behind; the controller did not create it.
    fs.writeFileSync(path.join(root, "src", "generated.ts"), "export const generated = 1;\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);

    // Supply the current full-file hash so the stale-write guard is satisfied: without it the delete
    // would be rejected for a missing expected hash and this test would pass for the wrong reason.
    // With it, only the ignore guard stops the delete, which is what this asserts.
    const removeGenerated = {
      kind: "workspace.delete",
      path: "src/generated.ts",
      expectedFiles: [{ path: "src/generated.ts", sha256: sha256("export const generated = 1;\n") }],
    };
    const execution = await executeManagedBrowserEnvelope(
      envelope([removeGenerated, verify()], "delete an ignored file then verify"),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    const rejected = execution.actionResults.find((entry) => entry.status === "rejected");
    assert.ok(rejected, "the ignored delete was not rejected");
    assert.match(rejected.summary, /Git ignores/u);
    // The delete never ran, so the untracked ignored file the controller did not create is intact.
    assert.equal(fs.existsSync(path.join(root, "src", "generated.ts")), true, "an ignored file was deleted through an invisible channel");
    const integrity = turn.verification.find((record) => record.id === "integrity");
    assert.equal(integrity.status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a controller patch that targets a git-ignored path is refused before it reaches disk", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-ignored-patch-"));
  try {
    setupRepository(root, "src/generated.ts\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);

    const patch = [
      "diff --git a/src/generated.ts b/src/generated.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/generated.ts",
      "@@ -0,0 +1 @@",
      "+export const generated = 1;",
      "",
    ].join("\n");

    const execution = await executeManagedBrowserEnvelope(
      envelope([applyPatch(patch), verify()], "patch an ignored file then verify"),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    const rejected = execution.actionResults.find((entry) => entry.status === "rejected");
    assert.ok(rejected, "the ignored patch was not rejected");
    assert.match(rejected.summary, /Git ignores/u);
    assert.equal(fs.existsSync(path.join(root, "src", "generated.ts")), false, "the ignored patch reached disk");
    const integrity = turn.verification.find((record) => record.id === "integrity");
    assert.equal(integrity.status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a normal untracked write is evidence, not a violation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-normal-write-"));
  try {
    setupRepository(root, "src/generated.ts\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);

    await executeManagedBrowserEnvelope(
      envelope([write("src/feature.ts", "export const feature = 1;\n"), verify()], "write a normal file then verify"),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    assert.equal(turn.changedFiles.includes("src/feature.ts"), true);
    assert.equal(
      turn.repositoryPolicyViolations.some((entry) => /ignore/u.test(entry)),
      false,
      "a normal untracked write was wrongly reported as an ignored-path violation",
    );
    const integrity = turn.verification.find((record) => record.id === "integrity");
    assert.equal(integrity.status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a tracked file whose name matches an ignore rule stays writable and verifiable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-tracked-under-ignore-"));
  try {
    // config.json matches the ignore rule, but it is force-added and tracked, so Git still names it
    // and the controller must be able to modify it — check-ignore honours the index and never
    // reports a tracked path.
    git(root, ["init", "--quiet"]);
    git(root, ["config", "user.email", "bachata@example.invalid"]);
    git(root, ["config", "user.name", "Bachata Test"]);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "config.json\n");
    fs.writeFileSync(path.join(root, "src", "config.json"), "{\"v\":1}\n");
    fs.writeFileSync(path.join(root, "src", "tracked.ts"), "export const tracked = 1;\n");
    git(root, ["add", ".gitignore", "src/tracked.ts"]);
    git(root, ["add", "-f", "src/config.json"]);
    git(root, ["commit", "--quiet", "-m", "baseline"]);
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);

    assert.equal(gitIgnored(root, "src/config.json"), false, "check-ignore wrongly reported a tracked path");

    // Overwriting an existing tracked file carries its current hash (the stale-file guard); the
    // point is that the ignore guard does not block it.
    const writeConfig = {
      kind: "workspace.write",
      path: "src/config.json",
      content: "{\"v\":2}\n",
      expectedFiles: [{ path: "src/config.json", sha256: sha256("{\"v\":1}\n") }],
    };
    await executeManagedBrowserEnvelope(
      envelope([writeConfig, verify()], "modify a tracked file whose name matches an ignore rule"),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    assert.equal(fs.readFileSync(path.join(root, "src", "config.json"), "utf8"), "{\"v\":2}\n", "the tracked write was refused");
    assert.equal(turn.changedFiles.includes("src/config.json"), true, "the tracked change was not surfaced");
    assert.equal(
      turn.repositoryPolicyViolations.some((entry) => /ignore/u.test(entry)),
      false,
      "a tracked file was wrongly treated as an ignored-path violation",
    );
    const integrity = turn.verification.find((record) => record.id === "integrity");
    assert.equal(integrity.status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a git-ignored write to a Unicode/space filename is judged by the actual target and refused", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-unicode-ignored-"));
  try {
    setupRepository(root, "*.gen\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);
    const target = "src/wéird na me.gen";

    const execution = await executeManagedBrowserEnvelope(
      envelope([write(target, "export const generated = 1;\n"), verify()], "write an ignored unicode/space filename"),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    const rejected = execution.actionResults.find((entry) => entry.status === "rejected");
    assert.ok(rejected, "the ignored unicode/space write was not refused");
    assert.match(rejected.summary, /Git ignores/u);
    assert.ok(rejected.summary.includes(target), "the refusal did not name the actual target");
    assert.equal(fs.existsSync(path.join(root, target)), false, "the ignored unicode/space write reached disk");
    const integrity = turn.verification.find((record) => record.id === "integrity");
    assert.equal(integrity.status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a git-ignored write to a newline filename is judged by the actual target, never mis-parsed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-newline-ignored-"));
  try {
    setupRepository(root, "*.gen\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);
    const target = "src/two\nlines.gen";

    const execution = await executeManagedBrowserEnvelope(
      envelope([write(target, "export const generated = 1;\n"), verify()], "write an ignored newline filename"),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    // Whether the refusal comes from the ignore check (path passed as argv, judged correctly) or an
    // existing path-syntax policy, the target's bytes must never reach disk — never silently written
    // because a newline mis-parsed the check.
    const rejected = execution.actionResults.find((entry) => entry.status === "rejected");
    assert.ok(rejected, "the ignored newline write was not refused");
    assert.equal(fs.existsSync(path.join(root, target)), false, "the ignored newline write reached disk");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legitimate ignored cache activity the task did not write is never attributed to it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-cache-activity-"));
  try {
    setupRepository(root, "*.cache\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);

    // A build or the OS drops an ignored cache file mid-run — never through a controller action.
    fs.writeFileSync(path.join(root, "src", "build.cache"), "not the task's write\n");

    await executeManagedBrowserEnvelope(
      envelope([write("src/feature.ts", "export const feature = 1;\n"), verify()], "write a normal file while an ignored cache file exists"),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    assert.equal(
      turn.repositoryPolicyViolations.some((entry) => /build\.cache/u.test(entry)),
      false,
      "an ignored cache file the task did not write was attributed to the task",
    );
    const integrity = turn.verification.find((record) => record.id === "integrity");
    assert.equal(integrity.status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hiding a change the task already made behind a new ignore rule is surfaced as a violation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-hidden-change-"));
  try {
    // Nothing ignores src/feature.ts at task start, so the task may legitimately create it.
    setupRepository(root, "*.cache\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);

    // A pre-disk guard cannot see this: the feature write is allowed, and only the later nested
    // .gitignore edit makes the already-written file disappear from tracked and untracked evidence.
    const execution = await executeManagedBrowserEnvelope(
      envelope(
        [
          write("src/feature.ts", "export const feature = 1;\n"),
          write("src/.gitignore", "feature.ts\n"),
          verify(),
        ],
        "write a file then hide it behind a new ignore rule",
      ),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    assert.equal(execution.recognized, true);
    // The feature file is still on disk. Assert its invisibility from Git's own inventory, not by
    // requiring changedFiles to forget it: `git ls-files --others` no longer names it and
    // check-ignore reports it ignored.
    assert.equal(fs.existsSync(path.join(root, "src", "feature.ts")), true);
    assert.equal(gitUntracked(root).includes("src/feature.ts"), false, "git still surfaces the hidden file");
    assert.equal(gitIgnored(root, "src/feature.ts"), true, "git does not actually ignore the file");
    // The runtime retains the hidden name in changedFiles with a blocking violation, so it is
    // carried forward rather than forgotten.
    assert.equal(turn.changedFiles.includes("src/feature.ts"), true, "the hidden change was dropped from changedFiles");
    const violation = turn.repositoryPolicyViolations.find((entry) => entry.startsWith("src/feature.ts:"));
    assert.ok(violation, "a change hidden by a new ignore rule was not surfaced");
    assert.match(violation, /ignore rule now matches it/u);
    const integrity = turn.verification.find((record) => record.id === "integrity");
    assert.ok(integrity, "workspace integrity did not run");
    assert.equal(integrity.status, "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh controller-verification turn loses nothing because refused writes never reach disk", async () => {
  // The real createRuntime path: final controller verification, the next role and rollover each
  // build a brand-new turn through prepareManagedBrowserTurn with no memory of what earlier turns
  // wrote. The old ephemeral list of written paths would be empty here, so a same-turn violation
  // could vanish while ignored bytes lingered. The correction refuses the write before disk, so a
  // fresh turn simply observes a clean tree — and the ignored bytes are provably absent.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-fresh-turn-"));
  try {
    setupRepository(root, "src/generated.ts\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);

    // Turn A attempts the ignored write and is refused before disk.
    const mutatingTurn = createTurn(root);
    await executeManagedBrowserEnvelope(
      envelope([write("src/generated.ts", "export const generated = 1;\n")], "attempt an ignored write"),
      mutatingTurn,
      options(root, baseline),
      async () => "approve",
    );
    assert.equal(fs.existsSync(path.join(root, "src", "generated.ts")), false, "the refused write must never reach disk");

    // Turn B is a genuinely fresh controller-verification turn, exactly as createRuntime builds one.
    // Because the write was refused before disk, the fresh turn simply sees a clean tree — there are
    // no invisible bytes for it to lose. (The direct non-controller write residual is intentionally
    // NOT asserted here; it is the known safety gap, reported, not a desired contract.)
    const freshTurn = await prepareManagedBrowserTurn(options(root, baseline));
    const [record] = await runManagedControllerVerification(freshTurn, options(root, baseline), ["integrity"]);
    assert.equal(record.status, "passed", "fresh-turn verification should see a clean tree");
    assert.equal(
      freshTurn.repositoryPolicyViolations.some((entry) => /ignore/u.test(entry)),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an ignore rule changed by the approval callback still refuses the target inside the boundary", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-approval-race-"));
  try {
    setupRepository(root, "*.cache\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);
    const target = path.join(root, "src", "feature.ts");

    // The pre-approval guard sees an allowed path; the approval callback then makes it ignored by
    // writing a nested ignore rule. The boundary must re-check and refuse the target before bytes.
    const execution = await executeManagedBrowserEnvelope(
      envelope([write("src/feature.ts", "export const feature = 1;\n"), verify()], "approval changes the ignore rule mid-flight"),
      turn,
      options(root, baseline),
      async () => {
        fs.writeFileSync(path.join(root, "src", ".gitignore"), "feature.ts\n");
        return "approve";
      },
    );

    const rejected = execution.actionResults.find((entry) => entry.status === "rejected");
    assert.ok(rejected, "the target ignored at approval time was not refused inside the boundary");
    assert.match(rejected.summary, /Git ignores/u);
    // The bytes never landed: only the approval callback's own .gitignore exists under src.
    assert.equal(fs.existsSync(target), false, "an approval-time ignored target still reached disk");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a change hidden after two verification runs in the same turn stays surfaced as a violation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-hidden-twice-"));
  try {
    setupRepository(root, "*.cache\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const turn = createTurn(root);

    // write a normal path -> hide it with a nested ignore rule -> verify twice. The second verify
    // recomputes the changed list (which no longer names the hidden file); the monotonic surfaced
    // set is what keeps the violation from being cleared within the turn.
    const execution = await executeManagedBrowserEnvelope(
      envelope(
        [
          write("src/feature.ts", "export const feature = 1;\n"),
          write("src/.gitignore", "feature.ts\n"),
          verify(),
          verify(),
        ],
        "hide a change then verify twice",
      ),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    assert.equal(execution.recognized, true);
    assert.equal(fs.existsSync(path.join(root, "src", "feature.ts")), true);
    const violation = turn.repositoryPolicyViolations.find((entry) => entry.startsWith("src/feature.ts:"));
    assert.ok(violation, "the hidden change was cleared by a later verification run");
    const integrity = turn.verification.find((record) => record.id === "integrity");
    assert.equal(integrity.status, "failed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a change hidden through the action loop is retained in changedFiles across rollover turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-rollover-hidden-"));
  try {
    setupRepository(root, "*.cache\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);

    // Turn 1: create the file and hide it behind a nested ignore rule — both through the action
    // loop, exactly as an agent would — then verify twice. The runtime must retain the hidden name
    // in changedFiles with its blocking violation, not forget it.
    const turn1 = createTurn(root);
    await executeManagedBrowserEnvelope(
      envelope(
        [
          write("src/feature.ts", "export const feature = 1;\n"),
          write("src/.gitignore", "feature.ts\n"),
          verify(),
          verify(),
        ],
        "create then hide a file, verify twice",
      ),
      turn1,
      options(root, baseline),
      async () => "approve",
    );
    // Git genuinely no longer surfaces it; the runtime nonetheless keeps the name.
    assert.equal(gitUntracked(root).includes("src/feature.ts"), false);
    assert.equal(gitIgnored(root, "src/feature.ts"), true);
    assert.equal(turn1.changedFiles.includes("src/feature.ts"), true, "turn 1 dropped the hidden change");
    assert.ok(turn1.repositoryPolicyViolations.some((entry) => entry.startsWith("src/feature.ts:")));

    // Turn 2 is prepared fresh (rollover), carrying exactly the changedFiles the runtime checkpoints.
    const carried1 = turn1.changedFiles;
    const turn2 = await prepareManagedBrowserTurn({ ...options(root, baseline), initialChangedFiles: carried1 });
    const [record2] = await runManagedControllerVerification(
      turn2,
      { ...options(root, baseline), initialChangedFiles: carried1 },
      ["integrity"],
    );
    assert.equal(record2.status, "failed", "the rollover turn did not re-flag the hidden change");
    assert.equal(turn2.changedFiles.includes("src/feature.ts"), true, "rollover turn 2 dropped the hidden change");
    assert.ok(turn2.repositoryPolicyViolations.some((entry) => entry.startsWith("src/feature.ts:")));

    // Turn 3 rolls over again from turn 2's changedFiles: the retention is stable, not a one-shot.
    const carried2 = turn2.changedFiles;
    const turn3 = await prepareManagedBrowserTurn({ ...options(root, baseline), initialChangedFiles: carried2 });
    const [record3] = await runManagedControllerVerification(
      turn3,
      { ...options(root, baseline), initialChangedFiles: carried2 },
      ["integrity"],
    );
    assert.equal(record3.status, "failed", "the second rollover turn dropped the hidden change");
    assert.equal(turn3.changedFiles.includes("src/feature.ts"), true);

    // Once the ignore rule is removed, Git surfaces the file again and the name is no longer retained
    // as a hidden violation (it drops out on its own rather than lingering forever).
    fs.rmSync(path.join(root, "src", ".gitignore"));
    const carried3 = turn3.changedFiles;
    const turn4 = await prepareManagedBrowserTurn({ ...options(root, baseline), initialChangedFiles: carried3 });
    const [record4] = await runManagedControllerVerification(
      turn4,
      { ...options(root, baseline), initialChangedFiles: carried3 },
      ["integrity"],
    );
    assert.equal(
      turn4.repositoryPolicyViolations.some((entry) => /ignore rule now matches it/u.test(entry)),
      false,
      "an un-hidden change was still reported as a hidden-path violation",
    );
    assert.equal(record4.status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an initially untracked baseline file overwritten then hidden stays blocked across fresh turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-baseline-hidden-"));
  try {
    // src/note.txt is untracked and dirty at task start, so it enters the baseline inventory. When
    // the task later hides it, the baseline-vs-current comparison synthesizes it as a deletion and
    // it is already present in changedFiles; the retention check must still judge its ignore/policy
    // status (not skip it because it is already listed) and keep the blocking violation.
    setupRepository(root, "*.cache\n");
    fs.writeFileSync(path.join(root, "src", "note.txt"), "original\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    assert.ok(baseline.entries.some((entry) => entry.path === "src/note.txt"), "baseline did not capture the untracked file");

    const turn1 = createTurn(root);
    const overwriteNote = {
      kind: "workspace.write",
      path: "src/note.txt",
      content: "changed by the task\n",
      expectedFiles: [{ path: "src/note.txt", sha256: sha256("original\n") }],
    };
    await executeManagedBrowserEnvelope(
      envelope([overwriteNote, write("src/.gitignore", "note.txt\n"), verify(), verify()], "overwrite an untracked baseline file then hide it"),
      turn1,
      options(root, baseline),
      async () => "approve",
    );

    // Git no longer surfaces the modified file, but the runtime keeps it with a blocking violation
    // rather than passing it off as a clean baseline deletion.
    assert.equal(fs.readFileSync(path.join(root, "src", "note.txt"), "utf8"), "changed by the task\n");
    assert.equal(gitIgnored(root, "src/note.txt"), true);
    assert.equal(gitUntracked(root).includes("src/note.txt"), false);
    assert.equal(turn1.changedFiles.includes("src/note.txt"), true, "the hidden baseline change was dropped from changedFiles");
    const violation1 = turn1.repositoryPolicyViolations.find((entry) => entry.startsWith("src/note.txt:"));
    assert.ok(violation1, "the hidden baseline change was not surfaced as a violation");
    assert.match(violation1, /ignore rule now matches it/u);
    assert.equal(turn1.verification.find((record) => record.id === "integrity").status, "failed");

    // Rollover: a fresh turn built from the carried changedFiles remains blocked.
    const carried1 = turn1.changedFiles;
    const turn2 = await prepareManagedBrowserTurn({ ...options(root, baseline), initialChangedFiles: carried1 });
    const [record2] = await runManagedControllerVerification(turn2, { ...options(root, baseline), initialChangedFiles: carried1 }, ["integrity"]);
    assert.equal(record2.status, "failed", "the rollover turn cleared the hidden baseline change");
    assert.ok(turn2.repositoryPolicyViolations.some((entry) => entry.startsWith("src/note.txt:")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hiding an unchanged baseline file is not a task change and leaves no ghost deletion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-hide-unchanged-"));
  try {
    // src/note.txt is untracked at task start (in the baseline). The task only adds an ignore rule
    // that matches it and never touches its bytes. The baseline comparison would synthesize it as a
    // deletion; because its bytes and mode still equal the baseline fingerprint, the retention check
    // must drop that false task-change evidence instead of retaining a ghost.
    setupRepository(root, "*.cache\n");
    fs.writeFileSync(path.join(root, "src", "note.txt"), "original\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);

    const turn = createTurn(root);
    await executeManagedBrowserEnvelope(
      envelope([write("src/.gitignore", "note.txt\n"), verify()], "hide an unchanged baseline file"),
      turn,
      options(root, baseline),
      async () => "approve",
    );

    assert.equal(fs.readFileSync(path.join(root, "src", "note.txt"), "utf8"), "original\n");
    assert.equal(gitIgnored(root, "src/note.txt"), true);
    assert.equal(turn.changedFiles.includes("src/note.txt"), false, "an unchanged hidden baseline file was retained as a ghost deletion");
    assert.equal(turn.changedFiles.includes("src/.gitignore"), true, "the actual ignore-rule change was dropped");
    assert.equal(
      turn.repositoryPolicyViolations.some((entry) => entry.startsWith("src/note.txt:")),
      false,
      "an unchanged hidden baseline file was wrongly flagged",
    );
    assert.equal(turn.verification.find((record) => record.id === "integrity").status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restoring a hidden file to its baseline bytes and mode drops the retained task change", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-hidden-restore-"));
  try {
    setupRepository(root, "*.cache\n");
    const notePath = path.join(root, "src", "note.txt");
    fs.writeFileSync(notePath, "original\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);
    const originalMode = fs.statSync(notePath).mode;

    // Turn 1 overwrites and hides the file: retained with a blocking violation.
    const turn1 = createTurn(root);
    const overwriteNote = {
      kind: "workspace.write",
      path: "src/note.txt",
      content: "changed by the task\n",
      expectedFiles: [{ path: "src/note.txt", sha256: sha256("original\n") }],
    };
    await executeManagedBrowserEnvelope(
      envelope([overwriteNote, write("src/.gitignore", "note.txt\n"), verify()], "overwrite then hide"),
      turn1,
      options(root, baseline),
      async () => "approve",
    );
    assert.ok(turn1.repositoryPolicyViolations.some((entry) => entry.startsWith("src/note.txt:")));

    // A hidden file cannot be reverted through the sanctioned write channel (the ignore guard refuses
    // writes to it), so recovery happens outside it. Restore the exact baseline bytes.
    fs.writeFileSync(notePath, "original\n");

    // The baseline fingerprint pins the file mode as well as its bytes. On a platform whose chmod is
    // honoured, bytes-back-to-baseline but a different readable mode is NOT a revert: the retained
    // name and its violation must survive. (Skipped where chmod carries no comparable permission
    // bits, e.g. Windows; this asserts nothing about a mode that was never changed there.)
    if (process.platform !== "win32") {
      const altMode = (originalMode & 0o777) === 0o644 ? 0o600 : 0o644;
      fs.chmodSync(notePath, altMode);
      assert.notEqual(fs.statSync(notePath).mode & 0o777, originalMode & 0o777, "the alternate mode did not differ; mode retention is untested");

      const carriedMode = turn1.changedFiles;
      const turnMode = await prepareManagedBrowserTurn({ ...options(root, baseline), initialChangedFiles: carriedMode });
      const [recordMode] = await runManagedControllerVerification(turnMode, { ...options(root, baseline), initialChangedFiles: carriedMode }, ["integrity"]);
      assert.equal(recordMode.status, "failed", "a mode-only difference from baseline dropped the retained hidden change");
      assert.equal(turnMode.changedFiles.includes("src/note.txt"), true, "the mode-changed hidden file was not retained");
      assert.ok(turnMode.repositoryPolicyViolations.some((entry) => entry.startsWith("src/note.txt:")), "the mode-changed hidden file lost its violation");

      // Restore the exact original mode so bytes and mode both match the baseline fingerprint.
      fs.chmodSync(notePath, originalMode);
    }

    // A fresh rollover turn carries the hidden name but now finds its bytes and mode back at baseline,
    // so it drops the retained change rather than blocking forever.
    const carried1 = turn1.changedFiles;
    const turn2 = await prepareManagedBrowserTurn({ ...options(root, baseline), initialChangedFiles: carried1 });
    const [record2] = await runManagedControllerVerification(turn2, { ...options(root, baseline), initialChangedFiles: carried1 }, ["integrity"]);
    assert.equal(turn2.changedFiles.includes("src/note.txt"), false, "a reverted hidden file was retained as a task change");
    assert.equal(
      turn2.repositoryPolicyViolations.some((entry) => entry.startsWith("src/note.txt:")),
      false,
      "a reverted hidden file was still flagged as a violation",
    );
    assert.equal(record2.status, "passed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a retained name whose ancestor became an out-of-scope symlink fails closed across repeats and fresh turns", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-retained-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-outside-"));
  try {
    setupRepository(root, "*.cache\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);

    // Turn 1 creates a nested file, then hides its whole parent with src/.gitignore ("pkg" matches
    // the directory now AND the symlink that replaces it later), so the name is carried forward in
    // changedFiles with a blocking violation and the replacement stays invisible to Git.
    const turn1 = createTurn(root);
    await executeManagedBrowserEnvelope(
      envelope([write("src/pkg/gen.txt", "export const gen = 1;\n"), write("src/.gitignore", "pkg\n"), verify()], "create then hide a nested file"),
      turn1,
      options(root, baseline),
      async () => "approve",
    );
    assert.equal(turn1.changedFiles.includes("src/pkg/gen.txt"), true, "the hidden nested change was not retained");
    assert.equal(turn1.verification.find((record) => record.id === "integrity").status, "failed", "the hidden change was not flagged");

    // The nested directory becomes a symlink pointing outside the workspace. The bytes that would
    // answer "is this still a hidden change?" now live outside scope. Git surfaces neither the
    // ignored symlink nor its child.
    fs.rmSync(path.join(root, "src", "pkg"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(root, "src", "pkg"));
    assert.equal(gitUntracked(root).includes("src/pkg"), false, "git surfaced the out-of-scope symlink");
    assert.equal(gitIgnored(root, "src/pkg"), true, "git does not ignore the replacement symlink");
    assert.equal(gitUntracked(root).includes("src/pkg/gen.txt"), false, "git surfaced the child under the symlink");

    // Repeated verification on the same turn (whose changedFiles carry the retained name) must stay
    // refused. repositoryState propagates the path-policy failure rather than returning a reduced
    // list, so it throws before assigning a new changedFiles/repositoryPolicyViolations array — the
    // failure lands in the returned verification record's summary and the retained name survives.
    for (const label of ["first", "second"]) {
      const [record] = await runManagedControllerVerification(turn1, options(root, baseline), ["integrity"]);
      assert.equal(record.status, "failed", `the ${label} verification did not refuse the symlinked-ancestor retained name`);
      assert.ok(record.summary.startsWith("src/pkg/gen.txt:"), `the ${label} verification did not name the retained target`);
      // A path-policy rejection (resolves outside the workspace), not the ignore-rule message: the
      // name was revalidated and refused before anything read or fingerprinted the target.
      assert.match(record.summary, /outside the workspace/u);
      assert.equal(/ignore rule now matches it/u.test(record.summary), false, `the ${label} verification read the target instead of refusing on path policy`);
      assert.equal(turn1.changedFiles.includes("src/pkg/gen.txt"), true, `the ${label} verification dropped the retained name`);
    }

    // A genuinely fresh rollover/restart turn built from the carried changedFiles rejects too, so the
    // unsafe retained state can never be forgotten by a later turn.
    await assert.rejects(
      prepareManagedBrowserTurn({ ...options(root, baseline), initialChangedFiles: turn1.changedFiles }),
      /outside the workspace/u,
      "a fresh turn accepted an out-of-scope retained name",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("the dirty-path cap counts the git-visible and retained sets combined, not each alone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-retained-cap-"));
  try {
    setupRepository(root, "*.cache\n");
    const baseline = await captureManagedRepositoryBaseline(root, new AbortController().signal);

    // One ordinary visible untracked file after the baseline, so gitVisible holds exactly one path.
    // The retained list is 10,000 names — at the cap on its own, not over — so only counting the
    // combined set rejects here. The limit is checked before any retained name is read, so none of
    // the 10,000 needs to exist on disk.
    fs.writeFileSync(path.join(root, "src", "feature.ts"), "export const feature = 1;\n");
    const retained = Array.from({ length: 10000 }, (_unused, i) => `src/retained-${String(i)}.ts`);

    await assert.rejects(
      prepareManagedBrowserTurn({ ...options(root, baseline), initialChangedFiles: retained }),
      /more than 10000 dirty paths/u,
      "the combined git-visible + retained set did not enforce the dirty-path cap",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
