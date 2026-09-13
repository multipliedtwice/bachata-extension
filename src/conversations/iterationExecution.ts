import type { WorkspaceWriteScope } from "../adapters/types";
import { failedRunWorkflowStatus } from "../runtime/recoveryTransition";

/**
 * EX-3. What an iteration decides before and after the runtime runs it, apart from the catalog
 * rows it writes and the runtime it drives.
 *
 * Whether a run is a pair, what its pair row says, which write scope an orchestration task's paths
 * imply, what the iteration events are called, and how a failed iteration is classified all sat
 * inside one function with the catalog writes, the persistence and the snapshot emission. The
 * write-scope rule was even spelled out twice in one expression.
 */

/** A pair run: a managed task, or a pipeline that names both a worker and a lead role. */
export const isPairPipeline = (input: {
  orchestrationTaskId?: string | undefined;
  roles?: readonly { id: string }[] | undefined;
}): boolean =>
  Boolean(
    input.orchestrationTaskId ||
      (input.roles?.some((role) => role.id === "worker") &&
        input.roles.some((role) => role.id === "lead")),
  );

/**
 * The write scope an orchestration task's paths imply when the caller named none: the whole
 * workspace when the task was scoped to the root, the task's own paths when it has any, nothing
 * otherwise — a run without paths keeps whatever the runtime decides.
 */
export const impliedWriteScope = (input: {
  requested?: WorkspaceWriteScope | undefined;
  orchestrationPaths?: readonly string[] | undefined;
}): WorkspaceWriteScope | undefined => {
  if (input.requested !== undefined) return input.requested;
  const paths = input.orchestrationPaths ?? [];
  if (paths.some((entry) => entry === "" || entry === ".")) return "workspace";
  return paths.length > 0 ? "task" : undefined;
};

/** The catalog's pair row for a run: the task's worktree and scope when it is a task, else the root. */
export const pairRecordFrom = (input: {
  runRef: string;
  iterationRef: string;
  orchestrationTaskId?: string | undefined;
  orchestrationBranch?: string | undefined;
  orchestrationBaseCommit?: string | undefined;
  orchestrationPaths?: readonly string[] | undefined;
  workingDirectory: string | undefined;
}): {
  runRef: string;
  iterationRef: string;
  taskId: string | undefined;
  workingRoot: string | undefined;
  worktreePath: string | undefined;
  branch: string | undefined;
  baseCommit: string | undefined;
  scope: { taskId: string; paths: string[] } | undefined;
  status: "running";
} => ({
  runRef: input.runRef,
  iterationRef: input.iterationRef,
  taskId: input.orchestrationTaskId,
  workingRoot: input.workingDirectory,
  worktreePath: input.orchestrationTaskId ? input.workingDirectory : undefined,
  branch: input.orchestrationBranch,
  baseCommit: input.orchestrationBaseCommit,
  scope: input.orchestrationTaskId
    ? { taskId: input.orchestrationTaskId, paths: [...(input.orchestrationPaths ?? [])] }
    : undefined,
  status: "running",
});

export const iterationStartEvent = (input: {
  resume: boolean;
  displayIndex: number;
  requestedIterations: number;
}): { type: "iteration.resumed" | "iteration.started"; title: string } => ({
  type: input.resume ? "iteration.resumed" : "iteration.started",
  title: `Iteration ${String(input.displayIndex)} of ${String(input.requestedIterations)}`,
});

export const iterationEndEvent = (input: {
  status: string;
  displayIndex: number;
}): { type: "iteration.interrupted" | "iteration.completed"; title: string } => ({
  type: input.status === "interrupted" ? "iteration.interrupted" : "iteration.completed",
  title: `Iteration ${String(input.displayIndex)} ${input.status}`,
});

/**
 * How a failed iteration is classified.
 *
 * What decides it is whether a checkpoint survived, not whether this attempt was a resume. The
 * runtime saves a recoverable workflow as soon as a step is reached, so a provider that fails on
 * the very first attempt leaves a checkpoint behind exactly as a failed resume does. Recording
 * that first attempt as `failed` while the checkpoint existed is what produced "The recoverable
 * workflow has no matching interrupted iteration": the run held everything needed to continue and
 * the catalog said it did not.
 *
 * `resume` still decides what the event is called, because "resume failed" and "failed" describe
 * different things to a reader, and only the classification was ever wrong.
 */
export const iterationFailurePlan = (input: {
  resume: boolean;
  runtimeStatus: string;
  hasResumableWorkflow: boolean;
  displayIndex: number;
  error: unknown;
}): {
  status: "interrupted" | "failed";
  workflowStatus: "interrupted" | "error";
  eventType: "iteration.resume.failed" | "iteration.failed";
  title: string;
  message: string;
  dropPendingWorkingDirectory: boolean;
} => {
  const recoverable = input.hasResumableWorkflow;
  const workflowStatus = failedRunWorkflowStatus(input.runtimeStatus);
  return {
    status: workflowStatus === "interrupted" ? "interrupted" : "failed",
    workflowStatus,
    eventType: input.resume ? "iteration.resume.failed" : "iteration.failed",
    title: input.resume
      ? `Iteration ${String(input.displayIndex)} resume failed`
      : `Iteration ${String(input.displayIndex)} failed`,
    message: input.error instanceof Error ? input.error.message : String(input.error),
    dropPendingWorkingDirectory: !recoverable,
  };
};
