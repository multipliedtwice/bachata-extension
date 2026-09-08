import type { JsonValue } from "../adapters/types";
import type { InteractionSummary, WorkflowEventSummary } from "../webview/protocol";

/**
 * EX-3. The catalog's rows as the panel sees them, apart from the catalog that stores them.
 *
 * `refreshCatalogViews` reads five catalog tables and rebuilds the panel's view of each. The reads
 * are the catalog's; the projections are not, and they carry rules a reader would not guess: an
 * event's payload travels only for the one event type whose payload the panel renders, an
 * interaction's presentation is read out of a free-form context record, changed files are reported
 * for an orchestration root only when every task under it reported its own, and a decision's
 * attribution is dropped entirely when a managed task already answered for it.
 *
 * Each of those was inside a two-hundred-line closure over the manager's whole state.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export type CatalogInteractionRow = {
  interactionRef: string;
  runRef: string;
  kind: string;
  prompt: string;
  options: unknown[];
  selected: string[];
  freeText: string;
  status: InteractionSummary["status"];
  createdAt: string;
  deadlineAt?: string | undefined;
  remainingMs?: number | undefined;
  pauseReason?: string | undefined;
  context?: unknown;
};

/**
 * How an open interaction is presented. Title, free text and secrecy come from a context record
 * the requester wrote, so each is read defensively: anything but the expected shape is the
 * conservative answer — no title, no free text, and not secret only because nothing said it was.
 */
export const openInteractionView = (
  interaction: CatalogInteractionRow,
  conversationId: string,
): InteractionSummary => {
  const context = isRecord(interaction.context) ? interaction.context : {};
  return {
    interactionRef: interaction.interactionRef,
    conversationId,
    runRef: interaction.runRef,
    kind: interaction.kind,
    title: typeof context.title === "string" ? context.title : undefined,
    prompt: interaction.prompt,
    options: interaction.options,
    allowFreeText: context.allowFreeText === true,
    secret: context.secret === true,
    selected: interaction.selected,
    freeText: interaction.freeText,
    status: interaction.status,
    createdAt: interaction.createdAt,
    deadlineAt: interaction.deadlineAt,
    remainingMs: interaction.remainingMs,
    pauseReason: interaction.pauseReason,
  };
};

/**
 * What an event row shows. Only a published decision carries its payload to the panel: every other
 * event's payload is provider or verifier detail the panel does not render, and sending it would
 * put unrendered free-form content into the webview for no reader.
 */
export const catalogEventView = (event: {
  id: number;
  type: string;
  status?: string | undefined;
  title?: string | undefined;
  payload?: unknown;
  createdAt: string;
}): WorkflowEventSummary => ({
  id: event.id,
  type: event.type,
  ...(event.status === undefined ? {} : { status: event.status }),
  ...(event.title === undefined ? {} : { title: event.title }),
  payload: event.type === "decision.published" ? (event.payload as JsonValue | undefined) : undefined,
  createdAt: event.createdAt,
});

/**
 * The files a conversation changed. A managed task reports its own. An orchestration root reports
 * the union of its tasks' — but only when every one of them reported, because a union missing a
 * task's contribution would read as a complete list of what the run touched.
 */
export const changedFilesFor = (input: {
  taskChangedFiles?: readonly string[] | undefined;
  isOrchestrationRoot: boolean;
  rootTasks: readonly { changedFiles?: readonly string[] | undefined }[];
}): string[] | undefined => {
  if (input.taskChangedFiles !== undefined) return [...input.taskChangedFiles];
  if (!input.isOrchestrationRoot) return undefined;
  const reported = input.rootTasks.map((task) => task.changedFiles);
  return reported.every((files): files is readonly string[] => files !== undefined)
    ? reported.flatMap((files) => [...files])
    : undefined;
};

/**
 * The checks a conversation is judged on, most specific first: the managed task's own, then what
 * the contract verification recorded, then — for an orchestration root — every task's checks plus
 * the run's final checks.
 */
export const checksFor = <Check>(input: {
  taskChecks?: readonly Check[] | undefined;
  contractChecks?: readonly Check[] | undefined;
  isOrchestrationRoot: boolean;
  rootTasks: readonly { checks: readonly Check[] }[];
  finalChecks: readonly Check[];
}): Check[] | undefined => {
  if (input.taskChecks !== undefined) return [...input.taskChecks];
  if (input.contractChecks !== undefined) return [...input.contractChecks];
  if (!input.isOrchestrationRoot) return undefined;
  return [...input.rootTasks.flatMap((task) => [...task.checks]), ...input.finalChecks];
};

/**
 * The retained run and worktree a result points at. Only an orchestration root retains a run; a
 * task points at the worktree it worked in, and nothing else points anywhere.
 */
export const retainedRunTarget = (input: {
  isOrchestrationRoot: boolean;
  conversationRunId?: string | undefined;
  orchestrationRunId?: string | undefined;
  integrationWorktree?: string | undefined;
  retainedRunWorktree?: string | undefined;
  taskWorktreePath?: string | undefined;
}): { retainedRunId?: string | undefined; retainedWorktree?: string | undefined } =>
  input.isOrchestrationRoot
    ? {
        retainedRunId: input.conversationRunId ?? input.orchestrationRunId,
        retainedWorktree: input.integrationWorktree ?? input.retainedRunWorktree,
      }
    : { retainedRunId: undefined, retainedWorktree: input.taskWorktreePath };

/**
 * What the run concluded. A managed task's own summary wins. Otherwise the published decision's
 * candidate is used as written when it is text, and serialised when it is not — a structured
 * candidate is still the ruling, and dropping it would report a decided run as undecided.
 */
export const finalRulingFor = (input: {
  taskSummary?: string | undefined;
  decisionCandidate: unknown;
}): string | undefined => {
  if (input.taskSummary !== undefined) return input.taskSummary;
  if (typeof input.decisionCandidate === "string") return input.decisionCandidate;
  return input.decisionCandidate === undefined ? undefined : JSON.stringify(input.decisionCandidate);
};

/**
 * Who ruled, and how.
 *
 * All of it is dropped when a managed task answered for this conversation: the task's own summary
 * is the ruling then, and attributing it to whoever published a provider-side decision would name
 * the wrong author. Consensus is claimed only when a decision was actually published under a
 * unanimous provenance.
 */
export const rulingAttribution = <Provenance extends { kind: string }>(input: {
  hasTask: boolean;
  ruledBy: unknown;
  provenance: Provenance | undefined;
  decisionPublished: boolean;
}): {
  rulingBy?: string;
  rulingProvenance?: Provenance;
  consensusRuling?: true;
} => {
  if (input.hasTask) return {};
  return {
    ...(typeof input.ruledBy === "string" ? { rulingBy: input.ruledBy } : {}),
    ...(input.provenance === undefined ? {} : { rulingProvenance: input.provenance }),
    ...(input.provenance?.kind === "unanimousConsensus" && input.decisionPublished
      ? { consensusRuling: true as const }
      : {}),
  };
};

/**
 * How far back the event window is widened when the current execution's first event is not in it.
 *
 * A conversation's results are read off the events at or after the execution that produced them,
 * so a window that has not reached that execution has not seen the run. The window quadruples
 * rather than paging one row at a time, and stops at a ceiling: a run whose history is longer than
 * that is read on what the ceiling holds rather than pulling an unbounded table into memory.
 */
export const EVENT_WINDOW_START = 500;
export const EVENT_WINDOW_CEILING = 32_000;

export const nextEventWindow = (input: {
  limit: number;
  returned: number;
  reachedCutoff: boolean;
}): number | undefined =>
  input.limit < EVENT_WINDOW_CEILING && input.returned >= input.limit && !input.reachedCutoff
    ? input.limit * 4
    : undefined;
