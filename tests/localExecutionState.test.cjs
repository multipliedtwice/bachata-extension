const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createLocalExecutionState } = require("../dist/runtime/localExecutionState.js");
const { fixture, projectionFromPrompt, proposal, planOperation } = require("./support/executionFixture.cjs");

const dispatch = (controller, role, send, extra = {}) => controller.dispatch({
  procedure: role, role, agentId: role === "worker" ? "worker" : "lead",
  candidate: async () => controller.snapshot().candidate,
  audit: async () => ({ candidate: controller.snapshot().candidate, changedPaths: [] }),
  persistBoundary: async () => undefined, send, ...extra,
});
const planner = (controller, extra = {}) => dispatch(controller, "planner", async (prompt) => ({
  status: "completed", answer: JSON.stringify(proposal(projectionFromPrompt(prompt), "planned", [planOperation()])),
}), extra);
const workerAnswer = (prompt) => ({ status: "completed", answer: JSON.stringify(proposal(projectionFromPrompt(prompt))) });

test("local planner, authorized Worker edit, controller checks and candidate-bound Lead acceptance persist end to end", async (t) => {
  const { controller, root, input } = await fixture(t);
  await planner(controller);
  let candidate = "c0";
  await dispatch(controller, "worker", async (prompt, archiveAnswer) => {
    const result = workerAnswer(prompt);
    candidate = "c1";
    await archiveAnswer(result.answer);
    return result;
  }, { candidate: async () => candidate, audit: async () => ({ candidate, changedPaths: ["src/changed.ts"] }) });
  assert.equal(controller.snapshot().candidate, "c1");
  assert.equal(controller.snapshot().checks[0].status, "pending");
  const before = controller.snapshot();
  const resumed = await createLocalExecutionState(root, input);
  assert.deepEqual(resumed.snapshot(), before);
  await resumed.verification("c1", [{ id: "required", status: "passed", content: "exact controller output" }]);
  await dispatch(resumed, "reviewer", async (prompt) => ({
    status: "completed", answer: JSON.stringify(proposal(projectionFromPrompt(prompt), "accept", [])),
  }));
  assert.equal(resumed.snapshot().phase, "complete");
  const stored = await resumed.evidence.manifest();
  assert.equal(stored.records.filter((record) => record.kind === "answer").length, 3);
  assert.ok(stored.records.some((record) => record.kind === "changedPaths"));
  const replayed = await createLocalExecutionState(root, input);
  assert.equal(replayed.snapshot().phase, "complete");
});

test("crash before dispatch restores byte-identical prompt and allowed actions in a fresh callback", async (t) => {
  const { root, input, controller } = await fixture(t);
  let calls = 0;
  await assert.rejects(planner(controller, { persistBoundary: async () => { throw new Error("crash before send"); }, send: async () => { calls += 1; } }), /crash/);
  assert.equal(calls, 0);
  assert.equal(controller.snapshot().pending.status, "prepared");
  const prepared = controller.snapshot();
  const storedPrompt = (await controller.evidence.read(prepared.pending.promptRef, "controller")).content;
  const resumed = await createLocalExecutionState(root, input);
  assert.deepEqual(resumed.snapshot().allowedActions, prepared.allowedActions);
  await planner(resumed, { send: async (prompt) => {
    calls += 1;
    assert.equal(prompt, storedPrompt);
    return { status: "completed", answer: JSON.stringify(proposal(projectionFromPrompt(prompt), "planned", [planOperation()])) };
  } });
  assert.equal(calls, 1);
});

for (const mutation of [false, true]) {
  test(`lost Worker response ${mutation ? "after" : "before"} mutation reconciles without replay`, async (t) => {
    const { root, input, controller } = await fixture(t);
    await planner(controller);
    let candidate = "c0";
    let edits = 0;
    await assert.rejects(dispatch(controller, "worker", async () => {
      if (mutation) { candidate = "c1"; edits += 1; }
      throw new Error("lost response");
    }), /lost response/);
    const resumed = await createLocalExecutionState(root, input);
    await assert.rejects(dispatch(resumed, "worker", async () => { edits += 1; throw new Error("must not send"); }, {
      candidate: async () => candidate, audit: async () => ({ candidate, changedPaths: mutation ? ["src/a.ts"] : [] }),
    }), /unsettled/);
    assert.equal(edits, mutation ? 1 : 0);
    assert.equal(resumed.snapshot().phase, "recovery");
    assert.equal(resumed.snapshot().allowedActions.length, 0);
    const manifest = await resumed.evidence.manifest();
    assert.ok(manifest.records.some((record) => record.source === "uncertain dispatch reconciliation"));
  });
}

test("settled dispatch is reused after lost workflow checkpoint; malformed edits stay uncertain", async (t) => {
  const { root, input, controller } = await fixture(t);
  await planner(controller);
  let sends = 0;
  await dispatch(controller, "worker", async (prompt) => { sends += 1; return workerAnswer(prompt); });
  const resumed = await createLocalExecutionState(root, input);
  await dispatch(resumed, "worker", async (prompt) => { sends += 1; return workerAnswer(prompt); });
  assert.equal(sends, 1);
  const state = await createLocalExecutionState(root, { ...input, restart: true });
  await planner(state);
  await assert.rejects(dispatch(state, "worker", async () => ({ status: "completed", answer: "not JSON" })), /JSON/);
  assert.equal(state.snapshot().pending.status, "dispatched");
});

test("failed controller archive never passes checks and restart does not repeat a settled edit", async (t) => {
  let failArchive = false;
  const { root, input, controller } = await fixture(t, { onRecord: (record) => {
    if (failArchive && record.source.startsWith("verification:")) throw new Error("archive unavailable");
  } });
  await planner(controller);
  let edits = 0;
  await dispatch(controller, "worker", async (prompt) => { edits += 1; return workerAnswer(prompt); });
  failArchive = true;
  await assert.rejects(controller.verification("c0", [{ id: "required", status: "passed", content: "pass" }]), /archive unavailable/);
  assert.equal(controller.snapshot().checks[0].status, "pending");
  failArchive = false;
  const resumed = await createLocalExecutionState(root, input);
  await dispatch(resumed, "worker", async (prompt) => { edits += 1; return workerAnswer(prompt); });
  await resumed.verification("c0", [{ id: "required", status: "passed", content: "pass" }]);
  assert.equal(edits, 1);
  assert.equal(resumed.snapshot().checks[0].status, "passed");
});

test("bounded explicit recall produces a new dispatch without replaying other answers", async (t) => {
  const { controller } = await fixture(t);
  const prompts = [];
  await planner(controller, { send: async (prompt) => {
    prompts.push(prompt);
    const state = projectionFromPrompt(prompt);
    const change = prompts.length === 1
      ? { ...proposal(state, "recall", []), recall: [{ id: state.bundleRef, start: 0, end: 9, use: "history" }] }
      : proposal(state, "planned", [planOperation()]);
    return { status: "completed", answer: JSON.stringify(change) };
  } });
  assert.equal(prompts.length, 2);
  const first = projectionFromPrompt(prompts[0]);
  const second = projectionFromPrompt(prompts[1]);
  assert.notEqual(first.pending.id, second.pending.id);
  assert.ok(prompts[1].includes('"text":"immutable"'));
  assert.equal(controller.snapshot().recall.length, 0);
});

test("Lead directive and revision budget survive restart and budget consumption is idempotent", async (t) => {
  const { root, input, controller } = await fixture(t);
  await planner(controller);
  await dispatch(controller, "worker", async (prompt) => workerAnswer(prompt));
  await controller.verification("c0", [{ id: "required", status: "passed", content: "pass" }]);
  await dispatch(controller, "reviewer", async (prompt) => {
    const state = projectionFromPrompt(prompt);
    return { status: "completed", answer: JSON.stringify(proposal(state, "reject", [{ type: "raiseDefect", id: "d1", statement: "exact defect", requiredChange: "exact fix", evidence: [state.checks[0].evidence] }])) };
  });
  assert.equal(await controller.spendRevision(), 1);
  assert.equal(await controller.spendRevision(), 1);
  const resumed = await createLocalExecutionState(root, input);
  assert.equal(await resumed.spendRevision(), 1);
  const directive = resumed.snapshot().directive;
  assert.ok(directive);
  await dispatch(resumed, "worker", async (prompt) => {
    assert.ok(prompt.includes("exact defect"));
    assert.ok(prompt.includes("exact fix"));
    return workerAnswer(prompt);
  }, { procedure: "worker-revision" });
  assert.equal(resumed.snapshot().directive, null);
  assert.equal(resumed.snapshot().consumedDirective, directive);
});

test("drift, changed policy, missing blobs and incomplete admission refuse execution", async (t) => {
  const { root, input, controller } = await fixture(t);
  await assert.rejects(createLocalExecutionState(root, { ...input, policyId: "changed" }), /identity/);
  await assert.rejects(createLocalExecutionState(root, { ...input, maxRevisions: 1 }), /budget contract/);
  await assert.rejects(createLocalExecutionState(root, { ...input, checks: [{ id: "invented", command: "other" }] }), /check or budget contract/);
  await assert.rejects(planner(controller, { candidate: async () => "drift" }), /Workspace changed/);
  const state = await createLocalExecutionState(root, { ...input, restart: true });
  const record = (await state.evidence.manifest()).records.find((item) => item.id === state.snapshot().baselineRef);
  await fs.unlink(path.join(state.evidence.directory, record.storage));
  await assert.rejects(createLocalExecutionState(root, input), /recovery/);
});

test("redacted task-start baseline refuses admission before any provider dispatch", async (t) => {
  const { root, input } = await fixture(t);
  await assert.rejects(createLocalExecutionState(root, { ...input, taskId: "redacted", baseline: "password=private-value" }), /baseline cannot be reconstructed/);
});

test("credential redaction in admitted task instructions is disclosed without losing prompt fidelity", async (t) => {
  const { controller } = await fixture(t, { task: "Implement feature\npassword=private-value" });
  const manifest = await controller.evidence.manifest();
  const task = manifest.records.find((record) => record.kind === "task");
  assert.ok(task.redactions.length > 0);
  assert.ok(!(await controller.evidence.read(task.id, "controller")).content.includes("private-value"));
  await planner(controller, { send: async (prompt) => {
    assert.ok(!prompt.includes("private-value"));
    const state = controller.snapshot();
    assert.equal((await controller.evidence.read(state.pending.promptRef, "controller")).content, prompt);
    return { status: "completed", answer: JSON.stringify(proposal(projectionFromPrompt(prompt), "planned", [planOperation()])) };
  } });
});

test("pending prompt and answer writes are fenced and uncertain calls cannot be replayed concurrently", async (t) => {
  let mutations = 0;
  const { controller } = await fixture(t, { withMutation: async (operation) => {
    mutations += 1;
    return operation();
  } });
  await planner(controller);
  let sends = 0;
  const send = async () => { sends += 1; throw new Error("lost response"); };
  const outcomes = await Promise.allSettled([dispatch(controller, "worker", send), dispatch(controller, "worker", send)]);
  assert.ok(outcomes.every((outcome) => outcome.status === "rejected"));
  assert.equal(sends, 1);
  assert.ok(mutations > 0);
  assert.equal(controller.snapshot().phase, "recovery");
});
