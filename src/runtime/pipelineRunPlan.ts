import { createHash } from "node:crypto";

import type { ManagedRepositoryBaseline } from "../orchestrator/managedPair";
import type { AgentAssignments } from "../pipeline/agentAssignment";
import type { PipelineResumeState } from "../pipeline/runner";
import type { PipelineSnapshot } from "../pipeline/identity";
import type { WorkspaceWriteScope } from "../adapters/types";
import type { ResumableWorkflow } from "../webview/protocol";
import type { RecoveryRecordOutcome } from "./recoveryTransition";
import type { RunSettingRejection, RunSettingsSnapshot } from "./settingsSnapshot";

/**
 * EX-3. What a pipeline run decides, apart from running one.
 *
 * The driver around `executePipeline` is mostly effects — a controller, transcript writes, host
 * callbacks, a snapshot store. Between them sat judgements that are not effects at all: which
 * constraints a resume inherits and which the caller overrode, what the resumable record for this
 * run looks like, whether a checkpoint still belongs to the run that produced it, whether the
 * workspace moved while the run held it, and what a failure owes depending on how far the run got
 * before it failed. Each of those was reachable only by driving a whole pipeline.
 *
 * Nothing here takes the run's options object. A decision that reads the whole bag is the closure
 * relocated, not extracted.
 */
/**
 * The whole plan the run was started under, not only the part the runtime executes.
 *
 * Iteration count, iteration mode and the clean-pass requirement are decided above the runtime, so
 * a restart that replayed only the runtime's record would silently run a different plan: a
 * five-pass until-clean run would come back as two fixed passes. Recorded with the checkpoint
 * because the checkpoint is what a restart replays.
 */
export type RunExecutionPlan = {
  iterationCount: number;
  iterationMode: "fixed" | "untilClean";
  requiredCleanPasses: number;
  trackWorkspaceChanges?: boolean | undefined;
  iterationIndex?: number | undefined;
  consecutiveCleanPasses?: number | undefined;
};

export type PersistedResumableWorkflow = Omit<ResumableWorkflow, "outcome" | "stepName"> & {
  outcome: RecoveryRecordOutcome;
  checkpoint: PipelineResumeState;
  pipelineSnapshot: PipelineSnapshot;
  executionPlan?: RunExecutionPlan | undefined;
  workspaceChangeBaseline?: ManagedRepositoryBaseline | undefined;
  // Which provider actually answered for each participant. The snapshot above is the pipeline as
  // the catalog holds it, so on its own it describes a run with the shipped providers — not the
  // reassigned ones this run used. Recorded separately so the executed run stays reproducible and
  // a resume can refuse a checkpoint whose assignments no longer hold.
  assignments?: AgentAssignments | undefined;
  runSettings?: RunSettingsSnapshot | undefined;
  // Values the persisted snapshot carried that Bachata will not apply. A resume states them rather
  // than quietly continuing on live settings for those keys.
  rejectedRunSettings?: RunSettingRejection[] | undefined;
  sourceQueueMessageId?: string | undefined;
  allowedPaths?: string[] | undefined;
  writeScope?: WorkspaceWriteScope | undefined;
  commitMode?: "never" | "allow" | undefined;
};

export type RunConstraints = {
  allowedPaths?: string[];
  writeScope?: WorkspaceWriteScope;
  commitMode?: "never" | "allow";
};

/**
 * What the run is constrained by: what the caller asked for, falling back per key to what the
 * resumed record carried. Per key, not per record — a caller who narrows the write scope on a
 * resume keeps the paths the interrupted run was allowed.
 *
 * A key nobody set stays absent rather than becoming an explicit `undefined`, because these are
 * spread into a request the adapter reads, and an absent constraint is not the same as one set to
 * nothing.
 */
export const resolvedRunConstraints = (input: {
  allowedPaths?: readonly string[] | undefined;
  writeScope?: WorkspaceWriteScope | undefined;
  commitMode?: "never" | "allow" | undefined;
  resume?:
    | {
        allowedPaths?: readonly string[] | undefined;
        writeScope?: WorkspaceWriteScope | undefined;
        commitMode?: "never" | "allow" | undefined;
      }
    | undefined;
}): RunConstraints => {
  const allowedPaths = input.allowedPaths ?? input.resume?.allowedPaths;
  const writeScope = input.writeScope ?? input.resume?.writeScope;
  const commitMode = input.commitMode ?? input.resume?.commitMode;
  return {
    ...(allowedPaths === undefined ? {} : { allowedPaths: [...allowedPaths] }),
    ...(writeScope === undefined ? {} : { writeScope }),
    ...(commitMode === undefined ? {} : { commitMode }),
  };
};

/**
 * The recorded plan, or nothing. A plan whose count or clean-pass requirement did not survive
 * persistence is refused whole rather than half-applied: a restart under half a plan is a restart
 * under a plan nobody chose.
 */
export const parseRunExecutionPlan = (
  value: unknown,
): RunExecutionPlan | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const { iterationCount, iterationMode, requiredCleanPasses } = record;
  if (
    !Number.isSafeInteger(iterationCount) ||
    Number(iterationCount) < 1 ||
    (iterationMode !== "fixed" && iterationMode !== "untilClean") ||
    !Number.isSafeInteger(requiredCleanPasses) ||
    Number(requiredCleanPasses) < 1 ||
    (record.iterationIndex !== undefined && (!Number.isSafeInteger(record.iterationIndex)
      || Number(record.iterationIndex) < 1 || Number(record.iterationIndex) > Number(iterationCount))) ||
    (record.consecutiveCleanPasses !== undefined && (!Number.isSafeInteger(record.consecutiveCleanPasses)
      || Number(record.consecutiveCleanPasses) < 0 || Number(record.consecutiveCleanPasses) >= Number(requiredCleanPasses)))
  ) {
    return undefined;
  }
  return {
    iterationCount: Number(iterationCount),
    iterationMode,
    requiredCleanPasses: Number(requiredCleanPasses),
    ...(record.trackWorkspaceChanges === true || iterationMode === "untilClean" ? { trackWorkspaceChanges: true } : {}),
    ...(record.iterationIndex === undefined ? {} : { iterationIndex: Number(record.iterationIndex) }),
    ...(record.consecutiveCleanPasses === undefined ? {} : { consecutiveCleanPasses: Number(record.consecutiveCleanPasses) }),
  };
};

/**
 * The record a run can be resumed from. The pipeline snapshot is cloned on the way in: the record
 * outlives the run, and a definition the catalog later mutates must not change what an interrupted
 * run says it was executing.
 */
export const resumableWorkflowFrom = (input: {
  attemptId: string;
  pipelineId: string;
  pipelineName: string;
  pipelineHash: string;
  totalSteps: number;
  userPrompt: string;
  attachmentIds: readonly string[];
  checkpoint: PipelineResumeState;
  pipelineSnapshot: PipelineSnapshot;
  assignments?: AgentAssignments | undefined;
  runSettings: RunSettingsSnapshot;
  constraints: RunConstraints;
  updatedAt: string;
  executionPlan?: RunExecutionPlan | undefined;
  workspaceChangeBaseline?: ManagedRepositoryBaseline | undefined;
  sourceQueueMessageId?: string | undefined;
  resumeSourceQueueMessageId?: string | undefined;
}): PersistedResumableWorkflow => ({
  attemptId: input.attemptId,
  outcome: "running",
  runSettings: input.runSettings,
  pipelineId: input.pipelineId,
  pipelineName: input.pipelineName,
  pipelineHash: input.pipelineHash,
  userPrompt: input.userPrompt,
  attachmentIds: [...input.attachmentIds],
  nextStepIndex: input.checkpoint.nextStepIndex,
  totalSteps: input.totalSteps,
  updatedAt: input.updatedAt,
  checkpoint: input.checkpoint,
  pipelineSnapshot: structuredClone(input.pipelineSnapshot),
  ...(input.assignments === undefined || Object.keys(input.assignments).length === 0
    ? {}
    : { assignments: structuredClone(input.assignments) }),
  ...input.constraints,
  ...(input.executionPlan === undefined ? {} : { executionPlan: { ...input.executionPlan } }),
  ...(input.workspaceChangeBaseline === undefined ? {} : { workspaceChangeBaseline: structuredClone(input.workspaceChangeBaseline) }),
  ...(input.sourceQueueMessageId !== undefined
    ? { sourceQueueMessageId: input.sourceQueueMessageId }
    : input.resumeSourceQueueMessageId !== undefined
      ? { sourceQueueMessageId: input.resumeSourceQueueMessageId }
      : {}),
});

/** Settings a resume carried and settings the recorder refused, as one list in that order. */
export const droppedRunSettings = (
  fromResume: readonly RunSettingRejection[] | undefined,
  fromRecorder: readonly RunSettingRejection[],
): RunSettingRejection[] => [...(fromResume ?? []), ...fromRecorder];

/**
 * What the run says about settings it would not apply. Nothing is said when nothing was dropped:
 * an empty notice would report a decision the run never made.
 */
export const droppedRunSettingsNotice = (
  dropped: readonly RunSettingRejection[],
): string | undefined =>
  dropped.length === 0
    ? undefined
    : `Bachata could not apply ${String(dropped.length)} recorded setting${
        dropped.length === 1 ? "" : "s"
      } from this run's saved input, and used the current value instead: ${dropped
        .map((entry) => `${entry.key} ${entry.reason}`)
        .join("; ")}.`;

/**
 * Whether a checkpoint belongs to the record currently held. A run that was replaced, or whose
 * pipeline definition changed underneath it, must not write its progress into the record the
 * replacement owns.
 */
export const checkpointAppliesTo = (
  current: { pipelineId: string; pipelineHash: string } | undefined,
  run: { pipelineId: string; pipelineHash: string },
): boolean =>
  current !== undefined &&
  current.pipelineId === run.pipelineId &&
  current.pipelineHash === run.pipelineHash;

const baselineFingerprint = (baseline: ManagedRepositoryBaseline): string =>
  createHash("sha256")
    .update(JSON.stringify({ head: baseline.head, entries: baseline.entries }))
    .digest("hex");

/**
 * Whether the workspace moved while the run held it. Only comparable when both readings saw a
 * repository: a directory that is not a repository, or became one mid-run, has no fingerprint to
 * compare and the run reports nothing rather than guessing.
 */
export const workspaceChangeFrom = (input: {
  before: ManagedRepositoryBaseline | undefined;
  after: ManagedRepositoryBaseline | undefined;
}): { workspaceChanged: boolean; workspaceFingerprint: string } | undefined => {
  const { before, after } = input;
  if (!before || !after) return undefined;
  if (!before.isGitRepository || !after.isGitRepository) return undefined;
  const afterFingerprint = baselineFingerprint(after);
  return {
    workspaceChanged: baselineFingerprint(before) !== afterFingerprint,
    workspaceFingerprint: afterFingerprint,
  };
};

/**
 * What a finished run owes. An interrupted run keeps its resumable record — that record is the
 * only way back into it — and a completed one drops it.
 */
export const pipelineTerminalPlan = (
  status: string,
): { runStatus: "interrupted" | "completed"; keepResumable: boolean; statusText: string } =>
  status === "interrupted"
    ? { runStatus: "interrupted", keepResumable: true, statusText: "Pipeline interrupted." }
    : { runStatus: "completed", keepResumable: false, statusText: "Pipeline completed." };

/**
 * What a failed run owes, which depends on how far it got. A run that failed before it was
 * accepted and before its recovery record existed was never visible as a run, so marking it failed
 * would report a run the reader never saw start; and a resume whose own record was never replaced
 * must be put back, or the failure would consume the only way back into the interrupted run.
 *
 * A restart owes the same debt for the same reason. It begins from the recorded run rather than
 * from the checkpoint's step, but until its own record is durable the checkpoint it started from
 * is still the only way back, so a restart that fails before that point restores it too.
 */
export const pipelineFailurePlan = (input: {
  accepted: boolean;
  recoveryEstablished: boolean;
  resuming: boolean;
  restarting?: boolean;
}): { recordFailure: boolean; restoreResume: boolean } => ({
  recordFailure: input.accepted || input.recoveryEstablished,
  restoreResume: !input.recoveryEstablished && (input.resuming || input.restarting === true),
});
