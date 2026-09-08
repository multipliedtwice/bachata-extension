const assert = require("node:assert/strict");
const test = require("node:test");

const {
  exportConfirmationDetail,
  exportDisclosureRules,
  runExportPlan,
} = require("../dist/export/exportPlan.js");
const { EXPORT_POLICY_PATH, EXPORT_REVIEW_WARNING } = require("../dist/export/exportPolicy.js");

// EX-3. What an export is called, how it is rendered, what it says it removed, and when it is
// refused. These were decisions taken between a runtime read and a save dialog inside the
// conversation manager, reachable only by driving a whole export through a stubbed VS Code — which
// is why the run export and the initiative export had drifted into two hand-written copies of the
// same disclosure. Driven directly, each answer is one call.

test("a request with no format asks for the run bundle", () => {
  const { plan } = runExportPlan({ hasEvidence: false, runRef: "run-1" });
  assert.equal(plan.format, "bundle");
  assert.equal(plan.render, "bundle");
  assert.equal(plan.reseal, true);
  assert.equal(plan.language, "json");
  assert.equal(plan.fileName, "run-1.bachata-run.json");
  assert.deepEqual(plan.saveFilter, { "Bachata export": ["json"] });
  assert.equal(plan.prompt, "Export run bundle?");
});

test("each evidence format names its own file, renderer and preview language", () => {
  const markdown = runExportPlan({ format: "markdown", hasEvidence: true, runRef: "run-2" }).plan;
  assert.equal(markdown.render, "markdown");
  assert.equal(markdown.reseal, false, "a rendered report is not a bundle and must not be resealed");
  assert.equal(markdown.language, "markdown");
  assert.equal(markdown.fileName, "run-2.bachata-evidence.md");
  assert.deepEqual(markdown.saveFilter, { "Bachata evidence report": ["md"] });
  assert.equal(markdown.prompt, "Export evidence as Markdown?");

  const sarif = runExportPlan({ format: "sarif", hasEvidence: true, runRef: "run-2" }).plan;
  assert.equal(sarif.render, "sarif");
  assert.equal(sarif.reseal, false);
  assert.equal(sarif.language, "json");
  assert.equal(sarif.fileName, "run-2.bachata-evidence.sarif.json");
  assert.deepEqual(sarif.saveFilter, { "Bachata export": ["json"] });
  assert.equal(sarif.prompt, "Export evidence as SARIF?");
});

test("a run with no recorded result is refused an evidence export, and offered the bundle", () => {
  for (const format of ["markdown", "sarif"]) {
    const verdict = runExportPlan({ format, hasEvidence: false, runRef: "run-3" });
    assert.equal(verdict.refusal, "This run has no recorded result to export as evidence", format);
    assert.equal(verdict.plan, undefined, "a refused export still handed back a plan");
  }
  // The bundle is what a run without a result can still produce, so it is not refused with it.
  assert.equal(runExportPlan({ format: "bundle", hasEvidence: false, runRef: "run-3" }).refusal, undefined);
});

test("the disclosure counts what was removed without naming the paths it removed", () => {
  const rules = exportDisclosureRules({
    policy: { version: 1, redactLiterals: ["secret-one"], excludePathPrefixes: ["internal/"] },
    policyErrors: [],
    excluded: 2,
    literals: [{ occurrences: 1 }, { occurrences: 3 }],
  });
  assert.ok(rules.includes(`2 paths were excluded by ${EXPORT_POLICY_PATH}.`));
  assert.ok(rules.includes("Repository literal redacted 1 time."));
  assert.ok(rules.includes("Repository literal redacted 3 times."));
  assert.equal(
    rules.some((rule) => rule.includes("internal/") && rule.includes("excluded by")),
    false,
    "the disclosure named an excluded path, which is what the exclusion exists to withhold",
  );
});

test("nothing removed is stated as nothing removed, not as zero of something", () => {
  const rules = exportDisclosureRules({
    policy: undefined,
    policyErrors: [],
    excluded: 0,
    literals: [],
  });
  assert.equal(rules.some((rule) => rule.includes("were excluded")), false);
  assert.equal(rules.some((rule) => rule.includes("Repository literal redacted")), false);
  assert.ok(rules.length > 0, "the standing redaction rules are always disclosed");
});

test("a caller that words its own exclusion line keeps it", () => {
  const rules = exportDisclosureRules({
    policy: undefined,
    policyErrors: [],
    excluded: 4,
    excludedNote: "4 paths were excluded from every bundle section.",
    literals: [],
  });
  assert.ok(rules.includes("4 paths were excluded from every bundle section."));
});

test("a policy that failed to load is disclosed rather than passed over", () => {
  const rules = exportDisclosureRules({
    policy: undefined,
    policyErrors: ["excludePathPrefixes must be an array of strings"],
    excluded: 0,
    literals: [],
  });
  assert.ok(rules.some((rule) => rule.includes("failed validation")));
});

test("the confirmation states the size that would be written and ends with the warning", () => {
  const detail = exportConfirmationDetail({ content: "é", rules: ["one rule"] });
  const lines = detail.split("\n");
  assert.equal(lines[0], "Size: 2 bytes.", "size was measured in code units, not UTF-8 bytes");
  assert.ok(lines.includes("Applied redaction rules:"));
  assert.ok(lines.includes("- one rule"));
  assert.equal(lines[lines.length - 1], EXPORT_REVIEW_WARNING);
});

test("a caller with a contents line puts it directly under the size", () => {
  const detail = exportConfirmationDetail({
    content: "{}",
    rules: [],
    contents: "Contents: 1 cycles, 2 findings, 3 decisions, 4 artifacts.",
  });
  const lines = detail.split("\n");
  assert.equal(lines[0], "Size: 2 bytes.");
  assert.equal(lines[1], "Contents: 1 cycles, 2 findings, 3 decisions, 4 artifacts.");
  assert.equal(
    exportConfirmationDetail({ content: "{}", rules: [] }).split("\n")[1],
    "",
    "an export with no contents line left a gap where one would have been",
  );
});
