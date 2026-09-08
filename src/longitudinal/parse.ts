import { INITIATIVE_BUNDLE_SPEC, walkBundle } from "./bundleSchema";
import {
  decisionLogicalIdentity,
  externalEvidenceLogicalIdentity,
  findingIsActionable,
} from "./lifecycle";
import { parseRulingProvenance } from "../results/rulingProvenance";
import {
  EMPTY_ACCEPTED_STATE_DELTA,
  EMPTY_ROUND_IDENTITIES,
  LONGITUDINAL_SCHEMA_VERSION,
} from "./types";
import type {
  AcceptedStateDelta,
  ArtifactType,
  AuthoredBy,
  Cycle,
  CycleBaseline,
  CycleCompletion,
  CycleType,
  CycleVerification,
  DecisionOption,
  DecisionRecord,
  DirectionRevision,
  ExternalEvidenceAuthority,
  ExternalEvidenceChallenge,
  ExternalEvidenceClaimTarget,
  ExternalEvidenceRecord,
  ExternalEvidenceRelation,
  ExternalEvidenceSource,
  FindingAlias,
  FindingChallenge,
  FindingFixRun,
  FindingFixState,
  FindingHistoryEntry,
  LongitudinalRound,
  RunCycleBinding,
  FindingLifecycleState,
  HumanResolution,
  HumanResolutionAction,
  Initiative,
  InitiativeArtifact,
  InitiativeStatus,
  LifecycleState,
  FindingObservation,
  RecordProvenance,
  ReconciliationQuestionKind,
  RoundDecisionChange,
  RoundIdentities,
  RoundReconciliation,
} from "./types";
import type { ModelFindingLocation, ModelFindingSeverity } from "../results/modelFindings";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export const textList = (value: unknown): string[] =>
  Array.isArray(value)
    ? Array.from(new Set(value.flatMap((item) => {
        const parsed = text(item);
        return parsed === undefined ? [] : [parsed];
      })))
    : [];

const positiveInteger = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;

const oneOf = <T extends string>(values: readonly T[]) =>
  (value: unknown): T | undefined =>
    typeof value === "string" && (values as readonly string[]).includes(value)
      ? (value as T)
      : undefined;

export const parseLifecycleState = oneOf<LifecycleState>([
  "proposed", "accepted", "rejected", "deferred", "superseded",
]);
export const parseInitiativeStatus = oneOf<InitiativeStatus>([
  "active", "paused", "completed", "abandoned",
]);
export const parseCycleType = oneOf<CycleType>([
  "framing", "research", "planning", "execution", "validation", "review", "debugging", "custom",
]);
export const parseCycleCompletion = oneOf<CycleCompletion>([
  "open", "completed", "abandoned",
]);
export const parseArtifactType = oneOf<ArtifactType>([
  "hypothesis", "requirement", "recommendation", "decision", "plan", "design",
  "protocol", "patch", "findingSet", "custom",
]);
export const parseFindingLifecycleState = oneOf<FindingLifecycleState>([
  "new", "repeated", "accepted", "rejected", "unresolved", "resolved", "regressed", "reopened",
]);
export const parseHumanResolutionAction = oneOf<HumanResolutionAction>([
  "accept", "reject", "defer", "supersede", "reopen",
]);
const parseAuthoredBy = oneOf<AuthoredBy>(["model", "human", "controller"]);
const parseSeverity = oneOf<ModelFindingSeverity>(["error", "warning", "information"]);

export const parseHumanResolution = (value: unknown): HumanResolution | undefined => {
  if (!isRecord(value)) return undefined;
  const action = parseHumanResolutionAction(value.action);
  const resolvedBy = text(value.resolvedBy);
  const resolvedAt = text(value.resolvedAt);
  if (action === undefined || resolvedBy === undefined || resolvedAt === undefined) {
    return undefined;
  }
  const reason = text(value.reason);
  const supersededById = text(value.supersededById);
  const materialEvidenceDelta = textList(value.materialEvidenceDelta);
  if (action === "reopen" && reason === undefined) return undefined;
  if (action === "supersede" && supersededById === undefined) return undefined;
  const parsed = {
    action,
    resolvedBy,
    resolvedAt,
    ...(reason === undefined ? {} : { reason }),
    ...(supersededById === undefined ? {} : { supersededById }),
    ...(materialEvidenceDelta.length === 0 ? {} : { materialEvidenceDelta }),
  };
  return parsed;
};

export const parseRecordProvenance = (value: unknown): RecordProvenance => {
  const source = isRecord(value) ? value : {};
  const rulingProvenance = parseRulingProvenance(source.rulingProvenance);
  const runRef = text(source.runRef);
  const cycleId = text(source.cycleId);
  const stepId = text(source.stepId);
  return {
    authoredBy: parseAuthoredBy(source.authoredBy) ?? "model",
    participantIds: textList(source.participantIds),
    ...(runRef === undefined ? {} : { runRef }),
    ...(cycleId === undefined ? {} : { cycleId }),
    ...(stepId === undefined ? {} : { stepId }),
    ...(rulingProvenance === undefined ? {} : { rulingProvenance }),
  };
};

export const parseLocation = (value: unknown): ModelFindingLocation | undefined => {
  if (!isRecord(value)) return undefined;
  const file = text(value.file);
  if (file === undefined) return undefined;
  const startLine = typeof value.startLine === "number" && Number.isInteger(value.startLine) && value.startLine > 0
    ? value.startLine
    : undefined;
  const endLine = typeof value.endLine === "number" && Number.isInteger(value.endLine) && value.endLine > 0
    ? value.endLine
    : undefined;
  return {
    file,
    ...(startLine === undefined ? {} : { startLine }),
    ...(endLine === undefined || startLine === undefined || endLine < startLine ? {} : { endLine }),
  };
};

export const parseAcceptedStateDelta = (value: unknown): AcceptedStateDelta => {
  if (!isRecord(value)) return EMPTY_ACCEPTED_STATE_DELTA;
  return {
    acceptedArtifactIds: textList(value.acceptedArtifactIds),
    rejectedArtifactIds: textList(value.rejectedArtifactIds),
    acceptedDecisionIds: textList(value.acceptedDecisionIds),
    newFindingIdentities: textList(value.newFindingIdentities),
    resolvedFindingIdentities: textList(value.resolvedFindingIdentities),
    regressedFindingIdentities: textList(value.regressedFindingIdentities),
    notObservedFindingIdentities: textList(value.notObservedFindingIdentities),
  };
};

export const parseInitiative = (value: unknown): Initiative | undefined => {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const repositoryId = text(value.repositoryId);
  const title = text(value.title);
  const goal = text(value.goal);
  const createdAt = text(value.createdAt);
  const updatedAt = text(value.updatedAt);
  if (
    id === undefined || repositoryId === undefined || title === undefined ||
    goal === undefined || createdAt === undefined || updatedAt === undefined
  ) return undefined;
  const repositoryRoot = text(value.repositoryRoot);
  const currentDirection = text(value.currentDirection);
  const currentCycleId = text(value.currentCycleId);
  const directionRevisions = parseDirectionRevisions(value.directionRevisions);
  return {
    schemaVersion: positiveInteger(value.schemaVersion, LONGITUDINAL_SCHEMA_VERSION),
    id,
    repositoryId,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    title,
    goal,
    desiredOutcome: text(value.desiredOutcome) ?? "",
    scope: textList(value.scope),
    constraints: textList(value.constraints),
    acceptanceCriteria: textList(value.acceptanceCriteria),
    ...(currentDirection === undefined ? {} : { currentDirection }),
    ...(directionRevisions.length === 0 ? {} : { directionRevisions }),
    status: parseInitiativeStatus(value.status) ?? "active",
    createdAt,
    updatedAt,
    ...(currentCycleId === undefined ? {} : { currentCycleId }),
  };
};

const parseDirectionRevisions = (value: unknown): DirectionRevision[] => {
  if (!Array.isArray(value)) return [];
  const revisions = value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const revision = positiveInteger(record.revision, 0);
    const revisionText = text(record.text);
    const author = text(record.author);
    const recordedAt = text(record.recordedAt);
    if (revision === 0 || revisionText === undefined || author === undefined ||
      recordedAt === undefined || record.source !== "human") return [];
    const rationale = text(record.rationale);
    const supporting = textList(record.supportingDecisionIds);
    const evidence = textList(record.evidence);
    return [{
      revision,
      text: revisionText,
      author,
      source: "human" as const,
      recordedAt,
      ...(rationale === undefined ? {} : { rationale }),
      ...(supporting.length === 0 ? {} : { supportingDecisionIds: supporting }),
      ...(evidence.length === 0 ? {} : { evidence }),
    }];
  });
  // A revision chain must be strictly increasing, or it is not a chain.
  return revisions.every((entry, index) => {
    const previous = revisions[index - 1];
    return previous === undefined || entry.revision > previous.revision;
  })
    ? revisions
    : [];
};

const count = (input: unknown): number =>
  typeof input === "number" && Number.isInteger(input) && input >= 0 ? input : 0;

export const parseFindingObservation = (
  value: unknown,
): FindingObservation | undefined => {
  if (!isRecord(value)) return undefined;
  const message = text(value.message);
  if (message === undefined) return undefined;
  const severity = parseSeverity(value.severity);
  const location = parseLocation(value.location);
  return {
    message,
    evidence: textList(value.evidence),
    challenges: textList(value.challenges),
    ...(severity === undefined ? {} : { severity }),
    ...(location === undefined ? {} : { location }),
  };
};

export const parseResolutionHistory = (value: unknown): HumanResolution[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const resolution = parseHumanResolution(item);
        return resolution === undefined ? [] : [resolution];
      })
    : [];

export const parseRoundDecisionChange = (
  value: unknown,
): RoundDecisionChange | undefined => {
  if (!isRecord(value)) return undefined;
  const decisionId = text(value.decisionId);
  const subject = text(value.subject);
  const to = parseLifecycleState(value.to);
  if (decisionId === undefined || subject === undefined || to === undefined) return undefined;
  const from = parseLifecycleState(value.from);
  const reason = text(value.reason);
  return {
    decisionId,
    subject,
    ...(from === undefined ? {} : { from }),
    to,
    ...(reason === undefined ? {} : { reason }),
  };
};

export const parseRoundIdentities = (value: unknown): RoundIdentities => {
  if (!isRecord(value)) return EMPTY_ROUND_IDENTITIES;
  return {
    newIdentities: textList(value.newIdentities),
    repeatedIdentities: textList(value.repeatedIdentities),
    resolvedIdentities: textList(value.resolvedIdentities),
    regressedIdentities: textList(value.regressedIdentities),
    reopenedIdentities: textList(value.reopenedIdentities),
    notObservedIdentities: textList(value.notObservedIdentities),
  };
};

const parseReconciliationQuestionKind = oneOf<ReconciliationQuestionKind>([
  "ambiguous", "split", "conflict",
]);

export const parseRoundReconciliation = (
  value: unknown,
): RoundReconciliation | undefined => {
  if (!isRecord(value)) return undefined;
  const merged = Array.isArray(value.merged)
    ? value.merged.flatMap((item) => {
        if (!isRecord(item)) return [];
        const aliasIdentity = text(item.aliasIdentity);
        const canonicalIdentity = text(item.canonicalIdentity);
        return aliasIdentity === undefined || canonicalIdentity === undefined
          ? []
          : [{ aliasIdentity, canonicalIdentity }];
      })
    : [];
  const questions = Array.isArray(value.questions)
    ? value.questions.flatMap((item) => {
        if (!isRecord(item)) return [];
        const freshIdentity = text(item.freshIdentity);
        const subject = text(item.subject);
        const kind = parseReconciliationQuestionKind(item.kind);
        const detail = text(item.detail);
        if (
          freshIdentity === undefined || subject === undefined ||
          kind === undefined || detail === undefined
        ) return [];
        const candidates = Array.isArray(item.candidates)
          ? item.candidates.flatMap((candidate) => {
              if (!isRecord(candidate)) return [];
              const identity = text(candidate.identity);
              const candidateSubject = text(candidate.subject);
              const score = typeof candidate.score === "number" && Number.isFinite(candidate.score)
                ? candidate.score
                : undefined;
              return identity === undefined || candidateSubject === undefined || score === undefined
                ? []
                : [{ identity, subject: candidateSubject, score }];
            })
          : [];
        return [{ freshIdentity, subject, kind, detail, candidates }];
      })
    : [];
  return merged.length === 0 && questions.length === 0 ? undefined : { merged, questions };
};

export const parseLongitudinalRound = (value: unknown): LongitudinalRound | undefined => {
  if (!isRecord(value)) return undefined;
  const initiativeId = text(value.initiativeId);
  const cycleId = text(value.cycleId);
  const runRef = text(value.runRef);
  const executionRef = text(value.executionRef);
  const recordedAt = text(value.recordedAt);
  if (
    initiativeId === undefined || cycleId === undefined || runRef === undefined ||
    executionRef === undefined || recordedAt === undefined
  ) return undefined;
  const reconciliation = parseRoundReconciliation(value.reconciliation);
  return {
    schemaVersion: positiveInteger(value.schemaVersion, LONGITUDINAL_SCHEMA_VERSION),
    initiativeId,
    cycleId,
    baselineEpoch: positiveInteger(value.baselineEpoch, 1),
    runRef,
    executionRef,
    freshReview: value.freshReview === true,
    recordedAt,
    newMaterialCount: count(value.newMaterialCount),
    regressionCount: count(value.regressionCount),
    notObservedCount: count(value.notObservedCount),
    materialChangeCount: count(value.materialChangeCount),
    identities: parseRoundIdentities(value.identities),
    decisionChanges: Array.isArray(value.decisionChanges)
      ? value.decisionChanges.flatMap((item) => {
          const change = parseRoundDecisionChange(item);
          return change === undefined ? [] : [change];
        })
      : [],
    ...(reconciliation === undefined ? {} : { reconciliation }),
    validationErrors: textList(value.validationErrors),
  };
};

export const parseRunCycleBinding = (value: unknown): RunCycleBinding | undefined => {
  if (!isRecord(value)) return undefined;
  const runRef = text(value.runRef);
  const initiativeId = text(value.initiativeId);
  const cycleId = text(value.cycleId);
  const boundAt = text(value.boundAt);
  if (
    runRef === undefined || initiativeId === undefined ||
    cycleId === undefined || boundAt === undefined
  ) return undefined;
  return {
    runRef,
    initiativeId,
    cycleId,
    baselineEpoch: positiveInteger(value.baselineEpoch, 1),
    freshReview: value.freshReview === true,
    boundAt,
  };
};

const parseVerificationStatus = oneOf<"passed" | "failed" | "timedOut" | "cancelled">([
  "passed", "failed", "timedOut", "cancelled",
]);

export const parseCycleBaseline = (value: unknown): CycleBaseline | undefined => {
  const legacy = text(value);
  if (legacy !== undefined) {
    return {
      commit: legacy,
      dirty: false,
      worktreeDigest: "",
      contentComplete: false,
      capturedAt: "",
    };
  }
  if (!isRecord(value)) return undefined;
  const commit = typeof value.commit === "string" ? value.commit.trim() : undefined;
  if (commit === undefined) return undefined;
  const branch = text(value.branch);
  return {
    commit,
    ...(branch === undefined ? {} : { branch }),
    dirty: value.dirty === true,
    worktreeDigest: text(value.worktreeDigest) ?? "",
    contentComplete: value.contentComplete === true,
    capturedAt: text(value.capturedAt) ?? "",
  };
};

export const parseCycleVerification = (value: unknown): CycleVerification | undefined => {
  if (!isRecord(value)) return undefined;
  const runRef = text(value.runRef);
  const recordedAt = text(value.recordedAt);
  if (runRef === undefined || recordedAt === undefined) return undefined;
  const checks = Array.isArray(value.checks)
    ? value.checks.flatMap((item) => {
        if (!isRecord(item)) return [];
        const command = text(item.command);
        const status = parseVerificationStatus(item.status);
        if (command === undefined || status === undefined) return [];
        return [{ command, status, ...(item.stale === true ? { stale: true } : {}) }];
      })
    : [];
  const baseline = parseCycleBaseline(value.baseline);
  return {
    runRef,
    baselineEpoch: positiveInteger(value.baselineEpoch, 1),
    checks,
    expected: value.expected === true,
    recordedAt,
    ...(baseline === undefined ? {} : { baseline }),
  };
};

export const parseFindingFixState = oneOf<FindingFixState>([
  "awaitingFix", "fixRunning", "fixApplied", "verified",
]);

export type ParsedInitiativeBundle = {
  bundleVersion: number;
  schemaVersion: number;
  exportedAt: string;
  initiative: Initiative;
  cycles: Cycle[];
  artifacts: InitiativeArtifact[];
  decisions: DecisionRecord[];
  findings: FindingHistoryEntry[];
  rounds: LongitudinalRound[];
  findingAliases: FindingAlias[];
  fixRuns: FindingFixRun[];
  externalEvidence: ExternalEvidenceRecord[];
};

const parseFindingAlias = (
  value: unknown,
  initiativeId: string,
): FindingAlias | undefined => {
  if (!isRecord(value)) return undefined;
  const aliasIdentity = text(value.aliasIdentity);
  const canonicalIdentity = text(value.canonicalIdentity);
  const reason = text(value.reason);
  const createdBy = text(value.createdBy);
  const createdAt = text(value.createdAt);
  if (
    aliasIdentity === undefined || canonicalIdentity === undefined ||
    reason === undefined || createdBy === undefined || createdAt === undefined
  ) return undefined;
  const owner = text(value.initiativeId);
  if (owner === undefined || owner !== initiativeId) return undefined;
  return { initiativeId, aliasIdentity, canonicalIdentity, reason, createdBy, createdAt };
};

const parseFindingFixRun = (
  value: unknown,
  initiativeId: string,
): FindingFixRun | undefined => {
  if (!isRecord(value)) return undefined;
  const identity = text(value.identity);
  const runRef = text(value.runRef);
  const state = parseFindingFixState(value.state);
  const updatedAt = text(value.updatedAt);
  if (
    identity === undefined || runRef === undefined ||
    state === undefined || updatedAt === undefined
  ) return undefined;
  const owner = text(value.initiativeId);
  if (owner === undefined || owner !== initiativeId) return undefined;
  return { initiativeId, identity, runRef, state, updatedAt };
};

export type BundleParse =
  | { bundle: ParsedInitiativeBundle; errors: [] }
  | { bundle?: undefined; errors: string[] };

export const parseInitiativeBundle = (value: unknown): BundleParse => {
  if (!isRecord(value)) return { errors: ["the file is not an initiative bundle object"] };
  const errors: string[] = [];
  const initiative = parseInitiative(value.initiative);
  const exportedAt = text(value.exportedAt);
  if (initiative === undefined) errors.push("the bundle carries no readable initiative");
  if (exportedAt === undefined) errors.push("the bundle carries no export timestamp");
  if (typeof value.bundleVersion !== "number" || !Number.isInteger(value.bundleVersion)) {
    errors.push("the bundle carries no format version");
  }
  if (initiative === undefined || exportedAt === undefined || errors.length > 0) {
    return { errors };
  }
  const strictList = <T>(
    field: string,
    source: unknown,
    parse: (item: unknown) => T | undefined,
  ): T[] => {
    if (source === undefined) {
      errors.push(`the bundle is missing its ${field}`);
      return [];
    }
    if (!Array.isArray(source)) {
      errors.push(`the bundle's ${field} is not a list`);
      return [];
    }
    const parsed: T[] = [];
    source.forEach((item, index) => {
      const value = parse(item);
      if (value === undefined) {
        errors.push(`${field} entry ${String(index + 1)} is malformed`);
        return;
      }
      parsed.push(value);
    });
    return parsed;
  };
  const eachParses = <T>(
    supplied: unknown,
    parse: (item: unknown) => T | undefined,
  ): boolean => {
    if (supplied === undefined) return true;
    if (!Array.isArray(supplied)) return false;
    return supplied.every((item) => parse(item) !== undefined);
  };
  const eachIsText = (supplied: unknown): boolean => {
    if (supplied === undefined) return true;
    if (!Array.isArray(supplied)) return false;
    return supplied.every((item) => text(item) !== undefined);
  };
  const textListsIntact = (
    item: Record<string, unknown>,
    fields: readonly string[],
  ): boolean => fields.every((field) => eachIsText(item[field]));
  const resolutionsIntact = (item: Record<string, unknown>): boolean => {
    if (
      item.humanResolution !== undefined &&
      parseHumanResolution(item.humanResolution) === undefined
    ) return false;
    return eachParses(item.resolutionHistory, parseHumanResolution);
  };
  const provenanceIntact = (item: Record<string, unknown>): boolean => {
    if (item.provenance === undefined) return true;
    if (!isRecord(item.provenance)) return false;
    const provenance = item.provenance;
    if (!eachIsText(provenance.participantIds)) return false;
    if (
      provenance.authoredBy !== undefined &&
      parseAuthoredBy(provenance.authoredBy) === undefined
    ) return false;
    if (
      provenance.rulingProvenance !== undefined &&
      parseRulingProvenance(provenance.rulingProvenance) === undefined
    ) return false;
    return true;
  };
  const strictCycle = (item: unknown): Cycle | undefined => {
    if (!isRecord(item)) return undefined;
    if (parseCycleType(item.type) === undefined) return undefined;
    if (parseCycleCompletion(item.completion) === undefined) return undefined;
    if (typeof item.sequence !== "number" || !Number.isInteger(item.sequence)) return undefined;
    if (!textListsIntact(item, ["runRefs", "inputArtifactIds", "outputArtifactIds"])) {
      return undefined;
    }
    if (item.acceptedStateDelta !== undefined) {
      if (!isRecord(item.acceptedStateDelta)) return undefined;
      if (!textListsIntact(item.acceptedStateDelta, [
        "acceptedArtifactIds",
        "rejectedArtifactIds",
        "acceptedDecisionIds",
        "newFindingIdentities",
        "resolvedFindingIdentities",
        "regressedFindingIdentities",
        "notObservedFindingIdentities",
      ])) return undefined;
    }
    if (
      item.repositoryBaseline !== undefined &&
      parseCycleBaseline(item.repositoryBaseline) === undefined
    ) return undefined;
    if (!eachParses(item.verifications, parseCycleVerification)) return undefined;
    return parseCycle(item);
  };
  const strictArtifact = (item: unknown): InitiativeArtifact | undefined => {
    if (!isRecord(item)) return undefined;
    if (!resolutionsIntact(item)) return undefined;
    if (!provenanceIntact(item)) return undefined;
    if (parseArtifactType(item.type) === undefined) return undefined;
    if (parseLifecycleState(item.state) === undefined) return undefined;
    if (!textListsIntact(item, ["evidence"])) return undefined;
    return parseInitiativeArtifact(item);
  };
  const strictDecision = (item: unknown): DecisionRecord | undefined => {
    if (!isRecord(item)) return undefined;
    if (!resolutionsIntact(item)) return undefined;
    if (!provenanceIntact(item)) return undefined;
    if (parseLifecycleState(item.state) === undefined) return undefined;
    if (!textListsIntact(item, [
      "affectedScope",
      "tradeOffs",
      "evidence",
      "materialEvidenceDelta",
    ])) return undefined;
    if (!eachParses(item.options, parseDecisionOption)) return undefined;
    return parseDecisionRecord(item);
  };
  const strictFinding = (item: unknown): FindingHistoryEntry | undefined => {
    if (!isRecord(item)) return undefined;
    if (!resolutionsIntact(item)) return undefined;
    if (parseFindingLifecycleState(item.state) === undefined) return undefined;
    if (item.fixState !== undefined && parseFindingFixState(item.fixState) === undefined) {
      return undefined;
    }
    if (!textListsIntact(item, [
      "messageHistory",
      "notObservedCycleIds",
      "evidence",
      "challenges",
      "materialDelta",
    ])) return undefined;
    if (!eachParses(item.challengeHistory, parseFindingChallenge)) return undefined;
    if (
      item.latestObservation !== undefined &&
      parseFindingObservation(item.latestObservation) === undefined
    ) return undefined;
    if (item.location !== undefined && parseLocation(item.location) === undefined) {
      return undefined;
    }
    return parseFindingHistoryEntry(item);
  };
  const strictExternalEvidence = (item: unknown): ExternalEvidenceRecord | undefined => {
    if (!isRecord(item)) return undefined;
    if (!resolutionsIntact(item)) return undefined;
    if (!provenanceIntact(item)) return undefined;
    if (parseLifecycleState(item.state) === undefined) return undefined;
    if (parseExternalEvidenceRelation(item.relation) === undefined) return undefined;
    if (parseExternalEvidenceAuthority(item.authority) === undefined) return undefined;
    if (parseExternalEvidenceSource(item.source) === undefined) return undefined;
    if (parseExternalEvidenceTarget(item.target) === undefined) return undefined;
    if (!eachParses(item.challenges, parseExternalEvidenceChallenge)) return undefined;
    return parseExternalEvidenceRecord(item);
  };
  const strictRound = (item: unknown): LongitudinalRound | undefined => {
    if (!isRecord(item)) return undefined;
    if (item.identities !== undefined) {
      if (!isRecord(item.identities)) return undefined;
      if (!textListsIntact(item.identities, [
        "newIdentities",
        "repeatedIdentities",
        "resolvedIdentities",
        "regressedIdentities",
        "reopenedIdentities",
        "notObservedIdentities",
      ])) return undefined;
    }
    if (!textListsIntact(item, ["validationErrors"])) return undefined;
    if (item.decisionChanges !== undefined) {
      if (!Array.isArray(item.decisionChanges)) return undefined;
      const intact = item.decisionChanges.every((change) => {
        if (!isRecord(change)) return false;
        if (text(change.decisionId) === undefined) return false;
        if (text(change.subject) === undefined) return false;
        if (parseLifecycleState(change.to) === undefined) return false;
        return change.from === undefined || parseLifecycleState(change.from) !== undefined;
      });
      if (!intact) return undefined;
    }
    return parseLongitudinalRound(item);
  };
  walkBundle(value, INITIATIVE_BUNDLE_SPEC, {
    onUnknownKey: (at) => {
      errors.push(`the bundle carries an unknown field at ${at}`);
    },
    onTypeError: (at, expected) => {
      errors.push(`the bundle field at ${at} is not ${expected}`);
    },
    onMissing: (at) => {
      errors.push(`the bundle is missing the required field at ${at}`);
    },
  });
  if (errors.length > 0) return { errors };
  const cycles = strictList("cycles", value.cycles, strictCycle);
  const artifacts = strictList("artifacts", value.artifacts, strictArtifact);
  const decisions = strictList("decisions", value.decisions, strictDecision);
  const findings = strictList("findings", value.findings, strictFinding);
  const rounds = strictList("rounds", value.rounds, strictRound);
  const findingAliases = strictList(
    "findingAliases",
    value.findingAliases,
    (item) => parseFindingAlias(item, initiative.id),
  );
  const fixRuns = strictList(
    "fixRuns",
    value.fixRuns,
    (item) => parseFindingFixRun(item, initiative.id),
  );
  const externalEvidence = strictList(
    "externalEvidence",
    value.externalEvidence ?? [],
    strictExternalEvidence,
  );
  const duplicate = (field: string, ids: readonly string[]): void => {
    const seen = new Set<string>();
    ids.forEach((id) => {
      if (seen.has(id)) errors.push(`the bundle repeats the ${field} id ${id}`);
      seen.add(id);
    });
  };
  duplicate("cycle", cycles.map((item) => item.id));
  duplicate("artifact", artifacts.map((item) => item.id));
  duplicate("decision", decisions.map((item) => item.id));
  duplicate("finding", findings.map((item) => item.identity));
  duplicate("cycle sequence", cycles.map((item) => String(item.sequence)));
  duplicate("merged finding", findingAliases.map((item) => item.aliasIdentity));
  duplicate("round", rounds.map((item) => `${item.cycleId}/${item.runRef}/${item.executionRef}`));
  duplicate("fix run", fixRuns.map((item) => `${item.identity}/${item.runRef}`));
  duplicate("external evidence", externalEvidence.map((item) => item.id));

  const owned = (owner: string | undefined, where: string): void => {
    if (owner !== undefined && owner !== initiative.id) {
      errors.push(`${where} belongs to initiative ${owner}, not to the one this bundle exports`);
    }
  };
  cycles.forEach((cycle) => owned(cycle.initiativeId, `cycle ${cycle.id}`));
  artifacts.forEach((artifact) => owned(artifact.initiativeId, `artifact ${artifact.id}`));
  decisions.forEach((decision) => owned(decision.initiativeId, `decision ${decision.id}`));
  findings.forEach((entry) => owned(entry.initiativeId, `finding ${entry.identity}`));
  rounds.forEach((round) => owned(round.initiativeId, `round ${round.runRef}`));
  findingAliases.forEach(
    (alias) => owned(alias.initiativeId, `merge ${alias.aliasIdentity}`));
  fixRuns.forEach((fixRun) => owned(fixRun.initiativeId, `fix run ${fixRun.runRef}`));
  externalEvidence.forEach(
    (record) => owned(record.initiativeId, `external evidence ${record.id}`));

  const cycleIds = new Set(cycles.map((item) => item.id));
  const artifactIds = new Set(artifacts.map((item) => item.id));
  const decisionIds = new Set(decisions.map((item) => item.id));
  const findingIds = new Set(findings.map((item) => item.identity));
  const historicalIds = new Set([
    ...findings.map((item) => item.identity),
    ...findingAliases.map((item) => item.aliasIdentity),
  ]);
  const requireCycle = (id: string | undefined, where: string): void => {
    if (id !== undefined && !cycleIds.has(id)) {
      errors.push(`${where} names cycle ${id}, which the bundle does not contain`);
    }
  };
  const requireArtifact = (id: string | undefined, where: string): void => {
    if (id !== undefined && !artifactIds.has(id)) {
      errors.push(`${where} names artifact ${id}, which the bundle does not contain`);
    }
  };
  const requireDecision = (id: string | undefined, where: string): void => {
    if (id !== undefined && !decisionIds.has(id)) {
      errors.push(`${where} names decision ${id}, which the bundle does not contain`);
    }
  };
  const requireFinding = (id: string, where: string): void => {
    if (!findingIds.has(id)) {
      errors.push(`${where} names finding ${id}, which the bundle does not contain`);
    }
  };
  const requireHistoricalFinding = (id: string, where: string): void => {
    if (!historicalIds.has(id)) {
      errors.push(
        `${where} names finding ${id}, which the bundle neither contains nor records as merged`,
      );
    }
  };
  requireCycle(initiative.currentCycleId, "the initiative");
  cycles.forEach((cycle) => {
    const delta = cycle.acceptedStateDelta;
    [
      delta.newFindingIdentities,
      delta.resolvedFindingIdentities,
      delta.regressedFindingIdentities,
      delta.notObservedFindingIdentities,
    ].forEach((group) => {
      group.forEach((id) => requireHistoricalFinding(id, `cycle ${cycle.id}`));
    });
    cycle.inputArtifactIds.forEach((id) => requireArtifact(id, `cycle ${cycle.id}`));
    cycle.outputArtifactIds.forEach((id) => requireArtifact(id, `cycle ${cycle.id}`));
    cycle.acceptedStateDelta.acceptedArtifactIds.forEach(
      (id) => requireArtifact(id, `cycle ${cycle.id}`));
    cycle.acceptedStateDelta.rejectedArtifactIds.forEach(
      (id) => requireArtifact(id, `cycle ${cycle.id}`));
    cycle.acceptedStateDelta.acceptedDecisionIds.forEach(
      (id) => requireDecision(id, `cycle ${cycle.id}`));
  });
  artifacts.forEach((artifact) => {
    requireCycle(artifact.cycleId, `artifact ${artifact.id}`);
    requireArtifact(artifact.supersedesId, `artifact ${artifact.id}`);
    requireArtifact(artifact.supersededById, `artifact ${artifact.id}`);
  });
  decisions.forEach((decision) => {
    requireCycle(decision.cycleId, `decision ${decision.id}`);
    requireDecision(decision.supersedesId, `decision ${decision.id}`);
    requireDecision(decision.supersededById, `decision ${decision.id}`);
  });
  artifacts.forEach((artifact) => {
    requireCycle(artifact.provenance.cycleId, `artifact ${artifact.id} provenance`);
    if (artifact.humanResolution?.supersededById !== undefined) {
      requireArtifact(artifact.humanResolution.supersededById, `artifact ${artifact.id}`);
    }
    artifact.resolutionHistory.forEach(
      (resolution) => requireArtifact(resolution.supersededById, `artifact ${artifact.id}`));
  });
  decisions.forEach((decision) => {
    requireCycle(decision.provenance.cycleId, `decision ${decision.id} provenance`);
    if (decision.humanResolution?.supersededById !== undefined) {
      requireDecision(decision.humanResolution.supersededById, `decision ${decision.id}`);
    }
    decision.resolutionHistory.forEach(
      (resolution) => requireDecision(resolution.supersededById, `decision ${decision.id}`));
  });
  findings.forEach((entry) => {
    requireCycle(entry.firstCycleId, `finding ${entry.identity}`);
    requireCycle(entry.lastCycleId, `finding ${entry.identity}`);
    entry.notObservedCycleIds.forEach((id) => requireCycle(id, `finding ${entry.identity}`));
    entry.challengeHistory.forEach(
      (challenge) => requireCycle(challenge.cycleId, `finding ${entry.identity} challenge`));
    if (entry.humanResolution?.supersededById !== undefined) {
      requireFinding(entry.humanResolution.supersededById, `finding ${entry.identity}`);
    }
    entry.resolutionHistory.forEach((resolution) => {
      if (resolution.supersededById !== undefined) {
        requireFinding(resolution.supersededById, `finding ${entry.identity}`);
      }
    });
  });
  rounds.forEach((round) => {
    requireCycle(round.cycleId, `round ${round.runRef}`);
    round.decisionChanges.forEach(
      (change) => requireDecision(change.decisionId, `round ${round.runRef}`));
    Object.values(round.identities).forEach((group) => {
      group.forEach((id) => requireHistoricalFinding(id, `round ${round.runRef}`));
    });
  });
  findingAliases.forEach((alias) => {
    if (alias.aliasIdentity === alias.canonicalIdentity) {
      errors.push(`merge ${alias.aliasIdentity} names itself as its canonical finding`);
    }
    if (findingIds.has(alias.aliasIdentity)) {
      errors.push(
        `merge ${alias.aliasIdentity} names a finding the bundle still tracks as its own record`,
      );
    }
    if (!findingIds.has(alias.canonicalIdentity)) {
      errors.push(
        `merge ${alias.aliasIdentity} names finding ${alias.canonicalIdentity}, which the bundle does not contain`,
      );
    }
  });
  fixRuns.forEach((fixRun) => {
    if (!findingIds.has(fixRun.identity)) {
      errors.push(
        `fix run ${fixRun.runRef} names finding ${fixRun.identity}, which the bundle does not contain`,
      );
    }
  });
  externalEvidence.forEach((record) => {
    requireCycle(record.cycleId, `external evidence ${record.id}`);
    if (record.target.kind === "artifact" && !artifactIds.has(record.target.artifactId)) {
      errors.push(
        `external evidence ${record.id} names artifact ${record.target.artifactId}, which the bundle does not contain`,
      );
    }
    if (record.target.kind === "decision" && !decisionIds.has(record.target.decisionId)) {
      errors.push(
        `external evidence ${record.id} names decision ${record.target.decisionId}, which the bundle does not contain`,
      );
    }
    if (record.target.kind === "finding" && !historicalIds.has(record.target.identity)) {
      errors.push(
        `external evidence ${record.id} names finding ${record.target.identity}, which the bundle does not contain`,
      );
    }
  });
  if (errors.length > 0) return { errors };
  return {
    bundle: {
      bundleVersion: value.bundleVersion as number,
      schemaVersion: positiveInteger(value.schemaVersion, LONGITUDINAL_SCHEMA_VERSION),
      exportedAt,
      initiative,
      cycles,
      artifacts,
      decisions,
      findings,
      rounds,
      findingAliases,
      fixRuns,
      externalEvidence,
    },
    errors: [],
  };
};

export const parseCycle = (value: unknown): Cycle | undefined => {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const initiativeId = text(value.initiativeId);
  const createdAt = text(value.createdAt);
  const updatedAt = text(value.updatedAt);
  if (id === undefined || initiativeId === undefined || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  const type = parseCycleType(value.type) ?? "custom";
  const customType = text(value.customType);
  const repositoryBaseline = parseCycleBaseline(value.repositoryBaseline);
  const verifications = Array.isArray(value.verifications)
    ? value.verifications.flatMap((item) => {
        const parsed = parseCycleVerification(item);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  const nextCycleTrigger = text(value.nextCycleTrigger);
  return {
    schemaVersion: positiveInteger(value.schemaVersion, LONGITUDINAL_SCHEMA_VERSION),
    id,
    sequence: positiveInteger(value.sequence, 1),
    initiativeId,
    type,
    ...(type === "custom" && customType !== undefined ? { customType } : {}),
    ...(repositoryBaseline === undefined ? {} : { repositoryBaseline }),
    baselineEpoch: positiveInteger(value.baselineEpoch, 1),
    ...(verifications.length === 0 ? {} : { verifications }),
    runRefs: textList(value.runRefs),
    inputArtifactIds: textList(value.inputArtifactIds),
    outputArtifactIds: textList(value.outputArtifactIds),
    acceptedStateDelta: parseAcceptedStateDelta(value.acceptedStateDelta),
    completion: parseCycleCompletion(value.completion) ?? "open",
    ...(nextCycleTrigger === undefined ? {} : { nextCycleTrigger }),
    createdAt,
    updatedAt,
  };
};

export const parseInitiativeArtifact = (value: unknown): InitiativeArtifact | undefined => {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const initiativeId = text(value.initiativeId);
  const cycleId = text(value.cycleId);
  const title = text(value.title);
  const createdAt = text(value.createdAt);
  const updatedAt = text(value.updatedAt);
  if (
    id === undefined || initiativeId === undefined || cycleId === undefined ||
    title === undefined || createdAt === undefined || updatedAt === undefined
  ) return undefined;
  const type = parseArtifactType(value.type) ?? "custom";
  const customType = text(value.customType);
  const supersedesId = text(value.supersedesId);
  const supersededById = text(value.supersededById);
  const humanResolution = parseHumanResolution(value.humanResolution);
  return {
    schemaVersion: positiveInteger(value.schemaVersion, LONGITUDINAL_SCHEMA_VERSION),
    id,
    initiativeId,
    cycleId,
    type,
    ...(type === "custom" && customType !== undefined ? { customType } : {}),
    title,
    body: text(value.body) ?? "",
    ...(text(value.contentDigest) === undefined
      ? {}
      : { contentDigest: text(value.contentDigest) as string }),
    revision: positiveInteger(value.revision, 1),
    state: parseLifecycleState(value.state) ?? "proposed",
    provenance: parseRecordProvenance(value.provenance),
    evidence: textList(value.evidence),
    ...(supersedesId === undefined ? {} : { supersedesId }),
    ...(supersededById === undefined ? {} : { supersededById }),
    ...(humanResolution === undefined ? {} : { humanResolution }),
    resolutionHistory: parseResolutionHistory(value.resolutionHistory),
    createdAt,
    updatedAt,
  };
};


export const parseExternalEvidenceRelation = oneOf<ExternalEvidenceRelation>([
  "supports",
  "contradicts",
  "qualifies",
]);

export const parseExternalEvidenceAuthority = oneOf<ExternalEvidenceAuthority>([
  "standard",
  "vendorDocumentation",
  "firstPartyMeasurement",
  "thirdPartyReport",
  "community",
  "unattributed",
]);

export const parseExternalEvidenceTarget = (
  value: unknown,
): ExternalEvidenceClaimTarget | undefined => {
  if (!isRecord(value)) return undefined;
  if (value.kind === "initiative") return { kind: "initiative" };
  if (value.kind === "artifact" && text(value.artifactId) !== undefined) {
    return { kind: "artifact", artifactId: text(value.artifactId) as string };
  }
  if (value.kind === "decision" && text(value.decisionId) !== undefined) {
    return { kind: "decision", decisionId: text(value.decisionId) as string };
  }
  if (value.kind === "finding" && text(value.identity) !== undefined) {
    return { kind: "finding", identity: text(value.identity) as string };
  }
  return undefined;
};

export const parseExternalEvidenceSource = (
  value: unknown,
): ExternalEvidenceSource | undefined => {
  if (!isRecord(value)) return undefined;
  const uri = text(value.uri);
  const title = text(value.title);
  const retrievedAt = text(value.retrievedAt);
  const contentDigest = text(value.contentDigest);
  if (
    uri === undefined || title === undefined
    || retrievedAt === undefined || contentDigest === undefined
  ) return undefined;
  const publisher = text(value.publisher);
  const publishedAt = text(value.publishedAt);
  return {
    uri,
    title,
    ...(publisher === undefined ? {} : { publisher }),
    ...(publishedAt === undefined ? {} : { publishedAt }),
    retrievedAt,
    contentDigest,
  };
};

export const parseExternalEvidenceChallenge = (
  value: unknown,
): ExternalEvidenceChallenge | undefined => {
  if (!isRecord(value)) return undefined;
  const cycleId = text(value.cycleId);
  const challengeText = text(value.text);
  const recordedAt = text(value.recordedAt);
  if (cycleId === undefined || challengeText === undefined || recordedAt === undefined) {
    return undefined;
  }
  return {
    cycleId,
    participantIds: textList(value.participantIds),
    text: challengeText,
    recordedAt,
  };
};

export const parseExternalEvidenceRecord = (
  value: unknown,
): ExternalEvidenceRecord | undefined => {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const initiativeId = text(value.initiativeId);
  const cycleId = text(value.cycleId);
  const claim = text(value.claim);
  const createdAt = text(value.createdAt);
  const updatedAt = text(value.updatedAt);
  const source = parseExternalEvidenceSource(value.source);
  const target = parseExternalEvidenceTarget(value.target);
  const relation = parseExternalEvidenceRelation(value.relation);
  if (
    id === undefined || initiativeId === undefined || cycleId === undefined
    || claim === undefined || createdAt === undefined || updatedAt === undefined
    || source === undefined || target === undefined || relation === undefined
  ) return undefined;
  const supersedesId = text(value.supersedesId);
  const supersededById = text(value.supersededById);
  const humanResolution = parseHumanResolution(value.humanResolution);
  const disposition = parseExternalEvidenceRelation(value.disposition);
  const horizon = value.freshnessHorizonDays;
  return {
    schemaVersion: positiveInteger(value.schemaVersion, LONGITUDINAL_SCHEMA_VERSION),
    id,
    logicalId: text(value.logicalId) ?? externalEvidenceLogicalIdentity(source.uri, target),
    revision: positiveInteger(value.revision, 1),
    initiativeId,
    cycleId,
    source,
    claim,
    relation,
    target,
    authority: parseExternalEvidenceAuthority(value.authority) ?? "unattributed",
    ...(typeof horizon === "number" && Number.isFinite(horizon) && horizon > 0
      ? { freshnessHorizonDays: Math.floor(horizon) }
      : {}),
    state: parseLifecycleState(value.state) ?? "proposed",
    disposition: disposition ?? "unresolved",
    challenges: Array.isArray(value.challenges)
      ? value.challenges
        .map(parseExternalEvidenceChallenge)
        .filter((entry): entry is ExternalEvidenceChallenge => entry !== undefined)
      : [],
    provenance: parseRecordProvenance(value.provenance),
    ...(supersedesId === undefined ? {} : { supersedesId }),
    ...(supersededById === undefined ? {} : { supersededById }),
    ...(humanResolution === undefined ? {} : { humanResolution }),
    resolutionHistory: parseResolutionHistory(value.resolutionHistory),
    createdAt,
    updatedAt,
  };
};

const parseDecisionOption = (value: unknown): DecisionOption | undefined => {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const summary = text(value.summary);
  if (id === undefined || summary === undefined) return undefined;
  return { id, summary, tradeOffs: textList(value.tradeOffs) };
};

export const parseDecisionRecord = (value: unknown): DecisionRecord | undefined => {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const initiativeId = text(value.initiativeId);
  const cycleId = text(value.cycleId);
  const subject = text(value.subject);
  const question = text(value.question);
  const createdAt = text(value.createdAt);
  const updatedAt = text(value.updatedAt);
  if (
    id === undefined || initiativeId === undefined || cycleId === undefined ||
    subject === undefined || question === undefined ||
    createdAt === undefined || updatedAt === undefined
  ) return undefined;
  const recommendation = text(value.recommendation);
  const supersedesId = text(value.supersedesId);
  const supersededById = text(value.supersededById);
  const reopenReason = text(value.reopenReason);
  const humanResolution = parseHumanResolution(value.humanResolution);
  return {
    schemaVersion: positiveInteger(value.schemaVersion, LONGITUDINAL_SCHEMA_VERSION),
    id,
    logicalId: text(value.logicalId) ??
      decisionLogicalIdentity(subject, textList(value.affectedScope)),
    revision: positiveInteger(value.revision, 1),
    occurrences: positiveInteger(value.occurrences, 1),
    initiativeId,
    cycleId,
    subject,
    affectedScope: textList(value.affectedScope),
    question,
    options: Array.isArray(value.options)
      ? value.options.flatMap((item) => {
          const option = parseDecisionOption(item);
          return option === undefined ? [] : [option];
        })
      : [],
    tradeOffs: textList(value.tradeOffs),
    ...(recommendation === undefined ? {} : { recommendation }),
    evidence: textList(value.evidence),
    state: parseLifecycleState(value.state) ?? "proposed",
    ...(humanResolution === undefined ? {} : { humanResolution }),
    provenance: parseRecordProvenance(value.provenance),
    ...(supersedesId === undefined ? {} : { supersedesId }),
    ...(supersededById === undefined ? {} : { supersededById }),
    ...(reopenReason === undefined ? {} : { reopenReason }),
    materialEvidenceDelta: textList(value.materialEvidenceDelta),
    resolutionHistory: parseResolutionHistory(value.resolutionHistory),
    createdAt,
    updatedAt,
  };
};

const parseFindingChallenge = (value: unknown): FindingChallenge | undefined => {
  if (!isRecord(value)) return undefined;
  const cycleId = text(value.cycleId);
  const challengeText = text(value.text);
  const recordedAt = text(value.recordedAt);
  if (cycleId === undefined || challengeText === undefined || recordedAt === undefined) {
    return undefined;
  }
  return {
    cycleId,
    participantIds: textList(value.participantIds),
    text: challengeText,
    recordedAt,
  };
};

export const parseFindingHistoryEntry = (value: unknown): FindingHistoryEntry | undefined => {
  if (!isRecord(value)) return undefined;
  const identity = text(value.identity);
  const initiativeId = text(value.initiativeId);
  const subject = text(value.subject);
  const message = text(value.message);
  const firstCycleId = text(value.firstCycleId);
  const lastCycleId = text(value.lastCycleId);
  const firstSeenAt = text(value.firstSeenAt);
  const lastSeenAt = text(value.lastSeenAt);
  if (
    identity === undefined || initiativeId === undefined || subject === undefined ||
    message === undefined || firstCycleId === undefined || lastCycleId === undefined ||
    firstSeenAt === undefined || lastSeenAt === undefined
  ) return undefined;
  const severity = parseSeverity(value.severity);
  const location = parseLocation(value.location);
  const humanResolution = parseHumanResolution(value.humanResolution);
  const latestObservation = parseFindingObservation(value.latestObservation);
  const fixState = parseFindingFixState(value.fixState);
  const challengeHistory = Array.isArray(value.challengeHistory)
    ? value.challengeHistory.flatMap((item) => {
        const challenge = parseFindingChallenge(item);
        return challenge === undefined ? [] : [challenge];
      })
    : [];
  const state = parseFindingLifecycleState(value.state) ?? "new";
  const parsed: FindingHistoryEntry = {
    schemaVersion: positiveInteger(value.schemaVersion, LONGITUDINAL_SCHEMA_VERSION),
    identity,
    initiativeId,
    subject,
    message,
    messageHistory: textList(value.messageHistory),
    ...(severity === undefined ? {} : { severity }),
    ...(location === undefined ? {} : { location }),
    state,
    notObservedCycleIds: textList(value.notObservedCycleIds),
    firstCycleId,
    lastCycleId,
    firstSeenAt,
    lastSeenAt,
    occurrences: positiveInteger(value.occurrences, 1),
    evidence: textList(value.evidence),
    challenges: textList(value.challenges),
    challengeHistory,
    materialDelta: textList(value.materialDelta),
    actionable: false,
    ...(fixState === undefined ? {} : { fixState }),
    ...(humanResolution === undefined ? {} : { humanResolution }),
    resolutionHistory: parseResolutionHistory(value.resolutionHistory),
    ...(latestObservation === undefined ? {} : { latestObservation }),
  };
  const actionable = findingIsActionable(parsed);
  const defaultedFixState: FindingFixState | undefined =
    actionable && parsed.fixState === undefined ? "awaitingFix" : parsed.fixState;
  return {
    ...parsed,
    actionable,
    ...(defaultedFixState === undefined ? {} : { fixState: defaultedFixState }),
  };
};
