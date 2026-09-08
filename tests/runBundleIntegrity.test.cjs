const assert = require("node:assert/strict");
const test = require("node:test");

const { createRunBundle, runBundleDigest } = require("../dist/export/runBundle.js");
const {
  inspectRunBundle,
  inspectRunBundleIntegrity,
  renderRunBundleReport,
} = require("../dist/export/runBundleReport.js");

const exportedRun = () => ({
  schema: "bachata.run-bundle.v1",
  toolVersion: "0.6.12",
  run: {
    runRef: "R7",
    title: "Fix the window bound",
    input: "Fix the sliding window",
    selectedPipelineId: "managed-fix",
    selectedPipelineHash: "a".repeat(64),
    workingDirectory: "/workspace",
  },
  result: {
    status: "completed",
    changedFiles: ["src/window.ts"],
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    providers: [{ name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
    findings: [{
      id: "window-bound",
      subject: "Window bound",
      message: "The upper bound is exclusive",
      disposition: "unresolved",
      evidence: ["Boundary trace recorded"],
      challenges: ["Inclusive behavior remains possible"],
      provenance: {
        source: "pipelineDecision",
        stepId: "review-consensus",
        participantIds: ["codex", "claude"],
        decisionStatus: "accepted",
      },
    }],
    unresolvedRisks: [],
    expectations: { changedFiles: true, verification: true, finalRuling: false },
  },
});

test("an exported bundle records a digest of exactly what it carries", () => {
  const bundle = JSON.parse(createRunBundle(exportedRun(), "2026-08-25T00:00:00.000Z"));
  assert.equal(bundle.integrity.algorithm, "sha256");
  assert.match(bundle.integrity.value, /^[0-9a-f]{64}$/u);
  assert.equal(
    bundle.integrity.value,
    runBundleDigest({ version: bundle.version, exportedAt: bundle.exportedAt, run: bundle.run }),
  );
  assert.equal(inspectRunBundleIntegrity(bundle).state, "verified");
});

test("editing a bundle after export is detected", () => {
  const bundle = JSON.parse(createRunBundle(exportedRun(), "2026-08-25T00:00:00.000Z"));
  bundle.run.result.checks = [{ command: "bachata:project-checks", status: "passed" }, { command: "invented", status: "passed" }];
  const integrity = inspectRunBundleIntegrity(bundle);
  assert.equal(integrity.state, "mismatch");
  assert.match(integrity.statement, /Treat every claim in it as unproven/u);
});

test("a bundle with no recorded digest is reported as unrecorded, never as verified", () => {
  const bundle = JSON.parse(createRunBundle(exportedRun(), "2026-08-25T00:00:00.000Z"));
  delete bundle.integrity;
  const integrity = inspectRunBundleIntegrity(bundle);
  assert.equal(integrity.state, "unrecorded");
  assert.match(integrity.statement, /cannot tell whether it changed/u);
});

test("inspection reads a bundle without creating anything and reports what it holds", () => {
  const source = createRunBundle(exportedRun(), "2026-08-25T00:00:00.000Z");
  const inspection = inspectRunBundle(source);
  assert.equal(inspection.integrity.state, "verified");
  assert.equal(inspection.runRef, "R7");
  assert.equal(inspection.pipelineId, "managed-fix");
  assert.equal(inspection.toolVersion, "0.6.12");
  assert.deepEqual(inspection.providers.map((provider) => provider.adapter), ["codex-app-server"]);
  assert.deepEqual(inspection.result.changedFiles, ["src/window.ts"]);
  assert.equal(inspection.result.findings[0].disposition, "unresolved");

  const report = renderRunBundleReport(inspection);
  assert.match(report, /Read-only inspection\. Nothing was created/u);
  assert.match(report, /State: verified/u);
  assert.match(report, /bachata:project-checks: passed/u);
  assert.match(report, /Codex · codex-app-server · model gpt-5-codex/u);
  assert.match(report, /unresolved · Window bound — The upper bound is exclusive/u);
});

test("an unreadable bundle reports its problems instead of pretending to be evidence", () => {
  const inspection = inspectRunBundle("{ not json");
  assert.equal("integrity" in inspection, false);
  const report = renderRunBundleReport(inspection);
  assert.match(report, /could not be read/u);
});

test("a structurally wrong bundle still reports its integrity and its problems", () => {
  const source = JSON.stringify({ version: 1, exportedAt: "2026-08-25T00:00:00.000Z", run: { schema: "other" } });
  const inspection = inspectRunBundle(source);
  assert.equal(inspection.integrity.state, "unrecorded");
  assert.equal(inspection.errors.length > 0, true);
  assert.match(renderRunBundleReport(inspection), /Problems reading this bundle/u);
});

test("only a verified digest is treated as replayable evidence", () => {
  const source = createRunBundle(exportedRun(), "2026-08-25T00:00:00.000Z");
  const verified = inspectRunBundle(source);
  assert.equal(verified.integrity.state, "verified");

  const withoutDigest = JSON.parse(source);
  delete withoutDigest.integrity;
  assert.equal(
    inspectRunBundle(JSON.stringify(withoutDigest)).integrity.state,
    "unrecorded",
    "a bundle with the digest removed must never read as verified",
  );

  const tampered = JSON.parse(source);
  tampered.run.result.changedFiles = ["src/other.ts"];
  assert.equal(inspectRunBundle(JSON.stringify(tampered)).integrity.state, "mismatch");
});

test("the digest covers the export time and the version, not the run section alone", () => {
  const source = createRunBundle(exportedRun(), "2026-08-25T00:00:00.000Z");
  const restamped = JSON.parse(source);
  restamped.exportedAt = "2020-01-01T00:00:00.000Z";
  assert.equal(
    inspectRunBundleIntegrity(restamped).state,
    "mismatch",
    "a rewritten export time still verified",
  );

  const reversioned = JSON.parse(source);
  reversioned.version = 2;
  assert.equal(
    inspectRunBundleIntegrity(reversioned).state,
    "unrecorded",
    "an unknown bundle version must never read as verified",
  );
});
