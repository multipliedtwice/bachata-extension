import { findingIsOpen, findingNeedsFix, findingNeedsRuling } from "./lifecycle";
import { quietFreshReviewStatement, SATURATION_DISCLAIMER } from "./comparison";
import type { RoundComparison, SaturationReport } from "./comparison";
import type {
  Cycle,
  CycleBaseline,
  CycleVerification,
  DecisionRecord,
  DirectionRevision,
  FindingHistoryEntry,
  FindingReconciliationQuestion,
  Initiative,
  InitiativeArtifact,
} from "./types";

export type NextActionKind =
  | "defineInitiative"
  | "resolveDecisions"
  | "reviewRegressions"
  | "ruleOnFindings"
  | "reconcileFindings"
  | "fixAcceptedFindings"
  | "runRequiredChecks"
  | "rebaseline"
  | "freshReview"
  | "closeCycle"
  | "startCycle";

export type NextActionCommand =
  | { type: "focusDirection"; section: "initiative" | "decisions" | "findings" }
  | { type: "startScopedFix"; identity: string }
  | { type: "runRequiredChecks" }
  | { type: "rebaseline" }
  | { type: "freshReview" }
  | { type: "closeCycle" }
  | { type: "startCycle" };

export type NextAction = {
  kind: NextActionKind;
  label: string;
  detail: string;
  command: NextActionCommand;
};

export type DirectionView = {
  goal?: string;
  desiredOutcome?: string;
  acceptedDirection?: string;
  directionRevisions: DirectionRevision[];
  acceptanceCriteria: string[];
  constraints: string[];
  initiativeStatus?: Initiative["status"];
  currentCycle?: {
    id: string;
    sequence: number;
    type: Cycle["type"];
    completion: Cycle["completion"];
    runCount: number;
  };
  baseline?: CycleBaseline;
  currentBaseline?: CycleBaseline;
  baselineDrift: string[];
  verification?: CycleVerification;
  latestChange?: RoundComparison;
  acceptedArtifacts: InitiativeArtifact[];
  proposedArtifacts: InitiativeArtifact[];
  decisionsNeedingHuman: DecisionRecord[];
  findingsNeedingRuling: FindingHistoryEntry[];
  outstandingAcceptedFindings: FindingHistoryEntry[];
  unresolvedFindings: FindingHistoryEntry[];
  reconciliationQuestions: FindingReconciliationQuestion[];
  // Attention projections above are deliberately compressed. These two carry the whole
  // semantic record so resolved, rejected and superseded work stays reachable in history
  // instead of leaving the product when it leaves the top-level surface.
  decisionHistory: DecisionRecord[];
  findingHistory: FindingHistoryEntry[];
  saturation: SaturationReport;
  saturationDisclaimer: string;
  quietReviewStatement: string;
  closeCycleAvailable: boolean;
  nextAction: NextAction;
};

export const decisionsNeedingHumanJudgement = (
  decisions: readonly DecisionRecord[],
): DecisionRecord[] =>
  decisions.filter(
    (decision) =>
      decision.state === "deferred" ||
      (decision.state === "proposed" && decision.humanResolution === undefined),
  );

const currentArtifacts = (
  artifacts: readonly InitiativeArtifact[],
): InitiativeArtifact[] =>
  artifacts.filter((artifact) => artifact.supersededById === undefined);

export const acceptedArtifacts = (
  artifacts: readonly InitiativeArtifact[],
): InitiativeArtifact[] =>
  currentArtifacts(artifacts).filter((artifact) => artifact.state === "accepted");

export const proposedArtifacts = (
  artifacts: readonly InitiativeArtifact[],
): InitiativeArtifact[] =>
  currentArtifacts(artifacts).filter((artifact) => artifact.state === "proposed");

export const findingsNeedingRuling = (
  history: readonly FindingHistoryEntry[],
): FindingHistoryEntry[] => history.filter((entry) => findingNeedsRuling(entry));

export const outstandingAcceptedFindings = (
  history: readonly FindingHistoryEntry[],
): FindingHistoryEntry[] => history.filter((entry) => findingNeedsFix(entry));

const nextActionFor = (input: {
  initiative?: Initiative;
  decisionsNeedingHuman: DecisionRecord[];
  regressions: FindingHistoryEntry[];
  needingRuling: FindingHistoryEntry[];
  reconciliationQuestions: FindingReconciliationQuestion[];
  outstanding: FindingHistoryEntry[];
  checkReasons: string[];
  baselineDrift: string[];
  cycleOpen: boolean;
  saturation: SaturationReport;
}): NextAction => {
  if (input.initiative === undefined) {
    return {
      kind: "defineInitiative",
      label: "State what this work is trying to achieve",
      detail: "Bachata has no recorded goal, desired outcome, or acceptance criteria for this repository.",
      command: { type: "focusDirection", section: "initiative" },
    };
  }
  if (input.decisionsNeedingHuman.length > 0) {
    const count = input.decisionsNeedingHuman.length;
    return {
      kind: "resolveDecisions",
      label: `Resolve ${String(count)} decision${count === 1 ? "" : "s"}`,
      detail: input.decisionsNeedingHuman.map((decision) => decision.subject).join("; "),
      command: { type: "focusDirection", section: "decisions" },
    };
  }
  if (input.regressions.length > 0) {
    const count = input.regressions.length;
    return {
      kind: "reviewRegressions",
      label: `Review ${String(count)} regression${count === 1 ? "" : "s"}`,
      detail: input.regressions.map((entry) => entry.subject).join("; "),
      command: { type: "focusDirection", section: "findings" },
    };
  }
  if (input.needingRuling.length > 0) {
    const count = input.needingRuling.length;
    return {
      kind: "ruleOnFindings",
      label: `Resolve ${String(count)} unresolved finding${count === 1 ? "" : "s"}`,
      detail: input.needingRuling.map((entry) => entry.subject).join("; "),
      command: { type: "focusDirection", section: "findings" },
    };
  }
  if (input.reconciliationQuestions.length > 0) {
    const count = input.reconciliationQuestions.length;
    return {
      kind: "reconcileFindings",
      label: `Decide how ${String(count)} finding${count === 1 ? "" : "s"} map${count === 1 ? "s" : ""} to earlier ones`,
      detail: input.reconciliationQuestions
        .map((item) => `${item.subject}: ${item.detail}`)
        .join("; "),
      command: { type: "focusDirection", section: "findings" },
    };
  }
  const [firstOutstanding] = input.outstanding;
  if (firstOutstanding) {
    const count = input.outstanding.length;
    return {
      kind: "fixAcceptedFindings",
      label: `Fix ${String(count)} accepted finding${count === 1 ? "" : "s"}`,
      detail: input.outstanding.map((entry) => entry.subject).join("; "),
      command: { type: "startScopedFix", identity: firstOutstanding.identity },
    };
  }
  if (input.baselineDrift.length > 0) {
    return {
      kind: "rebaseline",
      label: "Rebaseline this cycle against the current repository state",
      detail: input.baselineDrift.join("; "),
      command: { type: "rebaseline" },
    };
  }
  if (input.checkReasons.length > 0) {
    return {
      kind: "runRequiredChecks",
      label: "Run the required checks against the current candidate",
      detail: input.checkReasons.join("; "),
      command: { type: "runRequiredChecks" },
    };
  }
  if (!input.saturation.saturated) {
    return {
      kind: "freshReview",
      label: "Start a fresh review against the current repository state",
      detail: input.saturation.signalReached
        ? input.saturation.reasons.join("; ")
        : quietFreshReviewStatement(input.saturation),
      command: { type: "freshReview" },
    };
  }
  if (input.cycleOpen) {
    return {
      kind: "closeCycle",
      label: "Close this cycle and choose the next one",
      detail: SATURATION_DISCLAIMER,
      command: { type: "closeCycle" },
    };
  }
  return {
    kind: "startCycle",
    label: "Start the next cycle",
    detail: "This cycle is closed. The next cycle records its own repository candidate.",
    command: { type: "startCycle" },
  };
};

const CHECK_REASON_PREFIXES = [
  "No required check",
  "required checks are stale",
  "required checks did not pass",
];

export const directionView = (input: {
  initiative?: Initiative;
  currentCycle?: Cycle;
  latestChange?: RoundComparison;
  artifacts?: readonly InitiativeArtifact[];
  decisions: readonly DecisionRecord[];
  history: readonly FindingHistoryEntry[];
  saturation: SaturationReport;
  reconciliationQuestions?: readonly FindingReconciliationQuestion[];
  currentBaseline?: CycleBaseline;
  baselineDrift?: readonly string[];
  verification?: CycleVerification;
}): DirectionView => {
  const needingHuman = decisionsNeedingHumanJudgement(input.decisions);
  const needingRuling = findingsNeedingRuling(input.history);
  const reconciliationQuestions = [...(input.reconciliationQuestions ?? [])];
  const outstanding = outstandingAcceptedFindings(input.history);
  const regressions = input.history.filter((entry) => entry.state === "regressed");
  const drift = [...(input.baselineDrift ?? [])];
  const checkReasons = input.saturation.reasons.filter((reason) =>
    CHECK_REASON_PREFIXES.some((prefix) => reason.includes(prefix)),
  );
  return {
    ...(input.initiative?.goal === undefined ? {} : { goal: input.initiative.goal }),
    ...(input.initiative?.desiredOutcome === undefined || input.initiative.desiredOutcome === ""
      ? {}
      : { desiredOutcome: input.initiative.desiredOutcome }),
    ...(input.initiative?.currentDirection === undefined
      ? {}
      : { acceptedDirection: input.initiative.currentDirection }),
    directionRevisions: [...(input.initiative?.directionRevisions ?? [])],
    acceptanceCriteria: input.initiative?.acceptanceCriteria ?? [],
    constraints: input.initiative?.constraints ?? [],
    ...(input.initiative === undefined ? {} : { initiativeStatus: input.initiative.status }),
    ...(input.currentCycle === undefined
      ? {}
      : {
          currentCycle: {
            id: input.currentCycle.id,
            sequence: input.currentCycle.sequence,
            type: input.currentCycle.type,
            completion: input.currentCycle.completion,
            runCount: input.currentCycle.runRefs.length,
          },
        }),
    ...(input.currentCycle?.repositoryBaseline === undefined
      ? {}
      : { baseline: input.currentCycle.repositoryBaseline }),
    ...(input.currentBaseline === undefined ? {} : { currentBaseline: input.currentBaseline }),
    baselineDrift: drift,
    ...(input.verification === undefined ? {} : { verification: input.verification }),
    ...(input.latestChange === undefined ? {} : { latestChange: input.latestChange }),
    acceptedArtifacts: acceptedArtifacts(input.artifacts ?? []),
    proposedArtifacts: proposedArtifacts(input.artifacts ?? []),
    decisionsNeedingHuman: needingHuman,
    findingsNeedingRuling: needingRuling,
    outstandingAcceptedFindings: outstanding,
    unresolvedFindings: input.history.filter(
      (entry) => findingIsOpen(entry) && !findingNeedsRuling(entry) && !findingNeedsFix(entry),
    ),
    reconciliationQuestions,
    decisionHistory: [...input.decisions],
    findingHistory: [...input.history],
    saturation: input.saturation,
    saturationDisclaimer: SATURATION_DISCLAIMER,
    quietReviewStatement: quietFreshReviewStatement(input.saturation),
    closeCycleAvailable: input.currentCycle?.completion === "open",
    nextAction: nextActionFor({
      ...(input.initiative === undefined ? {} : { initiative: input.initiative }),
      decisionsNeedingHuman: needingHuman,
      regressions,
      needingRuling,
      reconciliationQuestions,
      outstanding,
      checkReasons,
      baselineDrift: drift,
      cycleOpen: input.currentCycle?.completion === "open",
      saturation: input.saturation,
    }),
  };
};
