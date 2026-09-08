const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MANAGED_LEAD_REVIEW_MARKER,
  MANAGED_LEAD_REVIEW_SCHEMA,
  MANAGED_WORKER_REVISION_MARKER,
  managedLeadDecision,
  managedLeadReviewPrompt,
  managedWorkerRevisionPrompt,
} = require("../dist/runtime/managedLeadReview.js");
const { TASK_REVIEW_VERDICT_SCHEMA } = require("../dist/pipeline/candidateShapes.js");

// P3. The decision a managed local Lead's answer makes.
//
// The combined harness proves this end to end through a real orchestration run. What is proved
// here is the decision itself, exhaustively and cheaply: every shape of answer that must not be an
// acceptance, and the two that are valid. A run-level test can show that one bad answer fails; it
// cannot enumerate them.

const CANDIDATE = "a".repeat(64);

const defect = (overrides = {}) => ({
  id: "missing-guard",
  severity: "blocker",
  statement: "The exported value is the placeholder.",
  requiredChange: "Export the delivered value.",
  evidence: ["src/feature.mjs:1"],
  ...overrides,
});

const answer = (value) => JSON.stringify(value);

const decide = (value, candidate = CANDIDATE, currentCandidate = CANDIDATE) =>
  managedLeadDecision({
    answer: typeof value === "string" ? value : answer(value),
    candidate,
    currentCandidate,
  });

test("the review envelope reuses the repository's own review verdict shape", () => {
  // Not a second definition of what a defect is: the same schema, wrapped in the binding that
  // ties a verdict to a candidate.
  assert.equal(MANAGED_LEAD_REVIEW_SCHEMA.properties.review, TASK_REVIEW_VERDICT_SCHEMA);
  assert.deepEqual(MANAGED_LEAD_REVIEW_SCHEMA.required, ["candidate", "review"]);
  assert.equal(MANAGED_LEAD_REVIEW_SCHEMA.additionalProperties, false);
});

test("an acceptance with no defects is the one answer that lets a run advance", () => {
  assert.deepEqual(
    decide({ candidate: CANDIDATE, review: { verdict: "accept", summary: "Ready.", defects: [] } }),
    { decision: "accept", summary: "Ready." },
  );
  // Whitespace around the document is insignificant and does not change the verdict.
  assert.deepEqual(
    decide(`\n\n  ${answer({ candidate: CANDIDATE, review: { verdict: "accept", summary: "Ready.", defects: [] } })}  \n`),
    { decision: "accept", summary: "Ready." },
  );
});

test("the verdict contract is exactly one JSON object, and framing is not an answer", () => {
  // THE BOUNDARY THIS GUARDS. The prompt says "Return exactly one JSON object and nothing else",
  // and the answer is read as an authorization to advance a candidate — not as a work product.
  //
  // This used to be parsed with the shared `parseJsonResponse`, which is deliberately forgiving:
  // it strips a fence, and failing that extracts the outermost balanced object from anywhere in
  // the answer. Under it every framed case below authorized the candidate, and the prose the Lead
  // wrote around the object — a reservation, a second verdict, a note — was silently discarded.
  // A verdict is not improved by being guessed at, so framing is refused rather than recovered.
  const accepting = { candidate: CANDIDATE, review: { verdict: "accept", summary: "Ready.", defects: [] } };
  const rejecting = { candidate: CANDIDATE, review: { verdict: "reject", summary: "No.", defects: [defect()] } };

  // The two bare documents that ARE the contract still pass, so the strictness is about framing
  // and not about refusing valid answers.
  assert.equal(decide(accepting).decision, "accept");
  assert.equal(decide(rejecting).decision, "reject");

  const framed = [
    ["a prose prefix", `Here is my verdict: ${answer(accepting)}`],
    ["a prose suffix", `${answer(accepting)} Hope that helps.`],
    ["a stated reservation after the object", `${answer(accepting)} I will fix the rest later.`],
    ["a fenced block", `\`\`\`json\n${answer(accepting)}\n\`\`\``],
    ["an unlabelled fenced block", `\`\`\`\n${answer(accepting)}\n\`\`\``],
    ["a fenced block with commentary", `Here is my review:\n\`\`\`json\n${answer(accepting)}\n\`\`\`\nLet me know.`],
    ["two JSON objects", `${answer(rejecting)}\n${answer(accepting)}`],
    ["a valid object followed by non-whitespace", `${answer(accepting)} ]]]`],
  ];
  for (const [name, text] of framed) {
    const decision = decide(text);
    assert.equal(decision.decision, "invalid", `${name} was read as a verdict`);
    assert.match(
      decision.problems.join("\n"),
      /exactly one JSON object and nothing else/u,
      `${name} did not say why it was refused`,
    );
  }

  // The two-object case is the sharpest: an extraction-based parser recovered the FIRST balanced
  // span, so a Lead that rejected and then restated could have either answer obeyed depending on
  // ordering. Neither is obeyed now.
  assert.equal(decide(`${answer(accepting)}\n${answer(rejecting)}`).decision, "invalid");
});

test("a rejection carries the defects a Worker is meant to repair", () => {
  const decision = decide({
    candidate: CANDIDATE,
    review: { verdict: "reject", summary: "Not ready.", defects: [defect()] },
  });
  assert.equal(decision.decision, "reject");
  assert.equal(decision.summary, "Not ready.");
  assert.deepEqual(decision.defects, [
    {
      id: "missing-guard",
      severity: "blocker",
      statement: "The exported value is the placeholder.",
      requiredChange: "Export the delivered value.",
      evidence: ["src/feature.mjs:1"],
    },
  ]);
  // Severity is optional and evidence defaults to empty, so a minimal defect is still actionable.
  const minimal = decide({
    candidate: CANDIDATE,
    review: {
      verdict: "reject",
      summary: "Not ready.",
      defects: [{ id: "x", statement: "wrong", requiredChange: "fix it", evidence: [] }],
    },
  });
  assert.deepEqual(minimal.defects, [
    { id: "x", statement: "wrong", requiredChange: "fix it", evidence: [] },
  ]);
});

test("every way of not answering fails closed", () => {
  const unusable = [
    ["prose", "The implementation is ready."],
    ["an empty answer", ""],
    ["JSON that is not an object", answer([1, 2, 3])],
    ["no candidate", { review: { verdict: "accept", summary: "ok", defects: [] } }],
    ["an empty candidate", { candidate: "", review: { verdict: "accept", summary: "ok", defects: [] } }],
    ["no review", { candidate: CANDIDATE }],
    ["a review that is not an object", { candidate: CANDIDATE, review: "accept" }],
    ["no verdict", { candidate: CANDIDATE, review: { summary: "ok", defects: [] } }],
    ["a verdict that is neither", { candidate: CANDIDATE, review: { verdict: "maybe", summary: "ok", defects: [] } }],
    ["no summary", { candidate: CANDIDATE, review: { verdict: "accept", defects: [] } }],
    ["no defects field", { candidate: CANDIDATE, review: { verdict: "accept", summary: "ok" } }],
    ["an extra field", { candidate: CANDIDATE, extra: 1, review: { verdict: "accept", summary: "ok", defects: [] } }],
    ["an acceptance with defects", { candidate: CANDIDATE, review: { verdict: "accept", summary: "ok", defects: [defect()] } }],
    ["a rejection with none", { candidate: CANDIDATE, review: { verdict: "reject", summary: "no", defects: [] } }],
    ["a defect with no required change", {
      candidate: CANDIDATE,
      review: { verdict: "reject", summary: "no", defects: [{ id: "x", statement: "wrong", evidence: [] }] },
    }],
    ["more defects than the bound allows", {
      candidate: CANDIDATE,
      review: {
        verdict: "reject",
        summary: "no",
        defects: Array.from({ length: 11 }, (_, index) => defect({ id: `d${String(index)}` })),
      },
    }],
  ];
  for (const [name, value] of unusable) {
    const decision = decide(value);
    assert.equal(decision.decision, "invalid", name);
    assert.ok(decision.problems.length > 0, name);
  }
});

test("a verdict about another candidate is not a verdict about this one", () => {
  const accepting = { candidate: "b".repeat(64), review: { verdict: "accept", summary: "ok", defects: [] } };
  const decision = decide(accepting);
  assert.equal(decision.decision, "invalid");
  assert.match(decision.problems[0], /names candidate b{64}, and the controller verified a{64}/u);
});

test("a candidate that moved while the Lead was reading it cannot be accepted", () => {
  // The Lead is read-only and the checks bound their results to a fingerprint; if the tree is no
  // longer that tree, the verdict describes something that no longer exists. This is checked
  // before the answer is even parsed, so a perfectly formed acceptance cannot pass it.
  const decision = managedLeadDecision({
    answer: answer({ candidate: CANDIDATE, review: { verdict: "accept", summary: "ok", defects: [] } }),
    candidate: CANDIDATE,
    currentCandidate: "c".repeat(64),
  });
  assert.equal(decision.decision, "invalid");
  assert.match(decision.problems[0], /changed while the Lead was reviewing it/u);
});

test("the Lead is told the candidate, the controller's results and the exact shape of an answer", () => {
  const prompt = managedLeadReviewPrompt({
    candidate: CANDIDATE,
    issues: [],
    evidence: [
      { id: "project-checks", command: "bachata:project-checks", status: "passed", exitCode: 0, output: "" },
    ],
  });
  assert.ok(prompt.startsWith(MANAGED_LEAD_REVIEW_MARKER));
  assert.match(prompt, /^check: project-checks$/mu);
  assert.match(prompt, /^command: bachata:project-checks$/mu);
  assert.match(prompt, /^status: passed$/mu);
  assert.match(prompt, /^exit: 0$/mu);
  assert.match(prompt, /^output: \(none\)$/mu);
  assert.match(prompt, new RegExp(`^Candidate: ${CANDIDATE}$`, "mu"));
  assert.match(prompt, /^Required verification: every declared check is passing\.$/mu);
  assert.match(prompt, /Return exactly one JSON object and nothing else/u);
  // A failing pass names what is failing rather than reporting an absence of bad news.
  const failing = managedLeadReviewPrompt({
    candidate: CANDIDATE,
    issues: ["project-checks: failed"],
    evidence: [],
  });
  assert.match(failing, /^Required verification: project-checks: failed$/mu);
});

test("a revising Worker is told what the Lead said and what the controller found, kept apart", () => {
  const prompt = managedWorkerRevisionPrompt({
    candidate: CANDIDATE,
    summary: "Not ready.",
    defects: [defect(), { id: "bare", statement: "also wrong", requiredChange: "fix that too", evidence: [] }],
    evidence: [
      { id: "workspace-integrity", command: "bachata:workspace-integrity", status: "passed", output: "" },
    ],
  });
  assert.ok(prompt.startsWith(MANAGED_WORKER_REVISION_MARKER));
  assert.match(prompt, new RegExp(`reviewed candidate ${CANDIDATE} and did not accept it: Not ready\\.`, "u"));
  assert.match(prompt, /Defects the Lead named \(the Lead's own words, not a check result\)/u);
  assert.match(prompt, /^1\. \[missing-guard\] \(blocker\) The exported value is the placeholder\.$/mu);
  assert.match(prompt, /^ {3}required change: Export the delivered value\.$/mu);
  assert.match(prompt, /^ {3}evidence cited: src\/feature\.mjs:1$/mu);
  // A defect with no severity and no cited evidence prints neither, rather than printing empty
  // parentheses or an empty citation line.
  assert.match(prompt, /^2\. \[bare\] also wrong$/mu);
  assert.equal((prompt.match(/^ {3}evidence cited: /gmu) ?? []).length, 1);
  assert.match(prompt, /Bachata controller verification against that same candidate/u);
  assert.match(prompt, /^check: workspace-integrity$/mu);
  assert.match(prompt, /^exit: n\/a$/mu);
  assert.match(prompt, /do not report check results of your own/u);
  // A rejection with no summary still reads as a sentence.
  assert.match(
    managedWorkerRevisionPrompt({ candidate: CANDIDATE, summary: "", defects: [defect()], evidence: [] }),
    new RegExp(`reviewed candidate ${CANDIDATE} and did not accept it\\.`, "u"),
  );
});
