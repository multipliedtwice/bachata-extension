import { PipelineDefinition } from "../pipeline/types";

export const unattendedPipelineSafetyErrors = (
  pipeline: PipelineDefinition,
): string[] => {
  const errors: string[] = [];
  for (const agent of pipeline.agents) {
    if (agent.permissionMode === "bypassPermissions") {
      errors.push(`Agent ${agent.id} uses bypassPermissions`);
    }
  }
  for (const step of pipeline.steps) {
    if (step.humanGate !== "none") {
      errors.push(`Step ${step.id} requires a human gate (${step.humanGate})`);
    }
    if (step.type === "agent" && step.consensus && (step.consensusConfig?.onMaxRounds ?? "humanGate") === "humanGate") {
      errors.push(`Step ${step.id} consensus can fall back to a human gate`);
    }
    if (step.type !== "agent" && step.type !== "checklist") {
      continue;
    }
    for (const [participant, mode] of Object.entries(step.permissionModes ?? {})) {
      if (mode === "bypassPermissions") {
        errors.push(`Step ${step.id} participant ${participant} uses bypassPermissions`);
      }
    }
  }
  return errors;
};
