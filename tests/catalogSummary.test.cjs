const assert = require("node:assert/strict");
const test = require("node:test");

const {
  conversationCatalogStatus,
  conversationSummaryFromCatalog,
  conversationSummaryToCatalog,
  conversationWorkflowStatus,
} = require("../dist/conversations/catalogSummary.js");

// EX-AUD-12. Both directions of the one mapping between a persisted run and the summary the
// product renders. The writer, a read-only secondary window and the catalog writer all go
// through it, so a disagreement here is two windows showing different runs.

const summary = (overrides = {}) => ({
  id: "run-1",
  runRef: "run-1",
  title: "A run",
  iterationCount: 3,
  activeIteration: 1,
  createdAt: 10,
  updatedAt: 20,
  running: false,
  waitingForResources: false,
  workflowStatus: "idle",
  unread: false,
  archived: false,
  ...overrides,
});

const record = (overrides = {}) => ({
  runRef: "run-1",
  title: "A run",
  input: "",
  iterationCount: 3,
  activeIteration: 1,
  createdAt: 10,
  updatedAt: 20,
  status: "draft",
  unread: false,
  archived: false,
  participants: [],
  ...overrides,
});

test("a run that is doing nothing recorded is a draft", () => {
  assert.equal(conversationCatalogStatus(summary()), "draft");
});

test("an archived run is archived whatever it was doing when it was filed away", () => {
  assert.equal(
    conversationCatalogStatus(summary({ archived: true, running: true, workflowStatus: "error" })),
    "archived",
  );
});

test("a running run is running, because that is the live fact", () => {
  assert.equal(
    conversationCatalogStatus(summary({ running: true, workflowStatus: "completed" })),
    "running",
  );
});

test("every stored workflow status has its own catalog word", () => {
  const expected = {
    paused: "paused",
    completed: "completed",
    error: "failed",
    interrupted: "stopped",
    idle: "draft",
  };
  for (const [workflowStatus, status] of Object.entries(expected)) {
    assert.equal(conversationCatalogStatus(summary({ workflowStatus })), status, workflowStatus);
  }
});

test("a workflow status the catalog has no word for is a draft, not a guess", () => {
  assert.equal(conversationCatalogStatus(summary({ workflowStatus: "something-new" })), "draft");
});

test("the two directions are not a round trip, and are not meant to be", () => {
  // The catalog records why a run is not running; the product renders one word for every way it
  // stopped. So `interrupted` is written as `stopped` and every stopped-ish status reads back as
  // `interrupted`. Asserting the asymmetry is what stops someone "fixing" one side.
  assert.equal(conversationCatalogStatus(summary({ workflowStatus: "interrupted" })), "stopped");
  assert.equal(conversationWorkflowStatus(record({ status: "stopped" })), "interrupted");
  assert.equal(conversationWorkflowStatus(record({ status: "abandoned" })), "interrupted");
  assert.equal(conversationWorkflowStatus(record({ status: "running" })), "interrupted");
  assert.equal(conversationWorkflowStatus(record({ status: "waiting" })), "interrupted");
  assert.equal(conversationWorkflowStatus(record({ status: "archived" })), "idle");
});

test("every catalog status has its own workflow word", () => {
  const expected = {
    running: "interrupted",
    waiting: "interrupted",
    paused: "paused",
    completed: "completed",
    failed: "error",
    stopped: "interrupted",
    abandoned: "interrupted",
    draft: "idle",
    archived: "idle",
  };
  for (const [status, workflowStatus] of Object.entries(expected)) {
    assert.equal(conversationWorkflowStatus(record({ status })), workflowStatus, status);
  }
});

test("a run whose id is its own reference carries no second identity", () => {
  assert.equal(conversationSummaryToCatalog(summary(), {}).legacyConversationId, undefined);
  assert.equal(
    conversationSummaryToCatalog(summary({ id: "legacy-1" }), {}).legacyConversationId,
    "legacy-1",
  );
});

test("a pinned pipeline is a version only once a hash pins it", () => {
  assert.equal(conversationSummaryToCatalog(summary(), {}).pipelineVersion, undefined);
  assert.equal(
    conversationSummaryToCatalog(summary({ selectedPipelineHash: "abc" }), {}).pipelineVersion,
    1,
  );
});

test("the per-run records are written from what is passed, never reached for", () => {
  const written = conversationSummaryToCatalog(summary(), {
    terminalResult: { outcome: "passed" },
    latestRecheck: { at: 5 },
    runSettings: { pinned: {} },
    replaySourceSettings: { pinned: { a: 1 } },
  });
  assert.deepEqual(written.terminalResult, { outcome: "passed" });
  assert.deepEqual(written.latestRecheck, { at: 5 });
  assert.deepEqual(written.runSettings, { pinned: {} });
  assert.deepEqual(written.replaySourceSettings, { pinned: { a: 1 } });
  const bare = conversationSummaryToCatalog(summary(), {});
  assert.equal(bare.terminalResult, undefined);
  assert.equal(bare.replaySourceSettings, undefined);
});

test("a run with no participants is written with none rather than without the field", () => {
  assert.deepEqual(conversationSummaryToCatalog(summary(), {}).participants, []);
  assert.deepEqual(
    conversationSummaryToCatalog(summary({ participants: ["lead"] }), {}).participants,
    ["lead"],
  );
});

test("orchestration paths are absent when there are none, rather than undefined", () => {
  assert.equal("orchestrationPaths" in conversationSummaryToCatalog(summary(), {}), false);
  assert.deepEqual(
    conversationSummaryToCatalog(summary({ orchestrationPaths: { root: "/tmp" } }), {})
      .orchestrationPaths,
    { root: "/tmp" },
  );
});

test("a missing input is written as empty text, because the catalog stores text", () => {
  assert.equal(conversationSummaryToCatalog(summary(), {}).input, "");
  assert.equal(conversationSummaryToCatalog(summary({ input: "do it" }), {}).input, "do it");
});

test("a summary read back from a record keeps the identity the record named", () => {
  const projected = conversationSummaryFromCatalog(record({ legacyConversationId: "legacy-1" }), 5);
  assert.equal(projected.id, "legacy-1");
  assert.equal(projected.runRef, "run-1");
  assert.equal(conversationSummaryFromCatalog(record(), 5).id, "run-1");
});

test("an iteration count outside what the workspace permits is brought inside it", () => {
  assert.equal(conversationSummaryFromCatalog(record({ iterationCount: 99 }), 5).iterationCount, 5);
  assert.equal(conversationSummaryFromCatalog(record({ iterationCount: 0 }), 5).iterationCount, 1);
  assert.equal(conversationSummaryFromCatalog(record({ iterationCount: 3 }), 5).iterationCount, 3);
});

test("a restored run is never restored as running", () => {
  const projected = conversationSummaryFromCatalog(record({ status: "running" }), 5);
  assert.equal(projected.running, false);
  assert.equal(projected.waitingForResources, false);
  assert.equal(projected.workflowStatus, "interrupted");
});

test("an empty input, working root or draft is left off the summary rather than carried as empty", () => {
  const projected = conversationSummaryFromCatalog(record(), 5);
  assert.equal("input" in projected, false);
  assert.equal("workingDirectory" in projected, false);
  assert.equal("preparedDraft" in projected, false);
  assert.equal("participants" in projected, false);
});

test("a record naming no optional identity produces a summary carrying none", () => {
  // Each of these is spread in only when the record has it, so a summary must not grow a key
  // whose value is undefined: the product distinguishes "no parent" from "a parent of nothing".
  const projected = conversationSummaryFromCatalog(record(), 5);
  for (const key of [
    "selectedPipelineId",
    "selectedPipelineHash",
    "pipelineScopeRoot",
    "parentConversationId",
    "orchestrationRunId",
    "orchestrationTaskId",
    "orchestrationBranch",
    "orchestrationBaseCommit",
    "orchestrationPaths",
  ]) {
    assert.equal(key in projected, false, key);
  }
});

test("a record with no participant field at all is not a record with an empty one", () => {
  assert.equal(
    "participants" in conversationSummaryFromCatalog(record({ participants: undefined }), 5),
    false,
  );
});

test("an empty participant list is left off, and a real one is kept", () => {
  assert.equal("participants" in conversationSummaryFromCatalog(record({ participants: [] }), 5), false);
  assert.deepEqual(
    conversationSummaryFromCatalog(record({ participants: ["lead"] }), 5).participants,
    ["lead"],
  );
});

test("every optional identity a record carries survives the projection", () => {
  const projected = conversationSummaryFromCatalog(record({
    input: "do it",
    pipelineId: "review",
    pipelineHash: "abc",
    pipelineScopeRoot: "/repo",
    workingRoot: "/work",
    preparedDraft: "draft",
    parentConversationId: "parent-1",
    orchestrationRunId: "orchestration-1",
    orchestrationTaskId: "task-1",
    orchestrationBranch: "branch-1",
    orchestrationBaseCommit: "commit-1",
    orchestrationPaths: { root: "/tmp" },
  }), 5);
  assert.equal(projected.input, "do it");
  assert.equal(projected.selectedPipelineId, "review");
  assert.equal(projected.selectedPipelineHash, "abc");
  assert.equal(projected.pipelineScopeRoot, "/repo");
  assert.equal(projected.workingDirectory, "/work");
  assert.equal(projected.preparedDraft, "draft");
  assert.equal(projected.parentConversationId, "parent-1");
  assert.equal(projected.orchestrationRunId, "orchestration-1");
  assert.equal(projected.orchestrationTaskId, "task-1");
  assert.equal(projected.orchestrationBranch, "branch-1");
  assert.equal(projected.orchestrationBaseCommit, "commit-1");
  assert.deepEqual(projected.orchestrationPaths, { root: "/tmp" });
});

test("what a summary was written as is what it reads back as, for the identities that round trip", () => {
  const original = summary({
    id: "legacy-1",
    input: "do it",
    selectedPipelineId: "review",
    selectedPipelineHash: "abc",
    workingDirectory: "/work",
    archived: true,
  });
  const projected = conversationSummaryFromCatalog(
    conversationSummaryToCatalog(original, {}),
    10,
  );
  assert.equal(projected.id, "legacy-1");
  assert.equal(projected.runRef, "run-1");
  assert.equal(projected.input, "do it");
  assert.equal(projected.selectedPipelineId, "review");
  assert.equal(projected.selectedPipelineHash, "abc");
  assert.equal(projected.workingDirectory, "/work");
  assert.equal(projected.archived, true);
});
