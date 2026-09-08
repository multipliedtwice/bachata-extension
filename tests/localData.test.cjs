const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  archivedRunCandidates,
  conversationOwnedPaths,
  conversationStorageDirectory,
  describeLocalData,
  formatBytes,
} = require("../dist/state/localData.js");

const write = async (file, contents) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
};

test("sizes are reported in readable units", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2 KiB");
  assert.equal(formatBytes(1_572_864), "1.5 MiB");
});

test("the inventory names every local store, its path, and what deleting it removes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-local-data-"));
  try {
    await write(path.join(root, "bachata-state.sqlite"), "x".repeat(100));
    await write(path.join(root, "transcript.jsonl"), "y".repeat(50));
    await write(path.join(root, "attachments", "a.png"), "z".repeat(10));
    await write(path.join(root, "pipelines", "p.json"), "{}");
    await write(path.join(root, "conversations", "c1", "transcript.jsonl"), "t".repeat(20));

    const entries = await describeLocalData({
      storageRoot: root,
      catalogPath: path.join(root, "bachata-state.sqlite"),
      retainedWorktrees: [],
    });
    const byCategory = Object.fromEntries(entries.map((entry) => [entry.category, entry]));
    assert.deepEqual(Object.keys(byCategory).sort(), [
      "attachments",
      "catalog",
      "pipelines",
      "transcripts",
      "worktrees",
    ]);
    assert.equal(byCategory.catalog.bytes, 100);
    assert.equal(byCategory.attachments.bytes, 10);
    assert.equal(byCategory.transcripts.bytes, 70);
    assert.equal(byCategory.worktrees.path, "none retained");
    entries.forEach((entry) => {
      assert.ok(entry.removes.length > 0, `${entry.category} does not say what is removed`);
      assert.ok(entry.keeps.length > 0, `${entry.category} does not say what is kept`);
    });
    assert.match(byCategory.attachments.keeps, /recorded in the catalog/u);
    assert.match(byCategory.transcripts.keeps, /Catalog metadata/u);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("only archived, idle runs past the retention period are cleanup candidates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-retention-"));
  try {
    const now = Date.parse("2026-08-24T00:00:00.000Z");
    const old = new Date(now - 40 * 86_400_000).toISOString();
    const recent = new Date(now - 2 * 86_400_000).toISOString();
    await write(path.join(root, "conversations", "old-archived", "transcript.jsonl"), "a".repeat(30));

    const conversations = [
      { id: "old-archived", title: "Old", updatedAt: old, archived: true, running: false },
      { id: "old-active", title: "Active", updatedAt: old, archived: false, running: false },
      { id: "old-running", title: "Running", updatedAt: old, archived: true, running: true },
      { id: "recent-archived", title: "Recent", updatedAt: recent, archived: true, running: false },
      { id: "broken-date", title: "Broken", updatedAt: "not-a-date", archived: true, running: false },
    ];

    assert.deepEqual(
      await archivedRunCandidates({ storageRoot: root, conversations, retentionDays: 0, nowMs: now }),
      [],
    );
    const candidates = await archivedRunCandidates({
      storageRoot: root,
      conversations,
      retentionDays: 30,
      nowMs: now,
    });
    assert.deepEqual(candidates.map((candidate) => candidate.conversationId), ["old-archived"]);
    assert.equal(candidates[0].bytes, 30);
    assert.deepEqual(candidates[0].paths, [path.join(root, "conversations", "old-archived")]);

    // EX-G6-14, EX-A5-R15. The runtime gives the initial conversation the storage root itself,
    // so cleanup used to offer it as `conversations/default`: a path holding nothing, whose
    // deletion removes nothing. Excluding it instead left it out of retention entirely, so its
    // expired transcript and attachments stayed and the person was told nothing was old enough.
    // It is a candidate like any other, named by the files it owns — the same files a full
    // deletion of that conversation stages — and never by the storage root, which holds the
    // catalog and every other conversation.
    await write(path.join(root, "transcript.jsonl"), "b".repeat(11));
    await write(path.join(root, "transcript.index.json"), "c".repeat(7));
    await write(path.join(root, "attachments", "one.txt"), "d".repeat(5));
    await write(path.join(root, "bachata-state.sqlite"), "e".repeat(9_000));
    const withDefault = await archivedRunCandidates({
      storageRoot: root,
      conversations: [
        ...conversations,
        { id: "default", title: "Initial", updatedAt: old, archived: true, running: false },
      ],
      retentionDays: 30,
      nowMs: now,
    });
    assert.deepEqual(
      withDefault.map((candidate) => candidate.conversationId).sort(),
      ["default", "old-archived"],
      "the initial conversation was left out of retention, so its expired data stays for good",
    );
    const initial = withDefault.find((candidate) => candidate.conversationId === "default");
    assert.deepEqual(initial.paths, [
      path.join(root, "transcript.jsonl"),
      path.join(root, "transcript.index.json"),
      path.join(root, "attachments"),
    ]);
    assert.deepEqual(initial.paths.filter((entry) => entry === root), [], "the storage root itself was offered for deletion");
    assert.equal(initial.bytes, 23, "the catalog beside the initial conversation was counted as its data");
    assert.equal(initial.fileCount, 3);
    assert.deepEqual(
      conversationOwnedPaths(root, "default"),
      initial.paths,
      "retention and deletion disagree about what the initial conversation owns",
    );
    assert.deepEqual(conversationOwnedPaths(root, "c1"), [path.join(root, "conversations", "c1")]);
    assert.equal(conversationStorageDirectory(root, "default"), root);
    assert.equal(
      conversationStorageDirectory(root, "c1"),
      path.join(root, "conversations", "c1"),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a missing storage root reports zero instead of throwing", async () => {
  const entries = await describeLocalData({
    storageRoot: path.join(os.tmpdir(), "bachata-does-not-exist-1234"),
    catalogPath: path.join(os.tmpdir(), "bachata-does-not-exist-1234", "bachata-state.sqlite"),
    retainedWorktrees: [path.join(os.tmpdir(), "bachata-missing-worktree")],
  });
  assert.deepEqual(entries.map((entry) => entry.bytes), [0, 0, 0, 0, 0]);
});
