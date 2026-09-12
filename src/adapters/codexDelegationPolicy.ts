export const CODEX_PARTICIPANT_INSTRUCTIONS =
  "Bachata alone schedules participants, concurrency, resource leases and worktree writes. "
  + "You are exactly the single participant scheduled for this turn. Never spawn, delegate to, "
  + "resume, message or invoke a Codex subagent or collaboration tool. Never launch another "
  + "Codex process as a worker. Perform the assigned work yourself. If another participant is "
  + "needed, report that need to Bachata and stop; do not create one.";

export const codexParticipantConfiguration = () => ({
  config: { "features.multi_agent": false, "features.multi_agent_v2": false },
  baseInstructions: CODEX_PARTICIPANT_INSTRUCTIONS,
  developerInstructions: CODEX_PARTICIPANT_INSTRUCTIONS,
});

const unmanagedTool = /(?:^|[./_:])(?:spawn_agent|spawnAgent|send_input|sendInput|resume_agent|resumeAgent|close_agent|closeAgent|wait_agent|waitAgent|send_message|sendMessage|followup_task|followupTask|interrupt_agent|interruptAgent|list_agents|listAgents|collaboration|collabAgentToolCall|collab)(?:$|[./_:])/u;

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

export const unmanagedCodexDelegation = (message: Record<string, unknown>): string | undefined => {
  const params = record(message.params);
  const item = record(params?.item);
  if (item?.type === "collabAgentToolCall") return typeof item.tool === "string" ? item.tool.slice(0, 256) : "collabAgentToolCall";
  if (message.method === "turn/started" || message.method === "turn/completed") {
    const items = record(params?.turn)?.items;
    if (Array.isArray(items)) {
      for (const value of items) {
        const turnItem = record(value);
        if (turnItem?.type === "collabAgentToolCall") return typeof turnItem.tool === "string" ? turnItem.tool.slice(0, 256) : "collabAgentToolCall";
      }
    }
  }
  for (const value of [message.method, params?.tool, params?.toolName, params?.name, item?.name]) {
    if (typeof value === "string" && unmanagedTool.test(value)) return value.slice(0, 256);
  }
  return undefined;
};

export class CodexDelegationPolicyError extends Error {
  readonly code = "BACHATA_UNMANAGED_DELEGATION";

  constructor(tool: string) {
    super(`Bachata policy refused unmanaged Codex delegation: ${tool}. Only Bachata may schedule concurrent participants. The provider transport is being terminated; this run must not continue.`);
    this.name = "CodexDelegationPolicyError";
  }
}
