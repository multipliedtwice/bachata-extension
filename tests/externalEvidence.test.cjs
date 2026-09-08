const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStateCatalog } = require("../dist/state/catalog.js");
const { createLongitudinalService } = require("../dist/longitudinal/service.js");
const {
  externalEvidenceIsContested,
  externalEvidenceIsStale,
  externalEvidenceLogicalIdentity,
} = require("../dist/longitudinal/lifecycle.js");
const { allowedResolutionActions, resolutionMatrix } = require("../dist/longitudinal/transitions.js");
const { parseExternalEvidenceRecord, parseInitiativeBundle } = require("../dist/longitudinal/parse.js");

const REPOSITORY_ROOT = "/work/repo";

const idFactory = () => {
  const counters = { N: 0, Y: 0, T: 0, D: 0, X: 0 };
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

const withService = async (body) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-external-evidence-"));
  const catalog = createStateCatalog(root);
  try {
    const service = createLongitudinalService({
      store: catalog.longitudinal,
      repositoryRoot: REPOSITORY_ROOT,
      now: clock(),
      createId: idFactory(),
    });
    service.defineInitiative({
      title: "Provider boundary",
      goal: "Ship the provider boundary",
      desiredOutcome: "Codex runs only where it can keep its promise",
      acceptanceCriteria: ["the handshake passes"],
    });
    service.startCycle({ type: "review" });
    await body(service, catalog);
  } finally {
    catalog.close();
    await rm(root, { recursive: true, force: true });
  }
};

const source = (overrides = {}) => ({
  uri: "https://standards.invalid/rfc-9999",
  title: "RFC 9999",
  publisher: "Standards body",
  publishedAt: "2026-01-01",
  retrievedAt: "2026-01-01T00:00:00.000Z",
  contentDigest: "a".repeat(64),
  ...overrides,
});

const record = (service, overrides = {}) => service.recordExternalEvidence({
  source: source(overrides.source),
  claim: overrides.claim ?? "The protocol requires kebab-case sandbox modes",
  relation: overrides.relation ?? "supports",
  target: overrides.target ?? { kind: "initiative" },
  authority: overrides.authority ?? "standard",
  ...(overrides.freshnessHorizonDays === undefined
    ? {}
    : { freshnessHorizonDays: overrides.freshnessHorizonDays }),
  participantIds: overrides.participantIds ?? ["codex", "claude"],
  ...(overrides.runRef === undefined ? {} : { runRef: overrides.runRef }),
});

test("external evidence is its own record kind with its own identity", async () => {
  await withService((service) => {
    const stored = record(service);
    assert.equal(stored.id.startsWith("X"), true, "external evidence must not borrow another kind's id");
    assert.equal(
      stored.logicalId,
      externalEvidenceLogicalIdentity(source().uri, { kind: "initiative" }),
    );
    assert.equal(stored.state, "proposed");
    assert.equal(stored.disposition, "unresolved");
    assert.equal(stored.revision, 1);
    const summary = service.summary();
    assert.equal(summary.externalEvidence.length, 1);
    assert.equal(summary.artifacts.length, 0, "it must not appear as an artifact");
    assert.equal(summary.decisions.length, 0, "it must not appear as a decision");
  });
});

const patchArtifact = (service) => {
  service.bindRun({ runRef: "R0001", freshReview: true });
  return service.recordPatchArtifact({
  runRef: "R0001",
  title: "Applied work",
  stagedFiles: ["src/a.ts"],
  targetBranch: "bachata/integration/run-1",
  findingIdentities: [],
  });
};

test("the same source cited against two targets is two records", async () => {
  await withService((service) => {
    const artifact = patchArtifact(service);
    assert.notEqual(artifact, undefined, "the fixture needs a real artifact to claim against");
    const artifactBound = record(service, { target: { kind: "artifact", artifactId: artifact.id } });
    const initiativeBound = record(service, { target: { kind: "initiative" } });
    assert.notEqual(artifactBound.logicalId, initiativeBound.logicalId);
    assert.equal(service.summary().externalEvidence.length, 2);
  });
});

test("a re-retrieval with the same bytes revises nothing", async () => {
  await withService((service) => {
    const first = record(service);
    const second = record(service);
    assert.equal(second.id, first.id);
    assert.equal(second.revision, 1);
    assert.equal(service.summary().externalEvidence.length, 1);
  });
});

test("changed bytes mint a revision that supersedes the previous one", async () => {
  await withService((service) => {
    const first = record(service);
    const second = record(service, {
      source: { contentDigest: "b".repeat(64), retrievedAt: "2026-02-01T00:00:00.000Z" },
      claim: "The protocol now rejects the readable-root field",
    });
    assert.notEqual(second.id, first.id);
    assert.equal(second.revision, 2);
    assert.equal(second.supersedesId, first.id);
    const stored = service.summary().externalEvidence;
    const previous = stored.find((item) => item.id === first.id);
    assert.equal(previous.state, "superseded");
    assert.equal(previous.supersededById, second.id);
    assert.equal(stored.filter((item) => item.supersededById === undefined).length, 1);
  });
});

test("freshness is stated, not enforced by deletion", async () => {
  await withService((service) => {
    const fresh = record(service, {
      source: { retrievedAt: new Date().toISOString() },
      freshnessHorizonDays: 30,
    });
    assert.equal(externalEvidenceIsStale(fresh, new Date().toISOString()), false);
    assert.equal(
      externalEvidenceIsStale(
        { freshnessHorizonDays: 30, source: { retrievedAt: "2020-01-01T00:00:00.000Z" } },
        "2026-01-01T00:00:00.000Z",
      ),
      true,
    );
    assert.equal(
      externalEvidenceIsStale({ source: { retrievedAt: "2020-01-01T00:00:00.000Z" } }, "2026-01-01T00:00:00.000Z"),
      false,
      "a record with no declared horizon never ages out on its own",
    );
    const summary = service.summary();
    assert.equal(summary.staleExternalEvidenceIds.includes(fresh.id), false);
  });
});

test("a stale record is reported as stale rather than dropped", async () => {
  await withService((service) => {
    const aged = record(service, {
      source: { retrievedAt: "2020-01-01T00:00:00.000Z" },
      freshnessHorizonDays: 1,
    });
    const summary = service.summary();
    assert.deepEqual(summary.staleExternalEvidenceIds, [aged.id]);
    assert.equal(summary.externalEvidence.some((item) => item.id === aged.id), true);
  });
});

test("a challenge is recorded and moves the disposition back to unresolved", async () => {
  await withService((service) => {
    const stored = record(service, { relation: "supports" });
    assert.equal(service.challengeExternalEvidence({
      id: stored.id,
      text: "The cited section was withdrawn in the current revision",
      participantIds: ["claude"],
    }), true);
    assert.equal(service.challengeExternalEvidence({
      id: stored.id,
      text: "The vendor answer contradicts it",
      participantIds: ["codex"],
    }), true);
    const [current] = service.summary().externalEvidence;
    assert.equal(current.challenges.length, 2);
    assert.equal(current.disposition, "unresolved");
    assert.equal(externalEvidenceIsContested(current), true, "two participants challenged it");
    assert.equal(service.challengeExternalEvidence({ id: stored.id, text: "   ", participantIds: [] }), false);
    assert.equal(service.challengeExternalEvidence({ id: "XNOPE", text: "x", participantIds: [] }), false);
  });
});

test("a human ruling follows the shared record matrix and is never invented by a model", async () => {
  await withService((service) => {
    const stored = record(service);
    assert.deepEqual(
      allowedResolutionActions("externalEvidence", "proposed"),
      ["accept", "reject", "defer", "supersede"],
    );
    assert.deepEqual(resolutionMatrix().externalEvidence.superseded, []);
    assert.equal(service.resolve({
      target: "externalEvidence",
      id: stored.id,
      action: "accept",
      resolvedBy: "human",
    }), true);
    const [accepted] = service.summary().externalEvidence;
    assert.equal(accepted.state, "accepted");
    assert.equal(accepted.humanResolution.action, "accept");
    assert.equal(accepted.humanResolution.resolvedBy, "human");
  });
});

test("a reopen needs a reason and a material evidence delta", async () => {
  await withService((service) => {
    const stored = record(service);
    service.resolve({ target: "externalEvidence", id: stored.id, action: "accept", resolvedBy: "human" });
    assert.equal(service.resolve({
      target: "externalEvidence",
      id: stored.id,
      action: "reopen",
      resolvedBy: "human",
    }), false);
    assert.equal(service.resolve({
      target: "externalEvidence",
      id: stored.id,
      action: "reopen",
      resolvedBy: "human",
      reason: "the publisher retracted it",
      materialEvidenceDelta: ["retraction notice"],
    }), true);
    const [reopened] = service.summary().externalEvidence;
    assert.equal(reopened.state, "proposed");
    assert.equal(reopened.humanResolution, undefined);
    assert.equal(reopened.resolutionHistory.length, 1);
    assert.equal(reopened.resolutionHistory[0].action, "accept");
  });
});

test("a supersede must name a replacement this initiative already holds", async () => {
  await withService((service) => {
    const first = record(service);
    assert.equal(service.resolve({
      target: "externalEvidence",
      id: first.id,
      action: "supersede",
      resolvedBy: "human",
      supersededById: "XDOESNOTEXIST",
    }), false);
    const replacement = record(service, {
      source: { uri: "https://standards.invalid/rfc-10000" },
    });
    assert.equal(service.resolve({
      target: "externalEvidence",
      id: first.id,
      action: "supersede",
      resolvedBy: "human",
      supersededById: replacement.id,
    }), true);
    const stored = service.summary().externalEvidence.find((item) => item.id === first.id);
    assert.equal(stored.state, "superseded");
    assert.deepEqual(allowedResolutionActions("externalEvidence", stored.state), []);
  });
});

test("external evidence survives export and import with remapped identity", async () => {
  await withService((service) => {
    const stored = record(service, { runRef: "R0001" });
    service.resolve({ target: "externalEvidence", id: stored.id, action: "accept", resolvedBy: "human" });
    const bundle = service.exportInitiative();
    assert.equal(bundle.externalEvidence.length, 1);
    const parsed = parseInitiativeBundle(JSON.parse(JSON.stringify(bundle)));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.bundle.externalEvidence[0].claim, stored.claim);

    const result = service.importInitiative(JSON.parse(JSON.stringify(bundle)));
    assert.equal(result.ok, true, result.ok ? "" : result.reason);
    const imported = service
      .listInitiatives()
      .find((initiative) => initiative.id !== stored.initiativeId);
    assert.notEqual(imported, undefined);
    service.switchInitiative(imported.id);
    const importedEvidence = service.summary().externalEvidence;
    assert.equal(importedEvidence.length, 1);
    assert.notEqual(importedEvidence[0].id, stored.id, "an imported record keeps its own identity");
    assert.equal(importedEvidence[0].claim, stored.claim);
    assert.equal(importedEvidence[0].state, "accepted");
  });
});

test("a bundle naming an artifact it does not carry imports nothing", async () => {
  await withService((service) => {
    record(service);
    const bundle = JSON.parse(JSON.stringify(service.exportInitiative()));
    bundle.externalEvidence[0].target = { kind: "artifact", artifactId: "TMISSING" };
    const parsed = parseInitiativeBundle(bundle);
    assert.equal(parsed.bundle, undefined);
    assert.match(parsed.errors.join("; "), /names artifact TMISSING, which the bundle does not contain/u);
  });
});

test("a record persisted before this kind existed reads back as nothing, never as a guess", () => {
  assert.equal(parseExternalEvidenceRecord(undefined), undefined);
  assert.equal(parseExternalEvidenceRecord({}), undefined);
  assert.equal(
    parseExternalEvidenceRecord({
      id: "X1",
      initiativeId: "N1",
      cycleId: "Y1",
      claim: "c",
      createdAt: "t",
      updatedAt: "t",
      source: source(),
      target: { kind: "initiative" },
      relation: "invented",
    }),
    undefined,
    "an unknown relation is refused rather than defaulted",
  );
  const migrated = parseExternalEvidenceRecord({
    id: "X1",
    initiativeId: "N1",
    cycleId: "Y1",
    claim: "c",
    createdAt: "t",
    updatedAt: "t",
    source: source(),
    target: { kind: "initiative" },
    relation: "supports",
  });
  assert.equal(migrated.authority, "unattributed", "an unstated authority is stated as unattributed");
  assert.equal(migrated.state, "proposed");
  assert.equal(migrated.disposition, "unresolved");
  assert.deepEqual(migrated.challenges, []);
});

test("the record survives a reopened database, which is what durable means", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-external-evidence-"));
  try {
    const first = createStateCatalog(root);
    const service = createLongitudinalService({
      store: first.longitudinal,
      repositoryRoot: REPOSITORY_ROOT,
      now: clock(),
      createId: idFactory(),
    });
    service.defineInitiative({
      title: "Durable",
      goal: "g",
      desiredOutcome: "o",
      acceptanceCriteria: ["a"],
    });
    service.startCycle({ type: "review" });
    const stored = record(service);
    first.close();

    const second = createStateCatalog(root);
    const reopened = createLongitudinalService({
      store: second.longitudinal,
      repositoryRoot: REPOSITORY_ROOT,
      now: clock(),
      createId: idFactory(),
    });
    const summary = reopened.summary();
    assert.equal(summary.externalEvidence.length, 1);
    assert.equal(summary.externalEvidence[0].id, stored.id);
    assert.equal(summary.externalEvidence[0].source.contentDigest, source().contentDigest);
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a later retrieval never revokes a ruling, and never leaves two current records", async () => {
  await withService((service) => {
    const first = record(service);
    service.resolve({ target: "externalEvidence", id: first.id, action: "accept", resolvedBy: "human" });
    const revised = record(service, {
      source: { contentDigest: "c".repeat(64), retrievedAt: "2026-03-01T00:00:00.000Z" },
      claim: "The vendor withdrew the section",
    });
    const stored = service.summary().externalEvidence;
    const ruled = stored.find((item) => item.id === first.id);
    assert.equal(ruled.state, "accepted", "a human ruling must survive a later retrieval");
    assert.equal(ruled.humanResolution.action, "accept");
    assert.equal(
      ruled.supersededById,
      revised.id,
      "the ruled record must stop being current once a revision exists",
    );
    assert.equal(revised.supersedesId, first.id);
    assert.equal(revised.revision, 2);
    assert.equal(revised.state, "proposed");
    assert.equal(
      stored.filter((item) => item.logicalId === first.logicalId && item.supersededById === undefined).length,
      1,
      "one claim must have exactly one current record",
    );
  });
});

test("a human recording evidence is not recorded as a model production", async () => {
  await withService((service) => {
    const byHuman = service.recordExternalEvidence({
      source: source(),
      claim: "The standard requires kebab-case",
      relation: "supports",
      target: { kind: "initiative" },
      authority: "standard",
      authoredBy: "human",
    });
    assert.equal(byHuman.provenance.authoredBy, "human");
    assert.deepEqual(byHuman.provenance.participantIds, []);
    const byModel = record(service, { source: { uri: "https://standards.invalid/other" } });
    assert.equal(byModel.provenance.authoredBy, "model");
    assert.deepEqual(byModel.provenance.participantIds, ["codex", "claude"]);
  });
});

test("accepting a record makes its asserted relation the disposition", async () => {
  await withService((service) => {
    const stored = record(service, { relation: "contradicts" });
    service.resolve({ target: "externalEvidence", id: stored.id, action: "accept", resolvedBy: "human" });
    assert.equal(service.summary().externalEvidence[0].disposition, "contradicts");
    service.resolve({
      target: "externalEvidence",
      id: stored.id,
      action: "reject",
      resolvedBy: "human",
    });
    assert.equal(
      service.summary().externalEvidence[0].disposition,
      "unresolved",
      "only an acceptance settles the claim",
    );
  });
});

test("a claim against a target this initiative does not hold is refused", async () => {
  await withService((service) => {
    assert.equal(record(service, { target: { kind: "artifact", artifactId: "TNOTHERE" } }), undefined);
    assert.equal(record(service, { target: { kind: "decision", decisionId: "DNOTHERE" } }), undefined);
    assert.equal(record(service, { target: { kind: "finding", identity: "FHNOTHERE" } }), undefined);
    assert.equal(service.summary().externalEvidence.length, 0);
    assert.deepEqual(service.exportInitiative().externalEvidence, []);
  });
});

test("an imported record re-derives its identity against the remapped target", async () => {
  await withService((service) => {
    const stored = record(service);
    const bundle = service.exportInitiative();
    assert.equal(service.importInitiative(JSON.parse(JSON.stringify(bundle))).ok, true);
    const imported = service
      .listInitiatives()
      .find((initiative) => initiative.id !== stored.initiativeId);
    service.switchInitiative(imported.id);
    const [copy] = service.summary().externalEvidence;
    assert.equal(
      copy.logicalId,
      externalEvidenceLogicalIdentity(copy.source.uri, copy.target),
      "an imported identity must match what a later retrieval would compute",
    );
  });
});

test("a superseded record past its horizon is not reported as stale", async () => {
  await withService((service) => {
    const first = record(service, {
      source: { retrievedAt: "2020-01-01T00:00:00.000Z" },
      freshnessHorizonDays: 1,
    });
    const second = record(service, {
      source: { contentDigest: "d".repeat(64), retrievedAt: new Date().toISOString() },
      freshnessHorizonDays: 1,
      claim: "restated from the current revision",
    });
    const summary = service.summary();
    assert.equal(summary.staleExternalEvidenceIds.includes(first.id), false);
    assert.equal(summary.staleExternalEvidenceIds.includes(second.id), false);
  });
});

test("a record that is no longer current cannot be challenged or ruled on again", async () => {
  await withService((service) => {
    const first = record(service);
    service.resolve({ target: "externalEvidence", id: first.id, action: "accept", resolvedBy: "human" });
    const revised = record(service, {
      source: { contentDigest: "e".repeat(64), retrievedAt: "2026-04-01T00:00:00.000Z" },
      claim: "restated",
    });
    assert.equal(
      service.challengeExternalEvidence({ id: first.id, text: "late objection", participantIds: ["codex"] }),
      false,
      "a superseded revision must not accept new challenges",
    );
    for (const action of ["accept", "reject", "defer"]) {
      assert.equal(
        service.resolve({ target: "externalEvidence", id: first.id, action, resolvedBy: "human" }),
        false,
        `${action} must be refused on a record something else replaced`,
      );
    }
    assert.equal(
      service.resolve({
        target: "externalEvidence",
        id: first.id,
        action: "reopen",
        resolvedBy: "human",
        reason: "the retraction was itself retracted",
        materialEvidenceDelta: ["second notice"],
      }),
      false,
    );
    const stored = service.summary().externalEvidence.find((item) => item.id === first.id);
    assert.equal(stored.state, "accepted", "the refusals must not have altered the record");
    assert.deepEqual(stored.challenges, []);
    assert.equal(
      service.resolve({ target: "externalEvidence", id: revised.id, action: "accept", resolvedBy: "human" }),
      true,
      "the current record still accepts a ruling",
    );
  });
});
