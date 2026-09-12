/**
 * Whether a persisted recovery checkpoint may still be resumed.
 *
 * A checkpoint is a promise to continue a run that was interrupted. It is only honourable
 * while the pipeline it names is still the selected one, at the same revision, in the same
 * storage scope, with a step index inside that pipeline and every attachment it referenced
 * still present. Any of those failing means the resumed run would not be the run that was
 * interrupted, so the checkpoint is discarded rather than repaired.
 *
 * The judgement lived inside the runtime's initialization, where it could only be reached by
 * constructing a whole runtime over a whole persisted value.
 */
import type { AgentAssignments } from "../pipeline/agentAssignment";
import { pipelineSnapshotRootsEqual, type PipelineSnapshot } from "../pipeline/identity";
import type { ResumableWorkflow } from "../webview/protocol";

export type RecoveryCheckpoint = ResumableWorkflow & {
  pipelineSnapshot: PipelineSnapshot;
  assignments?: AgentAssignments | undefined;
};

/**
 * Whether two assignment maps name the same provider, the same model, and the same browser
 * conversation, for every participant. Compared field by field rather than by serialisation so key
 * order cannot decide it. The model is part of the identity: resuming a checkpoint that ran on one
 * model under another would continue a run nobody interrupted.
 */
const assignmentsEqual = (
  left: AgentAssignments | undefined,
  right: AgentAssignments | undefined,
): boolean => {
  const leftEntries = Object.entries(left ?? {});
  const rightMap = right ?? {};
  return (
    leftEntries.length === Object.keys(rightMap).length &&
    leftEntries.every(([agentId, override]) =>
      rightMap[agentId]?.adapter === override.adapter &&
      rightMap[agentId]?.model === override.model &&
      rightMap[agentId]?.browserSessionId === override.browserSessionId,
    )
  );
};

export const recoveryCheckpointIsUsable = (input: {
  checkpoint: RecoveryCheckpoint;
  selectedSnapshot: PipelineSnapshot | undefined;
  availableAttachmentIds: ReadonlySet<string>;
  // The reassignments in force now. A checkpoint records the providers that actually ran, and
  // resuming it under different ones would continue a run nobody interrupted, so a change here
  // discards the checkpoint exactly as a change of pipeline revision does.
  currentAssignments?: AgentAssignments | undefined;
}): boolean => {
  const recoveryPipeline = input.checkpoint.pipelineSnapshot.definition;
  return (
    pipelineSnapshotRootsEqual(input.checkpoint.pipelineSnapshot, input.selectedSnapshot) &&
    assignmentsEqual(input.checkpoint.assignments, input.currentAssignments) &&
    recoveryPipeline.id === input.selectedSnapshot?.definition.id &&
    input.checkpoint.pipelineHash === input.checkpoint.pipelineSnapshot.hash &&
    input.checkpoint.totalSteps === recoveryPipeline.steps.length &&
    input.checkpoint.nextStepIndex >= 0 &&
    input.checkpoint.nextStepIndex <= recoveryPipeline.steps.length &&
    input.checkpoint.attachmentIds.every((attachmentId) =>
      input.availableAttachmentIds.has(attachmentId),
    )
  );
};
