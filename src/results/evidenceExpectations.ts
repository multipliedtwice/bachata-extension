import { executionSafetyLevel } from "../contract/executionContract";
import type { PipelineDefinition } from "../pipeline/types";

export type EvidenceExpectations = {
  changedFiles: boolean;
  verification: boolean;
  finalRuling: boolean;
};

export const UNKNOWN_EVIDENCE_EXPECTATIONS: EvidenceExpectations = {
  changedFiles: true,
  verification: true,
  finalRuling: true,
};

const enabledSteps = (pipeline: PipelineDefinition) =>
  (pipeline.steps ?? []).filter((step) => step.enabled);

const declaresVerification = (pipeline: PipelineDefinition): boolean =>
  (pipeline.managedPolicy?.verificationChecks ?? []).length > 0 ||
  (pipeline.roles ?? []).some((role) => (role.verificationChecks ?? []).length > 0) ||
  enabledSteps(pipeline).some((step) => step.type === "executeChecklist" && (step.checks ?? []).length > 0);

const declaresRuling = (pipeline: PipelineDefinition): boolean =>
  enabledSteps(pipeline).some((step) => step.type === "agent" && step.consensus) ||
  enabledSteps(pipeline).some((step) => step.type === "executeChecklist");

export const pipelineEvidenceExpectations = (
  pipeline: PipelineDefinition | undefined,
): EvidenceExpectations => {
  if (!pipeline) return UNKNOWN_EVIDENCE_EXPECTATIONS;
  return {
    changedFiles: executionSafetyLevel(pipeline) !== "review",
    verification: declaresVerification(pipeline),
    finalRuling: declaresRuling(pipeline),
  };
};

export const parseEvidenceExpectations = (value: unknown): EvidenceExpectations | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const flag = (item: unknown): boolean | undefined =>
    typeof item === "boolean" ? item : undefined;
  const changedFiles = flag(candidate.changedFiles);
  const verification = flag(candidate.verification);
  const finalRuling = flag(candidate.finalRuling);
  return changedFiles === undefined || verification === undefined || finalRuling === undefined
    ? undefined
    : { changedFiles, verification, finalRuling };
};
