import type { PipelineDefinition } from "../pipeline/types";
import type { DeclaredArtifactSource } from "./service";

type StoredOutput = {
  outputRef: string;
  name: string;
  value: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Maps this run's stored step outputs onto the promotions the pipeline declared.
 *
 * Outputs are stored under "<name>.<agentId>" and wrap a StepOutputArtifact, so the wrapper's
 * own stepId and name identify the step, and its inner `value` is what gets promoted. A step
 * that declared no promotion contributes nothing, which is what an undeclared custom pipeline
 * gets: run-local output and no durable state.
 */
export const declaredArtifactSourcesFor = (input: {
  definition: PipelineDefinition | undefined;
  outputs: readonly StoredOutput[];
  outputRefs: ReadonlySet<string>;
}): DeclaredArtifactSource[] => {
  if (input.definition === undefined) return [];
  const produced = input.outputs
    .filter((output) => input.outputRefs.has(output.outputRef))
    .flatMap((output) => {
      const wrapper = isRecord(output.value) ? output.value : undefined;
      if (wrapper === undefined) return [];
      if (typeof wrapper.stepId !== "string" || typeof wrapper.name !== "string") return [];
      // A step output that failed its own schema never becomes durable state.
      if (Array.isArray(wrapper.validationErrors) && wrapper.validationErrors.length > 0) {
        return [];
      }
      return [{
        stepId: wrapper.stepId,
        name: wrapper.name,
        agentId: typeof wrapper.agentId === "string" ? wrapper.agentId : undefined,
        participant: typeof wrapper.participant === "string" ? wrapper.participant : undefined,
        value: wrapper.value,
      }];
    });
  return input.definition.steps.flatMap((step) => {
    if (step.type !== "agent" || step.artifactPromotion === undefined) return [];
    const outputName = step.output?.name;
    if (outputName === undefined) return [];
    const candidates = produced
      .filter((output) => output.stepId === step.id && output.name === outputName);
    const producedBy = step.artifactPromotion.producedBy;
    // With a named producer, only that agent's answer is promoted. Without one, the step
    // must have produced exactly one answer; anything else is ambiguous and promotes nothing
    // rather than picking whichever was stored last.
    // producedBy names what the pipeline declared, which may be a role. Match the declared
    // participant first, and fall back to the agent id for a literal agent participant.
    const matches = producedBy === undefined
      ? candidates
      : candidates.filter((output) =>
        (output.participant ?? output.agentId) === producedBy ||
        output.agentId === producedBy);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match === undefined) return [];
    return [{
      promotion: step.artifactPromotion,
      output: match.value,
      fallbackTitle: step.name,
      participantIds: match.agentId === undefined ? step.participants : [match.agentId],
      stepId: step.id,
    }];
  });
};
