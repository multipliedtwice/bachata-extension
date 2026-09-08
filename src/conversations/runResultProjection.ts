import {
  RunRecheckRecord,
  VerificationProvenance,
  VerificationResult,
} from "../results/projectResult";

/**
 * A catalog event, reduced to what a projection reads from it. Events arrive in id order and ids
 * are monotonic per run, so an id comparison is what "since the current execution" means.
 */
export type ProjectionEvent = {
  id: number;
  type: string;
  payload?: unknown;
  createdAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The event id the current execution began at. Everything at or before it belongs to a previous
 * execution of the same run: a decision, a verification or a validated output from an earlier
 * attempt describes a candidate that no longer exists, and projecting it would present a stale
 * ruling as this run's. A run with no execution yet has no cut-off, and `E0` reads as zero.
 */
export const executionEventCutoff = (latestExecutionRef: string | undefined): number =>
  Number((latestExecutionRef ?? "E0").slice(1));

/** The last event of a type belonging to the current execution, if the current execution has one. */
export const latestCurrentEvent = (
  events: readonly ProjectionEvent[],
  type: string,
  cutoff: number,
): ProjectionEvent | undefined =>
  events.filter((event) => event.type === type && event.id > cutoff).at(-1);

/** Which structured outputs this execution validated, so earlier attempts' findings stay out. */
export const validatedOutputRefs = (
  events: readonly ProjectionEvent[],
  cutoff: number,
): Set<string> =>
  new Set(
    events
      .filter((event) => event.type === "output.validated" && event.id > cutoff)
      .flatMap((event) => {
        const payload = isRecord(event.payload) ? event.payload : undefined;
        return typeof payload?.outputRef === "string" ? [payload.outputRef] : [];
      }),
  );

export const decisionRisks = (decisionPayload: unknown): string[] =>
  isRecord(decisionPayload) && Array.isArray(decisionPayload.unresolvedRisks)
    ? decisionPayload.unresolvedRisks.filter((value): value is string => typeof value === "string")
    : [];

/**
 * The checks a contract verification recorded. A malformed entry is dropped rather than shown as a
 * check with no command or an unknown status, because a check the user cannot read is worse than a
 * check that is not listed; an event that carries no check array at all yields no checks, which is
 * different from an empty list and lets the caller fall back to another source.
 */
export const contractChecksFrom = (
  verificationEvent: ProjectionEvent | undefined,
): VerificationResult[] | undefined => {
  const payload = isRecord(verificationEvent?.payload) ? verificationEvent.payload : undefined;
  if (!Array.isArray(payload?.checks)) {
    return undefined;
  }
  return payload.checks.flatMap((item) => {
    if (!isRecord(item)) return [];
    const { command, status } = item;
    if (typeof command !== "string") return [];
    if (status !== "passed" && status !== "failed" && status !== "timedOut" && status !== "cancelled") {
      return [];
    }
    return [{ command, status } satisfies VerificationResult];
  });
};

/**
 * A recorded recheck only speaks for the candidate it ran against. One recorded before the run was
 * retained, or against a different retained run, is not evidence about this one and is dropped
 * rather than shown as fresher verification than the run's own.
 */
export const boundRecheck = (
  recorded: RunRecheckRecord | undefined,
  retainedRunId: string | undefined,
): RunRecheckRecord | undefined =>
  recorded && retainedRunId !== undefined && recorded.runId === retainedRunId
    ? recorded
    : undefined;

/**
 * Where the verification on screen came from. A recheck always names itself, because the user
 * needs to know the checks are newer than the run. The run's own checks are only claimed as
 * provenance when there are checks and a time they were recorded at: a time with no checks
 * describes nothing, and checks with no time cannot be placed against the candidate.
 */
export const verificationProvenance = (input: {
  recheck: RunRecheckRecord | undefined;
  checks: readonly VerificationResult[] | undefined;
  recordedAt: string | undefined;
}): VerificationProvenance | undefined => {
  if (input.recheck) {
    return { source: "recheck", recordedAt: input.recheck.recordedAt };
  }
  return (input.checks ?? []).length > 0 && input.recordedAt !== undefined
    ? { source: "run", recordedAt: input.recordedAt }
    : undefined;
};

/**
 * Whether a conversation has a run behind it at all.
 *
 * A conversation that has never run is not a run that produced nothing. Projecting every
 * conversation into a result rendered a pristine "New conversation" — no prompt sent, no step
 * started, nothing recorded — as an apply candidate with no changed files, no verification, a
 * refusal to apply and a notification about it, all describing a run that did not exist.
 *
 * Any one of four things proves a run: an event that only a running pipeline emits, a workflow
 * status that has left idle, a persisted terminal result from a previous session, or evidence in
 * the projection itself. What is NOT relaxed is the refusal for a real candidate: a run that
 * completed and recorded no verification still says so, because there the absence is a finding.
 */
export const runWasExecuted = (input: {
  events: readonly ProjectionEvent[];
  provingEventTypes: ReadonlySet<string>;
  workflowStatus: string;
  hasPersistedResult: boolean;
  projectionHasEvidence: boolean;
}): boolean =>
  input.events.some((event) => input.provingEventTypes.has(event.type)) ||
  input.workflowStatus !== "idle" ||
  input.hasPersistedResult ||
  input.projectionHasEvidence;
