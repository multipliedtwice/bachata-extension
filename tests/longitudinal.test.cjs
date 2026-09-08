const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { DatabaseSync } = require("node:sqlite");
const { createStateCatalog } = require("../dist/state/catalog.js");
const {
  createLongitudinalService,
  quietFreshReviewCount,
  repositoryIdentity,
} = require("../dist/longitudinal/service.js");
const {
  findingIdentity,
  findingIsActionable,
  foldFindingsIntoHistory,
  findingNeedsFix,
  resolveDecision,
  resolveFinding,
  resolveFindingWithControllerEvidence,
  supersedeDecision,
} = require("../dist/longitudinal/lifecycle.js");
const {
  compareRound,
  saturationReport,
  SATURATION_DISCLAIMER,
} = require("../dist/longitudinal/comparison.js");
const { directionView } = require("../dist/longitudinal/direction.js");
const { parseCycle, parseInitiative } = require("../dist/longitudinal/parse.js");

const REPOSITORY_ROOT = "/work/repo";

const finding = (overrides = {}) => ({
  id: overrides.id ?? "f1",
  subject: "Cancellation guard",
  message: "Cancellation bypasses cleanup",
  disposition: "accepted",
  evidence: ["Both participants traced the bypass"],
  challenges: ["The finally block was inspected"],
  location: { file: "src/a.ts", startLine: 12, endLine: 12 },
  provenance: {
    source: "pipelineDecision",
    stepId: "review-consensus",
    participantIds: ["codex", "claude"],
    decisionStatus: "accepted",
  },
  ...overrides,
});

const idFactory = () => {
  const counters = { N: 0, Y: 0, T: 0, D: 0 };
  return (prefix) => {
    counters[prefix] += 1;
    return `${prefix}${String(counters[prefix]).padStart(8, "0")}`;
  };
};

const clock = (start = Date.UTC(2026, 0, 1)) => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(start + tick * 1000);
  };
};

const withCatalog = async (body) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-longitudinal-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const serviceFor = (catalog) =>
  createLongitudinalService({
    store: catalog.longitudinal,
    repositoryRoot: REPOSITORY_ROOT,
    now: clock(),
    createId: idFactory(),
  });

const parseInitiativeRecordFor = (directionRevisions) => {
  const { parseInitiative } = require("../dist/longitudinal/parse.js");
  const parsed = parseInitiative({
    id: "I1",
    repositoryId: "R1",
    title: "t",
    goal: "g",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    directionRevisions,
  });
  return parsed?.directionRevisions ?? [];
};


test("repository identity is stable across separators and trailing slashes", () => {
  assert.equal(repositoryIdentity("/work/repo"), repositoryIdentity("/work/repo/"));
  assert.equal(repositoryIdentity("/work/repo"), repositoryIdentity("\\work\\repo"));
  assert.notEqual(repositoryIdentity("/work/repo"), repositoryIdentity("/work/other"));
});

test("the longitudinal migration opens an existing catalog without data loss", async () => {
  await withCatalog(async (root) => {
    const first = createStateCatalog(root);
    const run = first.createRun({ title: "Legacy run", input: "review src" });
    first.close();

    const second = createStateCatalog(root);
    assert.equal(second.getRun(run.runRef)?.title, "Legacy run");
    const service = serviceFor(second);
    const initiative = service.defineInitiative({
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
      desiredOutcome: "Every cancel path is proven",
      acceptanceCriteria: ["No leaked worktree after cancel"],
    });
    assert.equal(initiative.id, "N00000001");
    second.close();

    const third = createStateCatalog(root);
    assert.equal(third.getRun(run.runRef)?.title, "Legacy run");
    const restored = third.longitudinal.findInitiativeByRepository(
      repositoryIdentity(REPOSITORY_ROOT),
    );
    assert.equal(restored.goal, "Cancellation never leaks a worktree");
    assert.deepEqual(restored.acceptanceCriteria, ["No leaked worktree after cancel"]);
    third.close();
  });
});

test("initiative, cycle, and artifact state survives restart", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({
      type: "review",
      repositoryBaseline: {
        commit: "abc1234",
        branch: "main",
        dirty: false,
        worktreeDigest: "WTEMPTY",
        contentComplete: true,
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    assert.equal(cycle.sequence, 1);
    service.bindRun({ runRef: "R23456789", cycleId: cycle.id, freshReview: true });
    service.saveArtifacts([
      {
        schemaVersion: 1,
        id: "T00000001",
        initiativeId: "N00000001",
        cycleId: cycle.id,
        type: "plan",
        title: "Fix plan",
        body: "Guard the cancel path",
        revision: 1,
        state: "proposed",
        provenance: { authoredBy: "model", participantIds: ["codex", "claude"] },
        evidence: ["Consensus decision"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    const state = restored.snapshot();
    assert.equal(state.initiative.currentCycleId, cycle.id);
    assert.equal(state.cycles.length, 1);
    assert.deepEqual(state.cycles[0].runRefs, ["R23456789"]);
    assert.deepEqual(state.cycles[0].repositoryBaseline, {
      commit: "abc1234",
      branch: "main",
      dirty: false,
      worktreeDigest: "WTEMPTY",
      contentComplete: true,
      capturedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.equal(state.artifacts.length, 1);
    assert.equal(state.artifacts[0].title, "Fix plan");
    assert.equal(reopened.longitudinal.cycleForRun("R23456789").id, cycle.id);
    reopened.close();
  });
});

test("a second cycle closes the first and inherits its output artifacts", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const first = service.startCycle({ type: "framing" });
    catalog.longitudinal.saveCycle({ ...first, outputArtifactIds: ["T00000001"] });
    const second = service.startCycle({ type: "execution" });
    assert.equal(second.sequence, 2);
    assert.deepEqual(second.inputArtifactIds, ["T00000001"]);
    const cycles = catalog.longitudinal.listCycles("N00000001");
    assert.equal(cycles[0].completion, "completed");
    assert.equal(cycles[1].completion, "open");
    catalog.close();
  });
});

test("findings deduplicate across runs and regress only after a real resolution", () => {
  const first = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    history: [],
    findings: [finding()],
    freshReview: true,
  });
  assert.equal(first.history.length, 1);
  assert.deepEqual(first.newIdentities, [findingIdentity(finding())]);
  assert.equal(first.history[0].occurrences, 1);
  assert.equal(first.history[0].actionable, true);

  const repeated = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y2",
    recordedAt: "2026-01-02T00:00:00.000Z",
    history: first.history,
    findings: [finding({ id: "different-run-id" })],
    freshReview: true,
  });
  assert.equal(repeated.history.length, 1);
  assert.deepEqual(repeated.newIdentities, []);
  assert.equal(repeated.history[0].occurrences, 2);
  assert.equal(repeated.history[0].state, "accepted");

  const notObserved = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y3",
    recordedAt: "2026-01-03T00:00:00.000Z",
    history: repeated.history,
    findings: [],
    freshReview: true,
  });
  assert.equal(notObserved.history[0].state, "accepted", "silence is not resolution");
  assert.deepEqual(notObserved.resolvedIdentities, []);

  const resolved = resolveFindingWithControllerEvidence(notObserved.history[0], {
    evidence: ["bachata:project-checks now covers the cancel path and passes"],
    cycleId: "Y3",
    recordedAt: "2026-01-03T00:00:00.000Z",
  });
  assert.equal(resolved.state, "resolved");
  assert.equal(resolved.actionable, false);
  assert.equal(
    resolveFindingWithControllerEvidence(notObserved.history[0], {
      evidence: ["   "],
      cycleId: "Y3",
      recordedAt: "2026-01-03T00:00:00.000Z",
    }),
    undefined,
    "resolution without controller evidence must be refused",
  );

  const regressed = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y4",
    recordedAt: "2026-01-04T00:00:00.000Z",
    history: [resolved],
    findings: [finding()],
    freshReview: true,
  });
  assert.equal(regressed.history[0].state, "regressed");
  assert.deepEqual(regressed.regressedIdentities, [findingIdentity(finding())]);

  // EX-G6-04. The finding is back, so whatever was verified about the fix is no longer true of
  // the code in front of us. Carrying `fixState: "verified"` through the regression left the
  // finding looking fixed and verified while it was being reported again — and the fix action is
  // gated on exactly that value, so the one finding that needed fixing was the one that offered
  // no way to fix it.
  const verified = { ...resolved, fixState: "verified" };
  const regressedAfterVerification = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y5",
    recordedAt: "2026-01-05T00:00:00.000Z",
    history: [verified],
    findings: [finding()],
    freshReview: true,
  });
  assert.equal(regressedAfterVerification.history[0].state, "regressed");
  assert.equal(
    regressedAfterVerification.history[0].fixState,
    "awaitingFix",
    "a finding that came back was still carrying the verification of a fix that did not hold",
  );
});

// EX-A5-R05. Reopening says the finding is live again. The public human resolution path copied
// the old `fixState` through, so a reopened finding kept `verified`, and Reopen followed by
// Accept produced an accepted finding whose current fix was still verified — excluded from the
// outstanding accepted findings and with no Fix control, which is the one thing it needed. What
// the reopen withdraws is the verification, not the record that the fix was applied.
test("reopening a finding invalidates its current verification and Accept does not restore it", () => {
  const first = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    history: [],
    findings: [finding()],
    freshReview: true,
  });
  const verified = { ...first.history[0], state: "resolved", fixState: "verified" };
  assert.equal(findingNeedsFix(verified), false);

  const reopened = resolveFinding(verified, {
    action: "reopen",
    resolvedBy: "owner",
    reason: "The bypass is back on a different path",
    resolvedAt: "2026-01-02T00:00:00.000Z",
    materialEvidenceDelta: ["A second reproduction on the retry path"],
  });
  assert.equal(reopened.state, "reopened");
  assert.equal(
    reopened.fixState,
    "fixApplied",
    "a reopened finding kept the verification of a fix that no longer holds",
  );
  assert.deepEqual(
    reopened.materialDelta.includes("A second reproduction on the retry path"),
    true,
    "the historical evidence delta was dropped",
  );

  const accepted = resolveFinding(reopened, {
    action: "accept",
    resolvedBy: "owner",
    resolvedAt: "2026-01-03T00:00:00.000Z",
  });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.fixState, "fixApplied");
  assert.equal(
    findingNeedsFix(accepted),
    true,
    "an accepted finding reopened over a stale verification offered no way to fix it",
  );
  // The reopen's own evidence is still on the entry, so what was invalidated is the verification
  // and not the record of why.
  assert.equal(accepted.humanResolution.action, "accept");
  assert.equal(
    accepted.materialDelta.includes("A second reproduction on the retry path"),
    true,
  );
});

test("a non-fresh round never even marks an absent finding as not observed", () => {
  const first = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    history: [],
    findings: [finding()],
    freshReview: true,
  });
  const partial = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y2",
    recordedAt: "2026-01-02T00:00:00.000Z",
    history: first.history,
    findings: [],
    freshReview: false,
  });
  assert.deepEqual(partial.resolvedIdentities, []);
  assert.deepEqual(partial.notObservedIdentities, []);
  assert.equal(partial.history[0].state, "accepted");
});

test("only a challenged multi-participant accepted finding is automatically actionable", () => {
  const unchallenged = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    history: [],
    findings: [finding({ challenges: [] })],
    freshReview: true,
  });
  assert.equal(unchallenged.history[0].actionable, false);
  assert.equal(
    findingIsActionable({ state: "accepted", challengeHistory: [] }),
    false,
  );
  assert.equal(
    findingIsActionable({
      state: "accepted",
      challengeHistory: [{ cycleId: "Y1", participantIds: ["codex"], text: "x", recordedAt: "t" }],
    }),
    false,
    "a single-source challenge was promoted to bachata-accepted work",
  );
  assert.equal(
    findingIsActionable({
      state: "accepted",
      challengeHistory: [{ cycleId: "Y1", participantIds: ["codex", "claude"], text: "x", recordedAt: "t" }],
    }),
    true,
  );
  assert.equal(
    findingIsActionable({
      state: "unresolved",
      challengeHistory: [{ cycleId: "Y1", participantIds: ["codex", "claude"], text: "x", recordedAt: "t" }],
    }),
    false,
  );
});

test("a human-rejected finding reopens only on a visible material delta", () => {
  const seeded = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    history: [],
    findings: [finding()],
    freshReview: true,
  }).history.map((entry) => ({ ...entry, state: "rejected" }));

  const unchanged = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y2",
    recordedAt: "2026-01-02T00:00:00.000Z",
    history: seeded,
    findings: [finding()],
    freshReview: true,
  });
  assert.equal(unchanged.history[0].state, "rejected");
  assert.deepEqual(unchanged.reopenedIdentities, []);

  const withNewEvidence = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y3",
    recordedAt: "2026-01-03T00:00:00.000Z",
    history: seeded,
    findings: [finding({ evidence: ["A reproducing test now exists"] })],
    freshReview: true,
  });
  assert.equal(withNewEvidence.history[0].state, "reopened");
  assert.deepEqual(withNewEvidence.history[0].materialDelta, [
    "A reproducing test now exists",
    "withdrawn evidence: Both participants traced the bypass",
  ]);
});

test("decisions supersede and reopen with recorded reasons", () => {
  const base = {
    schemaVersion: 1,
    id: "D00000001",
    initiativeId: "N1",
    cycleId: "Y1",
    subject: "Cancellation ownership",
    affectedScope: ["src/orchestrator"],
    question: "Who owns cancellation cleanup?",
    options: [{ id: "a", summary: "Controller", tradeOffs: [] }],
    tradeOffs: [],
    evidence: ["Both providers agreed"],
    state: "accepted",
    provenance: { authoredBy: "model", participantIds: ["codex", "claude"] },
    materialEvidenceDelta: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const replacement = { ...base, id: "D00000002", updatedAt: "2026-02-01T00:00:00.000Z" };
  const superseded = supersedeDecision(base, replacement);
  assert.equal(superseded.previous.state, "superseded");
  assert.equal(superseded.previous.supersededById, "D00000002");
  assert.equal(superseded.next.supersedesId, "D00000001");

  const reopened = resolveDecision(base, {
    action: "reopen",
    resolvedBy: "owner",
    resolvedAt: "2026-03-01T00:00:00.000Z",
    reason: "A new failure mode appeared",
    materialEvidenceDelta: ["Cancellation leaks under Windows"],
  });
  assert.equal(reopened.state, "proposed");
  assert.equal(reopened.reopenReason, "A new failure mode appeared");
  assert.deepEqual(reopened.materialEvidenceDelta, ["Cancellation leaks under Windows"]);

  const rejected = resolveDecision(base, {
    action: "reject",
    resolvedBy: "owner",
    resolvedAt: "2026-03-02T00:00:00.000Z",
  });
  assert.equal(rejected.state, "rejected");
  assert.equal(rejected.humanResolution.resolvedBy, "owner");
});

test("a human rejection overrides automatic actionability and keeps its history", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R23456789", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R23456789",
      executionRef: "E1",
      findings: [finding()],
      freshReview: true,
    });

    const identity = findingIdentity(finding());
    const initial = service.summary().direction;
    assert.deepEqual(initial.findingsNeedingRuling, []);
    assert.deepEqual(
      initial.outstandingAcceptedFindings.map((entry) => entry.identity),
      [identity],
    );
    assert.equal(initial.nextAction.kind, "fixAcceptedFindings");

    assert.equal(
      service.resolve({ target: "finding", id: identity, action: "reopen", resolvedBy: "owner" }),
      false,
    );
    assert.equal(
      service.resolve({
        target: "finding",
        id: identity,
        action: "reopen",
        resolvedBy: "owner",
        reason: "New evidence",
      }),
      false,
      "a reopen without a material evidence delta must be refused",
    );
    assert.equal(
      service.resolve({
        target: "finding",
        id: identity,
        action: "reject",
        resolvedBy: "owner",
        reason: "Not a real bypass",
      }),
      true,
    );
    const after = service.summary();
    assert.deepEqual(after.direction.outstandingAcceptedFindings, []);
    assert.deepEqual(after.direction.findingsNeedingRuling, []);
    assert.equal(after.findings.length, 1);
    assert.equal(after.findings[0].state, "rejected");
    assert.equal(after.findings[0].fixState, undefined);
    assert.equal(after.findings[0].humanResolution.reason, "Not a real bypass");
    catalog.close();
  });
});

test("round comparison separates new, repeated, resolved, regressed, and reopened findings", () => {
  const history = [
    { identity: "A", state: "accepted", challengeHistory: [{ cycleId: "Y1", participantIds: ["codex", "claude"], text: "c", recordedAt: "t" }] },
    { identity: "B", state: "repeated", challengeHistory: [] },
    { identity: "C", state: "resolved", challengeHistory: [] },
    { identity: "D", state: "regressed", challengeHistory: [] },
    { identity: "E", state: "reopened", challengeHistory: [] },
  ];
  const comparison = compareRound({
    cycleId: "Y2",
    history,
    newIdentities: ["A"],
    repeatedIdentities: ["B"],
    resolvedIdentities: ["C"],
    regressedIdentities: ["D"],
    reopenedIdentities: ["E"],
    previousDecisions: [
      { id: "D1", subject: "Ownership", state: "proposed" },
      { id: "D2", subject: "Rollback", state: "accepted" },
    ],
    currentDecisions: [
      { id: "D1", subject: "Ownership", state: "accepted" },
      { id: "D2", subject: "Rollback", state: "accepted" },
      { id: "D3", subject: "Retries", state: "proposed" },
    ],
  });
  assert.deepEqual(comparison.newMaterial.map((entry) => entry.identity), ["A"]);
  assert.deepEqual(comparison.repeated.map((entry) => entry.identity), ["B"]);
  assert.deepEqual(comparison.resolved.map((entry) => entry.identity), ["C"]);
  assert.deepEqual(comparison.regressed.map((entry) => entry.identity), ["D"]);
  assert.deepEqual(comparison.reopened.map((entry) => entry.identity), ["E"]);
  assert.deepEqual(comparison.outstandingAccepted.map((entry) => entry.identity), ["A"]);
  assert.deepEqual(comparison.decisionChanges, [
    { decisionId: "D1", subject: "Ownership", from: "proposed", to: "accepted" },
    { decisionId: "D3", subject: "Retries", to: "proposed" },
  ]);
});

test("saturation is never claimed while work or checks are outstanding", () => {
  const openFinding = {
    identity: "A",
    state: "accepted",
    challengeHistory: [{ cycleId: "Y1", participantIds: [], text: "c", recordedAt: "t" }],
  };
  const noisy = saturationReport({
    quietFreshReviews: 0,
    history: [openFinding],
    decisions: [{ id: "D1", subject: "s", state: "proposed" }],
    checks: [{ command: "bachata:project-checks", status: "failed" }],
    verificationExpected: true,
  });
  assert.equal(noisy.saturated, false);
  assert.equal(noisy.reasons.length, 4);

  const quiet = saturationReport({
    quietFreshReviews: 2,
    history: [{ ...openFinding, state: "resolved" }],
    decisions: [{ id: "D1", subject: "s", state: "accepted" }],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    verificationExpected: true,
  });
  assert.equal(quiet.saturated, true);
  assert.deepEqual(quiet.reasons, []);
  assert.match(SATURATION_DISCLAIMER, /not a correctness proof/u);
});

test("quiet fresh reviews are counted only from the trailing quiet fresh rounds", () => {
  const round = (overrides) => ({
    runRef: "R1",
    executionRef: "E1",
    recordedAt: "t",
    freshReview: true,
    newMaterialCount: 0,
    regressionCount: 0,
    notObservedCount: 0,
    ...overrides,
  });
  assert.equal(quietFreshReviewCount([]), 0);
  assert.equal(
    quietFreshReviewCount([
      round({}),
      round({ newMaterialCount: 3 }),
      round({}),
    ]),
    1,
  );
  assert.equal(quietFreshReviewCount([round({}), round({ regressionCount: 1 })]), 0);
  assert.equal(
    quietFreshReviewCount([round({}), round({ freshReview: false, newMaterialCount: 9 }), round({})]),
    2,
    "a non-fresh round is not a fresh review and never breaks the quiet streak",
  );
});

test("the direction view answers the top-level questions and names one next action", () => {
  const empty = directionView({
    decisions: [],
    history: [],
    saturation: saturationReport({
      quietFreshReviews: 0,
      history: [],
      decisions: [],
      checks: [],
      verificationExpected: false,
    }),
  });
  assert.equal(empty.nextAction.kind, "defineInitiative");

  const initiative = {
    schemaVersion: 1,
    id: "N1",
    repositoryId: "REPO1",
    title: "Stabilize cancellation",
    goal: "Cancellation never leaks a worktree",
    desiredOutcome: "Every cancel path is proven",
    scope: ["src/orchestrator"],
    constraints: ["No new dependencies"],
    acceptanceCriteria: ["No leaked worktree after cancel"],
    currentDirection: "Guard the cleanup path in the controller",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const pending = directionView({
    initiative,
    decisions: [{ id: "D1", subject: "Ownership", state: "proposed" }],
    history: [],
    saturation: saturationReport({
      quietFreshReviews: 0,
      history: [],
      decisions: [{ id: "D1", subject: "Ownership", state: "proposed" }],
      checks: [],
      verificationExpected: false,
    }),
  });
  assert.equal(pending.goal, "Cancellation never leaks a worktree");
  assert.equal(pending.acceptedDirection, "Guard the cleanup path in the controller");
  assert.deepEqual(pending.acceptanceCriteria, ["No leaked worktree after cancel"]);
  assert.equal(pending.nextAction.kind, "resolveDecisions");
  assert.equal(pending.decisionsNeedingHuman.length, 1);

  const regressed = directionView({
    initiative,
    decisions: [],
    history: [{ identity: "A", state: "regressed", challengeHistory: [], subject: "Guard" }],
    saturation: saturationReport({
      quietFreshReviews: 0,
      history: [],
      decisions: [],
      checks: [],
      verificationExpected: false,
    }),
  });
  assert.equal(regressed.nextAction.kind, "reviewRegressions");

  const openCycle = {
    id: "Y1",
    sequence: 1,
    initiativeId: "N1",
    type: "review",
    completion: "open",
    runRefs: [],
    inputArtifactIds: [],
    outputArtifactIds: [],
    acceptedStateDelta: {
      acceptedArtifactIds: [],
      rejectedArtifactIds: [],
      acceptedDecisionIds: [],
      newFindingIdentities: [],
      resolvedFindingIdentities: [],
      regressedFindingIdentities: [],
      notObservedFindingIdentities: [],
    },
    createdAt: "t",
    updatedAt: "t",
  };
  const saturated = directionView({
    initiative,
    currentCycle: openCycle,
    decisions: [],
    history: [],
    saturation: saturationReport({
      quietFreshReviews: 2,
      history: [],
      decisions: [],
      checks: [{ command: "bachata:project-checks", status: "passed" }],
      verificationExpected: true,
    }),
  });
  assert.equal(saturated.nextAction.kind, "closeCycle");
  assert.equal(saturated.saturationDisclaimer, SATURATION_DISCLAIMER);

  const closed = directionView({
    initiative,
    currentCycle: { ...openCycle, completion: "completed" },
    decisions: [],
    history: [],
    saturation: saturationReport({
      quietFreshReviews: 2,
      history: [],
      decisions: [],
      checks: [{ command: "bachata:project-checks", status: "passed" }],
      verificationExpected: true,
    }),
  });
  assert.equal(
    closed.nextAction.kind,
    "startCycle",
    "a closed cycle was offered for closing again",
  );
});

test("longitudinal documents reject malformed persisted rows instead of trusting them", () => {
  assert.equal(parseInitiative(undefined), undefined);
  assert.equal(parseInitiative({ id: "N1", repositoryId: "R", title: "t" }), undefined);
  assert.equal(parseCycle({ id: "Y1" }), undefined);
  const lenient = parseInitiative({
    id: "N1",
    repositoryId: "REPO1",
    title: "t",
    goal: "g",
    status: "not-a-status",
    scope: ["a", "a", 7],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(lenient.status, "active");
  assert.deepEqual(lenient.scope, ["a"]);
});

const {
  baselineDrift,
  baselineIsSameCandidate,
  baselinePathExpectations,
  contentDigest,
  parsePorcelainEntries,
  worktreeIsAbsent,
  worktreeIsComplete,
} = require("../dist/longitudinal/repositoryBaseline.js");
const { applyExportPolicyToSchema } = require("../dist/export/exportPolicy.js");
const { INITIATIVE_BUNDLE_SPEC } = require("../dist/longitudinal/bundleSchema.js");
const { parseCycleBaseline } = require("../dist/longitudinal/parse.js");

const baselineAt = (overrides = {}) => ({
  commit: "1111111111111111111111111111111111111111",
  branch: "main",
  dirty: false,
  worktreeDigest: contentDigest([], new Map()),
  contentComplete: true,
  capturedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("a persisted legacy baseline string still parses as a commit-only baseline", () => {
  assert.deepEqual(parseCycleBaseline("abc1234"), {
    commit: "abc1234",
    dirty: false,
    worktreeDigest: "",
    contentComplete: false,
    capturedAt: "",
  });
  assert.ok(
    baselineDrift(parseCycleBaseline("abc1234"), baselineAt({ commit: "abc1234" }))
      .some((reason) => reason.includes("could not fingerprint the whole working tree")),
    "a legacy baseline carries no content fingerprint and must read as changed",
  );
  assert.equal(parseCycleBaseline(undefined), undefined);
  assert.equal(parseCycleBaseline({ dirty: true }), undefined);
});

test("baseline drift names the exact way the repository left the cycle candidate", () => {
  assert.deepEqual(baselineDrift(baselineAt(), baselineAt()), []);
  assert.deepEqual(baselineDrift(undefined, baselineAt()), []);
  assert.equal(
    baselineDrift(baselineAt(), undefined).length,
    1,
    "an unreadable repository must not read as no drift",
  );
  assert.equal(
    baselineDrift(baselineAt(), baselineAt({ contentComplete: false })).length,
    1,
    "an incomplete fingerprint must not read as no drift",
  );

  const moved = baselineDrift(
    baselineAt(),
    baselineAt({ commit: "2222222222222222222222222222222222222222" }),
  );
  assert.equal(moved.length, 1);
  assert.match(moved[0], /^the repository moved from 111111111111 to 222222222222/u);

  const branched = baselineDrift(baselineAt(), baselineAt({ branch: "feature" }));
  assert.equal(branched.length, 1);
  assert.match(branched[0], /branch changed from main to feature/u);

  const edited = baselineDrift(
    baselineAt(),
    baselineAt({
      dirty: true,
      worktreeDigest: contentDigest(
        [{ status: " M", path: "src/a.ts" }],
        new Map([["src/a.ts", "deadbeef"]]),
      ),
    }),
  );
  assert.deepEqual(edited, ["the working tree changed since this cycle was baselined"]);
});

test("direction reads verification from the cycle, never from a selected run", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });

    const before = service.summary();
    assert.equal(before.direction.verification, undefined);
    assert.ok(
      before.saturation.reasons.every((reason) => !reason.includes("No required check")),
      "an unrecorded expectation must not invent a check reason",
    );

    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordVerification({
      runRef: "R00000001",
      checks: [{ command: "npm test", status: "passed" }],
      expected: true,
      baseline: baselineAt(),
    });

    const after = service.summary();
    assert.equal(after.direction.verification.runRef, "R00000001");
    assert.deepEqual(after.direction.verification.checks, [
      { command: "npm test", status: "passed" },
    ]);
    assert.equal(
      service.summary().direction.verification.recordedAt,
      after.direction.verification.recordedAt,
      "an unchanged verification must not rewrite the cycle on every summary",
    );
    catalog.close();
  });
});

// EX-G6-12. Saturation reads one verification: the one bound to the latest round. Every terminal
// run records one, including a read-only review that verifies nothing — so an earlier *required*
// verification that failed was replaced, for saturation's purposes, by a later optional review
// carrying no checks at all. The failure stopped being a reason, and the cycle read as done.
test("a later optional review does not hide a required verification that failed", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });

    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [] });
    service.recordVerification({
      runRef: "R00000001",
      checks: [{ command: "npm test", status: "failed" }],
      expected: true,
      baseline: baselineAt(),
    });
    assert.ok(
      service.summary().saturation.reasons.some((reason) =>
        reason.includes("required checks did not pass")),
      "a failing required check was not a reason on its own run",
    );

    // A read-only review afterwards: it verifies nothing and is not expected to.
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000002", executionRef: "E2", findings: [] });
    service.recordVerification({
      runRef: "R00000002",
      checks: [],
      expected: false,
      baseline: baselineAt(),
    });

    const after = service.summary();
    assert.ok(
      after.saturation.reasons.some((reason) => reason.includes("required checks did not pass")),
      "a later review that verified nothing hid a required check that failed",
    );
    assert.equal(after.saturation.saturated, false);

    // A later run that does verify supersedes it, which is what resolving the failure looks like.
    service.bindRun({ runRef: "R00000003", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000003", executionRef: "E3", findings: [] });
    service.recordVerification({
      runRef: "R00000003",
      checks: [{ command: "npm test", status: "passed" }],
      expected: true,
      baseline: baselineAt(),
    });
    assert.deepEqual(
      service.summary().saturation.reasons.filter((reason) =>
        reason.includes("required checks did not pass")),
      [],
      "a passing required verification did not clear the earlier failure",
    );
    catalog.close();
  });
});

test("a moved repository makes the cycle stale, blocks saturation, and asks for a rebaseline", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordVerification({
      runRef: "R00000001",
      checks: [{ command: "npm test", status: "passed" }],
      expected: true,
      baseline: baselineAt(),
    });

    const aligned = service.summary({ currentBaseline: baselineAt() });
    assert.deepEqual(aligned.direction.baselineDrift, []);

    const moved = baselineAt({ commit: "3333333333333333333333333333333333333333" });
    const drifted = service.summary({ currentBaseline: moved });
    assert.equal(drifted.direction.baselineDrift.length, 1);
    assert.equal(drifted.saturation.saturated, false);
    assert.ok(
      drifted.saturation.reasons.some((reason) => reason.includes("required checks are stale")),
      "drift must invalidate the recorded checks",
    );
    assert.equal(drifted.direction.nextAction.kind, "rebaseline");

    service.rebaseline(moved);
    const rebaselined = service.summary({ currentBaseline: moved });
    assert.deepEqual(rebaselined.direction.baselineDrift, []);
    assert.deepEqual(rebaselined.direction.baseline, moved);
    catalog.close();
  });
});

test("two initiatives in one repository keep separate state and switch explicitly", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    const first = service.defineInitiative({ title: "First", goal: "Goal one" });
    service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    assert.equal(service.currentInitiative().id, first.id);

    const second = service.createInitiative({ title: "Second", goal: "Goal two" });
    assert.notEqual(second.id, first.id);
    assert.equal(service.currentInitiative().id, second.id);
    assert.deepEqual(service.summary().cycles, [], "a new initiative inherited another's cycles");
    assert.deepEqual(
      service.listInitiatives().map((item) => item.title).sort(),
      ["First", "Second"],
    );

    assert.equal(service.switchInitiative(first.id).id, first.id);
    assert.equal(service.currentInitiative().id, first.id);
    assert.equal(service.summary().cycles.length, 1);
    assert.equal(service.switchInitiative("NUNKNOWN"), undefined);

    assert.equal(service.setInitiativeStatus(second.id, "paused").status, "paused");
    assert.equal(
      service.listInitiatives().find((item) => item.id === second.id).status,
      "paused",
    );
    catalog.close();
  });
});

test("an exported initiative imports as a separate initiative with remapped ids", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Original", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
    });

    const bundle = service.exportInitiative();
    assert.equal(bundle.bundleVersion, 1);
    assert.equal(bundle.initiative.title, "Original");
    assert.equal(bundle.cycles.length, 1);
    assert.equal(bundle.rounds.length, 1);
    assert.equal(bundle.findings.length, 1);
    assert.equal(bundle.artifacts.length, 1);

    assert.equal(
      service.importInitiative({ ...bundle, bundleVersion: 99 }).ok,
      false,
      "a bundle from an unreadable format was imported anyway",
    );
    assert.equal(service.importInitiative({ nonsense: true }).ok, false);

    const imported = service.importInitiative(JSON.parse(JSON.stringify(bundle)));
    assert.equal(imported.ok, true);
    assert.notEqual(imported.initiative.id, bundle.initiative.id);
    assert.equal(service.currentInitiative().id, imported.initiative.id);

    const restoredSummary = service.summary();
    assert.equal(restoredSummary.cycles.length, 1);
    assert.notEqual(restoredSummary.cycles[0].id, bundle.cycles[0].id);
    assert.equal(restoredSummary.cycles[0].initiativeId, imported.initiative.id);
    assert.equal(restoredSummary.findings.length, 1);
    assert.equal(restoredSummary.findings[0].initiativeId, imported.initiative.id);
    assert.equal(restoredSummary.findings[0].lastCycleId, restoredSummary.cycles[0].id);
    assert.equal(restoredSummary.artifacts.length, 1);
    assert.equal(restoredSummary.artifacts[0].cycleId, restoredSummary.cycles[0].id);
    assert.equal(
      service.listInitiatives().length,
      2,
      "an import replaced the initiative it was exported from",
    );
    catalog.close();
  });
});


test("a bundle with a broken reference imports nothing at all", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Original", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const bundle = service.exportInitiative();
    const before = service.listInitiatives().length;

    const danglingCycle = JSON.parse(JSON.stringify(bundle));
    danglingCycle.findings[0].lastCycleId = "YMISSING";
    const rejectedCycle = service.importInitiative(danglingCycle);
    assert.equal(rejectedCycle.ok, false);
    assert.match(rejectedCycle.reason, /YMISSING/u);

    const malformed = JSON.parse(JSON.stringify(bundle));
    malformed.decisions = [{ id: "D1" }];
    const rejectedDecision = service.importInitiative(malformed);
    assert.equal(rejectedDecision.ok, false);
    assert.match(rejectedDecision.reason, /\$\.decisions\[0\]/u);

    const missingList = JSON.parse(JSON.stringify(bundle));
    delete missingList.rounds;
    const rejectedMissing = service.importInitiative(missingList);
    assert.equal(rejectedMissing.ok, false);
    assert.match(rejectedMissing.reason, /missing the required field at \$\.rounds/u);

    const duplicated = JSON.parse(JSON.stringify(bundle));
    duplicated.cycles = [...duplicated.cycles, duplicated.cycles[0]];
    const rejectedDuplicate = service.importInitiative(duplicated);
    assert.equal(rejectedDuplicate.ok, false);
    assert.match(rejectedDuplicate.reason, /repeats the cycle id/u);

    assert.equal(
      service.listInitiatives().length,
      before,
      "a refused import still created an initiative",
    );
    catalog.close();
  });
});

test("an imported bundle remaps every nested reference and drops candidate-bound checks", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Original", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.linkFixRun({ identity, runRef: "R00000002" });
    service.recordVerification({
      runRef: "R00000001",
      checks: [{ command: "npm test", status: "passed" }],
      expected: true,
      baseline: baselineAt(),
    });

    const bundle = service.exportInitiative();
    assert.equal(bundle.fixRuns.length, 1, "the bundle omitted the fix-run linkage");

    const sourceCycleId = bundle.cycles[0].id;
    const imported = service.importInitiative(JSON.parse(JSON.stringify(bundle)));
    assert.equal(imported.ok, true);

    const after = service.summary();
    const importedCycleId = after.cycles[0].id;
    assert.notEqual(importedCycleId, sourceCycleId);

    assert.equal(
      after.artifacts[0].provenance.cycleId,
      importedCycleId,
      "artifact provenance still names the source cycle",
    );
    assert.equal(
      after.findings[0].challengeHistory[0].cycleId,
      importedCycleId,
      "challenge history still names the source cycle",
    );
    assert.deepEqual(
      after.cycles[0].verifications,
      undefined,
      "an imported cycle carried a check for a candidate this workspace does not have",
    );
    assert.deepEqual(
      after.cycles[0].runRefs,
      [],
      "an imported cycle claimed runs that do not exist here",
    );
    assert.deepEqual(
      after.fixRuns.map((item) => [item.identity, item.runRef]),
      [[identity, "R00000002"]],
      "the imported finding kept a fix state with no fix provenance",
    );
    assert.equal(after.findings[0].fixState, "fixRunning");

    const serialised = JSON.stringify({
      initiative: after.initiative,
      cycles: after.cycles,
      artifacts: after.artifacts,
      decisions: after.decisions,
      findings: after.findings,
      fixRuns: after.fixRuns,
      findingAliases: after.findingAliases,
    });
    assert.equal(
      serialised.includes(sourceCycleId),
      false,
      "a source cycle id survived somewhere in the imported state",
    );
    catalog.close();
  });
});

test("a plan whose only change is its evidence produces a new revision", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "planning", repositoryBaseline: baselineAt() });
    const plan = (evidence) => ({
      stepId: "plan-consensus",
      participantIds: ["codex", "claude"],
      plan: {
        title: "Guard the cancel path",
        summary: "Add a finally block",
        scope: [],
        steps: [{ id: "1", intent: "Add the finally block", files: [] }],
        risks: [],
        acceptanceCriteria: [],
        evidence,
      },
    });

    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: false });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [],
      planSource: plan(["The bypass was traced"]),
    });
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: false });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [],
      planSource: plan(["The bypass was traced", "A reproduction now exists"]),
    });

    const plans = service.summary().artifacts.filter((item) => item.type === "plan");
    assert.equal(plans.length, 2, "new plan evidence was discarded instead of revised");
    const current = plans.find((item) => item.supersededById === undefined);
    assert.deepEqual(current.evidence, ["The bypass was traced", "A reproduction now exists"]);
    catalog.close();
  });
});


test("a rebaseline to the same candidate keeps the epoch and its quiet rounds", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [] });

    assert.equal(
      baselineIsSameCandidate(baselineAt(), baselineAt()),
      true,
      "an identical candidate did not compare equal",
    );
    assert.equal(
      baselineIsSameCandidate(
        baselineAt({ contentComplete: false }),
        baselineAt({ contentComplete: false }),
      ),
      false,
      "two unfingerprintable candidates were treated as the same candidate",
    );

    const before = service.summary({ currentBaseline: baselineAt() });
    assert.equal(before.saturation.quietFreshReviews, 1);

    service.rebaseline(baselineAt({ capturedAt: "2026-02-02T00:00:00.000Z" }));
    const after = service.summary({ currentBaseline: baselineAt() });
    assert.equal(
      after.saturation.quietFreshReviews,
      0,
      "the service should still bump on an explicit rebaseline",
    );
    catalog.close();
  });
});

test("a round records the epoch its run was bound at, not the epoch it finished in", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });

    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    const moved = baselineAt({ commit: "2222222222222222222222222222222222222222" });
    service.rebaseline(moved);
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [] });

    const after = service.summary({ currentBaseline: moved });
    assert.equal(
      after.saturation.quietFreshReviews,
      0,
      "a run started against the previous candidate counted as a quiet review of the new one",
    );
    assert.equal(service.rounds(cycle.id).at(-1).baselineEpoch, 1);
    catalog.close();
  });
});

test("a bundle with a dangling nested reference or a corrupt enum imports nothing", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Original", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const bundle = service.exportInitiative();
    const before = service.listInitiatives().length;

    const danglingChallenge = JSON.parse(JSON.stringify(bundle));
    danglingChallenge.findings[0].challengeHistory[0].cycleId = "DANGLING";
    const rejectedChallenge = service.importInitiative(danglingChallenge);
    assert.equal(rejectedChallenge.ok, false, "a dangling challenge cycle imported");
    assert.match(rejectedChallenge.reason, /DANGLING/u);

    const corruptEnum = JSON.parse(JSON.stringify(bundle));
    corruptEnum.cycles[0].completion = "corrupt";
    const rejectedEnum = service.importInitiative(corruptEnum);
    assert.equal(rejectedEnum.ok, false, "a corrupt cycle completion was normalized and imported");

    const corruptFixState = JSON.parse(JSON.stringify(bundle));
    corruptFixState.findings[0].fixState = "nonsense";
    assert.equal(service.importInitiative(corruptFixState).ok, false);

    const danglingRoundIdentity = JSON.parse(JSON.stringify(bundle));
    danglingRoundIdentity.rounds[0].identities.newIdentities = ["FHNOTHERE"];
    const rejectedRound = service.importInitiative(danglingRoundIdentity);
    assert.equal(rejectedRound.ok, false);
    assert.match(rejectedRound.reason, /FHNOTHERE/u);

    assert.equal(
      service.listInitiatives().length,
      before,
      "a refused import still created an initiative",
    );
    catalog.close();
  });
});

test("imported fix runs are historical and never drive a live fix outcome", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Original", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.linkFixRun({ identity, runRef: "R00000002" });

    const bundle = service.exportInitiative();
    const imported = service.importInitiative(JSON.parse(JSON.stringify(bundle)));
    assert.equal(imported.ok, true);

    const after = service.summary();
    assert.equal(after.fixRuns.length, 1);
    assert.equal(after.fixRuns[0].imported, true, "an imported fix run was not marked historical");

    const importedId = imported.initiative.id;
    const originalId = service
      .listInitiatives()
      .map((item) => item.id)
      .find((id) => id !== importedId);

    assert.deepEqual(
      service.recordFixOutcome({ runRef: "R00000002", state: "fixApplied" }),
      [identity],
      "the live fix run was ignored in favour of the imported one",
    );

    assert.equal(service.currentInitiative().id, importedId);
    const stillImported = service.summary();
    assert.equal(
      stillImported.fixRuns[0].state,
      "fixRunning",
      "a local run outcome was routed onto the imported initiative",
    );
    assert.equal(stillImported.findings[0].fixState, "fixRunning");

    service.switchInitiative(originalId);
    assert.equal(service.summary().findings[0].fixState, "fixApplied");
    catalog.close();
  });
});

test("merging two findings that share a fix run keeps the furthest state", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [
        finding({ id: "f1", subject: "Wording one" }),
        finding({ id: "f2", subject: "Wording two" }),
      ],
    });
    const [canonical, absorbed] = service.summary().findings;
    for (const entry of [canonical, absorbed]) {
      service.resolve({
        target: "finding",
        id: entry.identity,
        action: "accept",
        resolvedBy: "owner",
      });
      service.linkFixRun({ identity: entry.identity, runRef: "R00000002" });
    }
    service.recordFixOutcome({ runRef: "R00000002", state: "fixApplied" });
    catalog.longitudinal.commitFixRunState({
      fixRuns: [{
        initiativeId: service.currentInitiative().id,
        identity: canonical.identity,
        runRef: "R00000002",
        state: "fixRunning",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }],
      findings: [],
    });

    assert.equal(
      service.mergeFindings({
        absorbedIdentity: absorbed.identity,
        canonicalIdentity: canonical.identity,
        reason: "Same defect",
        resolvedBy: "owner",
      }).ok,
      true,
    );

    const after = service.summary();
    assert.equal(after.fixRuns.length, 1, "a shared fix run was duplicated or destroyed");
    assert.equal(
      after.fixRuns[0].state,
      "fixApplied",
      "the merge kept the less advanced fix-run state",
    );
    catalog.close();
  });
});


test("a catalog written before the fix-run provenance column still opens", async () => {
  await withCatalog(async (root) => {
    const first = createStateCatalog(root);
    const service = serviceFor(first);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    first.close();

    const database = new DatabaseSync(path.join(root, "bachata-state.sqlite"));
    database.exec("ALTER TABLE finding_fix_runs DROP COLUMN imported");
    const applied = database
      .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
      .all()
      .map((row) => Number(row.version));
    assert.ok(applied.includes(13), "migration 13 was never recorded");
    database.exec("DELETE FROM schema_migrations WHERE version > 13");
    database.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    const identity = findingIdentity(finding());
    restored.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    assert.equal(
      restored.linkFixRun({ identity, runRef: "R00000002" }).ok,
      true,
      "an older catalog could not record a fix run after upgrade",
    );
    assert.deepEqual(restored.fixRuns().map((item) => item.imported), [undefined]);
    reopened.close();
  });
});

test("a run bound to an earlier candidate records history without changing the current one", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });

    const moved = baselineAt({ commit: "2222222222222222222222222222222222222222" });
    service.rebaseline(moved);

    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const after = service.summary({ currentBaseline: moved });
    assert.deepEqual(
      after.findings,
      [],
      "a stale-candidate run folded its findings into the current candidate",
    );
    assert.deepEqual(after.artifacts, [], "a stale-candidate run produced a current artifact");
    assert.deepEqual(after.currentCycle.acceptedStateDelta.newFindingIdentities, []);
    assert.equal(service.rounds(cycle.id).length, 1, "the stale round was discarded entirely");
    assert.ok(
      service.rounds(cycle.id)[0].validationErrors.some(
        (item) => item.includes("earlier repository candidate")),
      "the stale round did not say why it was not folded in",
    );
    assert.equal(
      service.recordVerification({
        runRef: "R00000001",
        checks: [{ command: "npm test", status: "passed" }],
        expected: true,
      }),
      undefined,
      "a stale-candidate run recorded a check against the current candidate",
    );
    catalog.close();
  });
});

test("applied work records the fix outcome and its patch together or not at all", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: false });
    service.linkFixRun({ identity, runRef: "R00000002" });

    service.closeCycle("done");
    const refused = service.recordAppliedWork({
      runRef: "R00000002",
      title: "Applied work",
      stagedFiles: ["src/a.ts"],
      targetBranch: "main",
    });
    assert.equal(refused.ok, false, "applied work was recorded against a closed cycle");
    assert.match(refused.reason, /closed/u);
    assert.equal(
      service.summary().findings[0].fixState,
      "fixRunning",
      "a refused apply still advanced the fix state",
    );
    assert.deepEqual(
      service.summary().artifacts.filter((item) => item.type === "patch"),
      [],
    );

    const reopenedCycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000003", cycleId: reopenedCycle.id, freshReview: false });
    service.linkFixRun({ identity, runRef: "R00000003" });
    const accepted = service.recordAppliedWork({
      runRef: "R00000003",
      title: "Applied work",
      stagedFiles: ["src/a.ts"],
      targetBranch: "main",
    });
    assert.equal(accepted.ok, true);
    assert.deepEqual(accepted.identities, [identity]);
    const patches = service.summary().artifacts.filter((item) => item.type === "patch");
    assert.equal(patches.length, 1, "an applied fix produced no patch artifact");
    assert.equal(service.summary().findings[0].fixState, "fixApplied");
    catalog.close();
  });
});

test("a bundle exported after a merge imports back into Bachata", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [
        finding({ id: "f1", subject: "Wording one" }),
        finding({ id: "f2", subject: "Wording two" }),
      ],
    });
    const [canonical, absorbed] = service.summary().findings;
    assert.equal(
      service.mergeFindings({
        absorbedIdentity: absorbed.identity,
        canonicalIdentity: canonical.identity,
        reason: "Same defect",
        resolvedBy: "owner",
      }).ok,
      true,
    );

    const bundle = service.exportInitiative();
    const roundIdentities = bundle.rounds[0].identities.newIdentities;
    assert.ok(
      roundIdentities.includes(absorbed.identity),
      "the historical round no longer names the absorbed identity, so this test proves nothing",
    );

    const imported = service.importInitiative(JSON.parse(JSON.stringify(bundle)));
    assert.equal(imported.ok, true, "Bachata refused a bundle it produced itself");
    catalog.close();
  });
});

test("a bundle with a lost resolution or a dangling cycle delta imports nothing", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    const bundle = service.exportInitiative();
    const before = service.listInitiatives().length;

    const lostResolution = JSON.parse(JSON.stringify(bundle));
    lostResolution.findings[0].humanResolution = { action: "accept" };
    assert.equal(
      service.importInitiative(lostResolution).ok,
      false,
      "a malformed human resolution was silently dropped and imported",
    );

    const danglingDelta = JSON.parse(JSON.stringify(bundle));
    danglingDelta.cycles[0].acceptedStateDelta.newFindingIdentities = ["DANGLING"];
    const rejectedDelta = service.importInitiative(danglingDelta);
    assert.equal(rejectedDelta.ok, false, "a dangling cycle finding delta imported");
    assert.match(rejectedDelta.reason, /DANGLING/u);

    assert.equal(service.listInitiatives().length, before);
    catalog.close();
  });
});

test("a conflicted index stage is part of the candidate digest", () => {
  const entries = parsePorcelainEntries(["UU src/a.ts", ""].join("\u0000"));
  const hashes = new Map([["src/a.ts", "worktree"]]);
  const base = new Map([["src/a.ts", ["1:100644:aaa", "2:100644:bbb", "3:100644:ccc"]]]);
  const theirsChanged = new Map([["src/a.ts", ["1:100644:aaa", "2:100644:bbb", "3:100644:ddd"]]]);
  const oursChanged = new Map([["src/a.ts", ["1:100644:aaa", "2:100644:zzz", "3:100644:ccc"]]]);

  assert.notEqual(
    contentDigest(entries, hashes, base),
    contentDigest(entries, hashes, theirsChanged),
    "a change to one conflict stage left the digest unchanged",
  );
  assert.notEqual(
    contentDigest(entries, hashes, base),
    contentDigest(entries, hashes, oursChanged),
    "a change to another conflict stage left the digest unchanged",
  );
});

test("an ambiguous unbound fix link refuses rather than guessing an initiative", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    const first = service.defineInitiative({ title: "First", goal: "One" });
    const firstCycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: firstCycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.linkFixRun({ identity, runRef: "RSHARED" });

    const second = service.createInitiative({ title: "Second", goal: "Two" });
    const secondCycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000009", cycleId: secondCycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000009", executionRef: "E9", findings: [finding()] });
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.linkFixRun({ identity, runRef: "RSHARED" });

    assert.deepEqual(
      service.recordFixOutcome({ runRef: "RSHARED", state: "fixApplied" }),
      [],
      "an ambiguous unbound fix link picked an initiative by ordering",
    );

    service.bindRun({ runRef: "RSHARED", cycleId: secondCycle.id, freshReview: false });
    assert.deepEqual(
      service.recordFixOutcome({ runRef: "RSHARED", state: "fixApplied" }),
      [identity],
      "a bound link did not resolve the ambiguity",
    );
    assert.equal(service.currentInitiative().id, second.id);
    assert.equal(service.summary().findings[0].fixState, "fixApplied");
    service.switchInitiative(first.id);
    assert.equal(
      service.summary().findings[0].fixState,
      "fixRunning",
      "the outcome leaked into the unbound initiative",
    );
    catalog.close();
  });
});


test("a stale round carries no identities and its bundle still imports", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.rebaseline(baselineAt({ commit: "2222222222222222222222222222222222222222" }));

    const outcome = service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
    });
    assert.equal(outcome.stale, true, "a stale round did not report itself as stale");

    const stale = service.rounds(cycle.id).at(-1);
    assert.deepEqual(stale.identities.newIdentities, []);
    assert.equal(stale.newMaterialCount, 0);
    assert.equal(stale.materialChangeCount, 0);
    assert.deepEqual(stale.decisionChanges, []);

    const bundle = service.exportInitiative();
    assert.equal(
      service.importInitiative(JSON.parse(JSON.stringify(bundle))).ok,
      true,
      "Bachata refused a bundle containing its own stale round",
    );
    catalog.close();
  });
});

test("a supplied but malformed nested field refuses the import", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      decisionSource: {
        stepId: "review-consensus",
        participantIds: ["codex", "claude"],
        candidates: [{
          subject: "Retry policy",
          question: "Should cancelled runs retry?",
          affectedScope: ["src/orchestrator"],
          options: [{ id: "o1", summary: "Retry once", tradeOffs: ["hides flakiness"] }],
          tradeOffs: ["hides flakiness"],
          evidence: ["both providers disagreed"],
        }],
      },
    });
    const bundle = service.exportInitiative();
    const before = service.listInitiatives().length;

    const corrupt = (mutate) => {
      const copy = JSON.parse(JSON.stringify(bundle));
      mutate(copy);
      return service.importInitiative(copy);
    };

    assert.equal(
      corrupt((b) => { b.findings[0].challengeHistory = [{}]; }).ok,
      false,
      "a malformed challenge history was silently replaced with an empty list",
    );
    assert.equal(
      corrupt((b) => { b.findings[0].evidence = [""]; }).ok,
      false,
      "a malformed evidence list was silently dropped",
    );
    assert.equal(corrupt((b) => { b.decisions[0].options = [{ id: "o1" }]; }).ok, false);
    assert.equal(
      corrupt((b) => { b.artifacts[0].provenance = { participantIds: [1] }; }).ok,
      false,
    );
    assert.equal(
      corrupt((b) => { b.rounds[0].identities.newIdentities = [null]; }).ok,
      false,
    );
    assert.equal(
      corrupt((b) => { b.rounds[0].decisionChanges = [{ decisionId: "D1" }]; }).ok,
      false,
    );

    assert.equal(service.listInitiatives().length, before);
    catalog.close();
  });
});

test("a bundle with a foreign child or a duplicate round imports nothing", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const bundle = service.exportInitiative();
    const before = service.listInitiatives().length;

    const foreign = JSON.parse(JSON.stringify(bundle));
    foreign.cycles[0].initiativeId = "NFOREIGN";
    const rejectedForeign = service.importInitiative(foreign);
    assert.equal(rejectedForeign.ok, false, "a cycle owned by another initiative imported");
    assert.match(rejectedForeign.reason, /NFOREIGN/u);

    const duplicateRound = JSON.parse(JSON.stringify(bundle));
    duplicateRound.rounds = [...duplicateRound.rounds, duplicateRound.rounds[0]];
    const rejectedRound = service.importInitiative(duplicateRound);
    assert.equal(rejectedRound.ok, false, "a duplicate round imported as a silent first-wins");

    const duplicateSequence = JSON.parse(JSON.stringify(bundle));
    duplicateSequence.cycles = [
      duplicateSequence.cycles[0],
      { ...duplicateSequence.cycles[0], id: "YOTHER" },
    ];
    assert.equal(service.importInitiative(duplicateSequence).ok, false);

    assert.equal(service.listInitiatives().length, before);
    catalog.close();
  });
});

test("applied work with no staged file changes nothing", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: false });
    service.linkFixRun({ identity, runRef: "R00000002" });

    const refused = service.recordAppliedWork({
      runRef: "R00000002",
      title: "Applied work",
      stagedFiles: ["", "   "],
      targetBranch: "main",
    });
    assert.equal(refused.ok, false, "an empty apply advanced the fix state");
    assert.match(refused.reason, /staged no file/u);
    assert.equal(service.summary().findings[0].fixState, "fixRunning");
    assert.deepEqual(
      service.summary().artifacts.filter((item) => item.type === "patch"),
      [],
    );
    catalog.close();
  });
});

test("replaying identical applied work records one patch, and a different one supersedes it", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: false });
    service.linkFixRun({ identity, runRef: "R00000002" });

    const apply = (files) => service.recordAppliedWork({
      runRef: "R00000002",
      title: "Applied work",
      stagedFiles: files,
      targetBranch: "main",
    });

    assert.equal(apply(["src/a.ts"]).ok, true);
    assert.equal(apply(["src/a.ts"]).ok, true);
    const patches = () => service.summary().artifacts.filter((item) => item.type === "patch");
    assert.equal(patches().length, 1, "an identical replay recorded a second patch");

    assert.equal(apply(["src/a.ts", "src/b.ts"]).ok, true);
    const after = patches();
    assert.equal(after.length, 2);
    const current = after.find((item) => item.supersededById === undefined);
    const retired = after.find((item) => item.supersededById !== undefined);
    assert.equal(current.revision, 2, "a different apply produced another revision 1");
    assert.equal(retired.state, "superseded");
    catalog.close();
  });
});


test("replaying an applied fix after verification does not undo the verification", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: false });
    service.linkFixRun({ identity, runRef: "R00000002" });

    const apply = () => service.recordAppliedWork({
      runRef: "R00000002",
      title: "Applied work",
      stagedFiles: ["src/a.ts"],
      targetBranch: "main",
    });
    assert.equal(apply().ok, true);

    service.bindRun({ runRef: "R00000003", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000003", executionRef: "E3", findings: [] });
    assert.equal(service.summary().findings[0].fixState, "verified");
    assert.deepEqual(service.fixRuns().map((item) => item.state), ["verified"]);

    const replay = apply();
    assert.equal(replay.ok, true);
    assert.equal(
      service.summary().findings[0].fixState,
      "verified",
      "an identical replay pushed a verified finding back to fixApplied",
    );
    assert.deepEqual(
      service.fixRuns().map((item) => item.state),
      ["verified"],
      "an identical replay pushed a verified fix run back to fixApplied",
    );
    assert.equal(
      service.summary().artifacts.filter((item) => item.type === "patch").length,
      1,
    );
    catalog.close();
  });
});

test("every supplied bundle field is type-checked before it is normalized", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal", scope: ["src"] });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const bundle = service.exportInitiative();
    const before = service.listInitiatives().length;

    const corrupt = (mutate) => {
      const copy = JSON.parse(JSON.stringify(bundle));
      mutate(copy);
      return service.importInitiative(copy);
    };

    assert.equal(
      corrupt((b) => { b.findings[0].location.startLine = "bad"; }).ok,
      false,
      "a non-numeric line number was normalized away",
    );
    assert.equal(
      corrupt((b) => { b.findings[0].latestObservation.evidence = [{}]; }).ok,
      false,
      "a malformed latest observation was normalized away",
    );
    assert.equal(
      corrupt((b) => { b.artifacts[0].body = { text: "no" }; }).ok,
      false,
      "an object-valued artifact body was accepted",
    );
    assert.equal(
      corrupt((b) => { b.initiative.scope = [{}]; }).ok,
      false,
      "a malformed initiative scope was normalized away",
    );
    assert.equal(
      corrupt((b) => { b.findings[0].inventedField = "x"; }).ok,
      false,
      "an unknown bundle field was accepted",
    );

    assert.equal(service.listInitiatives().length, before);
    catalog.close();
  });
});

test("a merge without an owner, onto itself, or onto a live finding is refused", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [
        finding({ id: "f1", subject: "Wording one" }),
        finding({ id: "f2", subject: "Wording two" }),
      ],
    });
    const [canonical, absorbed] = service.summary().findings;
    service.mergeFindings({
      absorbedIdentity: absorbed.identity,
      canonicalIdentity: canonical.identity,
      reason: "Same defect",
      resolvedBy: "owner",
    });
    const bundle = service.exportInitiative();
    const before = service.listInitiatives().length;

    const corrupt = (mutate) => {
      const copy = JSON.parse(JSON.stringify(bundle));
      mutate(copy);
      return service.importInitiative(copy);
    };

    assert.equal(
      corrupt((b) => { delete b.findingAliases[0].initiativeId; }).ok,
      false,
      "a merge with no owner imported",
    );
    assert.equal(
      corrupt((b) => {
        b.findingAliases[0].canonicalIdentity = b.findingAliases[0].aliasIdentity;
      }).ok,
      false,
      "a merge naming itself imported",
    );
    assert.equal(
      corrupt((b) => { b.findingAliases[0].aliasIdentity = canonical.identity; }).ok,
      false,
      "a merge whose alias is still a live finding imported",
    );

    assert.equal(service.listInitiatives().length, before);
    catalog.close();
  });
});

test("a stale run is recorded durably and stays visible after restart", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    const moved = baselineAt({ commit: "2222222222222222222222222222222222222222" });
    service.rebaseline(moved);
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });

    assert.deepEqual(
      service.summary({ currentBaseline: moved }).staleRuns.map((item) => item.runRef),
      ["R00000001"],
    );
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    assert.deepEqual(
      restored.summary({ currentBaseline: moved }).staleRuns.map((item) => item.runRef),
      ["R00000001"],
      "a stale run vanished when the workspace reopened",
    );
    reopened.close();
  });
});

test("a scoped fix is recognised from its persisted link, not from session memory", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.linkFixRun({ identity, runRef: "R00000002" });
    assert.equal(service.isScopedFixRun("R00000002"), true);
    assert.equal(service.isScopedFixRun("R00000001"), false);
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    assert.equal(
      restored.isScopedFixRun("R00000002"),
      true,
      "a scoped fix lost its authorization across a restart",
    );
    reopened.close();
  });
});


test("a null or missing required bundle field imports nothing", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal", scope: ["src"] });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const bundle = service.exportInitiative();
    const before = service.listInitiatives().length;

    const corrupt = (mutate) => {
      const copy = JSON.parse(JSON.stringify(bundle));
      mutate(copy);
      return service.importInitiative(copy);
    };

    const nullBody = corrupt((b) => { b.artifacts[0].body = null; });
    assert.equal(nullBody.ok, false, "a null artifact body imported as an empty one");
    assert.match(nullBody.reason, /null/u);

    assert.equal(
      corrupt((b) => { delete b.artifacts[0].body; }).ok,
      false,
      "a missing artifact body imported as an empty one",
    );
    assert.equal(
      corrupt((b) => { delete b.artifacts[0].provenance; }).ok,
      false,
      "a missing artifact provenance imported as a default one",
    );
    assert.equal(
      corrupt((b) => { delete b.initiative.scope; }).ok,
      false,
      "a missing initiative scope imported as an empty list",
    );
    assert.equal(
      corrupt((b) => { b.findings[0].occurrences = 0; }).ok,
      false,
      "a non-positive occurrence count imported",
    );
    assert.equal(
      corrupt((b) => { b.rounds[0].newMaterialCount = -1; }).ok,
      false,
      "a negative count imported",
    );
    assert.equal(
      corrupt((b) => { b.findings[0].location = { file: "a.ts", startLine: 0 }; }).ok,
      false,
      "a zero line number imported",
    );

    assert.equal(service.listInitiatives().length, before);
    catalog.close();
  });
});

test("a copy source that vanished marks the candidate incomplete, a rename source does not", () => {
  const renamed = parsePorcelainEntries(["R  new.ts", "old.ts", ""].join("\u0000"));
  assert.deepEqual(renamed, [{ status: "R ", path: "new.ts", origin: "old.ts" }]);

  const copied = parsePorcelainEntries(["C  copy.ts", "source.ts", ""].join("\u0000"));
  assert.deepEqual(copied, [{ status: "C ", path: "copy.ts", origin: "source.ts" }]);

  assert.notEqual(
    contentDigest(renamed, new Map([["new.ts", "aaa"], ["old.ts", "absent"]]), new Map()),
    contentDigest(copied, new Map([["copy.ts", "aaa"], ["source.ts", "absent"]]), new Map()),
    "a rename and a copy of the same shape produced one digest",
  );
});


test("a deletion is absence in either status column, and an unchanged dirty tree stays complete", () => {
  assert.equal(worktreeIsAbsent(" D"), true, "an unstaged deletion was not read as absence");
  assert.equal(worktreeIsAbsent("D "), true, "a staged deletion was not read as absence");
  assert.equal(worktreeIsAbsent("MD"), true);
  assert.equal(worktreeIsAbsent(" M"), false);
  assert.equal(worktreeIsAbsent("??"), false);
  assert.equal(worktreeIsAbsent("R "), false);

  assert.equal(worktreeIsAbsent("DD"), true, "both-deleted is the only absent conflict");
  for (const unmerged of ["AU", "UD", "UA", "DU", "AA", "UU"]) {
    assert.equal(
      worktreeIsAbsent(unmerged),
      false,
      `${unmerged} keeps a file in the working tree and must be fingerprinted`,
    );
  }
});

test("a fully populated bundle survives export, sanitization, and import", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({
      title: "Initiative",
      goal: "Goal",
      desiredOutcome: "Outcome",
      scope: ["src"],
      constraints: ["no new dependencies"],
      acceptanceCriteria: ["no leaked worktree"],
    });
    service.setDirection("Guard the cleanup path");
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [
        finding({ id: "f1", subject: "Wording one" }),
        finding({ id: "f2", subject: "Wording two" }),
      ],
      decisionSource: {
        stepId: "review-consensus",
        participantIds: ["codex", "claude"],
        candidates: [{
          subject: "Retry policy",
          question: "Should cancelled runs retry?",
          affectedScope: ["src/orchestrator"],
          options: [{ id: "o1", summary: "Retry once", tradeOffs: ["hides flakiness"] }],
          tradeOffs: ["hides flakiness"],
          recommendation: "Do not retry",
          evidence: ["both providers disagreed"],
        }],
      },
      planSource: {
        stepId: "plan-consensus",
        participantIds: ["codex", "claude"],
        plan: {
          title: "Guard the cancel path",
          summary: "Add a finally block",
          scope: ["src/orchestrator"],
          steps: [{ id: "1", intent: "Add the block", files: ["src/a.ts"], verification: "npm test" }],
          risks: ["no reproduction"],
          acceptanceCriteria: ["cancel leaves no worktree"],
          evidence: ["the bypass was traced"],
        },
      },
    });

    const [canonical, absorbed] = service.summary().findings;
    service.mergeFindings({
      absorbedIdentity: absorbed.identity,
      canonicalIdentity: canonical.identity,
      reason: "Same defect",
      resolvedBy: "owner",
    });
    service.resolve({
      target: "finding",
      id: canonical.identity,
      action: "accept",
      resolvedBy: "owner",
    });
    service.resolve({
      target: "artifact",
      id: service.summary().artifacts[0].id,
      action: "accept",
      resolvedBy: "owner",
    });
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: false });
    service.linkFixRun({ identity: canonical.identity, runRef: "R00000002" });
    service.recordAppliedWork({
      runRef: "R00000002",
      title: "Applied work",
      stagedFiles: ["src/a.ts"],
      targetBranch: "main",
    });
    service.recordVerification({
      runRef: "R00000001",
      checks: [{ command: "npm test", status: "passed" }],
      expected: true,
      baseline: baselineAt(),
    });

    const bundle = service.exportInitiative();
    assert.ok(bundle.artifacts.length >= 3, "the fixture did not populate every artifact type");
    assert.equal(bundle.decisions.length, 1);
    assert.equal(bundle.findingAliases.length, 1);
    assert.equal(bundle.fixRuns.length, 1);

    const sanitized = applyExportPolicyToSchema(bundle, INITIATIVE_BUNDLE_SPEC, {
      excludePathPrefixes: [],
      redactLiterals: ["Guard"],
    });
    assert.deepEqual(
      sanitized.unclassified,
      [],
      "the bundle schema does not describe every field a real export produces",
    );

    const imported = service.importInitiative(JSON.parse(JSON.stringify(sanitized.value)));
    assert.equal(
      imported.ok,
      true,
      `a sanitized real export could not be imported: ${imported.ok ? "" : imported.reason}`,
    );
    catalog.close();
  });
});

test("a bundle from before the epoch and fingerprint fields still imports", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: baselineAt() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });

    const legacy = JSON.parse(JSON.stringify(service.exportInitiative()));
    delete legacy.cycles[0].baselineEpoch;
    delete legacy.cycles[0].repositoryBaseline.contentComplete;
    delete legacy.rounds[0].baselineEpoch;

    const imported = service.importInitiative(legacy);
    assert.equal(
      imported.ok,
      true,
      `a readable earlier bundle was refused: ${imported.ok ? "" : imported.reason}`,
    );

    const restored = service.summary();
    assert.equal(restored.cycles[0].baselineEpoch, 1);
    assert.equal(
      restored.cycles[0].repositoryBaseline.contentComplete,
      false,
      "a candidate with no recorded fingerprint completeness was trusted",
    );
    catalog.close();
  });
});


test("path selection keeps a copy source that is still present when its destination is gone", () => {
  const expectations = (entries) => [...baselinePathExpectations(entries).entries()].sort();

  assert.deepEqual(
    expectations([{ status: "CD", path: "copy.ts", origin: "source.ts" }]),
    [["copy.ts", true], ["source.ts", false]],
    "a copied destination that was deleted took its still-present source with it",
  );

  assert.deepEqual(
    expectations([{ status: "RD", path: "new.ts", origin: "old.ts" }]),
    [["new.ts", true], ["old.ts", true]],
    "a renamed origin is expected absent",
  );

  assert.deepEqual(
    expectations([{ status: "C ", path: "copy.ts", origin: "source.ts" }]),
    [["copy.ts", false], ["source.ts", false]],
  );

  assert.deepEqual(
    expectations([
      { status: " D", path: "shared.ts" },
      { status: " M", path: "shared.ts" },
    ]),
    [["shared.ts", false]],
    "a path expected present in one entry must still be fingerprinted",
  );
});


test("the candidate digest covers the origin side of a rename or copy", () => {
  const copied = [{ status: "C ", path: "copy.ts", origin: "source.ts" }];
  const base = new Map([["copy.ts", "aaa"], ["source.ts", "sss"]]);
  const originChanged = new Map([["copy.ts", "aaa"], ["source.ts", "CHANGED"]]);
  assert.notEqual(
    contentDigest(copied, base, new Map()),
    contentDigest(copied, originChanged, new Map()),
    "changing only the copy source left the candidate unchanged",
  );

  const renamed = [{ status: "R ", path: "new.ts", origin: "old.ts" }];
  assert.notEqual(
    contentDigest(renamed, new Map([["new.ts", "aaa"], ["old.ts", "absent"]]), new Map()),
    contentDigest(renamed, new Map([["new.ts", "aaa"], ["old.ts", "REAPPEARED"]]), new Map()),
    "a rename origin that reappeared left the candidate unchanged",
  );

  assert.equal(
    contentDigest(copied, base, new Map()),
    contentDigest(copied, new Map(base), new Map()),
    "the digest is not stable for identical input",
  );
});

test("a path that contradicts its recorded status makes the candidate incomplete", () => {
  const expectations = new Map([["gone.ts", true], ["here.ts", false]]);

  assert.equal(
    worktreeIsComplete(expectations, new Map([["gone.ts", "absent"], ["here.ts", "hhh"]])),
    true,
    "a tree that matches its status was reported incomplete",
  );
  assert.equal(
    worktreeIsComplete(expectations, new Map([["gone.ts", "hhh"], ["here.ts", "hhh"]])),
    false,
    "a deleted path that was present at fingerprint time was accepted as a clean snapshot",
  );
  assert.equal(
    worktreeIsComplete(expectations, new Map([["gone.ts", "absent"], ["here.ts", "absent"]])),
    false,
    "a present path that had vanished was accepted as a clean snapshot",
  );
  assert.equal(
    worktreeIsComplete(expectations, new Map([["gone.ts", "absent"], ["here.ts", "unreadable"]])),
    false,
  );
  assert.equal(
    worktreeIsComplete(expectations, new Map([["here.ts", "hhh"]])),
    false,
    "a path that was never fingerprinted was accepted",
  );
});

test("accepted direction is revisioned and never destroys what it replaced", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });

    service.setDirection("Bound every retry path");
    service.setDirection("Bound every retry path and make it cancellable", {
      rationale: "Cancellation was the real defect",
    });

    const initiative = service.currentInitiative();
    assert.equal(initiative.currentDirection, "Bound every retry path and make it cancellable");
    assert.deepEqual(
      initiative.directionRevisions.map((entry) => [entry.revision, entry.text, entry.source]),
      [
        [1, "Bound every retry path", "human"],
        [2, "Bound every retry path and make it cancellable", "human"],
      ],
    );
    assert.equal(initiative.directionRevisions[1].rationale, "Cancellation was the real defect");
    assert.equal(initiative.directionRevisions[0].author, "human");
    assert.ok(initiative.directionRevisions[0].recordedAt);

    // Re-recording the same text is not a change and must not inflate the chain.
    service.setDirection("Bound every retry path and make it cancellable");
    assert.equal(service.currentInitiative().directionRevisions.length, 2);

    assert.deepEqual(
      service.summary().direction.directionRevisions.map((entry) => entry.revision),
      [1, 2],
    );
    catalog.close();
  });
});

test("direction revisions survive a restart and an export/import round trip", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    service.setDirection("First direction");
    service.setDirection("Second direction", { rationale: "New evidence" });
    const bundle = service.exportInitiative();
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened).currentInitiative();
    assert.deepEqual(
      restored.directionRevisions.map((entry) => entry.text),
      ["First direction", "Second direction"],
      "direction history did not survive a restart",
    );
    reopened.close();

    await withCatalog(async (otherRoot) => {
      const other = createStateCatalog(otherRoot);
      const imported = serviceFor(other).importInitiative(bundle);
      assert.equal(imported.ok, true, imported.ok ? "" : imported.reason);
      assert.deepEqual(
        imported.initiative.directionRevisions.map((entry) => [entry.revision, entry.text]),
        [[1, "First direction"], [2, "Second direction"]],
        "import dropped the direction history",
      );
      other.close();
    });
  });
});

test("a malformed direction revision chain is refused rather than half-read", () => {
  const reversed = parseInitiativeRecordFor([
    { revision: 2, text: "b", author: "human", source: "human", recordedAt: "2026-01-01T00:00:00.000Z" },
    { revision: 1, text: "a", author: "human", source: "human", recordedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(reversed, [], "a non-increasing revision chain was accepted");
  const notHuman = parseInitiativeRecordFor([
    { revision: 1, text: "a", author: "model", source: "model", recordedAt: "2026-01-01T00:00:00.000Z" },
  ]);
  assert.deepEqual(notHuman, [], "a revision that was not human-authored was accepted");
});

test("a declared promotion reaches initiative state through recordRound", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });

    service.recordRound({
      runRef: "R00000001",
      executionRef: "X1",
      findings: [],
      declaredArtifacts: [{
        promotion: { type: "requirement", titleField: "title", bodyField: "body", evidenceField: "evidence" },
        output: { title: "Bounded retry", body: "Every retry is bounded", evidence: ["src/retry.ts:23"] },
        fallbackTitle: "Converge",
        participantIds: ["codex", "claude"],
        stepId: "converge",
      }],
    });

    const artifacts = service.summary().artifacts;
    const requirement = artifacts.find((item) => item.type === "requirement");
    assert.ok(requirement, "a declared promotion never reached initiative state");
    assert.equal(requirement.title, "Bounded retry");
    assert.deepEqual(requirement.evidence, ["src/retry.ts:23"]);
    assert.equal(requirement.state, "proposed");
    catalog.close();
  });
});

test("a round that declares no promotion adds no artifact", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "X1", findings: [] });
    assert.deepEqual(
      service.summary().artifacts.filter((item) => item.type === "requirement"),
      [],
      "an undeclared output was promoted into durable state",
    );
    catalog.close();
  });
});

test("a legacy accepted direction is preserved as revision 1 by the first edit", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    // An initiative recorded before revisions existed: direction set, no history.
    service.setDirection("The original direction");
    const legacy = service.currentInitiative();
    catalog.longitudinal.saveInitiative({ ...legacy, directionRevisions: undefined });

    const reopened = serviceFor(catalog);
    assert.equal(reopened.currentInitiative().directionRevisions, undefined);
    reopened.setDirection("A replacement direction", { rationale: "New evidence" });

    const revisions = reopened.currentInitiative().directionRevisions;
    assert.deepEqual(
      revisions.map((entry) => [entry.revision, entry.text]),
      [[1, "The original direction"], [2, "A replacement direction"]],
      "the legacy direction was destroyed instead of seeded as revision 1",
    );
    catalog.close();
  });
});

test("two distinct custom artifact chains never supersede one another", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });

    const round = (runRef, executionRef, customType, body) => {
      service.bindRun({ runRef, cycleId: cycle.id, freshReview: false });
      service.recordRound({
        runRef,
        executionRef,
        findings: [],
        declaredArtifacts: [{
          promotion: { type: "custom", customType, bodyField: "body" },
          output: { body },
          fallbackTitle: customType,
          participantIds: ["codex"],
          stepId: "converge",
        }],
      });
    };

    round("R00000001", "X1", "riskRegister", "three risks");
    round("R00000002", "X2", "openQuestions", "two questions");

    const artifacts = service.summary().artifacts.filter((item) => item.type === "custom");
    assert.deepEqual(
      artifacts.map((item) => item.customType).sort(),
      ["openQuestions", "riskRegister"],
      "a second custom chain replaced the first",
    );
    assert.deepEqual(
      artifacts.filter((item) => item.supersededById !== undefined),
      [],
      "one custom chain superseded a different one",
    );
    assert.deepEqual(artifacts.map((item) => item.revision), [1, 1]);

    // The same chain, changed, does supersede its own previous revision.
    round("R00000003", "X3", "riskRegister", "four risks");
    const risks = service.summary().artifacts
      .filter((item) => item.customType === "riskRegister" && item.supersededById === undefined);
    assert.equal(risks.length, 1);
    assert.equal(risks[0].revision, 2);
    catalog.close();
  });
});

test("a promoted artifact is listed among the cycle's outputs", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "X1",
      findings: [],
      declaredArtifacts: [{
        promotion: { type: "requirement", bodyField: "body" },
        output: { body: "Every retry is bounded" },
        fallbackTitle: "Converge",
        participantIds: ["codex"],
        stepId: "converge",
      }],
    });

    const summary = service.summary();
    const requirement = summary.artifacts.find((item) => item.type === "requirement");
    assert.ok(requirement);
    const currentCycle = summary.cycles.find((item) => item.id === cycle.id);
    assert.ok(
      currentCycle.outputArtifactIds.includes(requirement.id),
      "a promoted artifact was not recorded among the cycle's outputs",
    );
    catalog.close();
  });
});

test("new provenance on unchanged direction wording is recorded, not discarded", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    service.setDirection("Bound every retry path");
    assert.equal(service.currentInitiative().directionRevisions.length, 1);

    // Same wording, newly supplied evidence: the human said something new.
    service.setDirection("Bound every retry path", { evidence: ["src/retry.ts:23"] });
    const revisions = service.currentInitiative().directionRevisions;
    assert.equal(
      revisions.length,
      2,
      "evidence recorded against unchanged wording was thrown away",
    );
    assert.deepEqual(revisions[1].evidence, ["src/retry.ts:23"]);
    assert.equal(revisions[1].text, "Bound every retry path");

    // A genuine repeat with nothing new stays a no-op.
    service.setDirection("Bound every retry path", { evidence: ["src/retry.ts:23"] });
    assert.equal(
      service.currentInitiative().directionRevisions.length,
      2,
      "a repeat with nothing new created a revision",
    );

    service.setDirection("Bound every retry path", { rationale: "Cancellation was the defect" });
    const withRationale = service.currentInitiative().directionRevisions;
    assert.equal(withRationale.length, 3);
    assert.equal(withRationale[2].rationale, "Cancellation was the defect");
    catalog.close();
  });
});
