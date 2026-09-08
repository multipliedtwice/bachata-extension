const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStateCatalog } = require("../dist/state/catalog.js");
const {
  createLongitudinalService,
  repositoryIdentity,
} = require("../dist/longitudinal/service.js");
const {
  consensusRuledFindings,
  findingSetArtifactBody,
  findingSetContentDigest,
  latestFindingSetArtifact,
  produceFindingSetArtifact,
  supersedeArtifactAncestors,
} = require("../dist/longitudinal/artifacts.js");
const {
  decisionSourceFromDecisionArtifact,
  parseLongitudinalDecisionCandidate,
} = require("../dist/longitudinal/decisionCandidates.js");
const {
  decisionLogicalIdentity,
  decisionMaterialDigest,
} = require("../dist/longitudinal/lifecycle.js");
const { acceptedArtifacts, proposedArtifacts } = require("../dist/longitudinal/direction.js");

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
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-longitudinal-producers-"));
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

const startedService = (catalog) => {
  const service = serviceFor(catalog);
  service.defineInitiative({ title: "Initiative", goal: "Goal" });
  const cycle = service.startCycle({ type: "review" });
  service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: true });
  return { service, cycle };
};

const decisionCandidate = (overrides = {}) => ({
  subject: "Retry policy for cancelled runs",
  question: "Should a cancelled run retry automatically?",
  affectedScope: ["src/orchestrator"],
  evidence: ["Both participants read the cancel path and disagreed on intent"],
  options: [
    { id: "auto", summary: "Retry once automatically", tradeOffs: ["Hides flaky cancellation"] },
    { id: "manual", summary: "Never retry without a human", tradeOffs: ["More manual work"] },
  ],
  tradeOffs: ["An automatic retry hides the failure that caused the cancel"],
  ...overrides,
});

const decisionSource = (artifact) => decisionSourceFromDecisionArtifact(artifact).source;

const decisionArtifact = (candidate) => ({
  stepId: "decision-consensus",
  round: 1,
  policy: "unanimous",
  status: "accepted",
  candidateId: "DABC",
  candidateHash: "abc",
  candidate,
  participants: [{ agentId: "codex" }, { agentId: "claude" }],
  objections: [],
  unresolvedRisks: [],
});

test("only ruled consensus findings enter a finding-set artifact", () => {
  assert.deepEqual(
    consensusRuledFindings([
      finding({ id: "a" }),
      finding({ id: "b", disposition: "proposed" }),
      finding({
        id: "c",
        provenance: { source: "stepOutput", stepId: "review", participantIds: ["claude"] },
      }),
    ]).map((entry) => entry.id),
    ["a"],
  );
});

test("a finding set with no ruled consensus finding produces no artifact", () => {
  assert.equal(
    produceFindingSetArtifact({
      createId: () => "T00000001",
      initiativeId: "N1",
      cycleId: "Y1",
      runRef: "R1",
      recordedAt: "2026-01-01T00:00:00.000Z",
      title: "Ruled findings",
      findings: [finding({ disposition: "proposed" })],
    }),
    undefined,
    "an artifact was fabricated from claims no consensus ruled",
  );
});

test("an unchanged finding set produces no new revision", () => {
  const first = produceFindingSetArtifact({
    createId: () => "T00000001",
    initiativeId: "N1",
    cycleId: "Y1",
    runRef: "R1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    title: "Ruled findings",
    findings: [finding()],
  });
  assert.equal(first.artifact.revision, 1);
  assert.equal(first.artifact.state, "proposed");
  assert.equal(first.superseded, undefined);
  assert.equal(
    produceFindingSetArtifact({
      createId: () => "T00000002",
      initiativeId: "N1",
      cycleId: "Y1",
      runRef: "R2",
      recordedAt: "2026-01-01T00:01:00.000Z",
      title: "Ruled findings",
      findings: [finding()],
      previous: first.artifact,
    }),
    undefined,
  );
});

test("a changed finding set supersedes the previous revision", () => {
  const first = produceFindingSetArtifact({
    createId: () => "T00000001",
    initiativeId: "N1",
    cycleId: "Y1",
    runRef: "R1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    title: "Ruled findings",
    findings: [finding()],
  });
  const second = produceFindingSetArtifact({
    createId: () => "T00000002",
    initiativeId: "N1",
    cycleId: "Y1",
    runRef: "R2",
    recordedAt: "2026-01-01T00:01:00.000Z",
    title: "Ruled findings",
    findings: [finding(), finding({ id: "f2", subject: "Worktree leak", location: undefined })],
    previous: first.artifact,
  });
  assert.equal(second.artifact.revision, 2);
  assert.equal(second.artifact.supersedesId, "T00000001");
  assert.equal(second.superseded.state, "superseded");
  assert.equal(second.superseded.supersededById, "T00000002");
  assert.equal(latestFindingSetArtifact([second.superseded, second.artifact]).id, "T00000002");
  assert.deepEqual(findingSetArtifactBody([finding()]).split("\n"), [
    "accepted · Cancellation guard (src/a.ts:12)",
    "  message: Cancellation bypasses cleanup",
    "  evidence: Both participants traced the bypass",
    "  challenge: The finally block was inspected",
  ]);
});

test("a recorded round persists a proposed finding-set artifact that survives restart", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service, cycle } = startedService(catalog);
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const artifacts = catalog.longitudinal.listArtifacts("N00000001");
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].type, "findingSet");
    assert.equal(artifacts[0].state, "proposed");
    assert.deepEqual(artifacts[0].provenance.participantIds, ["codex", "claude"]);
    assert.equal(artifacts[0].provenance.runRef, "R00000001");
    assert.equal(artifacts[0].provenance.cycleId, cycle.id);
    assert.deepEqual(
      catalog.longitudinal.listCycles("N00000001")[0].outputArtifactIds,
      [artifacts[0].id],
    );
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    const state = restored.snapshot();
    assert.equal(state.artifacts.length, 1);
    assert.equal(
      state.artifacts[0].body.includes("  message: Cancellation bypasses cleanup"),
      true,
    );
    assert.deepEqual(proposedArtifacts(state.artifacts).map((item) => item.id), [artifacts[0].id]);
    assert.deepEqual(acceptedArtifacts(state.artifacts), []);
    reopened.close();
  });
});

test("replaying a terminal execution changes no artifact and no revision", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const before = catalog.longitudinal.listArtifacts("N00000001");
    assert.equal(
      service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] }),
      undefined,
    );
    assert.deepEqual(catalog.longitudinal.listArtifacts("N00000001"), before);
    catalog.close();
  });
});

test("accepting an artifact moves it out of the proposed list and into the cycle delta", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service, cycle } = startedService(catalog);
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const artifact = catalog.longitudinal.listArtifacts("N00000001")[0];
    assert.equal(
      service.resolve({
        target: "artifact",
        id: artifact.id,
        action: "accept",
        resolvedBy: "human",
      }),
      true,
    );
    const state = service.snapshot();
    assert.deepEqual(acceptedArtifacts(state.artifacts).map((item) => item.id), [artifact.id]);
    assert.deepEqual(proposedArtifacts(state.artifacts), []);
    assert.deepEqual(
      catalog.longitudinal.listCycles("N00000001")
        .find((item) => item.id === cycle.id).acceptedStateDelta.acceptedArtifactIds,
      [artifact.id],
    );
    assert.deepEqual(
      service.summary().direction.acceptedArtifacts.map((item) => item.id),
      [artifact.id],
    );
    catalog.close();
  });
});

test("an incomplete decision candidate is refused instead of being invented", () => {
  assert.equal(parseLongitudinalDecisionCandidate(undefined), undefined);
  assert.equal(
    parseLongitudinalDecisionCandidate({ ...decisionCandidate(), question: "  " }),
    undefined,
    "a decision without a real question was accepted",
  );
  assert.equal(
    parseLongitudinalDecisionCandidate({ ...decisionCandidate(), affectedScope: [] }),
    undefined,
    "a decision without an affected scope was accepted",
  );
  assert.equal(
    parseLongitudinalDecisionCandidate({ ...decisionCandidate(), evidence: [] }),
    undefined,
    "a decision without evidence was accepted",
  );
  assert.equal(
    parseLongitudinalDecisionCandidate({ ...decisionCandidate(), options: [{ id: "a" }] }),
    undefined,
    "an option without a summary was accepted",
  );
  const withoutOptions = parseLongitudinalDecisionCandidate({
    subject: "Retry policy",
    question: "Should a cancelled run retry?",
    affectedScope: ["src/orchestrator"],
    evidence: ["The cancel path was read"],
  });
  assert.deepEqual(withoutOptions.options, []);
  assert.deepEqual(withoutOptions.tradeOffs, []);
  assert.equal(withoutOptions.recommendation, undefined);
});

test("operational noise never becomes a decision", () => {
  assert.equal(
    decisionSourceFromDecisionArtifact({
      ...decisionArtifact({ findings: [] }),
    }).source,
    undefined,
    "a ruled finding set was read as a decision set",
  );
  assert.equal(
    decisionSourceFromDecisionArtifact({
      ...decisionArtifact({ decisions: [] }),
      unresolvedRisks: ["Provider timed out", "The evidence is incomplete"],
    }).source,
    undefined,
    "unresolved risk strings were promoted to decisions",
  );
  assert.equal(
    decisionSourceFromDecisionArtifact({
      ...decisionArtifact({ decisions: [decisionCandidate()] }),
      status: "pending",
    }).source,
    undefined,
    "an unaccepted decision artifact produced a decision",
  );
  const malformed = decisionSourceFromDecisionArtifact({
    ...decisionArtifact({ decisions: [{ subject: "Only a subject" }] }),
  });
  assert.equal(malformed.source, undefined, "a malformed decision candidate produced a decision");
  assert.ok(malformed.errors.length > 0, "a malformed candidate produced no validation evidence");
  const source = decisionSourceFromDecisionArtifact(
    decisionArtifact({ decisions: [decisionCandidate()] }),
  ).source;
  assert.deepEqual(source.participantIds, ["codex", "claude"]);
  assert.equal(source.stepId, "decision-consensus");
  assert.equal(source.candidates.length, 1);
});

test("a typed decision candidate becomes one durable decision the human still owns", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service, cycle } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      decisionSource: decisionSource(
        decisionArtifact({ decisions: [decisionCandidate()] }),
      ),
    });
    const decisions = catalog.longitudinal.listDecisions("N00000001");
    assert.equal(decisions.length, 1);
    const decision = decisions[0];
    assert.equal(
      decision.logicalId,
      decisionLogicalIdentity("Retry policy for cancelled runs", ["src/orchestrator"]),
    );
    assert.match(decision.id, /^D\d{8}$/u);
    assert.equal(decision.revision, 1);
    assert.equal(decision.occurrences, 1);
    assert.equal(decision.state, "proposed");
    assert.equal(decision.initiativeId, "N00000001");
    assert.equal(decision.cycleId, cycle.id);
    assert.equal(decision.question, "Should a cancelled run retry automatically?");
    assert.deepEqual(decision.affectedScope, ["src/orchestrator"]);
    assert.deepEqual(decision.options.map((option) => option.id), ["auto", "manual"]);
    assert.equal(decision.recommendation, undefined, "a recommendation was invented");
    assert.equal(decision.provenance.authoredBy, "model");
    assert.deepEqual(decision.provenance.participantIds, ["codex", "claude"]);
    assert.equal(decision.provenance.runRef, "R00000001");
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    assert.deepEqual(
      restored.summary().direction.decisionsNeedingHuman.map((item) => item.subject),
      ["Retry policy for cancelled runs"],
    );
    assert.equal(restored.summary().direction.nextAction.kind, "resolveDecisions");
    reopened.close();
  });
});

test("an exact repeat accumulates occurrence and provenance without reopening the decision", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      decisionSource: decisionSource(
        decisionArtifact({ decisions: [decisionCandidate()] }),
      ),
    });
    const id = catalog.longitudinal.listDecisions("N00000001")[0].id;
    service.resolve({ target: "decision", id, action: "accept", resolvedBy: "human" });
    service.bindRun({ runRef: "R00000002", freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [finding()],
      decisionSource: decisionSource(
        decisionArtifact({ decisions: [decisionCandidate()] }),
      ),
    });
    const decisions = catalog.longitudinal.listDecisions("N00000001");
    assert.equal(decisions.length, 1, "an exact repeat created a second decision row");
    assert.equal(decisions[0].id, id);
    assert.equal(decisions[0].state, "accepted");
    assert.equal(decisions[0].occurrences, 2);
    assert.equal(decisions[0].humanResolution.action, "accept");
    assert.deepEqual(service.summary().direction.decisionsNeedingHuman, []);
    catalog.close();
  });
});

test("a materially changed decision becomes an unapproved successor, never an approved rewrite", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      decisionSource: decisionSource(
        decisionArtifact({ decisions: [decisionCandidate()] }),
      ),
    });
    const first = catalog.longitudinal.listDecisions("N00000001")[0];
    service.resolve({ target: "decision", id: first.id, action: "accept", resolvedBy: "human" });
    service.bindRun({ runRef: "R00000002", freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [finding()],
      decisionSource: decisionSource(
        decisionArtifact({
          decisions: [decisionCandidate({
            question: "Should a cancelled run retry after the worktree is proven clean?",
            evidence: ["A reproducing test now exists"],
          })],
        }),
      ),
    });
    const decisions = catalog.longitudinal.listDecisions("N00000001");
    assert.equal(decisions.length, 2, "a material change did not create a successor");
    const retired = decisions.find((item) => item.id === first.id);
    const successor = decisions.find((item) => item.id !== first.id);
    assert.equal(retired.state, "superseded");
    assert.equal(retired.supersededById, successor.id);
    assert.equal(retired.humanResolution.action, "accept", "the earlier approval was rewritten");
    assert.equal(successor.state, "proposed");
    assert.equal(successor.revision, 2);
    assert.equal(successor.supersedesId, first.id);
    assert.equal(
      successor.humanResolution,
      undefined,
      "a materially changed decision inherited a human approval",
    );
    assert.equal(successor.materialEvidenceDelta.includes("question changed"), true);
    assert.equal(
      successor.materialEvidenceDelta.includes("new evidence: A reproducing test now exists"),
      true,
    );
    assert.deepEqual(
      service.summary().direction.decisionsNeedingHuman.map((item) => item.id),
      [successor.id],
    );
    assert.notEqual(
      decisionMaterialDigest(first),
      decisionMaterialDigest(successor),
      "the material digest did not change",
    );
    catalog.close();
  });
});

test("one subject in two scopes stays two decisions", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      decisionSource: decisionSource(
        decisionArtifact({
          decisions: [
            decisionCandidate(),
            decisionCandidate({ affectedScope: ["src/browser"] }),
          ],
        }),
      ),
    });
    const decisions = catalog.longitudinal.listDecisions("N00000001");
    assert.equal(decisions.length, 2, "two scopes of one subject collapsed into one decision");
    assert.notEqual(decisions[0].logicalId, decisions[1].logicalId);
    assert.deepEqual(
      decisions.map((item) => item.affectedScope).flat().sort(),
      ["src/browser", "src/orchestrator"],
    );
    catalog.close();
  });
});

test("a round records the decision changes it caused and rebuilds them after restart", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      decisionSource: decisionSource(
        decisionArtifact({ decisions: [decisionCandidate()] }),
      ),
    });
    const id = catalog.longitudinal.listDecisions("N00000001")[0].id;
    service.resolve({ target: "decision", id, action: "accept", resolvedBy: "human" });
    service.bindRun({ runRef: "R00000002", freshReview: true });
    const second = service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [finding()],
      decisionSource: decisionSource(
        decisionArtifact({ decisions: [decisionCandidate()] }),
      ),
    });
    assert.equal(second.stale, false);
    assert.deepEqual(
      second.comparison.decisionChanges,
      [],
      "an unchanged decision was reported as changed",
    );
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    assert.deepEqual(
      restored.summary().direction.latestChange.decisionChanges,
      [],
      "a retained decision was reported as changed after restart",
    );
    reopened.close();
  });
});

test("a human resolution from an earlier round is not attributed to a later round", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const identity = service.snapshot().findings[0].identity;
    service.resolve({
      target: "finding",
      id: identity,
      action: "supersede",
      resolvedBy: "human",
      supersededById: identity,
    });
    service.bindRun({ runRef: "R00000002", freshReview: true });
    service.recordRound({ runRef: "R00000002", executionRef: "E2", findings: [] });
    const rounds = service.rounds();
    assert.deepEqual(
      rounds.at(-1).identities.resolvedIdentities,
      [],
      "an earlier human resolution was attributed to a later round",
    );
    catalog.close();
  });
});

test("model output cannot revoke a human-accepted artifact", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const accepted = catalog.longitudinal.listArtifacts("N00000001")[0];
    service.resolve({
      target: "artifact",
      id: accepted.id,
      action: "accept",
      resolvedBy: "human",
    });
    service.bindRun({ runRef: "R00000002", freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [finding(), finding({ id: "f2", subject: "Worktree leak", location: undefined })],
    });
    const artifacts = catalog.longitudinal.listArtifacts("N00000001");
    assert.equal(artifacts.length, 2);
    const held = artifacts.find((item) => item.id === accepted.id);
    const proposal = artifacts.find((item) => item.id !== accepted.id);
    assert.equal(held.state, "accepted", "model output revoked a human-accepted artifact");
    assert.equal(held.supersededById, undefined);
    assert.equal(proposal.state, "proposed");
    assert.equal(proposal.supersedesId, accepted.id);
    assert.deepEqual(
      acceptedArtifacts(artifacts).map((item) => item.id),
      [accepted.id],
    );
    assert.deepEqual(
      proposedArtifacts(artifacts).map((item) => item.id),
      [proposal.id],
    );

    service.resolve({
      target: "artifact",
      id: proposal.id,
      action: "accept",
      resolvedBy: "human",
    });
    const after = catalog.longitudinal.listArtifacts("N00000001");
    assert.equal(after.find((item) => item.id === accepted.id).state, "superseded");
    assert.equal(after.find((item) => item.id === accepted.id).supersededById, proposal.id);
    assert.deepEqual(acceptedArtifacts(after).map((item) => item.id), [proposal.id]);
    catalog.close();
  });
});

test("a material finding change the summary line hides still produces a revision", () => {
  const first = produceFindingSetArtifact({
    createId: () => "T00000001",
    initiativeId: "N1",
    cycleId: "Y1",
    runRef: "R1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    title: "Ruled findings",
    findings: [finding()],
  });
  for (const changed of [
    finding({ message: "Cancellation bypasses cleanup on the retry path" }),
    finding({ severity: "error" }),
    finding({ location: { file: "src/a.ts", startLine: 40, endLine: 44 } }),
    finding({ evidence: ["A third participant reproduced it"] }),
    finding({ challenges: ["The retry path was inspected"] }),
  ]) {
    const next = produceFindingSetArtifact({
      createId: () => "T00000002",
      initiativeId: "N1",
      cycleId: "Y1",
      runRef: "R2",
      recordedAt: "2026-01-01T00:01:00.000Z",
      title: "Ruled findings",
      findings: [changed],
      previous: first.artifact,
    });
    assert.notEqual(next, undefined, `a material change produced no revision: ${changed.message}`);
    assert.equal(next.artifact.revision, 2);
  }
});

const recordDecision = (service, runRef, executionRef, candidates) => {
  service.bindRun({ runRef, freshReview: true });
  return service.recordRound({
    runRef,
    executionRef,
    findings: [finding()],
    decisionSource: decisionSource(decisionArtifact({ decisions: candidates })),
  });
};

test("re-observing a superseded decision never reuses a revision or overwrites a row", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    recordDecision(service, "R00000001", "E1", [decisionCandidate()]);
    const first = catalog.longitudinal.listDecisions("N00000001")[0];
    service.resolve({ target: "decision", id: first.id, action: "accept", resolvedBy: "human" });

    recordDecision(service, "R00000002", "E2", [
      decisionCandidate({ question: "Should a cancelled run retry after the worktree is clean?" }),
    ]);
    recordDecision(service, "R00000003", "E3", [decisionCandidate()]);

    const decisions = catalog.longitudinal.listDecisions("N00000001");
    assert.equal(decisions.length, 3, "a re-observation overwrote an earlier revision");
    assert.deepEqual(decisions.map((item) => item.revision).sort(), [1, 2, 3]);
    assert.equal(new Set(decisions.map((item) => item.id)).size, 3, "decision ids collided");
    const original = decisions.find((item) => item.id === first.id);
    assert.equal(original.revision, 1);
    assert.equal(original.humanResolution.action, "accept", "an approved row was overwritten");
    assert.equal(original.state, "superseded");
    assert.equal(original.supersededById, decisions.find((item) => item.revision === 2).id);
    const third = decisions.find((item) => item.revision === 3);
    assert.equal(third.state, "proposed");
    assert.equal(third.humanResolution, undefined);
    assert.equal(third.supersedesId, decisions.find((item) => item.revision === 2).id);
    assert.deepEqual(
      service.summary().direction.decisionsNeedingHuman.map((item) => item.id),
      [third.id],
    );
    catalog.close();
  });
});

test("a legacy decision row without a logical identity is superseded, not duplicated", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service, cycle } = startedService(catalog);
    const candidate = decisionCandidate();
    catalog.longitudinal.saveDecisions([{
      schemaVersion: 1,
      id: "DSLEGACY",
      initiativeId: "N00000001",
      cycleId: cycle.id,
      subject: candidate.subject,
      affectedScope: candidate.affectedScope,
      question: "An older question",
      options: [],
      tradeOffs: [],
      evidence: ["An older observation"],
      state: "accepted",
      provenance: { authoredBy: "model", participantIds: ["codex"] },
      materialEvidenceDelta: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }]);
    const legacy = catalog.longitudinal.listDecisions("N00000001")[0];
    assert.equal(
      legacy.logicalId,
      decisionLogicalIdentity(candidate.subject, candidate.affectedScope),
      "a legacy row kept its subject-only identity",
    );

    recordDecision(service, "R00000001", "E1", [candidate]);
    const decisions = catalog.longitudinal.listDecisions("N00000001");
    assert.equal(decisions.length, 2, "the legacy row was duplicated instead of superseded");
    const retired = decisions.find((item) => item.id === "DSLEGACY");
    const successor = decisions.find((item) => item.id !== "DSLEGACY");
    assert.equal(retired.state, "superseded");
    assert.equal(retired.supersededById, successor.id);
    assert.equal(successor.revision, 2);
    assert.equal(successor.supersedesId, "DSLEGACY");
    catalog.close();
  });
});

test("a scope change supersedes only when the workflow names its predecessor", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    recordDecision(service, "R00000001", "E1", [decisionCandidate()]);
    const first = catalog.longitudinal.listDecisions("N00000001")[0];

    recordDecision(service, "R00000002", "E2", [
      decisionCandidate({ affectedScope: ["src/browser"] }),
    ]);
    assert.equal(
      catalog.longitudinal.listDecisions("N00000001")
        .find((item) => item.id === first.id).state,
      "proposed",
      "an unrelated scope silently retired the earlier decision",
    );

    recordDecision(service, "R00000003", "E3", [
      decisionCandidate({
        affectedScope: ["src/orchestrator", "src/runtime"],
        supersedes: {
          subject: "Retry policy for cancelled runs",
          affectedScope: ["src/orchestrator"],
        },
      }),
    ]);
    const decisions = catalog.longitudinal.listDecisions("N00000001");
    const retired = decisions.find((item) => item.id === first.id);
    const successor = decisions.find((item) => item.supersedesId === first.id);
    assert.equal(retired.state, "superseded");
    assert.equal(retired.supersededById, successor.id);
    assert.equal(successor.state, "proposed");
    assert.deepEqual(successor.affectedScope, ["src/orchestrator", "src/runtime"]);
    assert.equal(successor.humanResolution, undefined);
    assert.equal(
      decisions.filter((item) => item.supersededById === undefined).length,
      2,
      "the unrelated scope decision was retired by the declared supersession",
    );
    catalog.close();
  });
});

test("conflicting duplicate decisions and duplicate option ids are refused whole", () => {
  const conflicting = decisionSourceFromDecisionArtifact(decisionArtifact({
    decisions: [
      decisionCandidate(),
      decisionCandidate({ question: "A different question about the same thing" }),
    ],
  }));
  assert.equal(
    conflicting.source,
    undefined,
    "two conflicting candidates for one logical decision were accepted",
  );
  assert.ok(conflicting.errors.some((item) => item.includes("conflicts")), conflicting.errors.join("; "));
  const collapsed = decisionSourceFromDecisionArtifact(decisionArtifact({
    decisions: [decisionCandidate(), decisionCandidate()],
  })).source;
  assert.equal(collapsed.candidates.length, 1, "an exact duplicate was stored twice");
  assert.equal(
    parseLongitudinalDecisionCandidate(decisionCandidate({
      options: [
        { id: "auto", summary: "Retry once", tradeOffs: [] },
        { id: "Auto", summary: "Retry twice", tradeOffs: [] },
      ],
    })),
    undefined,
    "duplicate option ids were accepted",
  );
});

test("artifact equality uses a canonical digest, not the rendered body", () => {
  const base = (findings) => produceFindingSetArtifact({
    createId: () => "T1",
    initiativeId: "N1",
    cycleId: "Y1",
    runRef: "R1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    title: "Ruled findings",
    findings,
  });
  const collidingLeft = finding({ message: "x\n  evidence: y", evidence: [] });
  const collidingRight = finding({ message: "x", evidence: ["y"] });
  assert.notEqual(
    findingSetContentDigest([collidingLeft]),
    findingSetContentDigest([collidingRight]),
    "label-shaped text inside a message collided with a separate evidence entry",
  );
  const first = base([collidingLeft]);
  const second = produceFindingSetArtifact({
    createId: () => "T2",
    initiativeId: "N1",
    cycleId: "Y1",
    runRef: "R2",
    recordedAt: "2026-01-01T00:01:00.000Z",
    title: "Ruled findings",
    findings: [collidingRight],
    previous: first.artifact,
  });
  assert.notEqual(second, undefined, "a material change produced no revision");
  assert.equal(second.artifact.revision, 2);

  const reordered = produceFindingSetArtifact({
    createId: () => "T3",
    initiativeId: "N1",
    cycleId: "Y1",
    runRef: "R3",
    recordedAt: "2026-01-01T00:02:00.000Z",
    title: "Ruled findings",
    findings: [{
      ...collidingRight,
      evidence: [...collidingRight.evidence].reverse(),
      challenges: [...collidingRight.challenges].reverse(),
    }],
    previous: second.artifact,
  });
  assert.equal(reordered, undefined, "reordering evidence produced a spurious revision");
});

test("a stored artifact keeps its digest across restart and replay", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const stored = catalog.longitudinal.listArtifacts("N00000001")[0];
    assert.equal(stored.contentDigest, findingSetContentDigest([finding()]));
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    assert.equal(restored.snapshot().artifacts[0].contentDigest, stored.contentDigest);
    restored.bindRun({ runRef: "R00000002", freshReview: true });
    restored.recordRound({ runRef: "R00000002", executionRef: "E2", findings: [finding()] });
    assert.equal(
      reopened.longitudinal.listArtifacts("N00000001").length,
      1,
      "an unchanged finding set produced a revision after restart",
    );
    reopened.close();
  });
});

test("a human-accepted artifact is retired when a later revision is accepted through the chain", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({ runRef: "R00000001", executionRef: "E1", findings: [finding()] });
    const first = catalog.longitudinal.listArtifacts("N00000001")[0];
    service.resolve({ target: "artifact", id: first.id, action: "accept", resolvedBy: "human" });

    service.bindRun({ runRef: "R00000002", freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [finding(), finding({ id: "f2", subject: "Worktree leak", location: undefined })],
    });
    service.bindRun({ runRef: "R00000003", freshReview: true });
    service.recordRound({
      runRef: "R00000003",
      executionRef: "E3",
      findings: [
        finding(),
        finding({ id: "f2", subject: "Worktree leak", location: undefined }),
        finding({ id: "f3", subject: "Retry storm", location: undefined }),
      ],
    });
    const before = catalog.longitudinal.listArtifacts("N00000001");
    assert.equal(before.length, 3, "the three revisions were not all recorded");
    const third = before.find((item) => item.revision === 3);
    assert.equal(before.find((item) => item.revision === 2).supersededById, third.id);

    service.resolve({ target: "artifact", id: third.id, action: "accept", resolvedBy: "human" });
    const after = catalog.longitudinal.listArtifacts("N00000001");
    assert.deepEqual(
      acceptedArtifacts(after).map((item) => item.revision),
      [3],
      "an earlier accepted revision stayed current beside the newly accepted one",
    );
    assert.equal(after.find((item) => item.id === first.id).state, "superseded");
    assert.equal(after.find((item) => item.id === first.id).supersededById, third.id);
    assert.equal(
      after.filter((item) => item.supersededById === undefined).length,
      1,
      "more than one finding-set revision remained current",
    );
    catalog.close();
  });
});

test("a material change after any human closure reopens the finding and the round is not quiet", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      freshReview: true,
    });
    const identity = service.snapshot().findings[0].identity;
    assert.equal(
      service.resolve({ target: "finding", id: identity, action: "reject", resolvedBy: "human" }),
      true,
    );
    assert.equal(service.summary().saturation.saturated, false);

    service.bindRun({ runRef: "R00000002", freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [finding({ evidence: ["A reproducing test now exists"] })],
      freshReview: true,
    });
    const entry = service.snapshot().findings[0];
    assert.equal(entry.state, "reopened", "a materially changed rejected finding stayed closed");
    assert.equal(entry.humanResolution, undefined, "the stale rejection stayed attached");
    assert.equal(entry.resolutionHistory.length, 1, "the prior rejection was lost");
    assert.equal(entry.resolutionHistory[0].action, "reject");
    const round = service.rounds().at(-1);
    assert.ok(round.materialChangeCount > 0, "a material change was recorded as no change");
    const summary = service.summary();
    assert.equal(summary.saturation.saturated, false, "a reopened finding was counted as quiet");
    assert.ok(
      summary.saturation.reasons.some((reason) => reason.includes("neither resolved nor")),
      summary.saturation.reasons.join("; "),
    );
    catalog.close();
  });
});

test("a lifecycle action that the record's state does not allow is refused", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      decisionSource: decisionSource(decisionArtifact({ decisions: [decisionCandidate()] })),
    });
    const decision = catalog.longitudinal.listDecisions("N00000001")[0];
    assert.equal(decision.state, "proposed");
    assert.equal(
      service.resolve({
        target: "decision",
        id: decision.id,
        action: "reopen",
        resolvedBy: "human",
        reason: "I changed my mind",
        materialEvidenceDelta: ["A new failure mode"],
      }),
      false,
      "a proposed decision accepted a reopen",
    );
    assert.deepEqual(
      service.summary().direction.decisionsNeedingHuman.map((item) => item.id),
      [decision.id],
      "the decision disappeared from the human queue",
    );

    assert.equal(
      service.resolve({ target: "decision", id: decision.id, action: "defer", resolvedBy: "human" }),
      true,
    );
    assert.deepEqual(
      service.summary().direction.decisionsNeedingHuman.map((item) => item.id),
      [decision.id],
      "a deferred decision stopped being visible",
    );

    const matrix = service.summary().resolutionMatrix;
    assert.deepEqual(matrix.decision.superseded, []);
    assert.equal(matrix.decision.proposed.includes("reopen"), false);
    assert.equal(matrix.finding.resolved.includes("accept"), false);
    catalog.close();
  });
});

test("a partly invalid decision set is refused whole and its validation evidence is durable", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    const parsed = decisionSourceFromDecisionArtifact(decisionArtifact({
      decisions: [decisionCandidate(), { subject: "Only a subject" }],
    }));
    assert.equal(parsed.source, undefined, "a partly invalid decision set was silently trimmed");
    assert.ok(parsed.errors.length > 0);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      validationErrors: parsed.errors,
    });
    assert.deepEqual(catalog.longitudinal.listDecisions("N00000001"), []);
    assert.deepEqual(service.summary().validationErrors, parsed.errors);
    catalog.close();

    const reopened = createStateCatalog(root);
    assert.deepEqual(serviceFor(reopened).summary().validationErrors, parsed.errors);
    reopened.close();
  });
});

test("an unknown predecessor is refused with visible evidence instead of being ignored", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      decisionSource: decisionSource(decisionArtifact({
        decisions: [decisionCandidate({
          affectedScope: ["src/runtime"],
          supersedes: { subject: "Nothing recorded", affectedScope: ["src/nowhere"] },
        })],
      })),
    });
    assert.deepEqual(catalog.longitudinal.listDecisions("N00000001"), []);
    const errors = service.summary().validationErrors;
    assert.ok(
      errors.some((item) => item.includes("not a current decision")),
      errors.join("; "),
    );
    catalog.close();
  });
});

test("a finding resolution records the resolved identity in the cycle delta", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service, cycle } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding(), finding({ id: "f2", subject: "Worktree leak", location: undefined })],
    });
    const [first, second] = service.snapshot().findings.map((entry) => entry.identity);
    assert.equal(
      service.resolve({
        target: "finding",
        id: first,
        action: "supersede",
        resolvedBy: "human",
        supersededById: second,
      }),
      true,
    );
    const stored = catalog.longitudinal.listCycles("N00000001").find((item) => item.id === cycle.id);
    assert.deepEqual(
      stored.acceptedStateDelta.resolvedFindingIdentities,
      [first],
      "a resolved finding was never recorded in the cycle delta",
    );
    const entry = service.snapshot().findings.find((item) => item.identity === first);
    assert.equal(entry.state, "resolved");
    assert.equal(entry.humanResolution.action, "supersede");

    assert.equal(
      service.resolve({ target: "finding", id: first, action: "accept", resolvedBy: "human" }),
      false,
      "a resolved finding accepted an accept",
    );
    assert.equal(
      service.resolve({
        target: "finding",
        id: first,
        action: "reopen",
        resolvedBy: "human",
        reason: "It came back",
        materialEvidenceDelta: ["A reproducing test"],
      }),
      true,
    );
    const reopened = service.snapshot().findings.find((item) => item.identity === first);
    assert.equal(reopened.humanResolution, undefined, "reopen kept the stale resolution");
    assert.equal(reopened.resolutionHistory.length, 1, "reopen discarded the resolution history");
    assert.equal(reopened.resolutionHistory[0].action, "supersede");
    catalog.close();
  });
});

test("a round carrying validation errors never advances saturation", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    const invalid = decisionSourceFromDecisionArtifact(decisionArtifact({
      decisions: [{ subject: "Only a subject" }],
    }));
    assert.ok(invalid.errors.length > 0);

    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [],
      validationErrors: invalid.errors,
      freshReview: true,
    });
    assert.equal(service.summary().saturation.quietFreshReviews, 0);
    service.bindRun({ runRef: "R00000002", freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [],
      validationErrors: invalid.errors,
      freshReview: true,
    });
    const afterInvalid = service.summary();
    assert.equal(
      afterInvalid.saturation.quietFreshReviews,
      0,
      "two malformed fresh rounds advanced the quiet count",
    );
    assert.equal(afterInvalid.saturation.saturated, false);

    service.bindRun({ runRef: "R00000003", freshReview: true });
    service.recordRound({
      runRef: "R00000003",
      executionRef: "E3",
      findings: [],
      freshReview: true,
    });
    assert.equal(
      service.summary().saturation.quietFreshReviews,
      1,
      "quiet counting did not restart from the first valid round",
    );
    catalog.close();

    const reopened = createStateCatalog(root);
    assert.equal(serviceFor(reopened).summary().saturation.quietFreshReviews, 1);
    reopened.close();
  });
});

const observe = (entry, overrides) => {
  const { mergeFindingIntoHistory } = require("../dist/longitudinal/lifecycle.js");
  return mergeFindingIntoHistory({
    entry,
    finding: finding(overrides),
    cycleId: "Y1",
    recordedAt: "2026-01-02T00:00:00.000Z",
  });
};

const seedEntry = (overrides = {}) => {
  const { newFindingHistoryEntry } = require("../dist/longitudinal/lifecycle.js");
  return newFindingHistoryEntry({
    initiativeId: "N1",
    cycleId: "Y1",
    recordedAt: "2026-01-01T00:00:00.000Z",
    finding: finding(overrides),
  });
};

test("material change compares against the previous observation, not cumulative history", () => {
  const seeded = seedEntry();
  assert.deepEqual(seeded.latestObservation.evidence, ["Both participants traced the bypass"]);

  const withdrawn = observe(seeded, { evidence: [] });
  assert.deepEqual(withdrawn.materialDelta, [
    "withdrawn evidence: Both participants traced the bypass",
  ]);
  const repeatedWithdrawal = observe(withdrawn, { evidence: [] });
  assert.deepEqual(
    repeatedWithdrawal.materialDelta,
    [],
    "a withdrawal was reported again on an identical later observation",
  );
  const restored = observe(repeatedWithdrawal, {});
  assert.deepEqual(restored.materialDelta, ["Both participants traced the bypass"]);
  assert.deepEqual(
    observe(restored, {}).materialDelta,
    [],
    "re-adding evidence stayed material after it was recorded",
  );
});

test("challenge, severity, and location changes are each material exactly once", () => {
  const seeded = seedEntry({ severity: "warning" });
  const withoutChallenge = observe(seeded, { severity: "warning", challenges: [] });
  assert.deepEqual(withoutChallenge.materialDelta, [
    "withdrawn challenge: The finally block was inspected",
  ]);
  assert.deepEqual(observe(withoutChallenge, { severity: "warning", challenges: [] }).materialDelta, []);

  const escalated = observe(withoutChallenge, { severity: "error", challenges: [] });
  assert.deepEqual(escalated.materialDelta, ["severity: error"]);
  assert.deepEqual(observe(escalated, { severity: "error", challenges: [] }).materialDelta, []);

  const dropped = observe(escalated, { severity: undefined, challenges: [] });
  assert.deepEqual(dropped.materialDelta, ["severity: none"]);
  assert.deepEqual(observe(dropped, { severity: undefined, challenges: [] }).materialDelta, []);

  const moved = observe(dropped, {
    severity: undefined,
    challenges: [],
    location: { file: "src/a.ts", startLine: 40, endLine: 44 },
  });
  assert.deepEqual(moved.materialDelta, ["location: src/a.ts:40-44"]);
  assert.deepEqual(
    observe(moved, {
      severity: undefined,
      challenges: [],
      location: { file: "src/a.ts", startLine: 40, endLine: 44 },
    }).materialDelta,
    [],
  );

  const unlocated = observe(moved, { severity: undefined, challenges: [], location: undefined });
  assert.deepEqual(unlocated.materialDelta, ["location: none"]);
  assert.deepEqual(
    observe(unlocated, { severity: undefined, challenges: [], location: undefined }).materialDelta,
    [],
    "a removed location was reported on every later observation",
  );
});

test("a rejected finding reopens once and does not reopen again from stale history", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding()],
      freshReview: true,
    });
    const identity = service.snapshot().findings[0].identity;
    service.resolve({ target: "finding", id: identity, action: "reject", resolvedBy: "human" });

    service.bindRun({ runRef: "R00000002", freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [finding({ evidence: ["A reproducing test now exists"] })],
      freshReview: true,
    });
    assert.equal(service.snapshot().findings[0].state, "reopened");
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    assert.deepEqual(
      restored.snapshot().findings[0].latestObservation.evidence,
      ["A reproducing test now exists"],
      "the observation baseline did not survive restart",
    );
    restored.bindRun({ runRef: "R00000003", freshReview: true });
    restored.recordRound({
      runRef: "R00000003",
      executionRef: "E3",
      findings: [finding({ evidence: ["A reproducing test now exists"] })],
      freshReview: true,
    });
    assert.deepEqual(
      restored.snapshot().findings[0].materialDelta,
      [],
      "an identical later observation was material again",
    );
    assert.equal(
      restored.rounds().find((round) => round.executionRef === "E3").materialChangeCount,
      0,
    );
    reopened.close();
  });
});

test("accepting one artifact chain leaves an independent chain untouched", () => {
  const plan = (id, revision, supersedesId) => ({
    schemaVersion: 1,
    id,
    initiativeId: "N1",
    cycleId: "Y1",
    type: "plan",
    title: `Plan ${id}`,
    body: id,
    revision,
    state: "proposed",
    provenance: { authoredBy: "model", participantIds: ["codex"] },
    evidence: [],
    resolutionHistory: [],
    ...(supersedesId === undefined ? {} : { supersedesId }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const a1 = plan("A1", 1);
  const a2 = plan("A2", 2, "A1");
  const b1 = plan("B1", 1);
  const retired = supersedeArtifactAncestors([a1, a2, b1], a2, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(
    retired.map((item) => item.id),
    ["A1"],
    "an independent artifact chain was retired",
  );

  const a3 = plan("A3", 3, "A2");
  const supersededA2 = { ...a2, state: "superseded", supersededById: "A3" };
  assert.deepEqual(
    supersedeArtifactAncestors([a1, supersededA2, a3, b1], a3, "2026-03-01T00:00:00.000Z")
      .map((item) => item.id),
    ["A1"],
    "the walk stopped at an already-superseded intermediate",
  );

  const cyclic = { ...plan("C1", 1, "C2"), id: "C1" };
  const cyclicPeer = { ...plan("C2", 2, "C1"), id: "C2" };
  assert.deepEqual(
    supersedeArtifactAncestors([cyclic, cyclicPeer], cyclicPeer, "2026-04-01T00:00:00.000Z")
      .map((item) => item.id),
    ["C1"],
    "a cyclic predecessor reference did not terminate safely",
  );
  assert.deepEqual(
    supersedeArtifactAncestors([a2], a2, "2026-05-01T00:00:00.000Z"),
    [],
    "a missing predecessor did not terminate safely",
  );
});

test("longitudinal mutation is refused after an adoption failure", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const legacyId = repositoryIdentity("/work/legacy");
    const legacy = createLongitudinalService({
      store: catalog.longitudinal,
      repositoryRoot: "/work/legacy",
      now: clock(),
      createId: idFactory(),
    });
    legacy.defineInitiative({ title: "Legacy initiative", goal: "Legacy goal" });
    const cycle = legacy.startCycle({ type: "review" });

    let failNext = true;
    const failingStore = {
      ...catalog.longitudinal,
      saveInitiative: (initiative) => {
        if (failNext) {
          failNext = false;
          throw new Error("Simulated adoption write failure");
        }
        catalog.longitudinal.saveInitiative(initiative);
      },
    };
    const failures = [];
    const adopting = createLongitudinalService({
      store: failingStore,
      repositoryRoot: "/work/canonical",
      ownershipPath: "/work/canonical/.git",
      legacyRepositoryIds: [legacyId],
      onAdoptionFailure: (error) => failures.push(error),
      now: clock(),
      createId: idFactory(),
    });

    assert.equal(
      adopting.currentInitiative().title,
      "Legacy initiative",
      "a read stopped surfacing the legacy initiative",
    );
    assert.equal(failures.length, 1);

    const before = JSON.stringify(catalog.longitudinal.snapshot("N00000001"));
    const mutations = [
      () => adopting.setDirection("Guard the cleanup path"),
      () => adopting.defineInitiative({ title: "Renamed", goal: "Renamed goal" }),
      () => adopting.startCycle({ type: "planning" }),
      () => adopting.bindRun({ runRef: "R00000009", freshReview: true }),
      () => adopting.closeCycle("done"),
      () => adopting.recordRound({ runRef: "R00000009", executionRef: "E9", findings: [finding()] }),
      () => adopting.saveDecisions([]),
      () => adopting.saveArtifacts([]),
      () => adopting.resolve({ target: "finding", id: "FH1", action: "accept", resolvedBy: "human" }),
    ];
    mutations.forEach((mutation, index) => {
      assert.throws(mutation, /could not be re-bound/u, `mutation ${String(index)} was not refused`);
    });
    assert.equal(
      JSON.stringify(catalog.longitudinal.snapshot("N00000001")),
      before,
      "a refused mutation still wrote",
    );
    assert.equal(catalog.longitudinal.listCycles("N00000001").length, 1);
    assert.equal(catalog.longitudinal.listCycles("N00000001")[0].id, cycle.id);
    catalog.close();
  });
});

test("a successful adoption permits normal mutation", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const legacyId = repositoryIdentity("/work/legacy");
    const legacy = createLongitudinalService({
      store: catalog.longitudinal,
      repositoryRoot: "/work/legacy",
      now: clock(),
      createId: idFactory(),
    });
    legacy.defineInitiative({ title: "Legacy initiative", goal: "Legacy goal" });
    const adopting = createLongitudinalService({
      store: catalog.longitudinal,
      repositoryRoot: "/work/canonical",
      ownershipPath: "/work/canonical/.git",
      legacyRepositoryIds: [legacyId],
      now: clock(),
      createId: idFactory(),
    });
    assert.equal(adopting.setDirection("Guard the cleanup path").currentDirection, "Guard the cleanup path");
    assert.equal(adopting.currentInitiative().title, "Legacy initiative");
    catalog.close();
  });
});

test("a removed severity or location is cleared from the finding projection", async () => {
  const { mergeFindingIntoHistory } = require("../dist/longitudinal/lifecycle.js");
  const seededEntry = seedEntry({ severity: "error", location: { file: "src/a.ts", startLine: 1 } });
  const stripped = mergeFindingIntoHistory({
    entry: seededEntry,
    finding: finding({ severity: undefined, location: undefined }),
    cycleId: "Y1",
    recordedAt: "2026-01-02T00:00:00.000Z",
  });
  assert.equal(stripped.severity, undefined, "a removed severity survived in the projection");
  assert.equal(stripped.location, undefined, "a removed location survived in the projection");
  assert.deepEqual(stripped.materialDelta, ["severity: none", "location: none"]);
  const persisted = JSON.parse(JSON.stringify(stripped));
  assert.equal("severity" in persisted, false, "the cleared severity was persisted as a key");
  assert.equal("location" in persisted, false, "the cleared location was persisted as a key");

  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service } = startedService(catalog);
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [finding({ severity: "error", location: { file: "src/a.ts", startLine: 12, endLine: 12 } })],
    });
    const seeded = service.snapshot().findings[0];
    assert.equal(seeded.severity, "error");
    assert.deepEqual(seeded.location, { file: "src/a.ts", startLine: 12, endLine: 12 });

    service.bindRun({ runRef: "R00000002", freshReview: true });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [finding({ severity: undefined, location: { file: "src/a.ts" } })],
    });
    const cleared = service.snapshot().findings[0];
    assert.equal(cleared.severity, undefined, "a removed severity survived a recorded round");
    assert.deepEqual(
      cleared.location,
      { file: "src/a.ts" },
      "a removed line range survived a recorded round",
    );
    assert.deepEqual(cleared.materialDelta, ["severity: none", "location: src/a.ts:0-0"]);
    const surfaced = service.summary().direction.outstandingAcceptedFindings[0];
    assert.equal(surfaced.severity, undefined, "the Direction view still carried the old severity");
    assert.deepEqual(
      surfaced.location,
      { file: "src/a.ts" },
      "the Direction view still carried the removed line range",
    );
    catalog.close();

    const reopened = createStateCatalog(root);
    const restored = serviceFor(reopened);
    const afterRestart = restored.snapshot().findings[0];
    assert.equal(afterRestart.severity, undefined, "the cleared severity came back after restart");
    assert.deepEqual(afterRestart.location, { file: "src/a.ts" });

    restored.bindRun({ runRef: "R00000003", freshReview: true });
    restored.recordRound({
      runRef: "R00000003",
      executionRef: "E3",
      findings: [finding({ severity: "warning", location: { file: "src/a.ts", startLine: 5, endLine: 5 } })],
    });
    const readded = restored.snapshot().findings[0];
    assert.equal(readded.severity, "warning");
    assert.deepEqual(readded.location, { file: "src/a.ts", startLine: 5, endLine: 5 });
    assert.deepEqual(readded.materialDelta, ["severity: warning", "location: src/a.ts:5-5"]);

    restored.bindRun({ runRef: "R00000004", freshReview: true });
    restored.recordRound({
      runRef: "R00000004",
      executionRef: "E4",
      findings: [finding({ severity: "warning", location: { file: "src/a.ts", startLine: 5, endLine: 5 } })],
    });
    assert.deepEqual(
      restored.snapshot().findings[0].materialDelta,
      [],
      "re-adding a field stayed material on the next identical observation",
    );
    reopened.close();
  });
});

test("a run binding and its cycle membership commit or fail together", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const { service, cycle } = startedService(catalog);
    assert.deepEqual(
      catalog.longitudinal.listCycles("N00000001")[0].runRefs,
      ["R00000001"],
      "the seeded binding did not publish its cycle membership",
    );
    assert.equal(catalog.longitudinal.runBinding("R00000001").cycleId, cycle.id);

    let failCycleWrite = false;
    const failingStore = {
      ...catalog.longitudinal,
      commitRunBinding: (input) => {
        if (failCycleWrite) throw new Error("Simulated cycle publication failure");
        catalog.longitudinal.commitRunBinding(input);
      },
    };
    const guarded = createLongitudinalService({
      store: failingStore,
      repositoryRoot: REPOSITORY_ROOT,
      now: clock(),
      createId: idFactory(),
    });
    failCycleWrite = true;
    assert.throws(
      () => guarded.bindRun({ runRef: "R00000099", freshReview: true }),
      /Simulated cycle publication failure/u,
    );
    assert.equal(
      catalog.longitudinal.runBinding("R00000099"),
      undefined,
      "a ghost binding survived a failed cycle publication",
    );
    assert.deepEqual(catalog.longitudinal.listCycles("N00000001")[0].runRefs, ["R00000001"]);

    const generic = service.bindRun({ runRef: "R00000002", freshReview: false });
    assert.deepEqual(generic.runRefs, ["R00000001", "R00000002"]);
    assert.equal(catalog.longitudinal.runBinding("R00000002").freshReview, false);

    const fresh = service.bindRun({ runRef: "R00000002", freshReview: true });
    assert.equal(
      catalog.longitudinal.runBinding("R00000002").freshReview,
      true,
      "a fresh-review binding did not override the earlier generic binding",
    );
    assert.deepEqual(
      fresh.runRefs,
      ["R00000001", "R00000002"],
      "a repeated binding duplicated the run reference",
    );
    assert.deepEqual(catalog.longitudinal.listCycles("N00000001")[0].runRefs, [
      "R00000001",
      "R00000002",
    ]);
    catalog.close();

    const reopened = createStateCatalog(root);
    assert.equal(reopened.longitudinal.runBinding("R00000002").cycleId, cycle.id);
    assert.deepEqual(reopened.longitudinal.listCycles("N00000001")[0].runRefs, [
      "R00000001",
      "R00000002",
    ]);
    reopened.close();
  });
});

const {
  planArtifactBody,
  planContentDigest,
  planSourceFromDecisionArtifact,
  validateInitiativePlanCandidate,
} = require("../dist/longitudinal/planCandidates.js");

const planCandidate = (overrides = {}) => ({
  title: "Guard the cancel path",
  summary: "Add a finally block and prove it runs",
  scope: ["src/orchestrator"],
  steps: [
    { id: "1", intent: "Add the finally block", files: ["src/orchestrator/run.ts"], verification: "npm test" },
    { id: "2", intent: "Cover the cancel path", files: ["tests/run.test.cjs"] },
  ],
  risks: ["The cancel path has no reproduction"],
  acceptanceCriteria: ["No leaked worktree after cancel"],
  evidence: ["Both participants traced the bypass"],
  ...overrides,
});

const planArtifactPayload = (candidate) => ({
  stepId: "plan-consensus",
  status: "accepted",
  participants: [{ agentId: "codex" }, { agentId: "claude" }],
  candidate,
});

test("a malformed plan candidate is rejected instead of stored", () => {
  assert.deepEqual(planSourceFromDecisionArtifact(undefined).errors, []);
  assert.equal(planSourceFromDecisionArtifact(planArtifactPayload(planCandidate())).source.stepId, "plan-consensus");

  const noSteps = validateInitiativePlanCandidate(planCandidate({ steps: [] }));
  assert.equal(noSteps.plan, undefined);
  assert.ok(noSteps.errors.includes("The plan has no steps"));

  const duplicate = validateInitiativePlanCandidate(planCandidate({
    steps: [
      { id: "1", intent: "one" },
      { id: "1", intent: "two" },
    ],
  }));
  assert.equal(duplicate.plan, undefined);
  assert.ok(duplicate.errors.some((error) => error.includes("repeats the step id")));

  const malformedScope = validateInitiativePlanCandidate(planCandidate({ scope: [""] }));
  assert.equal(malformedScope.plan, undefined);

  const rejected = planSourceFromDecisionArtifact(
    planArtifactPayload(planCandidate({ title: "   " })),
  );
  assert.equal(rejected.source, undefined);
  assert.ok(rejected.errors.length > 0);
});

test("a converged plan becomes a typed plan artifact that supersedes its predecessor", async () => {
  await withCatalog(async (root) => {
    const catalog = createStateCatalog(root);
    const service = serviceFor(catalog);
    service.defineInitiative({ title: "Initiative", goal: "Goal" });
    const cycle = service.startCycle({ type: "planning" });

    service.bindRun({ runRef: "R00000001", cycleId: cycle.id, freshReview: false });
    service.recordRound({
      runRef: "R00000001",
      executionRef: "E1",
      findings: [],
      planSource: planSourceFromDecisionArtifact(planArtifactPayload(planCandidate())).source,
    });

    const first = service.summary();
    const plans = first.artifacts.filter((artifact) => artifact.type === "plan");
    assert.equal(plans.length, 1, "a converged plan produced no typed artifact");
    assert.equal(plans[0].title, "Guard the cancel path");
    assert.equal(plans[0].state, "proposed");
    assert.equal(plans[0].revision, 1);
    assert.ok(plans[0].body.includes("1. Add the finally block"));
    assert.ok(plans[0].body.includes("files: src/orchestrator/run.ts"));
    assert.deepEqual(plans[0].evidence, ["Both participants traced the bypass"]);
    assert.ok(
      first.currentCycle.outputArtifactIds.includes(plans[0].id),
      "the cycle did not record the plan as its output",
    );

    service.bindRun({ runRef: "R00000002", cycleId: cycle.id, freshReview: false });
    service.recordRound({
      runRef: "R00000002",
      executionRef: "E2",
      findings: [],
      planSource: planSourceFromDecisionArtifact(planArtifactPayload(planCandidate())).source,
    });
    assert.equal(
      service.summary().artifacts.filter((artifact) => artifact.type === "plan").length,
      1,
      "an unchanged plan produced a second revision",
    );

    service.bindRun({ runRef: "R00000003", cycleId: cycle.id, freshReview: false });
    service.recordRound({
      runRef: "R00000003",
      executionRef: "E3",
      findings: [],
      planSource: planSourceFromDecisionArtifact(planArtifactPayload(planCandidate({
        steps: [{ id: "1", intent: "Add the finally block and a guard" }],
      }))).source,
    });

    const revised = service.summary().artifacts.filter((artifact) => artifact.type === "plan");
    assert.equal(revised.length, 2);
    const current = revised.find((artifact) => artifact.supersededById === undefined);
    const retired = revised.find((artifact) => artifact.supersededById !== undefined);
    assert.equal(current.revision, 2);
    assert.equal(retired.state, "superseded");
    assert.equal(retired.supersededById, current.id);
    catalog.close();
  });
});

test("a plan digest ignores ordering but not intent", () => {
  assert.equal(
    planContentDigest(planCandidate({ risks: ["a", "b"] })),
    planContentDigest(planCandidate({ risks: ["b", "a"] })),
  );
  assert.notEqual(
    planContentDigest(planCandidate()),
    planContentDigest(planCandidate({ summary: "Something else entirely" })),
  );
  assert.ok(planArtifactBody(planCandidate()).includes("verification: npm test"));
});

const { produceDeclaredArtifact } = require("../dist/longitudinal/artifacts.js");

const promotionInput = (promotion, output, previous) => ({
  createId: () => "A1",
  initiativeId: "I1",
  cycleId: "Y1",
  runRef: "run-1",
  recordedAt: "2026-01-01T00:00:00.000Z",
  promotion,
  output,
  fallbackTitle: "Requirements",
  participantIds: ["codex", "claude"],
  stepId: "converge",
  ...(previous === undefined ? {} : { previous }),
});

test("a declared promotion turns structured output into a typed artifact", () => {
  const production = produceDeclaredArtifact(promotionInput(
    { type: "requirement", titleField: "title", bodyField: "body", evidenceField: "evidence" },
    { title: "Bounded retry", body: "Every retry path is bounded", evidence: ["src/retry.ts:23"] },
  ));
  assert.ok(production, "a declared promotion produced no artifact");
  assert.equal(production.artifact.type, "requirement");
  assert.equal(production.artifact.title, "Bounded retry");
  assert.equal(production.artifact.body, "Every retry path is bounded");
  assert.deepEqual(production.artifact.evidence, ["src/retry.ts:23"]);
  assert.equal(production.artifact.state, "proposed");
  assert.equal(production.artifact.revision, 1);
  assert.ok(production.artifact.contentDigest);
  assert.deepEqual(production.artifact.provenance.participantIds, ["codex", "claude"]);
});

test("every declared artifact type is promotable, and custom carries its own name", () => {
  // "decision" is deliberately absent: a core decision is a DecisionRecord, not a generic
  // artifact, and has its own test below.
  for (const type of [
    "hypothesis", "requirement", "recommendation",
    "plan", "design", "protocol", "patch", "findingSet",
  ]) {
    const production = produceDeclaredArtifact(promotionInput(
      { type, bodyField: "body" },
      { body: `a ${type}` },
    ));
    assert.ok(production, `${type} was not promotable`);
    assert.equal(production.artifact.type, type);
  }
  const custom = produceDeclaredArtifact(promotionInput(
    { type: "custom", customType: "riskRegister", bodyField: "body" },
    { body: "three risks" },
  ));
  assert.ok(custom);
  assert.equal(custom.artifact.type, "custom");
  assert.equal(custom.artifact.customType, "riskRegister");
});

test("a custom promotion with no name produces nothing", () => {
  assert.equal(
    produceDeclaredArtifact(promotionInput({ type: "custom", bodyField: "body" }, { body: "x" })),
    undefined,
  );
});

test("output a preset did not declare stays run-local", () => {
  assert.equal(
    produceDeclaredArtifact(promotionInput(
      { type: "requirement", bodyField: "missingField" },
      { body: "not the declared field" },
    )),
    undefined,
    "a promotion read a field the preset never named",
  );
});

test("an unchanged promotion supersedes nothing and produces no revision", () => {
  const first = produceDeclaredArtifact(promotionInput(
    { type: "plan", bodyField: "body" },
    { body: "step one" },
  ));
  assert.equal(first.artifact.revision, 1);
  assert.equal(
    produceDeclaredArtifact(promotionInput(
      { type: "plan", bodyField: "body" },
      { body: "step one" },
      first.artifact,
    )),
    undefined,
    "identical output produced a second revision",
  );
  const changed = produceDeclaredArtifact(promotionInput(
    { type: "plan", bodyField: "body" },
    { body: "step one and two" },
    first.artifact,
  ));
  assert.equal(changed.artifact.revision, 2);
  assert.equal(changed.artifact.supersedesId, first.artifact.id);
});

test("a stored pipeline predating the rule still cannot produce a duplicate decision", () => {
  assert.equal(
    produceDeclaredArtifact(promotionInput({ type: "decision", bodyField: "body" }, { body: "x" })),
    undefined,
    "a decision was produced as a generic artifact",
  );
});
