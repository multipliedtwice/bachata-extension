const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ARCHIVE_ROLLBACK_INCOMPLETE,
  DELETION_ROLLBACK_INCOMPLETE,
  archiveReplacementChoice,
  busyConversationRefusal,
  deletionActiveChoice,
  resumeIterationWindow,
  resumeRefusal,
} = require("../dist/conversations/conversationLifecycle.js");

test("a working run is named in the refusal, in the words of what was attempted", () => {
  assert.equal(busyConversationRefusal("Review the auth middleware", "archive"), "Interrupt Review the auth middleware before changing this run archive");
  assert.equal(busyConversationRefusal("Review the auth middleware", "delete"), "Interrupt Review the auth middleware before deleting this run");
  assert.equal(busyConversationRefusal(undefined, "delete"), undefined);
});

const conversation = (id, over = {}) => ({ id, title: id, archived: false, ...over });

test("archiving the active run prefers an unarchived top-level run over a child", () => {
  assert.deepEqual(
    archiveReplacementChoice({
      candidates: [conversation("a"), conversation("child", { parentConversationId: "a" }), conversation("b")],
      archivedIds: new Set(["a"]),
    }),
    { kind: "existing", conversationId: "b" },
  );
});

test("a child is taken only when no top-level run is left", () => {
  assert.deepEqual(
    archiveReplacementChoice({
      candidates: [conversation("a"), conversation("child", { parentConversationId: "a" })],
      archivedIds: new Set(["a"]),
    }),
    { kind: "existing", conversationId: "child" },
  );
});

test("archiving the last run creates one, so the panel always has somewhere to be", () => {
  assert.deepEqual(archiveReplacementChoice({ candidates: [conversation("a")], archivedIds: new Set(["a"]) }), { kind: "create" });
  assert.deepEqual(
    archiveReplacementChoice({ candidates: [conversation("a"), conversation("b", { archived: true })], archivedIds: new Set(["a"]) }),
    { kind: "create" },
  );
});

test("a deletion that did not touch the active run leaves the reader where they are", () => {
  const choice = deletionActiveChoice({
    remaining: [conversation("a"), conversation("b")],
    activeConversationId: "b",
    removedIds: new Set(["c"]),
  });
  assert.equal(choice.keepsActive, true);
  assert.deepEqual(choice.fallback, { kind: "existing", conversationId: "a" });
});

test("a deletion that took the active run, or left it archived, moves to the first top-level run", () => {
  assert.equal(
    deletionActiveChoice({ remaining: [conversation("a")], activeConversationId: "b", removedIds: new Set(["b"]) }).keepsActive,
    false,
  );
  assert.equal(
    deletionActiveChoice({
      remaining: [conversation("a"), conversation("b", { archived: true })],
      activeConversationId: "b",
      removedIds: new Set(),
    }).keepsActive,
    false,
  );
});

test("a deletion that leaves no unarchived top-level run creates one", () => {
  assert.deepEqual(
    deletionActiveChoice({
      remaining: [conversation("child", { parentConversationId: "a" })],
      activeConversationId: "child",
      removedIds: new Set(["a"]),
    }).fallback,
    { kind: "create" },
  );
});

const refusal = (over = {}) =>
  resumeRefusal({
    archived: false,
    hasRecovery: true,
    runtimeProvidesSnapshot: true,
    snapshotHash: "hash-1",
    recoveryHash: "hash-1",
    latestIterationStatus: "interrupted",
    ...over,
  });

test("an archived run is unarchived first, before anything else is judged", () => {
  assert.equal(
    refusal({ archived: true, hasRecovery: false, latestIterationStatus: "completed" }),
    "Unarchive the run before resuming it",
  );
});

test("a run with no checkpoint has nothing to resume", () => {
  assert.equal(refusal({ hasRecovery: false }), "No recoverable workflow is available");
});

test("a checkpoint whose pipeline moved is refused, and one the runtime cannot compare is not", () => {
  assert.equal(refusal({ snapshotHash: "hash-2" }), "The recoverable workflow pipeline snapshot does not match");
  assert.equal(refusal({ runtimeProvidesSnapshot: false, snapshotHash: "hash-2" }), undefined);
  assert.equal(refusal({ snapshotHash: undefined }), undefined);
});

test("a checkpoint without an interrupted iteration is left over, not resumable", () => {
  assert.equal(refusal({ latestIterationStatus: "completed" }), "The recoverable workflow has no matching interrupted iteration");
  assert.equal(refusal({ latestIterationStatus: undefined }), "The recoverable workflow has no matching interrupted iteration");
  assert.equal(refusal(), undefined);
});

test("a resume never runs more passes than configured, nor from a pass outside the run", () => {
  assert.deepEqual(resumeIterationWindow({ iterationCount: 3, activeIteration: 2, maximumIterations: 10 }), { requestedIterations: 3, displayIndex: 2 });
  assert.deepEqual(resumeIterationWindow({ iterationCount: 99, activeIteration: 50, maximumIterations: 4 }), { requestedIterations: 4, displayIndex: 4 });
  assert.deepEqual(resumeIterationWindow({ iterationCount: 0, activeIteration: 0, maximumIterations: 10 }), { requestedIterations: 1, displayIndex: 1 });
});

test("each rollback failure is named for the change it could not undo", () => {
  assert.equal(ARCHIVE_ROLLBACK_INCOMPLETE, "Conversation archive change failed and rollback was incomplete");
  assert.equal(DELETION_ROLLBACK_INCOMPLETE, "Conversation deletion failed and rollback was incomplete");
});
