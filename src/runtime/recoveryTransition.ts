/**
 * EX-AUD-12. What survives a reset or a cancellation, and what may not come back afterwards.
 *
 * A task reset is destructive I/O from beginning to end — abort, interrupt, back up, clear the
 * transcript and the attachments, persist, roll the whole thing back if any of it fails — and it
 * stays in `createRuntime`. The judgements inside it do not: which state a reset leaves behind,
 * whether a result that arrives afterwards still belongs to the task it was started for, whether
 * an approval still belongs to the operation that asked for it, and whether a cancelled run may
 * be resumed at all.
 *
 * Those were spelled out inline at a dozen call sites, each one a comparison beside the write it
 * guards, so a site that forgot one half of the comparison would let work from a task the user
 * already reset write into the task that replaced it. They are one rule each here.
 */

/**
 * The optional state keys a task reset removes rather than sets to nothing.
 *
 * The difference matters to the panel: an absent key means "no such thing", and a key holding
 * `undefined` is a key the panel would still render and the persisted value would still carry.
 * A reset that only blanked them would leave the previous task's shape behind on the next one.
 */
export const taskResetClearedKeys: readonly string[] = [
  "transcriptError",
  "activeStep",
  "activeStepId",
  "consensusRound",
  "pendingGate",
  "resumableWorkflow",
];

export type TaskResetBaseline = {
  transcript: readonly never[];
  transcriptTotal: number;
  transcriptHasMore: boolean;
  approvals: readonly never[];
  attachments: readonly never[];
  queuedMessages: readonly never[];
  queuePaused: boolean;
  roles: Record<string, never>;
  running: boolean;
  workflowStatus: "idle";
};

/**
 * What a task reset leaves the panel as.
 *
 * Everything a task accumulated goes: its transcript, its approvals, its attachments, its queue,
 * its roles and its run status. What it does not touch is the workspace, the selected pipeline
 * and the agents — a reset ends a task, not the session it runs in.
 */
export const taskResetBaseline = (): TaskResetBaseline => ({
  transcript: [],
  transcriptTotal: 0,
  transcriptHasMore: false,
  approvals: [],
  attachments: [],
  queuedMessages: [],
  queuePaused: false,
  roles: {},
  running: false,
  workflowStatus: "idle",
});

/**
 * Whether a result belongs to a task that is no longer the current one, or to an operation the
 * user already cancelled.
 *
 * This is what stops a reset from being undone by the work it interrupted. An in-flight turn
 * cannot be stopped mid-write; it can only be stopped from writing. Every write inside a run
 * asks this first, and a run whose task has been replaced writes nothing further — including
 * into the state the reset just cleared, which is how cleared state would otherwise come back.
 */
export const resultIsStale = (input: {
  operationTaskId: string | undefined;
  currentTaskId: string;
  aborted?: boolean | undefined;
}): boolean =>
  input.operationTaskId !== input.currentTaskId || input.aborted === true;

/**
 * Whether an approval still belongs to the operation that asked for it.
 *
 * A task that was reset invalidates it, and so does an operation that has been replaced on the
 * same agent: an approval answered against a newer operation would authorize an action nobody
 * looked at. An approval recorded without an owner is checked on its task alone, because there
 * is no operation identity to compare and inventing one would refuse every such approval.
 */
export const approvalIsStale = (input: {
  resolverTaskId: string | undefined;
  currentTaskId: string;
  resolverOperationOwnerId?: string | undefined;
  activeOperationOwnerId?: string | undefined;
}): boolean =>
  input.resolverTaskId !== input.currentTaskId ||
  (input.resolverOperationOwnerId !== undefined &&
    input.activeOperationOwnerId !== input.resolverOperationOwnerId);

export type ResumeRefusal =
  | "no-recoverable-workflow"
  | "already-completed"
  | "workflow-active";

/**
 * Why a cancelled or interrupted run may not be resumed, or nothing.
 *
 * A checkpoint whose next step is past the end of its pipeline is not a run waiting to continue:
 * it is a run that finished, and resuming it would run nothing and report a fresh success. It is
 * reported separately from having no checkpoint at all, because the two need different words and
 * because only the completed one has a checkpoint to discard.
 */
export const resumeRefusal = (input: {
  checkpoint?: { nextStepIndex: number; totalSteps: number } | undefined;
  workflowActive: boolean;
}): ResumeRefusal | undefined => {
  if (input.workflowActive) return "workflow-active";
  if (!input.checkpoint) return "no-recoverable-workflow";
  return input.checkpoint.nextStepIndex >= input.checkpoint.totalSteps
    ? "already-completed"
    : undefined;
};

/**
 * Whether discarding a checkpoint also returns the run to idle.
 *
 * Only a run that stopped because it was interrupted or failed: those are the two statuses whose
 * only remaining meaning was the checkpoint that has just gone. A run reported idle, or one still
 * running, is left exactly as it is.
 */
export const discardReturnsToIdle = (workflowStatus: string): boolean =>
  workflowStatus === "interrupted" || workflowStatus === "error";
