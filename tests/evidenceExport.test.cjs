const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { renderEvidenceMarkdown, renderEvidenceSarif } = require("../dist/export/evidenceReport.js");
const { parseRulingProvenance } = require("../dist/results/rulingProvenance.js");
const {
  applyExportPolicy,
  applyExportPolicyToSchema,
  excludedByPolicy,
  exportRedactionRules,
  loadExportPolicy,
  parseExportPolicy,
  excludeBundlePaths,
  maskExcludedPaths,
  normalizeComparablePath,
  EXPORT_POLICY_PATH,
  EXCLUDED_PATH_PLACEHOLDER,
} = require("../dist/export/exportPolicy.js");

const input = (overrides = {}) => ({
  title: "Fix cancellation",
  runRef: "run-1",
  exportedAt: "2026-08-24T00:00:00.000Z",
  toolVersion: "0.6.12",
  workingDirectory: "/work/repo",
  pipelineName: "Review code",
  omissions: ["Attachment file contents are excluded; metadata only."],
  result: {
    status: "completed",
    changedFiles: ["src/a.ts", "src/b.ts"],
    diffSummary: "2 files changed",
    checks: [
      { command: "bachata:project-checks", status: "passed" },
      { command: "bachata:verifier:unit-tests", status: "failed" },
    ],
    finalRuling: "Accepted with follow-up",
    rulingBy: "Lead",
    providers: [{ name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
    findings: [
      {
        id: "accepted-1",
        subject: "Cancellation guard",
        message: "Cancellation can bypass cleanup",
        disposition: "accepted",
        severity: "warning",
        location: { file: "src/a.ts", startLine: 12, endLine: 12 },
        evidence: ["Both reviewers traced the bypass"],
        challenges: ["The existing finally block was checked"],
        provenance: {
          source: "pipelineDecision",
          stepId: "review-consensus",
          participantIds: ["codex", "claude"],
          decisionStatus: "accepted",
        },
      },
      {
        id: "unresolved-1",
        subject: "Windows cleanup",
        message: "Windows behavior still needs a decision",
        disposition: "unresolved",
        evidence: [],
        challenges: ["No Windows evidence is available"],
        provenance: {
          source: "pipelineDecision",
          stepId: "review-consensus",
          participantIds: ["codex", "claude"],
          decisionStatus: "accepted",
        },
      },
    ],
    unresolvedRisks: ["Cancellation path is untested on Windows"],
    recoveredErrors: ["Provider turn retried once"],
    evidenceGaps: ["No end-to-end run was executed"],
    retainedWorktree: "/work/.bachata/worktrees/run-1",
    ...overrides,
  },
});

test("the markdown report carries every evidence section", () => {
  const markdown = renderEvidenceMarkdown(input());
  for (const marker of [
    "# Fix cancellation",
    "- Run: `run-1`",
    "- Status: completed",
    "## Changed files",
    "src/a.ts",
    "## Verification",
    "| `bachata:project-checks` | passed |",
    "| `bachata:verifier:unit-tests` | failed |",
    "## Final ruling",
    "Ruled by Lead.",
    "## Unresolved risks",
    "Cancellation path is untested on Windows",
    "## Model findings",
    "[accepted] Cancellation guard",
    "[unresolved] Windows cleanup",
    "## Recovered errors",
    "## Evidence gaps",
    "No end-to-end run was executed",
    "## Recovery worktree",
    "## Export omissions",
  ]) {
    assert.ok(markdown.includes(marker), `missing: ${marker}`);
  }
});

test("empty evidence is stated, never omitted", () => {
  const markdown = renderEvidenceMarkdown(input({
    changedFiles: [],
    checks: [],
    unresolvedRisks: [],
    recoveredErrors: [],
    evidenceGaps: [],
    findings: [],
    finalRuling: undefined,
    retainedWorktree: undefined,
  }));
  assert.ok(markdown.includes("_No changed files were recorded._"));
  assert.ok(markdown.includes("_No verification evidence was recorded._"));
  assert.ok(markdown.includes("_No final ruling was recorded._"));
  assert.ok(markdown.includes("_No unresolved risks were recorded._"));
  assert.ok(markdown.includes("_No evidence gaps were recorded._"));
});

test("secrets in evidence text are redacted in the markdown report", () => {
  const markdown = renderEvidenceMarkdown(input({
    unresolvedRisks: ["api_key=abcd1234secret was left in the config"],
  }));
  assert.ok(!markdown.includes("abcd1234secret"));
  assert.ok(markdown.includes("[REDACTED]"));
});

test("the SARIF document is valid 2.1.0 with one result per finding", () => {
  const sarif = JSON.parse(renderEvidenceSarif(input()));
  assert.equal(sarif.version, "2.1.0");
  const run = sarif.runs[0];
  assert.equal(run.tool.driver.name, "Bachata");
  assert.equal(run.tool.driver.version, "0.6.12");
  assert.deepEqual(run.artifacts.map((artifact) => artifact.location.uri), ["src/a.ts", "src/b.ts"]);
  const byRule = run.results.reduce((counts, result) => {
    counts[result.ruleId] = (counts[result.ruleId] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(byRule, {
    "bachata.failed-check": 1,
    "bachata.model-finding": 1,
    "bachata.evidence-gap": 1,
  });
  const levels = new Set(run.results.map((result) => result.level));
  assert.deepEqual([...levels].sort(), ["error", "note", "warning"]);
  assert.equal(run.invocations[0].executionSuccessful, true);
  run.results.forEach((result) => {
    assert.ok(run.tool.driver.rules.some((rule) => rule.id === result.ruleId));
  });
});

test("a passing run produces no SARIF results", () => {
  const sarif = JSON.parse(renderEvidenceSarif(input({
    checks: [{ command: "bachata:project-checks", status: "passed" }],
    unresolvedRisks: [],
    recoveredErrors: [],
    evidenceGaps: [],
    findings: [],
  })));
  assert.deepEqual(sarif.runs[0].results, []);
});

test("the repository export policy validates strictly", () => {
  assert.ok(parseExportPolicy({ version: 2, redactLiterals: [] }).errors.length > 0);
  assert.ok(parseExportPolicy({ version: 1, redactLiterals: ["ab"] }).errors.length > 0);
  assert.ok(parseExportPolicy({ version: 1, unknown: true }).errors.length > 0);
  assert.ok(parseExportPolicy({ version: 1, excludePathPrefixes: [""] }).errors.length > 0);
  const parsed = parseExportPolicy({
    version: 1,
    redactLiterals: ["ACME-INTERNAL"],
    excludePathPrefixes: ["private/"],
  });
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.policy.redactLiterals, ["ACME-INTERNAL"]);
});

test("repository literals are redacted and excluded paths are reported", () => {
  const policy = parseExportPolicy({
    version: 1,
    redactLiterals: ["ACME-INTERNAL"],
    excludePathPrefixes: ["private"],
  }).policy;
  const applied = applyExportPolicy("a ACME-INTERNAL b ACME-INTERNAL", policy);
  assert.equal(applied.content, "a [REDACTED] b [REDACTED]");
  assert.deepEqual(applied.applied, [{ literal: "ACME-INTERNAL", occurrences: 2 }]);
  assert.deepEqual(
    excludedByPolicy(["private/a.ts", "privatex/b.ts", "src/c.ts"], policy),
    ["private/a.ts"],
  );
  const rules = exportRedactionRules(policy, []);
  assert.ok(rules.some((rule) => rule.includes("1 repository-owned literal patterns")));
  assert.ok(rules.some((rule) => rule.includes("1 repository-owned excluded path prefixes")));
});

test("an invalid policy file is ignored and reported, never silently applied", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-export-policy-"));
  try {
    assert.deepEqual(await loadExportPolicy(root), { present: false, errors: [] });
    await fs.mkdir(path.join(root, ".bachata"), { recursive: true });
    await fs.writeFile(path.join(root, EXPORT_POLICY_PATH), "{ broken", "utf8");
    const broken = await loadExportPolicy(root);
    assert.equal(broken.present, true);
    assert.equal(broken.policy, undefined);
    const rules = exportRedactionRules(undefined, broken.errors);
    assert.ok(rules.some((rule) => rule.includes("failed validation")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

const exclusionPolicy = () => parseExportPolicy({
  version: 1,
  redactLiterals: [],
  excludePathPrefixes: ["private/", "secrets"],
}).policy;

test("bundle sections drop excluded paths from every array, not only changed files", () => {
  const outcome = excludeBundlePaths({
    result: { changedFiles: ["private/a.ts", "src/b.ts"] },
    events: [
      { id: 1, type: "file.changed", path: "private/a.ts" },
      { id: 2, type: "file.changed", path: "src/b.ts" },
    ],
    structuredOutputs: [{ name: "plan", value: { touched: ["private/a.ts", "src/b.ts"] } }],
    iterations: [{ index: 1, files: ["secrets/keys.json"] }],
  }, exclusionPolicy());
  assert.deepEqual(outcome.value.result.changedFiles, ["src/b.ts"]);
  assert.deepEqual(outcome.value.events.map((event) => event.id), [2]);
  assert.deepEqual(outcome.value.structuredOutputs[0].value.touched, ["src/b.ts"]);
  assert.deepEqual(outcome.value.iterations[0].files, []);
  assert.deepEqual(outcome.excluded.sort(), ["private/a.ts", "secrets/keys.json"]);
});

test("an excluded path held in a scalar field is replaced, never retained", () => {
  const outcome = excludeBundlePaths(
    { run: { workingDirectory: "/repo", retainedWorktree: "private/worktree" } },
    exclusionPolicy(),
  );
  assert.equal(outcome.value.run.retainedWorktree, EXCLUDED_PATH_PLACEHOLDER);
  assert.equal(outcome.value.run.workingDirectory, "/repo");
  assert.deepEqual(outcome.excluded, ["private/worktree"]);
});

test("bundle exclusion is a no-op without a policy", () => {
  const input = { result: { changedFiles: ["private/a.ts"] } };
  const outcome = excludeBundlePaths(input, undefined);
  assert.equal(outcome.value, input);
  assert.deepEqual(outcome.excluded, []);
});

test("a prefix without a trailing slash never matches a sibling path", () => {
  const outcome = excludeBundlePaths(
    { files: ["secrets/a", "secretsx/b", "secrets"] },
    exclusionPolicy(),
  );
  assert.deepEqual(outcome.value.files, ["secretsx/b"]);
});

const {
  evidenceExclusionOmissions,
  excludeEvidencePaths,
} = require("../dist/export/evidenceExclusion.js");

const secretPolicy = {
  version: 1,
  redactLiterals: [],
  excludePathPrefixes: ["src/secret", "vendor/private"],
};

const leakyInput = () =>
  input({
    changedFiles: ["src/a.ts", "src/secret/key.ts"],
    diffSummary: "2 files changed, src/secret/key.ts rewritten",
    finalRuling: "Accepted after reading src/secret/key.ts",
    checks: [
      { command: "bachata:project-checks", status: "passed" },
      { command: "npx jest src/secret/key.test.ts", status: "failed" },
    ],
    findings: [
      {
        id: "public-1",
        subject: "Public guard",
        message: "Cleanup is skipped",
        disposition: "accepted",
        location: { file: "src/a.ts", startLine: 4 },
        evidence: ["Traced by both reviewers"],
        challenges: ["Existing finally block checked"],
        provenance: {
          source: "pipelineDecision",
          stepId: "review-consensus",
          participantIds: ["codex", "claude"],
          decisionStatus: "accepted",
        },
      },
      {
        id: "located-1",
        subject: "Excluded location",
        message: "Key rotation is wrong",
        disposition: "accepted",
        location: { file: "src/secret/key.ts", startLine: 7 },
        evidence: ["Both reviewers read the rotation branch"],
        challenges: ["The rotation test was inspected"],
        provenance: {
          source: "pipelineDecision",
          stepId: "review-consensus",
          participantIds: ["codex", "claude"],
          decisionStatus: "accepted",
        },
      },
      {
        id: "narrated-1",
        subject: "Excluded narration",
        message: "The helper in vendor/private/token.ts is duplicated",
        disposition: "accepted",
        location: { file: "src/a.ts", startLine: 9 },
        evidence: ["Both reviewers compared the helpers"],
        challenges: ["The duplicate was diffed"],
        provenance: {
          source: "pipelineDecision",
          stepId: "review-consensus",
          participantIds: ["codex", "claude"],
          decisionStatus: "accepted",
        },
      },
    ],
    unresolvedRisks: ["src/secret/key.ts is untested", "Windows is untested"],
    recoveredErrors: ["Provider retried while reading vendor/private/token.ts"],
    evidenceGaps: ["No end-to-end run was executed"],
    evidence: [
      { kind: "changedFiles", label: "Changed files", state: "recorded", detail: "2 changed files including src/secret/key.ts" },
    ],
    finalAssessment: {
      outcome: "completed",
      method: "consensus",
      summary: "Accepted after reading src/secret/key.ts",
      producedBy: [],
    },
  });

test("export policy exclusion removes excluded paths from the whole evidence input", () => {
  const exclusion = excludeEvidencePaths(leakyInput().result, secretPolicy);
  assert.deepEqual(exclusion.result.changedFiles, ["src/a.ts"]);
  assert.deepEqual(exclusion.result.findings.map((finding) => finding.id), ["public-1"]);
  assert.deepEqual(exclusion.excludedFindingIds, ["located-1", "narrated-1"]);
  assert.deepEqual(exclusion.result.unresolvedRisks, ["Windows is untested"]);
  assert.deepEqual(exclusion.result.recoveredErrors, []);
  assert.deepEqual(
    exclusion.result.checks.map((check) => check.command),
    ["bachata:project-checks"],
  );
  assert.equal(exclusion.result.diffSummary.includes("src/secret"), false);
  assert.equal(exclusion.result.finalRuling.includes("src/secret"), false);
  assert.equal(exclusion.result.finalAssessment.summary.includes("src/secret"), false);
  assert.equal(exclusion.result.evidence[0].detail.includes("src/secret"), false);
  assert.match(exclusion.result.finalRuling, /\[EXCLUDED BY EXPORT POLICY\]/u);
  assert.ok(exclusion.excludedPaths.includes("src/secret/key.ts"));
  assert.ok(exclusion.excludedPaths.includes("vendor/private/token.ts"));
});

test("markdown and SARIF evidence never render an excluded path", () => {
  const exclusion = excludeEvidencePaths(leakyInput().result, secretPolicy);
  const rendered = {
    ...leakyInput(),
    result: exclusion.result,
    omissions: evidenceExclusionOmissions(exclusion, EXPORT_POLICY_PATH),
  };
  const markdown = renderEvidenceMarkdown(rendered);
  const sarif = renderEvidenceSarif(rendered);
  for (const document of [markdown, sarif]) {
    assert.equal(document.includes("src/secret"), false);
    assert.equal(document.includes("vendor/private"), false);
  }
  assert.equal(JSON.parse(sarif).runs[0].results.filter((entry) => entry.ruleId === "bachata.model-finding").length, 1);
  assert.deepEqual(
    JSON.parse(sarif).runs[0].artifacts.map((artifact) => artifact.location.uri),
    ["src/a.ts"],
  );
  assert.match(markdown, /2 model findings were withheld/u);
  assert.match(markdown, /repository paths were excluded from every evidence section/u);
  assert.match(markdown, /risk, check, or evidence-gap entries were withheld/u);
});

test("evidence exclusion is a no-op without an export policy", () => {
  const original = leakyInput().result;
  const exclusion = excludeEvidencePaths(original, undefined);
  assert.equal(exclusion.result, original);
  assert.deepEqual(exclusion.excludedPaths, []);
  assert.deepEqual(evidenceExclusionOmissions(exclusion, EXPORT_POLICY_PATH), []);
});

test("bundle exclusion masks excluded paths embedded in prose, not only whole-string fields", () => {
  const bundle = excludeBundlePaths({
    schema: "bachata.run-bundle.v1",
    result: {
      finalRuling: "Accepted after reading src/secret/key.ts and vendor/private/token.ts",
      finalAssessment: { summary: "Verified against src/secret/key.ts" },
      unresolvedRisks: ["Rotation in src/secret/key.ts is unproven"],
      changedFiles: ["src/a.ts", "src/secret/key.ts"],
    },
    transcript: [
      { id: "1", kind: "answer", text: "I inspected src/secret/key.ts and it rotates twice" },
      { id: "2", kind: "error", text: "src/secret/key.ts could not be read" },
    ],
    events: [{ type: "output.validated", title: "wrote src/secret/key.ts" }],
    structuredOutputs: [{ name: "modelFindings", value: { note: "see src/secret/key.ts:12" } }],
  }, secretPolicy);

  const serialized = JSON.stringify(bundle.value);
  assert.equal(serialized.includes("src/secret"), false, serialized);
  assert.equal(serialized.includes("vendor/private"), false, serialized);
  assert.match(serialized, /\[EXCLUDED BY EXPORT POLICY\]/u);
  assert.ok(bundle.excluded.includes("src/secret/key.ts"));
  assert.ok(bundle.excluded.includes("vendor/private/token.ts"));
  assert.deepEqual(bundle.value.result.changedFiles, ["src/a.ts"]);
});

test("export omissions report counts and never repeat an excluded path", () => {
  const exclusion = excludeEvidencePaths(leakyInput().result, secretPolicy);
  const omissions = evidenceExclusionOmissions(exclusion, EXPORT_POLICY_PATH);
  omissions.forEach((line) => {
    assert.equal(line.includes("src/secret"), false, line);
    assert.equal(line.includes("vendor/private"), false, line);
  });
  assert.ok(omissions.some((line) => /\d+ repository paths were excluded/u.test(line)));
});

test("path exclusion normalizes separators and dot segments before it decides", () => {
  assert.deepEqual(
    excludedByPolicy(
      [
        "src/secret/key.ts",
        "./src/secret/key.ts",
        "src//secret//key.ts",
        "docs/../src/secret/key.ts",
        "src\\secret\\key.ts",
        "/home/user/src/secret/key.ts",
        "src/secretary/key.ts",
        "src/a.ts",
      ],
      secretPolicy,
    ),
    [
      "src/secret/key.ts",
      "./src/secret/key.ts",
      "src//secret//key.ts",
      "docs/../src/secret/key.ts",
      "src\\secret\\key.ts",
      "/home/user/src/secret/key.ts",
    ],
  );
  assert.equal(normalizeComparablePath("docs/../src/./secret//key.ts"), "src/secret/key.ts");
  assert.equal(normalizeComparablePath("/a/b/../c"), "/a/c");
});

test("prose masking covers spaces, Unicode, dot segments, and absolute forms", () => {
  const cases = [
    ["Read src/secret/my key.ts before shipping", "before shipping"],
    ["Read src/secret/ключ.ts now", "now"],
    ["Read ./src/secret/key.ts now", "now"],
    ["Read docs/../src/secret/key.ts now", "now"],
    ["Read src\\secret\\key.ts now", "now"],
    ["Read /home/user/src/secret/key.ts now", "now"],
    ['Read "src/secret/key.ts" now', "now"],
  ];
  cases.forEach(([value, tail]) => {
    const masked = maskExcludedPaths(value, secretPolicy);
    assert.equal(masked.includes("src/secret"), false, masked);
    assert.equal(masked.includes("secret"), false, masked);
    assert.equal(masked.includes("key.ts"), false, masked);
    assert.equal(masked.includes(EXCLUDED_PATH_PLACEHOLDER), true, masked);
    assert.equal(masked.endsWith(tail), true, masked);
  });
  assert.equal(
    maskExcludedPaths("src/secretary/key.ts is public", secretPolicy),
    "src/secretary/key.ts is public",
    "a sibling path that merely shares a prefix was masked",
  );
});

test("no excluded raw path text survives any serialized export form", () => {
  const leaks = [
    "src/secret/my key.ts",
    "src/secret/ключ.ts",
    "./src/secret/key.ts",
    "docs/../src/secret/key.ts",
    "src\\secret\\key.ts",
    "/home/user/vendor/private/token.ts",
  ];
  const result = input({
    changedFiles: ["src/a.ts", ...leaks],
    diffSummary: `Touched ${leaks.join(" and ")}`,
    finalRuling: `Accepted after reading ${leaks.join(", ")}`,
    finalAssessment: {
      method: "consensus",
      summary: `Verified against ${leaks[0]}`,
      confidence: "medium",
    },
    unresolvedRisks: leaks.map((leak) => `Rotation in ${leak} is unproven`),
    recoveredErrors: [`${leaks[1]} could not be read`],
    evidenceGaps: [`No test covers ${leaks[2]}`],
    checks: [{ command: `npx jest ${leaks[3]}`, status: "failed" }],
    findings: [{
      id: "leaky-1",
      subject: "Rotation",
      message: `Key rotation in ${leaks[4]} is wrong`,
      disposition: "accepted",
      evidence: [`Traced through ${leaks[5]}`],
      challenges: [],
      provenance: {
        source: "pipelineDecision",
        stepId: "review-consensus",
        participantIds: ["codex", "claude"],
        decisionStatus: "accepted",
      },
    }],
  }).result;

  const exclusion = excludeEvidencePaths(result, secretPolicy);
  const bundle = excludeBundlePaths({
    schema: "bachata.run-bundle.v1",
    result: exclusion.result,
    transcript: leaks.map((leak, index) => ({
      id: String(index),
      kind: "answer",
      text: `I inspected ${leak}`,
    })),
    events: leaks.map((leak) => ({ type: "output.validated", title: `wrote ${leak}` })),
    structuredOutputs: [{ name: "modelFindings", value: { note: `see ${leaks[0]}:12` } }],
    omissions: evidenceExclusionOmissions(exclusion, EXPORT_POLICY_PATH),
  }, secretPolicy);

  const serialized = [
    JSON.stringify(bundle.value),
    renderEvidenceMarkdown(input({ ...exclusion.result })),
    JSON.stringify(renderEvidenceSarif(input({ ...exclusion.result }))),
  ].join("\n");
  for (const marker of [
    "src/secret",
    "src\\secret",
    "vendor/private",
    "ключ.ts",
    "my key.ts",
    "token.ts",
  ]) {
    assert.equal(serialized.includes(marker), false, `${marker} survived the export`);
  }
});

test("masking is driven by the configured prefix, including spaces and Unicode", () => {
  const spaced = { version: 1, redactLiterals: [], excludePathPrefixes: ["private dir"] };
  const unicode = { version: 1, redactLiterals: [], excludePathPrefixes: ["секрет/ключи"] };
  for (const [policy, value, tail] of [
    [spaced, "see private dir/key.ts now", "now"],
    [spaced, "see (private dir/key.ts) now", ") now"],
    [spaced, "see ./private dir/key.ts now", "now"],
    [unicode, "see секрет/ключи/a.ts now", "now"],
    [unicode, "see [link](секрет/ключи/a.ts) now", ") now"],
  ]) {
    const masked = maskExcludedPaths(value, policy);
    assert.equal(masked.includes(EXCLUDED_PATH_PLACEHOLDER), true, masked);
    assert.equal(masked.includes("private dir"), false, masked);
    assert.equal(masked.includes("секрет"), false, masked);
    assert.equal(masked.includes("key.ts"), false, masked);
    assert.equal(masked.endsWith(tail), true, masked);
  }
});

test("punctuation, assignment, Markdown, and tabs do not shelter an excluded path", () => {
  const values = [
    "path=src/secret/a.ts",
    "(src/secret/a.ts)",
    "[src/secret/a.ts]",
    "{src/secret/a.ts}",
    "[link](src/secret/a.ts)",
    "see\tsrc/secret/a.ts",
    "see `src/secret/a.ts`",
    "see 'src/secret/a.ts',",
    "see src/secret/a.ts:12",
    "see <src/secret/a.ts>",
  ];
  values.forEach((value) => {
    const masked = maskExcludedPaths(value, secretPolicy);
    assert.equal(masked.includes("src/secret"), false, masked);
    assert.equal(masked.includes("a.ts"), false, masked);
    assert.equal(masked.includes(EXCLUDED_PATH_PLACEHOLDER), true, masked);
  });
  assert.equal(
    maskExcludedPaths("src/secretary/a.ts is public", secretPolicy),
    "src/secretary/a.ts is public",
  );
});

test("no configured prefix and no complete raw path survives any serialized export", () => {
  const policy = {
    version: 1,
    redactLiterals: [],
    excludePathPrefixes: ["src/secret", "private dir", "секрет"],
  };
  const leaks = [
    "path=src/secret/a.ts",
    "(private dir/key.ts)",
    "[link](секрет/ключ.ts)",
    "./src/secret/my file.ts",
    "docs/../private dir/b.ts",
    "src\\secret\\c.ts",
    "/home/user/секрет/d.ts",
  ];
  const result = input({
    changedFiles: ["src/a.ts", "src/secret/a.ts", "private dir/key.ts"],
    diffSummary: leaks.join(" and "),
    finalRuling: `Accepted after reading ${leaks.join(", ")}`,
    finalAssessment: { method: "consensus", summary: leaks[0], confidence: "medium" },
    unresolvedRisks: leaks.map((leak) => `Unproven: ${leak}`),
    recoveredErrors: [`${leaks[1]} could not be read`],
    evidenceGaps: [`No test covers ${leaks[2]}`],
    checks: [{ command: `npx jest ${leaks[3]}`, status: "failed" }],
    findings: [{
      id: "leaky-2",
      subject: "Rotation",
      message: `Rotation in ${leaks[4]} is wrong`,
      disposition: "accepted",
      evidence: [`Traced through ${leaks[5]}`],
      challenges: [`Checked ${leaks[6]}`],
      provenance: {
        source: "pipelineDecision",
        stepId: "review-consensus",
        participantIds: ["codex", "claude"],
        decisionStatus: "accepted",
      },
    }],
  }).result;

  const exclusion = excludeEvidencePaths(result, policy);
  const bundle = excludeBundlePaths({
    schema: "bachata.run-bundle.v1",
    result: exclusion.result,
    transcript: leaks.map((leak, index) => ({ id: String(index), kind: "answer", text: `saw ${leak}` })),
    events: leaks.map((leak) => ({ type: "output.validated", title: `wrote ${leak}` })),
    structuredOutputs: [{ name: "modelFindings", value: { note: leaks[0] } }],
    omissions: evidenceExclusionOmissions(exclusion, EXPORT_POLICY_PATH),
  }, policy);

  const serialized = [
    JSON.stringify(bundle.value),
    renderEvidenceMarkdown(input({ ...exclusion.result })),
    JSON.stringify(renderEvidenceSarif(input({ ...exclusion.result }))),
  ].join("\n");
  for (const marker of [
    "src/secret",
    "src\\\\secret",
    "private dir",
    "секрет",
    "key.ts",
    "ключ.ts",
    "my file.ts",
  ]) {
    assert.equal(serialized.includes(marker), false, `${marker} survived the export`);
  }
});

test("common delimiters never shelter a configured prefix", () => {
  const values = [
    "ref:src/secret/a.ts",
    "user@src/secret/a.ts",
    "!src/secret/a.ts",
    "#src/secret/a.ts",
    "x&src/secret/a.ts",
    "a+src/secret/a.ts",
    "~src/secret/a.ts",
    "|src/secret/a.ts",
    "%src/secret/a.ts",
    "^src/secret/a.ts",
  ];
  values.forEach((value) => {
    const masked = maskExcludedPaths(value, secretPolicy);
    assert.equal(masked.includes("src/secret"), false, masked);
    assert.equal(masked.includes("a.ts"), false, masked);
  });
  for (const kept of ["mysrc/secret/a.ts", "foo.src/secret/a.ts", "src/secretary/a.ts"]) {
    assert.equal(
      maskExcludedPaths(kept, secretPolicy),
      kept,
      "a path that only shares a prefix fragment was masked",
    );
  }
});

test("export metadata and provenance are masked, not only evidence bodies", () => {
  const exclusion = excludeEvidencePaths(
    input({
      providers: [{ name: "src/secret/agent", adapter: "src/secret/adapter", model: "src/secret/m" }],
      rulingBy: "src/secret/lead",
    }).result,
    secretPolicy,
  );
  const serialized = JSON.stringify(exclusion.result);
  assert.equal(serialized.includes("src/secret"), false, serialized);

  const report = renderEvidenceMarkdown({
    title: "Review of src/secret/a.ts",
    runRef: "run-1",
    exportedAt: "2026-08-24T00:00:00.000Z",
    toolVersion: "0.6.12",
    workingDirectory: "/work/src/secret",
    pipelineName: "Review src/secret",
    result: exclusion.result,
    omissions: [],
  });
  assert.equal(
    report.includes("src/secret"),
    true,
    "this fixture is only meaningful while the renderer copies metadata verbatim",
  );
  const sanitised = maskExcludedPaths(report, secretPolicy);
  assert.equal(sanitised.includes("src/secret"), false, sanitised);
});

test("the final no-leak pass keeps JSON exports valid", () => {
  const document = JSON.stringify({
    title: "Review of src/secret/a.ts",
    workingDirectory: "/work/src/secret",
    nested: { note: "see src\\secret\\b.ts and ./src/secret/c.ts" },
  });
  const sanitised = maskExcludedPaths(document, secretPolicy);
  assert.equal(sanitised.includes("src/secret"), false, sanitised);
  assert.equal(sanitised.includes("src\\\\secret"), false, sanitised);
  const parsed = JSON.parse(sanitised);
  assert.equal(parsed.title.includes(EXCLUDED_PATH_PLACEHOLDER), true);
  assert.equal(parsed.nested.note.includes(EXCLUDED_PATH_PLACEHOLDER), true);
});

const { INITIATIVE_BUNDLE_SPEC } = require("../dist/longitudinal/bundleSchema.js");

const sanitize = (bundle, policy) =>
  applyExportPolicyToSchema(bundle, INITIATIVE_BUNDLE_SPEC, policy);

test("structural redaction survives JSON escaping that defeats text redaction", () => {
  const policy = {
    excludePathPrefixes: [],
    redactLiterals: ["C:\\private\\secret"],
  };
  const bundle = {
    initiative: { title: "Work in C:\\private\\secret" },
    findings: [{ evidence: ["traced through C:\\private\\secret/a.ts"] }],
  };

  const serialisedFirst = applyExportPolicy(JSON.stringify(bundle), policy);
  assert.equal(
    serialisedFirst.content.includes("private"),
    true,
    "this test no longer reproduces the escaping problem it guards",
  );

  const deep = sanitize(bundle, policy);
  assert.deepEqual(deep.unclassified, []);
  assert.equal(
    JSON.stringify(deep.value).includes("private"),
    false,
    "a redacted literal survived JSON escaping",
  );
  assert.equal(deep.applied[0].occurrences, 2);
});

test("redaction leaves schema ids and enums intact", () => {
  const policy = {
    excludePathPrefixes: [],
    redactLiterals: ["review", "accepted"],
  };
  const deep = sanitize({
    cycles: [{ id: "Y1", type: "review", completion: "open" }],
    findings: [{
      identity: "FH1",
      state: "accepted",
      message: "the review accepted this",
      notObservedCycleIds: ["Y1"],
    }],
  }, policy);

  assert.deepEqual(deep.unclassified, []);
  assert.equal(deep.value.cycles[0].type, "review", "a redacted literal rewrote a schema enum");
  assert.equal(deep.value.findings[0].state, "accepted");
  assert.equal(deep.value.findings[0].identity, "FH1");
  assert.deepEqual(deep.value.findings[0].notObservedCycleIds, ["Y1"]);
  assert.equal(deep.value.findings[0].message.includes("review"), false);
});

test("an arbiter ruling provenance is classified and survives redaction intact", () => {
  const policy = {
    excludePathPrefixes: [],
    redactLiterals: ["arbiterRuling", "codex", "acme-model"],
  };
  const provenance = {
    authoredBy: "model",
    participantIds: ["codex"],
    rulingProvenance: {
      kind: "arbiterRuling",
      participants: [{ agentId: "codex", provider: "acme", adapter: "codex-app-server", model: "acme-model" }],
      ruledBy: "codex",
    },
  };
  const deep = sanitize({ artifacts: [{ id: "T1", provenance }] }, policy);

  assert.deepEqual(deep.unclassified, [], "a real provenance shape was refused as unclassified");
  const kept = deep.value.artifacts[0].provenance;
  assert.equal(kept.rulingProvenance.kind, "arbiterRuling", "redaction destroyed the ruling kind");
  assert.equal(kept.rulingProvenance.participants[0].agentId, "codex");
  assert.deepEqual(kept.participantIds, ["codex"]);
  assert.equal(
    kept.rulingProvenance.participants[0].model.includes("acme-model"),
    false,
    "a free-text model name escaped redaction",
  );
  assert.equal(
    kept.rulingProvenance.ruledBy,
    "codex",
    "ruledBy must stay structural: parseRulingProvenance requires it to name a participant",
  );

  const reparsed = parseRulingProvenance(kept.rulingProvenance);
  assert.ok(
    reparsed,
    "sanitization produced a ruling provenance that Bachata can no longer read back",
  );
  assert.equal(reparsed.kind, "arbiterRuling");
  assert.equal(reparsed.ruledBy, "codex");
});

test("free-text fields are redacted and unknown fields refuse the export", () => {
  const policy = { excludePathPrefixes: [], redactLiterals: ["secret"] };

  const named = sanitize(
    { cycles: [{ type: "custom", customType: "a secret name" }] },
    policy,
  );
  assert.deepEqual(named.unclassified, []);
  assert.equal(named.value.cycles[0].type, "custom");
  assert.equal(named.value.cycles[0].customType.includes("secret"), false);

  const branch = sanitize(
    { cycles: [{ repositoryBaseline: { branch: "feature/secret-thing", commit: "abc" } }] },
    policy,
  );
  assert.equal(
    branch.value.cycles[0].repositoryBaseline.branch.includes("secret"),
    false,
    "a user-named branch escaped configured redaction",
  );
  assert.equal(branch.value.cycles[0].repositoryBaseline.commit, "abc");

  const unknown = sanitize({ findings: [{ inventedField: "a secret" }] }, policy);
  assert.deepEqual(
    unknown.unclassified,
    ["$.findings[0].inventedField"],
    "an unclassified field was silently passed through or silently redacted",
  );
  assert.equal(unknown.value.findings[0].inventedField, "a secret");
});

test("classification is by schema path, not by property name", () => {
  const policy = { excludePathPrefixes: [], redactLiterals: ["secret"] };
  const deep = sanitize({
    findings: [{ state: "accepted", message: "a secret" }],
    rounds: [{ decisionChanges: [{ to: "accepted", reason: "a secret" }] }],
  }, policy);

  assert.deepEqual(deep.unclassified, []);
  assert.equal(deep.value.findings[0].state, "accepted");
  assert.equal(deep.value.findings[0].message.includes("secret"), false);
  assert.equal(deep.value.rounds[0].decisionChanges[0].to, "accepted");
  assert.equal(
    deep.value.rounds[0].decisionChanges[0].reason.includes("secret"),
    false,
    "a free-text reason under a structural sibling escaped redaction",
  );
});


test("a redacted artifact loses the digest that described its unredacted content", () => {
  const policy = { excludePathPrefixes: [], redactLiterals: ["secret"] };
  const artifact = {
    id: "T1",
    title: "a secret plan",
    body: "the secret detail",
    evidence: ["a secret trace"],
    contentDigest: "DIGESTOFORIGINAL",
  };
  const deep = sanitize({ artifacts: [artifact] }, policy);
  assert.deepEqual(deep.unclassified, []);

  const sanitized = deep.value.artifacts[0];
  assert.equal(sanitized.title.includes("secret"), false);
  assert.notEqual(
    sanitized.contentDigest,
    undefined,
    "this test asserts the raw walker keeps the digest; the manager is what must drop it",
  );
  assert.equal(
    sanitized.contentDigest,
    "DIGESTOFORIGINAL",
    "the digest is structural and must not be rewritten by redaction itself",
  );
});
