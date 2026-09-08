const assert = require("node:assert/strict");
const test = require("node:test");

const {
  RETAINED_EVIDENCE_LIMIT,
  retainedApplyRefusal,
  retainedCandidateFingerprint,
  retainedEvidenceFor,
  retainedVerificationIssues,
  withRetainedEvidence,
} = require("../dist/orchestrator/retainedVerification.js");

// P3. Whether a retained run's checks authorize applying it. Applying is the moment the work
// reaches the workspace, and it was the one moment nothing consulted the run's verification.

const check = (command, overrides = {}) => ({
  command,
  status: "passed",
  stdout: "",
  stderr: "",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  ...overrides,
});

test("the candidate is the tree Apply would carry, not the retained worktree's live state", () => {
  const first = retainedCandidateFingerprint({ candidate: "a".repeat(40) });
  assert.match(first, /^[0-9a-f]{64}$/u);
  assert.equal(first, retainedCandidateFingerprint({ candidate: "a".repeat(40) }));
  assert.notEqual(first, retainedCandidateFingerprint({ candidate: "b".repeat(40) }));
});

test("a selection is part of the candidate it is applied from", () => {
  const whole = retainedCandidateFingerprint({ candidate: "a".repeat(40) });
  const part = retainedCandidateFingerprint({ candidate: "a".repeat(40) }, { paths: ["src/one.ts"] });
  assert.notEqual(whole, part);
  assert.equal(
    part,
    retainedCandidateFingerprint({ candidate: "a".repeat(40) }, { paths: ["src/one.ts"] }),
  );
  // A different selection of the same candidate is a different thing to verify.
  assert.notEqual(
    part,
    retainedCandidateFingerprint({ candidate: "a".repeat(40) }, { paths: ["src/two.ts"] }),
  );
  // And the same selection of a changed candidate is too.
  assert.notEqual(
    part,
    retainedCandidateFingerprint({ candidate: "b".repeat(40) }, { paths: ["src/one.ts"] }),
  );
});

test("a candidate has one current verification, and the newest replaces it", () => {
  const first = withRetainedEvidence(undefined, { fingerprint: "a", checks: [check("one")] });
  assert.deepEqual(first.map((entry) => entry.fingerprint), ["a"]);
  const replaced = withRetainedEvidence(first, { fingerprint: "a", checks: [check("two")] });
  assert.equal(replaced.length, 1);
  assert.deepEqual(replaced[0].checks.map((entry) => entry.command), ["two"]);
  const both = withRetainedEvidence(replaced, { fingerprint: "b", checks: [] });
  assert.deepEqual(both.map((entry) => entry.fingerprint), ["a", "b"]);
});

test("what a run remembers about verified candidates is bounded, oldest first", () => {
  let evidence;
  for (let index = 0; index < RETAINED_EVIDENCE_LIMIT + 3; index += 1) {
    evidence = withRetainedEvidence(evidence, { fingerprint: `f${String(index)}`, checks: [] });
  }
  assert.equal(evidence.length, RETAINED_EVIDENCE_LIMIT);
  assert.equal(evidence[0].fingerprint, "f3");
  assert.equal(evidence.at(-1).fingerprint, `f${String(RETAINED_EVIDENCE_LIMIT + 2)}`);
});

test("evidence is looked up by the exact candidate it was produced for", () => {
  const evidence = withRetainedEvidence(undefined, { fingerprint: "a", checks: [check("one")] });
  assert.deepEqual(retainedEvidenceFor(evidence, "a").map((entry) => entry.command), ["one"]);
  assert.deepEqual(retainedEvidenceFor(evidence, "b"), []);
  assert.deepEqual(retainedEvidenceFor(undefined, "a"), []);
});

test("a complete passing set for this candidate has nothing wrong with it", () => {
  assert.deepEqual(
    retainedVerificationIssues({
      required: ["bachata:workspace-integrity", "bachata:project-checks"],
      checks: [
        check("bachata:workspace-integrity", { candidateTree: "f" }),
        check("bachata:project-checks", { candidateTree: "f" }),
      ],
      fingerprint: "f",
    }),
    [],
  );
});

test("a check that never ran, one from another candidate and one that failed read differently", () => {
  assert.deepEqual(
    retainedVerificationIssues({
      required: ["a", "b", "c", "d"],
      checks: [
        check("b", { candidateTree: "other" }),
        check("c", { candidateTree: "f", status: "failed" }),
        check("d", { candidateTree: "f", status: "cancelled" }),
      ],
      fingerprint: "f",
    }),
    ["a: not run", "b: stale", "c: failed", "d: cancelled"],
  );
});

test("a timed-out check is not a passing check", () => {
  assert.deepEqual(
    retainedVerificationIssues({
      required: ["a"],
      checks: [check("a", { candidateTree: "f", status: "timedOut" })],
      fingerprint: "f",
    }),
    ["a: timedOut"],
  );
});

test("a check with no candidate recorded at all authorizes nothing", () => {
  assert.deepEqual(
    retainedVerificationIssues({ required: ["a"], checks: [check("a")], fingerprint: "f" }),
    ["a: stale"],
  );
});

test("a run that declares no checks has nothing missing, so Apply is not blocked", () => {
  assert.equal(
    retainedApplyRefusal({ required: [], evidence: undefined, fingerprint: "f", selective: false }),
    undefined,
  );
});

test("a run with complete passing evidence for this candidate may be applied", () => {
  const evidence = withRetainedEvidence(undefined, {
    fingerprint: "f",
    checks: [check("a", { candidateTree: "f" })],
  });
  assert.equal(
    retainedApplyRefusal({ required: ["a"], evidence, fingerprint: "f", selective: false }),
    undefined,
  );
});

test("a refusal names the checks and says what to do about it", () => {
  const refusal = retainedApplyRefusal({
    required: ["bachata:project-checks"],
    evidence: undefined,
    fingerprint: "f",
    selective: false,
  });
  assert.match(refusal, /no complete passing verification for its current candidate/u);
  assert.match(refusal, /Required verification: bachata:project-checks: not run/u);
  assert.match(refusal, /Re-run the retained checks and apply once they pass/u);
});

test("a selective apply is refused in its own words", () => {
  const refusal = retainedApplyRefusal({
    required: ["bachata:project-checks"],
    evidence: withRetainedEvidence(undefined, {
      fingerprint: "whole",
      checks: [check("bachata:project-checks", { candidateTree: "whole" })],
    }),
    fingerprint: "part",
    selective: true,
  });
  assert.match(refusal, /no complete passing verification for the retained run as it stands/u);
});

// EX-A5-R01. Complete passing evidence is evidence about one composition: this candidate on top
// of one exact receiving HEAD. A patch that still applies cleanly says nothing about everything
// outside it, so a branch that has moved since the checks is a composition nothing has verified.
test("evidence bound to another receiving HEAD does not authorize an Apply", () => {
  const evidence = withRetainedEvidence(undefined, {
    fingerprint: "f",
    checks: [check("a", { candidateTree: "f" })],
    target: "1111111111111111111111111111111111111111",
  });
  assert.equal(
    retainedApplyRefusal({
      required: ["a"],
      evidence,
      fingerprint: "f",
      selective: false,
      target: "1111111111111111111111111111111111111111",
    }),
    undefined,
    "evidence recorded against the branch as it stands was refused",
  );
  const refusal = retainedApplyRefusal({
    required: ["a"],
    evidence,
    fingerprint: "f",
    selective: false,
    target: "2222222222222222222222222222222222222222",
  });
  assert.match(refusal, /verified against a different state of the receiving branch/u);
  assert.match(refusal, /Verified against 111111111111; the branch is now on 222222222222/u);
  // EX-A5-R01 residue. Not "re-run the checks": a retained run's checks are composed on the
  // commit it started from, so a recheck against a moved branch is refused rather than run.
  assert.match(refusal, /Rebase this work onto the branch and start a new run\./u);
  assert.doesNotMatch(refusal, /Re-run the retained checks/u);
});

test("a selection verified against another receiving HEAD is refused in its own words", () => {
  const refusal = retainedApplyRefusal({
    required: ["a"],
    evidence: withRetainedEvidence(undefined, {
      fingerprint: "f",
      checks: [check("a", { candidateTree: "f" })],
      target: "1111111111111111111111111111111111111111",
    }),
    fingerprint: "f",
    selective: true,
    target: "2222222222222222222222222222222222222222",
  });
  assert.match(refusal, /This selection was verified against a different state of the receiving branch/u);
});

// EX-A5-R01. Evidence recorded before the receiving branch was bound names no commit at all, so
// it cannot be shown to match the branch Apply would write to. It is unbound, not current.
test("evidence that records no receiving HEAD authorizes nothing", () => {
  const refusal = retainedApplyRefusal({
    required: ["a"],
    evidence: withRetainedEvidence(undefined, {
      fingerprint: "f",
      checks: [check("a", { candidateTree: "f" })],
    }),
    fingerprint: "f",
    selective: false,
    target: "2222222222222222222222222222222222222222",
  });
  assert.match(refusal, /verified against a different state of the receiving branch/u);
  assert.match(refusal, /does not record which commit it ran against/u);
});
