import type { PipelineDefinition } from "../pipeline/types";

export type ExecutionContextMode = "legacy" | "localTodoStateV1";
export type ExecutionContextUnavailable = "workflow" | "providers" | "workspace" | "attachments";

export const executionContextAssignments = (pipeline: PipelineDefinition) => {
  const assigned = Object.fromEntries(pipeline.steps.flatMap((step) =>
    step.enabled && step.type === "assignRoles"
      ? step.roleAssignments.map((item) => [item.role, item.agentId])
      : []));
  return { planner: assigned.lead ?? "", worker: assigned.worker ?? "", reviewer: assigned.reviewer ?? "" };
};

export const executionContextUnavailable = (
  pipeline: PipelineDefinition | undefined,
  hasWorkspace: boolean,
  attachmentCount: number,
): ExecutionContextUnavailable | undefined => {
  if (!pipeline || pipeline.id !== "todo-implementation") return "workflow";
  const enabled = pipeline.steps.filter((step) => step.enabled);
  if (enabled.length !== 4 || enabled.some((step, index) =>
    step.id !== ["assign-roles", "lead-plan", "worker-implementation", "lead-review"][index]
    || step.humanGate !== "none"
    || (index === 0 ? step.type !== "assignRoles" : step.type !== "agent"
      || step.consensus || step.parallel || step.participants.length !== 1
      || step.participants[0] !== ["", "lead", "worker", "reviewer"][index]))) return "workflow";
  if (Object.values(executionContextAssignments(pipeline)).some((id) => {
    const adapter = pipeline.agents.find((agent) => agent.id === id)?.adapter;
    return adapter !== "claude-code" && adapter !== "codex-app-server";
  })) return "providers";
  if (!hasWorkspace) return "workspace";
  if (attachmentCount > 0) return "attachments";
  return undefined;
};
