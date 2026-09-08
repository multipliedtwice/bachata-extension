import type { RunCatalogRecord, RunCatalogStatus } from "../state/catalog";
import type { ConversationSummary } from "../webview/protocol";

/**
 * The single mapping from a persisted run to the summary the product renders. The writer and
 * a read-only secondary window both project the same catalog rows through it, so a secondary
 * window shows the writer's runs rather than a second, differently shaped view of them.
 */
export const conversationWorkflowStatus = (
  run: RunCatalogRecord,
): ConversationSummary["workflowStatus"] => {
  if (run.status === "running" || run.status === "waiting") return "interrupted";
  if (run.status === "paused") return "paused";
  if (run.status === "completed") return "completed";
  if (run.status === "failed") return "error";
  if (run.status === "stopped" || run.status === "abandoned") return "interrupted";
  return "idle";
};

export const conversationSummaryFromCatalog = (
  run: RunCatalogRecord,
  maximumPipelineIterations: number,
): ConversationSummary => ({
  id: run.legacyConversationId ?? run.runRef,
  runRef: run.runRef,
  title: run.title,
  ...(run.input ? { input: run.input } : {}),
  iterationCount: Math.max(1, Math.min(maximumPipelineIterations, run.iterationCount)),
  activeIteration: run.activeIteration,
  createdAt: run.createdAt,
  updatedAt: run.updatedAt,
  running: false,
  waitingForResources: false,
  workflowStatus: conversationWorkflowStatus(run),
  unread: run.unread,
  archived: run.archived,
  ...(run.pipelineId === undefined ? {} : { selectedPipelineId: run.pipelineId }),
  ...(run.pipelineHash === undefined ? {} : { selectedPipelineHash: run.pipelineHash }),
  ...(run.pipelineScopeRoot === undefined ? {} : { pipelineScopeRoot: run.pipelineScopeRoot }),
  ...(run.workingRoot === undefined ? {} : { workingDirectory: run.workingRoot }),
  ...(run.preparedDraft === undefined ? {} : { preparedDraft: run.preparedDraft }),
  ...(run.parentConversationId === undefined
    ? {}
    : { parentConversationId: run.parentConversationId }),
  ...(run.orchestrationRunId === undefined ? {} : { orchestrationRunId: run.orchestrationRunId }),
  ...(run.orchestrationTaskId === undefined
    ? {}
    : { orchestrationTaskId: run.orchestrationTaskId }),
  ...(run.orchestrationBranch === undefined ? {} : { orchestrationBranch: run.orchestrationBranch }),
  ...(run.orchestrationBaseCommit === undefined
    ? {}
    : { orchestrationBaseCommit: run.orchestrationBaseCommit }),
  ...(run.orchestrationPaths === undefined ? {} : { orchestrationPaths: run.orchestrationPaths }),
  ...(run.participants && run.participants.length > 0 ? { participants: run.participants } : {}),
});

/**
 * EX-AUD-12. The other direction: what a summary is worth writing back as.
 *
 * The order matters and is not the reverse of the mapping above. Archived wins over everything,
 * because a run the user filed away is filed away whatever it was doing when they did it.
 * Running wins next, because it is the live fact and the workflow status is the last thing the
 * run wrote before it started again. Only then does the stored workflow status decide, and a
 * run with none of these is a draft rather than an unknown.
 *
 * `interrupted` maps to `stopped` here while `stopped` maps back to `interrupted` above. That
 * is not a round trip and is not meant to be: the catalog records why a run is not running, and
 * the product renders one word for every way it stopped.
 */
export const conversationCatalogStatus = (
  summary: Pick<ConversationSummary, "archived" | "running" | "workflowStatus">,
): RunCatalogStatus => {
  if (summary.archived) return "archived";
  if (summary.running) return "running";
  if (summary.workflowStatus === "paused") return "paused";
  if (summary.workflowStatus === "completed") return "completed";
  if (summary.workflowStatus === "error") return "failed";
  if (summary.workflowStatus === "interrupted") return "stopped";
  return "draft";
};

/**
 * What the catalog is told about a run.
 *
 * The three per-run records the manager keeps outside the summary — the terminal result, the
 * latest recheck and the settings the run executed under — are passed in rather than reached
 * for, so this stays a projection of its arguments and the manager keeps owning where they are
 * held. A run whose id is its own runRef carries no legacy id: writing one would invent a
 * second identity for a run that only ever had one.
 */
export const conversationSummaryToCatalog = (
  summary: ConversationSummary,
  records: {
    terminalResult?: RunCatalogRecord["terminalResult"] | undefined;
    latestRecheck?: RunCatalogRecord["latestRecheck"] | undefined;
    runSettings?: RunCatalogRecord["runSettings"] | undefined;
    replaySourceSettings?: RunCatalogRecord["replaySourceSettings"] | undefined;
  },
): RunCatalogRecord => ({
  runRef: summary.runRef,
  legacyConversationId: summary.id === summary.runRef ? undefined : summary.id,
  title: summary.title,
  input: summary.input ?? "",
  pipelineId: summary.selectedPipelineId,
  // A stored hash is what makes a pinned pipeline a version rather than a name.
  pipelineVersion: summary.selectedPipelineHash ? 1 : undefined,
  pipelineHash: summary.selectedPipelineHash,
  pipelineScopeRoot: summary.pipelineScopeRoot,
  iterationCount: summary.iterationCount,
  activeIteration: summary.activeIteration,
  workingRoot: summary.workingDirectory,
  preparedDraft: summary.preparedDraft,
  terminalResult: records.terminalResult,
  latestRecheck: records.latestRecheck,
  parentConversationId: summary.parentConversationId,
  orchestrationRunId: summary.orchestrationRunId,
  orchestrationTaskId: summary.orchestrationTaskId,
  orchestrationBranch: summary.orchestrationBranch,
  orchestrationBaseCommit: summary.orchestrationBaseCommit,
  ...(summary.orchestrationPaths === undefined
    ? {}
    : { orchestrationPaths: summary.orchestrationPaths }),
  participants: summary.participants ?? [],
  runSettings: records.runSettings,
  replaySourceSettings: records.replaySourceSettings,
  status: conversationCatalogStatus(summary),
  unread: summary.unread,
  archived: summary.archived,
  createdAt: summary.createdAt,
  updatedAt: summary.updatedAt,
});
