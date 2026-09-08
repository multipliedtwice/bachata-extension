import { pipelineDefinitionHash, pipelineSnapshotRootsEqual } from "../pipeline/identity";
import type { PipelineSnapshot } from "../pipeline/identity";

/**
 * EX-AUD-12. What the message queue admits, what it may start, and what leaves it.
 *
 * These decisions sat inside `createRuntime`, interleaved with the transaction that writes the
 * queue and the transcript entry that announces the change, so the only way to reach a refusal
 * was to drive a whole runtime. Nothing here touches state, storage or the transcript: the
 * runtime still holds the lock, writes the queue and appends the entry. What it no longer holds
 * is the rule.
 */

/**
 * Whether a queued pipeline snapshot carries exactly the dependency bundle its own steps need.
 *
 * A snapshot with a `executeChecklist` step depends on that step's pipeline, and a snapshot
 * that names dependencies it does not use — or omits one it does — describes a different run
 * from the one that would execute.
 */
export const pipelineSnapshotHasCompleteTaskDependencies = (
  snapshot: PipelineSnapshot,
): boolean => {
  const expected = Array.from(new Set(
    snapshot.definition.steps.flatMap((step) =>
      step.enabled && step.type === "executeChecklist" ? [step.pipelineId] : [],
    ),
  )).sort();
  if (expected.length === 0) {
    return !snapshot.dependencies && !snapshot.bundleHash;
  }
  if (!snapshot.dependencies || !snapshot.bundleHash) {
    return false;
  }
  const provided = Object.keys(snapshot.dependencies).sort();
  return provided.length === expected.length &&
    provided.every((id, index) => id === expected[index]);
};

export type QueueAdmissionInput = {
  /** The configured ceiling, already clamped to at least one by the caller. */
  maximum: number;
  queuedCount: number;
  attachmentIds: readonly string[];
  availableAttachmentIds: ReadonlySet<string>;
  kind: "pipeline" | "direct";
  pipelineId?: string | undefined;
  pipelineSnapshot?: PipelineSnapshot | undefined;
  /** The snapshot currently selected, which a queued pipeline request must still match. */
  selectedPipelineSnapshot?: PipelineSnapshot | undefined;
  recipients: readonly string[];
  knownAgentIds: ReadonlySet<string>;
};

/**
 * Why this message may not join the queue, or nothing.
 *
 * The order is deliberate and is the order a person would want to hear about it: a full queue
 * first, because nothing else matters if there is no room; then an attachment that no longer
 * exists, because that is the request describing something the workspace does not have; then
 * the request's own identity — a pipeline snapshot that is not the selected one, or a recipient
 * that is not a configured agent.
 */
export const queueAdmissionProblem = (
  input: QueueAdmissionInput,
): string | undefined => {
  if (input.queuedCount >= input.maximum) {
    return `Queued message limit is ${String(input.maximum)}`;
  }
  const missingAttachment = input.attachmentIds.find(
    (attachmentId) => !input.availableAttachmentIds.has(attachmentId),
  );
  if (missingAttachment) {
    return `Unknown attachment: ${missingAttachment}`;
  }
  if (input.kind === "pipeline") {
    const snapshot = input.pipelineSnapshot;
    if (
      !input.pipelineId ||
      !snapshot ||
      snapshot.definition.id !== input.pipelineId ||
      pipelineDefinitionHash(snapshot.definition) !== snapshot.hash ||
      !pipelineSnapshotHasCompleteTaskDependencies(snapshot) ||
      !pipelineSnapshotRootsEqual(input.selectedPipelineSnapshot, snapshot)
    ) {
      return "The selected pipeline snapshot cannot be queued";
    }
    return undefined;
  }
  const unknownAgent = input.recipients.find((agentId) => !input.knownAgentIds.has(agentId));
  return unknownAgent === undefined ? undefined : `Unknown agent: ${unknownAgent}`;
};

export type QueueStartInput = {
  kind: "pipeline" | "direct";
  disposed: boolean;
  mutationActive: boolean;
  checkingAvailability: boolean;
  pickingWorkingDirectory: boolean;
  gateDecisionActive: boolean;
  /** Another queued message already holds the start claim. */
  claimHeld: boolean;
  anyAgentRunning: boolean;
  foregroundOperations: number;
  activeForegroundOperations: number;
  /** A pipeline run is in flight, whichever of its three markers says so. */
  pipelineOperationActive: boolean;
  workflowStatus: string;
  /** Recovery work is waiting to be adopted or discarded. */
  resumableWorkflow: boolean;
};

/**
 * Whether the runtime is free to start this queued message now.
 *
 * The exception in the middle is the whole point: while a pipeline is running, one kind of
 * queued message may still start — a direct message to an agent, and only while the workflow is
 * paused, because that is a person stepping in rather than two runs racing. Everything else
 * waits, and nothing starts at all while recovery work is unresolved: adopting or discarding it
 * is a decision that belongs to the person, not to whatever the queue would have started next.
 */
export const canStartQueuedMessage = (input: QueueStartInput): boolean => {
  if (
    input.disposed ||
    input.mutationActive ||
    input.checkingAvailability ||
    input.pickingWorkingDirectory ||
    input.gateDecisionActive ||
    input.claimHeld ||
    input.anyAgentRunning ||
    input.foregroundOperations > 0
  ) {
    return false;
  }
  const unrelatedForegroundOperations =
    input.activeForegroundOperations - (input.pipelineOperationActive ? 1 : 0);
  if (unrelatedForegroundOperations > 0) {
    return false;
  }
  if (input.pipelineOperationActive) {
    return input.kind === "direct" && input.workflowStatus === "paused";
  }
  return !input.resumableWorkflow;
};

export type QueueRemovalKind =
  | "completion"
  | "cancellation"
  | "supersession"
  | "recoveryAdoption";

export type QueueRemovalInput = {
  kind: QueueRemovalKind;
  messageId: string;
  /** Whether the message is still in the queue. */
  present: boolean;
  /** How many messages remain once this one is gone. */
  remainingCount: number;
  /** The message id the current start claim names, if there is a claim. */
  claimedMessageId?: string | undefined;
  queuePaused: boolean;
  queueDraining: boolean;
};

export type QueueRemovalOutcome = {
  /** Whether the queue state is written at all. */
  commit: boolean;
  /** Whether the removal is announced on the transcript and reported to the caller. */
  announce: boolean;
  queuePaused: boolean;
  /** Whether the start claim is released as part of this transition. */
  clearClaim: boolean;
};

const refused: QueueRemovalOutcome = {
  commit: false,
  announce: false,
  queuePaused: false,
  clearClaim: false,
};

/**
 * What one message leaving the queue does to the rest of it.
 *
 * The four ways a message leaves are not the same transition, and the differences are the
 * reason this is one function rather than four copies of a filter:
 *
 * - `completion`: the execution that claimed this message finished it. Only the claim holder
 *   may complete, so a message completed by anything else is refused rather than silently
 *   removed.
 * - `cancellation`: a person removed it. A message an execution is actively running cannot be
 *   cancelled this way — "actively" meaning the queue is not paused, or is draining — because
 *   removing it would leave the run with nothing to report against.
 * - `supersession`: an interrupted run's message is discarded. It commits even when the message
 *   is already gone, so long as the claim still names it, because the claim itself is what has
 *   to be released; with nothing left to remove there is nothing to announce. The queue is
 *   paused afterwards: something was interrupted, and the next message should not start on its
 *   own.
 * - `recoveryAdoption`: the message became recoverable work. The queue pauses only if anything
 *   is still in it, so an emptied queue does not come back paused for no reason.
 */
export const queueRemoval = (input: QueueRemovalInput): QueueRemovalOutcome => {
  const claimsThisMessage = input.claimedMessageId === input.messageId;
  if (input.kind === "completion") {
    return input.present && claimsThisMessage
      ? { commit: true, announce: true, queuePaused: input.queuePaused, clearClaim: true }
      : refused;
  }
  if (input.kind === "cancellation") {
    const claimedByActiveExecution =
      claimsThisMessage && (!input.queuePaused || input.queueDraining);
    return input.present && !claimedByActiveExecution
      ? {
          commit: true,
          announce: true,
          queuePaused: input.queuePaused,
          clearClaim: claimsThisMessage,
        }
      : refused;
  }
  if (input.kind === "supersession") {
    return input.present || claimsThisMessage
      ? {
          commit: true,
          announce: input.present,
          queuePaused: true,
          clearClaim: claimsThisMessage,
        }
      : refused;
  }
  return input.present
    ? {
        commit: true,
        announce: true,
        queuePaused: input.remainingCount > 0,
        clearClaim: true,
      }
    : refused;
};

/**
 * EX-3. What the drain loop decides before it runs a queued request, and what a failed one owes.
 *
 * The loop's own judgements — a request that cannot be verified pauses the queue and says why, a
 * request that cannot start yet pauses it only when an idle recoverable workflow is what blocks it,
 * and a failure keeps or releases the start claim depending on how far the request got — lived
 * between the claim, the execution and the transcript write. They are decided here; the claim,
 * the run and the write stay in the loop.
 */
export type QueueDrainStep =
  | { action: "run" }
  | { action: "stop" }
  | { action: "pause"; reason: string; clearStart: boolean; log?: string };

export const queueDrainStep = (input: {
  blockedReason?: string | undefined;
  canStart: boolean;
  recoveryIdle: boolean;
}): QueueDrainStep => {
  if (input.blockedReason) {
    return {
      action: "pause",
      reason: "an unverifiable legacy queued request",
      clearStart: false,
      log: input.blockedReason,
    };
  }
  if (!input.canStart) {
    return input.recoveryIdle
      ? { action: "pause", reason: "recoverable workflow blocking queued work", clearStart: false }
      : { action: "stop" };
  }
  return { action: "run" };
};

export const QUEUE_FAILURE_MESSAGES = {
  recovery: "Queued execution failed and its recovery could not be reconciled",
  finalization: "Queued execution finished, but its completion could not be persisted",
} as const;

/** The failure so far, joined with a second one when the recovery step itself failed. */
export const queueFailureJoined = (
  failure: unknown,
  secondary: unknown,
  message: string,
): unknown =>
  secondary === undefined ? failure : new AggregateError([failure, secondary], message);

/**
 * After a failed request: a request that was accepted but never finalised, and whose recovery
 * was not adopted, still owes a completion record — and while that record is missing the start
 * claim is kept, so a restart offers the request again rather than running it twice.
 */
export const queueFailureReconciliation = (input: {
  accepted: boolean;
  completionFinalized: boolean;
  recoveryAdopted: boolean;
}): { finalizeNow: boolean; retainStartClaim: boolean } => {
  const unsettled = input.accepted && !input.recoveryAdopted && !input.completionFinalized;
  return { finalizeNow: unsettled, retainStartClaim: unsettled };
};

/** What the ledger records for a queued failure: the message, and how far the request got. */
export const queueFailureRecord = (input: {
  messageId: string;
  failure: unknown;
  accepted: boolean;
  completionFinalized: boolean;
  recoveryAdopted: boolean;
}): {
  text: string;
  payload: { messageId: string; accepted: boolean; completionFinalized: boolean; recoveryAdopted: boolean };
} => ({
  text: input.failure instanceof Error ? input.failure.message : String(input.failure),
  payload: {
    messageId: input.messageId,
    accepted: input.accepted,
    completionFinalized: input.completionFinalized,
    recoveryAdopted: input.recoveryAdopted,
  },
});
