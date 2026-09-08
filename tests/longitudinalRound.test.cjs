const assert = require("node:assert/strict");
const test = require("node:test");

const {
  freshReviewJourneyEvents,
  roundCandidateFrom,
  roundEligibility,
  roundRecordingDecision,
} = require("../dist/conversations/longitudinalRound.js");

const eligibility = (overrides = {}) =>
  roundEligibility({
    declaredFreshReview: true,
    workflowStatus: "completed",
    evidenceGaps: [],
    finalAssessment: { outcome: "completed", summary: "all good" },
    ...overrides,
  });

test("a completed review that recorded its evidence counts as an independent review", () => {
  assert.deepEqual(eligibility(), { freshReview: true, notices: [] });
});

test("a run whose workflow never declared a fresh review is neither counted nor demoted", () => {
  assert.deepEqual(eligibility({ declaredFreshReview: false, workflowStatus: "error" }), {
    freshReview: false,
    notices: [],
  });
});

test("a review that ended other than completed is demoted, and says how it ended", () => {
  const result = eligibility({ workflowStatus: "interrupted" });
  assert.equal(result.freshReview, false);
  assert.equal(result.notCountedBecause, "ended as interrupted instead of completing");
  assert.deepEqual(result.notices, [
    "This fresh review ended as interrupted instead of completing, so it is recorded as evidence and not as an independent review: its silence about a finding is not an observation.",
  ]);
});

test("a review with evidence gaps is demoted, and names every gap", () => {
  const result = eligibility({ evidenceGaps: ["no changed files", "no ruling provider"] });
  assert.equal(result.freshReview, false);
  assert.equal(
    result.notCountedBecause,
    "did not record the evidence its workflow declares: no changed files; no ruling provider",
  );
});

test("a review with no usable assessment is demoted, and carries the assessment's own words", () => {
  const result = eligibility({
    finalAssessment: { outcome: "inconclusive", summary: "the provider stopped" },
  });
  assert.equal(result.freshReview, false);
  assert.equal(
    result.notCountedBecause,
    "reached no usable assessment: inconclusive — the provider stopped",
  );
});

test("the earliest reason is the one reported when a review failed several ways", () => {
  assert.equal(
    eligibility({
      workflowStatus: "error",
      evidenceGaps: ["no changed files"],
      finalAssessment: { outcome: "inconclusive", summary: "stopped" },
    }).notCountedBecause,
    "ended as error instead of completing",
  );
});

const candidate = (overrides = {}) =>
  roundCandidateFrom({
    runRef: "run-1",
    executionRef: "exec-7",
    eligibility: { freshReview: true, notices: [] },
    findings: [{ identity: "f1" }],
    decisions: { errors: [] },
    plan: { errors: [] },
    declaredArtifacts: [],
    ...overrides,
  });

test("the stored round carries the execution it came from and nothing it was not given", () => {
  assert.deepEqual(candidate(), {
    runRef: "run-1",
    executionRef: "exec-7",
    freshReview: true,
    findings: [{ identity: "f1" }],
  });
});

test("a declared source travels, and an absent one leaves no key", () => {
  const withSources = candidate({
    decisions: { source: { kind: "artifact" }, errors: [] },
    plan: { source: { kind: "declared" }, errors: [] },
    declaredArtifacts: [{ ref: "a1" }],
  });
  assert.deepEqual(withSources.decisionSource, { kind: "artifact" });
  assert.deepEqual(withSources.planSource, { kind: "declared" });
  assert.deepEqual(withSources.declaredArtifacts, [{ ref: "a1" }]);
  assert.equal("decisionSource" in candidate(), false);
  assert.equal("planSource" in candidate(), false);
  assert.equal("declaredArtifacts" in candidate(), false);
  assert.equal("validationErrors" in candidate(), false);
});

test("decision errors, plan errors and the demotion notice are one list in that order", () => {
  assert.deepEqual(
    candidate({
      decisions: { errors: ["decision unreadable"] },
      plan: { errors: ["plan unreadable"] },
      eligibility: { freshReview: false, notCountedBecause: "x", notices: ["demoted"] },
    }).validationErrors,
    ["decision unreadable", "plan unreadable", "demoted"],
  );
});

test("a demoted round is still stored, as a round that is not an independent review", () => {
  const demoted = candidate({
    eligibility: { freshReview: false, notCountedBecause: "x", notices: ["demoted"] },
  });
  assert.equal(demoted.freshReview, false);
  assert.equal(demoted.executionRef, "exec-7");
  assert.deepEqual(demoted.findings, [{ identity: "f1" }]);
});

test("a run with no execution behind it records nothing and reports nothing", () => {
  assert.deepEqual(
    roundRecordingDecision({
      executionRef: undefined,
      declaredIntent: "initiativeRequired",
      hasInitiative: true,
      runRef: "run-1",
    }),
    { record: false },
  );
});

test("a run-local workflow records nothing and must not report a failure to do so", () => {
  assert.deepEqual(
    roundRecordingDecision({
      executionRef: "exec-1",
      declaredIntent: "runLocal",
      hasInitiative: false,
      runRef: "run-1",
    }),
    { record: false },
  );
});

test("an initiative that went away mid-run is reported rather than skipped", () => {
  assert.deepEqual(
    roundRecordingDecision({
      executionRef: "exec-1",
      declaredIntent: "initiativeRequired",
      hasInitiative: false,
      runRef: "run-9",
    }),
    {
      record: false,
      failure:
        "The result of run-9 was not recorded: its workflow records against an initiative, and this repository no longer has one.",
    },
  );
});

test("an initiative-bound run with an execution records", () => {
  assert.deepEqual(
    roundRecordingDecision({
      executionRef: "exec-1",
      declaredIntent: "initiativeRequired",
      hasInitiative: true,
      runRef: "run-1",
    }),
    { record: true },
  );
});

test("a demoted round tells the onboarding journey nothing", () => {
  assert.deepEqual(freshReviewJourneyEvents({ freshReview: false, priorRounds: 3 }), []);
});

test("the first fresh review reports itself and nothing to compare with", () => {
  assert.deepEqual(freshReviewJourneyEvents({ freshReview: true, priorRounds: 0 }), [
    { kind: "freshReviewCompleted" },
  ]);
});

test("a later fresh review reports how many rounds are now comparable", () => {
  assert.deepEqual(freshReviewJourneyEvents({ freshReview: true, priorRounds: 2 }), [
    { kind: "freshReviewCompleted" },
    { kind: "freshReviewCompared", comparedRounds: 3 },
  ]);
});
