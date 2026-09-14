const assert = require("node:assert/strict");
const test = require("node:test");
const { implementationDraftFromResult, implementationHandoffMarkdown } = require("../dist/results/implementationHandoff.js");
const { RESULT_TEXT_LIMITS } = require("../dist/results/textLimits.js");
const { RESULT_OMISSION_NOTICE } = require("../dist/results/boundedResultInput.js");
const { readableResultMarkdown } = require("../dist/results/readableResult.js");
const { isBrowserSourcePath } = require("../dist/browser/sourceTransferPolicy.js");
const { resultHandoffFixture, resultHandoffPlacements } = require("./fixtures/resultHandoff.cjs");

const excludedPaths = [
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "node_modules/library/index.js",
  "nested/dist/output.js", "build/main.js", "out/main.js", ".next/server/index.js",
  "coverage/report.json", "extension.vsix", "release.zip", "artifact.tar.gz",
  "vendor/library.php", "C:\\repo\\node_modules\\library.js", "/private/repo/source.ts",
];

for (const [field, place] of resultHandoffPlacements) {
  for (const file of excludedPaths) {
    test(`the complete implementation draft withholds ${field} content referencing ${file}`, () => {
      assert.equal(isBrowserSourcePath(file), false);
      const source = resultHandoffFixture();
      place(source, `Review [material](<${file}>) before proceeding.\n\n\`\`\`text\nEXCLUDED_PAYLOAD\n\`\`\``);
      const before = structuredClone(source);
      const preparedDraft = implementationDraftFromResult(source);
      assert.ok(!preparedDraft.includes(file));
      assert.doesNotMatch(preparedDraft, /EXCLUDED_PAYLOAD/u);
      assert.match(preparedDraft, /Unresolved findings require confirmation before edits/u);
      assert.match(preparedDraft, /withheld/u);
      assert.deepEqual(source, before);
    });
  }
}

for (const embedded of [
  'Record: {"file":"src/\\u0064ist/out.js","summary":"EXCLUDED_BODY"}',
  '100% complete: {"file":"src/\\u0064ist/out.js","text":"EXCLUDED_BODY"}',
  '100% complete: [material](nested/%64ist/out.js) EXCLUDED_BODY',
  JSON.stringify(["Contents of dist/out.js:", "EXCLUDED_BODY"]),
  "Contents of `node_modules`:\nEXCLUDED_BODY",
  "Generated directory `dist` contains EXCLUDED_BODY",
  "The dependency tree `vendor` contains EXCLUDED_BODY",
  'Record: {"file":"src\\/dist\\/out.js","summary":"EXCLUDED_BODY"}',
  'Record: {"file":"extension.\\u0076six","summary":"EXCLUDED_BODY"}',
  'See [output](nested/%64ist/out.js): EXCLUDED_BODY',
  'See [output](nested/%2564ist/out.js): EXCLUDED_BODY',
  'See [output](nested/&#100;ist/out.js): EXCLUDED_BODY',
  'See [output]: node_modules/example.js\n\n    EXCLUDED_BODY',
  'See `node_modules/example.js:12:4`: EXCLUDED_BODY',
  JSON.stringify({ summary: "Contents of package-lock.json:", text: "EXCLUDED_BODY" }),
  JSON.stringify(JSON.stringify({ location: { file: "nested/dist/out.js" }, text: "EXCLUDED_BODY" })),
]) {
  test(`complete drafts withhold encoded or structured excluded content: ${embedded}`, () => {
    const source = resultHandoffFixture();
    source.finalRuling = embedded;
    const preparedDraft = implementationDraftFromResult(source);
    assert.doesNotMatch(preparedDraft, /EXCLUDED_BODY|package-lock|node_modules|out\.js|extension\./u);
    assert.match(preparedDraft, /The lead should review the build/u);
  });
}

test("a finding cannot detach excluded content from a tainted message or evidence label", () => {
  for (const field of ["message", "evidence", "challenges"]) {
    const source = resultHandoffFixture();
    source.findings[0].message = "EXCLUDED_BODY";
    source.findings[0].evidence = ["EXCLUDED_BODY"];
    source.findings[0].challenges = ["EXCLUDED_BODY"];
    source.findings[0][field] = field === "message" ? "Contents of dist/out.js follow" : ["Contents of dist/out.js follow", "EXCLUDED_BODY"];
    const preparedDraft = implementationDraftFromResult(source);
    assert.doesNotMatch(preparedDraft, /EXCLUDED_BODY|dist\/out/u);
    assert.match(preparedDraft, /withheld/u);
  }
});

test("withholding the selected ruling never substitutes an older conclusion", () => {
  const source = resultHandoffFixture();
  source.finalRuling = "LEGACY_CONCLUSION";
  source.finalDecision = { stepId: "review", status: "ruled", candidate: { file: "dist/out.js", summary: "EXCLUDED_BODY" }, participants: [], objections: [], unresolvedRisks: [] };
  const preparedDraft = implementationDraftFromResult(source);
  assert.doesNotMatch(preparedDraft, /LEGACY_CONCLUSION|EXCLUDED_BODY|dist\/out/u);
  assert.match(preparedDraft, /selected ruling material was withheld/u);
});

for (const [field, place] of resultHandoffPlacements) {
  test(`the complete draft omits opaque identifiers in ${field} without corrupting review prose`, () => {
    const source = resultHandoffFixture();
    const digest = "a7".repeat(32);
    const session = "session-7Gr3Tm9Qa2Zv5Jk8Lp4Wx6Bn";
    const version = "a497c55b-8695-4f70-a2cc-4a0fb736b917";
    const prose = `The lead must review the current source. ${digest} ${session} ${version} git show abc1234`;
    place(source, prose);
    const before = structuredClone(source);
    const preparedDraft = implementationDraftFromResult(source);
    assert.ok(!preparedDraft.includes(digest));
    assert.ok(!preparedDraft.includes(session));
    assert.ok(!preparedDraft.includes(version));
    assert.doesNotMatch(preparedDraft, /abc1234/u);
    assert.match(preparedDraft, /lead.*review/u);
    assert.deepEqual(source, before);
  });
}

test("a safe draft preserves readable local material and ordinary lead review and build words", () => {
  const source = resultHandoffFixture();
  source.finalRuling = "The lead should review the `build` command and the 'out' variable in src/building.ts.";
  const preparedDraft = implementationDraftFromResult(source);
  assert.ok(preparedDraft.includes(readableResultMarkdown(source)));
  assert.match(preparedDraft, /src\/worker\.ts:12/u);
  assert.match(preparedDraft, /node scripts\/verify\.cjs — Failed/u);
  assert.match(preparedDraft, /Recorded disposition: unresolved/u);
  assert.doesNotMatch(preparedDraft, /withheld|internal value omitted/u);
});

test("local copying keeps useful excluded-file names while the automatically generated draft withholds them", () => {
  const source = resultHandoffFixture();
  source.changedFiles.push("package-lock.json", "dist/out.js", "extension.vsix");
  source.checks.push({ command: "node dist/verify.js", status: "failed" });
  const copy = readableResultMarkdown(source);
  const preparedDraft = implementationDraftFromResult(source);
  assert.match(copy, /package-lock\.json|dist\/out\.js|extension\.vsix/u);
  assert.match(copy, /node dist\/verify\.js/u);
  assert.doesNotMatch(preparedDraft, /package-lock\.json|dist\/|extension\.vsix/u);
  assert.match(preparedDraft, /src\/worker\.ts/u);
});


test("thousands of review entries produce deterministic independently bounded copy and complete drafts", () => {
  const source = resultHandoffFixture();
  const finding = source.findings[0];
  source.findings = Array.from({ length: 3_000 }, (_, index) => ({
    ...finding,
    id: `finding-${index}`,
    subject: `Review guard ${index}`,
    evidence: [`Evidence for guard ${index}.`],
    challenges: [`Confirm guard ${index} before editing.`],
  }));
  source.changedFiles = Array.from({ length: 3_000 }, (_, index) => `src/worker-${index}.ts`);
  source.checks = Array.from({ length: 3_000 }, (_, index) => ({ command: `node scripts/check-${index}.cjs`, status: "failed" }));
  source.unresolvedRisks = Array.from({ length: 3_000 }, (_, index) => `Unresolved risk ${index} needs review.`);
  source.evidenceGaps = Array.from({ length: 3_000 }, (_, index) => `Evidence gap ${index} needs confirmation.`);
  source.finalDecision = {
    stepId: "review", status: "pending",
    participants: Array.from({ length: 3_000 }, (_, index) => ({ agentId: "lead", candidate: { summary: `Participant conclusion ${index} remains unresolved.` } })),
    objections: [], unresolvedRisks: [],
  };
  const before = structuredClone(source);
  const copy = readableResultMarkdown(source);
  const handoff = implementationHandoffMarkdown(source);
  const draft = implementationDraftFromResult(source);
  assert.ok(copy.length <= RESULT_TEXT_LIMITS.readableMarkdownUnits);
  assert.ok(handoff.length <= RESULT_TEXT_LIMITS.handoffMarkdownUnits);
  assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
  assert.ok(copy.includes(RESULT_OMISSION_NOTICE));
  assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
  assert.match(draft, /The lead should review the build before edits\./u);
  assert.match(draft, /The review is unresolved\./u);
  assert.match(draft, /Recorded disposition: unresolved/u);
  assert.match(draft, /Unresolved risk 0 needs review\./u);
  assert.match(draft, /Evidence gap 0 needs confirmation\./u);
  assert.equal(implementationHandoffMarkdown(source), handoff);
  assert.equal(implementationDraftFromResult(source), draft);
  assert.equal(readableResultMarkdown(source), copy);
  assert.deepEqual(source, before);
});

for (const [field, place] of resultHandoffPlacements) {
  test(`bounding an oversized ${field} never retains its prefix or a tail source exclusion`, () => {
    const source = resultHandoffFixture();
    const payload = `DETACHED_CONTENT ${"ordinary review evidence ".repeat(RESULT_TEXT_LIMITS.maximumEntryTextUnits)} [excluded](nested/dist/output.js) ${"d8".repeat(32)} session-7Gr3Tm9Qa2Zv5Jk8Lp4Wx6Bn`;
    place(source, payload);
    const before = structuredClone(source);
    const draft = implementationDraftFromResult(source);
    assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
    assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
    assert.doesNotMatch(draft, /DETACHED_CONTENT|nested\/dist|output\.js|d8d8d8d8|session-7Gr3Tm9Qa2Zv5Jk8Lp4Wx6Bn/u);
    assert.deepEqual(source, before);
  });
}

test("oversized nested location, evidence and challenge owners cannot detach excluded content", () => {
  for (const field of ["location", "evidence", "challenges"]) {
    const source = resultHandoffFixture();
    source.findings[0].message = "DETACHED_CONTENT";
    source.findings[0][field] = field === "location"
      ? { file: `${"src/".repeat(RESULT_TEXT_LIMITS.maximumEntryTextUnits)}dist/out.js` }
      : Array.from({ length: RESULT_TEXT_LIMITS.maximumSectionEntries + 1 }, (_, index) => index === RESULT_TEXT_LIMITS.maximumSectionEntries ? "Contents of package-lock.json" : "DETACHED_CONTENT");
    const draft = implementationDraftFromResult(source);
    assert.doesNotMatch(draft, /DETACHED_CONTENT|package-lock|dist\/out/u);
    assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
    assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
  }
});

test("structured and stringified nested arrays are bounded without detaching their prohibited source", () => {
  for (const encode of [JSON.stringify, (value) => JSON.stringify(JSON.stringify(value))]) {
    const source = resultHandoffFixture();
    source.finalRuling = encode({
      location: { file: "package-lock.json" },
      evidence: Array.from({ length: 1_000 }, () => "DETACHED_CONTENT"),
      summary: "DETACHED_CONTENT",
    });
    const before = structuredClone(source);
    const draft = implementationDraftFromResult(source);
    assert.doesNotMatch(draft, /DETACHED_CONTENT|package-lock/u);
    assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
    assert.match(draft, /omitted|withheld/u);
    assert.deepEqual(source, before);
  }
});

test("deeply nested review structures are omitted as complete entries", () => {
  const source = resultHandoffFixture();
  let candidate = { summary: "DETACHED_CONTENT", file: "dist/out.js" };
  for (let depth = 0; depth < RESULT_TEXT_LIMITS.maximumDepth + 4; depth += 1) candidate = { evidence: [candidate] };
  source.finalDecision = { stepId: "review", status: "ruled", candidate, participants: [], objections: [], unresolvedRisks: [] };
  const before = structuredClone(source);
  const draft = implementationDraftFromResult(source);
  assert.doesNotMatch(draft, /DETACHED_CONTENT|dist\/out/u);
  assert.match(draft, /selected ruling material was omitted/u);
  assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
  assert.deepEqual(source, before);
});

test("malformed JSON-like prose with thousands of unmatched braces is deterministic and bounded", () => {
  const source = resultHandoffFixture();
  source.finalAssessment.summary = `The lead should review current evidence. ${'{"summary":'.repeat(5_000)} malformed`;
  source.finalRuling = `Review evidence ${'{"summary":'.repeat(700)} malformed`;
  const before = structuredClone(source);
  const first = implementationDraftFromResult(source);
  assert.ok(first.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
  assert.equal(implementationDraftFromResult(source), first);
  assert.ok(first.includes(RESULT_OMISSION_NOTICE));
  assert.doesNotMatch(first, /\{\s*"summary"/u);
  assert.deepEqual(source, before);
});

test("multibyte prose and code remain whole at the handoff boundary", () => {
  const source = resultHandoffFixture();
  source.finalAssessment.summary = "ตรวจสอบหลักฐานก่อนแก้ไข 🙂 Review the lead decision.";
  const finding = source.findings[0];
  source.findings = Array.from({ length: 50 }, (_, index) => ({
    ...finding,
    id: `finding-${index}`,
    subject: `Review ${index}`,
    message: `\`\`\`text\n${"หลักฐาน🙂 ".repeat(180)}\n\`\`\``,
  }));
  const draft = implementationDraftFromResult(source);
  assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
  assert.match(draft, /ตรวจสอบหลักฐานก่อนแก้ไข 🙂/u);
  assert.doesNotMatch(draft, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  assert.equal((draft.match(/^```/gmu) ?? []).length % 2, 0);
  assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
});

test("bounding keeps ordinary short identity words and allowed local references readable", () => {
  const source = resultHandoffFixture();
  const prose = "The lead should review session and reference evidence in file src/cafe.ts; cafe, face, beef, and dead are ordinary short words.";
  source.finalAssessment.summary = prose;
  source.finalRuling = prose;
  source.unresolvedRisks = [prose];
  source.evidenceGaps = [prose];
  source.metadata = { agentId: "lead", stepId: "review", session: "session", reference: "reference", digest: "beef" };
  source.findings = [...source.findings, ...Array.from({ length: 3_000 }, () => ({ ...source.findings[0], message: "Review current evidence." }))];
  source.changedFiles = ["src/cafe.ts", "package-lock.json", "/private/workspace/src/cafe.ts"];
  const copy = readableResultMarkdown(source);
  const draft = implementationDraftFromResult(source);
  assert.ok(copy.includes(prose));
  assert.ok(copy.includes("/private/workspace/src/cafe.ts"));
  assert.ok(copy.includes("package-lock.json"));
  assert.ok(draft.includes(prose));
  assert.doesNotMatch(draft, /package-lock|\/private\/workspace|internal value omitted/u);
  assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
});

test("a complete prepared draft stays identical through JSON serialization", () => {
  const source = resultHandoffFixture();
  source.findings = Array.from({ length: 3_000 }, (_, index) => ({ ...source.findings[0], subject: `Finding ${index}`, message: "確認🙂 Review current evidence." }));
  const preparedDraft = implementationDraftFromResult(source);
  const restored = JSON.parse(JSON.stringify({ preparedDraft })).preparedDraft;
  assert.ok(preparedDraft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
  assert.equal(restored, preparedDraft);
  assert.ok(restored.includes(RESULT_OMISSION_NOTICE));
});

test("generated drafts normalize textarea line endings and nulls before state installation", () => {
  const source = resultHandoffFixture();
  source.finalAssessment.summary = "Review the lead evidence.\r\nConfirm the current source.\rKeep the session reference readable.\0😀";
  const before = structuredClone(source);
  const preparedDraft = implementationDraftFromResult(source);
  assert.ok(preparedDraft.includes("Review the lead evidence.\nConfirm the current source.\nKeep the session reference readable.\uFFFD😀"));
  assert.doesNotMatch(preparedDraft, /[\r\0]/u);
  assert.equal(JSON.parse(JSON.stringify({ preparedDraft })).preparedDraft, preparedDraft);
  assert.equal(implementationDraftFromResult(source), preparedDraft);
  assert.deepEqual(source, before);
});


test("an exhausted structured scan withholds the entire owner before an excluded tail location", () => {
  const source = resultHandoffFixture();
  source.finalRuling = JSON.stringify({
    summary: "DETACHED_CONTENT",
    evidence: Array.from({ length: RESULT_TEXT_LIMITS.maximumVisitedEntries + 32 }, () => ""),
    location: { file: "dist/out.js" },
  });
  assert.ok(source.finalRuling.length < RESULT_TEXT_LIMITS.maximumEntryTextUnits);
  const before = structuredClone(source);
  const draft = implementationDraftFromResult(source);
  assert.doesNotMatch(draft, /DETACHED_CONTENT|dist\/out/u);
  assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
  assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
  assert.equal(implementationDraftFromResult(source), draft);
  assert.deepEqual(source, before);
});

for (const [field, place] of resultHandoffPlacements) {
  test(`bounded complete drafts remove opaque and prohibited material in ${field}`, () => {
    const source = resultHandoffFixture();
    place(source, `The lead must review evidence. [material](node_modules/library/index.js) ${"d7".repeat(32)} session-7Gr3Tm9Qa2Zv5Jk8Lp4Wx6Bn /private/repo/src/worker.ts`);
    source.findings.push(...Array.from({ length: 3_000 }, () => ({
      ...resultHandoffFixture().findings[0],
      message: "Confirm the current source before edits.",
    })));
    const draft = implementationDraftFromResult(source);
    assert.doesNotMatch(draft, /node_modules|library\/index|d7d7d7d7|session-7Gr3Tm9Qa2Zv5Jk8Lp4Wx6Bn|\/private\/repo/u);
    assert.match(draft, /Unresolved findings require confirmation before edits/u);
    assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
    assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
  });
}


for (const owner of ["failure", "ruling", "human resolution"]) {
  for (const oversized of [false, true]) {
    test(`the complete ${oversized ? "large" : "small"} draft scrubs recorded opaque identity from omitted ${owner} fields`, () => {
      const source = resultHandoffFixture();
      const identifier = "abc1234";
      const prose = `The lead should review session and reference evidence in file src/cafe.ts; cafe, face, beef, and dead stay readable. Review candidate ${identifier} before editing.`;
      source.finalAssessment.summary = prose;
      if (owner === "failure") {
        source.failure = { error: prose, agentId: identifier };
      } else {
        source.finalDecision = {
          stepId: "review", status: "ruled", candidate: { summary: prose }, participants: [], objections: [], unresolvedRisks: [],
          ...(owner === "ruling" ? { ruledBy: identifier } : {
            humanResolution: { action: "acceptParticipant", selectedParticipant: identifier, rationale: prose, resolvedAt: "2026-09-14T00:00:00Z" },
          }),
        };
      }
      if (oversized) {
        source.findings = Array.from({ length: 3_000 }, (_, index) => ({
          ...source.findings[0], id: `finding-${index}`, message: "Review current evidence. ".repeat(200),
        }));
      }
      const before = structuredClone(source);
      const draft = implementationDraftFromResult(source);
      assert.doesNotMatch(draft, /abc1234|agentId|ruledBy|selectedParticipant/u);
      assert.match(draft, /lead should review session and reference evidence in file src\/cafe\.ts/u);
      assert.match(draft, /cafe, face, beef, and dead stay readable/u);
      assert.match(draft, /Review candidate \[internal identifier omitted\] before editing/u);
      assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
      if (oversized) assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
      assert.equal(implementationDraftFromResult(source), draft);
      assert.equal(JSON.parse(JSON.stringify({ preparedDraft: draft })).preparedDraft, draft);
      assert.deepEqual(source, before);
    });
  }
}


test("catalog bounding removes recorded opaque context from visible prose before discarding its owner", () => {
  const { boundedTerminalResult } = require("../dist/results/persistedResult.js");
  const { parseRunResult } = require("../dist/results/projectResult.js");
  const source = resultHandoffFixture();
  const identifier = "a1b2c3d4";
  source.finalAssessment.summary = `The lead should review session and reference evidence in src/cafe.ts. Candidate ${identifier} needs confirmation.`;
  source.finalRuling = "OLDER_RULING_MUST_NOT_REPLACE_OMITTED_CANDIDATE";
  source.finalDecision = {
    status: "ruled", stepId: "review", ruledBy: "lead", participants: [], objections: [], unresolvedRisks: [],
    candidate: { digest: identifier, summary: "OMITTED_CANDIDATE_BODY", evidence: Array(65).fill("Review current source.") },
  };
  source.changedFiles.push("package-lock.json", "dist/output.js");
  const before = structuredClone(source);
  const persisted = boundedTerminalResult(source);
  const restored = parseRunResult(JSON.parse(JSON.stringify(persisted)));
  assert.deepEqual(restored, persisted);
  assert.equal(restored.persistence.omitted, true);
  assert.match(restored.finalDecision.candidate, /omitted/iu);
  const draft = implementationDraftFromResult(restored);
  const copy = readableResultMarkdown(restored);
  assert.doesNotMatch(draft, /a1b2c3d4|OLDER_RULING_MUST_NOT_REPLACE_OMITTED_CANDIDATE|OMITTED_CANDIDATE_BODY|package-lock|dist\/output/u);
  assert.doesNotMatch(copy, /a1b2c3d4|OLDER_RULING_MUST_NOT_REPLACE_OMITTED_CANDIDATE|OMITTED_CANDIDATE_BODY/u);
  assert.match(copy, /package-lock\.json/u);
  assert.match(draft, /The lead should review session and reference evidence in src\/cafe\.ts/u);
  assert.ok(Buffer.byteLength(JSON.stringify(restored), "utf8") <= RESULT_TEXT_LIMITS.catalogJsonBytes);
  assert.deepEqual(source, before);
});

test("catalog omission preserves an unresolved human decision before creating a draft", () => {
  const { boundedTerminalResult } = require("../dist/results/persistedResult.js");
  const { parseRunResult } = require("../dist/results/projectResult.js");
  const source = resultHandoffFixture();
  source.finalDecision = {
    status: "resolved", stepId: "review", participants: [], objections: [], unresolvedRisks: [],
    candidate: { summary: "CANDIDATE_MUST_NOT_BECOME_ACCEPTED" },
    humanResolution: {
      action: "acceptUnresolved", resolvedAt: "2026-09-14T00:00:00.000Z",
      rationale: "Review the evidence first. ".repeat(RESULT_TEXT_LIMITS.maximumEntryTextUnits),
    },
  };
  const before = structuredClone(source);
  const persisted = boundedTerminalResult(source);
  const restored = parseRunResult(JSON.parse(JSON.stringify(persisted)));
  assert.deepEqual(restored, persisted);
  assert.equal(restored.finalDecision.humanResolution.action, "acceptUnresolved");
  assert.match(restored.finalDecision.humanResolution.rationale, /omitted/iu);
  const draft = implementationDraftFromResult(restored);
  assert.match(draft, /finished with unresolved findings/u);
  assert.doesNotMatch(draft, /CANDIDATE_MUST_NOT_BECOME_ACCEPTED/u);
  assert.deepEqual(source, before);
});

test("catalog omission retains failure identity and visible failure meaning in a prepared draft", () => {
  const { boundedTerminalResult } = require("../dist/results/persistedResult.js");
  const { parseRunResult } = require("../dist/results/projectResult.js");
  const source = resultHandoffFixture();
  source.status = "error";
  delete source.finalRuling;
  source.failure = { error: "Provider stopped while reviewing. ".repeat(RESULT_TEXT_LIMITS.maximumEntryTextUnits), agentId: "lead", participant: "Lead", step: "Review" };
  source.finalAssessment = { outcome: "failedBeforeRuling", method: "none", summary: "Work stopped before a final ruling.", producedBy: [], failure: source.failure };
  const before = structuredClone(source);
  const persisted = boundedTerminalResult(source);
  const restored = parseRunResult(JSON.parse(JSON.stringify(persisted)));
  assert.deepEqual(restored, persisted);
  assert.equal(restored.failure.agentId, "lead");
  assert.equal(restored.failure.step, "Review");
  assert.match(restored.failure.error, /omitted/iu);
  assert.deepEqual(restored.finalAssessment.failure, restored.failure);
  const draft = implementationDraftFromResult(restored);
  assert.match(draft, /Run result: Failed/u);
  assert.match(draft, /Failure:/u);
  assert.match(draft, /Work stopped before a final ruling/u);
  assert.deepEqual(source, before);
});


test("selected findings alone become requested work while the lead assessment remains context", () => {
  const source = resultHandoffFixture();
  const first = { ...source.findings[0], id: "chosen", subject: "SELECTED_GUARD", disposition: "accepted" };
  const omitted = { ...source.findings[0], id: "omitted", subject: "UNSELECTED_FINDING", message: "UNSELECTED_DETAIL" };
  source.findings = [first, omitted];
  source.finalAssessment.summary = JSON.stringify({ summary: "LEAD_ASSESSMENT", findings: [omitted] });
  source.finalRuling = JSON.stringify({ summary: "LEAD_RULING", findings: [first, omitted] });
  source.finalDecision = {
    stepId: "review", status: "accepted", candidate: { summary: "LEAD_RULING", findings: [first, omitted] },
    participants: [{ agentId: "lead", candidate: { summary: "UNSELECTED_PARTICIPANT", findings: [omitted] } }],
    objections: [{ text: JSON.stringify({ findings: [omitted] }) }], unresolvedRisks: [],
  };
  source.unresolvedRisks.push(JSON.stringify({ summary: "Risk context remains", findings: [omitted] }));
  source.evidenceGaps.push(`Details: ${JSON.stringify({ findings: [omitted] })}`);
  const before = structuredClone(source);
  const draft = implementationDraftFromResult(source, ["chosen"]);
  assert.match(draft, /Only the selected findings listed below are requested/u);
  assert.match(draft, /LEAD_ASSESSMENT/u);
  assert.match(draft, /LEAD_RULING/u);
  assert.match(draft, /SELECTED_GUARD/u);
  assert.match(draft, /Recorded disposition: accepted/u);
  assert.match(draft, /src\/worker\.ts:12/u);
  assert.match(draft, /Evidence:/u);
  assert.match(draft, /Challenges:/u);
  assert.match(draft, /Risk context remains/u);
  assert.match(draft, /node scripts\/verify\.cjs — Failed/u);
  assert.match(draft, /Unresolved findings require confirmation before edits/u);
  assert.match(draft, /Unselected finding details were omitted/u);
  assert.doesNotMatch(draft, /UNSELECTED_FINDING|UNSELECTED_DETAIL|UNSELECTED_PARTICIPANT/u);
  assert.equal(implementationDraftFromResult(source, ["chosen"]), draft);
  assert.deepEqual(source, before);
});

test("selected handoff ordering follows the recorded result and keeps unresolved findings unconfirmed", () => {
  const source = resultHandoffFixture();
  source.findings.push({ ...source.findings[0], id: "next", subject: "SECOND_SELECTED" });
  const draft = implementationDraftFromResult(source, ["next", "review"]);
  assert.ok(draft.indexOf("Confirm the review guard") < draft.indexOf("SECOND_SELECTED"));
  assert.equal((draft.match(/Recorded disposition: unresolved/gu) ?? []).length, 2);
  assert.match(draft, /Selection does not confirm a finding or change its recorded disposition/u);
  assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
});

for (const selection of [[], ["unknown"], ["review", "review"], [" "], Array(65).fill("review"), ["a".repeat(16_385)]]) {
  test(`selected handoff refuses invalid finding selection ${JSON.stringify(selection).slice(0, 80)}`, () => {
    const source = resultHandoffFixture();
    const before = structuredClone(source);
    assert.throws(() => implementationDraftFromResult(source, selection), /Select at least one finding|selected findings changed/u);
    assert.deepEqual(source, before);
  });
}

test("selected handoff refuses rejected and ambiguously identified findings", () => {
  const source = resultHandoffFixture();
  source.findings[0].disposition = "rejected";
  assert.throws(() => implementationDraftFromResult(source, ["review"]), /Rejected findings cannot/u);
  source.findings[0].disposition = "unresolved";
  source.findings.push({ ...source.findings[0], subject: "Duplicate identity" });
  assert.throws(() => implementationDraftFromResult(source, ["review"]), /selected findings changed/u);
});

test("selected drafts preserve the complete browser exclusion and bounded output contracts", () => {
  const source = resultHandoffFixture();
  const hidden = "a7".repeat(32);
  source.finalDecision = {
    stepId: "review", status: "accepted", candidate: {
      summary: "Keep the lead review ordinary.",
      findings: [{ subject: "UNSELECTED", message: "EXCLUDED_CONTENT", location: { file: "dist/output.js" } }],
    }, participants: [], objections: [], unresolvedRisks: [],
  };
  source.changedFiles.push("package-lock.json", "extension.vsix");
  source.findings[0].message += ` ${hidden}`;
  source.evidenceGaps = Array.from({ length: 3_000 }, (_, index) => `No evidence for concern ${index}`);
  const before = structuredClone(source);
  const draft = implementationDraftFromResult(source, ["review"]);
  assert.ok(draft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
  assert.ok(draft.includes(RESULT_OMISSION_NOTICE));
  assert.match(draft, /Confirm the review guard/u);
  assert.match(draft, /Recorded disposition: unresolved/u);
  assert.doesNotMatch(draft, /UNSELECTED|EXCLUDED_CONTENT|dist\/output|package-lock|extension\.vsix/u);
  assert.ok(!draft.includes(hidden));
  assert.equal(implementationDraftFromResult(source, ["review"]), draft);
  assert.deepEqual(source, before);
});
