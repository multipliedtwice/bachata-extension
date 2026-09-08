export type ModelFindingDisposition = "proposed" | "accepted" | "rejected" | "unresolved";
export type ModelFindingSeverity = "error" | "warning" | "information";

export type ModelFindingLocation = {
  file: string;
  startLine?: number;
  endLine?: number;
};

export type ModelFindingProvenance = {
  source: "pipelineDecision" | "stepOutput" | "legacyRuling";
  stepId: string;
  participantIds: string[];
  decisionStatus?: "accepted" | "ruled";
  ruledBy?: string;
};

export type ModelFinding = {
  id: string;
  subject: string;
  message: string;
  disposition: ModelFindingDisposition;
  severity?: ModelFindingSeverity;
  location?: ModelFindingLocation;
  evidence: string[];
  challenges: string[];
  provenance: ModelFindingProvenance;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const stringList = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const values: string[] = [];
  for (const item of value) {
    const parsed = nonEmptyString(item);
    if (parsed === undefined) return undefined;
    values.push(parsed);
  }
  return Array.from(new Set(values));
};

const positiveInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

const parseLocation = (value: unknown): ModelFindingLocation | undefined | false => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return false;
  const file = nonEmptyString(value.file);
  if (file === undefined) return false;
  const startLine = value.startLine === undefined ? undefined : positiveInteger(value.startLine);
  const endLine = value.endLine === undefined ? undefined : positiveInteger(value.endLine);
  if (value.startLine !== undefined && startLine === undefined) return false;
  if (value.endLine !== undefined && endLine === undefined) return false;
  if (endLine !== undefined && startLine === undefined) return false;
  if (startLine !== undefined && endLine !== undefined && endLine < startLine) return false;
  return {
    file,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined ? {} : { endLine }),
  };
};

const isDisposition = (value: unknown): value is ModelFindingDisposition =>
  value === "proposed" || value === "accepted" || value === "rejected" || value === "unresolved";

const isSeverity = (value: unknown): value is ModelFindingSeverity =>
  value === "error" || value === "warning" || value === "information";

const parseProvenance = (value: unknown): ModelFindingProvenance | undefined => {
  if (
    !isRecord(value) ||
    (value.source !== "pipelineDecision" && value.source !== "stepOutput" && value.source !== "legacyRuling")
  ) {
    return undefined;
  }
  const stepId = nonEmptyString(value.stepId);
  const participantIds = stringList(value.participantIds);
  const decisionStatus = value.decisionStatus === "accepted" || value.decisionStatus === "ruled"
    ? value.decisionStatus
    : undefined;
  if (
    stepId === undefined ||
    participantIds === undefined ||
    (value.source !== "legacyRuling" && participantIds.length === 0) ||
    (value.source === "pipelineDecision" && decisionStatus !== "accepted" && decisionStatus !== "ruled") ||
    (value.source !== "pipelineDecision" && value.decisionStatus !== undefined)
  ) return undefined;
  const ruledBy = nonEmptyString(value.ruledBy);
  return {
    source: value.source,
    stepId,
    participantIds,
    ...(decisionStatus === undefined ? {} : { decisionStatus }),
    ...(ruledBy === undefined ? {} : { ruledBy }),
  };
};

const terminalDispositionIsSupported = (
  evidence: string[],
  challenges: string[],
  provenance: ModelFindingProvenance,
): boolean => provenance.source === "pipelineDecision" &&
  evidence.length > 0 &&
  challenges.length > 0 &&
  new Set(provenance.participantIds).size > 1;

export const parseModelFinding = (value: unknown): ModelFinding | undefined => {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  const subject = nonEmptyString(value.subject);
  const message = nonEmptyString(value.message);
  const disposition = value.disposition === undefined ? "proposed" : value.disposition;
  const evidence = stringList(value.evidence);
  const challenges = stringList(value.challenges);
  const provenance = parseProvenance(value.provenance);
  const location = parseLocation(value.location);
  if (
    id === undefined || subject === undefined || message === undefined ||
    !isDisposition(disposition) || evidence === undefined || challenges === undefined ||
    provenance === undefined || location === false ||
    (value.severity !== undefined && !isSeverity(value.severity))
  ) return undefined;
  const effectiveDisposition = disposition !== "proposed" &&
    !terminalDispositionIsSupported(evidence, challenges, provenance)
    ? "proposed"
    : disposition;
  return {
    id,
    subject,
    message,
    disposition: effectiveDisposition,
    ...(value.severity === undefined ? {} : { severity: value.severity }),
    ...(location === undefined ? {} : { location }),
    evidence,
    challenges,
    provenance,
  };
};

export const mergeModelFindings = (
  ...groups: ReadonlyArray<readonly ModelFinding[]>
): ModelFinding[] => {
  const findings = new Map<string, ModelFinding>();
  groups.flat().forEach((finding) => {
    const parsed = parseModelFinding(finding);
    if (parsed !== undefined) findings.set(parsed.id, parsed);
  });
  return [...findings.values()];
};

export const parseModelFindings = (value: unknown): ModelFinding[] =>
  Array.isArray(value)
    ? mergeModelFindings(value.flatMap((item) => {
        const finding = parseModelFinding(item);
        return finding === undefined ? [] : [finding];
      }))
    : [];

export const modelFindingsFromDecisionArtifact = (value: unknown): ModelFinding[] => {
  if (!isRecord(value)) return [];
  const stepId = nonEmptyString(value.stepId);
  const decisionStatus = value.status;
  const participants = Array.isArray(value.participants)
    ? value.participants.flatMap((participant) => {
        if (!isRecord(participant)) return [];
        const agentId = nonEmptyString(participant.agentId);
        return agentId === undefined ? [] : [agentId];
      })
    : [];
  const candidate = isRecord(value.candidate) ? value.candidate : undefined;
  if (
    stepId === undefined ||
    (decisionStatus !== "accepted" && decisionStatus !== "ruled") ||
    participants.length === 0 ||
    !Array.isArray(candidate?.findings)
  ) return [];
  const ruledBy = nonEmptyString(value.ruledBy);
  const provenance: ModelFindingProvenance = {
    source: "pipelineDecision",
    stepId,
    participantIds: Array.from(new Set(participants)),
    decisionStatus,
    ...(ruledBy === undefined ? {} : { ruledBy }),
  };
  return mergeModelFindings(candidate.findings.flatMap((item) => {
    if (!isRecord(item)) return [];
    const finding = parseModelFinding({
      ...item,
      evidence: item.evidence ?? [],
      challenges: item.challenges ?? [],
      provenance,
    });
    return finding === undefined ? [] : [finding];
  }));
};

export const modelFindingsFromStepOutputArtifact = (value: unknown): ModelFinding[] => {
  if (!isRecord(value) || !isRecord(value.value)) return [];
  const stepId = nonEmptyString(value.stepId);
  const agentId = nonEmptyString(value.agentId);
  if (stepId === undefined || agentId === undefined || !Array.isArray(value.value.findings)) return [];
  const provenance: ModelFindingProvenance = {
    source: "stepOutput",
    stepId,
    participantIds: [agentId],
  };
  return mergeModelFindings(value.value.findings.flatMap((item) => {
    if (!isRecord(item)) return [];
    const finding = parseModelFinding({
      ...item,
      evidence: item.evidence ?? [],
      challenges: item.challenges ?? [],
      provenance,
    });
    return finding === undefined ? [] : [finding];
  }));
};

const LEGACY_BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/u;
const LEGACY_LOCATION = /(?:^|[\s(`"'[])((?:\.{0,2}\/)?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z][\w]{0,15}):(\d{1,7})(?:[:-](\d{1,7}))?/u;

export const legacyModelFindingsFromRuling = (
  ruling: string | undefined,
  rulingBy?: string,
): ModelFinding[] => {
  if (ruling === undefined) return [];
  const participantIds = rulingBy === undefined ? [] : [rulingBy];
  return mergeModelFindings(ruling.split("\n").flatMap((line) => {
    const bullet = LEGACY_BULLET.exec(line);
    if (!bullet) return [];
    const message = (bullet[1] ?? "").trim();
    const locationMatch = LEGACY_LOCATION.exec(message);
    const locationFile = locationMatch?.[1];
    if (!locationMatch || locationFile === undefined) return [];
    const startLine = Number(locationMatch[2]);
    const endLine = locationMatch[3] === undefined ? startLine : Number(locationMatch[3]);
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(endLine) || endLine < startLine) {
      return [];
    }
    const finding: ModelFinding = {
      id: `legacy:${locationFile}:${String(startLine)}-${String(endLine)}:${message}`,
      subject: message,
      message,
      disposition: "proposed",
      location: { file: locationFile, startLine, endLine },
      evidence: [],
      challenges: [],
      provenance: {
        source: "legacyRuling",
        stepId: "legacy-final-ruling",
        participantIds,
      },
    };
    return [finding];
  }));
};
