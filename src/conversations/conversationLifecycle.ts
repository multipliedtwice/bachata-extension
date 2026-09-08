/**
 * EX-3. What a conversation may become, and what it costs to get there.
 *
 * Archiving, deleting and resuming a run each begin with the same shape of question: may this
 * happen from the state the run is in, which run takes over when the active one goes away, and
 * what has to be undone if the change fails partway. Those judgements were spelled out three times
 * inside three long `try`/`catch` bodies that also create runs, dispose runtimes, stage storage
 * and persist — so reaching any of them meant driving a real manager to that exact partial state.
 */
export type ConversationLike = {
  id: string;
  title: string;
  archived: boolean;
  parentConversationId?: string | undefined;
};

/**
 * A run whose subtree is still working is not archived or deleted underneath itself; the refusal
 * names the run the reader has to deal with rather than the one they pressed.
 */
export const busyConversationRefusal = (
  busyTitle: string | undefined,
  action: "archive" | "delete",
): string | undefined =>
  busyTitle === undefined
    ? undefined
    : `Interrupt ${busyTitle} before ${action === "archive" ? "changing this run archive" : "deleting this run"}`;

export type ReplacementChoice =
  | { kind: "existing"; conversationId: string }
  | { kind: "create" };

/**
 * Which run the reader is left looking at when the active one is archived.
 *
 * A top-level run is preferred over a child: a child opened on its own shows a task without the
 * run it belongs to. Any unarchived run will do after that, and when the archive swallowed the
 * last one a fresh run is created — the panel always has somewhere to be.
 */
export const archiveReplacementChoice = (input: {
  candidates: readonly ConversationLike[];
  archivedIds: ReadonlySet<string>;
}): ReplacementChoice => {
  const outside = input.candidates.filter(
    (candidate) => !input.archivedIds.has(candidate.id) && !candidate.archived,
  );
  const root = outside.find((candidate) => !candidate.parentConversationId);
  const chosen = root ?? outside[0];
  return chosen ? { kind: "existing", conversationId: chosen.id } : { kind: "create" };
};

/**
 * Which run is active after a deletion.
 *
 * The reader stays where they are unless the deletion took that run, or the run they were on is
 * archived; either way they land on the first unarchived top-level run, and a tree with none left
 * gets a fresh one.
 */
export const deletionActiveChoice = (input: {
  remaining: readonly ConversationLike[];
  activeConversationId: string;
  removedIds: ReadonlySet<string>;
}): { fallback: ReplacementChoice; keepsActive: boolean } => {
  const activeSurvives =
    !input.removedIds.has(input.activeConversationId) &&
    input.remaining.some(
      (candidate) => candidate.id === input.activeConversationId && !candidate.archived,
    );
  const root = input.remaining.find(
    (candidate) => !candidate.archived && !candidate.parentConversationId,
  );
  return {
    fallback: root ? { kind: "existing", conversationId: root.id } : { kind: "create" },
    keepsActive: activeSurvives,
  };
};

/**
 * Why a run cannot be resumed.
 *
 * The order is the order a reader can act on: unarchive first, because nothing else can be judged
 * while the run is read-only; then whether there is a checkpoint at all; then whether that
 * checkpoint still describes the pipeline the runtime holds — a snapshot that moved would resume
 * the recorded prompt against a different workflow; then whether the run really has an interrupted
 * iteration to continue, rather than a checkpoint left over from one that finished.
 */
export const resumeRefusal = (input: {
  archived: boolean;
  hasRecovery: boolean;
  runtimeProvidesSnapshot: boolean;
  snapshotHash?: string | undefined;
  recoveryHash?: string | undefined;
  latestIterationStatus?: string | undefined;
}): string | undefined => {
  if (input.archived) return "Unarchive the run before resuming it";
  if (!input.hasRecovery) return "No recoverable workflow is available";
  if (
    input.runtimeProvidesSnapshot &&
    input.snapshotHash !== undefined &&
    input.snapshotHash !== input.recoveryHash
  ) {
    return "The recoverable workflow pipeline snapshot does not match";
  }
  if (input.latestIterationStatus !== "interrupted") {
    return "The recoverable workflow has no matching interrupted iteration";
  }
  return undefined;
};

/**
 * The pass a resume continues from, and how many the run is asking for. Both are clamped: a
 * recorded count above the configured ceiling would run more passes than this installation allows,
 * and a recorded position outside the run would resume a pass that does not exist.
 */
export const resumeIterationWindow = (input: {
  iterationCount: number;
  activeIteration: number;
  maximumIterations: number;
}): { requestedIterations: number; displayIndex: number } => {
  const requestedIterations = Math.max(1, Math.min(input.maximumIterations, input.iterationCount));
  return {
    requestedIterations,
    displayIndex: Math.max(1, Math.min(requestedIterations, input.activeIteration)),
  };
};

export const ARCHIVE_ROLLBACK_INCOMPLETE = "Conversation archive change failed and rollback was incomplete";
export const DELETION_ROLLBACK_INCOMPLETE = "Conversation deletion failed and rollback was incomplete";
