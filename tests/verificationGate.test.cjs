const assert = require("node:assert/strict");
const test = require("node:test");

const {
  verificationGateHolds,
  verificationIssues,
} = require("../dist/runtime/verificationGate.js");

// EX-AUD-12, P3. Whether declared checks let a managed turn finish. This lived inside
// `createRuntime`'s managed browser-action loop with the I/O that carries it out; it is a
// decision, and it is the one that stops unverified work reaching a Lead review.

const check = (id) => ({ id });
const record = (id, status, workspaceFingerprint = "tree-1") => ({ id, status, workspaceFingerprint });

test("checks that all ran and passed against this workspace raise nothing", () => {
  assert.deepEqual(
    verificationIssues(
      [check("integrity"), check("project")],
      [record("integrity", "passed"), record("project", "passed")],
      "tree-1",
    ),
    [],
  );
});

test("a declared check with no record is named as not run, because silence is not a pass", () => {
  assert.deepEqual(
    verificationIssues([check("integrity"), check("project")], [record("integrity", "passed")], "tree-1"),
    ["project: not run"],
  );
});

test("no records at all names every declared check, not just the first", () => {
  assert.deepEqual(
    verificationIssues([check("a"), check("b"), check("c")], [], "tree-1"),
    ["a: not run", "b: not run", "c: not run"],
  );
});

test("a record from another workspace is stale, however green it was", () => {
  // This is what stops an earlier passing run from carrying a later, different change.
  assert.deepEqual(
    verificationIssues([check("project")], [record("project", "passed", "tree-0")], "tree-1"),
    ["project: stale"],
  );
});

test("a record with no workspace named cannot authorize one", () => {
  assert.deepEqual(
    verificationIssues([check("project")], [{ id: "project", status: "passed" }], "tree-1"),
    ["project: stale"],
  );
});

test("a failing check is reported in its own word, not flattened to failed", () => {
  // Inconclusive is not failed, and a Lead has to be able to tell them apart.
  assert.deepEqual(
    verificationIssues(
      [check("a"), check("b"), check("c")],
      [record("a", "failed"), record("b", "inconclusive"), record("c", "skipped")],
      "tree-1",
    ),
    ["a: failed", "b: inconclusive", "c: skipped"],
  );
});

test("only a pass is a pass", () => {
  for (const status of ["failed", "inconclusive", "skipped", "pending", "", "PASSED"]) {
    assert.deepEqual(
      verificationIssues([check("only")], [record("only", status)], "tree-1"),
      [`only: ${status}`],
      status,
    );
  }
});

test("issues follow the declared order, so the same problems read the same way twice", () => {
  assert.deepEqual(
    verificationIssues(
      [check("first"), check("second")],
      [record("second", "failed"), record("first", "failed")],
      "tree-1",
    ),
    ["first: failed", "second: failed"],
  );
});

test("a record for a check nobody declared is not an issue of its own", () => {
  assert.deepEqual(
    verificationIssues([check("declared")], [record("declared", "passed"), record("extra", "failed")], "tree-1"),
    [],
  );
});

test("declaring no checks raises nothing, because nothing was required", () => {
  assert.deepEqual(verificationIssues([], [record("anything", "failed")], "tree-1"), []);
});

const gate = (overrides = {}) => verificationGateHolds({
  terminal: true,
  hasEnvelope: true,
  envelopeStatus: "complete",
  issues: ["project: failed"],
  role: "worker",
  terminalObjections: [],
  ...overrides,
});

test("a worker claiming a finished turn is held back by any check problem", () => {
  assert.equal(gate(), true);
});

test("a turn with nothing wrong is never held", () => {
  assert.equal(gate({ issues: [] }), false);
});

test("a turn that is not finished yet is not gated, because it claims nothing", () => {
  assert.equal(gate({ terminal: false }), false);
});

test("a turn with no envelope is not gated: there is no claim to hold", () => {
  assert.equal(gate({ hasEnvelope: false }), false);
});

test("a turn that already reports itself blocked is not held again", () => {
  assert.equal(gate({ envelopeStatus: "blocked" }), false);
});

test("a lead that raised objections is reporting a problem, and is not silenced by the gate", () => {
  // Holding a lead's own findings over the checks would suppress the finding rather than
  // surface it. A lead with nothing to say is held like anyone else.
  assert.equal(gate({ role: "lead", terminalObjections: ["the fix is wrong"] }), false);
  assert.equal(gate({ role: "lead", terminalObjections: [] }), true);
});

test("a worker's objections do not exempt it, because its claim is that the work is verified", () => {
  assert.equal(gate({ role: "worker", terminalObjections: ["something"] }), true);
});

test("a check that never ran holds a turn exactly as a failing one does", () => {
  assert.equal(gate({ issues: ["project: not run"] }), true);
  assert.equal(gate({ issues: ["project: stale"] }), true);
});
