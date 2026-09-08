const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applyConfirmationPolicy,
  applyConfirmationQuestion,
  applyConfirmationDetail,
  applySelectionUnprovenNotice,
} = require("../dist/conversations/applyConfirmation.js");

// EX-3. What applying a retained run refuses, asks and discloses. These were strings assembled by
// hand inside the conversation manager's message handler, reachable only by driving a whole apply
// through a stubbed VS Code. Driven directly, each refusal, question and disclosure is one call, so
// the override disclosure a person reads and the question they answer cannot drift apart unseen.

test("a blocked run is refused before anything is asked, with its reason logged and shown", () => {
  const verdict = applyConfirmationPolicy({
    blockedReason: "verification is not recorded",
    selection: {},
    hasSelectionVerifier: true,
  });
  assert.equal(verdict.kind, "blocked");
  assert.equal(verdict.logLine, "Run apply refused: verification is not recorded");
  assert.equal(verdict.message, "This run was not applied: verification is not recorded.");
  assert.match(verdict.detail, /Nothing was changed\.$/);
});

test("a partial selection with no in-window verifier is refused, not asked", () => {
  const verdict = applyConfirmationPolicy({
    selection: { paths: ["src/a.ts"] },
    hasSelectionVerifier: false,
  });
  assert.equal(verdict.kind, "unverifiablePartial");
  assert.equal(verdict.message, "A partial selection cannot be verified in this window, so it was not applied.");
  assert.equal(verdict.detail, "Apply the whole run, or export the patch and apply it yourself.");
});

test("a whole run needs no selection verification and asks the whole-run question", () => {
  const verdict = applyConfirmationPolicy({ selection: {}, hasSelectionVerifier: false });
  assert.equal(verdict.kind, "confirm");
  assert.equal(verdict.needsVerification, false);
  assert.equal(verdict.confirmAction, "Apply");
  assert.equal(verdict.question, "Apply this run to your current branch?");
  assert.equal(verdict.selectedPaths.length, 0);
  assert.match(verdict.detail, /stages the retained work in your working tree and creates no commit\./);
});

test("a selection with a verifier is verified, and its paths are deduplicated across hunks", () => {
  const verdict = applyConfirmationPolicy({
    selection: { paths: ["src/a.ts"], hunks: [{ path: "src/a.ts", index: 0 }, { path: "src/b.ts", index: 1 }] },
    hasSelectionVerifier: true,
  });
  assert.equal(verdict.kind, "confirm");
  assert.equal(verdict.needsVerification, true);
  assert.deepEqual(verdict.selectedPaths, ["src/a.ts", "src/b.ts"]);
  assert.equal(verdict.hunkCount, 2);
});

test("an inconclusive run changes the confirm action and leads the disclosure with the override", () => {
  const verdict = applyConfirmationPolicy({
    overrideReason: "a check timed out",
    selection: { paths: ["src/a.ts", "src/b.ts"] },
    hasSelectionVerifier: true,
  });
  assert.equal(verdict.confirmAction, "Apply despite inconclusive result");
  assert.match(verdict.detail, /^This run is inconclusive: a check timed out\./);
  assert.match(verdict.detail, /Bachata does not consider this work proven\./);
});

test("the question counts hunks and files, each pluralised where it is counted", () => {
  assert.equal(
    applyConfirmationQuestion({ selectedPathCount: 1, hunkCount: 1 }),
    "Apply 1 selected hunk across 1 file to your current branch?",
  );
  assert.equal(
    applyConfirmationQuestion({ selectedPathCount: 2, hunkCount: 3 }),
    "Apply 3 selected hunks across 2 files to your current branch?",
  );
  assert.equal(
    applyConfirmationQuestion({ selectedPathCount: 1, hunkCount: 0 }),
    "Apply 1 selected file from this run to your current branch?",
  );
  assert.equal(
    applyConfirmationQuestion({ selectedPathCount: 2, hunkCount: 0 }),
    "Apply 2 selected files from this run to your current branch?",
  );
  assert.equal(
    applyConfirmationQuestion({ selectedPathCount: 0, hunkCount: 0 }),
    "Apply this run to your current branch?",
  );
});

test("the disclosure names the selection but only the first twenty paths", () => {
  const many = Array.from({ length: 25 }, (_value, index) => `src/f${String(index)}.ts`);
  const detail = applyConfirmationDetail({ selectedPaths: many });
  assert.match(detail, /Bachata stages only this selection and creates no commit:/);
  assert.ok(detail.includes("src/f19.ts"));
  assert.ok(!detail.includes("src/f20.ts"), "the disclosure named more than the first twenty paths");

  const wholeRun = applyConfirmationDetail({ selectedPaths: [] });
  assert.match(wholeRun, /stages the retained work in your working tree/);
});

test("the unproven-selection notice pluralises, and reads stderr, then stdout, then nothing", () => {
  assert.equal(applySelectionUnprovenNotice({ unproven: [] }), undefined);

  const single = applySelectionUnprovenNotice({
    unproven: [{ command: "npm test", status: "failed", stderr: "boom" }],
  });
  assert.equal(single.message, "This selection was not applied: 1 check did not pass against the selected work alone.");
  assert.match(single.detail, /npm test: failed\nboom/);

  const many = applySelectionUnprovenNotice({
    unproven: [
      { command: "a", status: "failed", stdout: "out-only" },
      { command: "b", status: "timedOut" },
    ],
  });
  assert.match(many.message, /2 checks did not pass/);
  assert.match(many.detail, /a: failed\nout-only/);
  assert.match(many.detail, /b: timedOut\n$/);
});
