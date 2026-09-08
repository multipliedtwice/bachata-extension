const assert = require("node:assert/strict");
const test = require("node:test");

const {
  canStartQueuedMessage,
  pipelineSnapshotHasCompleteTaskDependencies,
  queueAdmissionProblem,
  queueRemoval,
} = require("../dist/runtime/queueTransitions.js");
const {
  createPipelineExecutionSnapshot,
  createPipelineSnapshot,
} = require("../dist/pipeline/identity.js");

// EX-AUD-12. What the queue admits, may start, and lets go of. Every one of these judgements
// lived inside `createRuntime`, wrapped in the transaction that writes the queue, so a refusal
// could only be reached by driving a whole runtime over a whole persisted state.

const definition = (id = "queued-pipeline", steps = []) => ({
  version: 1,
  id,
  name: "Queued pipeline",
  agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
  roles: [],
  steps: steps.length > 0 ? steps : [{
    id: "step-0",
    name: "Step 0",
    enabled: true,
    participants: ["codex"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    humanGate: "none",
    type: "agent",
  }],
});

const checklistStep = (id, pipelineId, enabled = true) => ({
  id,
  name: id,
  enabled,
  participants: [],
  promptTemplate: "",
  parallel: false,
  consensus: false,
  humanGate: "none",
  type: "executeChecklist",
  pipelineId,
});

// --- dependency completeness -------------------------------------------------------------

test("a snapshot with no task steps carries no dependency bundle at all", () => {
  const plain = createPipelineSnapshot(definition(), "builtin");
  assert.equal(pipelineSnapshotHasCompleteTaskDependencies(plain), true);
  // A bundle nothing in the snapshot needs describes a run this snapshot does not perform.
  assert.equal(
    pipelineSnapshotHasCompleteTaskDependencies({ ...plain, dependencies: {} , bundleHash: "abc" }),
    false,
  );
  assert.equal(pipelineSnapshotHasCompleteTaskDependencies({ ...plain, bundleHash: "abc" }), false);
});

test("a snapshot whose task steps have no dependency bundle is incomplete", () => {
  const withTask = createPipelineSnapshot(
    definition("parent", [checklistStep("run-child", "child")]),
    "builtin",
  );
  assert.equal(pipelineSnapshotHasCompleteTaskDependencies(withTask), false);
  assert.equal(
    pipelineSnapshotHasCompleteTaskDependencies({ ...withTask, dependencies: {} }),
    false,
  );
});

test("a dependency bundle has to name exactly the pipelines the enabled task steps run", () => {
  const child = createPipelineSnapshot(definition("child"), "builtin");
  const parent = createPipelineSnapshot(
    definition("parent", [checklistStep("run-child", "child")]),
    "builtin",
  );
  const exact = createPipelineExecutionSnapshot(parent, { child });
  assert.equal(pipelineSnapshotHasCompleteTaskDependencies(exact), true);

  const extra = createPipelineExecutionSnapshot(parent, { child, other: child });
  assert.equal(pipelineSnapshotHasCompleteTaskDependencies(extra), false);

  const wrong = createPipelineExecutionSnapshot(parent, { other: child });
  assert.equal(pipelineSnapshotHasCompleteTaskDependencies(wrong), false);
});

test("a disabled task step needs nothing, because it will not run", () => {
  const parent = createPipelineSnapshot(
    definition("parent", [checklistStep("run-child", "child", false)]),
    "builtin",
  );
  assert.equal(pipelineSnapshotHasCompleteTaskDependencies(parent), true);
});

test("two task steps naming one pipeline need it once, not twice", () => {
  const child = createPipelineSnapshot(definition("child"), "builtin");
  const parent = createPipelineSnapshot(
    definition("parent", [checklistStep("a", "child"), checklistStep("b", "child")]),
    "builtin",
  );
  assert.equal(
    pipelineSnapshotHasCompleteTaskDependencies(createPipelineExecutionSnapshot(parent, { child })),
    true,
  );
});

// --- admission ---------------------------------------------------------------------------

const selected = createPipelineSnapshot(definition(), "builtin");

const admission = (overrides = {}) => queueAdmissionProblem({
  maximum: 50,
  queuedCount: 0,
  attachmentIds: [],
  availableAttachmentIds: new Set(),
  kind: "direct",
  recipients: ["codex"],
  knownAgentIds: new Set(["codex"]),
  ...overrides,
});

test("a message that fits is admitted with nothing said about it", () => {
  assert.equal(admission(), undefined);
  assert.equal(
    admission({ kind: "pipeline", pipelineId: "queued-pipeline", pipelineSnapshot: selected, selectedPipelineSnapshot: selected }),
    undefined,
  );
});

test("a full queue is refused by its own limit, before anything else is looked at", () => {
  assert.equal(
    admission({ maximum: 2, queuedCount: 2, recipients: ["nobody"], knownAgentIds: new Set() }),
    "Queued message limit is 2",
  );
  assert.equal(admission({ maximum: 2, queuedCount: 1 }), undefined);
});

test("an attachment the workspace no longer holds is named", () => {
  assert.equal(
    admission({ attachmentIds: ["gone"], availableAttachmentIds: new Set(["kept"]) }),
    "Unknown attachment: gone",
  );
  assert.equal(
    admission({ attachmentIds: ["kept"], availableAttachmentIds: new Set(["kept"]) }),
    undefined,
  );
});

test("a recipient that is not a configured agent is named", () => {
  assert.equal(
    admission({ recipients: ["codex", "ghost"], knownAgentIds: new Set(["codex"]) }),
    "Unknown agent: ghost",
  );
});

test("every way a queued pipeline snapshot can fail to be the selected one is refused", () => {
  const other = createPipelineSnapshot(definition("other"), "builtin");
  const cases = [
    { pipelineId: undefined, pipelineSnapshot: selected },
    { pipelineId: "queued-pipeline", pipelineSnapshot: undefined },
    { pipelineId: "another-id", pipelineSnapshot: selected },
    { pipelineId: "queued-pipeline", pipelineSnapshot: { ...selected, hash: "tampered" } },
    { pipelineId: "queued-pipeline", pipelineSnapshot: { ...selected, bundleHash: "unneeded" } },
    { pipelineId: "other", pipelineSnapshot: other },
  ];
  for (const [index, overrides] of cases.entries()) {
    assert.equal(
      admission({ kind: "pipeline", selectedPipelineSnapshot: selected, ...overrides }),
      "The selected pipeline snapshot cannot be queued",
      `case ${String(index)}`,
    );
  }
  // A pipeline request never checks recipients: a pipeline names its own participants.
  assert.equal(
    admission({
      kind: "pipeline",
      pipelineId: "queued-pipeline",
      pipelineSnapshot: selected,
      selectedPipelineSnapshot: selected,
      recipients: ["ghost"],
      knownAgentIds: new Set(),
    }),
    undefined,
  );
});

// --- starting ----------------------------------------------------------------------------

const start = (overrides = {}) => canStartQueuedMessage({
  kind: "direct",
  disposed: false,
  mutationActive: false,
  checkingAvailability: false,
  pickingWorkingDirectory: false,
  gateDecisionActive: false,
  claimHeld: false,
  anyAgentRunning: false,
  foregroundOperations: 0,
  activeForegroundOperations: 0,
  pipelineOperationActive: false,
  workflowStatus: "idle",
  resumableWorkflow: false,
  ...overrides,
});

test("an idle runtime starts the next queued message", () => {
  assert.equal(start(), true);
  assert.equal(start({ kind: "pipeline" }), true);
});

test("every reason the runtime is busy stops the queue by itself", () => {
  for (const reason of [
    "disposed",
    "mutationActive",
    "checkingAvailability",
    "pickingWorkingDirectory",
    "gateDecisionActive",
    "claimHeld",
    "anyAgentRunning",
  ]) {
    assert.equal(start({ [reason]: true }), false, reason);
  }
  assert.equal(start({ foregroundOperations: 1 }), false);
});

test("a foreground operation that is not the pipeline's own stops the queue", () => {
  // The running pipeline accounts for one of them; a second belongs to something else.
  assert.equal(start({ pipelineOperationActive: true, activeForegroundOperations: 2 }), false);
  assert.equal(start({ activeForegroundOperations: 1 }), false);
});

test("while a pipeline runs, only a direct message to a paused workflow may start", () => {
  const running = { pipelineOperationActive: true, activeForegroundOperations: 1 };
  assert.equal(start({ ...running, kind: "direct", workflowStatus: "paused" }), true);
  assert.equal(start({ ...running, kind: "direct", workflowStatus: "running" }), false);
  assert.equal(start({ ...running, kind: "pipeline", workflowStatus: "paused" }), false);
});

test("unresolved recovery work stops the queue until a person decides about it", () => {
  assert.equal(start({ resumableWorkflow: true }), false);
  // Except while a pipeline is running and the workflow is paused: that path never reads it.
  assert.equal(
    start({
      resumableWorkflow: true,
      pipelineOperationActive: true,
      activeForegroundOperations: 1,
      workflowStatus: "paused",
    }),
    true,
  );
});

// --- removal -----------------------------------------------------------------------------

const removal = (overrides = {}) => queueRemoval({
  kind: "completion",
  messageId: "message-1",
  present: true,
  remainingCount: 0,
  claimedMessageId: "message-1",
  queuePaused: false,
  queueDraining: false,
  ...overrides,
});

test("only the execution that claimed a message may complete it", () => {
  assert.deepEqual(removal(), {
    commit: true,
    announce: true,
    queuePaused: false,
    clearClaim: true,
  });
  assert.equal(removal({ claimedMessageId: "another" }).commit, false);
  assert.equal(removal({ claimedMessageId: undefined }).commit, false);
  assert.equal(removal({ present: false }).commit, false);
  // Completing does not change whether the queue is paused; it releases the claim.
  assert.equal(removal({ queuePaused: true }).queuePaused, true);
});

test("a message an execution is actively running cannot be cancelled out from under it", () => {
  const cancel = (overrides) => removal({ kind: "cancellation", ...overrides });
  assert.equal(cancel({ queuePaused: false }).commit, false);
  assert.equal(cancel({ queuePaused: true, queueDraining: true }).commit, false);
  // Paused and not draining: the claim is held but nothing is running against it.
  assert.deepEqual(cancel({ queuePaused: true }), {
    commit: true,
    announce: true,
    queuePaused: true,
    clearClaim: true,
  });
  // A message no execution claimed is cancellable, and the claim someone else holds stays.
  assert.deepEqual(cancel({ claimedMessageId: "another" }), {
    commit: true,
    announce: true,
    queuePaused: false,
    clearClaim: false,
  });
  assert.equal(cancel({ present: false, claimedMessageId: "another" }).commit, false);
});

test("supersession releases the claim even when the message is already gone", () => {
  const supersede = (overrides) => removal({ kind: "supersession", ...overrides });
  assert.deepEqual(supersede(), {
    commit: true,
    announce: true,
    queuePaused: true,
    clearClaim: true,
  });
  // Nothing left to remove, but the claim still names it: commit, and announce nothing.
  assert.deepEqual(supersede({ present: false }), {
    commit: true,
    announce: false,
    queuePaused: true,
    clearClaim: true,
  });
  assert.equal(supersede({ present: false, claimedMessageId: "another" }).commit, false);
  // An interrupted run leaves the queue paused rather than starting the next message.
  assert.equal(supersede({ claimedMessageId: "another", queuePaused: false }).queuePaused, true);
});

test("adopting a message as recovery work pauses the queue only if anything is left in it", () => {
  const adopt = (overrides) => removal({ kind: "recoveryAdoption", ...overrides });
  assert.deepEqual(adopt({ remainingCount: 0 }), {
    commit: true,
    announce: true,
    queuePaused: false,
    clearClaim: true,
  });
  assert.equal(adopt({ remainingCount: 2 }).queuePaused, true);
  assert.equal(adopt({ present: false }).commit, false);
  // The claim is released whoever held it: the message is no longer the queue's to run.
  assert.equal(adopt({ claimedMessageId: "another" }).clearClaim, true);
});

// EX-3. What the drain loop decides before running a request, and what a failed one owes.
const {
  QUEUE_FAILURE_MESSAGES,
  queueDrainStep,
  queueFailureJoined,
  queueFailureReconciliation,
  queueFailureRecord,
} = require("../dist/runtime/queueTransitions.js");

test("an unverifiable legacy request pauses the queue and says why", () => {
  assert.deepEqual(queueDrainStep({ blockedReason: "legacy shape", canStart: true, recoveryIdle: false }), {
    action: "pause",
    reason: "an unverifiable legacy queued request",
    clearStart: false,
    log: "legacy shape",
  });
});

test("a request that cannot start pauses the queue only when an idle recoverable workflow blocks it", () => {
  assert.deepEqual(queueDrainStep({ canStart: false, recoveryIdle: true }), {
    action: "pause",
    reason: "recoverable workflow blocking queued work",
    clearStart: false,
  });
  assert.deepEqual(queueDrainStep({ canStart: false, recoveryIdle: false }), { action: "stop" });
  assert.deepEqual(queueDrainStep({ canStart: true, recoveryIdle: true }), { action: "run" });
});

test("a second failure joins the first under the step that produced it", () => {
  const first = new Error("run failed");
  assert.equal(queueFailureJoined(first, undefined, QUEUE_FAILURE_MESSAGES.recovery), first);
  const joined = queueFailureJoined(first, new Error("recovery refused"), QUEUE_FAILURE_MESSAGES.recovery);
  assert.ok(joined instanceof AggregateError);
  assert.equal(joined.message, "Queued execution failed and its recovery could not be reconciled");
  assert.deepEqual(joined.errors.map((error) => error.message), ["run failed", "recovery refused"]);
  assert.equal(QUEUE_FAILURE_MESSAGES.finalization, "Queued execution finished, but its completion could not be persisted");
});

test("an accepted, unfinalised request whose recovery was not adopted still owes a completion and keeps its claim", () => {
  assert.deepEqual(queueFailureReconciliation({ accepted: true, completionFinalized: false, recoveryAdopted: false }), {
    finalizeNow: true,
    retainStartClaim: true,
  });
  for (const settled of [
    { accepted: false, completionFinalized: false, recoveryAdopted: false },
    { accepted: true, completionFinalized: true, recoveryAdopted: false },
    { accepted: true, completionFinalized: false, recoveryAdopted: true },
  ]) {
    assert.deepEqual(queueFailureReconciliation(settled), { finalizeNow: false, retainStartClaim: false }, JSON.stringify(settled));
  }
});

test("the ledger records the failure's message and how far the request got", () => {
  assert.deepEqual(
    queueFailureRecord({ messageId: "q-1", failure: new Error("boom"), accepted: true, completionFinalized: false, recoveryAdopted: false }),
    { text: "boom", payload: { messageId: "q-1", accepted: true, completionFinalized: false, recoveryAdopted: false } },
  );
  assert.equal(queueFailureRecord({ messageId: "q-2", failure: "text", accepted: false, completionFinalized: false, recoveryAdopted: false }).text, "text");
});
