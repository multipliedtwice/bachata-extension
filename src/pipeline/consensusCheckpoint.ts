import type { PendingConsensus, PipelineOrderedAnswers } from "./runner";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const orderedAnswers = (value: unknown): PipelineOrderedAnswers | undefined => {
  if (!record(value) || !Array.isArray(value.order) || !record(value.values) ||
      value.order.length > 64 || new Set(value.order).size !== value.order.length ||
      value.order.some((item) => typeof item !== "string" || item.length === 0) ||
      Object.keys(value.values).length !== value.order.length) return undefined;
  const values: Record<string, string> = {};
  for (const agentId of value.order as string[]) {
    const answer = value.values[agentId];
    if (typeof answer !== "string") return undefined;
    values[agentId] = answer;
  }
  return { order: [...value.order] as string[], values };
};

export const parsePendingConsensus = (value: unknown): Record<string, PendingConsensus> | undefined => {
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).length > 1) return undefined;
  const parsed: Record<string, PendingConsensus> = {};
  for (const [stepId, pending] of Object.entries(value)) {
    if (!stepId || !record(pending) || !Number.isSafeInteger(pending.round) ||
        !Number.isSafeInteger(pending.roundLimit) || Number(pending.round) < 1 ||
        Number(pending.roundLimit) < 1 || Number(pending.round) > Number(pending.roundLimit) + 1 ||
        !record(pending.participants) || !Array.isArray(pending.reviewInstructions) ||
        pending.reviewInstructions.some((item) => typeof item !== "string") ||
        (pending.gateReason !== undefined && pending.gateReason !== "maxConsensusRounds" && pending.gateReason !== "invalidConsensus") ||
        (pending.gateDetail !== undefined && typeof pending.gateDetail !== "string")) return undefined;
    const sourceAnswers = orderedAnswers(pending.sourceAnswers);
    const results = orderedAnswers(pending.results);
    const participants = pending.participants;
    if (!sourceAnswers || !results || Object.keys(participants).length !== results.order.length ||
        results.order.some((agentId) => typeof participants[agentId] !== "string" || !participants[agentId]) ||
        (pending.gateReason !== undefined && results.order.length === 0) ||
        (pending.gateReason === "maxConsensusRounds" && Number(pending.round) <= Number(pending.roundLimit))) return undefined;
    parsed[stepId] = {
      round: Number(pending.round),
      roundLimit: Number(pending.roundLimit),
      sourceAnswers,
      results,
      participants: { ...pending.participants } as Record<string, string>,
      reviewInstructions: [...pending.reviewInstructions] as string[],
      ...(pending.gateReason === undefined ? {} : { gateReason: pending.gateReason }),
      ...(pending.gateDetail === undefined ? {} : { gateDetail: pending.gateDetail }),
    };
  }
  return parsed;
};
