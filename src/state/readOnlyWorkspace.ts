/**
 * Read-only secondary-window mode.
 *
 * Exactly one window owns workspace state. A window that did not win ownership still shows
 * the product — Direction, semantic history, runs, results, retained work, ownership — but
 * every mutation refuses at this boundary, not merely in the UI. Nothing here fabricates a
 * fencing token, and nothing here writes: viewing state never changes it.
 */

export type OwnershipView = {
  owned: false;
  reason: string;
  holderDescription?: string;
  holderLastSeenSecondsAgo?: number;
  retryCommand: string;
};

export const MUTATION_CLASSES = [
  "runConversation",
  "createConversation",
  "archiveConversation",
  "deleteConversation",
  "applyRetainedWork",
  "recheckVerification",
  "resolveRecord",
  "defineInitiative",
  "setDirection",
  "startCycle",
  "closeCycle",
  "mergeFindings",
  "startScopedFix",
  "pipelineSave",
  "pipelineDelete",
  "pipelineImport",
  "orchestrationStart",
  "orchestrationResume",
  "orchestrationStop",
  "providerExecution",
  "browserBridgeStart",
] as const;

export type MutationClass = (typeof MUTATION_CLASSES)[number];

export type ReadOnlyRefusal = {
  refused: true;
  mutation: MutationClass;
  message: string;
};

const ownershipSentence = (ownership: OwnershipView): string => {
  const holder = ownership.holderDescription === undefined
    ? "Another Bachata window"
    : `The Bachata window running ${ownership.holderDescription}`;
  const seen = ownership.holderLastSeenSecondsAgo === undefined
    ? ""
    : ` It was active ${String(ownership.holderLastSeenSecondsAgo)}s ago.`;
  return `${holder} owns this repository's state.${seen}`;
};

/**
 * The single refusal every mutation goes through in a secondary window. It names what was
 * attempted, who holds the repository, and how to take ownership, so a refusal is actionable
 * rather than an error.
 */
export const refuseMutation = (
  mutation: MutationClass,
  ownership: OwnershipView,
): ReadOnlyRefusal => ({
  refused: true,
  mutation,
  message: [
    `Bachata refused ${mutation}: this window is read-only.`,
    ownershipSentence(ownership),
    `Close that window or reload this one, then run ${ownership.retryCommand} to take ownership.`,
  ].join(" "),
});

export const isReadOnlyRefusal = (value: unknown): value is ReadOnlyRefusal =>
  typeof value === "object" && value !== null &&
  (value as { refused?: unknown }).refused === true &&
  typeof (value as { mutation?: unknown }).mutation === "string";

const COMMAND_MUTATIONS: Record<string, MutationClass> = {
  "bachata.setup": "createConversation",
  "bachata.reviewFile": "createConversation",
  "bachata.reviewSelection": "createConversation",
  "bachata.reviewStagedDiff": "createConversation",
  "bachata.reviewUncommitted": "createConversation",
  "bachata.reviewBranch": "createConversation",
  "bachata.reviewCommit": "createConversation",
  "bachata.reviewCommitRange": "createConversation",
  "bachata.fixDiagnostic": "createConversation",
  "bachata.publishFindings": "resolveRecord",
  "bachata.recordExternalEvidence": "resolveRecord",
  "bachata.replayRun": "runConversation",
  "bachata.verifiers": "pipelineSave",
  "bachata.bootstrapConfiguration": "pipelineSave",
  "bachata.improve": "orchestrationStart",
  "bachata.todo.start": "orchestrationStart",
  "bachata.todo.resume": "orchestrationResume",
  "bachata.todo.stop": "orchestrationStop",
  "bachata.todo.abandon": "orchestrationStop",
  "bachata.todo.status": "orchestrationStart",
  "bachata.todo.preview": "orchestrationStart",
  "bachata.remediate": "providerExecution",
};

export const mutationClassForCommand = (command: string): MutationClass =>
  COMMAND_MUTATIONS[command] ?? "providerExecution";

// The webview speaks its own message names. A read-only window maps each state-changing one
// onto the same mutation classes the commands use, so one refusal boundary covers both.
const MESSAGE_MUTATIONS: Record<string, MutationClass> = {
  "conversation.create": "createConversation",
  "conversation.duplicate": "createConversation",
  "conversation.archive": "archiveConversation",
  "conversation.close": "deleteConversation",
  "conversation.rename": "createConversation",
  "conversation.saveDraft": "createConversation",
  "conversation.consumePreparedDraft": "createConversation",
  "conversation.exportBundle": "resolveRecord",
  "conversation.publishFindings": "resolveRecord",
  "initiative.define": "defineInitiative",
  "initiative.create": "defineInitiative",
  "initiative.setDirection": "setDirection",
  "initiative.switch": "setDirection",
  "initiative.setStatus": "setDirection",
  "initiative.import": "defineInitiative",
  "initiative.export": "resolveRecord",
  "cycle.start": "startCycle",
  "cycle.close": "closeCycle",
  "cycle.rebaseline": "startCycle",
  "review.startFresh": "startCycle",
  "resolution.apply": "resolveRecord",
  "finding.merge": "mergeFindings",
  "finding.unmerge": "mergeFindings",
  "finding.startFix": "startScopedFix",
  "direction.runNextAction": "runConversation",
  "notifications.setMode": "resolveRecord",
  "notifications.markAllRead": "resolveRecord",
  "notifications.clear": "resolveRecord",
  "orchestration.start": "orchestrationStart",
  "orchestration.resume": "orchestrationResume",
  "orchestration.stop": "orchestrationStop",
  "orchestration.abandon": "orchestrationStop",
  "orchestration.cleanup": "orchestrationStop",
  "orchestration.patch": "applyRetainedWork",
  "orchestration.apply": "applyRetainedWork",
  "orchestration.recheck": "recheckVerification",
  "interaction.submit": "resolveRecord",
  "interaction.update": "resolveRecord",
  "interaction.pause": "resolveRecord",
  "interaction.resume": "resolveRecord",
  "readiness.remediate": "providerExecution",
  "recovery.doctor": "providerExecution",
  "recovery.setup": "providerExecution",
  "conversation.runtime": "providerExecution",
};

export const mutationClassForProtocolMessage = (type: string): MutationClass =>
  MESSAGE_MUTATIONS[type] ?? "providerExecution";
