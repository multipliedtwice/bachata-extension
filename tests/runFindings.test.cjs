const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  groupFindingsByFile,
  parseFindingLocation,
  runFindings,
} = require("../dist/results/findingLocations.js");
const { projectRunResult } = require("../dist/results/projectResult.js");

const typedFinding = (overrides = {}) => ({
  id: "finding-1",
  subject: "Cancellation guard",
  message: "The cancellation guard is missing",
  disposition: "accepted",
  severity: "error",
  location: { file: "src/api/handler.ts", startLine: 42, endLine: 44 },
  evidence: ["Both implementations omit the abort check"],
  challenges: ["Checked whether the caller already guards cancellation"],
  provenance: {
    source: "pipelineDecision",
    stepId: "review-consensus",
    participantIds: ["codex", "claude"],
    decisionStatus: "accepted",
  },
  ...overrides,
});

test("a finding location is read only from a real file reference", () => {
  assert.deepEqual(
    parseFindingLocation("src/api/handler.ts:42 leaks the connection"),
    { file: "src/api/handler.ts", startLine: 42, endLine: 42 },
  );
  assert.deepEqual(
    parseFindingLocation("see `src/a.ts:10-14` for the range"),
    { file: "src/a.ts", startLine: 10, endLine: 14 },
  );
  assert.equal(parseFindingLocation("no location here"), undefined);
  assert.equal(parseFindingLocation("version 1.2:3 is not a file"), undefined);
  assert.equal(parseFindingLocation("src/a.ts:0 is not a line"), undefined);
});

test("only accepted typed model findings and deterministic facts become Problems", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    changedFiles: ["src/a.ts"],
    checks: [{ command: "bachata:project-checks", status: "failed" }],
    unresolvedRisks: ["src/api/handler.ts:42 leaks the connection"],
    finalRuling: "- src/webview/main.ts:11 misses the guard\n- general remark with no location",
    rulingBy: "codex",
    findings: [
      typedFinding(),
      typedFinding({ id: "proposed", disposition: "proposed", message: "Proposed claim" }),
      typedFinding({ id: "rejected", disposition: "rejected", message: "Rejected claim" }),
      typedFinding({ id: "unresolved", disposition: "unresolved", message: "Needs human" }),
    ],
    expectations: { changedFiles: true, verification: true, finalRuling: true },
  });
  const findings = runFindings(result);
  assert.deepEqual(
    findings.map((finding) => [finding.source, finding.severity, finding.file ?? null]),
    [
      ["check", "error", null],
      ["modelFinding", "error", "src/api/handler.ts"],
    ],
  );
});

test("single-provider, invalid, and free-text claims never become actionable", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [
      { kind: "error", text: "src/recovered.ts:2 transient failure", timestamp: "2026-08-25T00:00:00.000Z", agentId: "codex", step: "review" },
      { kind: "answer", text: "recovered", timestamp: "2026-08-25T00:00:01.000Z", agentId: "codex", step: "review" },
    ],
    finalRuling: "- src/legacy.ts:7 looks wrong",
    rulingBy: "codex",
    providers: [{ name: "Codex", adapter: "codex-app-server" }],
    findings: [
      typedFinding({
        provenance: {
          source: "stepOutput",
          stepId: "review",
          participantIds: ["codex"],
        },
      }),
      typedFinding({ id: "invalid", disposition: "unknown" }),
    ],
    expectations: { changedFiles: false, verification: false, finalRuling: true },
  });
  assert.equal(result.findings.length, 2);
  assert.equal(result.findings.every((finding) => finding.disposition === "proposed"), true);
  assert.equal(
    result.findings.some((finding) => finding.provenance.source === "legacyRuling"),
    true,
  );
  assert.deepEqual(runFindings(result), []);
});

test("failed and timed-out checks plus missing evidence remain independently actionable", () => {
  const result = projectRunResult({
    status: "completed",
    transcript: [],
    checks: [
      { command: "pass", status: "passed" },
      { command: "fail", status: "failed" },
      { command: "timeout", status: "timedOut" },
      { command: "cancel", status: "cancelled" },
    ],
    expectations: { changedFiles: true, verification: true, finalRuling: false },
  });
  assert.deepEqual(
    runFindings(result).map((finding) => [finding.source, finding.message]),
    [
      ["check", "fail failed"],
      ["check", "timeout timedOut"],
      ["gap", "Changed files: Changed-file evidence was not recorded"],
    ],
  );
});

test("contract-aware evidence keeps not-applicable entries out of Problems", () => {
  const review = projectRunResult({
    status: "completed",
    transcript: [],
    expectations: { changedFiles: false, verification: false, finalRuling: false },
  });
  assert.deepEqual(runFindings(review), []);

  const promised = projectRunResult({
    status: "completed",
    transcript: [],
    expectations: { changedFiles: true, verification: true, finalRuling: true },
  });
  assert.deepEqual(
    runFindings(promised).map((finding) => finding.source),
    ["gap", "gap", "gap"],
  );
});

test("a finding pointing outside the repository is never published to a file", () => {
  const root = path.resolve("/work/repo");
  const grouped = groupFindingsByFile(
    [
      { message: "inside", severity: "warning", source: "modelFinding", file: "src/a.ts", startLine: 3, endLine: 3 },
      { message: "escape", severity: "warning", source: "modelFinding", file: "../other/b.ts", startLine: 3, endLine: 3 },
      { message: "absolute escape", severity: "warning", source: "modelFinding", file: path.resolve("/etc/passwd"), startLine: 1, endLine: 1 },
      { message: "no location", severity: "information", source: "gap" },
    ],
    root,
  );
  assert.deepEqual([...grouped.located.keys()], [path.join(root, "src", "a.ts")]);
  assert.deepEqual(grouped.unlocated.map((finding) => finding.message), [
    "escape",
    "absolute escape",
    "no location",
  ]);
});
