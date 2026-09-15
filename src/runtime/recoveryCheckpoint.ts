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

export type RecoveryCheckpoint = Omit<ResumableWorkflow, "attemptId" | "outcome" | "failureScope" | "stepName"> & {
  pipelineSnapshot: PipelineSnapshot;
  assignments?: AgentAssignments | undefined;
};

/**
 * Whether two assignment maps name the same provider and browser conversation for every
 * participant. Compared field by field rather than by serialisation so key order cannot decide it.
 * Model and thinking effort are intentionally excluded: they are turn-level choices and may change
 * after a stop or failure before the next turn starts.
 */
const assignmentProvidersEqual = (
  left: AgentAssignments | undefined,
  right: AgentAssignments | undefined,
  pipeline: PipelineSnapshot["definition"],
): boolean => {
  const declared = new Set(pipeline.agents.map((agent) => agent.id));
  if ([...Object.keys(left ?? {}), ...Object.keys(right ?? {})].some((agentId) => !declared.has(agentId))) {
    return false;
  }
  return pipeline.agents.every((agent) => {
    const before = left?.[agent.id];
    const current = right?.[agent.id];
    return (
      (before?.adapter ?? agent.adapter) === (current?.adapter ?? agent.adapter) &&
      before?.browserSessionId === current?.browserSessionId
    );
  });
};

export const recoveryCheckpointIsUsable = (input: {
  checkpoint: RecoveryCheckpoint;
  selectedSnapshot: PipelineSnapshot | undefined;
  availableAttachmentIds: ReadonlySet<string>;
  // The reassignments in force now. Provider and browser-conversation identity stay fixed for the
  // run; model and thinking effort may change for the next turn after a stop or failure.
  currentAssignments?: AgentAssignments | undefined;
}): boolean => {
  const recoveryPipeline = input.checkpoint.pipelineSnapshot.definition;
  return (
    pipelineSnapshotRootsEqual(input.checkpoint.pipelineSnapshot, input.selectedSnapshot) &&
    assignmentProvidersEqual(
      input.checkpoint.assignments,
      input.currentAssignments,
      recoveryPipeline,
    ) &&
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
