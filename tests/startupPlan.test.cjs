const assert = require("node:assert/strict");
const test = require("node:test");

const {
  latestAgentOutputs,
  persistedHasDurableState,
  queueClaimStartupPlan,
  recoveryStartupPlan,
  selectedPipelinePlan,
  startupTaskDirty,
} = require("../dist/runtime/startupPlan.js");

test("a record with nothing in progress carries no durable state", () => {
  assert.equal(persistedHasDurableState(undefined), false);
  assert.equal(
    persistedHasDurableState({
      taskDirty: false,
      attachments: [],
      queuedMessages: [],
      managedPairCheckpoints: [],
    }),
    false,
  );
});

test("any one sign of work in progress makes the record durable", () => {
  for (const persisted of [
    { taskDirty: true },
    { attachments: [{ id: "a" }] },
    { queuedMessages: [{ id: "q" }] },
    { queueStart: { messageId: "q", claimedAt: "now" } },
    { resumableWorkflow: { pipelineId: "review" } },
    { managedPairCheckpoints: [{ id: "c" }] },
  ]) {
    assert.equal(persistedHasDurableState(persisted), true, JSON.stringify(persisted));
  }
});

const plan = (overrides = {}) =>
  selectedPipelinePlan({
    hasDurableState: false,
    persistedSnapshotMatchesCatalog: false,
    catalogIds: ["review-only", "build"],
    defaultPipelineId: "review-only",
    ...overrides,
  });

test("an interrupted session resumes on the definition it started under", () => {
  assert.deepEqual(
    plan({
      persistedSelectedId: "build",
      persistedSnapshotPipelineId: "build",
      hasDurableState: true,
    }),
    { source: "persistedSnapshot" },
  );
});

test("a snapshot the catalog still agrees with is kept even with no work in progress", () => {
  assert.deepEqual(
    plan({
      persistedSelectedId: "build",
      persistedSnapshotPipelineId: "build",
      persistedSnapshotMatchesCatalog: true,
    }),
    { source: "persistedSnapshot" },
  );
});

test("a stale snapshot with nothing in progress gives way to the catalog", () => {
  assert.deepEqual(
    plan({ persistedSelectedId: "build", persistedSnapshotPipelineId: "build" }),
    { source: "catalog", pipelineId: "build" },
  );
});

test("a snapshot for a pipeline that is not the selected one is not kept", () => {
  assert.deepEqual(
    plan({
      persistedSelectedId: "review-only",
      persistedSnapshotPipelineId: "build",
      hasDurableState: true,
    }),
    { source: "catalog", pipelineId: "review-only" },
  );
});

test("a persisted selection the catalog dropped falls back to the default pipeline", () => {
  assert.deepEqual(plan({ persistedSelectedId: "deleted" }), {
    source: "catalog",
    pipelineId: "review-only",
  });
});

test("without the default pipeline the catalog's first entry is selected", () => {
  assert.deepEqual(plan({ catalogIds: ["build", "ship"] }), {
    source: "catalog",
    pipelineId: "build",
  });
});

test("an empty catalog selects nothing rather than inventing a pipeline", () => {
  assert.deepEqual(plan({ catalogIds: [] }), { source: "none" });
  assert.deepEqual(
    plan({ catalogIds: [], persistedSelectedId: "build", persistedSnapshotPipelineId: "build" }),
    { source: "none" },
  );
});

test("no recoverable workflow needs no decision", () => {
  assert.deepEqual(recoveryStartupPlan({ hasRecovery: false, usable: false }), { action: "none" });
});

test("an unusable checkpoint is discarded rather than offered", () => {
  assert.deepEqual(recoveryStartupPlan({ hasRecovery: true, usable: false }), {
    action: "discard",
  });
  assert.deepEqual(
    recoveryStartupPlan({ hasRecovery: true, usable: false, sourceQueueMessageId: "q-1" }),
    { action: "discard" },
  );
});

test("a usable checkpoint from the queue adopts the request so it cannot run twice", () => {
  assert.deepEqual(
    recoveryStartupPlan({ hasRecovery: true, usable: true, sourceQueueMessageId: "q-1" }),
    { action: "adoptQueued", sourceQueueMessageId: "q-1" },
  );
});

test("a usable checkpoint nobody queued is simply kept", () => {
  assert.deepEqual(recoveryStartupPlan({ hasRecovery: true, usable: true }), { action: "keep" });
});

test("no queue claim releases nothing and says nothing", () => {
  assert.deepEqual(queueClaimStartupPlan({ queuedIds: ["q-1"] }), {
    release: false,
    recovered: false,
  });
});

test("a claim on a message still queued is released and reported", () => {
  assert.deepEqual(queueClaimStartupPlan({ claimedMessageId: "q-1", queuedIds: ["q-1"] }), {
    release: true,
    recovered: true,
  });
});

test("a claim on a message that already left the queue is released quietly", () => {
  assert.deepEqual(queueClaimStartupPlan({ claimedMessageId: "q-1", queuedIds: ["q-2"] }), {
    release: true,
    recovered: false,
  });
});

test("a restart with nothing left behind starts clean", () => {
  assert.equal(
    startupTaskDirty({
      persistedDirty: false,
      transcriptTotal: 0,
      attachmentCount: 0,
      queuedCount: 0,
      hasRecovery: false,
    }),
    false,
  );
});

test("anything the previous session left behind makes the task dirty", () => {
  const clean = {
    persistedDirty: false,
    transcriptTotal: 0,
    attachmentCount: 0,
    queuedCount: 0,
    hasRecovery: false,
  };
  for (const change of [
    { persistedDirty: true },
    { transcriptTotal: 1 },
    { attachmentCount: 1 },
    { queuedCount: 1 },
    { hasRecovery: true },
  ]) {
    assert.equal(startupTaskDirty({ ...clean, ...change }), true, JSON.stringify(change));
  }
});

test("each agent is restored to the last thing it finished saying", () => {
  const transcript = [
    { agentId: "lead", kind: "answer", text: "first" },
    { kind: "status", text: "no agent" },
    { agentId: "lead", kind: "prompt", text: "not an answer" },
    { agentId: "worker", kind: "interrupted", text: "half" },
    { agentId: "lead", kind: "answer", text: "second" },
    { agentId: "lead", kind: "prompt", text: "asked again" },
    { agentId: "worker", kind: "error", text: "failed later" },
  ];
  assert.deepEqual(latestAgentOutputs(transcript, ["lead", "worker", "reviewer"]), {
    lead: "second",
    worker: "half",
    reviewer: "",
  });
});

test("an agent with no entries in the window shows nothing", () => {
  assert.deepEqual(latestAgentOutputs([], ["lead"]), { lead: "" });
});
