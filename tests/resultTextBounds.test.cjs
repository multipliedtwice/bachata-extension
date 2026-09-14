const assert = require("node:assert/strict");
const test = require("node:test");
const { readableResultMarkdown, scrubOpaqueResultTokens, parseResultStructuredText } = require("../dist/results/readableResult.js");
const { boundedResultInput, boundedResultValue, boundedMarkdown, RESULT_OMISSION_NOTICE } = require("../dist/results/boundedResultInput.js");
const { RESULT_TEXT_LIMITS } = require("../dist/results/textLimits.js");
const { resultHandoffFixture, largeResultHandoffFixture } = require("./fixtures/resultHandoff.cjs");

const assertCompleteUnicode = (text) => {
  assert.doesNotMatch(text, /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/u);
  assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
};

test("thousands of every result entry remain bounded, deterministic and explicitly incomplete", () => {
  const source = largeResultHandoffFixture(4_096);
  const before = structuredClone(source);
  const first = readableResultMarkdown(source);
  assert.ok(first.length <= RESULT_TEXT_LIMITS.readableMarkdownUnits);
  assert.equal(first, readableResultMarkdown(source));
  for (const expected of [
    "# Run result: Completed", "The lead should review", "The review is unresolved.",
    "Recorded disposition: unresolved", "Review risk 0", "No independent evidence for concern 0",
    "src/worker-0.ts", "node scripts/verify-0.cjs", "Participant conclusion 1 (unresolved)", RESULT_OMISSION_NOTICE,
  ]) assert.ok(first.includes(expected), `Missing prioritized result material: ${expected}`);
  assert.doesNotMatch(first, /Review concern 4095|Review risk 4095|Participant review 4095/u);
  assertCompleteUnicode(first);
  assert.deepEqual(source, before);
});

test("aggregate entry traversal does not access arrays beyond the bounded prefix", () => {
  const source = resultHandoffFixture();
  const values = Array.from({ length: RESULT_TEXT_LIMITS.maximumSectionEntries + 10 }, (_, index) => `Risk ${index}`);
  Object.defineProperty(values, RESULT_TEXT_LIMITS.maximumSectionEntries, {
    get() { throw new Error("Unbounded traversal reached an excluded array entry"); },
  });
  source.unresolvedRisks = values;
  const bounded = boundedResultInput(source);
  assert.equal(bounded.omitted, true);
  assert.equal(bounded.result.unresolvedRisks.length, RESULT_TEXT_LIMITS.maximumSectionEntries);
  assert.ok(readableResultMarkdown(source).includes(RESULT_OMISSION_NOTICE));
});

test("oversized owning records are discarded whole without detaching their evidence", () => {
  const source = resultHandoffFixture();
  source.findings[0].location.file = "src/" + "x".repeat(RESULT_TEXT_LIMITS.maximumEntryTextUnits);
  source.findings[0].message = "Detached evidence must not be retained.";
  const before = structuredClone(source);
  const bounded = boundedResultInput(source);
  assert.equal(bounded.omitted, true);
  assert.deepEqual(bounded.result.findings, []);
  assert.doesNotMatch(readableResultMarkdown(source), /Detached evidence must not be retained/u);
  assert.deepEqual(source, before);
});

test("large nested arrays and objects cannot consume unbounded traversal work", () => {
  const source = resultHandoffFixture();
  source.finalDecision = {
    status: "accepted", stepId: "review", candidate: { summary: "Do not detach this summary.", evidence: Array(100_000).fill("evidence") },
    participants: [], objections: [], unresolvedRisks: [],
  };
  const text = readableResultMarkdown(source);
  assert.ok(text.includes(RESULT_OMISSION_NOTICE));
  assert.match(text, /selected ruling material was omitted/u);
  assert.doesNotMatch(text, /Do not detach this summary|Review the source and confirm the lead recommendation/u);
  assert.ok(text.length <= RESULT_TEXT_LIMITS.readableMarkdownUnits);
});

test("nested cycles and excessive depth fail closed without mutating input", () => {
  const source = resultHandoffFixture();
  const candidate = { summary: "Do not detach cyclic evidence." };
  candidate.details = candidate;
  source.finalDecision = { status: "pending", stepId: "review", participants: [{ candidate }], objections: [], unresolvedRisks: [] };
  const text = readableResultMarkdown(source);
  assert.match(text, /The review is unresolved/u);
  assert.ok(text.includes(RESULT_OMISSION_NOTICE));
  assert.doesNotMatch(text, /Do not detach cyclic evidence/u);
  assert.equal(candidate.details, candidate);
});

test("very large strings are omitted whole before parsing or Markdown truncation", () => {
  const source = resultHandoffFixture();
  source.finalAssessment.summary = "Assessment " + "😀".repeat(RESULT_TEXT_LIMITS.maximumEntryTextUnits);
  source.finalRuling = '{"summary":"' + "x".repeat(RESULT_TEXT_LIMITS.maximumEntryTextUnits) + '","sessionId":"hidden-session"}';
  const before = structuredClone(source);
  const text = readableResultMarkdown(source);
  assert.ok(text.includes(RESULT_OMISSION_NOTICE));
  assert.match(text, /Assessment details were omitted/u);
  assert.doesNotMatch(text, /hidden-session|sessionId|\{"|😀/u);
  assertCompleteUnicode(text);
  assert.deepEqual(source, before);
});

test("malformed JSON-like prose with unmatched braces remains bounded and deterministic", () => {
  const source = resultHandoffFixture();
  source.finalRuling = 'Review the lead evidence. ' + '{"summary":'.repeat(1_000) + '"sessionId":"hidden-session"';
  const text = readableResultMarkdown(source);
  assert.equal(text, readableResultMarkdown(source));
  assert.ok(text.length <= RESULT_TEXT_LIMITS.readableMarkdownUnits);
  assert.match(text, /Review the lead evidence/u);
  assert.doesNotMatch(text, /hidden-session|sessionId|\{"/u);
  assert.equal(parseResultStructuredText("{".repeat(RESULT_TEXT_LIMITS.maximumEntryTextUnits + 1)).structured, true);
});

test("structured strings with thousands of primitive entries report bounded projection omissions", () => {
  const source = resultHandoffFixture();
  source.finalRuling = JSON.stringify({ evidence: Array(2_048).fill("ok") });
  const text = readableResultMarkdown(source);
  assert.ok(text.length <= RESULT_TEXT_LIMITS.readableMarkdownUnits);
  assert.ok(text.includes(RESULT_OMISSION_NOTICE));
  assert.equal(text, readableResultMarkdown(source));
});

test("bounded Markdown retains complete fences and never cuts a surrogate pair", () => {
  const emojiBlock = "Review งานตรวจสอบ 😀".repeat(40);
  const fence = "```json\n{\"summary\": \"งานตรวจสอบ 😀\"}\n```";
  const maximumUnits = RESULT_OMISSION_NOTICE.length + emojiBlock.length + fence.length + 10;
  const text = boundedMarkdown([emojiBlock, fence, "x".repeat(maximumUnits)], maximumUnits);
  assert.ok(text.length <= maximumUnits);
  assert.ok(text.includes(emojiBlock));
  assert.ok(text.includes(fence));
  assert.ok(text.endsWith(RESULT_OMISSION_NOTICE));
  assert.equal((text.match(/^```/gmu) ?? []).length, 2);
  assertCompleteUnicode(text);
});

test("incomplete fences and invalid surrogate strings are omitted without breaking surrounding Markdown", () => {
  const text = boundedMarkdown(["Review the lead evidence.", "```json\n{\"summary\":\"incomplete\"}", "Risk \ud83d"], 1_000);
  assert.match(text, /Review the lead evidence/u);
  assert.ok(text.includes(RESULT_OMISSION_NOTICE));
  assert.doesNotMatch(text, /```|incomplete|Risk/u);
  assertCompleteUnicode(text);
  assert.throws(() => boundedMarkdown(["text"], 1), /room for the omission notice/u);
});

test("local readable copy retains useful local paths and ordinary short identity words after bounding", () => {
  const source = largeResultHandoffFixture();
  const prose = "The lead will review the session reference, file evidence, feedback, cafe and deadbeef labels.";
  source.finalAssessment.summary = prose;
  source.changedFiles.unshift("src/local.ts", "/Users/developer/workspace/src/local.ts", "package-lock.json");
  source.findings[0].location.file = "/Users/developer/workspace/src/local.ts";
  source.executionRef = "reference";
  const text = readableResultMarkdown(source);
  assert.ok(text.includes(prose));
  for (const file of ["src/local.ts", "/Users/developer/workspace/src/local.ts", "package-lock.json"]) assert.ok(text.includes(file));
  assert.ok(text.includes(RESULT_OMISSION_NOTICE));
  assertCompleteUnicode(text);
});

test("opaque identifiers remain absent when oversized metadata cannot be traversed", () => {
  const source = largeResultHandoffFixture();
  const identifier = "q3Fg8Kp1Vt6Ds9Ha2Yw7Lr0Mx";
  const digest = "123abc".repeat(10) + "abcd";
  source.finalAssessment.summary = `The lead should review ${identifier}, ${digest}, and commit abc1234.`;
  source.metadata = { details: Array(100_000).fill(identifier) };
  const text = readableResultMarkdown(source);
  assert.match(text, /The lead should review/u);
  assert.ok(!text.includes(identifier));
  assert.ok(!text.includes(digest));
  assert.doesNotMatch(text, /abc1234/u);
  assert.ok(text.length <= RESULT_TEXT_LIMITS.readableMarkdownUnits);
});

test("optional opaque source traversal is bounded independently of readable formatting", () => {
  const source = { metadata: Array(100_000).fill({ sessionId: "q3Fg8Kp1Vt6Ds9Ha2Yw7Lr0Mx" }) };
  const text = scrubOpaqueResultTokens("Review q3Fg8Kp1Vt6Ds9Ha2Yw7Lr0Mx and the lead evidence.", source);
  assert.match(text, /Review/u);
  assert.match(text, /the lead evidence/u);
  assert.doesNotMatch(text, /q3Fg8Kp1Vt6Ds9Ha2Yw7Lr0Mx/u);
  assert.equal(boundedResultValue(source).omitted, true);
});

test("result output limits preserve complete higher priority sections before additional entries", () => {
  const source = resultHandoffFixture();
  source.findings = Array.from({ length: 64 }, (_, index) => ({
    ...source.findings[0], id: `finding-${index}`, subject: `Finding ${index}`, message: "Review evidence. ".repeat(200),
  }));
  const text = readableResultMarkdown(source, { maximumUnits: 8_192 });
  assert.ok(text.length <= 8_192);
  for (const expected of ["## Final assessment", "## Final ruling", "Recorded disposition: unresolved", "## Unresolved risks", "## Evidence gaps", "## Changed files", "## Verification"]) assert.ok(text.includes(expected));
  assert.ok(text.includes(RESULT_OMISSION_NOTICE));
  assert.equal(text, readableResultMarkdown(source, { maximumUnits: 8_192 }));
});
