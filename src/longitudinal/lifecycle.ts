import { createHash } from "node:crypto";

import type { ModelFinding } from "../results/modelFindings";
import type {
  DecisionRecord,
  ExternalEvidenceChallenge,
  ExternalEvidenceClaimTarget,
  ExternalEvidenceRecord,
  FindingChallenge,
  FindingFixState,
  FindingHistoryEntry,
  FindingLifecycleState,
  FindingObservation,
  DecisionOption,
  HumanResolution,
  InitiativeArtifact,
  LifecycleState,
} from "./types";
import { LONGITUDINAL_SCHEMA_VERSION } from "./types";

const normalize = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/gu, " ");

const normalizePath = (value: string): string => value.replaceAll("\\", "/").trim();

export const findingIdentity = (finding: {
  subject: string;
  location?: { file: string };
}): string => {
  const scope = finding.location ? normalizePath(finding.location.file) : "";
  const digest = createHash("sha256")
    .update(`${scope} ${normalize(finding.subject)}`)
    .digest("hex");
  return `FH${digest.slice(0, 24).toUpperCase()}`;
};

export const canonicalFindingIdentity = (
  aliases: ReadonlyMap<string, string>,
  identity: string,
): string => {
  const seen = new Set<string>([identity]);
  let current = identity;
  for (;;) {
    const next = aliases.get(current);
    if (next === undefined || seen.has(next)) return current;
    seen.add(next);
    current = next;
  }
};

export const findingAliasMap = (
  aliases: readonly { aliasIdentity: string; canonicalIdentity: string }[],
): Map<string, string> =>
  new Map(aliases.map((alias) => [alias.aliasIdentity, alias.canonicalIdentity]));

const FIX_STATE_ORDER: FindingFixState[] = [
  "awaitingFix",
  "fixRunning",
  "fixApplied",
  "verified",
];

export const furthestFixState = (
  left: FindingFixState | undefined,
  right: FindingFixState | undefined,
): FindingFixState | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return FIX_STATE_ORDER.indexOf(left) >= FIX_STATE_ORDER.indexOf(right) ? left : right;
};

export const mergeConflict = (
  canonical: FindingHistoryEntry,
  absorbed: FindingHistoryEntry,
): string | undefined => {
  const canonicalAction = canonical.humanResolution?.action;
  const absorbedAction = absorbed.humanResolution?.action;
  if (
    canonicalAction !== undefined &&
    absorbedAction !== undefined &&
    canonicalAction !== absorbedAction
  ) {
    return `you resolved one as ${canonicalAction} and the other as ${absorbedAction}; resolve them the same way before merging`;
  }
  return undefined;
};

export const mergeFindingEntries = (
  canonical: FindingHistoryEntry,
  absorbed: FindingHistoryEntry,
): FindingHistoryEntry => {
  const fixState = furthestFixState(canonical.fixState, absorbed.fixState);
  const humanResolution = canonical.humanResolution ?? absorbed.humanResolution;
  return withActionability({
    ...canonical,
    state: canonical.humanResolution === undefined && absorbed.humanResolution !== undefined
      ? absorbed.state
      : canonical.state,
    fixState: undefined,
    ...(fixState === undefined ? {} : { fixState }),
    humanResolution: undefined,
    ...(humanResolution === undefined ? {} : { humanResolution }),
    messageHistory: Array.from(new Set([
      ...canonical.messageHistory,
      ...absorbed.messageHistory,
    ])),
    firstCycleId: absorbed.firstSeenAt < canonical.firstSeenAt
      ? absorbed.firstCycleId
      : canonical.firstCycleId,
    firstSeenAt: absorbed.firstSeenAt < canonical.firstSeenAt
      ? absorbed.firstSeenAt
      : canonical.firstSeenAt,
    lastCycleId: absorbed.lastSeenAt > canonical.lastSeenAt
      ? absorbed.lastCycleId
      : canonical.lastCycleId,
    lastSeenAt: absorbed.lastSeenAt > canonical.lastSeenAt
      ? absorbed.lastSeenAt
      : canonical.lastSeenAt,
    occurrences: canonical.occurrences + absorbed.occurrences,
    notObservedCycleIds: Array.from(new Set([
      ...canonical.notObservedCycleIds,
      ...absorbed.notObservedCycleIds,
    ])),
    evidence: Array.from(new Set([...canonical.evidence, ...absorbed.evidence])),
    challenges: Array.from(new Set([...canonical.challenges, ...absorbed.challenges])),
    challengeHistory: [...canonical.challengeHistory, ...absorbed.challengeHistory],
    resolutionHistory: [
      ...canonical.resolutionHistory,
      ...absorbed.resolutionHistory,
      ...(absorbed.humanResolution === undefined || absorbed.humanResolution === humanResolution
        ? []
        : [absorbed.humanResolution]),
    ],
  });
};

const SEPARATOR = "\u0000";

const normalizedScope = (scope: readonly string[]): string =>
  [...scope].map((item) => normalize(normalizePath(item))).sort().join(SEPARATOR);

export const decisionLogicalIdentity = (
  subject: string,
  affectedScope: readonly string[],
): string =>
  `DL${createHash("sha256")
    .update(`${normalize(subject)}${SEPARATOR}${normalizedScope(affectedScope)}`)
    .digest("hex")
    .slice(0, 22)
    .toUpperCase()}`;

export type DecisionMaterial = {
  question: string;
  affectedScope: readonly string[];
  options: readonly DecisionOption[];
  tradeOffs: readonly string[];
  recommendation?: string;
  evidence: readonly string[];
};

export const decisionMaterialDigest = (material: DecisionMaterial): string =>
  createHash("sha256")
    .update(JSON.stringify({
      question: normalize(material.question),
      affectedScope: [...material.affectedScope].map(normalize).sort(),
      options: [...material.options]
        .map((option) => ({
          id: normalize(option.id),
          summary: normalize(option.summary),
          tradeOffs: [...option.tradeOffs].map(normalize).sort(),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      tradeOffs: [...material.tradeOffs].map(normalize).sort(),
      recommendation: material.recommendation === undefined
        ? null
        : normalize(material.recommendation),
      evidence: [...material.evidence].map(normalize).sort(),
    }))
    .digest("hex")
    .slice(0, 32)
    .toUpperCase();

export const decisionMaterialDelta = (
  previous: DecisionMaterial,
  next: DecisionMaterial,
): string[] => {
  const changed = (field: string, before: unknown, after: unknown): string[] =>
    JSON.stringify(before) === JSON.stringify(after) ? [] : [`${field} changed`];
  return [
    ...changed("question", normalize(previous.question), normalize(next.question)),
    ...changed(
      "affected scope",
      [...previous.affectedScope].map(normalize).sort(),
      [...next.affectedScope].map(normalize).sort(),
    ),
    ...changed("options", previous.options, next.options),
    ...changed(
      "trade-offs",
      [...previous.tradeOffs].map(normalize).sort(),
      [...next.tradeOffs].map(normalize).sort(),
    ),
    ...changed(
      "recommendation",
      previous.recommendation === undefined ? null : normalize(previous.recommendation),
      next.recommendation === undefined ? null : normalize(next.recommendation),
    ),
    ...addedValues([...previous.evidence], [...next.evidence]).map((item) => `new evidence: ${item}`),
    ...addedValues([...next.evidence], [...previous.evidence])
      .map((item) => `withdrawn evidence: ${item}`),
  ];
};

const OPEN_STATES: ReadonlySet<FindingLifecycleState> = new Set([
  "new", "repeated", "accepted", "unresolved", "regressed", "reopened",
]);

export const findingIsOpen = (entry: FindingHistoryEntry): boolean =>
  OPEN_STATES.has(entry.state);

export const findingWasHumanAccepted = (entry: {
  humanResolution?: HumanResolution | undefined;
}): boolean => entry.humanResolution?.action === "accept";

export const findingHasMultiParticipantChallenge = (entry: {
  challengeHistory: FindingChallenge[];
}): boolean => entry.challengeHistory.some(
  (challenge) => new Set(challenge.participantIds).size > 1,
);

export const findingIsActionable = (entry: {
  state: FindingLifecycleState;
  challengeHistory: FindingChallenge[];
  humanResolution?: HumanResolution | undefined;
}): boolean => {
  if (entry.state !== "accepted") return false;
  if (entry.humanResolution !== undefined) return findingWasHumanAccepted(entry);
  return findingHasMultiParticipantChallenge(entry);
};

export const findingNeedsRuling = (entry: {
  state: FindingLifecycleState;
  challengeHistory: FindingChallenge[];
  humanResolution?: HumanResolution | undefined;
}): boolean =>
  entry.state === "unresolved" &&
  entry.humanResolution === undefined &&
  findingHasMultiParticipantChallenge(entry);

export const findingNeedsFix = (entry: {
  state: FindingLifecycleState;
  challengeHistory: FindingChallenge[];
  humanResolution?: HumanResolution | undefined;
  fixState?: FindingFixState | undefined;
}): boolean =>
  findingIsActionable(entry) &&
  entry.fixState !== "verified";

const dispositionState = (
  disposition: ModelFinding["disposition"],
): FindingLifecycleState =>
  disposition === "accepted"
    ? "accepted"
    : disposition === "rejected"
      ? "rejected"
      : disposition === "unresolved"
        ? "unresolved"
        : "repeated";

const addedValues = (previous: string[], next: string[]): string[] => {
  const seen = new Set(previous.map(normalize));
  return next.filter((value) => !seen.has(normalize(value)));
};

const challengesFor = (
  finding: ModelFinding,
  cycleId: string,
  recordedAt: string,
): FindingChallenge[] =>
  finding.challenges.map((challenge) => ({
    cycleId,
    participantIds: finding.provenance.participantIds,
    text: challenge,
    recordedAt,
  }));

const withActionability = (entry: FindingHistoryEntry): FindingHistoryEntry => {
  const actionable = findingIsActionable(entry);
  return {
    ...entry,
    actionable,
    ...(actionable && entry.fixState === undefined ? { fixState: "awaitingFix" } : {}),
  };
};

export const observationOf = (finding: ModelFinding): FindingObservation => ({
  message: finding.message,
  evidence: [...finding.evidence],
  challenges: [...finding.challenges],
  ...(finding.severity === undefined ? {} : { severity: finding.severity }),
  ...(finding.location === undefined ? {} : { location: finding.location }),
});

export const observationBaseline = (entry: FindingHistoryEntry): FindingObservation =>
  entry.latestObservation ?? {
    message: entry.message,
    evidence: [...entry.evidence],
    challenges: [...entry.challenges],
    ...(entry.severity === undefined ? {} : { severity: entry.severity }),
    ...(entry.location === undefined ? {} : { location: entry.location }),
  };

const locationLabel = (location: FindingObservation["location"]): string =>
  location === undefined
    ? "none"
    : `${normalizePath(location.file)}:${String(location.startLine ?? 0)}-${String(location.endLine ?? location.startLine ?? 0)}`;

export const observationDelta = (
  previous: FindingObservation,
  next: FindingObservation,
): string[] => [
  ...addedValues(previous.evidence, next.evidence),
  ...addedValues(next.evidence, previous.evidence).map((item) => `withdrawn evidence: ${item}`),
  ...addedValues(previous.challenges, next.challenges),
  ...addedValues(next.challenges, previous.challenges)
    .map((item) => `withdrawn challenge: ${item}`),
  ...(normalize(previous.message) === normalize(next.message) ? [] : [next.message]),
  ...(previous.severity === next.severity
    ? []
    : [`severity: ${next.severity ?? "none"}`]),
  ...(locationLabel(previous.location) === locationLabel(next.location)
    ? []
    : [`location: ${locationLabel(next.location)}`]),
];

export const newFindingHistoryEntry = (input: {
  initiativeId: string;
  cycleId: string;
  recordedAt: string;
  finding: ModelFinding;
}): FindingHistoryEntry => {
  const { finding, cycleId, recordedAt } = input;
  const challengeHistory = challengesFor(finding, cycleId, recordedAt);
  const state: FindingLifecycleState = finding.disposition === "proposed"
    ? "new"
    : dispositionState(finding.disposition);
  return withActionability({
    schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
    identity: findingIdentity(finding),
    initiativeId: input.initiativeId,
    subject: finding.subject,
    message: finding.message,
    messageHistory: [finding.message],
    ...(finding.severity === undefined ? {} : { severity: finding.severity }),
    ...(finding.location === undefined ? {} : { location: finding.location }),
    state,
    notObservedCycleIds: [],
    firstCycleId: cycleId,
    lastCycleId: cycleId,
    firstSeenAt: recordedAt,
    lastSeenAt: recordedAt,
    occurrences: 1,
    evidence: finding.evidence,
    challenges: finding.challenges,
    challengeHistory,
    materialDelta: [],
    actionable: false,
    resolutionHistory: [],
    latestObservation: observationOf(finding),
  });
};

export const mergeFindingIntoHistory = (input: {
  entry: FindingHistoryEntry;
  finding: ModelFinding;
  cycleId: string;
  recordedAt: string;
}): FindingHistoryEntry => {
  const { entry, finding, cycleId, recordedAt } = input;
  const observation = observationOf(finding);
  const materialDelta = observationDelta(observationBaseline(entry), observation);
  const observed = dispositionState(finding.disposition);
  const closed = entry.humanResolution !== undefined || entry.state === "rejected";
  const reopened = materialDelta.length > 0 && closed;
  const state: FindingLifecycleState = entry.state === "resolved"
    ? "regressed"
    : reopened
      ? "reopened"
      : closed
        ? entry.state
        : observed;
  const { severity: _severity, location: _location, ...withoutProjection } = entry;
  // EX-G6-04. A finding that is being reported again is a finding whose fix did not hold, so
  // whatever was verified about that fix is no longer true of the code in front of us. Carrying
  // the old `fixState` through left it reading as fixed and verified while it was regressed —
  // and the fix action is gated on exactly that value, so the one finding that needed fixing was
  // the one offering no way to fix it. The proof that a fix once passed stays where it was
  // recorded, in the run and its verification records; what does not survive is the claim that
  // it still holds.
  const invalidatedFixState = state === "regressed" || state === "reopened";
  return withActionability({
    ...withoutProjection,
    ...(invalidatedFixState && entry.fixState !== undefined ? { fixState: "awaitingFix" } : {}),
    subject: finding.subject,
    message: observation.message,
    messageHistory: Array.from(new Set([...entry.messageHistory, finding.message])),
    ...(observation.severity === undefined ? {} : { severity: observation.severity }),
    ...(observation.location === undefined ? {} : { location: observation.location }),
    state,
    notObservedCycleIds: entry.notObservedCycleIds.filter((id) => id !== cycleId),
    lastCycleId: cycleId,
    lastSeenAt: recordedAt,
    occurrences: entry.occurrences + 1,
    evidence: Array.from(new Set([...entry.evidence, ...finding.evidence])),
    challenges: Array.from(new Set([...entry.challenges, ...finding.challenges])),
    challengeHistory: [...entry.challengeHistory, ...challengesFor(finding, cycleId, recordedAt)],
    materialDelta,
    latestObservation: observation,
    ...(reopened && entry.humanResolution !== undefined
      ? {
          humanResolution: undefined,
          resolutionHistory: [...entry.resolutionHistory, entry.humanResolution],
        }
      : {}),
  });
};

export const markFindingNotObserved = (
  entry: FindingHistoryEntry,
  cycleId: string,
): FindingHistoryEntry =>
  withActionability({
    ...entry,
    notObservedCycleIds: Array.from(new Set([...entry.notObservedCycleIds, cycleId])),
    materialDelta: [],
  });

export const resolveFindingWithControllerEvidence = (
  entry: FindingHistoryEntry,
  input: { evidence: string[]; cycleId: string; recordedAt: string },
): FindingHistoryEntry | undefined => {
  const evidence = input.evidence.map((item) => item.trim()).filter((item) => item.length > 0);
  if (evidence.length === 0) return undefined;
  return withActionability({
    ...entry,
    state: "resolved",
    lastCycleId: input.cycleId,
    lastSeenAt: input.recordedAt,
    evidence: Array.from(new Set([...entry.evidence, ...evidence])),
    materialDelta: [],
  });
};

export type FindingHistoryFold = {
  history: FindingHistoryEntry[];
  newIdentities: string[];
  repeatedIdentities: string[];
  resolvedIdentities: string[];
  regressedIdentities: string[];
  reopenedIdentities: string[];
  notObservedIdentities: string[];
};

export const foldFindingsIntoHistory = (input: {
  initiativeId: string;
  cycleId: string;
  recordedAt: string;
  history: readonly FindingHistoryEntry[];
  findings: readonly ModelFinding[];
  freshReview: boolean;
  aliases?: ReadonlyMap<string, string>;
}): FindingHistoryFold => {
  const aliases = input.aliases ?? new Map<string, string>();
  const byIdentity = new Map(input.history.map((entry) => [entry.identity, entry]));
  const seen = new Set<string>();
  const newIdentities: string[] = [];
  const repeatedIdentities: string[] = [];
  const regressedIdentities: string[] = [];
  const reopenedIdentities: string[] = [];

  input.findings.forEach((finding) => {
    const identity = canonicalFindingIdentity(aliases, findingIdentity(finding));
    seen.add(identity);
    const existing = byIdentity.get(identity);
    if (existing === undefined) {
      const created = newFindingHistoryEntry({
        initiativeId: input.initiativeId,
        cycleId: input.cycleId,
        recordedAt: input.recordedAt,
        finding,
      });
      byIdentity.set(identity, { ...created, identity });
      newIdentities.push(identity);
      return;
    }
    const merged = mergeFindingIntoHistory({
      entry: existing,
      finding,
      cycleId: input.cycleId,
      recordedAt: input.recordedAt,
    });
    byIdentity.set(identity, merged);
    if (merged.state === "regressed") regressedIdentities.push(identity);
    else if (merged.state === "reopened") reopenedIdentities.push(identity);
    else repeatedIdentities.push(identity);
  });

  const notObservedIdentities: string[] = [];
  const resolvedIdentities: string[] = [];
  if (input.freshReview) {
    input.history.forEach((entry) => {
      if (seen.has(entry.identity) || !findingIsOpen(entry)) return;
      byIdentity.set(entry.identity, markFindingNotObserved(entry, input.cycleId));
      notObservedIdentities.push(entry.identity);
    });
  }

  return {
    history: [...byIdentity.values()],
    newIdentities,
    repeatedIdentities,
    resolvedIdentities,
    regressedIdentities,
    reopenedIdentities,
    notObservedIdentities,
  };
};

const resolutionState = (
  action: HumanResolution["action"],
  current: LifecycleState,
): LifecycleState =>
  action === "accept"
    ? "accepted"
    : action === "reject"
      ? "rejected"
      : action === "defer"
        ? "deferred"
        : action === "supersede"
          ? "superseded"
          : current === "superseded" ? "superseded" : "proposed";

const nextResolution = (
  current: HumanResolution | undefined,
  resolution: HumanResolution,
  history: readonly HumanResolution[] | undefined,
): { humanResolution?: HumanResolution | undefined; resolutionHistory: HumanResolution[] } => {
  const previous = [...(history ?? [])];
  return resolution.action === "reopen"
    ? { resolutionHistory: current === undefined ? previous : [...previous, current] }
    : { humanResolution: resolution, resolutionHistory: previous };
};

export const resolveArtifact = (
  artifact: InitiativeArtifact,
  resolution: HumanResolution,
): InitiativeArtifact => ({
  ...artifact,
  state: resolutionState(resolution.action, artifact.state),
  ...(resolution.supersededById === undefined
    ? {}
    : { supersededById: resolution.supersededById }),
  humanResolution: undefined,
  ...nextResolution(artifact.humanResolution, resolution, artifact.resolutionHistory),
  updatedAt: resolution.resolvedAt,
});

export const resolveDecision = (
  decision: DecisionRecord,
  resolution: HumanResolution,
): DecisionRecord => ({
  ...decision,
  state: resolutionState(resolution.action, decision.state),
  ...(resolution.supersededById === undefined
    ? {}
    : { supersededById: resolution.supersededById }),
  ...(resolution.action === "reopen" && resolution.reason !== undefined
    ? { reopenReason: resolution.reason }
    : {}),
  materialEvidenceDelta: resolution.action === "reopen"
    ? Array.from(new Set([
        ...decision.materialEvidenceDelta,
        ...(resolution.materialEvidenceDelta ?? []),
      ]))
    : decision.materialEvidenceDelta,
  humanResolution: undefined,
  ...nextResolution(decision.humanResolution, resolution, decision.resolutionHistory),
  updatedAt: resolution.resolvedAt,
});

export const resolveFinding = (
  entry: FindingHistoryEntry,
  resolution: HumanResolution,
  cycleId?: string,
): FindingHistoryEntry => {
  const state: FindingLifecycleState = resolution.action === "accept"
    ? "accepted"
    : resolution.action === "reject"
      ? "rejected"
      : resolution.action === "defer"
        ? "unresolved"
        : resolution.action === "supersede"
          ? "resolved"
          : "reopened";
  // EX-A5-R05. Reopening says the finding is live again, so the claim that its fix is verified is
  // no longer current: a reopened finding still marked verified is excluded from the outstanding
  // accepted findings and offers no Fix control, and Reopen followed by Accept produced exactly
  // that. Only the verification is withdrawn — the work state falls back to the fix having been
  // applied, and the fix runs themselves are separate records and are untouched, so what was done
  // survives while the claim that it held does not.
  const fixState: FindingFixState | undefined = resolution.action === "reopen"
    ? entry.fixState === "verified" ? "fixApplied" : entry.fixState
    : resolution.action === "accept"
      ? entry.fixState ?? "awaitingFix"
      : (resolution.action === "reject" || resolution.action === "supersede") &&
          entry.fixState === "awaitingFix"
        ? undefined
        : entry.fixState;
  return withActionability({
    ...entry,
    state,
    fixState: undefined,
    ...(fixState === undefined ? {} : { fixState }),
    humanResolution: undefined,
    ...nextResolution(entry.humanResolution, resolution, entry.resolutionHistory),
    ...(cycleId === undefined ? {} : { lastCycleId: cycleId }),
    lastSeenAt: resolution.resolvedAt,
    materialDelta: resolution.action === "reopen"
      ? Array.from(new Set([
          ...entry.materialDelta,
          ...(resolution.materialEvidenceDelta ?? []),
        ]))
      : entry.materialDelta,
  });
};


// A piece of external evidence is identified by where it came from and what it is claimed
// against. The same document cited against two different targets is two records, because a
// human rules on the pairing, not on the document.
const claimTargetKey = (target: ExternalEvidenceClaimTarget): string =>
  target.kind === "artifact"
    ? `artifact${SEPARATOR}${target.artifactId}`
    : target.kind === "decision"
      ? `decision${SEPARATOR}${target.decisionId}`
      : target.kind === "finding"
        ? `finding${SEPARATOR}${target.identity}`
        : "initiative";

export const externalEvidenceLogicalIdentity = (
  sourceUri: string,
  target: ExternalEvidenceClaimTarget,
): string =>
  `XE${createHash("sha256")
    .update(`${normalize(sourceUri)}${SEPARATOR}${claimTargetKey(target)}`)
    .digest("hex")
    .slice(0, 22)
    .toUpperCase()}`;

export const externalEvidenceIsStale = (
  record: Pick<ExternalEvidenceRecord, "freshnessHorizonDays" | "source">,
  now: string,
): boolean => {
  if (record.freshnessHorizonDays === undefined) return false;
  const retrieved = Date.parse(record.source.retrievedAt);
  const current = Date.parse(now);
  if (!Number.isFinite(retrieved) || !Number.isFinite(current)) return false;
  return current - retrieved > record.freshnessHorizonDays * 86_400_000;
};

export const challengeExternalEvidence = (
  record: ExternalEvidenceRecord,
  challenge: ExternalEvidenceChallenge,
): ExternalEvidenceRecord => ({
  ...record,
  challenges: [...record.challenges, challenge],
  disposition: "unresolved",
  updatedAt: challenge.recordedAt,
});

export const externalEvidenceIsContested = (
  record: Pick<ExternalEvidenceRecord, "challenges">,
): boolean =>
  new Set(record.challenges.flatMap((challenge) => challenge.participantIds)).size > 1;

// A human ruling is what settles the claim, so accepting the record is what makes its asserted
// relation its disposition. Every other action leaves the claim unsettled.
export const resolveExternalEvidence = (
  record: ExternalEvidenceRecord,
  resolution: HumanResolution,
): ExternalEvidenceRecord => ({
  ...record,
  disposition: resolution.action === "accept" ? record.relation : "unresolved",
  state: resolutionState(resolution.action, record.state),
  ...(resolution.supersededById === undefined
    ? {}
    : { supersededById: resolution.supersededById }),
  humanResolution: undefined,
  ...nextResolution(record.humanResolution, resolution, record.resolutionHistory),
  updatedAt: resolution.resolvedAt,
});

export const supersedeExternalEvidence = (
  previous: ExternalEvidenceRecord,
  next: ExternalEvidenceRecord,
): { previous: ExternalEvidenceRecord; next: ExternalEvidenceRecord } => ({
  previous: {
    ...previous,
    state: "superseded",
    supersededById: next.id,
    updatedAt: next.updatedAt,
  },
  next: { ...next, supersedesId: previous.id, revision: previous.revision + 1 },
});

export const supersedeDecision = (
  previous: DecisionRecord,
  next: DecisionRecord,
): { previous: DecisionRecord; next: DecisionRecord } => ({
  previous: {
    ...previous,
    state: "superseded",
    supersededById: next.id,
    updatedAt: next.updatedAt,
  },
  next: { ...next, supersedesId: previous.id },
});

export const supersedeArtifact = (
  previous: InitiativeArtifact,
  next: InitiativeArtifact,
): { previous: InitiativeArtifact; next: InitiativeArtifact } => ({
  previous: {
    ...previous,
    state: "superseded",
    supersededById: next.id,
    updatedAt: next.updatedAt,
  },
  next: { ...next, supersedesId: previous.id, revision: previous.revision + 1 },
});
