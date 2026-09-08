const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStateCatalog } = require("../dist/state/catalog.js");
const {
  createLongitudinalService,
  caseFoldedRepositoryIdentities,
  repositoryIdentity,
} = require("../dist/longitudinal/service.js");
const {
  findingIdentity,
  foldFindingsIntoHistory,
} = require("../dist/longitudinal/lifecycle.js");

const REPOSITORY_ROOT = "/work/repo";

let idSeed = 0;
const idFactory = () => {
  idSeed += 1;
  const scope = idSeed;
  const counters = { N: 0, Y: 0, T: 0, D: 0 };
  return (prefix) => {
    counters[prefix] += 1;
    return `${prefix}${String(scope)}${String(counters[prefix]).padStart(7, "0")}`;
  };
};

const clock = () => {
  let tick = 0;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1) + tick * 1000);
  };
};

const withCatalog = async (body) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-longitudinal-regression-"));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const serviceFor = (catalog, repositoryRoot = REPOSITORY_ROOT) =>
  createLongitudinalService({
    store: catalog.longitudinal,
    repositoryRoot,
    now: clock(),
    createId: idFactory(),
  });

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

test("two quiet fresh reviews in one review cycle reach a quiet count of two", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });

    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      freshReview: true,
    });
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E1",
      findings: [finding()],
      freshReview: true,
    });
    service.bindRun({ runRef: "R00000003", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000003",
      executionRef: "E1",
      findings: [finding()],
      freshReview: true,
    });

    const summary = service.summary();
    assert.equal(summary.saturation.quietFreshReviews, 2);
    assert.equal(summary.cycles.length, 1, "a fresh review must not open a cycle per click");
    catalog.close();
  });
});

test("quiet-round state survives a catalog restart", async () => {
  await withCatalog(async (root) => {
    const first = createStateCatalog(root);
    const service = serviceFor(first);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()], freshReview: true });
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000002", executionRef: "E1", findings: [finding()], freshReview: true });
    first.close();

    const second = createStateCatalog(root);
    const restored = serviceFor(second);
    assert.equal(restored.summary().saturation.quietFreshReviews, 1);
    second.close();
  });
});

test("replaying the same execution changes no occurrence, round, or delta", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });

    const first = service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      freshReview: true,
    });
    assert.ok(first, "the first record of an execution must be applied");
    const afterFirst = service.summary();

    const replay = service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      freshReview: true,
    });
    assert.equal(replay, undefined, "replaying one execution must be a no-op");
    const afterReplay = service.summary();

    assert.equal(afterReplay.findings[0].occurrences, afterFirst.findings[0].occurrences);
    assert.deepEqual(
      afterReplay.currentCycle.acceptedStateDelta,
      afterFirst.currentCycle.acceptedStateDelta,
    );
    assert.equal(
      afterReplay.saturation.quietFreshReviews,
      afterFirst.saturation.quietFreshReviews,
    );
    catalog.close();
  });
});

test("two executions that share a run reference stay separate rounds", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });

    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()], freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E2", findings: [finding()], freshReview: true });

    const rounds = catalog.longitudinal.listRounds(service.currentInitiative().id, cycle.id);
    assert.equal(rounds.length, 2);
    assert.deepEqual(rounds.map((round) => round.executionRef), ["E1", "E2"]);
    catalog.close();
  });
});

test("a finding omitted by one fresh review stays open instead of becoming resolved", () => {
  const first = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    history: [],
    findings: [finding()],
    freshReview: true,
  });
  const absent = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y2",
    recordedAt: "2026-01-02T00:00:00.000Z",
    history: first.history,
    findings: [],
    freshReview: true,
  });
  assert.deepEqual(absent.resolvedIdentities, []);
  assert.deepEqual(absent.notObservedIdentities, [findingIdentity(finding())]);
  assert.equal(absent.history[0].state, "accepted");
  assert.equal(absent.history[0].notObservedCycleIds.includes("Y2"), true);
});

test("a paraphrased message keeps one finding and never fakes a resolution", () => {
  const first = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    history: [],
    findings: [finding()],
    freshReview: true,
  });
  const paraphrased = foldFindingsIntoHistory({
    initiativeId: "N1",
    cycleId: "Y2",
    recordedAt: "2026-01-02T00:00:00.000Z",
    history: first.history,
    findings: [finding({ message: "Cleanup is skipped when the run is cancelled" })],
    freshReview: true,
  });
  assert.equal(paraphrased.history.length, 1);
  assert.deepEqual(paraphrased.newIdentities, []);
  assert.deepEqual(paraphrased.resolvedIdentities, []);
  assert.deepEqual(paraphrased.notObservedIdentities, []);
  assert.equal(paraphrased.history[0].occurrences, 2);
  assert.equal(
    paraphrased.history[0].messageHistory.includes("Cancellation bypasses cleanup"),
    true,
  );
});

test("identical decision subjects in two initiatives stay isolated", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const alpha = serviceFor(catalog, "/work/alpha");
    const beta = serviceFor(catalog, "/work/beta");
    alpha.defineInitiative({ title: "Alpha", goal: "Alpha goal" });
    beta.defineInitiative({ title: "Beta", goal: "Beta goal" });

    const subject = "Rollback is unproven";
    const decisionFor = (service, id) => ({
      schemaVersion: 1,
      id,
      initiativeId: service.currentInitiative().id,
      cycleId: "Y0",
      subject,
      affectedScope: [],
      question: "Is this acceptable?",
      options: [],
      tradeOffs: [],
      evidence: [subject],
      state: "proposed",
      provenance: { authoredBy: "controller", participantIds: [] },
      materialEvidenceDelta: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    alpha.saveDecisions([decisionFor(alpha, "SHARED-ID")]);
    beta.saveDecisions([decisionFor(beta, "SHARED-ID")]);

    assert.equal(alpha.summary().decisions.length, 1);
    assert.equal(beta.summary().decisions.length, 1);
    assert.equal(alpha.summary().decisions[0].initiativeId, alpha.currentInitiative().id);
    assert.equal(beta.summary().decisions[0].initiativeId, beta.currentInitiative().id);
    catalog.close();
  });
});

test("repository identity is case sensitive only where the platform is", () => {
  assert.notEqual(
    repositoryIdentity("/work/Repo", { caseSensitive: true }),
    repositoryIdentity("/work/repo", { caseSensitive: true }),
  );
  assert.equal(
    repositoryIdentity("C:/Work/Repo", { caseSensitive: false }),
    repositoryIdentity("c:/work/repo", { caseSensitive: false }),
  );
});

test("case sensitive platforms keep distinct repositories apart", () => {
  const held = process.platform;
  const set = (value) => Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
  try {
    set("darwin");
    assert.notEqual(
      repositoryIdentity("/Volumes/code/Repo"),
      repositoryIdentity("/Volumes/code/repo"),
      "distinct repositories on a case sensitive volume shared one identity",
    );
    assert.deepEqual(
      caseFoldedRepositoryIdentities("/Volumes/code/Repo"),
      [repositoryIdentity("/Volumes/code/repo", { caseSensitive: false })],
      "macOS lost the case folded identity recorded before this change",
    );
    set("linux");
    assert.deepEqual(caseFoldedRepositoryIdentities("/work/Repo"), []);
    set("win32");
    assert.equal(
      repositoryIdentity("C:/Work/Repo"),
      repositoryIdentity("c:/work/repo"),
    );
    assert.deepEqual(caseFoldedRepositoryIdentities("C:/Work/Repo"), []);
  } finally {
    set(held);
  }
});

test("an operational error never becomes a core human decision", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [],
      unresolvedRisks: ["Adapter restart required", "bachata:project-checks did not run"],
      freshReview: true,
    });
    const summary = service.summary();
    assert.deepEqual(summary.decisions, []);
    assert.deepEqual(summary.direction.decisionsNeedingHuman, []);
    catalog.close();
  });
});

test("reopen requires a reason and at least one material evidence delta", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()], freshReview: true });
    const identity = findingIdentity(finding());

    assert.equal(
      service.resolve({
        target: "finding",
        id: identity,
        action: "reopen",
        resolvedBy: "owner",
        reason: "A new failure mode appeared",
      }),
      false,
      "reopen without a material evidence delta must be refused",
    );
    assert.equal(
      service.resolve({
        target: "finding",
        id: identity,
        action: "reopen",
        resolvedBy: "owner",
        reason: "A new failure mode appeared",
        materialEvidenceDelta: ["A reproducing test now exists"],
      }),
      true,
    );
    catalog.close();
  });
});

test("supersede requires a known replacement in the same initiative", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const alpha = serviceFor(catalog, "/work/alpha");
    const beta = serviceFor(catalog, "/work/beta");
    alpha.defineInitiative({ title: "Alpha", goal: "Alpha goal" });
    beta.defineInitiative({ title: "Beta", goal: "Beta goal" });
    const decision = (service, id) => ({
      schemaVersion: 1,
      id,
      initiativeId: service.currentInitiative().id,
      cycleId: "Y0",
      subject: `subject ${id}`,
      affectedScope: [],
      question: "Is this acceptable?",
      options: [],
      tradeOffs: [],
      evidence: ["e"],
      state: "proposed",
      provenance: { authoredBy: "controller", participantIds: [] },
      materialEvidenceDelta: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    alpha.saveDecisions([decision(alpha, "A1"), decision(alpha, "A2")]);
    beta.saveDecisions([decision(beta, "B1")]);

    assert.equal(
      alpha.resolve({ target: "decision", id: "A1", action: "supersede", resolvedBy: "owner" }),
      false,
      "supersede without a replacement must be refused",
    );
    assert.equal(
      alpha.resolve({
        target: "decision",
        id: "A1",
        action: "supersede",
        resolvedBy: "owner",
        supersededById: "A1",
      }),
      false,
      "a record cannot supersede itself",
    );
    assert.equal(
      alpha.resolve({
        target: "decision",
        id: "A1",
        action: "supersede",
        resolvedBy: "owner",
        supersededById: "B1",
      }),
      false,
      "a replacement from another initiative must be refused",
    );
    assert.equal(
      alpha.resolve({
        target: "decision",
        id: "A1",
        action: "supersede",
        resolvedBy: "owner",
        supersededById: "A2",
      }),
      true,
    );
    assert.equal(alpha.summary().decisions.find((item) => item.id === "A1").state, "superseded");
    catalog.close();
  });
});

test("a human resolution shows up as resolved in the current round comparison", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()], freshReview: true });
    const identity = findingIdentity(finding());

    assert.deepEqual(service.summary().direction.latestChange.resolved, []);
    assert.equal(
      service.resolve({
        target: "finding",
        id: identity,
        action: "supersede",
        resolvedBy: "owner",
        supersededById: identity,
      }),
      false,
      "a finding cannot supersede itself",
    );
    assert.equal(
      service.resolve({ target: "finding", id: identity, action: "reject", resolvedBy: "owner" }),
      true,
    );
    const after = service.summary();
    assert.equal(after.findings[0].state, "rejected");
    assert.deepEqual(after.direction.outstandingAcceptedFindings, []);
    catalog.close();
  });
});

test("a not-observed finding still blocks saturation until a human or the controller closes it", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()], freshReview: true });
    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000002", executionRef: "E1", findings: [], freshReview: true });
    service.bindRun({ runRef: "R00000003", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000003", executionRef: "E1", findings: [], freshReview: true });

    const summary = service.summary();
    assert.equal(summary.saturation.quietFreshReviews, 2);
    assert.equal(summary.saturation.saturated, false);
    assert.ok(
      summary.saturation.reasons.some((reason) =>
        reason.includes("neither resolved nor explicitly accepted")),
    );
    assert.equal(summary.findings[0].state, "accepted");
    catalog.close();
  });
});

test("a human merge folds two identities into one history and survives later rounds", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });

    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "X1",
      findings: [
        finding({ id: "f1", subject: "Cancellation guard" }),
        finding({ id: "f2", subject: "Cleanup is skipped on cancel" }),
      ],
    });

    const before = service.summary();
    assert.equal(before.findings.length, 2, "the two wordings were not tracked separately");
    const [first, second] = before.findings;

    const refusedSelf = service.mergeFindings({
      absorbedIdentity: first.identity,
      canonicalIdentity: first.identity,
      reason: "same",
      resolvedBy: "human",
    });
    assert.equal(refusedSelf.ok, false);

    const refusedBlank = service.mergeFindings({
      absorbedIdentity: second.identity,
      canonicalIdentity: first.identity,
      reason: "   ",
      resolvedBy: "human",
    });
    assert.equal(refusedBlank.ok, false);

    const merged = service.mergeFindings({
      absorbedIdentity: second.identity,
      canonicalIdentity: first.identity,
      reason: "Both describe the same skipped cleanup",
      resolvedBy: "human",
    });
    assert.equal(merged.ok, true);

    const afterMerge = service.summary();
    assert.equal(afterMerge.findings.length, 1, "the absorbed finding was left behind");
    assert.equal(afterMerge.findings[0].identity, first.identity);
    assert.equal(afterMerge.findings[0].occurrences, 2);
    assert.deepEqual(
      afterMerge.findingAliases.map((alias) => [alias.aliasIdentity, alias.canonicalIdentity]),
      [[second.identity, first.identity]],
    );

    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "X2",
      findings: [
        finding({ id: "f1", subject: "Cancellation guard" }),
        finding({ id: "f2", subject: "Cleanup is skipped on cancel" }),
      ],
    });

    const afterSecond = service.summary();
    assert.equal(
      afterSecond.findings.length,
      1,
      "a merged wording came back as a separate finding in a later round",
    );
    assert.deepEqual(
      afterSecond.direction.latestChange.newMaterial,
      [],
      "a merged wording was reported as new material",
    );
    catalog.close();
  });
});

test("merged findings survive restart and can be unmerged without resurrecting the absorbed row", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "X1",
      findings: [
        finding({ id: "f1", subject: "Cancellation guard" }),
        finding({ id: "f2", subject: "Cleanup is skipped on cancel" }),
      ],
    });
    const [first, second] = service.summary().findings;
    service.mergeFindings({
      absorbedIdentity: second.identity,
      canonicalIdentity: first.identity,
      reason: "Same defect",
      resolvedBy: "human",
    });
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    assert.equal(restored.summary().findingAliases.length, 1);

    const unknown = restored.unmergeFinding("FHNOTHING");
    assert.equal(unknown.ok, false);

    assert.equal(restored.unmergeFinding(second.identity).ok, true);
    const afterUnmerge = restored.summary();
    assert.deepEqual(afterUnmerge.findingAliases, []);
    assert.equal(
      afterUnmerge.findings.length,
      1,
      "unmerging resurrected a finding history that no longer exists",
    );
    reopened.close();
  });
});

test("an alias chain resolves to one canonical finding", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "X1",
      findings: [
        finding({ id: "f1", subject: "Wording one" }),
        finding({ id: "f2", subject: "Wording two" }),
        finding({ id: "f3", subject: "Wording three" }),
      ],
    });
    const [a, b, c] = service.summary().findings;
    assert.equal(
      service.mergeFindings({
        absorbedIdentity: b.identity,
        canonicalIdentity: a.identity,
        reason: "same",
        resolvedBy: "human",
      }).ok,
      true,
    );
    assert.equal(
      service.mergeFindings({
        absorbedIdentity: c.identity,
        canonicalIdentity: b.identity,
        reason: "same again",
        resolvedBy: "human",
      }).ok,
      true,
    );
    const summary = service.summary();
    assert.equal(summary.findings.length, 1);
    assert.equal(summary.findings[0].identity, a.identity);
    assert.deepEqual(
      summary.findingAliases.map((alias) => alias.canonicalIdentity),
      [a.identity, a.identity],
      "a chained merge was left pointing at an absorbed identity",
    );
    catalog.close();
  });
});

test("a pipeline-accepted finding becomes work to fix and only a fresh review verifies it", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "X1",
      findings: [finding()],
    });

    const identity = findingIdentity(finding());
    const accepted = service.summary();
    assert.equal(accepted.findings[0].fixState, "awaitingFix");
    assert.deepEqual(
      accepted.direction.outstandingAcceptedFindings.map((entry) => entry.identity),
      [identity],
      "a challenged pipeline finding disappeared instead of becoming work to fix",
    );
    assert.deepEqual(accepted.direction.findingsNeedingRuling, []);
    assert.equal(accepted.direction.nextAction.kind, "fixAcceptedFindings");
    assert.deepEqual(accepted.direction.nextAction.command, {
      type: "startScopedFix",
      identity,
    });
    assert.ok(
      accepted.saturation.reasons.some((reason) =>
        reason.includes("accepted findings have no verified fix")),
      "an unfixed accepted finding did not block saturation",
    );

    assert.equal(service.linkFixRun({ identity, runRef: "R00000002" }).ok, true);
    assert.equal(service.summary().findings[0].fixState, "fixRunning");
    assert.deepEqual(
      service.fixRuns().map((item) => [item.identity, item.runRef, item.state]),
      [[identity, "R00000002", "fixRunning"]],
    );

    assert.deepEqual(
      service.recordFixOutcome({ runRef: "R00000002", state: "fixApplied" }),
      [identity],
    );
    assert.equal(service.summary().findings[0].fixState, "fixApplied");
    assert.equal(
      service.summary().direction.outstandingAcceptedFindings.length,
      1,
      "an applied but unconfirmed fix was treated as finished",
    );

    service.bindRun({ runRef: "R00000003", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000003", executionRef: "X3", findings: [] });

    const verified = service.summary();
    assert.equal(verified.findings[0].fixState, "verified");
    assert.deepEqual(verified.direction.outstandingAcceptedFindings, []);
    assert.deepEqual(
      service.fixRuns().map((item) => item.state),
      ["verified"],
    );
    catalog.close();
  });
});

test("an applied fix stays unverified while the finding is still observed", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "X1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.linkFixRun({ identity, runRef: "R00000002" });
    service.recordFixOutcome({ runRef: "R00000002", state: "fixApplied" });

    service.bindRun({ runRef: "R00000003", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000003", executionRef: "X3", findings: [finding()] });

    const after = service.summary();
    assert.equal(
      after.findings[0].fixState,
      "fixApplied",
      "a still-observed finding was marked verified",
    );
    assert.equal(after.findings[0].state, "accepted");
    assert.equal(
      after.direction.outstandingAcceptedFindings.length,
      1,
      "a finding the fix did not remove stopped being work to fix",
    );
    catalog.close();
  });
});

test("unresolved and single-source findings block or stay provisional while routine accepted work can start", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "X1",
      findings: [
        finding({ id: "accepted", subject: "Accepted", location: { file: "src/a.ts", startLine: 1 } }),
        finding({ id: "unresolved", subject: "Unresolved", disposition: "unresolved", location: { file: "src/b.ts", startLine: 1 } }),
        finding({
          id: "single",
          subject: "Single source",
          location: { file: "src/c.ts", startLine: 1 },
          provenance: {
            source: "pipelineDecision",
            stepId: "single-review",
            participantIds: ["codex"],
            decisionStatus: "accepted",
          },
        }),
      ],
    });

    const initial = service.summary();
    const accepted = initial.findings.find((entry) => entry.subject === "Accepted");
    const unresolved = initial.findings.find((entry) => entry.subject === "Unresolved");
    const single = initial.findings.find((entry) => entry.subject === "Single source");
    assert.equal(accepted.actionable, true);
    assert.equal(unresolved.actionable, false);
    assert.equal(single.actionable, false);
    assert.deepEqual(
      initial.direction.findingsNeedingRuling.map((entry) => entry.identity),
      [unresolved.identity],
    );
    assert.equal(initial.direction.nextAction.kind, "ruleOnFindings");
    assert.match(initial.direction.nextAction.label, /unresolved finding/u);

    assert.equal(service.linkFixRun({ identity: accepted.identity, runRef: "R00000002" }).ok, true);
    assert.equal(service.linkFixRun({ identity: unresolved.identity, runRef: "R00000003" }).ok, false);
    assert.equal(service.linkFixRun({ identity: single.identity, runRef: "R00000004" }).ok, false);
    assert.deepEqual(
      service.recordFixOutcome({ runRef: "R00000002", state: "fixApplied" }),
      [accepted.identity],
    );

    assert.equal(
      service.resolve({
        target: "finding",
        id: accepted.identity,
        action: "reject",
        resolvedBy: "owner",
        reason: "Evidence was misread",
      }),
      true,
    );
    const rejected = service.summary().findings.find((entry) => entry.identity === accepted.identity);
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.actionable, false);
    assert.equal(rejected.fixState, "fixApplied", "semantic rejection silently deleted work state");
    assert.equal(service.fixRuns().some((run) => run.identity === accepted.identity), true);
    assert.equal(service.linkFixRun({ identity: accepted.identity, runRef: "R00000005" }).ok, false);

    assert.equal(
      service.resolve({
        target: "finding",
        id: accepted.identity,
        action: "reopen",
        resolvedBy: "owner",
        reason: "New controller evidence",
        materialEvidenceDelta: ["A reproducing check now exists"],
      }),
      true,
    );
    const reopened = service.summary().findings.find((entry) => entry.identity === accepted.identity);
    assert.equal(reopened.state, "reopened");
    assert.equal(reopened.actionable, false);
    assert.equal(reopened.fixState, "fixApplied");
    assert.equal(reopened.humanResolution, undefined);
    assert.equal(reopened.resolutionHistory.at(-1).action, "reject");
    catalog.close();
  });
});

const {
  contentDigest: digestOf,
  parsePorcelainEntries,
} = require("../dist/longitudinal/repositoryBaseline.js");

const candidate = (overrides = {}) => ({
  commit: "1111111111111111111111111111111111111111",
  branch: "main",
  dirty: false,
  worktreeDigest: digestOf([], new Map()),
  contentComplete: true,
  capturedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("editing an already-dirty file changes the candidate digest", () => {
  const entries = parsePorcelainEntries([" M src/a.ts", "?? new.txt", ""].join("\u0000"));
  assert.deepEqual(entries, [
    { status: " M", path: "src/a.ts" },
    { status: "??", path: "new.txt" },
  ]);

  const before = digestOf(entries, new Map([["src/a.ts", "aaa"], ["new.txt", "bbb"]]));
  const afterEdit = digestOf(entries, new Map([["src/a.ts", "ccc"], ["new.txt", "bbb"]]));
  assert.notEqual(
    before,
    afterEdit,
    "editing a file that was already dirty left the candidate digest unchanged",
  );
  assert.equal(
    before,
    digestOf([...entries].reverse(), new Map([["src/a.ts", "aaa"], ["new.txt", "bbb"]])),
    "the digest depended on porcelain ordering",
  );
});

test("a rebaseline invalidates the quiet rounds and checks of the previous candidate", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: candidate() });

    for (const runRef of ["R00000001", "R00000002"]) {
      service.bindRun({ runRef, cycleId: cycle.id, freshReview: true });
      service.recordRound({ runRef, executionRef: `E${runRef}`, findings: [] });
    }
    service.recordVerification({
      runRef: "R00000002",
      checks: [{ command: "npm test", status: "passed" }],
      expected: true,
      baseline: candidate(),
    });

    const before = service.summary({ currentBaseline: candidate() });
    assert.equal(before.saturation.quietFreshReviews, 2);
    assert.equal(before.saturation.saturated, true, "the cycle did not reach saturation first");

    const moved = candidate({ commit: "2222222222222222222222222222222222222222" });
    service.rebaseline(moved);

    const after = service.summary({ currentBaseline: moved });
    assert.equal(
      after.saturation.quietFreshReviews,
      0,
      "quiet rounds from the previous candidate still counted after a rebaseline",
    );
    assert.equal(after.saturation.saturated, false);
    assert.equal(
      after.direction.verification,
      undefined,
      "a check recorded against the previous candidate survived the rebaseline",
    );
    assert.equal(after.direction.nextAction.kind, "freshReview");
    catalog.close();
  });
});

test("a closed cycle takes no further runs, rounds, checks, or rebaseline", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: candidate() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    assert.notEqual(service.closeCycle("done"), undefined);

    assert.equal(service.closeCycle("again"), undefined, "a closed cycle closed twice");
    assert.equal(
      service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: true }),
      undefined,
      "a run was bound to a closed cycle",
    );
    assert.equal(service.rebaseline(candidate()), undefined);
    assert.equal(
      service.recordVerification({ runRef: "R00000001", checks: [], expected: true }),
      undefined,
      "a check was recorded against a closed cycle",
    );

    const roundsBefore = service.rounds(cycle.id).length;
    assert.equal(
      service.recordRound({ runRef: "R00000001", executionRef: "E2", findings: [finding()] }),
      undefined,
      "a round was recorded against a closed cycle",
    );
    assert.equal(service.rounds(cycle.id).length, roundsBefore);
    catalog.close();
  });
});

test("a fix outcome follows its own run, not whichever initiative is active", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    const first = service.defineInitiative({ title: "First", goal: "Goal one" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: candidate() });
    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = findingIdentity(finding());
    service.resolve({ target: "finding", id: identity, action: "accept", resolvedBy: "owner" });
    service.linkFixRun({ identity, runRef: "R00000002" });

    const second = service.createInitiative({ title: "Second", goal: "Goal two" });
    assert.equal(service.currentInitiative().id, second.id);

    assert.deepEqual(
      service.recordFixOutcome({ runRef: "R00000002", state: "fixApplied" }),
      [identity],
      "the applied fix was not attached to the run's own initiative",
    );

    service.switchInitiative(first.id);
    assert.equal(service.summary().findings[0].fixState, "fixApplied");
    assert.deepEqual(
      service.fixRuns().map((item) => item.state),
      ["fixApplied"],
    );
    catalog.close();
  });
});

test("merging carries the human acceptance, the furthest fix state, and the fix runs", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: candidate() });
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

    service.resolve({
      target: "finding",
      id: absorbed.identity,
      action: "accept",
      resolvedBy: "owner",
    });
    service.linkFixRun({ identity: absorbed.identity, runRef: "R00000002" });

    const merged = service.mergeFindings({
      absorbedIdentity: absorbed.identity,
      canonicalIdentity: canonical.identity,
      reason: "Same defect",
      resolvedBy: "owner",
    });
    assert.equal(merged.ok, true);

    const after = service.summary();
    assert.equal(after.findings.length, 1);
    assert.equal(
      after.findings[0].humanResolution?.action,
      "accept",
      "merging discarded the human acceptance",
    );
    assert.equal(
      after.findings[0].fixState,
      "fixRunning",
      "merging discarded the in-progress fix state",
    );
    assert.deepEqual(
      after.fixRuns.map((item) => [item.identity, item.runRef]),
      [[canonical.identity, "R00000002"]],
      "merging orphaned the fix run",
    );
    catalog.close();
  });
});

test("merging two findings you resolved differently is refused", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review", repositoryBaseline: candidate() });
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
    service.resolve({
      target: "finding",
      id: canonical.identity,
      action: "accept",
      resolvedBy: "owner",
    });
    service.resolve({
      target: "finding",
      id: absorbed.identity,
      action: "reject",
      resolvedBy: "owner",
      reason: "Not real",
    });

    const refused = service.mergeFindings({
      absorbedIdentity: absorbed.identity,
      canonicalIdentity: canonical.identity,
      reason: "Same defect",
      resolvedBy: "owner",
    });
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /resolve them the same way/u);
    assert.equal(service.summary().findings.length, 2, "a refused merge still absorbed a finding");
    catalog.close();
  });
});

test("accepted, fixed, then verified by a fresh review, saturation is no longer blocked", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });
    const identity = findingIdentity(finding());

    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "X1", findings: [finding()] });
    assert.ok(
      service.summary().saturation.reasons.some((reason) =>
        reason.includes("accepted findings have no verified fix")),
      "an unfixed accepted finding did not block saturation",
    );

    assert.equal(service.linkFixRun({ identity, runRef: "R00000002" }).ok, true);
    service.recordFixOutcome({ runRef: "R00000002", state: "fixApplied" });
    assert.equal(
      service.summary().findings[0].fixState,
      "fixApplied",
      "an applied fix was recorded as more than applied",
    );
    assert.ok(
      service.summary().saturation.reasons.length > 0,
      "an applied but unverified fix stopped blocking saturation",
    );

    // First quiet fresh review: no longer reports the finding, so it verifies and closes.
    service.bindRun({ runRef: "R00000003", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000003", executionRef: "X3", findings: [] });
    const verified = service.summary();
    assert.equal(verified.findings[0].fixState, "verified");
    assert.equal(
      verified.findings[0].state,
      "resolved",
      "a verified finding stayed semantically open and kept blocking saturation",
    );
    assert.ok(
      verified.findings[0].evidence.some((item) => /did not report this finding/u.test(item)),
      "the resolving evidence does not name the fresh review that supplied it",
    );
    assert.deepEqual(verified.direction.outstandingAcceptedFindings, []);
    assert.deepEqual(
      verified.saturation.reasons.filter((reason) =>
        reason.includes("accepted findings have no verified fix")),
      [],
      "a verified finding still counted as an unfixed accepted finding",
    );

    // Second quiet fresh review: two consecutive quiet rounds is the signal's condition.
    service.bindRun({ runRef: "R00000004", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000004", executionRef: "X4", findings: [] });
    const saturated = service.summary();
    assert.deepEqual(
      saturated.saturation.reasons,
      [],
      `saturation stayed blocked: ${saturated.saturation.reasons.join("; ")}`,
    );
    assert.equal(saturated.saturation.saturated, true);
    assert.equal(saturated.saturation.signalReached, true);
    catalog.close();
  });
});

test("a finding nobody fixed is unobserved, never verified by absence", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "review" });

    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000001", executionRef: "X1", findings: [finding()] });

    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: true });
    service.recordRound({ runRef: "R00000002", executionRef: "X2", findings: [] });

    const summary = service.summary();
    assert.notEqual(
      summary.findings[0].state,
      "resolved",
      "a finding nobody fixed was closed because one review did not repeat it",
    );
    assert.notEqual(summary.findings[0].fixState, "verified");
    catalog.close();
  });
});
