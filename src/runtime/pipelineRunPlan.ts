import { createHash } from "node:crypto";

import type { ManagedRepositoryBaseline } from "../orchestrator/managedPair";
import type { PipelineResumeState } from "../pipeline/runner";
import type { PipelineSnapshot } from "../pipeline/identity";
import type { WorkspaceWriteScope } from "../adapters/types";
import type { ResumableWorkflow } from "../webview/protocol";
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
export type PersistedResumableWorkflow = ResumableWorkflow & {
  checkpoint: PipelineResumeState;
  pipelineSnapshot: PipelineSnapshot;
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
 * The record a run can be resumed from. The pipeline snapshot is cloned on the way in: the record
 * outlives the run, and a definition the catalog later mutates must not change what an interrupted
 * run says it was executing.
 */
export const resumableWorkflowFrom = (input: {
  pipelineId: string;
  pipelineName: string;
  pipelineHash: string;
  totalSteps: number;
  userPrompt: string;
  attachmentIds: readonly string[];
  checkpoint: PipelineResumeState;
  pipelineSnapshot: PipelineSnapshot;
  runSettings: RunSettingsSnapshot;
  constraints: RunConstraints;
  updatedAt: string;
  sourceQueueMessageId?: string | undefined;
  resumeSourceQueueMessageId?: string | undefined;
}): PersistedResumableWorkflow => ({
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
  ...input.constraints,
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
 */
export const pipelineFailurePlan = (input: {
  accepted: boolean;
  recoveryEstablished: boolean;
  resuming: boolean;
}): { recordFailure: boolean; restoreResume: boolean } => ({
  recordFailure: input.accepted || input.recoveryEstablished,
  restoreResume: !input.recoveryEstablished && input.resuming,
});
