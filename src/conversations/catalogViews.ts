import type { JsonValue } from "../adapters/types";
import {
  isValidPipelineDisplayName,
  isValidPipelineIdentifier,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_PIPELINE_STEPS,
} from "../pipeline/schema";
import type {
  InteractionSummary,
  WorkflowAttempt,
  WorkflowAttemptStep,
  WorkflowEventSummary,
} from "../webview/protocol";
import {
  MAX_EVENT_DETAIL_BYTES,
  boundedDecisionDetail,
  boundedEventDetail,
  boundedRedactedText,
  serializedJsonBytes,
} from "./eventDetail";

/**
 * EX-3. The catalog's rows as the panel sees them, apart from the catalog that stores them.
 *
 * `refreshCatalogViews` reads five catalog tables and rebuilds the panel's view of each. The reads
 * are the catalog's; the projections are not, and they carry rules a reader would not guess: an
 * event's payload travels whole only for the one event type the panel renders as a ruling and
 * bounded and redacted for every other, an
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
 * Ceilings on the controller-generated strings an event row carries outside the payload budget.
 *
 * These fields are not free-form provider output, which is why they travel when a payload does
 * not — but "not free-form" was doing more work than it could carry. Each one is read back out of a
 * persisted payload, and a title in particular is composed from provider text. So each is bounded
 * and redacted here, and its bytes are charged to the same aggregate as the detail beside it.
 */
const MAX_EVENT_TYPE_BYTES = 128;
const MAX_EVENT_STATUS_BYTES = 128;
const MAX_EVENT_TITLE_BYTES = 512;
const MAX_EVENT_TIMESTAMP_BYTES = 64;
const MAX_STEP_ID_BYTES = MAX_IDENTIFIER_LENGTH + 2;
const MAX_PIPELINE_HASH_BYTES = MAX_IDENTIFIER_LENGTH + 2;
const MAX_STEP_NAME_BYTES = MAX_DISPLAY_NAME_LENGTH + 2;

/**
 * The attempt boundary an event carries, where the recorder wrote one.
 *
 * The step list is the execution plan the panel renders progress against, so it is either right or
 * absent: a plan longer than the schema allows, or carrying an identifier or a name longer than the
 * schema allows, is refused rather than cut down into a pipeline that never ran. `steps.length` is
 * O(1), so an enormous array costs one comparison and no reads at all.
 */
const attemptFromPayload = (payload: unknown): WorkflowAttempt | undefined => {
  const pipeline = isRecord(payload) ? payload.pipeline : undefined;
  if (!isRecord(pipeline) || typeof pipeline.hash !== "string" || !Array.isArray(pipeline.steps)) {
    return undefined;
  }
  if (!/^[0-9a-f]{64}$/u.test(pipeline.hash)) return undefined;
  if (pipeline.steps.length === 0 || pipeline.steps.length > MAX_PIPELINE_STEPS) return undefined;
  const steps: WorkflowAttemptStep[] = [];
  const ids = new Set<string>();
  for (const step of pipeline.steps) {
    if (!isRecord(step)
      || !isValidPipelineIdentifier(step.id)
      || !isValidPipelineDisplayName(step.name)
      || ids.has(step.id)) return undefined;
    ids.add(step.id);
    steps.push({ id: step.id, name: step.name });
  }
  return { pipelineHash: pipeline.hash, steps };
};

/**
 * What an event row shows.
 *
 * Every event carries a bounded, redacted projection of its payload rather than the payload
 * itself — enough for a reader who opens a step's "Technical detail" or the raw event history to
 * see what was recorded, with credentials, secrets and provider session handles removed and the
 * serialized size of the projection capped. Sending nothing at all was what left both of those
 * disclosures empty for every event that was not a ruling; sending everything would put unbounded
 * free-form provider content into the webview.
 *
 * A published decision is projected too. It used to travel whole, on the grounds that the
 * controller composed it and the panel renders it as the run's conclusion — but the controller
 * composes the envelope, not the contents: the candidate, the objections, the unresolved risks and
 * each participant's validation errors are free-form provider output, and none of them had a bound.
 * It gets its own projector, which keeps the fields the ruling card reads under the same byte
 * guarantee.
 *
 * Two controller-generated fields travel on their own. The step an event belongs to is what the
 * pipeline summary is keyed on; the attempt boundary is what stops a restarted run from inheriting
 * the previous attempt's rows. Neither is read back out of the projection above, so a payload the
 * bounds happened to cut cannot take the run's progress with it.
 */
export type CatalogEventRow = {
  id: number;
  type: string;
  status?: string | undefined;
  title?: string | undefined;
  payload?: unknown;
  createdAt: string;
};

const eventMetadata = (event: CatalogEventRow): WorkflowEventSummary => {
  const stepIdSource = isRecord(event.payload) && typeof event.payload.stepId === "string"
    ? event.payload.stepId
    : undefined;
  const stepId = stepIdSource === undefined
    ? undefined
    : boundedRedactedText(stepIdSource, MAX_STEP_ID_BYTES);
  const attempt = attemptFromPayload(event.payload);
  return {
    id: event.id,
    type: boundedRedactedText(event.type, MAX_EVENT_TYPE_BYTES),
    ...(event.status === undefined
      ? {}
      : { status: boundedRedactedText(event.status, MAX_EVENT_STATUS_BYTES) }),
    ...(event.title === undefined
      ? {}
      : {
          // A title is composed around provider text often enough to get the stricter,
          // assignment-aware redaction rather than the prose one.
          title: boundedRedactedText(event.title, MAX_EVENT_TITLE_BYTES, { structured: true }),
        }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(attempt === undefined
      ? {}
      : {
          attempt: {
            pipelineHash: boundedRedactedText(attempt.pipelineHash, MAX_PIPELINE_HASH_BYTES),
            steps: attempt.steps.map((step) => ({
              id: boundedRedactedText(step.id, MAX_STEP_ID_BYTES),
              name: boundedRedactedText(step.name, MAX_STEP_NAME_BYTES),
            })),
          },
        }),
    createdAt: boundedRedactedText(event.createdAt, MAX_EVENT_TIMESTAMP_BYTES),
  };
};

/** What one row costs the whole message: its metadata, and the detail it was allowed to carry. */
const metadataBytes = (summary: WorkflowEventSummary): number => {
  const attempt = summary.attempt;
  return serializedJsonBytes({
    id: summary.id,
    type: summary.type,
    ...(summary.status === undefined ? {} : { status: summary.status }),
    ...(summary.title === undefined ? {} : { title: summary.title }),
    ...(summary.stepId === undefined ? {} : { stepId: summary.stepId }),
    ...(attempt === undefined
      ? {}
      : { attempt: { pipelineHash: attempt.pipelineHash, steps: attempt.steps.map((step) => ({ ...step })) } }),
    createdAt: summary.createdAt,
  });
};

const eventDetail = (event: CatalogEventRow, maxBytes: number): JsonValue | undefined =>
  event.type === "decision.published"
    ? boundedDecisionDetail(event.payload, maxBytes)
    : boundedEventDetail(event.payload, maxBytes);

export const catalogEventView = (event: CatalogEventRow): WorkflowEventSummary => ({
  ...eventMetadata(event),
  payload: eventDetail(event, MAX_EVENT_DETAIL_BYTES),
});

/**
 * How many bytes the whole event history may send in a single snapshot, across every conversation.
 *
 * A per-event cap bounds one row and says nothing about five hundred of them; a per-conversation
 * cap bounds one conversation's five hundred rows and says nothing about a panel holding fifty
 * conversations. `eventsByConversation` is one value in one message, so the ceiling is stated over
 * that whole value — detail, event metadata and attempt metadata together — and every conversation
 * spends from it.
 *
 * How it is spent:
 *
 *  - metadata first, because a row's type, status, title, step, attempt boundary and time are what
 *    the pipeline summary and the run's progress are read from, and a conversation whose rows were
 *    all cut renders as a run that never happened. Each conversation gets an equal share of half
 *    the ceiling and spends it newest-first, its newest ruling before that. A fixed ceiling and an
 *    unbounded number of conversations cannot both be honoured in full: as conversations multiply,
 *    each one's share shrinks to its newest rows, which are the rows status is read from;
 *  - detail second, from everything the metadata pass left, in priority order: the active
 *    conversation's newest published decision — the run's final ruling, and the one payload the
 *    panel renders outside a disclosure — then the rest of the active conversation newest-first,
 *    then every other conversation in turn. Selecting a different conversation recomputes this, so
 *    a conversation that was inactive gets the active share as soon as it is the one being read.
 */
export const EVENT_HISTORY_AGGREGATE_BYTES = 512 * 1_024;

/**
 * The fraction of the ceiling reserved for metadata, so status survives a detail-hungry run.
 *
 * Metadata is spent first and is cheap, so with a handful of conversations it never reaches this
 * share and everything it leaves goes to detail. The share only binds when conversations are many,
 * which is exactly when a row's status matters more than a row's payload.
 */
const METADATA_SHARE_NUMERATOR = 3;
const METADATA_SHARE_DENOMINATOR = 4;

/** One `,` between rows of an array. */
const ROW_SEPARATOR_BYTES = 1;

/** `,"payload":` — what attaching a detail to a row costs beyond the detail itself. */
const PAYLOAD_ENTRY_BYTES = 11;

/** `"<id>":[]` and the comma before it. */
const conversationEntryBytes = (conversationId: string): number =>
  serializedJsonBytes(conversationId) + 4;

const lastRulingIndex = (events: readonly CatalogEventRow[]): number =>
  events.reduce(
    (found, event, index) => (event.type === "decision.published" ? index : found),
    -1,
  );

/** Newest first, with the newest published ruling ahead of everything. */
const spendOrder = (
  events: readonly CatalogEventRow[],
): { index: number; event: CatalogEventRow }[] => {
  const ruling = lastRulingIndex(events);
  const newestFirst = events
    .map((_event, offset) => events.length - 1 - offset)
    .filter((index) => index !== ruling)
    .map((index) => ({ index, event: events[index] as CatalogEventRow }));
  return ruling < 0
    ? newestFirst
    : [{ index: ruling, event: events[ruling] as CatalogEventRow }, ...newestFirst];
};

export type ConversationEventHistory = {
  conversationId: string;
  events: readonly CatalogEventRow[];
};

/**
 * Every conversation's event history as one message, under one ceiling.
 *
 * The same projection serves the window that owns the workspace and the read-only window beside it;
 * neither may send more than the other.
 *
 * Conversation keys are charged and may be omitted. The renderer treats an omitted inactive key as
 * an empty history. The active key and its newest metadata are spent first, before an arbitrary
 * number of inactive empty keys can consume the whole message.
 */
const projectedHistories = (input: {
  histories: readonly ConversationEventHistory[];
  activeConversationId?: string | undefined;
  aggregateBytes?: number | undefined;
}): { conversationId: string; views: WorkflowEventSummary[] }[] => {
  const aggregate = input.aggregateBytes ?? EVENT_HISTORY_AGGREGATE_BYTES;
  if (aggregate < 2) return [];
  const prioritized: ConversationEventHistory[] = [];
  const activeIndex = input.activeConversationId === undefined
    ? -1
    : input.histories.findIndex((history) => history.conversationId === input.activeConversationId);
  if (activeIndex >= 0) prioritized.push(input.histories[activeIndex] as ConversationEventHistory);
  input.histories.forEach((history, index) => {
    if (index !== activeIndex) prioritized.push(history);
  });

  const selected: { history: ConversationEventHistory; rows: Map<number, WorkflowEventSummary> }[] = [];
  let remaining = aggregate - 2;
  const addHistory = (history: ConversationEventHistory): boolean => {
    const entryBytes = conversationEntryBytes(history.conversationId)
      - (selected.length === 0 ? 1 : 0);
    if (entryBytes > remaining) return false;
    remaining -= entryBytes;
    selected.push({ history, rows: new Map() });
    return true;
  };
  if (activeIndex >= 0) {
    addHistory(prioritized[0] as ConversationEventHistory);
  }

  const spendMetadata = (
    entries: readonly { history: ConversationEventHistory; rows: Map<number, WorkflowEventSummary> }[],
    budget: number,
  ): number => {
    let metadataRemaining = budget;
    entries.forEach(({ history, rows }) => {
      for (const { index, event } of spendOrder(history.events)) {
        const summary = eventMetadata(event);
        const bytes = metadataBytes(summary) + (rows.size === 0 ? 0 : ROW_SEPARATOR_BYTES);
        if (bytes > metadataRemaining || bytes > remaining) break;
        metadataRemaining -= bytes;
        remaining -= bytes;
        rows.set(index, summary);
      }
    });
    return metadataRemaining;
  };

  const metadataBudget = Math.floor(
    Math.max(0, remaining) * METADATA_SHARE_NUMERATOR / METADATA_SHARE_DENOMINATOR,
  );
  let metadataRemaining = activeIndex >= 0
    ? spendMetadata(selected, metadataBudget)
    : metadataBudget;

  const inactiveStart = activeIndex >= 0 ? 1 : 0;
  for (let index = inactiveStart; index < prioritized.length; index += 1) {
    addHistory(prioritized[index] as ConversationEventHistory);
  }
  const inactiveSelected = activeIndex >= 0 ? selected.slice(1) : selected;
  metadataRemaining = spendMetadata(inactiveSelected, Math.min(metadataRemaining, remaining));

  selected.forEach(({ history, rows }) => {
    for (const { index, event } of spendOrder(history.events)) {
      if (remaining <= PAYLOAD_ENTRY_BYTES) break;
      const summary = rows.get(index);
      if (summary === undefined) continue;
      // The projector is asked for at most what is left, and it guarantees its own serialized size
      // against that number, so what comes back is already affordable. Re-checking it here would be
      // a branch no input can reach; `tests/eventDetail.test.cjs` is where that guarantee is held.
      const detail = eventDetail(
        event,
        Math.min(MAX_EVENT_DETAIL_BYTES, remaining - PAYLOAD_ENTRY_BYTES),
      );
      if (detail === undefined) continue;
      remaining -= serializedJsonBytes(detail) + PAYLOAD_ENTRY_BYTES;
      rows.set(index, { ...summary, payload: detail });
    }
  });

  return selected.map(({ history, rows }) => ({
    conversationId: history.conversationId,
    views: history.events.flatMap((_event, index) => {
      const summary = rows.get(index);
      return summary === undefined ? [] : [summary];
    }),
  }));
};

export const catalogEventHistories = (input: {
  histories: readonly ConversationEventHistory[];
  activeConversationId?: string | undefined;
  aggregateBytes?: number | undefined;
}): Record<string, WorkflowEventSummary[]> =>
  Object.fromEntries(projectedHistories(input).map((entry) => [entry.conversationId, entry.views]));

/** One conversation's history, under the same whole-message ceiling. */
export const catalogEventViews = (
  events: readonly CatalogEventRow[],
  aggregateBytes = EVENT_HISTORY_AGGREGATE_BYTES,
): WorkflowEventSummary[] =>
  projectedHistories({
    histories: [{ conversationId: "", events }],
    activeConversationId: "",
    aggregateBytes,
  }).flatMap((entry) => entry.views);

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
