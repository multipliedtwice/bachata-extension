import { createHash } from "node:crypto";

import type { ModelFinding } from "../results/modelFindings";
import type { VerificationResult } from "../results/projectResult";
import { baselineDrift } from "./repositoryBaseline";
import type { LongitudinalStore } from "../state/longitudinalStore";
import {
  latestArtifactOfType,
  latestFindingSetArtifact,
  produceDeclaredArtifact,
  produceFindingSetArtifact,
  produceTypedArtifact,
  supersedeArtifactAncestors,
} from "./artifacts";
import type { DeclaredArtifactPromotion } from "./artifacts";
import { compareRound, decisionChanges, saturationReport } from "./comparison";
import { reconcileFindings, roundReconciliation } from "./reconciliation";
import type { RoundComparison, SaturationReport } from "./comparison";
import type { LongitudinalDecisionSource } from "./decisionCandidates";
import { planArtifactBody, planContentDigest } from "./planCandidates";
import type { PlanSource } from "./planCandidates";
import { directionView } from "./direction";
import { parseInitiativeBundle } from "./parse";
import { resolutionIsAllowed, resolutionMatrix } from "./transitions";
import type { ResolutionMatrix } from "./transitions";
import type { DirectionView } from "./direction";
import {
  canonicalFindingIdentity,
  decisionLogicalIdentity,
  mergeConflict,
  decisionMaterialDelta,
  decisionMaterialDigest,
  findingAliasMap,
  findingIsActionable,
  foldFindingsIntoHistory,
  furthestFixState,
  mergeFindingEntries,
  challengeExternalEvidence,
  externalEvidenceIsStale,
  externalEvidenceLogicalIdentity,
  resolveArtifact,
  resolveDecision,
  resolveExternalEvidence,
  resolveFinding,
  supersedeExternalEvidence,
  resolveFindingWithControllerEvidence,
} from "./lifecycle";
import {
  EMPTY_ACCEPTED_STATE_DELTA,
  EMPTY_ROUND_IDENTITIES,
  EMPTY_ROUND_RECONCILIATION,
  LONGITUDINAL_SCHEMA_VERSION,
} from "./types";
import type {
  AcceptedStateDelta,
  Cycle,
  CycleBaseline,
  CycleType,
  CycleVerification,
  RunCycleBinding,
  AuthoredBy,
  DecisionRecord,
  ExternalEvidenceAuthority,
  ExternalEvidenceChallenge,
  ExternalEvidenceClaimTarget,
  ExternalEvidenceRecord,
  ExternalEvidenceRelation,
  ExternalEvidenceSource,
  FindingHistoryEntry,
  HumanResolution,
  HumanResolutionAction,
  FindingAlias,
  FindingFixRun,
  FindingFixState,
  DirectionRevision,
  Initiative,
  InitiativeArtifact,
  LongitudinalRound,
  LongitudinalSnapshot,
  RecordProvenance,
  RoundIdentities,
  RoundReconciliation,
} from "./types";

const MAX_CYCLE_VERIFICATIONS = 50;

export const STALE_EPOCH_NOTICE =
  "This run was started against an earlier repository candidate, so Bachata recorded it as history and did not fold it into the current candidate.";

const platformIsCaseSensitive = (): boolean => process.platform !== "win32";

export const caseFoldedRepositoryIdentities = (
  repositoryRoot: string | undefined,
): string[] =>
  process.platform === "darwin"
    ? [repositoryIdentity(repositoryRoot, { caseSensitive: false })]
    : [];

export const repositoryIdentity = (
  repositoryRoot: string | undefined,
  options: { caseSensitive?: boolean } = {},
): string => {
  const caseSensitive = options.caseSensitive ?? platformIsCaseSensitive();
  const normalized = (repositoryRoot ?? "").replaceAll("\\", "/").replace(/\/+$/u, "");
  return `REPO${createHash("sha256")
    .update(caseSensitive ? normalized : normalized.toLowerCase())
    .digest("hex")
    .slice(0, 24)
    .toUpperCase()}`;
};

export const roundIsQuiet = (round: LongitudinalRound): boolean =>
  round.newMaterialCount === 0 &&
  round.regressionCount === 0 &&
  (round.materialChangeCount ?? 0) === 0 &&
  (round.identities?.reopenedIdentities ?? []).length === 0 &&
  (round.validationErrors ?? []).length === 0;

export const quietFreshReviewCount = (
  rounds: readonly LongitudinalRound[],
): number => {
  const fresh = rounds.filter((round) => round.freshReview);
  let quiet = 0;
  for (const round of [...fresh].reverse()) {
    if (!roundIsQuiet(round)) break;
    quiet += 1;
  }
  return quiet;
};

export type LongitudinalSummary = {
  initiative?: Initiative;
  initiatives: Initiative[];
  cycles: Cycle[];
  currentCycle?: Cycle;
  artifacts: InitiativeArtifact[];
  decisions: DecisionRecord[];
  findings: FindingHistoryEntry[];
  findingAliases: FindingAlias[];
  fixRuns: FindingFixRun[];
  externalEvidence: ExternalEvidenceRecord[];
  staleExternalEvidenceIds: string[];
  latestComparison?: RoundComparison;
  reconciliation: RoundReconciliation;
  saturation: SaturationReport;
  resolutionMatrix: ResolutionMatrix;
  validationErrors: string[];
  staleRuns: Array<{ runRef: string; cycleId: string; recordedAt: string }>;
  direction: DirectionView;
};

export type LongitudinalSummaryOptions = {
  currentBaseline?: CycleBaseline;
};

export const INITIATIVE_BUNDLE_VERSION = 1;

export type InitiativeBundle = {
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

export type RoundOutcome = {
  stale: boolean;
  comparison: RoundComparison;
};

export type ResolutionTarget = "finding" | "decision" | "artifact" | "externalEvidence";

export type DeclaredArtifactSource = {
  promotion: DeclaredArtifactPromotion;
  output: unknown;
  fallbackTitle: string;
  participantIds: readonly string[];
  stepId?: string;
};

export type LongitudinalService = {
  snapshot: () => LongitudinalSnapshot;
  summary: (options?: LongitudinalSummaryOptions) => LongitudinalSummary;
  currentInitiative: () => Initiative | undefined;
  listInitiatives: () => Initiative[];
  createInitiative: (input: {
    title: string;
    goal: string;
    desiredOutcome?: string;
    scope?: string[];
    constraints?: string[];
    acceptanceCriteria?: string[];
  }) => Initiative;
  switchInitiative: (initiativeId: string) => Initiative | undefined;
  setInitiativeStatus: (
    initiativeId: string,
    status: Initiative["status"],
  ) => Initiative | undefined;
  exportInitiative: (initiativeId?: string) => InitiativeBundle | undefined;
  importInitiative: (
    value: unknown,
  ) => { ok: true; initiative: Initiative } | { ok: false; reason: string };
  currentCycle: () => Cycle | undefined;
  defineInitiative: (input: {
    title: string;
    goal: string;
    desiredOutcome?: string;
    scope?: string[];
    constraints?: string[];
    acceptanceCriteria?: string[];
    repositoryRoot?: string;
  }) => Initiative;
  setDirection: (
    direction: string,
    options?: { rationale?: string; supportingDecisionIds?: string[]; evidence?: string[] },
  ) => Initiative | undefined;
  startCycle: (input: {
    type: CycleType;
    customType?: string;
    repositoryBaseline?: CycleBaseline;
  }) => Cycle | undefined;
  rebaseline: (baseline: CycleBaseline) => Cycle | undefined;
  recordVerification: (input: {
    runRef: string;
    checks: readonly VerificationResult[];
    expected: boolean;
    baseline?: CycleBaseline;
  }) => Cycle | undefined;
  boundInitiativeId: (runRef: string) => string | undefined;
  isScopedFixRun: (runRef: string) => boolean;
  rounds: (cycleId?: string) => LongitudinalRound[];
  runBinding: (runRef: string) => RunCycleBinding | undefined;
  bindRun: (input: {
    runRef: string;
    cycleId?: string;
    freshReview: boolean;
  }) => Cycle | undefined;
  recordRound: (input: {
    runRef: string;
    executionRef: string;
    findings: readonly ModelFinding[];
    decisionSource?: LongitudinalDecisionSource;
    planSource?: PlanSource;
    declaredArtifacts?: readonly DeclaredArtifactSource[];
    validationErrors?: readonly string[];
    freshReview?: boolean;
  }) => RoundOutcome | undefined;
  closeCycle: (nextCycleTrigger?: string) => Cycle | undefined;
  findingAliases: () => FindingAlias[];
  mergeFindings: (input: {
    absorbedIdentity: string;
    canonicalIdentity: string;
    reason: string;
    resolvedBy: string;
  }) => { ok: true } | { ok: false; reason: string };
  unmergeFinding: (aliasIdentity: string) => { ok: true } | { ok: false; reason: string };
  fixRuns: () => FindingFixRun[];
  linkFixRun: (input: {
    identity: string;
    runRef: string;
  }) => { ok: true } | { ok: false; reason: string };
  recordFixOutcome: (input: {
    runRef: string;
    state: FindingFixState;
  }) => string[];
  recordAppliedWork: (input: {
    runRef: string;
    title: string;
    stagedFiles: readonly string[];
    targetBranch: string;
  }) => { ok: true; identities: string[]; artifactId?: string } | { ok: false; reason: string };
  saveDecisions: (decisions: readonly DecisionRecord[]) => void;
  saveArtifacts: (artifacts: readonly InitiativeArtifact[]) => void;
  recordPatchArtifact: (input: {
    runRef: string;
    title: string;
    stagedFiles: readonly string[];
    targetBranch: string;
    findingIdentities: readonly string[];
  }) => InitiativeArtifact | undefined;
  recordExternalEvidence: (input: {
    source: ExternalEvidenceSource;
    claim: string;
    relation: ExternalEvidenceRelation;
    target: ExternalEvidenceClaimTarget;
    authority: ExternalEvidenceAuthority;
    freshnessHorizonDays?: number;
    // Who read the source and wrote the claim. A human recording evidence by hand is not a
    // model production, and the record must not say it was.
    authoredBy?: AuthoredBy;
    participantIds?: readonly string[];
    runRef?: string;
  }) => ExternalEvidenceRecord | undefined;
  challengeExternalEvidence: (input: {
    id: string;
    text: string;
    participantIds: readonly string[];
  }) => boolean;
  resolve: (input: {
    target: ResolutionTarget;
    id: string;
    action: HumanResolutionAction;
    resolvedBy: string;
    reason?: string;
    supersededById?: string;
    materialEvidenceDelta?: string[];
  }) => boolean;
};

/**
 * The summary a window shows when no longitudinal state has been recorded yet — for example a
 * read-only window opened before the writer created the catalog. It is the same shape the
 * service produces, so the product renders one Direction view rather than two.
 */
export const emptyLongitudinalSummary = (): LongitudinalSummary => {
  const saturation = saturationReport({
    quietFreshReviews: 0,
    history: [],
    decisions: [],
    checks: [],
    verificationExpected: false,
  });
  return {
    initiatives: [],
    cycles: [],
    artifacts: [],
    decisions: [],
    findings: [],
    findingAliases: [],
    fixRuns: [],
    externalEvidence: [],
    staleExternalEvidenceIds: [],
    reconciliation: EMPTY_ROUND_RECONCILIATION,
    saturation,
    resolutionMatrix: resolutionMatrix(),
    validationErrors: [],
    staleRuns: [],
    direction: directionView({ decisions: [], history: [], saturation }),
  };
};

export const createLongitudinalService = (options: {
  store: LongitudinalStore;
  repositoryRoot?: string;
  ownershipPath?: string;
  legacyRepositoryIds?: readonly string[];
  onAdoptionFailure?: (error: unknown) => void;
  now?: () => Date;
  createId: (prefix: "N" | "Y" | "T" | "D" | "X") => string;
}): LongitudinalService => {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const stamp = (): string => now().toISOString();
  const repositoryId = repositoryIdentity(options.ownershipPath ?? options.repositoryRoot);

  let adoptionFailure: unknown;

  const assertAdoptable = (): void => {
    if (adoptionFailure === undefined) return;
    throw new Error(
      `Bachata refused this change: an initiative recorded under an earlier repository identity could not be re-bound (${adoptionFailure instanceof Error ? adoptionFailure.message : String(adoptionFailure)}). Reopen the workspace before recording more longitudinal state.`,
    );
  };

  const mutableInitiative = (): Initiative | undefined => {
    const initiative = currentInitiative();
    assertAdoptable();
    return initiative;
  };

  const currentInitiative = (): Initiative | undefined => {
    const activeId = store.activeInitiativeId(repositoryId);
    if (activeId !== undefined) {
      const active = store.getInitiative(activeId);
      if (active !== undefined && active.repositoryId === repositoryId) return active;
    }
    const bound = store.findInitiativeByRepository(repositoryId);
    if (bound !== undefined) return bound;
    for (const legacyId of options.legacyRepositoryIds ?? []) {
      if (legacyId === repositoryId) continue;
      const legacy = store.findInitiativeByRepository(legacyId);
      if (legacy === undefined) continue;
      if (adoptionFailure !== undefined) return legacy;
      const adopted: Initiative = { ...legacy, repositoryId, updatedAt: stamp() };
      try {
        store.saveInitiative(adopted);
      } catch (error) {
        adoptionFailure = error;
        options.onAdoptionFailure?.(error);
        return legacy;
      }
      return adopted;
    }
    return undefined;
  };

  const currentCycle = (): Cycle | undefined => {
    const initiative = currentInitiative();
    if (initiative === undefined) return undefined;
    const cycles = store.listCycles(initiative.id);
    return initiative.currentCycleId !== undefined
      ? cycles.find((cycle) => cycle.id === initiative.currentCycleId) ?? cycles.at(-1)
      : cycles.at(-1);
  };

  const snapshot = (): LongitudinalSnapshot => store.snapshot(currentInitiative()?.id);

  const latestComparisonFor = (
    cycle: Cycle | undefined,
    rounds: readonly LongitudinalRound[],
    findings: readonly FindingHistoryEntry[],
  ): RoundComparison | undefined => {
    if (cycle === undefined) return undefined;
    const latest = rounds.at(-1);
    if (latest === undefined) return undefined;
    return compareRound({
      cycleId: cycle.id,
      history: findings,
      ...latest.identities,
      recordedDecisionChanges: latest.decisionChanges,
    });
  };

  const currentVerification = (
    cycle: Cycle | undefined,
    rounds: readonly LongitudinalRound[],
  ): CycleVerification | undefined => {
    const epoch = cycle?.baselineEpoch ?? 1;
    const recorded = (cycle?.verifications ?? []).filter(
      (item) => (item.baselineEpoch ?? 1) === epoch,
    );
    if (recorded.length === 0) return undefined;
    const byTime = [...recorded].sort(
      (left, right) => left.recordedAt.localeCompare(right.recordedAt),
    );
    const latestRunRef = rounds.at(-1)?.runRef;
    const bound = latestRunRef === undefined
      ? undefined
      : recorded.find((item) => item.runRef === latestRunRef);
    const latest = bound ?? byTime.at(-1);
    // EX-G6-12. Every terminal run records a verification, including a read-only review that
    // verifies nothing and is not expected to. Reading only the latest therefore let such a
    // review stand in for a required verification that had failed: the failure stopped being a
    // reason and the cycle read as saturated. A required result is current until another
    // required result replaces it; an optional review reports beside it, never over it.
    const latestRequired = byTime.filter((item) => item.expected).at(-1);
    if (latestRequired === undefined || latest?.expected === true) {
      return latest;
    }
    return latestRequired;
  };

  const summary = (
    options: LongitudinalSummaryOptions = {},
  ): LongitudinalSummary => {
    const state = snapshot();
    const cycle = currentCycle();
    const rounds = state.initiative === undefined
      ? []
      : store.listRounds(state.initiative.id, cycle?.id);
    const drift = baselineDrift(cycle?.repositoryBaseline, options.currentBaseline);
    const epoch = cycle?.baselineEpoch ?? 1;
    const currentEpochRounds = rounds.filter(
      (round) => (round.baselineEpoch ?? 1) === epoch,
    );
    const verification = currentVerification(cycle, currentEpochRounds);
    const saturation = saturationReport({
      quietFreshReviews: quietFreshReviewCount(currentEpochRounds),
      history: state.findings,
      decisions: state.decisions,
      checks: verification?.checks ?? [],
      verificationExpected: verification?.expected ?? false,
      driftReasons: drift,
    });
    const now = stamp();
    const externalEvidence = state.initiative === undefined
      ? []
      : store.listExternalEvidence(state.initiative.id);
    const latestComparison = latestComparisonFor(cycle, currentEpochRounds, state.findings);
    const reconciliation = currentEpochRounds.at(-1)?.reconciliation
      ?? EMPTY_ROUND_RECONCILIATION;
    return {
      ...(state.initiative === undefined ? {} : { initiative: state.initiative }),
      initiatives: store.listInitiativesByRepository(repositoryId),
      cycles: state.cycles,
      ...(cycle === undefined ? {} : { currentCycle: cycle }),
      artifacts: state.artifacts,
      decisions: state.decisions,
      findings: state.findings,
      findingAliases: state.findingAliases,
      fixRuns: state.fixRuns,
      externalEvidence,
      staleExternalEvidenceIds: externalEvidence
        .filter((record) => record.supersededById === undefined)
        .filter((record) => externalEvidenceIsStale(record, now))
        .map((record) => record.id),
      ...(latestComparison === undefined ? {} : { latestComparison }),
      reconciliation,
      saturation,
      resolutionMatrix: resolutionMatrix(),
      validationErrors: currentEpochRounds.at(-1)?.validationErrors ?? [],
      staleRuns: rounds
        .filter((round) => round.validationErrors.includes(STALE_EPOCH_NOTICE))
        .map((round) => ({
          runRef: round.runRef,
          cycleId: round.cycleId,
          recordedAt: round.recordedAt,
        })),
      direction: directionView({
        ...(state.initiative === undefined ? {} : { initiative: state.initiative }),
        ...(cycle === undefined ? {} : { currentCycle: cycle }),
        ...(latestComparison === undefined ? {} : { latestChange: latestComparison }),
        artifacts: state.artifacts,
        decisions: state.decisions,
        history: state.findings,
        saturation,
        reconciliationQuestions: reconciliation.questions,
        ...(options.currentBaseline === undefined
          ? {}
          : { currentBaseline: options.currentBaseline }),
        baselineDrift: drift,
        ...(verification === undefined ? {} : { verification }),
      }),
    };
  };

  const persistInitiative = (initiative: Initiative): Initiative => {
    store.saveInitiative(initiative);
    return initiative;
  };

  const defineInitiative: LongitudinalService["defineInitiative"] = (input) => {
    if (options.repositoryRoot === undefined || options.repositoryRoot.trim().length === 0) {
      throw new Error(
        "Bachata cannot bind an initiative without a repository. Open a folder or set a working directory first.",
      );
    }
    const existing = mutableInitiative();
    const recordedAt = stamp();
    const next: Initiative = {
      schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
      id: existing?.id ?? options.createId("N"),
      repositoryId,
      ...(options.repositoryRoot === undefined
        ? {}
        : { repositoryRoot: options.repositoryRoot }),
      title: input.title,
      goal: input.goal,
      desiredOutcome: input.desiredOutcome ?? existing?.desiredOutcome ?? "",
      scope: input.scope ?? existing?.scope ?? [],
      constraints: input.constraints ?? existing?.constraints ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? existing?.acceptanceCriteria ?? [],
      ...(existing?.currentDirection === undefined
        ? {}
        : { currentDirection: existing.currentDirection }),
      status: existing?.status ?? "active",
      createdAt: existing?.createdAt ?? recordedAt,
      updatedAt: recordedAt,
      ...(existing?.currentCycleId === undefined
        ? {}
        : { currentCycleId: existing.currentCycleId }),
    };
    const saved = persistInitiative(next);
    store.setActiveInitiative(repositoryId, saved.id);
    return saved;
  };

  const listInitiatives: LongitudinalService["listInitiatives"] = () =>
    store.listInitiativesByRepository(repositoryId);

  const createInitiative: LongitudinalService["createInitiative"] = (input) => {
    if (options.repositoryRoot === undefined || options.repositoryRoot.trim().length === 0) {
      throw new Error(
        "Bachata cannot bind an initiative without a repository. Open a folder or set a working directory first.",
      );
    }
    assertAdoptable();
    const recordedAt = stamp();
    const created: Initiative = {
      schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
      id: options.createId("N"),
      repositoryId,
      repositoryRoot: options.repositoryRoot,
      title: input.title,
      goal: input.goal,
      desiredOutcome: input.desiredOutcome ?? "",
      scope: input.scope ?? [],
      constraints: input.constraints ?? [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      status: "active",
      createdAt: recordedAt,
      updatedAt: recordedAt,
    };
    store.saveInitiative(created);
    store.setActiveInitiative(repositoryId, created.id);
    return created;
  };

  const switchInitiative: LongitudinalService["switchInitiative"] = (initiativeId) => {
    assertAdoptable();
    const target = store.getInitiative(initiativeId);
    if (target === undefined || target.repositoryId !== repositoryId) return undefined;
    store.setActiveInitiative(repositoryId, target.id);
    return target;
  };

  const setInitiativeStatus: LongitudinalService["setInitiativeStatus"] = (
    initiativeId,
    status,
  ) => {
    assertAdoptable();
    const target = store.getInitiative(initiativeId);
    if (target === undefined || target.repositoryId !== repositoryId) return undefined;
    const next: Initiative = { ...target, status, updatedAt: stamp() };
    store.saveInitiative(next);
    return next;
  };

  const exportInitiative: LongitudinalService["exportInitiative"] = (initiativeId) => {
    const target = initiativeId === undefined
      ? currentInitiative()
      : store.getInitiative(initiativeId);
    if (target === undefined || target.repositoryId !== repositoryId) return undefined;
    return {
      bundleVersion: INITIATIVE_BUNDLE_VERSION,
      schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
      exportedAt: stamp(),
      initiative: target,
      cycles: store.listCycles(target.id),
      artifacts: store.listArtifacts(target.id),
      decisions: store.listDecisions(target.id),
      findings: store.listFindingHistory(target.id),
      rounds: store.listRounds(target.id),
      findingAliases: store.listFindingAliases(target.id),
      fixRuns: store.listFixRuns(target.id),
      externalEvidence: store.listExternalEvidence(target.id),
    };
  };

  const importInitiative: LongitudinalService["importInitiative"] = (value) => {
    if (options.repositoryRoot === undefined || options.repositoryRoot.trim().length === 0) {
      return { ok: false, reason: "there is no repository to bind the imported initiative to" };
    }
    const parsed = parseInitiativeBundle(value);
    if (parsed.bundle === undefined) {
      return {
        ok: false,
        reason: `Bachata imported nothing. ${parsed.errors.slice(0, 5).join("; ")}${parsed.errors.length > 5 ? `; and ${String(parsed.errors.length - 5)} more` : ""}`,
      };
    }
    const bundle = parsed.bundle;
    if (bundle.bundleVersion !== INITIATIVE_BUNDLE_VERSION) {
      return {
        ok: false,
        reason: `the bundle was written for format ${String(bundle.bundleVersion)} and this build reads format ${String(INITIATIVE_BUNDLE_VERSION)}`,
      };
    }
    assertAdoptable();
    const recordedAt = stamp();
    const initiativeId = options.createId("N");
    const cycleIds = new Map<string, string>(
      bundle.cycles.map((cycle) => [cycle.id, options.createId("Y")]),
    );
    const artifactIds = new Map<string, string>(
      bundle.artifacts.map((artifact) => [artifact.id, options.createId("T")]),
    );
    const decisionIds = new Map<string, string>(
      bundle.decisions.map((decision) => [decision.id, options.createId("D")]),
    );
    const evidenceIds = new Map<string, string>(
      bundle.externalEvidence.map((record) => [record.id, options.createId("X")]),
    );
    let unmapped: string | undefined;
    const mapped = (
      table: ReadonlyMap<string, string>,
      kind: string,
    ) => (id: string): string => {
      const next = table.get(id);
      if (next === undefined) {
        unmapped ??= `${kind} ${id}`;
        return id;
      }
      return next;
    };
    const cycleId = mapped(cycleIds, "cycle");
    const artifactId = mapped(artifactIds, "artifact");
    const decisionId = mapped(decisionIds, "decision");
    const evidenceId = mapped(evidenceIds, "external evidence");
    const remapProvenance = (provenance: RecordProvenance): RecordProvenance => ({
      ...provenance,
      ...(provenance.cycleId === undefined
        ? {}
        : { cycleId: cycleId(provenance.cycleId) }),
    });
    const remapResolution = (
      resolution: HumanResolution,
      remapId: (id: string) => string,
    ): HumanResolution => ({
      ...resolution,
      ...(resolution.supersededById === undefined
        ? {}
        : { supersededById: remapId(resolution.supersededById) }),
    });
    const initiative: Initiative = {
      ...bundle.initiative,
      id: initiativeId,
      repositoryId,
      repositoryRoot: options.repositoryRoot,
      status: "active",
      ...(bundle.initiative.currentCycleId === undefined
        ? {}
        : { currentCycleId: cycleId(bundle.initiative.currentCycleId) }),
      updatedAt: recordedAt,
    };
    const payload = {
      initiative,
      cycles: bundle.cycles.map((cycle) => {
        const { verifications: _verifications, ...withoutVerification } = cycle;
        return {
          ...withoutVerification,
          id: cycleId(cycle.id),
          initiativeId,
          runRefs: [],
          inputArtifactIds: cycle.inputArtifactIds.map(artifactId),
          outputArtifactIds: cycle.outputArtifactIds.map(artifactId),
          acceptedStateDelta: {
            ...cycle.acceptedStateDelta,
            acceptedArtifactIds: cycle.acceptedStateDelta.acceptedArtifactIds.map(artifactId),
            rejectedArtifactIds: cycle.acceptedStateDelta.rejectedArtifactIds.map(artifactId),
            acceptedDecisionIds: cycle.acceptedStateDelta.acceptedDecisionIds.map(decisionId),
          },
        };
      }),
      artifacts: bundle.artifacts.map((artifact) => ({
        ...artifact,
        id: artifactId(artifact.id),
        initiativeId,
        cycleId: cycleId(artifact.cycleId),
        provenance: remapProvenance(artifact.provenance),
        ...(artifact.supersedesId === undefined
          ? {}
          : { supersedesId: artifactId(artifact.supersedesId) }),
        ...(artifact.supersededById === undefined
          ? {}
          : { supersededById: artifactId(artifact.supersededById) }),
        ...(artifact.humanResolution === undefined
          ? {}
          : { humanResolution: remapResolution(artifact.humanResolution, artifactId) }),
        resolutionHistory: artifact.resolutionHistory.map(
          (resolution) => remapResolution(resolution, artifactId)),
      })),
      decisions: bundle.decisions.map((decision) => ({
        ...decision,
        id: decisionId(decision.id),
        initiativeId,
        cycleId: cycleId(decision.cycleId),
        provenance: remapProvenance(decision.provenance),
        ...(decision.supersedesId === undefined
          ? {}
          : { supersedesId: decisionId(decision.supersedesId) }),
        ...(decision.supersededById === undefined
          ? {}
          : { supersededById: decisionId(decision.supersededById) }),
        ...(decision.humanResolution === undefined
          ? {}
          : { humanResolution: remapResolution(decision.humanResolution, decisionId) }),
        resolutionHistory: decision.resolutionHistory.map(
          (resolution) => remapResolution(resolution, decisionId)),
      })),
      findings: bundle.findings.map((entry) => ({
        ...entry,
        initiativeId,
        firstCycleId: cycleId(entry.firstCycleId),
        lastCycleId: cycleId(entry.lastCycleId),
        notObservedCycleIds: entry.notObservedCycleIds.map(cycleId),
        challengeHistory: entry.challengeHistory.map((challenge) => ({
          ...challenge,
          cycleId: cycleId(challenge.cycleId),
        })),
        ...(entry.humanResolution === undefined
          ? {}
          : { humanResolution: remapResolution(entry.humanResolution, (id) => id) }),
      })),
      rounds: bundle.rounds.map((round) => ({
        ...round,
        initiativeId,
        cycleId: cycleId(round.cycleId),
        decisionChanges: round.decisionChanges.map((change) => ({
          ...change,
          decisionId: decisionId(change.decisionId),
        })),
      })),
      aliases: bundle.findingAliases.map((alias) => ({ ...alias, initiativeId })),
      fixRuns: bundle.fixRuns.map((fixRun) => ({
        ...fixRun,
        initiativeId,
        imported: true,
      })),
      externalEvidence: bundle.externalEvidence.map((record) => {
        const importedTarget = record.target.kind === "artifact"
          ? { kind: "artifact" as const, artifactId: artifactId(record.target.artifactId) }
          : record.target.kind === "decision"
            ? { kind: "decision" as const, decisionId: decisionId(record.target.decisionId) }
            : record.target;
        return {
        ...record,
        id: evidenceId(record.id),
        initiativeId,
        cycleId: cycleId(record.cycleId),
        target: importedTarget,
        // Identity is derived from the source and the target it is claimed against, so an
        // imported record must be re-derived against the remapped target or a later retrieval
        // would fork a second live record for the same claim.
        logicalId: externalEvidenceLogicalIdentity(record.source.uri, importedTarget),
        ...(record.supersedesId === undefined
          ? {}
          : { supersedesId: evidenceId(record.supersedesId) }),
        ...(record.supersededById === undefined
          ? {}
          : { supersededById: evidenceId(record.supersededById) }),
        provenance: remapProvenance(record.provenance),
        challenges: record.challenges.map((challenge) => ({
          ...challenge,
          cycleId: cycleId(challenge.cycleId),
        })),
        ...(record.humanResolution === undefined
          ? {}
          : { humanResolution: remapResolution(record.humanResolution, evidenceId) }),
        resolutionHistory: record.resolutionHistory.map(
          (resolution) => remapResolution(resolution, evidenceId)),
        };
      }),
    };
    if (unmapped !== undefined) {
      return {
        ok: false,
        reason: `Bachata imported nothing. The bundle names ${unmapped}, which it does not contain`,
      };
    }
    store.importInitiative(payload);
    store.setActiveInitiative(repositoryId, initiativeId);
    return { ok: true, initiative };
  };

  // Saving direction appends a revision. It never destroys the previous one, so a reader can
  // see what the direction was, what it became, and what the human said changed it.
  const setDirection: LongitudinalService["setDirection"] = (direction, options) => {
    const initiative = mutableInitiative();
    if (initiative === undefined) return undefined;
    const text = direction.trim();
    // An initiative recorded before revisions existed carries only currentDirection. Seed it
    // as revision 1 so the first edit adds to the history instead of erasing what was there.
    const stored = initiative.directionRevisions ?? [];
    const revisions = stored.length === 0 && initiative.currentDirection !== undefined
      ? [{
        revision: 1,
        text: initiative.currentDirection,
        author: "human",
        source: "human" as const,
        recordedAt: initiative.updatedAt,
        rationale: "Recorded before Bachata kept direction history; seeded from the stored direction.",
      }]
      : stored;
    const latest = revisions.at(-1);
    const acceptedDecisionIds = new Set(
      store.listDecisions(initiative.id)
        .filter((decision) => decision.state === "accepted")
        .map((decision) => decision.id),
    );
    const supportingDecisionIds = (options?.supportingDecisionIds ?? [])
      .filter((id) => acceptedDecisionIds.has(id));
    // Unchanged wording is still a change when the human supplied new provenance. Only a
    // repeat with nothing new is a no-op.
    const rationale = options?.rationale?.trim();
    const evidence = (options?.evidence ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
    const suppliedProvenance = (rationale !== undefined && rationale.length > 0) ||
      evidence.length > 0 ||
      supportingDecisionIds.length > 0;
    const addsProvenance = suppliedProvenance && (
      latest === undefined ||
      (rationale !== undefined && rationale.length > 0 && rationale !== latest.rationale) ||
      JSON.stringify(evidence) !== JSON.stringify(latest.evidence ?? []) ||
      JSON.stringify(supportingDecisionIds) !== JSON.stringify(latest.supportingDecisionIds ?? [])
    );
    // Re-recording the same wording with nothing new is a no-op. Omitting provenance is not
    // new provenance, so it never creates a revision either.
    if (latest?.text === text && !addsProvenance) return initiative;
    const recordedAt = stamp();
    const revision: DirectionRevision = {
      revision: (latest?.revision ?? 0) + 1,
      text,
      author: "human",
      source: "human",
      recordedAt,
      ...(rationale === undefined || rationale.length === 0 ? {} : { rationale }),
      // Provenance is only recorded for decisions this initiative actually accepted. A caller
      // naming anything else records a link that does not exist.
      ...(supportingDecisionIds.length === 0 ? {} : { supportingDecisionIds }),
      ...(evidence.length === 0 ? {} : { evidence }),
    };
    return persistInitiative({
      ...initiative,
      currentDirection: text,
      directionRevisions: [...revisions, revision],
      updatedAt: recordedAt,
    });
  };

  const startCycle: LongitudinalService["startCycle"] = (input) => {
    const initiative = mutableInitiative();
    if (initiative === undefined) return undefined;
    const recordedAt = stamp();
    const cycles = store.listCycles(initiative.id);
    const previous = cycles.at(-1);
    const closedPrevious = previous !== undefined && previous.completion === "open"
      ? { ...previous, completion: "completed" as const, updatedAt: recordedAt }
      : undefined;
    const cycle: Cycle = {
      schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
      id: options.createId("Y"),
      sequence: (previous?.sequence ?? 0) + 1,
      initiativeId: initiative.id,
      type: input.type,
      ...(input.type === "custom" && input.customType !== undefined
        ? { customType: input.customType }
        : {}),
      ...(input.repositoryBaseline === undefined
        ? {}
        : { repositoryBaseline: input.repositoryBaseline }),
      baselineEpoch: 1,
      runRefs: [],
      inputArtifactIds: previous?.outputArtifactIds ?? [],
      outputArtifactIds: [],
      acceptedStateDelta: EMPTY_ACCEPTED_STATE_DELTA,
      completion: "open",
      createdAt: recordedAt,
      updatedAt: recordedAt,
    };
    store.commitCycleStart({
      initiative: { ...initiative, currentCycleId: cycle.id, updatedAt: recordedAt },
      ...(closedPrevious === undefined ? {} : { previous: closedPrevious }),
      cycle,
    });
    return cycle;
  };

  const rebaseline: LongitudinalService["rebaseline"] = (baseline) => {
    mutableInitiative();
    const cycle = currentCycle();
    if (cycle === undefined) return undefined;
    if (cycle.completion !== "open") return undefined;
    const next: Cycle = {
      ...cycle,
      repositoryBaseline: baseline,
      baselineEpoch: (cycle.baselineEpoch ?? 1) + 1,
      updatedAt: stamp(),
    };
    store.saveCycle(next);
    return next;
  };

  const verificationDigest = (input: {
    runRef: string;
    checks: readonly VerificationResult[];
    expected: boolean;
    baseline?: CycleBaseline;
  }): string =>
    JSON.stringify([
      input.runRef,
      input.expected,
      input.baseline?.commit ?? "",
      input.baseline?.worktreeDigest ?? "",
      [...input.checks].map((check) => [check.command, check.status, check.stale === true]),
    ]);

  const cycleForRunRef = (runRef: string): Cycle | undefined => {
    const binding = store.runBinding(runRef);
    if (binding === undefined) return undefined;
    const cycles = store.listCycles(binding.initiativeId);
    return cycles.find((item) => item.id === binding.cycleId);
  };

  const recordVerification: LongitudinalService["recordVerification"] = (input) => {
    mutableInitiative();
    const cycle = cycleForRunRef(input.runRef);
    if (cycle === undefined || cycle.completion !== "open") return undefined;
    const boundEpoch = store.runBinding(input.runRef)?.baselineEpoch ?? cycle.baselineEpoch ?? 1;
    if (boundEpoch !== (cycle.baselineEpoch ?? 1)) return undefined;
    const existing = cycle.verifications ?? [];
    const held = existing.find((item) => item.runRef === input.runRef);
    if (held !== undefined && verificationDigest(held) === verificationDigest(input)) {
      return cycle;
    }
    const recordedAt = stamp();
    const recorded: CycleVerification = {
      runRef: input.runRef,
      baselineEpoch: boundEpoch,
      checks: [...input.checks],
      expected: input.expected,
      recordedAt,
      ...(input.baseline === undefined ? {} : { baseline: input.baseline }),
    };
    const next: Cycle = {
      ...cycle,
      verifications: [
        ...existing.filter((item) => item.runRef !== input.runRef),
        recorded,
      ].slice(-MAX_CYCLE_VERIFICATIONS),
      updatedAt: recordedAt,
    };
    store.saveCycle(next);
    return next;
  };

  const bindRun: LongitudinalService["bindRun"] = (input) => {
    const initiative = mutableInitiative();
    if (initiative === undefined) return undefined;
    const cycles = store.listCycles(initiative.id);
    const cycle = input.cycleId === undefined
      ? currentCycle()
      : cycles.find((item) => item.id === input.cycleId);
    if (cycle === undefined) return undefined;
    if (cycle.completion !== "open") return undefined;
    const boundAt = stamp();
    const next: Cycle = cycle.runRefs.includes(input.runRef)
      ? cycle
      : { ...cycle, runRefs: [...cycle.runRefs, input.runRef], updatedAt: boundAt };
    store.commitRunBinding({
      binding: {
        runRef: input.runRef,
        initiativeId: initiative.id,
        cycleId: cycle.id,
        baselineEpoch: cycle.baselineEpoch ?? 1,
        freshReview: input.freshReview,
        boundAt,
      },
      cycle: next,
    });
    return next;
  };

  const decisionUpdatesFrom = (input: {
    initiativeId: string;
    cycleId: string;
    runRef: string;
    recordedAt: string;
    existing: readonly DecisionRecord[];
    source: LongitudinalDecisionSource;
  }): { decisions: DecisionRecord[]; errors: string[] } => {
    const current = new Map<string, DecisionRecord>();
    const highestRevision = new Map<string, number>();
    input.existing.forEach((decision) => {
      highestRevision.set(
        decision.logicalId,
        Math.max(highestRevision.get(decision.logicalId) ?? 0, decision.revision),
      );
      if (decision.supersededById !== undefined) return;
      const held = current.get(decision.logicalId);
      if (held === undefined || decision.revision >= held.revision) {
        current.set(decision.logicalId, decision);
      }
    });
    const provenanceFor = (participantIds: readonly string[]): RecordProvenance => ({
      authoredBy: "model",
      participantIds: [...participantIds],
      runRef: input.runRef,
      cycleId: input.cycleId,
      stepId: input.source.stepId,
    });
    const retired = new Set<string>();
    const errors: string[] = [];
    const decisions = input.source.candidates.flatMap((candidate) => {
      const logicalId = decisionLogicalIdentity(candidate.subject, candidate.affectedScope);
      const sameIdentity = current.get(logicalId);
      const declaredId = candidate.supersedes === undefined
        ? undefined
        : decisionLogicalIdentity(
            candidate.supersedes.subject,
            candidate.supersedes.affectedScope,
          );
      const declared = declaredId === undefined ? undefined : current.get(declaredId);
      if (declaredId !== undefined && declared === undefined) {
        errors.push(
          `"${candidate.subject}" names a predecessor that is not a current decision in this initiative`,
        );
        return [];
      }
      if (
        sameIdentity !== undefined &&
        declared !== undefined &&
        sameIdentity.id !== declared.id
      ) {
        errors.push(
          `"${candidate.subject}" names a predecessor that conflicts with the current decision for the same subject and scope`,
        );
        return [];
      }
      const previous = sameIdentity ?? declared;
      if (
        previous !== undefined &&
        previous.logicalId === logicalId &&
        decisionMaterialDigest(previous) === decisionMaterialDigest(candidate)
      ) {
        return [{
          ...previous,
          cycleId: input.cycleId,
          occurrences: previous.occurrences + 1,
          provenance: provenanceFor(Array.from(new Set([
            ...previous.provenance.participantIds,
            ...input.source.participantIds,
          ]))),
          updatedAt: input.recordedAt,
        }];
      }
      const revision = (highestRevision.get(logicalId) ?? 0) + 1;
      highestRevision.set(logicalId, revision);
      const successor: DecisionRecord = {
        schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
        id: options.createId("D"),
        logicalId,
        revision,
        occurrences: 1,
        initiativeId: input.initiativeId,
        cycleId: input.cycleId,
        subject: candidate.subject,
        affectedScope: candidate.affectedScope,
        question: candidate.question,
        options: candidate.options,
        tradeOffs: candidate.tradeOffs,
        ...(candidate.recommendation === undefined
          ? {}
          : { recommendation: candidate.recommendation }),
        evidence: candidate.evidence,
        state: "proposed",
        provenance: provenanceFor(input.source.participantIds),
        ...(previous === undefined ? {} : { supersedesId: previous.id }),
        materialEvidenceDelta: previous === undefined
          ? []
          : decisionMaterialDelta(previous, candidate),
        resolutionHistory: [],
        createdAt: input.recordedAt,
        updatedAt: input.recordedAt,
      };
      if (previous === undefined || retired.has(previous.id)) return [successor];
      retired.add(previous.id);
      return [
        {
          ...previous,
          state: "superseded" as const,
          supersededById: successor.id,
          updatedAt: input.recordedAt,
        },
        successor,
      ];
    });
    return errors.length > 0 ? { decisions: [], errors } : { decisions, errors };
  };

  const recordRound: LongitudinalService["recordRound"] = (input) => {
    mutableInitiative();
    const binding = store.runBinding(input.runRef);
    const bound = binding === undefined
      ? undefined
      : store.listCycles(binding.initiativeId).find((item) => item.id === binding.cycleId);
    const recovered = bound === undefined ? store.cycleForRun(input.runRef) : undefined;
    const cycle = bound ?? recovered;
    const initiative = cycle === undefined
      ? undefined
      : store.getInitiative(cycle.initiativeId);
    if (initiative === undefined) return undefined;
    if (cycle === undefined || cycle.completion !== "open") return undefined;
    const freshReview = input.freshReview ?? binding?.freshReview ?? false;
    const boundEpoch = binding?.baselineEpoch ?? cycle.baselineEpoch ?? 1;
    const staleEpoch = boundEpoch !== (cycle.baselineEpoch ?? 1);
    const recordedAt = stamp();
    const history = store.listFindingHistory(initiative.id);
    const decisions = store.listDecisions(initiative.id);
    if (staleEpoch) {
      const staleRound: LongitudinalRound = {
        schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
        initiativeId: initiative.id,
        cycleId: cycle.id,
        baselineEpoch: boundEpoch,
        runRef: input.runRef,
        executionRef: input.executionRef,
        freshReview,
        recordedAt,
        newMaterialCount: 0,
        regressionCount: 0,
        notObservedCount: 0,
        materialChangeCount: 0,
        identities: EMPTY_ROUND_IDENTITIES,
        decisionChanges: [],
        validationErrors: [...(input.validationErrors ?? []), STALE_EPOCH_NOTICE],
      };
      const recorded = store.commitRound({
        round: staleRound,
        history: [],
        decisions: [],
        artifacts: [],
        cycle,
      });
      return recorded
        ? {
            stale: true,
            comparison: compareRound({
              cycleId: cycle.id,
              history,
              ...EMPTY_ROUND_IDENTITIES,
              recordedDecisionChanges: [],
            }),
          }
        : undefined;
    }
    const storedAliases = findingAliasMap(store.listFindingAliases(initiative.id));
    const reconciliation = reconcileFindings({
      findings: input.findings,
      history,
      aliases: storedAliases,
    });
    const reconciledAliases: FindingAlias[] = reconciliation.aliases.map((alias) => ({
      initiativeId: initiative.id,
      aliasIdentity: alias.aliasIdentity,
      canonicalIdentity: alias.canonicalIdentity,
      reason: alias.reason,
      createdBy: "controller",
      createdAt: recordedAt,
    }));
    const roundAliases = new Map(storedAliases);
    reconciledAliases.forEach((alias) => {
      roundAliases.set(alias.aliasIdentity, alias.canonicalIdentity);
    });
    const fold = foldFindingsIntoHistory({
      initiativeId: initiative.id,
      cycleId: cycle.id,
      recordedAt,
      history,
      findings: input.findings,
      freshReview,
      aliases: roundAliases,
    });
    const statesBefore = new Map(history.map((entry) => [entry.identity, entry.state]));
    const roundIdentities: RoundIdentities = {
      newIdentities: fold.newIdentities,
      repeatedIdentities: fold.repeatedIdentities,
      resolvedIdentities: fold.history
        .filter((entry) =>
          entry.state === "resolved" && statesBefore.get(entry.identity) !== "resolved")
        .map((entry) => entry.identity),
      regressedIdentities: fold.regressedIdentities,
      reopenedIdentities: fold.reopenedIdentities,
      notObservedIdentities: fold.notObservedIdentities,
    };
    const production_decisions = input.decisionSource === undefined
      ? { decisions: [] as DecisionRecord[], errors: [] as string[] }
      : decisionUpdatesFrom({
          initiativeId: initiative.id,
          cycleId: cycle.id,
          runRef: input.runRef,
          recordedAt,
          existing: decisions,
          source: input.decisionSource,
        });
    const producedDecisions = production_decisions.decisions;
    const validationErrors = [
      ...(input.validationErrors ?? []),
      ...production_decisions.errors,
    ];
    const decisionsAfter = [
      ...decisions.filter((decision) =>
        !producedDecisions.some((produced) => produced.id === decision.id)),
      ...producedDecisions,
    ];
    const roundDecisionChanges = decisionChanges(decisions, decisionsAfter);
    const round: LongitudinalRound = {
      schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
      initiativeId: initiative.id,
      cycleId: cycle.id,
      baselineEpoch: binding?.baselineEpoch ?? cycle.baselineEpoch ?? 1,
      runRef: input.runRef,
      executionRef: input.executionRef,
      freshReview,
      recordedAt,
      newMaterialCount: fold.newIdentities.length,
      regressionCount: fold.regressedIdentities.length,
      notObservedCount: fold.notObservedIdentities.length,
      materialChangeCount: fold.history.filter((entry) =>
        entry.lastCycleId === cycle.id &&
        entry.lastSeenAt === recordedAt &&
        entry.materialDelta.length > 0).length,
      identities: roundIdentities,
      decisionChanges: roundDecisionChanges,
      ...(reconciliation.aliases.length === 0 && reconciliation.questions.length === 0
        ? {}
        : { reconciliation: roundReconciliation(reconciliation) }),
      validationErrors,
    };
    const storedArtifacts = store.listArtifacts(initiative.id);
    const previousArtifact = latestFindingSetArtifact(storedArtifacts);
    const production = produceFindingSetArtifact({
      createId: () => options.createId("T"),
      initiativeId: initiative.id,
      cycleId: cycle.id,
      runRef: input.runRef,
      recordedAt,
      title: `Ruled findings · cycle ${String(cycle.sequence)}`,
      findings: input.findings,
      ...(previousArtifact === undefined ? {} : { previous: previousArtifact }),
    });
    const previousPlan = latestArtifactOfType(storedArtifacts, "plan");
    const planProduction = input.planSource === undefined
      ? undefined
      : produceTypedArtifact({
          createId: () => options.createId("T"),
          initiativeId: initiative.id,
          cycleId: cycle.id,
          runRef: input.runRef,
          recordedAt,
          type: "plan",
          title: input.planSource.plan.title,
          body: planArtifactBody(input.planSource.plan),
          contentDigest: planContentDigest(input.planSource.plan),
          evidence: input.planSource.plan.evidence,
          participantIds: input.planSource.participantIds,
          stepId: input.planSource.stepId,
          ...(previousPlan === undefined ? {} : { previous: previousPlan }),
        });
    // Every promotion the pipeline declared for this run, produced against the latest
    // revision of the same artifact type so a repeated round supersedes instead of forking.
    const declaredProductions = (input.declaredArtifacts ?? []).flatMap((source) => {
      const previous = latestArtifactOfType(
        storedArtifacts,
        source.promotion.type,
        source.promotion.customType,
      );
      const produced = produceDeclaredArtifact({
        createId: () => options.createId("T"),
        initiativeId: initiative.id,
        cycleId: cycle.id,
        runRef: input.runRef,
        recordedAt,
        promotion: source.promotion,
        output: source.output,
        fallbackTitle: source.fallbackTitle,
        participantIds: source.participantIds,
        ...(source.stepId === undefined ? {} : { stepId: source.stepId }),
        ...(previous === undefined ? {} : { previous }),
      });
      return produced === undefined ? [] : [produced];
    });
    const artifacts = [
      ...declaredProductions.flatMap((produced) => [
        ...(produced.superseded === undefined ? [] : [produced.superseded]),
        produced.artifact,
      ]),
      ...(production === undefined
        ? []
        : [
            ...(production.superseded === undefined ? [] : [production.superseded]),
            production.artifact,
          ]),
      ...(planProduction === undefined
        ? []
        : [
            ...(planProduction.superseded === undefined ? [] : [planProduction.superseded]),
            planProduction.artifact,
          ]),
    ];
    const nextCycle: Cycle = {
      ...cycle,
      outputArtifactIds: Array.from(new Set([
        ...cycle.outputArtifactIds,
        ...(production === undefined ? [] : [production.artifact.id]),
        ...(planProduction === undefined ? [] : [planProduction.artifact.id]),
        ...declaredProductions.map((produced) => produced.artifact.id),
      ])),
      runRefs: cycle.runRefs.includes(input.runRef)
        ? cycle.runRefs
        : [...cycle.runRefs, input.runRef],
      acceptedStateDelta: {
        ...cycle.acceptedStateDelta,
        newFindingIdentities: Array.from(new Set([
          ...cycle.acceptedStateDelta.newFindingIdentities,
          ...fold.newIdentities,
        ])),
        regressedFindingIdentities: Array.from(new Set([
          ...cycle.acceptedStateDelta.regressedFindingIdentities,
          ...fold.regressedIdentities,
        ])),
        notObservedFindingIdentities: Array.from(new Set([
          ...cycle.acceptedStateDelta.notObservedFindingIdentities,
          ...fold.notObservedIdentities,
        ])),
      },
      updatedAt: recordedAt,
    };
    const verifiedIdentities = freshReview
      ? fold.history
          .filter((entry) =>
            entry.fixState === "fixApplied" &&
            fold.notObservedIdentities.includes(entry.identity))
          .map((entry) => entry.identity)
      : [];
    // A fresh independent review that no longer reports a finding whose fix was applied is
    // the controller's own evidence. It closes the finding as well as verifying the fix, so
    // a verified finding no longer counts as outstanding against saturation. A finding that
    // was never fixed is only unobserved: absence of a report is not evidence.
    const roundHistory = verifiedIdentities.length === 0
      ? fold.history
      : fold.history.map((entry) => {
          if (!verifiedIdentities.includes(entry.identity)) return entry;
          const verified = { ...entry, fixState: "verified" as const };
          return resolveFindingWithControllerEvidence(verified, {
            evidence: [
              `Fresh review ${round.runRef} in cycle ${cycle.id} did not report this finding after its fix was applied`,
            ],
            cycleId: cycle.id,
            recordedAt,
          }) ?? verified;
        });
    const applied = store.commitRound({
      round,
      history: roundHistory,
      decisions: producedDecisions,
      artifacts,
      aliases: reconciledAliases,
      cycle: nextCycle,
    });
    if (!applied) return undefined;
    if (verifiedIdentities.length > 0) {
      const linked = store
        .listFixRuns(initiative.id)
        .filter((item) => verifiedIdentities.includes(item.identity) && item.state !== "verified");
      if (linked.length > 0) {
        store.commitFixRunState({
          fixRuns: linked.map((item) => ({
            ...item,
            state: "verified" as const,
            updatedAt: recordedAt,
          })),
          findings: [],
        });
      }
    }
    return {
      stale: false,
      comparison: compareRound({
        cycleId: cycle.id,
        history: roundHistory,
        ...roundIdentities,
        recordedDecisionChanges: roundDecisionChanges,
      }),
    };
  };

  const findingAliases = (): FindingAlias[] => {
    const initiative = currentInitiative();
    return initiative === undefined ? [] : store.listFindingAliases(initiative.id);
  };

  const mergeFindings: LongitudinalService["mergeFindings"] = (input) => {
    const initiative = mutableInitiative();
    if (initiative === undefined) {
      return { ok: false, reason: "no initiative is recorded for this repository" };
    }
    const reason = input.reason.trim();
    if (reason.length === 0) {
      return { ok: false, reason: "a merge must record why the two findings are the same defect" };
    }
    if (input.absorbedIdentity === input.canonicalIdentity) {
      return { ok: false, reason: "a finding cannot be merged into itself" };
    }
    const aliases = findingAliasMap(store.listFindingAliases(initiative.id));
    const canonicalIdentity = canonicalFindingIdentity(aliases, input.canonicalIdentity);
    if (canonicalIdentity === input.absorbedIdentity) {
      return { ok: false, reason: "that merge would make the two findings point at each other" };
    }
    const history = store.listFindingHistory(initiative.id);
    const absorbed = history.find((entry) => entry.identity === input.absorbedIdentity);
    const canonical = history.find((entry) => entry.identity === canonicalIdentity);
    if (absorbed === undefined || canonical === undefined) {
      return { ok: false, reason: "both findings must be tracked in this initiative" };
    }
    const conflict = mergeConflict(canonical, absorbed);
    if (conflict !== undefined) return { ok: false, reason: conflict };
    const existingFixRuns = store.listFixRuns(initiative.id);
    const canonicalByRun = new Map(
      existingFixRuns
        .filter((item) => item.identity === canonical.identity)
        .map((item) => [item.runRef, item]),
    );
    const absorbedFixRuns = existingFixRuns
      .filter((item) => item.identity === absorbed.identity)
      .map((item) => {
        const held = canonicalByRun.get(item.runRef);
        const state = furthestFixState(held?.state, item.state) ?? item.state;
        return {
          ...item,
          identity: canonical.identity,
          state,
          updatedAt: held !== undefined && held.updatedAt > item.updatedAt
            ? held.updatedAt
            : item.updatedAt,
        };
      });
    store.commitFindingMerge({
      absorbedFixRuns,
      alias: {
        initiativeId: initiative.id,
        aliasIdentity: absorbed.identity,
        canonicalIdentity: canonical.identity,
        reason,
        createdBy: input.resolvedBy,
        createdAt: stamp(),
      },
      canonical: mergeFindingEntries(canonical, absorbed),
      absorbedIdentity: absorbed.identity,
    });
    return { ok: true };
  };

  const unmergeFinding: LongitudinalService["unmergeFinding"] = (aliasIdentity) => {
    const initiative = mutableInitiative();
    if (initiative === undefined) {
      return { ok: false, reason: "no initiative is recorded for this repository" };
    }
    return store.removeFindingAlias(initiative.id, aliasIdentity)
      ? { ok: true }
      : { ok: false, reason: `no finding is merged under ${aliasIdentity}` };
  };

  const fixRuns = (): FindingFixRun[] => {
    const initiative = currentInitiative();
    return initiative === undefined ? [] : store.listFixRuns(initiative.id);
  };

  const linkFixRun: LongitudinalService["linkFixRun"] = (input) => {
    const initiative = mutableInitiative();
    if (initiative === undefined) {
      return { ok: false, reason: "no initiative is recorded for this repository" };
    }
    const entry = store
      .listFindingHistory(initiative.id)
      .find((item) => item.identity === input.identity);
    if (entry === undefined) {
      return { ok: false, reason: `no finding is tracked as ${input.identity}` };
    }
    if (!findingIsActionable(entry)) {
      return {
        ok: false,
        reason: "only an actionable accepted finding can be handed to a fix",
      };
    }
    const updatedAt = stamp();
    store.commitFixRunState({
      fixRuns: [{
        initiativeId: initiative.id,
        identity: entry.identity,
        runRef: input.runRef,
        state: "fixRunning",
        updatedAt,
      }],
      findings: [{ ...entry, fixState: "fixRunning" }],
    });
    return { ok: true };
  };

  const initiativeForRun = (runRef: string): Initiative | undefined => {
    const boundId = store.runBinding(runRef)?.initiativeId;
    const live = store.fixRunsForRun(runRef).filter((item) => item.imported !== true);
    if (boundId !== undefined && live.some((item) => item.initiativeId === boundId)) {
      return store.getInitiative(boundId);
    }
    const initiativeIds = Array.from(new Set(live.map((item) => item.initiativeId)));
    if (initiativeIds.length > 1) return undefined;
    const linkedId = initiativeIds[0] ?? boundId;
    return linkedId === undefined ? undefined : store.getInitiative(linkedId);
  };

  const recordFixOutcome: LongitudinalService["recordFixOutcome"] = (input) => {
    mutableInitiative();
    const initiative = initiativeForRun(input.runRef);
    if (initiative === undefined) return [];
    const linked = store
      .fixRunsForRun(input.runRef)
      .filter((item) =>
        item.initiativeId === initiative.id &&
        item.imported !== true &&
        item.state !== input.state);
    if (linked.length === 0) return [];
    const history = store.listFindingHistory(initiative.id);
    const updatedAt = stamp();
    const findings = linked.flatMap((item) => {
      const entry = history.find((candidate) => candidate.identity === item.identity);
      return entry === undefined || entry.fixState === input.state
        ? []
        : [{ ...entry, fixState: input.state }];
    });
    store.commitFixRunState({
      fixRuns: linked.map((item) => ({ ...item, state: input.state, updatedAt })),
      findings,
    });
    return linked.map((item) => item.identity);
  };

  const liveFixRunsFor = (
    runRef: string,
    initiativeId: string,
  ): FindingFixRun[] =>
    store
      .fixRunsForRun(runRef)
      .filter((item) => item.initiativeId === initiativeId && item.imported !== true);

  const recordAppliedWork: LongitudinalService["recordAppliedWork"] = (input) => {
    mutableInitiative();
    const binding = store.runBinding(input.runRef);
    if (binding === undefined) {
      return { ok: false, reason: `run ${input.runRef} is not bound to any cycle` };
    }
    const initiative = store.getInitiative(binding.initiativeId);
    const cycle = store
      .listCycles(binding.initiativeId)
      .find((item) => item.id === binding.cycleId);
    if (initiative === undefined || cycle === undefined) {
      return { ok: false, reason: `run ${input.runRef} names an initiative or cycle that is gone` };
    }
    if (cycle.completion !== "open") {
      return {
        ok: false,
        reason: `cycle ${String(cycle.sequence)} is closed, so Bachata recorded no applied work against it`,
      };
    }
    if (binding.baselineEpoch !== (cycle.baselineEpoch ?? 1)) {
      return {
        ok: false,
        reason: `run ${input.runRef} was bound to an earlier repository candidate of cycle ${String(cycle.sequence)}`,
      };
    }
    const files = Array.from(new Set(
      input.stagedFiles.map((file) => file.trim()).filter((file) => file.length > 0),
    )).sort();
    if (files.length === 0) {
      return {
        ok: false,
        reason: `run ${input.runRef} staged no file, so Bachata recorded no applied work`,
      };
    }
    const linked = liveFixRunsFor(input.runRef, initiative.id);
    const recordedAt = stamp();
    const history = store.listFindingHistory(initiative.id);
    const identities = linked.map((item) => item.identity);
    const findings = linked.flatMap((item) => {
      const entry = history.find((candidate) => candidate.identity === item.identity);
      return entry === undefined || entry.fixState === "fixApplied"
        ? []
        : [{ ...entry, fixState: "fixApplied" as const }];
    });
    const contentDigest = createHash("sha256")
      .update(JSON.stringify([input.runRef, cycle.id, input.targetBranch, files]))
      .digest("hex")
      .slice(0, 40)
      .toUpperCase();
    const cyclePatches = store
      .listArtifacts(initiative.id)
      .filter((artifact) => artifact.type === "patch" && artifact.cycleId === cycle.id);
    const alreadyRecorded = cyclePatches.find(
      (artifact) => artifact.contentDigest === contentDigest,
    );
    if (alreadyRecorded !== undefined) {
      return {
        ok: true,
        identities: linked.map((item) => item.identity),
        artifactId: alreadyRecorded.id,
      };
    }
    const previousPatch = latestArtifactOfType(cyclePatches, "patch");
    const production = produceTypedArtifact({
      createId: () => options.createId("T"),
      initiativeId: initiative.id,
      cycleId: cycle.id,
      runRef: input.runRef,
      recordedAt,
      type: "patch",
      title: input.title,
      body: [
        `Applied to ${input.targetBranch} from run ${input.runRef}. No commit was created.`,
        "",
        "Staged files:",
        ...files.map((file) => `- ${file}`),
        ...(identities.length === 0
          ? []
          : ["", "Findings this work was scoped to:", ...identities.map((item) => `- ${item}`)]),
      ].join("\n"),
      contentDigest,
      evidence: identities,
      participantIds: [],
      ...(previousPatch === undefined ? {} : { previous: previousPatch }),
    });
    store.commitFixRunState({
      fixRuns: linked
        .filter((item) => item.state !== "fixApplied")
        .map((item) => ({ ...item, state: "fixApplied" as const, updatedAt: recordedAt })),
      findings,
      ...(production === undefined
        ? {}
        : {
            artifacts: [
              ...(production.superseded === undefined ? [] : [production.superseded]),
              production.artifact,
            ],
            cycle: {
              ...cycle,
              outputArtifactIds: Array.from(new Set([
                ...cycle.outputArtifactIds,
                production.artifact.id,
              ])),
              updatedAt: recordedAt,
            },
          }),
    });
    return {
      ok: true,
      identities,
      ...(production === undefined ? {} : { artifactId: production.artifact.id }),
    };
  };

  const recordPatchArtifact: LongitudinalService["recordPatchArtifact"] = (input) => {
    mutableInitiative();
    const initiative = initiativeForRun(input.runRef);
    if (initiative === undefined) return undefined;
    const cycle = cycleForRunRef(input.runRef) ??
      store.listCycles(initiative.id).find((item) => item.completion === "open");
    if (cycle === undefined || cycle.completion !== "open") return undefined;
    const files = Array.from(new Set(input.stagedFiles)).sort();
    if (files.length === 0) return undefined;
    const recordedAt = stamp();
    const body = [
      `Applied to ${input.targetBranch} from run ${input.runRef}. No commit was created.`,
      "",
      "Staged files:",
      ...files.map((file) => `- ${file}`),
      ...(input.findingIdentities.length === 0
        ? []
        : ["", "Findings this work was scoped to:", ...input.findingIdentities.map((item) => `- ${item}`)]),
    ].join("\n");
    const production = produceTypedArtifact({
      createId: () => options.createId("T"),
      initiativeId: initiative.id,
      cycleId: cycle.id,
      runRef: input.runRef,
      recordedAt,
      type: "patch",
      title: input.title,
      body,
      contentDigest: createHash("sha256")
        .update(JSON.stringify([input.runRef, input.targetBranch, files]))
        .digest("hex")
        .slice(0, 40)
        .toUpperCase(),
      evidence: input.findingIdentities,
      participantIds: [],
    });
    if (production === undefined) return undefined;
    store.saveArtifacts([
      ...(production.superseded === undefined ? [] : [production.superseded]),
      production.artifact,
    ]);
    store.saveCycle({
      ...cycle,
      outputArtifactIds: Array.from(new Set([
        ...cycle.outputArtifactIds,
        production.artifact.id,
      ])),
      updatedAt: recordedAt,
    });
    return production.artifact;
  };

  const closeCycle: LongitudinalService["closeCycle"] = (nextCycleTrigger) => {
    mutableInitiative();
    const cycle = currentCycle();
    if (cycle === undefined || cycle.completion !== "open") return undefined;
    const next: Cycle = {
      ...cycle,
      completion: "completed",
      ...(nextCycleTrigger === undefined ? {} : { nextCycleTrigger }),
      updatedAt: stamp(),
    };
    store.saveCycle(next);
    return next;
  };

  const rounds: LongitudinalService["rounds"] = (cycleId) => {
    const initiative = currentInitiative();
    if (initiative === undefined) return [];
    return cycleId === undefined
      ? store.listRounds(initiative.id)
      : store.listRounds(initiative.id, cycleId);
  };

  const deltaWith = (
    cycle: Cycle,
    key: keyof AcceptedStateDelta,
    id: string,
    resolvedAt: string,
  ): Cycle | undefined => {
    if (cycle.acceptedStateDelta[key].includes(id)) return undefined;
    return {
      ...cycle,
      acceptedStateDelta: {
        ...cycle.acceptedStateDelta,
        [key]: [...cycle.acceptedStateDelta[key], id],
      },
      updatedAt: resolvedAt,
    };
  };


  // External evidence has one durable identity per (source, claim target). A second retrieval
  // of the same document against the same target revises that record when the retrieved bytes
  // differ, and supersedes the previous revision — it never mints a parallel record and never
  // revokes a ruling a human already made on the previous revision.
  const recordExternalEvidence: LongitudinalService["recordExternalEvidence"] = (input) => {
    const initiative = mutableInitiative();
    if (initiative === undefined) return undefined;
    const cycle = currentCycle();
    if (cycle === undefined) return undefined;
    const claim = input.claim.trim();
    const uri = input.source.uri.trim();
    if (claim.length === 0 || uri.length === 0) return undefined;
    if (input.source.contentDigest.trim().length === 0) return undefined;
    const target = input.target;
    const known = target.kind === "artifact"
      ? store.listArtifacts(initiative.id).some((item) => item.id === target.artifactId)
      : target.kind === "decision"
        ? store.listDecisions(initiative.id).some((item) => item.id === target.decisionId)
        : target.kind === "finding"
          ? store.listFindingHistory(initiative.id).some((item) => item.identity === target.identity)
          : true;
    if (!known) return undefined;
    const logicalId = externalEvidenceLogicalIdentity(uri, input.target);
    const stored = store.listExternalEvidence(initiative.id);
    const previous = stored
      .filter((record) => record.logicalId === logicalId && record.supersededById === undefined)
      .at(-1);
    const recordedAt = stamp();
    if (
      previous !== undefined
      && previous.source.contentDigest === input.source.contentDigest
      && previous.claim === claim
      && previous.relation === input.relation
      && previous.authority === input.authority
    ) {
      return previous;
    }
    const next: ExternalEvidenceRecord = {
      schemaVersion: LONGITUDINAL_SCHEMA_VERSION,
      id: options.createId("X"),
      logicalId,
      revision: 1,
      initiativeId: initiative.id,
      cycleId: cycle.id,
      source: { ...input.source, uri },
      claim,
      relation: input.relation,
      target: input.target,
      authority: input.authority,
      ...(input.freshnessHorizonDays === undefined
        ? {}
        : { freshnessHorizonDays: input.freshnessHorizonDays }),
      state: "proposed",
      disposition: "unresolved",
      challenges: [],
      provenance: {
        authoredBy: input.authoredBy ?? "model",
        participantIds: [...(input.participantIds ?? [])],
        ...(input.runRef === undefined ? {} : { runRef: input.runRef }),
        cycleId: cycle.id,
      },
      resolutionHistory: [],
      createdAt: recordedAt,
      updatedAt: recordedAt,
    };
    if (previous === undefined) {
      store.commitExternalEvidence([next]);
      return next;
    }
    // A later retrieval never revokes a human ruling, and never leaves two current records for
    // one claim. The ruled predecessor keeps the state the human put it in — it is still the
    // record their judgment applies to — but it stops being current, because the revision is.
    if (previous.humanResolution !== undefined) {
      const revision: ExternalEvidenceRecord = {
        ...next,
        createdAt: previous.createdAt,
        revision: previous.revision + 1,
        supersedesId: previous.id,
      };
      store.commitExternalEvidence([
        { ...previous, supersededById: revision.id, updatedAt: revision.updatedAt },
        revision,
      ]);
      return revision;
    }
    const chained = supersedeExternalEvidence(previous, { ...next, createdAt: previous.createdAt });
    store.commitExternalEvidence([chained.previous, chained.next]);
    return chained.next;
  };

  const challengeExternalEvidenceRecord: LongitudinalService["challengeExternalEvidence"] = (input) => {
    const initiative = mutableInitiative();
    if (initiative === undefined) return false;
    const cycle = currentCycle();
    if (cycle === undefined) return false;
    const text = input.text.trim();
    if (text.length === 0) return false;
    const record = store
      .listExternalEvidence(initiative.id)
      .find((item) => item.id === input.id);
    if (record === undefined) return false;
    // A record that is no longer current is history. Challenging it would attach new material to
    // a revision nothing reads, so it is refused whatever state a human left it in.
    if (record.state === "superseded" || record.supersededById !== undefined) return false;
    const challenge: ExternalEvidenceChallenge = {
      cycleId: cycle.id,
      participantIds: [...input.participantIds],
      text,
      recordedAt: stamp(),
    };
    store.commitExternalEvidence([challengeExternalEvidence(record, challenge)]);
    return true;
  };

  const resolve: LongitudinalService["resolve"] = (input) => {
    const initiative = mutableInitiative();
    if (initiative === undefined) return false;
    const reason = input.reason?.trim();
    const delta = (input.materialEvidenceDelta ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (input.action === "reopen" && (reason === undefined || reason.length === 0)) return false;
    if (input.action === "reopen" && delta.length === 0) return false;
    if (input.action === "supersede") {
      const replacement = input.supersededById?.trim();
      if (replacement === undefined || replacement.length === 0) return false;
      if (replacement === input.id) return false;
      const known = input.target === "decision"
        ? store.listDecisions(initiative.id).some((item) => item.id === replacement)
        : input.target === "artifact"
          ? store.listArtifacts(initiative.id).some((item) => item.id === replacement)
          : input.target === "externalEvidence"
            ? store.listExternalEvidence(initiative.id).some((item) => item.id === replacement)
            : store.listFindingHistory(initiative.id).some((item) => item.identity === replacement);
      if (!known) return false;
    }
    const resolution: HumanResolution = {
      action: input.action,
      resolvedBy: input.resolvedBy,
      resolvedAt: stamp(),
      ...(reason === undefined || reason.length === 0 ? {} : { reason }),
      ...(input.supersededById === undefined
        ? {}
        : { supersededById: input.supersededById.trim() }),
      ...(delta.length === 0 ? {} : { materialEvidenceDelta: delta }),
    };
    const cycle = currentCycle();
    if (input.target === "externalEvidence") {
      const record = store
        .listExternalEvidence(initiative.id)
        .find((item) => item.id === input.id);
      if (record === undefined) return false;
      // A superseded record keeps the state a human put it in, which is why the state matrix
      // alone would still permit a ruling on it. Currency is the separate test: a human rules on
      // the record that is current, not on a revision something else replaced.
      if (record.supersededById !== undefined) return false;
      if (!resolutionIsAllowed("externalEvidence", record.state, input.action)) return false;
      store.commitExternalEvidence([resolveExternalEvidence(record, resolution)]);
      return true;
    }
    if (input.target === "finding") {
      const entry = store
        .listFindingHistory(initiative.id)
        .find((item) => item.identity === input.id);
      if (entry === undefined) return false;
      if (!resolutionIsAllowed("finding", entry.state, input.action)) return false;
      const resolved = resolveFinding(entry, resolution, cycle?.id);
      const nextCycle = cycle !== undefined && resolved.state === "resolved"
        ? deltaWith(cycle, "resolvedFindingIdentities", entry.identity, resolution.resolvedAt)
        : undefined;
      store.commitResolution({
        findings: [resolved],
        ...(nextCycle === undefined ? {} : { cycle: nextCycle }),
      });
      return true;
    }
    if (input.target === "decision") {
      const decision = store.listDecisions(initiative.id).find((item) => item.id === input.id);
      if (decision === undefined) return false;
      if (!resolutionIsAllowed("decision", decision.state, input.action)) return false;
      const nextCycle = cycle !== undefined && input.action === "accept"
        ? deltaWith(cycle, "acceptedDecisionIds", input.id, resolution.resolvedAt)
        : undefined;
      store.commitResolution({
        decisions: [resolveDecision(decision, resolution)],
        ...(nextCycle === undefined ? {} : { cycle: nextCycle }),
      });
      return true;
    }
    const artifacts = store.listArtifacts(initiative.id);
    const artifact = artifacts.find((item) => item.id === input.id);
    if (artifact === undefined) return false;
    if (!resolutionIsAllowed("artifact", artifact.state, input.action)) return false;
    const resolved = resolveArtifact(artifact, resolution);
    const nextCycle = cycle === undefined
      ? undefined
      : input.action === "accept"
        ? deltaWith(cycle, "acceptedArtifactIds", input.id, resolution.resolvedAt)
        : input.action === "reject"
          ? deltaWith(cycle, "rejectedArtifactIds", input.id, resolution.resolvedAt)
          : undefined;
    store.commitResolution({
      artifacts: [
        ...(resolution.action === "accept"
          ? supersedeArtifactAncestors(artifacts, resolved, resolution.resolvedAt)
          : []),
        resolved,
      ],
      ...(nextCycle === undefined ? {} : { cycle: nextCycle }),
    });
    return true;
  };

  return {
    recordExternalEvidence,
    challengeExternalEvidence: challengeExternalEvidenceRecord,
    snapshot,
    summary,
    currentInitiative,
    listInitiatives,
    createInitiative,
    switchInitiative,
    setInitiativeStatus,
    exportInitiative,
    importInitiative,
    currentCycle,
    defineInitiative,
    setDirection,
    startCycle,
    rebaseline,
    recordVerification,
    boundInitiativeId: (runRef) => initiativeForRun(runRef)?.id,
    isScopedFixRun: (runRef) =>
      store.fixRunsForRun(runRef).some((item) => item.imported !== true),
    rounds,
    runBinding: (runRef) => store.runBinding(runRef),
    bindRun,
    recordRound,
    closeCycle,
    findingAliases,
    mergeFindings,
    unmergeFinding,
    fixRuns,
    linkFixRun,
    recordFixOutcome,
    recordAppliedWork,
    saveDecisions: (decisions) => {
      mutableInitiative();
      store.saveDecisions(decisions);
    },
    saveArtifacts: (artifacts) => {
      mutableInitiative();
      store.saveArtifacts(artifacts);
    },
    recordPatchArtifact,
    resolve,
  };
};
