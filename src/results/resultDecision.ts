import type { JsonValue } from "../adapters/types";
import { boundedResultDecision } from "../conversations/eventDetail";

export type ResultDecision = {
  stepId: string;
  status: "pending" | "accepted" | "ruled" | "resolved";
  candidate?: JsonValue;
  participants: JsonValue[];
  objections: JsonValue[];
  unresolvedRisks: string[];
  ruledBy?: string;
  humanResolution?: {
    action: "acceptParticipant" | "acceptUnresolved";
    rationale: string;
    selectedParticipant?: string;
    resolvedAt: string;
  };
};

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

const copyJson = (value: unknown): JsonValue | undefined => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as JsonValue;
  } catch {
    return undefined;
  }
};

export const parseResultDecision = (value: unknown): ResultDecision | undefined => {
  const record = recordOf(boundedResultDecision(value));
  if (!record || typeof record.stepId !== "string" ||
      (record.status !== "pending" && record.status !== "accepted" && record.status !== "ruled" && record.status !== "resolved")) return undefined;
  const candidate = copyJson(record.candidate);
  const participants = copyJson(record.participants);
  const objections = copyJson(record.objections);
  const resolution = recordOf(record.humanResolution);
  const humanResolution = resolution &&
    (resolution.action === "acceptParticipant" || resolution.action === "acceptUnresolved") &&
    typeof resolution.rationale === "string" && typeof resolution.resolvedAt === "string"
    ? {
        action: resolution.action,
        rationale: resolution.rationale,
        resolvedAt: resolution.resolvedAt,
        ...(typeof resolution.selectedParticipant === "string" ? { selectedParticipant: resolution.selectedParticipant } : {}),
      } satisfies NonNullable<ResultDecision["humanResolution"]>
    : undefined;
  return {
    stepId: record.stepId,
    status: record.status,
    ...(candidate === undefined ? {} : { candidate }),
    participants: Array.isArray(participants) ? participants : [],
    objections: Array.isArray(objections) ? objections : [],
    unresolvedRisks: Array.isArray(record.unresolvedRisks)
      ? record.unresolvedRisks.filter((risk): risk is string => typeof risk === "string")
      : [],
    ...(typeof record.ruledBy === "string" ? { ruledBy: record.ruledBy } : {}),
    ...(humanResolution === undefined ? {} : { humanResolution }),
  };
};
