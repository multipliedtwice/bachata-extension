/**
 * EX-3. What a finished run contributes to the longitudinal record, apart from writing it.
 *
 * Recording a round is one storage call surrounded by judgements: whether this run records at all,
 * whether it counts as an independent review, what it is allowed to say when it does not, and what
 * the stored candidate carries. Those judgements decide whether a review's silence about a finding
 * is read as an observation — the difference between a cycle that closes and one that stays open —
 * and every one of them was reachable only by running a whole review against a real store.
 */
export type RoundEligibility = {
  freshReview: boolean;
  /** Present only when a declared fresh review was demoted, and says why in the round's own words. */
  notCountedBecause?: string;
  notices: string[];
};

/**
 * Whether a run counts as an independent review.
 *
 * EX-G6-03. A review that errored or was interrupted stopped looking before it finished, so it did
 * not observe the absence of anything. EX-A5-R04. Workflow completion says the steps ran, not that
 * anything was observed: a round may resolve findings and count toward saturation only when the
 * run's own assessment is usable and the evidence its pipeline declares is actually there.
 *
 * A demoted round is still recorded — it happened, and its evidence is real — with the reason
 * travelling beside it, so the history shows an inconclusive round rather than a missing one.
 */
export const roundEligibility = (input: {
  declaredFreshReview: boolean;
  workflowStatus: string;
  evidenceGaps: readonly string[];
  finalAssessment: { outcome: string; summary: string };
}): RoundEligibility => {
  const reviewCompleted = input.workflowStatus === "completed";
  const inspectionRecorded = input.evidenceGaps.length === 0;
  const assessmentUsable = input.finalAssessment.outcome === "completed";
  const freshReview =
    input.declaredFreshReview && reviewCompleted && inspectionRecorded && assessmentUsable;
  if (!input.declaredFreshReview || freshReview) return { freshReview, notices: [] };
  const notCountedBecause = !reviewCompleted
    ? `ended as ${input.workflowStatus} instead of completing`
    : !inspectionRecorded
      ? `did not record the evidence its workflow declares: ${input.evidenceGaps.join("; ")}`
      : `reached no usable assessment: ${input.finalAssessment.outcome} — ${input.finalAssessment.summary}`;
  return {
    freshReview,
    notCountedBecause,
    notices: [
      `This fresh review ${notCountedBecause}, so it is recorded as evidence and not as an independent review: its silence about a finding is not an observation.`,
    ],
  };
};

export type RoundCandidate<Finding, DecisionSource, PlanSource, Artifact> = {
  runRef: string;
  executionRef: string;
  freshReview: boolean;
  findings: readonly Finding[];
  decisionSource?: DecisionSource;
  planSource?: PlanSource;
  declaredArtifacts?: readonly Artifact[];
  validationErrors?: string[];
};

/**
 * The round as it is stored. The execution it came from is carried exactly — a round attributed to
 * the wrong execution is a finding attributed to work that did not produce it — and every optional
 * field stays absent rather than empty, so "nothing was declared" and "an empty declaration" do
 * not read alike. Validation errors from the decision artefact, the plan artefact and the
 * eligibility demotion are one list, in that order.
 */
export const roundCandidateFrom = <Finding, DecisionSource, PlanSource, Artifact>(input: {
  runRef: string;
  executionRef: string;
  eligibility: RoundEligibility;
  findings: readonly Finding[];
  decisions: { source?: DecisionSource | undefined; errors: readonly string[] };
  plan: { source?: PlanSource | undefined; errors: readonly string[] };
  declaredArtifacts: readonly Artifact[];
}): RoundCandidate<Finding, DecisionSource, PlanSource, Artifact> => {
  const validationErrors = [
    ...input.decisions.errors,
    ...input.plan.errors,
    ...input.eligibility.notices,
  ];
  return {
    runRef: input.runRef,
    executionRef: input.executionRef,
    freshReview: input.eligibility.freshReview,
    findings: input.findings,
    ...(input.decisions.source === undefined ? {} : { decisionSource: input.decisions.source }),
    ...(input.plan.source === undefined ? {} : { planSource: input.plan.source }),
    ...(input.declaredArtifacts.length === 0
      ? {}
      : { declaredArtifacts: input.declaredArtifacts }),
    ...(validationErrors.length === 0 ? {} : { validationErrors }),
  };
};

export type RoundRecordingDecision =
  /** Nothing to record: no execution behind the run, or a workflow that records nothing. */
  | { record: false; failure?: undefined }
  /** The workflow records against an initiative the repository no longer has. */
  | { record: false; failure: string }
  | { record: true; failure?: undefined };

/**
 * Whether this run records a round at all.
 *
 * A run-local workflow has nothing to persist and must not report a failure to do so. An
 * initiative-required run cannot normally reach here — it is refused before any provider starts —
 * so an initiative that is gone by the time the run ends is worth saying rather than skipping.
 */
export const roundRecordingDecision = (input: {
  executionRef: string | undefined;
  declaredIntent: string;
  hasInitiative: boolean;
  runRef: string;
}): RoundRecordingDecision => {
  if (input.executionRef === undefined) return { record: false };
  if (input.declaredIntent !== "initiativeRequired") return { record: false };
  if (!input.hasInitiative) {
    return {
      record: false,
      failure: `The result of ${input.runRef} was not recorded: its workflow records against an initiative, and this repository no longer has one.`,
    };
  }
  return { record: true };
};

/**
 * What the onboarding journey is told after a fresh review is stored: that one happened, and — when
 * the cycle already had rounds — how many rounds are now comparable.
 */
export const freshReviewJourneyEvents = (input: {
  freshReview: boolean;
  priorRounds: number;
}): ({ kind: "freshReviewCompleted" } | { kind: "freshReviewCompared"; comparedRounds: number })[] => {
  if (!input.freshReview) return [];
  return [
    { kind: "freshReviewCompleted" },
    ...(input.priorRounds > 0
      ? [{ kind: "freshReviewCompared" as const, comparedRounds: input.priorRounds + 1 }]
      : []),
  ];
};
