import { resolveWorkspaceWritePolicy, selectedWriteScope } from "../adapters/workspacePolicyAudit";
import { isBrowserAdapterType, roleBindingsByStep } from "../pipeline/agentAssignment";
import { pipelineParticipantPlans } from "../pipeline/runner";
import { permissionModeIntent } from "../pipeline/permissionModes";
import { validatePipelineDefinition } from "../pipeline/schema";
import type { PipelineDefinition } from "../pipeline/types";
import { turnExecutionPolicy } from "../runtime/turnStream";

export const pipelineImplementationRefusal = (
  definition: PipelineDefinition,
): string | undefined => {
  const refusal = "This workflow has no enabled participant with effective write authority; read-only workflows cannot implement changes.";
  if (!validatePipelineDefinition(definition).success) {
    return `${refusal} Fix the invalid workflow definition before starting implementation.`;
  }
  const enabled = { ...definition, steps: definition.steps.filter((step) => step.enabled) };
  const bindings = roleBindingsByStep(enabled);
  const agents = new Map(definition.agents.map((agent) => [agent.id, agent]));
  const participants = enabled.steps.flatMap((step) => pipelineParticipantPlans(
    { ...enabled, steps: [step] },
    "",
    { fromStepIndex: 0, roles: Object.fromEntries(bindings.get(step.id) ?? []) },
  ));
  const hasWriter = participants.some((participant) => participant.candidates.length > 0 &&
    participant.candidates.every((candidate) => {
      const policy = turnExecutionPolicy({ ...candidate.options, unattended: false });
      const scope = selectedWriteScope({
        writeScope: candidate.options.writeScope,
        readOnly: policy.readOnly,
        defaultScope: policy.defaultScope,
      });
      const agent = agents.get(candidate.agentId);
      const grantsWrites = agent !== undefined && (isBrowserAdapterType(agent.adapter)
        ? candidate.options.managed === true && candidate.options.managedRole === "worker"
        : permissionModeIntent(agent.adapter, candidate.options.permissionMode ?? "") === "write");
      if (scope === "configured") {
        try {
          resolveWorkspaceWritePolicy({
            task: "",
            workspaceRoot: ".",
            writeScope: scope,
            allowedPaths: candidate.options.allowedPaths ?? [],
            readOnly: policy.readOnly,
            defaultScope: policy.defaultScope,
          });
        } catch {
          return false;
        }
      }
      return !policy.readOnly && scope !== "readOnly" && agent !== undefined &&
        grantsWrites;
    }));
  return hasWriter ? undefined : refusal;
};
