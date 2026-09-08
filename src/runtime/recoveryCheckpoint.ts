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
import { pipelineSnapshotRootsEqual, type PipelineSnapshot } from "../pipeline/identity";
import type { ResumableWorkflow } from "../webview/protocol";

export type RecoveryCheckpoint = ResumableWorkflow & {
  pipelineSnapshot: PipelineSnapshot;
};

export const recoveryCheckpointIsUsable = (input: {
  checkpoint: RecoveryCheckpoint;
  selectedSnapshot: PipelineSnapshot | undefined;
  availableAttachmentIds: ReadonlySet<string>;
}): boolean => {
  const recoveryPipeline = input.checkpoint.pipelineSnapshot.definition;
  return (
    pipelineSnapshotRootsEqual(input.checkpoint.pipelineSnapshot, input.selectedSnapshot) &&
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
