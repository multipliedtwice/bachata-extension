import { validateDecisionCandidate } from "./decisionCandidates";
import type {
  DecisionSourceResult,
  LongitudinalDecisionCandidate,
} from "./decisionCandidates";
import type { PipelineDefinition } from "../pipeline/types";

type StoredOutput = {
  outputRef: string;
  name: string;
  value: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads core-decision candidates from the step that declared them.
 *
 * Only a step carrying `coreDecisionOutput` contributes. An ordinary consensus ruling stays
 * run evidence: agreement on an answer is not a material human judgment. Structurally
 * unusable output produces errors, which the round records as an evidence gap rather than a
 * durable decision, and nothing here supplies a subject, scope, evidence, option, trade-off
 * or recommendation the workflow did not state.
 */
export const coreDecisionSourceFrom = (input: {
  definition: PipelineDefinition | undefined;
  outputs: readonly StoredOutput[];
  outputRefs: ReadonlySet<string>;
}): DecisionSourceResult => {
  if (input.definition === undefined) return { errors: [] };
  const produced = input.outputs
    .filter((output) => input.outputRefs.has(output.outputRef))
    .flatMap((output) => {
      const wrapper = isRecord(output.value) ? output.value : undefined;
      if (wrapper === undefined) return [];
      if (typeof wrapper.stepId !== "string" || typeof wrapper.name !== "string") return [];
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

  const errors: string[] = [];
  const candidates: LongitudinalDecisionCandidate[] = [];
  const participantIds: string[] = [];
  let stepId: string | undefined;

  input.definition.steps.forEach((step) => {
    if (step.type !== "agent" || step.coreDecisionOutput === undefined) return;
    const outputName = step.output?.name;
    if (outputName === undefined) return;
    const producedBy = step.coreDecisionOutput.producedBy;
    const matches = produced
      .filter((output) => output.stepId === step.id && output.name === outputName)
      .filter((output) => producedBy === undefined ||
        (output.participant ?? output.agentId) === producedBy ||
        output.agentId === producedBy);
    const match = matches.length === 1 ? matches[0] : undefined;
    if (match === undefined) return;
    const field = step.coreDecisionOutput.field ?? "decisions";
    const container = isRecord(match.value) ? match.value[field] : undefined;
    if (container === undefined) return;
    if (!Array.isArray(container)) {
      errors.push(
        `Step ${step.id} declared core decisions in "${field}", but that field is not a list`,
      );
      return;
    }
    if (container.length === 0) return;
    stepId = stepId ?? step.id;
    if (match.agentId !== undefined && !participantIds.includes(match.agentId)) {
      participantIds.push(match.agentId);
    }
    container.forEach((item, index) => {
      const validated = validateDecisionCandidate(item, `Step ${step.id} decision ${String(index + 1)}`);
      errors.push(...validated.errors);
      if (validated.candidate !== undefined) candidates.push(validated.candidate);
    });
  });

  if (stepId === undefined || candidates.length === 0) return { errors };
  return {
    source: { stepId, participantIds, candidates },
    errors,
  };
};

/**
 * A declared core-decision output and a consensus decision artifact can both appear in one
 * run. Candidates merge; a subject and scope already carried is not repeated, so a replayed
 * execution produces no duplicate.
 */
export const mergeDecisionSources = (
  ...sources: readonly DecisionSourceResult[]
): DecisionSourceResult => {
  const errors = sources.flatMap((entry) => entry.errors);
  const present = sources.flatMap((entry) => entry.source ?? []);
  const [firstPresent] = present;
  if (firstPresent === undefined) return { errors };
  const seen = new Set<string>();
  const candidates: LongitudinalDecisionCandidate[] = [];
  present.forEach((source) => {
    source.candidates.forEach((candidate) => {
      const key = `${candidate.subject.trim().toLowerCase()}::${[...candidate.affectedScope].sort().join("|").toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      candidates.push(candidate);
    });
  });
  return {
    source: {
      stepId: firstPresent.stepId,
      participantIds: Array.from(new Set(present.flatMap((entry) => entry.participantIds))),
      candidates,
    },
    errors,
  };
};
