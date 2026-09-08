import { createHash } from "node:crypto";

import type { ModelFinding } from "../results/modelFindings";
import { LONGITUDINAL_SCHEMA_VERSION } from "./types";
import type { InitiativeArtifact } from "./types";
import { byCodeUnitOn } from "../security/ordinal";

const canonicalFinding = (finding: ModelFinding): unknown => ({
  disposition: finding.disposition,
  subject: finding.subject.trim(),
  message: finding.message.trim(),
  severity: finding.severity ?? null,
  location: finding.location === undefined
    ? null
    : {
        file: finding.location.file.replaceAll("\\", "/").trim(),
        startLine: finding.location.startLine ?? null,
        endLine: finding.location.endLine ?? null,
      },
  evidence: [...finding.evidence].map((item) => item.trim()).sort(),
  challenges: [...finding.challenges].map((item) => item.trim()).sort(),
});

export const findingSetContentDigest = (findings: readonly ModelFinding[]): string =>
  createHash("sha256")
    .update(JSON.stringify(
      [...findings]
        .map(canonicalFinding)
        .sort(byCodeUnitOn((entry) => JSON.stringify(entry))),
    ))
    .digest("hex")
    .slice(0, 40)
    .toUpperCase();

const RULED_DISPOSITIONS: ReadonlySet<ModelFinding["disposition"]> = new Set([
  "accepted",
  "rejected",
  "unresolved",
]);

export const consensusRuledFindings = (
  findings: readonly ModelFinding[],
): ModelFinding[] =>
  findings.filter(
    (finding) =>
      finding.provenance.source === "pipelineDecision" &&
      RULED_DISPOSITIONS.has(finding.disposition),
  );

const locationText = (finding: ModelFinding): string => {
  if (finding.location === undefined) return "";
  const { file, startLine, endLine } = finding.location;
  const lines = startLine === undefined
    ? ""
    : endLine === undefined || endLine === startLine
      ? `:${String(startLine)}`
      : `:${String(startLine)}-${String(endLine)}`;
  return ` (${file}${lines})`;
};

export const findingSetArtifactBody = (findings: readonly ModelFinding[]): string =>
  [...findings]
    .map((finding) => ({
      finding,
      key: `${finding.location?.file ?? ""} ${finding.subject} ${finding.id}`,
    }))
    .sort(byCodeUnitOn((entry) => entry.key))
    .flatMap(({ finding }) => [
      `${finding.disposition} · ${finding.subject}${locationText(finding)}${finding.severity === undefined ? "" : ` · ${finding.severity}`}`,
      `  message: ${finding.message}`,
      ...[...finding.evidence].sort().map((item) => `  evidence: ${item}`),
      ...[...finding.challenges].sort().map((item) => `  challenge: ${item}`),
    ])
    .join("\n");

export const latestFindingSetArtifact = (
  artifacts: readonly InitiativeArtifact[],
): InitiativeArtifact | undefined =>
  artifacts
    .filter((artifact) => artifact.type === "findingSet" && artifact.supersededById === undefined)
    .reduce<InitiativeArtifact | undefined>(
      (latest, artifact) =>
        latest === undefined || artifact.revision >= latest.revision ? artifact : latest,
      undefined,
    );

export type ArtifactProduction = {
  artifact: InitiativeArtifact;
  superseded?: InitiativeArtifact;
};

export type FindingSetArtifactProduction = ArtifactProduction;

// A custom artifact's chain is its customType, not the shared "custom" bucket: two distinct
// custom chains must not supersede one another.
export const latestArtifactOfType = (
  artifacts: readonly InitiativeArtifact[],
  type: InitiativeArtifact["type"],
  customType?: string,
): InitiativeArtifact | undefined =>
  artifacts
    .filter((artifact) => artifact.type === type &&
      artifact.customType === customType &&
      artifact.supersededById === undefined)
    .reduce<InitiativeArtifact | undefined>(
      (latest, artifact) =>
        latest === undefined || artifact.revision >= latest.revision ? artifact : latest,
      undefined,
    );

export const produceTypedArtifact = (input: {
  createId: () => string;
  initiativeId: string;
  cycleId: string;
  runRef: string;
  recordedAt: string;
  type: InitiativeArtifact["type"];
  customType?: string;
  title: string;
  body: string;
  contentDigest: string;
  evidence: readonly string[];
  participantIds: readonly string[];
  stepId?: string;
  previous?: InitiativeArtifact;
}): ArtifactProduction | undefined => {
  const unchanged = input.previous !== undefined &&
    (input.previous.contentDigest === undefined
      ? input.previous.body === input.body
      : input.previous.contentDigest === input.contentDigest);
  if (unchanged) return undefined;
  const artifact: InitiativeArtifact = {
    schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
    id: input.createId(),
    initiativeId: input.initiativeId,
    cycleId: input.cycleId,
    type: input.type,
    ...(input.customType === undefined ? {} : { customType: input.customType }),
    title: input.title,
    body: input.body,
    contentDigest: input.contentDigest,
    revision: (input.previous?.revision ?? 0) + 1,
    state: "proposed",
    provenance: {
      authoredBy: "model",
      participantIds: [...input.participantIds],
      runRef: input.runRef,
      cycleId: input.cycleId,
      ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    },
    evidence: Array.from(new Set(input.evidence)),
    resolutionHistory: [],
    ...(input.previous === undefined ? {} : { supersedesId: input.previous.id }),
    createdAt: input.recordedAt,
    updatedAt: input.recordedAt,
  };
  return {
    artifact,
    ...(input.previous === undefined || input.previous.humanResolution !== undefined
      ? {}
      : {
          superseded: {
            ...input.previous,
            state: "superseded" as const,
            supersededById: artifact.id,
            updatedAt: input.recordedAt,
          },
        }),
  };
};

export const produceFindingSetArtifact = (input: {
  createId: () => string;
  initiativeId: string;
  cycleId: string;
  runRef: string;
  recordedAt: string;
  title: string;
  findings: readonly ModelFinding[];
  previous?: InitiativeArtifact;
}): FindingSetArtifactProduction | undefined => {
  const ruled = consensusRuledFindings(input.findings);
  if (ruled.length === 0) return undefined;
  const firstRuledStepId = ruled[0]?.provenance.stepId;
  return produceTypedArtifact({
    createId: input.createId,
    initiativeId: input.initiativeId,
    cycleId: input.cycleId,
    runRef: input.runRef,
    recordedAt: input.recordedAt,
    type: "findingSet",
    title: input.title,
    body: findingSetArtifactBody(ruled),
    contentDigest: findingSetContentDigest(ruled),
    evidence: ruled.flatMap((finding) => finding.evidence),
    participantIds: Array.from(
      new Set(ruled.flatMap((finding) => finding.provenance.participantIds)),
    ),
    ...(firstRuledStepId === undefined ? {} : { stepId: firstRuledStepId }),
    ...(input.previous === undefined ? {} : { previous: input.previous }),
  });
};

export const supersedeArtifactAncestors = (
  artifacts: readonly InitiativeArtifact[],
  accepted: InitiativeArtifact,
  recordedAt: string,
): InitiativeArtifact[] => {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const retire = new Map<string, InitiativeArtifact>();
  const visited = new Set<string>([accepted.id]);
  let ancestorId = accepted.supersedesId;
  while (ancestorId !== undefined && !visited.has(ancestorId)) {
    visited.add(ancestorId);
    const ancestor = byId.get(ancestorId);
    if (ancestor === undefined) break;
    if (ancestor.supersededById === undefined) retire.set(ancestor.id, ancestor);
    ancestorId = ancestor.supersedesId;
  }
  return [...retire.values()].map((artifact) => ({
    ...artifact,
    state: "superseded" as const,
    supersededById: accepted.id,
    updatedAt: recordedAt,
  }));
};

export type DeclaredArtifactPromotion = {
  type: InitiativeArtifact["type"];
  customType?: string;
  titleField?: string;
  bodyField?: string;
  evidenceField?: string;
};

const promotedText = (value: unknown): string | undefined => {
  if (typeof value === "string") return value.trim().length === 0 ? undefined : value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
};

const promotedList = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    const single = promotedText(value);
    return single === undefined ? [] : [single];
  }
  return value.flatMap((item) => {
    const text = promotedText(item);
    return text === undefined ? [] : [text];
  });
};

/**
 * Promotes one step's structured output into a typed initiative artifact, but only where the
 * pipeline declared the promotion. Output a preset did not declare stays run-local, so a
 * custom pipeline never grows durable state by accident.
 */
export const produceDeclaredArtifact = (input: {
  createId: () => string;
  initiativeId: string;
  cycleId: string;
  runRef: string;
  recordedAt: string;
  promotion: DeclaredArtifactPromotion;
  output: unknown;
  fallbackTitle: string;
  participantIds: readonly string[];
  stepId?: string;
  previous?: InitiativeArtifact;
}): ArtifactProduction | undefined => {
  if (input.promotion.type === "custom" && !input.promotion.customType) return undefined;
  // Refused at validation; refused again here so a stored pipeline predating that rule
  // cannot produce a second representation of a core decision.
  if (input.promotion.type === "decision") return undefined;
  const record = typeof input.output === "object" && input.output !== null
    ? input.output as Record<string, unknown>
    : undefined;
  const body = input.promotion.bodyField === undefined
    ? (record === undefined ? promotedText(input.output) : JSON.stringify(record, undefined, 2))
    : promotedText(record?.[input.promotion.bodyField]);
  if (body === undefined) return undefined;
  const title = (input.promotion.titleField === undefined
    ? undefined
    : promotedText(record?.[input.promotion.titleField])) ?? input.fallbackTitle;
  const evidence = input.promotion.evidenceField === undefined
    ? []
    : promotedList(record?.[input.promotion.evidenceField]);
  return produceTypedArtifact({
    createId: input.createId,
    initiativeId: input.initiativeId,
    cycleId: input.cycleId,
    runRef: input.runRef,
    recordedAt: input.recordedAt,
    type: input.promotion.type,
    ...(input.promotion.customType === undefined
      ? {}
      : { customType: input.promotion.customType }),
    title,
    body,
    contentDigest: createHash("sha256").update(body, "utf8").digest("hex"),
    evidence,
    participantIds: input.participantIds,
    ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
    ...(input.previous === undefined ? {} : { previous: input.previous }),
  });
};
