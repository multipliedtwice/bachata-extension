const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createStateCatalog } = require("../dist/state/catalog.js");
const { boundedTerminalResult, TERMINAL_RESULT_OMISSION_NOTICE } = require("../dist/results/persistedResult.js");
const { parseRunResult, mergeRunResults } = require("../dist/results/projectResult.js");
const { readableResultMarkdown } = require("../dist/results/readableResult.js");
const { RESULT_TEXT_LIMITS } = require("../dist/results/textLimits.js");
const { largeResultHandoffFixture, resultHandoffFixture } = require("./fixtures/resultHandoff.cjs");

const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");
const resultFixture = (count = 2_048) => {
  const result = largeResultHandoffFixture(count);
  result.executionRef = "execution-current";
  result.retainedRunId = "retained-current";
  result.finalDecisionEventId = 47;
  result.failure = { error: "Verification stopped before confirmation.", participant: "Worker", step: "Confirm" };
  result.evidence = [
    { kind: "changedFiles", label: "Changed files", state: "recorded", detail: "Recorded changed source files." },
    { kind: "verification", label: "Verification", state: "missing", detail: "Confirmation did not pass." },
  ];
  result.findings[0].disposition = "accepted";
  result.findings[0].provenance = { source: "pipelineDecision", stepId: "review", participantIds: ["lead", "worker"], decisionStatus: "accepted" };
  return result;
};

const assertStable = (source) => {
  const before = structuredClone(source);
  const first = boundedTerminalResult(source);
  assert.ok(bytes(first) <= RESULT_TEXT_LIMITS.catalogJsonBytes);
  assert.deepEqual(boundedTerminalResult(source), first);
  assert.deepEqual(boundedTerminalResult(first), first);
  assert.deepEqual(parseRunResult(JSON.parse(JSON.stringify(first))), first);
  assert.deepEqual(source, before);
  return first;
};

test("terminal persistence bounds aggregate serialized UTF-8 bytes and preserves every priority section", () => {
  const source = resultFixture();
  assert.ok(bytes(source) > RESULT_TEXT_LIMITS.catalogJsonBytes);
  const result = assertStable(source);
  assert.equal(result.persistence.omitted, true);
  assert.equal(result.status, source.status);
  assert.equal(result.executionRef, source.executionRef);
  assert.equal(result.retainedRunId, source.retainedRunId);
  assert.equal(result.finalDecisionEventId, 47);
  assert.deepEqual(result.finalAssessment, source.finalAssessment);
  assert.deepEqual(result.failure, source.failure);
  assert.equal(result.finalDecision.status, "pending");
  assert.equal(result.finalRuling, source.finalRuling);
  assert.deepEqual(result.expectations, source.expectations);
  assert.equal(result.findings[0].disposition, "accepted");
  assert.equal(result.findings[1].disposition, "unresolved");
  assert.deepEqual(result.checks[0], source.checks[0]);
  assert.equal(result.unresolvedRisks[0], source.unresolvedRisks[0]);
  assert.equal(result.evidenceGaps[0], source.evidenceGaps[0]);
  assert.equal(result.changedFiles[0], source.changedFiles[0]);
  assert.deepEqual(result.evidence, source.evidence);
  assert.equal(result.evidenceGaps.at(-1), TERMINAL_RESULT_OMISSION_NOTICE);
  assert.equal(result.evidenceGaps.filter((gap) => gap === TERMINAL_RESULT_OMISSION_NOTICE).length, 1);
});

for (const [label, value] of [
  ["multibyte text", "งานตรวจสอบ 😀".repeat(250)],
  ["JSON escaping", '\\"\n\t\0'.repeat(500)],
  ["surrogates", "😀\ud800\udfff".repeat(500)],
]) {
  test(`terminal persistence measures ${label} after JSON serialization`, () => {
    const source = resultFixture(128);
    source.finalAssessment.summary = value;
    source.finalRuling = value;
    source.unresolvedRisks = Array.from({ length: 128 }, (_, index) => `${index}: ${value}`);
    source.evidenceGaps = Array.from({ length: 128 }, (_, index) => `${index}: ${value}`);
    assert.ok(bytes(source) > RESULT_TEXT_LIMITS.catalogJsonBytes);
    const result = assertStable(source);
    assert.equal(result.finalAssessment.summary, value);
    assert.equal(result.finalRuling, value);
    assert.equal(result.unresolvedRisks[0], source.unresolvedRisks[0]);
    assert.equal(result.evidenceGaps[0], source.evidenceGaps[0]);
    assert.equal(result.persistence.omitted, true);
  });
}

test("terminal persistence retains unresolved decision and failure meaning when owning text cannot fit", () => {
  const source = resultFixture(4);
  const huge = "งาน😀".repeat(100_000);
  source.finalAssessment.summary = huge;
  source.finalRuling = huge;
  source.failure.error = huge;
  source.finalAssessment.failure = { error: huge, participant: "Lead", step: "Review" };
  source.finalDecision = {
    stepId: "review", status: "resolved", candidate: { summary: huge }, participants: [], objections: [], unresolvedRisks: [],
    humanResolution: { action: "acceptUnresolved", rationale: huge, selectedParticipant: "worker", resolvedAt: "2026-09-14T00:00:00Z" },
  };
  const result = assertStable(source);
  assert.match(result.finalAssessment.summary, /omitted/u);
  assert.match(result.finalRuling, /omitted/u);
  assert.match(result.failure.error, /omitted/u);
  assert.equal(result.failure.participant, "Worker");
  assert.equal(result.failure.step, "Confirm");
  assert.equal(result.finalAssessment.failure.participant, "Lead");
  assert.equal(result.finalAssessment.failure.step, "Review");
  assert.equal(result.finalDecision.status, "resolved");
  assert.match(result.finalDecision.candidate, /omitted/u);
  assert.equal(result.finalDecision.humanResolution.action, "acceptUnresolved");
  assert.equal(result.finalDecision.humanResolution.selectedParticipant, "worker");
  assert.equal(result.finalDecision.humanResolution.resolvedAt, "2026-09-14T00:00:00Z");
  assert.match(result.finalDecision.humanResolution.rationale, /omitted/u);
  assert.match(readableResultMarkdown(result), /unresolved/iu);
  assert.ok(result.applyBlockedReason);
});

test("terminal persistence never substitutes an older ruling when an oversized decision is omitted", () => {
  const source = resultFixture(1);
  source.finalRuling = "An older assessment must not become the current ruling.";
  source.finalDecision.status = "accepted";
  source.finalDecision.candidate = { findings: Array.from({ length: 65 }, () => ({ summary: "Too many nested entries." })) };
  const result = assertStable(source);
  assert.equal(result.finalDecision.status, "accepted");
  assert.match(result.finalDecision.candidate, /omitted/u);
  assert.doesNotMatch(readableResultMarkdown(result), /An older assessment/u);
});

test("terminal persistence keeps oversized failure metadata and redaction expansion idempotent", () => {
  const source = resultFixture();
  source.failure = {
    error: "Error ".repeat(100_000),
    participant: "Participant ".repeat(1_000),
    step: "Step ".repeat(2_000),
    adapter: "Adapter ".repeat(1_500),
    model: "Model ".repeat(1_500),
  };
  source.finalAssessment.failure = structuredClone(source.failure);
  source.finalDecision.candidate = { digest: "a1b2c3d4", summary: "a1b2c3d4 ".repeat(1_500) };
  const result = assertStable(source);
  assert.match(result.failure.error, /omitted/u);
  assert.match(result.finalAssessment.failure.error, /omitted/u);
  assert.ok(bytes(result.failure) <= RESULT_TEXT_LIMITS.catalogJsonBytes / 8);
  assert.doesNotMatch(readableResultMarkdown(result), /a1b2c3d4/u);
});

test("terminal enforcement stays identical when rejected aggregate entries exhaust traversal work", () => {
  const source = resultFixture(128);
  source.finalDecision.candidate = {
    summary: "A bounded review remains unresolved.",
    details: Array.from({ length: 64 }, () => ({ evidence: Array.from({ length: 64 }, () => "review") })),
  };
  source.findings.forEach((finding) => {
    finding.evidence = Array.from({ length: 64 }, (_, index) => `Evidence ${index}`);
    finding.challenges = Array.from({ length: 64 }, (_, index) => `Challenge ${index}`);
  });
  const result = assertStable(source);
  assert.equal(result.persistence.omitted, true);
  assert.match(result.applyBlockedReason, /Verification did not pass/u);
});

test("terminal persistence bounds traversal without reading beyond collection limits or modifying input", () => {
  const source = resultFixture(100);
  Object.defineProperty(source.changedFiles, RESULT_TEXT_LIMITS.maximumSectionEntries, {
    get() { throw new Error("Read beyond the bounded collection"); },
  });
  source.finalDecision.candidate = { summary: "{".repeat(1_000_000) };
  const result = boundedTerminalResult(source);
  assert.ok(bytes(result) <= RESULT_TEXT_LIMITS.catalogJsonBytes);
  assert.equal(result.changedFiles.length, RESULT_TEXT_LIMITS.maximumSectionEntries);
  assert.equal(result.persistence.omitted, true);
  assert.equal(source.finalDecision.candidate.summary.length, 1_000_000);
  assert.deepEqual(boundedTerminalResult(result), result);
});

test("versioned terminal parsing validates collections and cannot erase canonical verification blocking", () => {
  const source = resultFixture(1);
  source.persistence = { version: 1, omitted: false };
  source.findings.push({ id: "forged", subject: "Unsupported acceptance", disposition: "accepted" });
  source.checks.push({ command: 42, status: "passed" });
  source.evidence.push({ kind: "verification", state: "passed", detail: 42 });
  source.applyBlockedReason = "";
  source.applyOverrideReason = "Allow unverified changes";
  const result = parseRunResult(source);
  assert.equal(result.findings.length, 1);
  assert.equal(result.checks.length, 1);
  assert.equal(result.evidence.length, 2);
  assert.match(result.applyBlockedReason, /Verification did not pass/u);
  assert.equal(result.applyOverrideReason, undefined);
  assert.equal(result.persistence.omitted, true);
});

test("bounded terminal merge preserves saved assessment and omissions when reload has no newer evidence", () => {
  const persisted = assertStable(resultFixture());
  const live = resultHandoffFixture();
  live.executionRef = persisted.executionRef;
  live.finalDecisionEventId = persisted.finalDecisionEventId;
  live.changedFiles = [];
  live.findings = [];
  live.checks = [];
  live.unresolvedRisks = [];
  live.recoveredErrors = [];
  live.evidenceGaps = [];
  delete live.finalRuling;
  assert.deepEqual(mergeRunResults(persisted, live), persisted);
  const newer = structuredClone(live);
  newer.executionRef = "execution-next";
  assert.deepEqual(mergeRunResults(persisted, newer), newer);
});

test("an omitted terminal result remains authoritative over a divergent reconstruction of the same execution", () => {
  const persisted = assertStable(resultFixture());
  const live = resultHandoffFixture();
  live.executionRef = persisted.executionRef;
  live.finalDecisionEventId = persisted.finalDecisionEventId;
  live.finalDecision = {
    stepId: "reconstructed-decision",
    status: "accepted",
    participants: [],
    objections: [],
    unresolvedRisks: [],
  };
  live.finalRuling = "A reconstructed ruling that was never persisted";
  assert.deepEqual(mergeRunResults(persisted, live), persisted);
});

test("bounded terminal merge updates newer verification and keeps saved omission semantics", () => {
  const persisted = assertStable(resultFixture());
  const live = resultHandoffFixture();
  live.executionRef = persisted.executionRef;
  live.checks = [{ command: "node scripts/new-check.cjs", status: "failed" }];
  live.verificationProvenance = { source: "recheck", recordedAt: "2026-09-15T00:00:00Z" };
  const merged = boundedTerminalResult(mergeRunResults(persisted, live));
  assert.deepEqual(merged.checks, live.checks);
  assert.equal(merged.verificationProvenance.recordedAt, live.verificationProvenance.recordedAt);
  assert.match(merged.finalAssessment.summary, /new-check/u);
  assert.equal(merged.persistence.omitted, true);
  assert.ok(merged.evidenceGaps.includes(TERMINAL_RESULT_OMISSION_NOTICE));
});

for (const operation of ["createRun", "upsertRun", "commitRuns"]) {
  test(`catalog ${operation} stores bounded terminal JSON and preserves event history across close and reload`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "bachata-terminal-catalog-"));
    let catalog;
    let database;
    try {
      catalog = createStateCatalog(root);
      const source = resultFixture();
      source.finalAssessment.summary = 'ตรวจสอบ 😀 "quoted" \\ escaped\n\0';
      source.finalRuling = source.finalAssessment.summary;
      const original = structuredClone(source);
      const expected = boundedTerminalResult(source);
      const run = catalog.createRun({ title: "Terminal result", ...(operation === "createRun" ? { terminalResult: source } : {}) });
      if (operation === "upsertRun") catalog.upsertRun({ ...run, terminalResult: source });
      if (operation === "commitRuns") catalog.commitRuns([{ ...run, terminalResult: source }], [], run.runRef);
      for (let index = 0; index < 24; index += 1) {
        catalog.appendEvent({ runRef: run.runRef, type: "step.answer", title: `Answer ${index}`, payload: { text: "Recorded participant answer ".repeat(200), stepId: `step-${index}` } });
      }
      const events = catalog.listEvents(run.runRef);
      assert.equal(events.length, 24);
      assert.deepEqual(catalog.getRun(run.runRef).terminalResult, expected);
      assert.deepEqual(source, original);
      catalog.close();
      catalog = undefined;
      database = new DatabaseSync(path.join(root, "bachata-state.sqlite"));
      const row = database.prepare("SELECT result_json FROM runs WHERE run_ref = ?").get(run.runRef);
      assert.ok(Buffer.byteLength(row.result_json, "utf8") <= RESULT_TEXT_LIMITS.catalogJsonBytes);
      assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(row.result_json)), "utf8") <= RESULT_TEXT_LIMITS.catalogJsonBytes);
      assert.deepEqual(JSON.parse(row.result_json), expected);
      database.close();
      database = undefined;
      catalog = createStateCatalog(root);
      assert.deepEqual(catalog.getRun(run.runRef).terminalResult, expected);
      assert.deepEqual(catalog.listEvents(run.runRef), events);
      const restored = catalog.getRun(run.runRef);
      catalog.upsertRun(restored);
      assert.deepEqual(catalog.getRun(run.runRef).terminalResult, expected);
    } finally {
      database?.close();
      catalog?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
