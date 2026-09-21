const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { parseExecutionProposal, parseExecutionState, reduceExecutionProposal, strictExecutionJson, executionAllowedActions, EXECUTION_LIMITS } = require("../dist/pipeline/executionState.js");
const { executionPrompt, projectExecutionState } = require("../dist/pipeline/executionProjection.js");
const { pureState, proposal, planOperation } = require("./support/executionFixture.cjs");

const apply = (state, change, observedCandidate = "c0") => reduceExecutionProposal(state, change, {
  agentId: state.pending.agentId, answerRef: randomUUID(), observedCandidate,
  validEvidence: [state.bundleRef, ...state.checks.map((check) => check.evidence).filter(Boolean)],
});

test("strict proposal and stored-state parsing refuse unknown fields, duplicates, versions, depth and UTF-8 overflow", () => {
  const state = pureState();
  const valid = proposal(state);
  assert.deepEqual(parseExecutionProposal(JSON.stringify(valid)), valid);
  for (const mutation of [
    { ...valid, version: 2 }, { ...valid, extra: true }, { ...valid, result: { ...valid.result, candidate: "invented" } },
    { ...valid, operations: [{ type: "passCheck", id: "required" }] },
    { ...valid, result: { ...valid.result, summary: "🙂".repeat(1025) } },
    { ...valid, result: { ...valid.result, summary: "\ud800" } },
    { ...valid, operations: [{ type: "reportWork", planIds: null }] },
  ]) assert.throws(() => parseExecutionProposal(JSON.stringify(mutation)));
  assert.throws(() => parseExecutionProposal(JSON.stringify(valid).replace('"version":1', '"version":1,"version":1')), /duplicate/);
  assert.throws(() => strictExecutionJson("[".repeat(10) + "0" + "]".repeat(10), 1000), /nesting/);
  assert.throws(() => parseExecutionState({ ...state, allowedActions: ["approveCompletion"] }), /controller derived/);
  assert.throws(() => parseExecutionState({ ...state, extra: true }), /unknown/);
  assert.throws(() => parseExecutionState({ ...state, checks: Array.from({ length: 17 }, (_, i) => ({ ...state.checks[0], id: `c${i}` })) }));
});

test("one revision accepts at most one proposal; stale, wrong-owner, invalid and unauthorized proposals do not mutate input", () => {
  const state = pureState();
  const original = structuredClone(state);
  const proposed = proposal(state);
  const accepted = apply(state, proposed, "c1");
  assert.equal(accepted.candidate, "c1");
  assert.equal(accepted.checks[0].status, "pending");
  assert.throws(() => apply(accepted, proposed), /stale/);
  assert.throws(() => apply(state, { ...proposed, dispatchId: "wrong" }), /ownership/);
  assert.throws(() => apply(state, { ...proposed, procedure: "other" }), /ownership/);
  assert.throws(() => apply(state, { ...proposed, operations: [planOperation()] }), /ownership/);
  assert.throws(() => apply(state, { ...proposed, result: { status: "accept", summary: "claim" } }), /worker/);
  assert.throws(() => apply(state, { ...proposed, operations: [{ type: "reportWork", planIds: ["missing"] }] }), /unknown/);
  assert.deepEqual(state, original);
});

test("Lead acceptance requires current complete verification and explicit resolution; Worker cannot clear Lead defects", () => {
  const lead = pureState("reviewer");
  lead.defects = [{ id: "d1", statement: "exact problem", requiredChange: "exact repair", attribution: "lead", evidence: [lead.bundleRef], status: "open", candidate: "c0" }];
  assert.throws(() => apply(lead, proposal(lead, "accept", [])), /defect resolution/);
  const accept = proposal(lead, "accept", [{ type: "resolveDefect", defectId: "d1" }]);
  assert.equal(apply(lead, accept).phase, "complete");
  assert.throws(() => apply(lead, accept, "drift"), /drift/);
  const stale = { ...lead, checks: lead.checks.map((check) => ({ ...check, candidate: "old" })) };
  assert.throws(() => apply(stale, accept), /unverified/);
  const worker = pureState();
  worker.defects = structuredClone(lead.defects);
  assert.throws(() => apply(worker, proposal(worker, "worked", [{ type: "resolveDefect", defectId: "d1" }])), /ownership/);
  const reported = apply(worker, proposal(worker, "worked", [{ type: "reportWork", planIds: ["p1"] }, { type: "proposeResolution", defectId: "d1" }]));
  assert.equal(reported.defects[0].status, "proposedResolved");
  assert.equal(reported.defects[0].statement, "exact problem");
});

test("recall is explicit, bounded, scoped and cannot hide a Worker edit", () => {
  const state = pureState();
  const requested = { ...proposal(state, "recall", []), recall: [{ id: state.bundleRef, start: 0, end: 10, use: "history" }] };
  assert.equal(apply(state, requested).recall.length, 1);
  assert.throws(() => apply(state, requested, "edited"), /conceal/);
  assert.throws(() => apply(state, { ...requested, recall: [{ ...requested.recall[0], id: randomUUID() }] }), /unknown/);
  assert.throws(() => parseExecutionProposal(JSON.stringify({ ...requested, recall: [{ ...requested.recall[0], end: EXECUTION_LIMITS.recall + 1 }] })), /range/);
  assert.throws(() => parseExecutionState({ ...state, recall: [
    { ...requested.recall[0], end: EXECUTION_LIMITS.recall },
    { ...requested.recall[0], start: 1, end: 2 },
  ] }), /aggregate/);
});

for (const transitions of [10, 50, 100, 200]) {
  test(`${transitions} transitions keep complete prompts bounded without replaying earlier answers`, () => {
    let state = pureState();
    let compactBytes = 0;
    let legacyBytes = 0;
    const history = [];
    for (let i = 0; i < transitions; i += 1) {
      state.pending = { ...state.pending, id: randomUUID(), status: "dispatched", baseRevision: state.revision, candidate: state.candidate, answerRef: null };
      state.allowedActions = executionAllowedActions(state);
      const prompt = executionPrompt(state);
      assert.ok(Buffer.byteLength(prompt) <= EXECUTION_LIMITS.prompt);
      assert.ok(Buffer.byteLength(projectExecutionState(state)) <= EXECUTION_LIMITS.projection);
      for (const previous of history.slice(0, -1)) assert.ok(!prompt.includes(previous));
      compactBytes += Buffer.byteLength(prompt);
      legacyBytes += Buffer.byteLength(`${state.task}\n${history.join("\n")}`);
      const answer = `answer-${i}-` + "x".repeat(3000);
      const change = proposal(state);
      change.result.summary = answer;
      state = apply(state, change);
      history.push(answer);
    }
    assert.ok(compactBytes < legacyBytes, `${compactBytes} compact bytes versus ${legacyBytes} repeated-context bytes`);
  });
}

test("required task and defect material is refused instead of truncated", () => {
  const state = pureState();
  state.task = "🙂".repeat(8193);
  assert.throws(() => executionPrompt(state), /admission refused/);
  const crowded = pureState("reviewer");
  crowded.defects = Array.from({ length: 10 }, (_, i) => ({ id: `d${i}`, statement: "x".repeat(4096), requiredChange: "y".repeat(4096), attribution: "lead", evidence: [crowded.bundleRef], status: "open", candidate: "c0" }));
  assert.throws(() => projectExecutionState(crowded), /admission refused/);
});
