import type {
  RetainedTodoRunSummary,
  TodoOrchestrationSummary,
} from "../webview/protocol";
import type { OrchestrationLedger, OrchestrationSnapshot } from "./types";

export const emptyOrchestrationSummary = (): TodoOrchestrationSummary => ({
  active: false,
  masterChecks: [],
  tasks: [],
  finalChecks: [],
  retainedRuns: [],
});

export const latestCheckStamp = (
  checks: ReadonlyArray<{ completedAt?: string | undefined }>,
): string | undefined => {
  const stamps = checks
    .map((check) => check.completedAt)
    .filter((value): value is string => typeof value === "string");
  return stamps.length > 0
    ? stamps.reduce((latest, value) => (value.localeCompare(latest) > 0 ? value : latest))
    : undefined;
};

export const summarizeOrchestration = (
  snapshot: OrchestrationSnapshot,
): TodoOrchestrationSummary => {
  const run = snapshot.run;
  if (!run) {
    return {
      active: snapshot.active,
      masterChecks: [],
      tasks: [],
      finalChecks: [],
      retainedRuns: snapshot.retainedRuns,
    };
  }
  const finalChecksVerifiedAt = latestCheckStamp(run.finalChecks);
  return {
    active: snapshot.active,
    runId: run.runId,
    title: run.title,
    status: run.status,
    integrationBranch: run.integrationBranch,
    integrationWorktree: run.integrationWorktree,
    ...(run.parentConversationId === undefined
      ? {}
      : { parentConversationId: run.parentConversationId }),
    ...(run.masterConversationId === undefined
      ? {}
      : { masterConversationId: run.masterConversationId }),
    masterChecks: run.masterChecks.map((check) => ({
      phase: check.phase,
      status: check.status,
    })),
    tasks: Object.values(run.tasks).map((task) => {
      const verifiedAt = latestCheckStamp(task.result?.checks ?? []);
      return {
      id: task.spec.id,
      title: task.spec.title,
      status: task.status,
      attempts: task.attempts,
      ...(task.conversationId === undefined ? {} : { conversationId: task.conversationId }),
      ...(task.lastError === undefined ? {} : { lastError: task.lastError }),
      checks: task.result?.checks.map((check) => ({
        command: check.command,
        status: check.status,
        ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
        ...(check.workingDirectory === undefined ? {} : { workingDirectory: check.workingDirectory }),
        ...(check.candidateTree === undefined ? {} : { candidateTree: check.candidateTree }),
        ...(check.outputReference === undefined ? {} : { outputReference: check.outputReference }),
      })) ?? [],
      ...(task.result?.summary === undefined ? {} : { summary: task.result.summary }),
      ...(task.result
        ? { changedFiles: [...task.result.changedFiles], blockers: [...task.result.blockers] }
        : {}),
      ...(task.worktreePath === undefined ? {} : { worktreePath: task.worktreePath }),
        ...(verifiedAt === undefined ? {} : { verifiedAt }),
      };
    }),
    finalChecks: run.finalChecks.map((check) => ({
      command: check.command,
      status: check.status,
      ...(check.exitCode === undefined ? {} : { exitCode: check.exitCode }),
      ...(check.workingDirectory === undefined ? {} : { workingDirectory: check.workingDirectory }),
      ...(check.candidateTree === undefined ? {} : { candidateTree: check.candidateTree }),
      ...(check.outputReference === undefined ? {} : { outputReference: check.outputReference }),
    })),
    ...(finalChecksVerifiedAt === undefined ? {} : { finalChecksVerifiedAt }),
    retainedRuns: snapshot.retainedRuns,
  };
};


/**
 * The retained-run projection. A retained run holds a Git worktree after its orchestration
 * finished, so both the owning window and a read-only window must describe it identically.
 */
export const retainedOrchestrationSummary = (
  current: OrchestrationLedger,
): RetainedTodoRunSummary => ({
  runId: current.runId,
  title: current.title,
  status: current.status === "cleanupPending" ? "cleanupPending" : "completed",
  integrationBranch: current.integrationBranch,
  integrationWorktree: current.integrationWorktree,
  createdAt: current.createdAt,
  updatedAt: current.updatedAt,
  taskCount: Object.keys(current.tasks).length,
});
