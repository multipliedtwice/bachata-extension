/**
 * EX-3. What starting a runtime decides, apart from the reads and subscriptions that start it.
 *
 * Initialisation loads a catalog, a transcript store, an attachment store and a bridge. Between
 * those reads sat every judgement about what the persisted record still means: whether the
 * snapshot a previous session was running may be kept, which pipeline is selected when it may
 * not, whether a recoverable workflow survives, what an unfinished queue claim was, and what the
 * task is dirty because of. All of it was reachable only by constructing a runtime against a real
 * workspace, so none of it was measured.
 *
 * Nothing here reads a store or a setting. Each decision is handed what was read.
 */
export type SelectedPipelinePlan =
  | { source: "persistedSnapshot" }
  | { source: "catalog"; pipelineId: string }
  | { source: "none" };

/**
 * Whether the persisted record carries work rather than only a preference.
 *
 * A record with a dirty task, attachments, a queue, a claimed queue start, a recoverable workflow
 * or managed checkpoints describes work in progress; one without any of them describes a selection
 * and nothing else. The difference decides whether a pipeline definition that changed underneath
 * the record is allowed to replace it.
 */
export const persistedHasDurableState = (
  persisted:
    | {
        taskDirty?: boolean | undefined;
        attachments?: readonly unknown[] | undefined;
        queuedMessages?: readonly unknown[] | undefined;
        queueStart?: unknown;
        resumableWorkflow?: unknown;
        managedPairCheckpoints?: readonly unknown[] | undefined;
      }
    | undefined,
): boolean =>
  Boolean(
    persisted?.taskDirty ||
      persisted?.attachments?.length ||
      persisted?.queuedMessages?.length ||
      persisted?.queueStart ||
      persisted?.resumableWorkflow ||
      persisted?.managedPairCheckpoints?.length,
  );

/**
 * Which pipeline the runtime starts on.
 *
 * The persisted snapshot is kept when it is still the selected one and either the session carried
 * real work or the catalog still agrees with it — an interrupted run must resume against the
 * definition it started under, even after the catalog moved. Otherwise the catalog decides: the
 * persisted selection if the catalog still has it, then the default pipeline, then whatever the
 * catalog lists first. An empty catalog selects nothing, which is a refusal for the caller to
 * report rather than a pipeline to invent.
 */
export const selectedPipelinePlan = (input: {
  persistedSelectedId?: string | undefined;
  persistedSnapshotPipelineId?: string | undefined;
  hasDurableState: boolean;
  persistedSnapshotMatchesCatalog: boolean;
  catalogIds: readonly string[];
  defaultPipelineId: string;
}): SelectedPipelinePlan => {
  if (
    input.persistedSnapshotPipelineId !== undefined &&
    input.persistedSelectedId === input.persistedSnapshotPipelineId &&
    (input.hasDurableState || input.persistedSnapshotMatchesCatalog)
  ) {
    return { source: "persistedSnapshot" };
  }
  const persistedSelection =
    input.persistedSelectedId !== undefined && input.catalogIds.includes(input.persistedSelectedId)
      ? input.persistedSelectedId
      : undefined;
  const pipelineId =
    persistedSelection ??
    (input.catalogIds.includes(input.defaultPipelineId)
      ? input.defaultPipelineId
      : input.catalogIds[0]);
  return pipelineId === undefined ? { source: "none" } : { source: "catalog", pipelineId };
};

export type RecoveryStartupPlan =
  | { action: "none" }
  | { action: "discard" }
  | { action: "adoptQueued"; sourceQueueMessageId: string }
  | { action: "keep" };

/**
 * What a persisted recoverable workflow is worth at startup.
 *
 * An unusable checkpoint is discarded rather than offered: resuming it would run a pipeline the
 * catalog no longer describes, or one whose attachments are gone. A usable one that came from a
 * queued request adopts that request, so the queue does not also still hold it and run it twice.
 */
export const recoveryStartupPlan = (input: {
  hasRecovery: boolean;
  usable: boolean;
  sourceQueueMessageId?: string | undefined;
}): RecoveryStartupPlan => {
  if (!input.hasRecovery) return { action: "none" };
  if (!input.usable) return { action: "discard" };
  return input.sourceQueueMessageId === undefined
    ? { action: "keep" }
    : { action: "adoptQueued", sourceQueueMessageId: input.sourceQueueMessageId };
};

/**
 * What an unfinished queue-start claim was.
 *
 * The claim is always released — the run it claimed for is not running any more. It is worth
 * saying so only when the message it claimed is still queued: that is the case where a request was
 * taken off the queue, never durably accepted, and is about to be offered again.
 */
export const queueClaimStartupPlan = (input: {
  claimedMessageId?: string | undefined;
  queuedIds: readonly string[];
}): { release: boolean; recovered: boolean } =>
  input.claimedMessageId === undefined
    ? { release: false, recovered: false }
    : { release: true, recovered: input.queuedIds.includes(input.claimedMessageId) };

/**
 * Whether the task is dirty after a restart. Anything the previous session left behind — a
 * transcript, attachments, a queue, a recoverable workflow — makes it dirty, and a record that
 * already said so stays so.
 */
export const startupTaskDirty = (input: {
  persistedDirty: boolean;
  transcriptTotal: number;
  attachmentCount: number;
  queuedCount: number;
  hasRecovery: boolean;
}): boolean =>
  input.persistedDirty ||
  input.transcriptTotal > 0 ||
  input.attachmentCount > 0 ||
  input.queuedCount > 0 ||
  input.hasRecovery;

/**
 * The output each agent panel is restored to: the last thing that agent finished saying. An agent
 * that never answered in the loaded window shows nothing rather than the last entry of somebody
 * else's turn.
 */
export const latestAgentOutputs = (
  transcript: readonly { agentId?: string | undefined; kind: string; text: string }[],
  agentIds: readonly string[],
): Record<string, string> => {
  const latest = new Map<string, string>();
  for (const entry of transcript) {
    if (entry.agentId === undefined) continue;
    if (entry.kind !== "answer" && entry.kind !== "interrupted") continue;
    latest.set(entry.agentId, entry.text);
  }
  return Object.fromEntries(agentIds.map((agentId) => [agentId, latest.get(agentId) ?? ""]));
};
