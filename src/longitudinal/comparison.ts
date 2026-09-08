import type { VerificationResult } from "../results/projectResult";
import { findingIsOpen, findingNeedsFix, findingNeedsRuling } from "./lifecycle";
import type {
  DecisionRecord,
  FindingHistoryEntry,
  RoundDecisionChange,
} from "./types";

export type DecisionChange = RoundDecisionChange;

export type RoundComparison = {
  cycleId: string;
  newMaterial: FindingHistoryEntry[];
  repeated: FindingHistoryEntry[];
  resolved: FindingHistoryEntry[];
  regressed: FindingHistoryEntry[];
  reopened: FindingHistoryEntry[];
  notObserved: FindingHistoryEntry[];
  outstandingAccepted: FindingHistoryEntry[];
  decisionChanges: DecisionChange[];
};

const byIdentity = (
  entries: readonly FindingHistoryEntry[],
): Map<string, FindingHistoryEntry> =>
  new Map(entries.map((entry) => [entry.identity, entry]));

const select = (
  entries: Map<string, FindingHistoryEntry>,
  identities: readonly string[],
): FindingHistoryEntry[] =>
  identities.flatMap((identity) => {
    const entry = entries.get(identity);
    return entry === undefined ? [] : [entry];
  });

export const decisionChanges = (
  previous: readonly DecisionRecord[],
  next: readonly DecisionRecord[],
): DecisionChange[] => {
  const before = new Map(previous.map((decision) => [decision.id, decision]));
  return next.flatMap((decision) => {
    const earlier = before.get(decision.id);
    if (earlier !== undefined && earlier.state === decision.state) return [];
    const reason = decision.humanResolution?.reason ?? decision.reopenReason;
    return [{
      decisionId: decision.id,
      subject: decision.subject,
      ...(earlier === undefined ? {} : { from: earlier.state }),
      to: decision.state,
      ...(reason === undefined ? {} : { reason }),
    }];
  });
};

export const compareRound = (input: {
  cycleId: string;
  history: readonly FindingHistoryEntry[];
  newIdentities: readonly string[];
  repeatedIdentities: readonly string[];
  resolvedIdentities: readonly string[];
  regressedIdentities: readonly string[];
  reopenedIdentities: readonly string[];
  notObservedIdentities?: readonly string[];
  previousDecisions?: readonly DecisionRecord[];
  currentDecisions?: readonly DecisionRecord[];
  recordedDecisionChanges?: readonly DecisionChange[];
}): RoundComparison => {
  const entries = byIdentity(input.history);
  return {
    cycleId: input.cycleId,
    newMaterial: select(entries, input.newIdentities),
    repeated: select(entries, input.repeatedIdentities),
    resolved: select(entries, input.resolvedIdentities),
    regressed: select(entries, input.regressedIdentities),
    reopened: select(entries, input.reopenedIdentities),
    notObserved: select(entries, input.notObservedIdentities ?? []),
    outstandingAccepted: input.history.filter(
      (entry) => findingNeedsRuling(entry) || findingNeedsFix(entry),
    ),
    decisionChanges: input.recordedDecisionChanges === undefined
      ? decisionChanges(input.previousDecisions ?? [], input.currentDecisions ?? [])
      : [...input.recordedDecisionChanges],
  };
};

export type SaturationReport = {
  saturated: boolean;
  quietFreshReviews: number;
  quietReviewSignal: number;
  signalReached: boolean;
  reasons: string[];
};

export const QUIET_FRESH_REVIEW_SIGNAL = 2;

const quietReviewCountWord = (count: number): string =>
  count === 1 ? "One" : count === 2 ? "Two" : String(count);

export const quietFreshReviewStatement = (report: {
  quietFreshReviews: number;
  quietReviewSignal: number;
  signalReached: boolean;
}): string =>
  report.quietFreshReviews === 0
    ? "No fresh review has found no material change yet. Continue or close the cycle."
    : report.signalReached
      ? `${quietReviewCountWord(report.quietFreshReviews)} consecutive fresh reviews found no material change. Continue or close the cycle.`
      : `${quietReviewCountWord(report.quietFreshReviews)} of ${String(report.quietReviewSignal)} consecutive fresh reviews found no material change. Continue or close the cycle.`;

export const saturationReport = (input: {
  quietFreshReviews: number;
  quietReviewSignal?: number;
  history: readonly FindingHistoryEntry[];
  decisions: readonly DecisionRecord[];
  checks: readonly VerificationResult[];
  verificationExpected: boolean;
  driftReasons?: readonly string[];
}): SaturationReport => {
  const signal = input.quietReviewSignal ?? QUIET_FRESH_REVIEW_SIGNAL;
  const signalReached = input.quietFreshReviews >= signal;
  const reasons: string[] = [];
  if (!signalReached) {
    reasons.push(
      `${String(input.quietFreshReviews)} of ${String(signal)} consecutive fresh reviews found no material change`,
    );
  }
  const outstanding = input.history.filter(
    (entry) => findingIsOpen(entry) && entry.humanResolution === undefined,
  );
  if (outstanding.length > 0) {
    reasons.push(
      `${String(outstanding.length)} findings are neither resolved nor explicitly accepted`,
    );
  }
  const unfixed = input.history.filter((entry) => findingNeedsFix(entry));
  if (unfixed.length > 0) {
    reasons.push(
      `${String(unfixed.length)} accepted findings have no verified fix`,
    );
  }
  const openDecisions = input.decisions.filter(
    (decision) => decision.state === "proposed" || decision.state === "deferred",
  );
  if (openDecisions.length > 0) {
    reasons.push(`${String(openDecisions.length)} core decisions are still open`);
  }
  const drift = [...(input.driftReasons ?? [])];
  drift.forEach((reason) => reasons.push(reason));
  const staleChecks = drift.length > 0
    ? input.checks
    : input.checks.filter((check) => check.stale === true);
  const failedChecks = input.checks.filter(
    (check) => check.status !== "passed",
  );
  if (input.verificationExpected && input.checks.length === 0) {
    reasons.push("No required check has been run against the current candidate");
  }
  if (staleChecks.length > 0) {
    reasons.push(`${String(staleChecks.length)} required checks are stale`);
  }
  if (failedChecks.length > 0) {
    reasons.push(`${String(failedChecks.length)} required checks did not pass`);
  }
  return {
    saturated: reasons.length === 0,
    quietFreshReviews: input.quietFreshReviews,
    quietReviewSignal: signal,
    signalReached,
    reasons,
  };
};

export const SATURATION_DISCLAIMER =
  "Saturation means repeated fresh review stopped producing material findings. It is not a correctness proof. No review count is required, and you can close this cycle whenever you decide the evidence is enough.";
