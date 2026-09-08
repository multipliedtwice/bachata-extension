export type OnboardingMilestone =
  | "providerAvailable"
  | "readinessVerified"
  | "workflowSelected"
  | "reviewCompleted"
  | "evidenceReviewed"
  | "resolutionRecorded"
  | "fixCompleted"
  | "workApplied"
  | "freshReviewCompleted"
  | "freshReviewCompared"
  | "nextActionChosen";

export type MilestoneState = "pending" | "done" | "notApplicable";

// Every field is required. A journey that cannot name all three is not an identity, and an
// event carrying a partial one must not advance a first run it may have nothing to do with.
export type OnboardingJourney = {
  repositoryRoot: string;
  initiativeId: string;
  runRef: string;
};

export type OnboardingProgress = Record<OnboardingMilestone, MilestoneState> & {
  journey?: OnboardingJourney;
  // Which repository the readiness milestones above were proven against, while no run has
  // claimed them yet. Readiness is about one repository's providers and workflows, so it
  // must not follow a later run into a different one.
  pendingReadinessRoot?: string;
};

export const onboardingMilestones: OnboardingMilestone[] = [
  "providerAvailable",
  "readinessVerified",
  "workflowSelected",
  "reviewCompleted",
  "evidenceReviewed",
  "resolutionRecorded",
  "fixCompleted",
  "workApplied",
  "freshReviewCompleted",
  "freshReviewCompared",
  "nextActionChosen",
];

export const onboardingContextKeys: Record<OnboardingMilestone, string> = {
  providerAvailable: "bachata.onboarding.providerAvailable",
  readinessVerified: "bachata.onboarding.readinessVerified",
  workflowSelected: "bachata.onboarding.workflowSelected",
  reviewCompleted: "bachata.onboarding.reviewCompleted",
  evidenceReviewed: "bachata.onboarding.evidenceReviewed",
  resolutionRecorded: "bachata.onboarding.resolutionRecorded",
  fixCompleted: "bachata.onboarding.fixCompleted",
  workApplied: "bachata.onboarding.workApplied",
  freshReviewCompleted: "bachata.onboarding.freshReviewCompleted",
  freshReviewCompared: "bachata.onboarding.freshReviewCompared",
  nextActionChosen: "bachata.onboarding.nextActionChosen",
};

export const milestoneSatisfied = (state: MilestoneState): boolean => state !== "pending";

export const emptyOnboardingProgress = (): OnboardingProgress =>
  onboardingMilestones.reduce<OnboardingProgress>((result, milestone) => {
    result[milestone] = "pending";
    return result;
  }, {} as OnboardingProgress);

const readMilestoneState = (value: unknown): MilestoneState => {
  if (value === true || value === "done") return "done";
  if (value === "notApplicable") return "notApplicable";
  return "pending";
};

const readJourney = (value: unknown): OnboardingJourney | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const repositoryRoot = typeof record.repositoryRoot === "string" ? record.repositoryRoot : undefined;
  const initiativeId = typeof record.initiativeId === "string" ? record.initiativeId : undefined;
  const runRef = typeof record.runRef === "string" ? record.runRef : undefined;
  // A stored journey missing any field is discarded rather than half-trusted.
  if (repositoryRoot === undefined || initiativeId === undefined || runRef === undefined) {
    return undefined;
  }
  return { repositoryRoot, initiativeId, runRef };
};

export const readOnboardingProgress = (value: unknown): OnboardingProgress => {
  const stored = typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
  const progress = onboardingMilestones.reduce<OnboardingProgress>((result, milestone) => {
    result[milestone] = readMilestoneState(stored[milestone]);
    return result;
  }, emptyOnboardingProgress());
  const journey = readJourney(stored.journey);
  const pendingReadinessRoot = typeof stored.pendingReadinessRoot === "string"
    ? stored.pendingReadinessRoot
    : undefined;
  return {
    ...progress,
    ...(journey === undefined ? {} : { journey }),
    ...(pendingReadinessRoot === undefined ? {} : { pendingReadinessRoot }),
  };
};

export type OnboardingEvent = { journey?: OnboardingJourney } & (
  | {
      kind: "readiness";
      repositoryRoot?: string;
      availableProviders: number;
      blockingFindings: number;
      selectedPipelineId?: string;
      selectedSafetyLevel?: string;
    }
  | {
      kind: "runCompleted";
      status: string;
      safetyLevel?: string;
      changedFilesRecorded: boolean;
      resolvableFindings?: number;
      scopedFix?: boolean;
    }
  | { kind: "evidenceReviewed" }
  | { kind: "resolutionRecorded" }
  | { kind: "workApplied" }
  | { kind: "freshReviewCompleted" }
  | { kind: "freshReviewCompared"; comparedRounds: number }
  | { kind: "nextActionChosen" }
);

const record = (
  progress: OnboardingProgress,
  milestone: OnboardingMilestone,
  state: MilestoneState,
): OnboardingProgress => {
  if (state === "notApplicable" && progress[milestone] === "done") return progress;
  if (progress[milestone] === state) return progress;
  return { ...progress, [milestone]: state };
};

// Identity is compared strictly. A missing field is a different journey, not a compatible
// one: an event that cannot say which run, repository, and initiative it belongs to must
// never advance a first run it may have nothing to do with.
// Two journeys match only when every field matches. A journeyless event never reaches here.
const sameJourney = (
  a: OnboardingJourney | undefined,
  b: OnboardingJourney,
): boolean =>
  a !== undefined &&
  a.repositoryRoot === b.repositoryRoot &&
  a.initiativeId === b.initiativeId &&
  a.runRef === b.runRef;

// Progress belongs to one journey. An event from another repository or initiative starts a
// new one rather than adding to a first run it was never part of.
export const advanceOnboarding = (
  progress: OnboardingProgress,
  event: OnboardingEvent,
): OnboardingProgress => {
  // Readiness describes one repository's providers and chosen workflow, not one run. Setup
  // and Doctor emit it before any run exists, so it carries no journey and must never reset
  // one; only journey-bound events start or switch a journey.
  if (event.journey === undefined) {
    if (event.kind !== "readiness") return progress;
    const root = event.repositoryRoot;
    if (progress.journey !== undefined) {
      // Readiness for another repository is not this journey's readiness.
      return root !== undefined && root !== progress.journey.repositoryRoot
        ? progress
        : applyMilestones(progress, event);
    }
    // Readiness proven for one repository never carries over to another.
    const base = root !== undefined &&
      progress.pendingReadinessRoot !== undefined &&
      progress.pendingReadinessRoot !== root
      ? emptyOnboardingProgress()
      : progress;
    return applyMilestones(
      root === undefined ? base : { ...base, pendingReadinessRoot: root },
      event,
    );
  }
  if (progress.journey === undefined) {
    // Adopting an identity is not switching away from one, so readiness already proven for
    // this repository survives. Readiness proven elsewhere does not.
    const carried = progress.pendingReadinessRoot !== undefined &&
      progress.pendingReadinessRoot !== event.journey.repositoryRoot
      ? emptyOnboardingProgress()
      : progress;
    const { pendingReadinessRoot, ...withoutPendingRoot } = carried;
    return applyMilestones({ ...withoutPendingRoot, journey: event.journey }, event);
  }
  if (!sameJourney(progress.journey, event.journey)) {
    // A fresh review is a new run by definition, and it is the same repository and initiative
    // repeating the review this journey already completed. Resetting on its run ref would
    // discard the very milestone its own event is guarded on, leaving the last steps of the
    // walkthrough unreachable for the case the walkthrough describes.
    const continued = freshReviewEvent(event.kind) &&
      sameWork(progress.journey, event.journey);
    return applyMilestones(
      continued
        ? { ...progress, journey: event.journey }
        : { ...emptyOnboardingProgress(), journey: event.journey },
      event,
    );
  }
  return applyMilestones(progress, event);
};

const freshReviewEvent = (kind: OnboardingEvent["kind"]): boolean =>
  kind === "freshReviewCompleted" ||
  kind === "freshReviewCompared" ||
  kind === "nextActionChosen";

const sameWork = (
  a: OnboardingJourney,
  b: OnboardingJourney,
): boolean => a.repositoryRoot === b.repositoryRoot && a.initiativeId === b.initiativeId;

const applyMilestones = (
  progress: OnboardingProgress,
  event: OnboardingEvent,
): OnboardingProgress => {
  if (event.kind === "readiness") {
    let next = progress;
    if (event.availableProviders > 0) next = record(next, "providerAvailable", "done");
    if (
      event.availableProviders > 0 &&
      event.blockingFindings === 0 &&
      event.selectedPipelineId !== undefined
    ) {
      next = record(next, "readinessVerified", "done");
    }
    if (event.selectedPipelineId !== undefined && event.selectedSafetyLevel === "review") {
      next = record(next, "workflowSelected", "done");
    }
    return next;
  }
  if (event.kind === "runCompleted") {
    let next = progress;
    if (event.status === "completed" && event.safetyLevel === "review") {
      next = record(next, "reviewCompleted", "done");
      // A clean review leaves nothing to resolve, fix, or apply, but it is never
      // evidence that the reader opened the result.
      if (event.resolvableFindings === 0) {
        next = record(next, "resolutionRecorded", "notApplicable");
        next = record(next, "fixCompleted", "notApplicable");
        next = record(next, "workApplied", "notApplicable");
      }
    }
    if (
      event.status === "completed" &&
      event.scopedFix === true &&
      event.changedFilesRecorded &&
      event.safetyLevel !== undefined &&
      event.safetyLevel !== "review"
    ) {
      next = record(next, "fixCompleted", "done");
    }
    return next;
  }
  // Each milestone requires only the facts that make it possible, never the
  // walkthrough's preferred order: a valid action taken early is still recorded.
  if (event.kind === "evidenceReviewed") {
    return milestoneSatisfied(progress.reviewCompleted)
      ? record(progress, "evidenceReviewed", "done")
      : progress;
  }
  if (event.kind === "resolutionRecorded") {
    return milestoneSatisfied(progress.reviewCompleted)
      ? record(progress, "resolutionRecorded", "done")
      : progress;
  }
  if (event.kind === "workApplied") {
    return milestoneSatisfied(progress.fixCompleted)
      ? record(progress, "workApplied", "done")
      : progress;
  }
  if (event.kind === "freshReviewCompleted") {
    return milestoneSatisfied(progress.reviewCompleted)
      ? record(progress, "freshReviewCompleted", "done")
      : progress;
  }
  if (event.kind === "freshReviewCompared") {
    return milestoneSatisfied(progress.freshReviewCompleted) && event.comparedRounds > 1
      ? record(progress, "freshReviewCompared", "done")
      : progress;
  }
  return milestoneSatisfied(progress.freshReviewCompared)
    ? record(progress, "nextActionChosen", "done")
    : progress;
};

export const onboardingComplete = (progress: OnboardingProgress): boolean =>
  onboardingMilestones.every((milestone) => milestoneSatisfied(progress[milestone]));
