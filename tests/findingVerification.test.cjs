const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createStateCatalog } = require("../dist/state/catalog.js");
const { createLongitudinalService } = require("../dist/longitudinal/service.js");
const { parseExternalEvidenceRecord, parseInitiativeBundle } = require("../dist/longitudinal/parse.js");
const { parseFindingVerification, findingVerificationRefusal } = require("../dist/longitudinal/findingVerification.js");
const now = "2026-09-12T00:00:00.000Z";
const baseline = { commit: "a".repeat(40), worktreeDigest: "WT" + "B".repeat(24), contentComplete: true, dirty: true, capturedAt: now };
const fixture = async (body) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-finding-proof-"));
  const catalog = createStateCatalog(root);
  let counter = 0;
  const service = createLongitudinalService({ store: catalog.longitudinal, repositoryRoot: root, now: () => new Date(now), createId: (prefix) => `${prefix}${++counter}` });
  try {
    service.defineInitiative({ title: "Bound retry execution", goal: "Retry no more than requested" });
    service.startCycle({ type: "review", repositoryBaseline: baseline });
    service.bindRun({ runRef: "R1", freshReview: true });
    service.recordRound({ runRef: "R1", executionRef: "E1", freshReview: true, findings: [{ id: "retry-count", subject: "Retry bound", message: "Retry executes one extra attempt", disposition: "accepted", evidence: ["src/retry.ts:12"], challenges: [], provenance: { source: "pipelineDecision", stepId: "review", participantIds: ["codex", "claude"] }, location: { file: "src/retry.ts", startLine: 12 } }] });
    const finding = service.summary().findings[0];
    assert.ok(finding);
    const proof = { version: 1, kind: "externalEvidence", findingIdentity: finding.identity, findingStatement: finding.message, requirement: "Two requested attempts execute exactly two calls", scope: ["src/retry.ts"], candidate: { commit: baseline.commit, worktreeDigest: baseline.worktreeDigest }, outcome: "passed", verifier: "human reviewer", environment: "Node.js deterministic retry reproduction", recordedAt: now };
    const input = { source: { uri: "https://evidence.invalid/retry", title: "Retry reproduction", retrievedAt: now, contentDigest: "c".repeat(64) }, claim: "The extra attempt was removed", relation: "supports", target: { kind: "finding", identity: finding.identity }, authority: "firstPartyMeasurement", authoredBy: "human", verification: proof };
    await body({ root, service, catalog, finding, proof, input });
  } finally { catalog.close(); await rm(root, { recursive: true, force: true }); }
};

test("accepted candidate-scoped verification atomically resolves the finding and persists independent evidence", async () => fixture(async ({ service, catalog, finding, input }) => {
  const stored = service.recordExternalEvidence(input);
  assert.equal(stored.state, "proposed");
  assert.equal(service.summary().findings[0].state, "accepted");
  assert.equal(service.resolve({ target: "externalEvidence", id: stored.id, action: "accept", resolvedBy: "human", currentBaseline: baseline }), true);
  const state = service.summary();
  assert.equal(state.externalEvidence[0].state, "accepted");
  assert.equal(state.findings[0].state, "resolved");
  assert.equal(state.findings[0].fixState, "verified");
  assert.ok(state.findings[0].evidence.some((item) => item.includes(stored.id)));
  assert.ok(state.currentCycle.acceptedStateDelta.resolvedFindingIdentities.includes(finding.identity));
  const reloaded = catalog.longitudinal.listExternalEvidence(state.initiative.id)[0];
  assert.deepEqual(reloaded.verification, stored.verification);
  assert.deepEqual(parseExternalEvidenceRecord(reloaded), reloaded);
  const exported = service.exportInitiative();
  const parsed = parseInitiativeBundle(exported);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.bundle.externalEvidence[0].verification, input.verification);
}));

test("accepting an ordinary citation never resolves its finding", async () => fixture(async ({ service, input }) => {
  const { verification, ...ordinary } = input;
  const stored = service.recordExternalEvidence(ordinary);
  assert.equal(service.resolve({ target: "externalEvidence", id: stored.id, action: "accept", resolvedBy: "human" }), true);
  assert.equal(service.summary().findings[0].state, "accepted");
}));

for (const [name, change] of [
  ["candidate drift", (state) => { state.currentBaseline.worktreeDigest = "WT" + "D".repeat(24); }],
  ["missing current candidate", (state) => { state.currentBaseline = undefined; }],
  ["incomplete inventory", (state) => { state.currentBaseline.contentComplete = false; }],
  ["another finding", (state) => { state.record.verification.findingIdentity = "other"; }],
  ["changed finding statement", (state) => { state.finding.message = "Changed criterion"; }],
  ["uncovered file", (state) => { state.record.verification.scope = ["src/other.ts"]; }],
  ["failed check", (state) => { state.record.verification.outcome = "failed"; }],
  ["future observation", (state) => { state.record.verification.recordedAt = "2027-01-01T00:00:00.000Z"; }],
  ["expired observation", (state) => { state.record.freshnessHorizonDays = 1; state.now = "2026-09-15T00:00:00.000Z"; }],
  ["superseded evidence", (state) => { state.record.supersededById = "X2"; }],
  ["unresolved challenge", (state) => { state.record.challenges = [{ recordedAt: now, participantIds: ["reviewer"], cycleId: "Y1", text: "Wrong environment" }]; }],
  ["undated challenge", (state) => { state.record.challenges = [{ recordedAt: "not a date", participantIds: ["reviewer"], cycleId: "Y1", text: "Wrong environment" }]; }],
  ["rejected finding", (state) => { state.finding.state = "rejected"; }],
]) test(`verification refuses ${name}`, async () => fixture(async ({ service, input, finding }) => {
  const stored = service.recordExternalEvidence(input);
  const state = { record: structuredClone(stored), finding: structuredClone(finding), currentBaseline: structuredClone(baseline), now };
  change(state);
  assert.equal(typeof findingVerificationRefusal(state), "string");
}));

test("stale acceptance refuses both transitions and a revised candidate supersedes rather than reuses evidence", async () => fixture(async ({ service, input }) => {
  const stored = service.recordExternalEvidence(input);
  assert.equal(service.resolve({ target: "externalEvidence", id: stored.id, action: "accept", resolvedBy: "human", currentBaseline: { ...baseline, worktreeDigest: "WT" + "D".repeat(24) } }), false);
  assert.equal(service.summary().externalEvidence[0].state, "proposed");
  assert.equal(service.summary().findings[0].state, "accepted");
  const revised = service.recordExternalEvidence({ ...input, verification: { ...input.verification, candidate: { ...input.verification.candidate, worktreeDigest: "WT" + "D".repeat(24) } } });
  assert.equal(revised.revision, 2);
  assert.equal(revised.supersedesId, stored.id);
}));

test("regression evidence requires identical check identity, different exact candidates and fail-before/pass-after", async () => fixture(async ({ proof }) => {
  const regression = { ...proof, kind: "regression", checkIdentity: "e".repeat(64), before: { candidate: { commit: baseline.commit, worktreeDigest: "WT" + "F".repeat(24) }, checkIdentity: "e".repeat(64), outcome: "failed" } };
  assert.deepEqual(parseFindingVerification(regression), regression);
  for (const alter of [
    (value) => { delete value.before; },
    (value) => { value.before.checkIdentity = "1".repeat(64); },
    (value) => { value.before.candidate = value.candidate; },
    (value) => { value.before.outcome = "passed"; },
    (value) => { value.outcome = "failed"; },
    (value) => { value.checkIdentity = "not-a-check-identity"; },
  ]) { const value = structuredClone(regression); alter(value); assert.equal(parseFindingVerification(value), undefined); }
  for (const kind of ["reproduction", "invariant", "staticRule"]) {
    assert.ok(parseFindingVerification({ ...proof, kind, checkIdentity: "e".repeat(64) }));
    assert.equal(parseFindingVerification({ ...proof, kind }), undefined);
  }
}));

test("verification schema refuses unknown fields, malformed versions, deep fields, oversized values and array lookahead", async () => fixture(async ({ proof }) => {
  for (const value of [{ ...proof, version: 2 }, { ...proof, extra: {} }, { ...proof, requirement: "x".repeat(8001) }, { ...proof, scope: Array(33).fill("src/a.ts") }, { ...proof, candidate: { ...proof.candidate, extra: {} } }]) {
    assert.equal(parseFindingVerification(value), undefined);
  }
  const wide = new Proxy(Array(33), { get(target, key) { if (key !== "length") throw new Error("Array traversed before count refusal"); return target.length; } });
  assert.equal(parseFindingVerification({ ...proof, scope: wide }), undefined);
  const multibyte = { ...proof, requirement: "界".repeat(8000), findingStatement: "界".repeat(8000) };
  assert.equal(parseFindingVerification(multibyte), undefined);
}));

test("evidence-copy reading has a literal byte bound and refuses symlinks", async () => {
  const { writeFile, symlink } = require("node:fs/promises");
  const { createHash } = require("node:crypto");
  const { sha256EvidenceCopy } = require("../dist/security/fileHash.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-evidence-copy-"));
  try {
    const file = path.join(root, "evidence.txt");
    const value = "界".repeat(1024);
    await writeFile(file, value);
    assert.equal(await sha256EvidenceCopy(file), createHash("sha256").update(value).digest("hex"));
    const link = path.join(root, "copy.txt");
    await symlink(file, link);
    await assert.rejects(sha256EvidenceCopy(link));
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
    await assert.rejects(sha256EvidenceCopy(file), /at most 4 MiB/);
    await assert.rejects(sha256EvidenceCopy(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verification scope excludes ignored files, redirected paths and traversal", async () => {
  const { writeFile, symlink } = require("node:fs/promises");
  const { execFileSync } = require("node:child_process");
  const { verificationScopeIsObservable } = require("../dist/longitudinal/repositoryBaseline.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-verification-scope-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(path.join(root, ".gitignore"), "ignored.ts\n");
    await writeFile(path.join(root, "ignored.ts"), "ignored");
    await writeFile(path.join(root, "source.ts"), "source");
    await symlink("source.ts", path.join(root, "redirect.ts"));
    await symlink("absent.ts", path.join(root, "dangling.ts"));
    assert.equal(await verificationScopeIsObservable(root, ["source.ts"]), true);
    assert.equal(await verificationScopeIsObservable(root, ["ignored.ts"]), false);
    assert.equal(await verificationScopeIsObservable(root, ["source.ts", "ignored.ts"]), false);
    assert.equal(await verificationScopeIsObservable(root, ["redirect.ts"]), false);
    assert.equal(await verificationScopeIsObservable(root, ["dangling.ts"]), false);
    assert.equal(await verificationScopeIsObservable(root, ["absent.ts"]), false);
    assert.equal(await verificationScopeIsObservable(root, [".git/config"]), false);
    assert.equal(await verificationScopeIsObservable(root, [":(glob)*.ts"]), false);
    assert.equal(await verificationScopeIsObservable(root, ["../source.ts"]), false);
    assert.equal(await verificationScopeIsObservable(root, ["/source.ts"]), false);
    assert.equal(await verificationScopeIsObservable(undefined, ["source.ts"]), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("verification consumes the actual repository-baseline format, including an unborn repository", async () => {
  const { writeFile } = require("node:fs/promises");
  const { execFileSync } = require("node:child_process");
  const { captureCycleBaseline } = require("../dist/longitudinal/repositoryBaseline.js");
  const { verificationCandidateFrom } = require("../dist/longitudinal/findingVerification.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-real-proof-baseline-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    await writeFile(path.join(root, "retry.ts"), "export const attempts = 2;\n");
    const captured = await captureCycleBaseline(root, now);
    assert.equal(captured.contentComplete, true);
    const candidate = verificationCandidateFrom(captured);
    assert.deepEqual(candidate, { commit: captured.commit, worktreeDigest: captured.worktreeDigest });
    assert.ok(candidate);
    await writeFile(path.join(root, "retry.ts"), "export const attempts = 3;\n");
    assert.notDeepEqual(verificationCandidateFrom(await captureCycleBaseline(root, now)), candidate);
    assert.equal(verificationCandidateFrom({ ...captured, contentComplete: false }), undefined);
    assert.equal(verificationCandidateFrom({ ...captured, worktreeDigest: "raw" }), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test("a storage refusal rolls back evidence acceptance together with finding resolution", async () => fixture(async ({ service, catalog, input }) => {
  const { DatabaseSync } = require("node:sqlite");
  const stored = service.recordExternalEvidence(input);
  const database = new DatabaseSync(catalog.path);
  try {
    database.exec("CREATE TRIGGER refuse_finding_resolution BEFORE UPDATE ON finding_history BEGIN SELECT RAISE(ABORT, 'controlled finding write refusal'); END");
    assert.throws(() => service.resolve({ target: "externalEvidence", id: stored.id, action: "accept", resolvedBy: "human", currentBaseline: baseline }), /controlled finding write refusal/);
    assert.equal(service.summary().externalEvidence[0].state, "proposed");
    assert.equal(service.summary().findings[0].state, "accepted");
    assert.deepEqual(service.summary().currentCycle.acceptedStateDelta.resolvedFindingIdentities, []);
  } finally { database.close(); }
}));

test("external verification resolves the finding without reclassifying an independently failed fix run", async () => fixture(async ({ service, catalog, finding, input }) => {
  const stored = service.recordExternalEvidence(input);
  const failed = catalog.createRun({ title: "Failed cleanup repair", status: "failed" });
  catalog.appendEvent({ runRef: failed.runRef, type: "run.failed", status: "failed", payload: { message: "Provider timeout" } });
  const run = { initiativeId: stored.initiativeId, identity: finding.identity, runRef: failed.runRef, state: "awaitingFix", updatedAt: now };
  catalog.longitudinal.commitFixRunState({ fixRuns: [run], findings: [] });
  assert.equal(service.resolve({ target: "externalEvidence", id: stored.id, action: "accept", resolvedBy: "human", currentBaseline: baseline }), true);
  assert.equal(service.summary().findings[0].fixState, "verified");
  assert.equal(service.summary().fixRuns[0].state, "awaitingFix");
  assert.equal(catalog.getRun(failed.runRef).status, "failed");
  assert.equal(catalog.listEvents(failed.runRef).at(-1).type, "run.failed");
}));


test("verification scope refuses holes and ignores custom iterators while preserving a reload fixed point", async () => fixture(async ({ proof }) => {
  const hole = Array(1);
  assert.equal(parseFindingVerification({ ...proof, scope: hole }), undefined);
  const scope = ["src/retry.ts"];
  scope[Symbol.iterator] = () => { throw new Error("Untrusted scope iterator executed"); };
  const parsed = parseFindingVerification({ ...proof, scope });
  assert.ok(parsed);
  assert.deepEqual(parsed.scope, ["src/retry.ts"]);
  assert.deepEqual(parseFindingVerification(JSON.parse(JSON.stringify(parsed))), parsed);
  assert.equal(parseFindingVerification({ ...proof, scope: ["src/retry.ts", "src\\retry.ts"] }), undefined);
  assert.deepEqual(parseFindingVerification({ ...proof, scope: ["src\\retry.ts"] }).scope, ["src/retry.ts"]);
}));
