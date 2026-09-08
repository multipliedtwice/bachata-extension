const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  advanceOnboarding,
  emptyOnboardingProgress,
  onboardingComplete,
  onboardingContextKeys,
  onboardingMilestones,
  milestoneSatisfied,
  readOnboardingProgress,
} = require("../dist/onboarding/firstRun.js");

// These tests exercise milestone rules, not journey identity. Every event therefore names
// the same journey; journey behaviour has its own tests below.
const J = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };

test("invoking a command never completes a milestone on its own", () => {
  const progress = advanceOnboarding(emptyOnboardingProgress(), {
    journey: J,
    kind: "readiness",
    availableProviders: 0,
    blockingFindings: 3,
  });
  assert.deepEqual(
    { ...progress, journey: undefined, pendingReadinessRoot: undefined },
    { ...emptyOnboardingProgress(), journey: undefined, pendingReadinessRoot: undefined },
    "a command invocation completed a milestone",
  );
});

test("a provider milestone needs an actually available local provider", () => {
  const progress = advanceOnboarding(emptyOnboardingProgress(), {
    journey: J,
    kind: "readiness",
    availableProviders: 1,
    blockingFindings: 2,
  });
  assert.equal(progress.providerAvailable, 'done');
  assert.equal(progress.readinessVerified, 'pending');
});

test("readiness is verified only with a provider, a selected pipeline, and no blocker", () => {
  const withBlocker = advanceOnboarding(emptyOnboardingProgress(), {
    journey: J,
    kind: "readiness",
    availableProviders: 1,
    blockingFindings: 1,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  assert.equal(withBlocker.readinessVerified, 'pending');
  assert.equal(withBlocker.workflowSelected, 'done');

  const clean = advanceOnboarding(withBlocker, {
    journey: J,
    kind: "readiness",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  assert.equal(clean.readinessVerified, 'done');
});

test("only a read-only workflow satisfies the safe-pipeline milestone", () => {
  const managed = advanceOnboarding(emptyOnboardingProgress(), {
    journey: J,
    kind: "readiness",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "todo-master",
    selectedSafetyLevel: "orchestration",
  });
  assert.equal(managed.workflowSelected, 'pending');
  assert.equal(managed.readinessVerified, 'done');
});

test("an interrupted or non-review run does not complete the first review", () => {
  const interrupted = advanceOnboarding(emptyOnboardingProgress(), {
    journey: J,
    kind: "runCompleted",
    status: "interrupted",
    safetyLevel: "review",
    changedFilesRecorded: false,
  });
  assert.equal(interrupted.reviewCompleted, 'pending');

  const managed = advanceOnboarding(emptyOnboardingProgress(), {
    journey: J,
    kind: "runCompleted",
    status: "completed",
    safetyLevel: "managed",
    changedFilesRecorded: true,
  });
  assert.equal(managed.reviewCompleted, 'pending');
});

test("evidence counts only after a completed review, and milestones never regress", () => {
  const early = advanceOnboarding(emptyOnboardingProgress(), { journey: J, kind: "evidenceReviewed" });
  assert.equal(early.evidenceReviewed, 'pending');

  const reviewed = advanceOnboarding(early, {
    journey: J,
    kind: "runCompleted",
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
  });
  const evidence = advanceOnboarding(reviewed, { journey: J, kind: "evidenceReviewed" });
  assert.equal(evidence.evidenceReviewed, 'done');

  const later = advanceOnboarding(evidence, {
    journey: J,
    kind: "readiness",
    availableProviders: 0,
    blockingFindings: 5,
  });
  assert.equal(later.evidenceReviewed, 'done');
  assert.equal(later.reviewCompleted, 'done');
});

test("a full first run completes every milestone", () => {
  let progress = emptyOnboardingProgress();
  progress = advanceOnboarding(progress, {
    journey: J,
    kind: "readiness",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  progress = advanceOnboarding(progress, {
    journey: J,
    kind: "runCompleted",
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
  });
  progress = advanceOnboarding(progress, { journey: J, kind: "evidenceReviewed" });
  assert.equal(onboardingComplete(progress), false);
  progress = advanceOnboarding(progress, { journey: J, kind: "resolutionRecorded" });
  assert.equal(
    advanceOnboarding(progress, { journey: J, kind: "workApplied" }).workApplied,
    "pending",
    "work was applied before any fix run produced it",
  );
  assert.equal(
    advanceOnboarding(progress, {
      journey: J,
      kind: "runCompleted",
      status: "completed",
      safetyLevel: "managed",
      changedFilesRecorded: true,
    }).fixCompleted,
    "pending",
    "any write-capable run earned the fix milestone",
  );
  assert.equal(
    advanceOnboarding(progress, {
      journey: J,
      kind: "runCompleted",
      status: "completed",
      safetyLevel: "managed",
      changedFilesRecorded: false,
      scopedFix: true,
    }).fixCompleted,
    "pending",
    "a scoped fix that changed nothing earned the fix milestone",
  );
  progress = advanceOnboarding(progress, {
    journey: J,
    kind: "runCompleted",
    status: "completed",
    safetyLevel: "managed",
    changedFilesRecorded: true,
    scopedFix: true,
  });
  assert.equal(progress.fixCompleted, 'done');
  progress = advanceOnboarding(progress, { journey: J, kind: "workApplied" });
  progress = advanceOnboarding(progress, { journey: J, kind: "freshReviewCompleted" });
  progress = advanceOnboarding(progress, { journey: J, kind: "freshReviewCompared", comparedRounds: 2 });
  progress = advanceOnboarding(progress, { journey: J, kind: "nextActionChosen" });
  assert.equal(onboardingComplete(progress), true);
});

test("a review with nothing to resolve still completes the first-run path", () => {
  let progress = advanceOnboarding(emptyOnboardingProgress(), {
    journey: J,
    kind: "readiness",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  progress = advanceOnboarding(progress, {
    journey: J,
    kind: "runCompleted",
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 0,
  });
  assert.equal(progress.reviewCompleted, "done");
  assert.equal(
    progress.evidenceReviewed,
    "pending",
    "a clean review claimed the reader had opened the result",
  );
  assert.equal(progress.resolutionRecorded, "notApplicable");
  assert.equal(progress.fixCompleted, "notApplicable");
  assert.equal(progress.workApplied, "notApplicable");
  progress = advanceOnboarding(progress, { journey: J, kind: "evidenceReviewed" });
  assert.equal(progress.evidenceReviewed, "done");
  progress = advanceOnboarding(progress, { journey: J, kind: "freshReviewCompleted" });
  progress = advanceOnboarding(progress, { journey: J, kind: "freshReviewCompared", comparedRounds: 2 });
  progress = advanceOnboarding(progress, { journey: J, kind: "nextActionChosen" });
  assert.equal(
    onboardingComplete(progress),
    true,
    "a clean review left the first-run path unfinishable",
  );
});

test("a review that produced findings still needs a resolution and a fix", () => {
  let progress = advanceOnboarding(emptyOnboardingProgress(), {
    journey: J,
    kind: "readiness",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  progress = advanceOnboarding(progress, {
    journey: J,
    kind: "runCompleted",
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 2,
  });
  assert.equal(progress.reviewCompleted, 'done');
  assert.equal(progress.resolutionRecorded, 'pending');
  assert.equal(progress.fixCompleted, 'pending');
  assert.equal(progress.workApplied, 'pending');
});

test("a milestone needs the facts that make it possible, not the documented order", () => {
  const empty = emptyOnboardingProgress();
  assert.equal(advanceOnboarding(empty, { journey: J, kind: "resolutionRecorded" }).resolutionRecorded, "pending");
  assert.equal(advanceOnboarding(empty, { journey: J, kind: "workApplied" }).workApplied, "pending");
  assert.equal(
    advanceOnboarding(empty, { journey: J, kind: "freshReviewCompleted" }).freshReviewCompleted,
    "pending",
  );
  assert.equal(
    advanceOnboarding(empty, { journey: J, kind: "freshReviewCompared", comparedRounds: 5 }).freshReviewCompared,
    "pending",
  );
  assert.equal(advanceOnboarding(empty, { journey: J, kind: "nextActionChosen" }).nextActionChosen, "pending");

  const reviewed = advanceOnboarding(empty, {
    journey: J,
    kind: "runCompleted",
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 2,
  });
  assert.equal(
    advanceOnboarding(reviewed, { journey: J, kind: "resolutionRecorded" }).resolutionRecorded,
    "done",
    "resolving before opening the evidence view forced the work to be repeated",
  );
  assert.equal(
    advanceOnboarding(reviewed, { journey: J, kind: "freshReviewCompleted" }).freshReviewCompleted,
    "done",
    "a fresh review after a first review was discarded",
  );

  const applied = advanceOnboarding(reviewed, { journey: J, kind: "freshReviewCompleted" });
  assert.equal(applied.freshReviewCompared, "pending");
  assert.equal(
    advanceOnboarding(applied, { journey: J, kind: "freshReviewCompared", comparedRounds: 1 }).freshReviewCompared,
    "pending",
    "a single round has nothing to compare against",
  );
  assert.equal(
    advanceOnboarding(applied, { journey: J, kind: "freshReviewCompared", comparedRounds: 2 }).freshReviewCompared,
    "done",
  );
});

test("a clean review's not-applicable milestones still unblock the rest of the path", () => {
  const clean = advanceOnboarding(emptyOnboardingProgress(), {
    journey: J,
    kind: "runCompleted",
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 0,
  });
  assert.equal(milestoneSatisfied(clean.workApplied), true);
  assert.equal(milestoneSatisfied(clean.fixCompleted), true);
  assert.equal(
    advanceOnboarding(clean, { journey: J, kind: "workApplied" }).workApplied,
    "done",
    "work that was actually applied after a clean review stayed not-applicable",
  );
});

test("a recorded milestone is never downgraded to not applicable", () => {
  const done = advanceOnboarding(
    advanceOnboarding(emptyOnboardingProgress(), {
      journey: J,
      kind: "runCompleted",
      status: "completed",
      safetyLevel: "review",
      changedFilesRecorded: false,
      resolvableFindings: 2,
    }),
    { journey: J, kind: "resolutionRecorded" },
  );
  assert.equal(done.resolutionRecorded, "done");
  const laterClean = advanceOnboarding(done, {
    journey: J,
    kind: "runCompleted",
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 0,
  });
  assert.equal(laterClean.resolutionRecorded, "done");
});

test("stored progress is read defensively", () => {
  assert.deepEqual(readOnboardingProgress(undefined), emptyOnboardingProgress());
  assert.deepEqual(readOnboardingProgress("nonsense"), emptyOnboardingProgress());
  assert.equal(readOnboardingProgress({ providerAvailable: "yes" }).providerAvailable, "pending");
  assert.equal(
    readOnboardingProgress({ providerAvailable: true }).providerAvailable,
    "done",
    "a legacy boolean record no longer reads as a completed milestone",
  );
  assert.equal(readOnboardingProgress({ providerAvailable: "done" }).providerAvailable, "done");
  assert.equal(
    readOnboardingProgress({ workApplied: "notApplicable" }).workApplied,
    "notApplicable",
  );
});

test("the walkthrough completes on outcomes, never on command invocation", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  const steps = packageJson.contributes.walkthroughs[0].steps;
  const events = steps.flatMap((step) => step.completionEvents);
  assert.deepEqual(events.filter((event) => event.startsWith("onCommand:")), []);
  const expected = onboardingMilestones.map((milestone) => `onContext:${onboardingContextKeys[milestone]}`);
  assert.deepEqual(events, expected);
  steps.forEach((step) => {
    assert.equal(
      fs.existsSync(path.join(__dirname, "..", step.media.markdown)),
      true,
      `missing walkthrough media: ${step.media.markdown}`,
    );
  });
});

test("walkthrough copy never demands human acceptance before a fix can start", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  );
  const steps = packageJson.contributes.walkthroughs[0].steps;
  const manifestCopy = steps.map((step) => `${step.title}\n${step.description}`).join("\n");
  const markdownCopy = steps
    .map((step) => fs.readFileSync(path.join(__dirname, "..", step.media.markdown), "utf8"))
    .join("\n");
  [
    ["manifest", manifestCopy],
    ["walkthrough markdown", markdownCopy],
  ].forEach(([where, copy]) => {
    assert.doesNotMatch(
      copy,
      /a finding you accepted|Accepting a finding is what turns it into work|Accept a finding in the Direction view/u,
      `${where} still tells the user that a pipeline-accepted finding needs their acceptance first`,
    );
  });
  assert.match(
    markdownCopy,
    /needs no human acceptance|without you|needs no acceptance from you|needs no ruling from you/u,
    "no walkthrough copy states that a pipeline-accepted finding is actionable on its own",
  );
});

test("progress belongs to one journey and never accumulates across repositories", () => {
  const first = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  const second = { repositoryRoot: "/work/b", initiativeId: "initiative-2", runRef: "R2" };

  let progress = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "readiness",
    journey: first,
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  progress = advanceOnboarding(progress, {
    kind: "runCompleted",
    journey: first,
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 2,
  });
  assert.equal(progress.reviewCompleted, "done");
  assert.deepEqual(progress.journey, first);

  const foreign = advanceOnboarding(progress, { kind: "evidenceReviewed", journey: second });
  assert.deepEqual(
    foreign.journey,
    second,
    "an event from another repository did not start its own journey",
  );
  assert.equal(
    foreign.reviewCompleted,
    "pending",
    "another repository's run inherited a first review it was never part of",
  );
  assert.equal(foreign.evidenceReviewed, "pending");
  assert.equal(onboardingComplete(foreign), false);
});

test("a different initiative in the same repository is a different journey", () => {
  const started = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "runCompleted",
    journey: { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" },
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 1,
  });
  assert.equal(started.reviewCompleted, "done");
  const switched = advanceOnboarding(started, {
    kind: "resolutionRecorded",
    journey: { repositoryRoot: "/work/a", initiativeId: "initiative-2", runRef: "R1" },
  });
  assert.equal(switched.reviewCompleted, "pending");
  assert.deepEqual(switched.journey, { repositoryRoot: "/work/a", initiativeId: "initiative-2", runRef: "R1" });
});

test("an event that cannot say which journey it belongs to advances nothing", () => {
  const journey = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  const reviewed = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "runCompleted",
    journey,
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 1,
  });
  assert.equal(
    advanceOnboarding(reviewed, { kind: "evidenceReviewed" }).evidenceReviewed,
    "pending",
    "an unidentified event advanced a journey it could not name",
  );
  const identified = advanceOnboarding(reviewed, { kind: "evidenceReviewed", journey });
  assert.equal(identified.evidenceReviewed, "done");
  assert.deepEqual(identified.journey, journey);
});

test("progress is bound to one run, not merely one repository and initiative", () => {
  const first = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  const second = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R2" };
  const reviewed = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "runCompleted",
    journey: first,
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 1,
  });
  assert.equal(reviewed.reviewCompleted, "done");
  const otherRun = advanceOnboarding(reviewed, { kind: "resolutionRecorded", journey: second });
  assert.equal(
    otherRun.reviewCompleted,
    "pending",
    "a different run in the same initiative inherited a first review it never made",
  );
  assert.deepEqual(otherRun.journey, second);
});

test("a stored journey keeps its run identity across a restart", () => {
  const journey = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  assert.deepEqual(readOnboardingProgress({ reviewCompleted: "done", journey }).journey, journey);
  assert.equal(
    readOnboardingProgress({ journey: { runRef: "R1" } }).journey,
    undefined,
    "a stored journey missing repository and initiative was half-trusted",
  );
});

test("a stored journey survives a restart", () => {
  const journey = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  const restored = readOnboardingProgress({ reviewCompleted: "done", journey });
  assert.deepEqual(restored.journey, journey);
  assert.equal(restored.reviewCompleted, "done");
  assert.equal(readOnboardingProgress({ journey: { nonsense: 1 } }).journey, undefined);
  assert.equal(
    readOnboardingProgress({ journey: { repositoryRoot: "/work/a" } }).journey,
    undefined,
    "a partial stored journey was accepted",
  );
});

test("a journey change with unchanged milestones is still persisted", async () => {
  const Module = require("node:module");
  const setContexts = [];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return {
        commands: {
          executeCommand: async (command, key, value) => {
            setContexts.push([command, key, value]);
          },
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("../dist/onboarding/tracker.js")];
  const { createOnboardingTracker } = require("../dist/onboarding/tracker.js");
  const stored = new Map();
  const contexts = [];
  const context = {
    globalState: {
      get: (key) => stored.get(key),
      update: async (key, value) => {
        stored.set(key, value);
        contexts.push(structuredClone(value));
      },
    },
  };
  const tracker = createOnboardingTracker(context);

  const first = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  const second = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R2" };

  await tracker.record({
    kind: "readiness",
    journey: first,
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  const afterFirst = stored.get("bachata.onboarding.v1");
  assert.deepEqual(afterFirst.journey, first);
  assert.equal(afterFirst.providerAvailable, "done");

  // A second run resets progress. Every milestone value differs, so this alone would persist;
  // the case that matters is a journey switch that leaves the values identical.
  await tracker.record({
    kind: "readiness",
    journey: second,
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  const afterSecond = stored.get("bachata.onboarding.v1");
  assert.deepEqual(
    afterSecond.journey,
    second,
    "a journey change that left milestone values identical was not persisted",
  );
  assert.equal(afterSecond.providerAvailable, "done");
  assert.equal(tracker.progress().journey.runRef, "R2");
  Module._load = originalLoad;
  delete require.cache[require.resolve("../dist/onboarding/tracker.js")];
});

test("Setup or Doctor after a run began never erases the journey", () => {
  const journey = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  let progress = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "readiness",
    journey,
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  progress = advanceOnboarding(progress, {
    kind: "runCompleted",
    journey,
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 2,
  });
  progress = advanceOnboarding(progress, { kind: "evidenceReviewed", journey });
  assert.equal(progress.reviewCompleted, "done");
  assert.equal(progress.evidenceReviewed, "done");

  // Setup and Doctor emit readiness with no journey, before any run identity exists.
  const afterDoctor = advanceOnboarding(progress, {
    kind: "readiness",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  assert.deepEqual(afterDoctor.journey, journey, "a journeyless readiness event erased the journey");
  assert.equal(
    afterDoctor.reviewCompleted,
    "done",
    "running Doctor after a review erased the completed first review",
  );
  assert.equal(afterDoctor.evidenceReviewed, "done");
  assert.equal(afterDoctor.providerAvailable, "done");
});

test("a journeyless event that is not readiness advances nothing", () => {
  const journey = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  const reviewed = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "runCompleted",
    journey,
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 2,
  });
  const stray = advanceOnboarding(reviewed, { kind: "evidenceReviewed" });
  assert.equal(stray.evidenceReviewed, "pending", "an unidentified event advanced a milestone");
  assert.deepEqual(stray.journey, journey, "an unidentified event disturbed the journey");
});

test("readiness before any run still starts progress, and a run then adopts it", () => {
  const readiness = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "readiness",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  assert.equal(readiness.providerAvailable, "done");
  assert.equal(readiness.workflowSelected, "done");
  assert.equal(readiness.journey, undefined);

  const journey = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  const ran = advanceOnboarding(readiness, {
    kind: "runCompleted",
    journey,
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 1,
  });
  assert.deepEqual(ran.journey, journey);
  assert.equal(ran.reviewCompleted, "done");
  assert.equal(ran.providerAvailable, "done", "adopting a journey discarded readiness already proven");
});

test("readiness proven in one repository never follows a run into another", () => {
  const readiness = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "readiness",
    repositoryRoot: "/work/a",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  assert.equal(readiness.workflowSelected, "done");
  assert.equal(readiness.pendingReadinessRoot, "/work/a");

  const elsewhere = advanceOnboarding(readiness, {
    kind: "runCompleted",
    journey: { repositoryRoot: "/work/b", initiativeId: "initiative-1", runRef: "R1" },
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 1,
  });
  assert.equal(
    elsewhere.workflowSelected,
    "pending",
    "readiness proven in /work/a was inherited by a run in /work/b",
  );
  assert.equal(elsewhere.readinessVerified, "pending");
  assert.equal(elsewhere.reviewCompleted, "done");
  assert.equal(elsewhere.pendingReadinessRoot, undefined);

  const sameRoot = advanceOnboarding(readiness, {
    kind: "runCompleted",
    journey: { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" },
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 1,
  });
  assert.equal(
    sameRoot.workflowSelected,
    "done",
    "readiness proven for this very repository was discarded",
  );
});

test("Doctor in another repository leaves an active journey untouched", () => {
  const journey = { repositoryRoot: "/work/a", initiativeId: "initiative-1", runRef: "R1" };
  const reviewed = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "runCompleted",
    journey,
    status: "completed",
    safetyLevel: "review",
    changedFilesRecorded: false,
    resolvableFindings: 1,
  });
  const foreign = advanceOnboarding(reviewed, {
    kind: "readiness",
    repositoryRoot: "/work/b",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  assert.deepEqual(foreign, reviewed, "Doctor in another repository changed this journey");
});

test("readiness for a second repository replaces pending readiness for the first", () => {
  const first = advanceOnboarding(emptyOnboardingProgress(), {
    kind: "readiness",
    repositoryRoot: "/work/a",
    availableProviders: 1,
    blockingFindings: 0,
    selectedPipelineId: "codex-review",
    selectedSafetyLevel: "review",
  });
  const second = advanceOnboarding(first, {
    kind: "readiness",
    repositoryRoot: "/work/b",
    availableProviders: 0,
    blockingFindings: 3,
  });
  assert.equal(second.pendingReadinessRoot, "/work/b");
  assert.equal(
    second.workflowSelected,
    "pending",
    "a second repository inherited the first repository's chosen workflow",
  );
});
