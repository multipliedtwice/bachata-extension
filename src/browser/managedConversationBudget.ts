export const MANAGED_CONVERSATION_MIN_BYTES = 256 * 1024;
export const MANAGED_CONVERSATION_MAX_BYTES = 32 * 1024 * 1024;
export const MANAGED_CONVERSATION_DEFAULT_BYTES = 8 * 1024 * 1024;

export const managedConversationMaxBytes = (configured?: number): number => {
  const requested = Number.isFinite(configured)
    ? Number(configured)
    : MANAGED_CONVERSATION_DEFAULT_BYTES;
  return Math.min(
    MANAGED_CONVERSATION_MAX_BYTES,
    Math.max(MANAGED_CONVERSATION_MIN_BYTES, requested),
  );
};

export const managedConversationRolloverRequired = (
  currentBytes: number,
  promptBytes: number,
  maxBytes: number,
): boolean => currentBytes + promptBytes > maxBytes;

export const MANAGED_ROLLOVER_NOTICE =
  "Bachata opened a fresh role conversation because the previous managed conversation reached its cumulative context budget. Continue from this authoritative controller state.";

export const composeManagedRolloverPrompt = (input: {
  preparedPrompt: string;
  continuationPrompt: string;
  maxBytes: number;
}): string => {
  const prompt = [
    input.preparedPrompt,
    MANAGED_ROLLOVER_NOTICE,
    input.continuationPrompt,
  ].join("\n\n");
  if (Buffer.byteLength(prompt, "utf8") > input.maxBytes) {
    throw new Error(
      `Managed conversation rehydration exceeds the ${String(input.maxBytes)} byte cumulative limit`,
    );
  }
  return prompt;
};

export const managedRolloverTaskId = (taskId: string, rolloverIndex: number): string =>
  `${taskId}:rollover:${String(rolloverIndex)}`;

export const managedFreshSessionKey = (taskId: string, agentId: string): string =>
  `${taskId}:${agentId}`;
