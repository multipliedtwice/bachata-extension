const assert = require("node:assert/strict");
const test = require("node:test");

const {
  UNKNOWN_EVIDENCE_EXPECTATIONS,
  pipelineEvidenceExpectations,
} = require("../dist/results/evidenceExpectations.js");
const { projectRunResult } = require("../dist/results/projectResult.js");
const {
  boundRecheck,
  contractChecksFrom,
  decisionRisks,
  executionEventCutoff,
  latestCurrentEvent,
  runWasExecuted,
  validatedOutputRefs,
  verificationProvenance,
} = require("../dist/conversations/runResultProjection.js");

// EX-3. What a conversation's result card is built from. Every one of these was inside one
// 220-line closure in `createConversationManager`, so a stale decision from a previous execution,
// a malformed check, or a recheck bound to the wrong candidate could only be reached by driving a
// whole run through a real catalog.

const event = (id, type, payload) => ({ id, type, payload, createdAt: "2026-01-01T00:00:00.000Z" });

test("a run with no execution yet has no cut-off, and E0 reads as zero", () => {
  assert.equal(executionEventCutoff(undefined), 0);
  assert.equal(executionEventCutoff("E0"), 0);
  assert.equal(executionEventCutoff("E17"), 17);
});

test("only the current execution's events are read, and the last one wins", () => {
  // WHY THE CUT-OFF. A decision from an earlier attempt describes a candidate that no longer
  // exists; showing it presents a stale ruling as this run's.
  const events = [
    event(1, "decision.published", { candidate: "old" }),
    event(5, "decision.published", { candidate: "first" }),
    event(6, "decision.published", { candidate: "latest" }),
    event(7, "other"),
  ];
  assert.equal(latestCurrentEvent(events, "decision.published", 4).payload.candidate, "latest");
  assert.equal(latestCurrentEvent(events, "decision.published", 6), undefined);
  assert.equal(latestCurrentEvent(events, "verification.completed", 0), undefined);
});

test("validated output refs come only from this execution and only when well formed", () => {
  const refs = validatedOutputRefs(
    [
      event(1, "output.validated", { outputRef: "stale" }),
      event(5, "output.validated", { outputRef: "kept" }),
      event(6, "output.validated", { outputRef: 7 }),
      event(7, "output.validated", "not a record"),
      event(8, "output.validated", { outputRef: "also-kept" }),
    ],
    4,
  );
  assert.deepEqual([...refs].sort(), ["also-kept", "kept"]);
});

test("unresolved risks are read only as strings, from a record", () => {
  assert.deepEqual(decisionRisks({ unresolvedRisks: ["a", 2, null, "b"] }), ["a", "b"]);
  assert.deepEqual(decisionRisks({ unresolvedRisks: "a" }), []);
  assert.deepEqual(decisionRisks(undefined), []);
  assert.deepEqual(decisionRisks(["a"]), []);
});

test("no check array at all is different from an empty one, so the caller can fall back", () => {
  // WHY. `undefined` lets the projection use the orchestration task's checks instead; `[]` is a
  // verification that ran and found nothing to report.
  assert.equal(contractChecksFrom(undefined), undefined);
  assert.equal(contractChecksFrom(event(1, "verification.completed")), undefined);
  assert.equal(contractChecksFrom(event(1, "verification.completed", { checks: "no" })), undefined);
  assert.deepEqual(contractChecksFrom(event(1, "verification.completed", { checks: [] })), []);
});

test("a check with no command or an unknown status is dropped, not shown unreadable", () => {
  assert.deepEqual(
    contractChecksFrom(
      event(1, "verification.completed", {
        checks: [
          { command: "npm test", status: "passed" },
          { command: 3, status: "passed" },
          { command: "npm run lint", status: "exploded" },
          "not a record",
          { command: "npm run build", status: "timedOut" },
          { command: "npm run x", status: "cancelled" },
          { command: "npm run y", status: "failed" },
        ],
      }),
    ),
    [
      { command: "npm test", status: "passed" },
      { command: "npm run build", status: "timedOut" },
      { command: "npm run x", status: "cancelled" },
      { command: "npm run y", status: "failed" },
    ],
  );
});

test("a recheck recorded against another candidate is not evidence about this one", () => {
  const recorded = { runId: "run-1", recordedAt: "2026-01-02T00:00:00.000Z", checks: [] };
  assert.equal(boundRecheck(recorded, "run-1"), recorded);
  assert.equal(boundRecheck(recorded, "run-2"), undefined);
  assert.equal(boundRecheck(recorded, undefined), undefined);
  assert.equal(boundRecheck(undefined, "run-1"), undefined);
});

test("a recheck always names itself; the run's own checks need both checks and a time", () => {
  const recheck = { runId: "r", recordedAt: "2026-01-02T00:00:00.000Z", checks: [] };
  assert.deepEqual(
    verificationProvenance({ recheck, checks: undefined, recordedAt: undefined }),
    { source: "recheck", recordedAt: "2026-01-02T00:00:00.000Z" },
  );
  assert.deepEqual(
    verificationProvenance({
      recheck: undefined,
      checks: [{ command: "npm test", status: "passed" }],
      recordedAt: "2026-01-01T00:00:00.000Z",
    }),
    { source: "run", recordedAt: "2026-01-01T00:00:00.000Z" },
  );
  // A time with no checks describes nothing; checks with no time cannot be placed.
  assert.equal(
    verificationProvenance({ recheck: undefined, checks: [], recordedAt: "2026-01-01T00:00:00.000Z" }),
    undefined,
  );
  assert.equal(
    verificationProvenance({
      recheck: undefined,
      checks: [{ command: "npm test", status: "passed" }],
      recordedAt: undefined,
    }),
    undefined,
  );
  assert.equal(
    verificationProvenance({ recheck: undefined, checks: undefined, recordedAt: undefined }),
    undefined,
  );
});

test("a conversation that never ran is not projected as a run that produced nothing", () => {
  // WHY. A pristine "New conversation" was rendered as an apply candidate: no changed files, no
  // verification, "Do not apply", and an apply-blocked notification, all about a run that did not
  // exist.
  const proving = new Set(["run.started", "step.started"]);
  const pristine = {
    events: [],
    provingEventTypes: proving,
    workflowStatus: "idle",
    hasPersistedResult: false,
    projectionHasEvidence: false,
  };
  assert.equal(runWasExecuted(pristine), false);
  assert.equal(runWasExecuted({ ...pristine, events: [event(1, "chat.appended")] }), false);
});

test("any one of four things proves a run happened", () => {
  const proving = new Set(["run.started", "step.started"]);
  const base = {
    events: [],
    provingEventTypes: proving,
    workflowStatus: "idle",
    hasPersistedResult: false,
    projectionHasEvidence: false,
  };
  assert.equal(runWasExecuted({ ...base, events: [event(1, "step.started")] }), true);
  assert.equal(runWasExecuted({ ...base, workflowStatus: "running" }), true);
  assert.equal(runWasExecuted({ ...base, hasPersistedResult: true }), true);
  assert.equal(runWasExecuted({ ...base, projectionHasEvidence: true }), true);
});


// EX-A5-R04. The expectations a run is judged against belong to the pipeline it executed. A
// pipeline nothing can name excuses nothing: the unknown stays every-expectation-true, so a run
// that recorded none of them reads as inconclusive rather than as a clean independent review.
const reviewOnlyPipeline = {
  version: 1,
  id: "review-only",
  name: "review-only",
  agents: [
    { id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "readOnly" },
    { id: "claude", name: "Claude Code", adapter: "claude-code", permissionMode: "plan" },
  ],
  steps: [{
    id: "review",
    type: "agent",
    name: "Review",
    enabled: true,
    participants: ["codex", "claude"],
    promptTemplate: "{{userPrompt}}",
    parallel: true,
    consensus: false,
    humanGate: "none",
  }],
};

const completedReview = (expectations) => projectRunResult({
  status: "completed",
  transcript: [],
  providers: [{ name: "Codex", adapter: "codex-app-server" }],
  expectations,
});

test("a read-only review owes no changed files, no controller verification and no ruling", () => {
  const expectations = pipelineEvidenceExpectations(reviewOnlyPipeline);
  assert.deepEqual(expectations, { changedFiles: false, verification: false, finalRuling: false });
  const result = completedReview(expectations);
  assert.deepEqual(result.evidenceGaps, []);
  assert.equal(result.finalAssessment.outcome, "completed");
});

test("a review workflow that declares controller verification still owes a check result", () => {
  const expectations = pipelineEvidenceExpectations({
    ...reviewOnlyPipeline,
    roles: [{ id: "reviewer", verificationChecks: ["npm test"] }],
  });
  assert.equal(expectations.verification, true);
  const result = completedReview(expectations);
  assert.equal(
    result.evidenceGaps.includes("Expected but missing: no verification check was recorded"),
    true,
    `declared verification recorded no gap: ${JSON.stringify(result.evidenceGaps)}`,
  );
  assert.equal(result.finalAssessment.outcome, "inconclusive");
});

test("a pipeline definition nothing can name stays fail-closed", () => {
  assert.deepEqual(pipelineEvidenceExpectations(undefined), UNKNOWN_EVIDENCE_EXPECTATIONS);
  assert.deepEqual(
    UNKNOWN_EVIDENCE_EXPECTATIONS,
    { changedFiles: true, verification: true, finalRuling: true },
    "the unknown stopped owing everything, so an unnamed pipeline now excuses evidence",
  );
  const result = completedReview(UNKNOWN_EVIDENCE_EXPECTATIONS);
  assert.equal(result.evidenceGaps.length > 0, true);
  assert.equal(result.finalAssessment.outcome, "inconclusive");
});
