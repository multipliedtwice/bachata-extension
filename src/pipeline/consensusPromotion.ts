import type { JsonValue } from "../adapters/types";
import { jsonHash } from "./output";

export type ConsensusAcceptance = {
  stepId: string;
  round: number;
  ruling: "accepted" | "ruled";
  candidateHash: string;
  participantIds: string[];
  ruledBy?: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const identifier = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 80 &&
  /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value);

const digest = (value: unknown): value is string =>
  typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);

export const parseConsensusAcceptance = (value: unknown): ConsensusAcceptance | undefined => {
  if (!record(value) || !identifier(value.stepId) ||
      !Number.isSafeInteger(value.round) || typeof value.round !== "number" || value.round < 1 ||
      (value.ruling !== "accepted" && value.ruling !== "ruled") || !digest(value.candidateHash) ||
      !Array.isArray(value.participantIds) || value.participantIds.length === 0 ||
      value.participantIds.length > 64 || !value.participantIds.every(identifier) ||
      new Set(value.participantIds).size !== value.participantIds.length ||
      (value.ruling === "ruled" && (!identifier(value.ruledBy) || !value.participantIds.includes(value.ruledBy))) ||
      (value.ruling === "accepted" && value.ruledBy !== undefined)) return undefined;
  return {
    stepId: value.stepId,
    round: value.round,
    ruling: value.ruling,
    candidateHash: value.candidateHash,
    participantIds: [...value.participantIds],
    ...(typeof value.ruledBy === "string" ? { ruledBy: value.ruledBy } : {}),
  };
};

const boundedJson = (value: unknown): value is JsonValue => {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let items = 0;
  let bytes = 0;
  while (pending.length > 0) {
    const entry = pending.pop()!;
    if (++items > 20_000 || entry.depth > 32) return false;
    const item = entry.value;
    if (typeof item === "string") {
      if (item.length > 262_144) return false;
      bytes += Buffer.byteLength(JSON.stringify(item));
    } else if (item === null || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      bytes += 24;
    } else if (Array.isArray(item)) {
      if (item.length > 4096 || pending.length + item.length > 20_000) return false;
      bytes += item.length + 2;
      for (const child of item) pending.push({ value: child, depth: entry.depth + 1 });
    } else if (record(item)) {
      let keys = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (++keys > 256 || key.length > 256) return false;
        bytes += Buffer.byteLength(JSON.stringify(key)) + 2;
        pending.push({ value: item[key], depth: entry.depth + 1 });
      }
      bytes += 2;
    } else return false;
    if (bytes > 1_048_576) return false;
  }
  return true;
};

export const consensusAcceptanceFor = (
  decision: unknown,
  output: unknown,
  stepId: string,
): ConsensusAcceptance | undefined => {
  try {
    if (!record(decision) || decision.stepId !== stepId || !boundedJson(output) ||
        !boundedJson(decision.candidate) || !Array.isArray(decision.participants) ||
        decision.participants.length === 0 || decision.participants.length > 64) return undefined;
    const hash = jsonHash(output);
    if (decision.candidateHash !== hash || jsonHash(decision.candidate) !== hash) return undefined;
    if (decision.policy !== "unanimous" && decision.policy !== "arbiter") return undefined;
    const participants = decision.participants;
    const accepted = participants.filter((participant) => record(participant) &&
      identifier(participant.agentId) && participant.valid === true && participant.accepted === true &&
      participant.candidateHash === hash && Array.isArray(participant.validationErrors) &&
      participant.validationErrors.length === 0);
    if (decision.status === "accepted" && accepted.length !== participants.length) return undefined;
    if (decision.status === "ruled" && (decision.policy !== "arbiter" ||
        !accepted.some((participant) => participant.agentId === decision.ruledBy))) return undefined;
    return parseConsensusAcceptance({
      stepId, round: decision.round, ruling: decision.status, candidateHash: hash,
      participantIds: participants.map((participant) => record(participant) ? participant.agentId : undefined),
      ...(decision.status === "ruled" ? { ruledBy: decision.ruledBy } : {}),
    });
  } catch { return undefined; }
};

export const matchesConsensusAcceptance = (receipt: unknown, output: unknown, stepId: string): boolean => {
  try {
    const accepted = parseConsensusAcceptance(receipt);
    return accepted !== undefined && accepted.stepId === stepId && boundedJson(output) &&
      accepted.candidateHash === jsonHash(output);
  } catch { return false; }
};
