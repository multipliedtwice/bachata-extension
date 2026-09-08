export type RulingProvenanceKind =
  | "unanimousConsensus"
  | "arbiterRuling"
  | "singleProvider"
  | "controllerVerification"
  | "humanResolution";

export type RulingParticipantIdentity = {
  agentId: string;
  provider?: string;
  adapter?: string;
  model?: string;
};

export type RulingProvenance = {
  kind: RulingProvenanceKind;
  participants: RulingParticipantIdentity[];
  ruledBy?: string;
  resolvedBy?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const RULING_KINDS = new Set<string>([
  "unanimousConsensus",
  "arbiterRuling",
  "singleProvider",
  "controllerVerification",
  "humanResolution",
]);

const isRulingProvenanceKind = (value: unknown): value is RulingProvenanceKind =>
  typeof value === "string" && RULING_KINDS.has(value);

export const parseRulingParticipantIdentity = (
  value: unknown,
): RulingParticipantIdentity | undefined => {
  if (!isRecord(value)) return undefined;
  const agentId = nonEmptyString(value.agentId);
  if (agentId === undefined) return undefined;
  const provider = nonEmptyString(value.provider);
  const adapter = nonEmptyString(value.adapter);
  const model = nonEmptyString(value.model);
  return {
    agentId,
    ...(provider === undefined ? {} : { provider }),
    ...(adapter === undefined ? {} : { adapter }),
    ...(model === undefined ? {} : { model }),
  };
};

const dedupeParticipants = (
  participants: RulingParticipantIdentity[],
): RulingParticipantIdentity[] => {
  const seen = new Map<string, RulingParticipantIdentity>();
  participants.forEach((participant) => {
    if (!seen.has(participant.agentId)) seen.set(participant.agentId, participant);
  });
  return [...seen.values()];
};

const provenanceIsCoherent = (value: RulingProvenance): boolean => {
  if (value.kind === "controllerVerification") {
    return value.ruledBy === undefined && value.resolvedBy === undefined;
  }
  if (value.kind === "humanResolution") {
    return value.resolvedBy !== undefined && value.ruledBy === undefined;
  }
  if (value.resolvedBy !== undefined) return false;
  if (value.kind === "arbiterRuling") {
    return value.ruledBy !== undefined &&
      value.participants.some((participant) => participant.agentId === value.ruledBy);
  }
  if (value.ruledBy !== undefined) return false;
  if (value.kind === "unanimousConsensus") return value.participants.length > 1;
  return value.participants.length === 1;
};

export const parseRulingProvenance = (value: unknown): RulingProvenance | undefined => {
  if (!isRecord(value) || !isRulingProvenanceKind(value.kind)) return undefined;
  if (value.participants !== undefined && !Array.isArray(value.participants)) return undefined;
  const parsedParticipants = (value.participants ?? []).map(parseRulingParticipantIdentity);
  if (parsedParticipants.some((participant) => participant === undefined)) return undefined;
  const participants = dedupeParticipants(
    parsedParticipants.filter((participant): participant is RulingParticipantIdentity =>
      participant !== undefined),
  );
  const ruledBy = nonEmptyString(value.ruledBy);
  const resolvedBy = nonEmptyString(value.resolvedBy);
  const provenance: RulingProvenance = {
    kind: value.kind,
    participants,
    ...(ruledBy === undefined ? {} : { ruledBy }),
    ...(resolvedBy === undefined ? {} : { resolvedBy }),
  };
  return provenanceIsCoherent(provenance) ? provenance : undefined;
};

export const rulingProvenanceFrom = (input: {
  kind: RulingProvenanceKind;
  participants?: RulingParticipantIdentity[];
  ruledBy?: string;
  resolvedBy?: string;
}): RulingProvenance | undefined => parseRulingProvenance(input);

export const legacyRulingProvenance = (
  rulingBy: string | undefined,
): RulingProvenance | undefined =>
  rulingBy === undefined
    ? undefined
    : parseRulingProvenance({
        kind: "arbiterRuling",
        participants: [{ agentId: rulingBy }],
        ruledBy: rulingBy,
      });

const identityLabel = (participant: RulingParticipantIdentity): string => {
  const provider = participant.provider ?? participant.agentId;
  const qualifiers = [participant.adapter, participant.model].filter(
    (value): value is string => value !== undefined,
  );
  return qualifiers.length === 0 ? provider : `${provider} (${qualifiers.join(" · ")})`;
};

export const rulingProvenanceParticipantLabels = (
  provenance: RulingProvenance,
): string[] => provenance.participants.map(identityLabel);

export const rulingProvenanceDetail = (provenance: RulingProvenance): string => {
  const labels = rulingProvenanceParticipantLabels(provenance);
  if (provenance.kind === "unanimousConsensus") {
    return `Unanimous consensus of ${labels.join(", ")}`;
  }
  if (provenance.kind === "arbiterRuling") {
    const arbiter = provenance.participants.find(
      (participant) => participant.agentId === provenance.ruledBy,
    );
    return `Arbiter ruling by ${arbiter ? identityLabel(arbiter) : String(provenance.ruledBy)}`;
  }
  if (provenance.kind === "singleProvider") {
    return `Single provider result from ${labels[0]}`;
  }
  if (provenance.kind === "humanResolution") {
    return `Human resolution by ${String(provenance.resolvedBy)}`;
  }
  return labels.length > 0
    ? `Controller verification over ${labels.join(", ")}`
    : "Controller verification";
};

export const rulingProvenanceRuledBy = (
  provenance: RulingProvenance | undefined,
): string | undefined => {
  if (provenance === undefined) return undefined;
  if (provenance.kind === "arbiterRuling") return provenance.ruledBy;
  if (provenance.kind === "humanResolution") return provenance.resolvedBy;
  if (provenance.kind === "singleProvider") return provenance.participants[0]?.agentId;
  return undefined;
};
