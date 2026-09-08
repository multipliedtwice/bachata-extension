const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  isPathAtOrInside,
  isPathInside,
  parseDeletionManifest,
  plannedRestoreEntries,
  stagedDeletionDisposition,
} = require("../dist/conversations/conversationDeletion.js");

// EX-3. Undoing a conversation deletion. A manifest is read back from disk after a crash, so it
// decides which paths a restore writes to while being exactly the kind of file a crash can leave
// truncated or a hostile workspace can plant. Every check below was inside
// `createConversationManager`, reachable only by standing up the whole manager against a real
// storage root and catalog.

const storageRoot = path.resolve("/storage");
const trashRoot = path.join(storageRoot, ".trash", "conversation-deletions");
const directory = path.join(trashRoot, "staged-1");
const stagedRoot = path.join(directory, "data");

const policy = {
  storageRoot,
  trashRoot,
  stagedRoot,
  isRuntimeStorageKey: (key) => key.startsWith("bachata.conversationRuntime.v2."),
  isRunReference: (runRef) => /^R[0-9]+$/u.test(runRef),
};

const manifest = (overrides = {}) => ({
  version: 1,
  runRefs: ["R1"],
  entries: [
    {
      original: path.join(storageRoot, "conversations", "one"),
      staged: path.join(stagedRoot, "one"),
    },
  ],
  runtimeValues: [
    { storageKey: "bachata.conversationRuntime.v2.abc", present: true, value: { any: "thing" } },
  ],
  ...overrides,
});

test("a well-formed manifest round-trips, and an absent runtime value carries no value key", () => {
  const parsed = parseDeletionManifest(
    manifest({
      runtimeValues: [{ storageKey: "bachata.conversationRuntime.v2.abc", present: false, value: 1 }],
    }),
    policy,
  );
  assert.deepEqual(parsed.runtimeValues, [
    { storageKey: "bachata.conversationRuntime.v2.abc", present: false },
  ]);
  assert.equal(parseDeletionManifest(manifest(), policy).entries.length, 1);
});

test("an original path outside this workspace's storage is refused", () => {
  // WHY. The manifest names the destination of a rename. A forged one would otherwise have the
  // restore write anywhere the editor can reach.
  assert.equal(
    parseDeletionManifest(
      manifest({
        entries: [{ original: path.resolve("/etc/passwd"), staged: path.join(stagedRoot, "one") }],
      }),
      policy,
    ),
    undefined,
  );
});

test("an original path inside the trash root is refused, so a restore cannot unstage the staging area", () => {
  assert.equal(
    parseDeletionManifest(
      manifest({
        entries: [
          { original: path.join(trashRoot, "other", "data"), staged: path.join(stagedRoot, "one") },
        ],
      }),
      policy,
    ),
    undefined,
  );
});

test("a staged path outside this manifest's own directory is refused", () => {
  assert.equal(
    parseDeletionManifest(
      manifest({
        entries: [
          {
            original: path.join(storageRoot, "conversations", "one"),
            staged: path.join(trashRoot, "staged-2", "data", "one"),
          },
        ],
      }),
      policy,
    ),
    undefined,
  );
});

test("one unusable entry refuses the whole manifest rather than half-undoing a deletion", () => {
  // WHY ALL OR NOTHING. Restoring the sound entries would leave a conversation whose storage
  // exists and whose catalog rows do not.
  assert.equal(
    parseDeletionManifest(
      manifest({
        entries: [
          {
            original: path.join(storageRoot, "conversations", "one"),
            staged: path.join(stagedRoot, "one"),
          },
          { original: path.resolve("/elsewhere"), staged: path.join(stagedRoot, "two") },
        ],
      }),
      policy,
    ),
    undefined,
  );
});

test("duplicate originals, duplicate staged paths and duplicate storage keys are all refused", () => {
  const duplicated = (key, entry) => parseDeletionManifest(manifest({ [key]: entry }), policy);
  const original = path.join(storageRoot, "conversations", "one");
  assert.equal(
    duplicated("entries", [
      { original, staged: path.join(stagedRoot, "a") },
      { original, staged: path.join(stagedRoot, "b") },
    ]),
    undefined,
  );
  assert.equal(
    duplicated("entries", [
      { original, staged: path.join(stagedRoot, "a") },
      { original: path.join(storageRoot, "two"), staged: path.join(stagedRoot, "a") },
    ]),
    undefined,
  );
  assert.equal(
    duplicated("runtimeValues", [
      { storageKey: "bachata.conversationRuntime.v2.abc", present: false },
      { storageKey: "bachata.conversationRuntime.v2.abc", present: false },
    ]),
    undefined,
  );
});

test("a foreign storage key, a bad run reference and a wrong version are each refused", () => {
  assert.equal(
    parseDeletionManifest(
      manifest({ runtimeValues: [{ storageKey: "some.other.key", present: false }] }),
      policy,
    ),
    undefined,
  );
  assert.equal(parseDeletionManifest(manifest({ runRefs: ["not-a-ref"] }), policy), undefined);
  assert.equal(parseDeletionManifest(manifest({ version: 2 }), policy), undefined);
});

test("anything that is not a manifest-shaped record is refused without inspecting it", () => {
  for (const value of [undefined, null, 4, "manifest", [], { version: 1 }]) {
    assert.equal(parseDeletionManifest(value, policy), undefined);
  }
  assert.equal(
    parseDeletionManifest(manifest({ runRefs: [1] }), policy),
    undefined,
  );
  assert.equal(parseDeletionManifest(manifest({ entries: "no" }), policy), undefined);
  assert.equal(parseDeletionManifest(manifest({ runtimeValues: "no" }), policy), undefined);
});

test("a path equal to the root is at it but not inside it", () => {
  assert.equal(isPathInside(storageRoot, storageRoot), false);
  assert.equal(isPathAtOrInside(storageRoot, storageRoot), true);
  assert.equal(isPathInside(storageRoot, path.join(storageRoot, "x")), true);
  assert.equal(isPathAtOrInside(storageRoot, path.resolve("/elsewhere")), false);
});

test("a restore plan is built in reverse staging order and skips what is already back", async () => {
  // WHY REVERSE. A directory is considered after everything staged out of it, so restoring the
  // children cannot recreate a parent the plan is about to move.
  const outer = { original: path.join(storageRoot, "a"), staged: path.join(stagedRoot, "a") };
  const inner = { original: path.join(storageRoot, "a", "b"), staged: path.join(stagedRoot, "b") };
  const present = new Set([outer.staged, inner.original]);
  const planned = await plannedRestoreEntries(
    { version: 1, runRefs: [], entries: [outer, inner], runtimeValues: [] },
    async (value) => present.has(value),
  );
  assert.deepEqual(planned, [outer]);

  const bothStaged = new Set([outer.staged, inner.staged]);
  assert.deepEqual(
    await plannedRestoreEntries(
      { version: 1, runRefs: [], entries: [outer, inner], runtimeValues: [] },
      async (value) => bothStaged.has(value),
    ),
    [inner, outer],
  );
});

test("a path present in both places refuses before anything is moved", async () => {
  // WHY REFUSE. Restoring over whatever took the path would destroy it, and there is no way to
  // tell which copy the user meant to keep.
  await assert.rejects(
    plannedRestoreEntries(manifest(), async () => true),
    /already exists/,
  );
});

test("a path present in neither place refuses rather than silently restoring nothing", async () => {
  await assert.rejects(
    plannedRestoreEntries(manifest(), async () => false),
    /and its staged copy are both missing/,
  );
});

test("a deletion whose runs are still in the catalog never completed and is put back", () => {
  assert.equal(
    stagedDeletionDisposition(manifest({ runRefs: ["R1", "R2"] }), (runRef) => runRef === "R2"),
    "restore",
  );
  assert.equal(
    stagedDeletionDisposition(manifest({ runRefs: ["R1"] }), () => false),
    "discard",
  );
  assert.equal(stagedDeletionDisposition(manifest({ runRefs: [] }), () => true), "discard");
});
