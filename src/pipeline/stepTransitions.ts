/**
 * EX-AUD-12. Where a pipeline run goes next.
 *
 * The runner's loop reads a step, runs it, asks a human about it, and then moves. The moving is
 * the part that was never separable: every gate answer and every managed-turn result was turned
 * into an index change inline, beside the snapshot restore, the transcript write and the provider
 * call that surround it. So the rules — a cancelled gate ends the run, a rerun repeats the step
 * from its own snapshot, a repeated consensus repeats it without one, a finalized managed block
 * leaves the block rather than the step, a Lead's revision goes to a Worker in the same block and
 * fails loudly when there is none — could only be reached by running a pipeline.
 *
 * They are decisions about an index and nothing else, so they are here. Restoring the snapshot,
 * applying interventions and calling the agent stay in the runner.
 */

export type StepMovement =
  | { movement: "interrupt" }
  /** Run, or finish, the step the loop is on. */
  | { movement: "proceed" }
  /** Leave this step behind and take the next one. */
  | { movement: "advance" }
  /** Take the same step again; `restoreSnapshot` says whether its state is rolled back first. */
  | { movement: "repeat"; restoreSnapshot: boolean }
  | { movement: "rollback"; targetStepId: string }
  /** Continue from an index the caller did not reach by stepping. */
  | { movement: "jump"; index: number }
  /** The run cannot go anywhere: the caller raises this with the step it happened at. */
  | { movement: "fail"; reason: "no-managed-worker" };

export type GateDecisionLike = {
  action: string;
  targetStepId?: string | undefined;
};

/**
 * What a human's answer at a gate does to the run.
 *
 * `before` and `after` accept different answers, and the same word means different things at
 * each: `skip` before a step means never run it, and there is no `skip` after one. Both are
 * decided here so a gate answer cannot mean one thing where it is offered and another where it
 * is acted on.
 *
 * A rollback names its target, and a rollback whose target is missing is refused rather than
 * turned into a movement to nowhere: the runner would otherwise restore a snapshot for
 * `undefined`.
 */
export const gateMovement = (
  decision: GateDecisionLike,
  reason: "before" | "after",
): StepMovement => {
  if (decision.action === "cancel") {
    return { movement: "interrupt" };
  }
  if (decision.action === "rollback") {
    if (typeof decision.targetStepId !== "string" || decision.targetStepId.length === 0) {
      throw new Error("A rollback gate decision names no target step");
    }
    return { movement: "rollback", targetStepId: decision.targetStepId };
  }
  if (reason === "before") {
    return decision.action === "skip" ? { movement: "advance" } : { movement: "proceed" };
  }
  if (decision.action === "rerunStep") {
    return { movement: "repeat", restoreSnapshot: true };
  }
  // A repeated consensus is the same step run again over the state it already produced: the
  // point of repeating it is to let the participants see that state, so it is not rolled back.
  if (decision.action === "repeatConsensus") {
    return { movement: "repeat", restoreSnapshot: false };
  }
  return { movement: "proceed" };
};

export type ManagedBlockBounds = { start: number; end: number };

export type ManagedTransitionInput = {
  /** The state the managed turn reported, if it reported one. */
  managedState?: string | undefined;
  managedRole?: "worker" | "lead" | undefined;
  bounds?: ManagedBlockBounds | undefined;
  index: number;
  /** Whether the step at this index is an enabled managed Worker step. */
  isEnabledWorkerStep: (index: number) => boolean;
};

/**
 * Where a managed turn's own result sends the run.
 *
 * Only two results move the run at all. `FINALIZE` leaves the whole managed block, because the
 * block's work is what finished, not the step's. `WORKER_REVISE` from a Lead goes back to a
 * Worker in the same block — forward first, so a block written Worker-then-Lead-then-Worker
 * revises into the step that follows the Lead rather than the one before it, and backwards only
 * when there is nothing ahead.
 *
 * A Lead asking for a revision in a block with no enabled Worker is an error, not an advance: the
 * revision was requested and nothing would carry it out, and continuing would report the block
 * complete with the Lead's objection unanswered.
 */
export const managedTransition = (input: ManagedTransitionInput): StepMovement => {
  const { managedState, managedRole, bounds, index } = input;
  if (managedState === undefined || managedRole === undefined || bounds === undefined) {
    return { movement: "advance" };
  }
  if (managedState === "FINALIZE") {
    return { movement: "jump", index: bounds.end };
  }
  if (managedState !== "WORKER_REVISE" || managedRole !== "lead") {
    return { movement: "advance" };
  }
  for (let candidate = index + 1; candidate < bounds.end; candidate += 1) {
    if (input.isEnabledWorkerStep(candidate)) return { movement: "jump", index: candidate };
  }
  for (let candidate = index - 1; candidate >= bounds.start; candidate -= 1) {
    if (input.isEnabledWorkerStep(candidate)) return { movement: "jump", index: candidate };
  }
  return { movement: "fail", reason: "no-managed-worker" };
};

export type IterationPlan = {
  /** How many passes will run at most. */
  iterations: number;
  /** How many consecutive passes that changed nothing end the run early. */
  targetCleanPasses: number;
};

/**
 * How many times a request runs, and what would end it early.
 *
 * Both bounds are clamped rather than trusted. The counts reach here from persisted queue
 * entries and from webview messages, so a saved run from another version, or a message nothing
 * validated, must not be able to ask for zero passes — which would run nothing and report
 * success — or for a number large enough to be a denial of service against the user's own
 * machine.
 */
export const iterationPlan = (input: {
  iterationCount?: number | undefined;
  requiredCleanPasses?: number | undefined;
  maximumIterations?: number | undefined;
  maximumCleanPasses?: number | undefined;
}): IterationPlan => {
  const clamp = (value: number | undefined, fallback: number, maximum: number): number => {
    const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.max(1, Math.min(maximum, Math.trunc(candidate)));
  };
  return {
    iterations: clamp(input.iterationCount, 1, input.maximumIterations ?? 50),
    targetCleanPasses: clamp(input.requiredCleanPasses, 2, input.maximumCleanPasses ?? 10),
  };
};

export type IterationOutcome = {
  cleanPasses: number;
  /** Whether the run has met its clean-pass target and should stop before its last pass. */
  exhausted: boolean;
};

/**
 * What one finished pass leaves the run in.
 *
 * A fixed run never stops early: it was asked for a number of passes and it runs them. An
 * `untilClean` run counts consecutive passes that changed nothing, and one pass that did change
 * something resets the count to zero rather than decrementing it — the point of the target is
 * consecutive quiet, and a run that alternated changed and unchanged has not gone quiet.
 *
 * An unknown answer about whether the workspace changed is treated as a change. A pass whose
 * effect could not be established is not evidence of quiet.
 */
export const iterationOutcome = (input: {
  mode: "fixed" | "untilClean";
  cleanPasses: number;
  workspaceChanged?: boolean | undefined;
  targetCleanPasses: number;
}): IterationOutcome => {
  if (input.mode !== "untilClean") {
    return { cleanPasses: input.cleanPasses, exhausted: false };
  }
  const cleanPasses = input.workspaceChanged === false ? input.cleanPasses + 1 : 0;
  return { cleanPasses, exhausted: cleanPasses >= input.targetCleanPasses };
};
