const assert = require("node:assert/strict");
const test = require("node:test");

const {
  catalogEventView,
  EVENT_WINDOW_CEILING,
  EVENT_WINDOW_START,
  changedFilesFor,
  checksFor,
  finalRulingFor,
  nextEventWindow,
  openInteractionView,
  retainedRunTarget,
  rulingAttribution,
} = require("../dist/conversations/catalogViews.js");

const interaction = (context) => ({
  interactionRef: "int-1",
  runRef: "run-1",
  kind: "permission",
  prompt: "May I?",
  options: [{ id: "allow" }],
  selected: [],
  freeText: "",
  status: "pending",
  createdAt: "2026-01-01T00:00:00.000Z",
  deadlineAt: "2026-01-01T00:01:00.000Z",
  remainingMs: 60_000,
  pauseReason: undefined,
  context,
});

test("an interaction's presentation is read out of the context the requester wrote", () => {
  const view = openInteractionView(
    interaction({ title: "Permission", allowFreeText: true, secret: true }),
    "conversation-1",
  );
  assert.equal(view.conversationId, "conversation-1");
  assert.equal(view.title, "Permission");
  assert.equal(view.allowFreeText, true);
  assert.equal(view.secret, true);
  assert.equal(view.prompt, "May I?");
  assert.equal(view.remainingMs, 60_000);
});

test("a context that is not a record, or says nothing, is the conservative presentation", () => {
  for (const context of [undefined, null, "nonsense", 7, ["title"], {}]) {
    const view = openInteractionView(interaction(context), "conversation-1");
    assert.equal(view.title, undefined, JSON.stringify(context));
    assert.equal(view.allowFreeText, false);
    assert.equal(view.secret, false);
  }
});

test("a non-string title and a non-true flag are not taken", () => {
  const view = openInteractionView(
    interaction({ title: 42, allowFreeText: "yes", secret: 1 }),
    "conversation-1",
  );
  assert.equal(view.title, undefined);
  assert.equal(view.allowFreeText, false);
  assert.equal(view.secret, false);
});

test("only a published decision carries its payload to the panel", () => {
  assert.deepEqual(
    catalogEventView({
      id: 1,
      type: "decision.published",
      status: "ok",
      title: "Decision",
      payload: { candidate: "ship" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }),
    {
      id: 1,
      type: "decision.published",
      status: "ok",
      title: "Decision",
      payload: { candidate: "ship" },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  );
  assert.equal(
    catalogEventView({
      id: 2,
      type: "verification.completed",
      payload: { detail: "provider output" },
      createdAt: "2026-01-01T00:00:00.000Z",
    }).payload,
    undefined,
  );
});

test("an event with no status or title carries neither key", () => {
  const view = catalogEventView({ id: 3, type: "run.started", createdAt: "t" });
  assert.equal("status" in view, false);
  assert.equal("title" in view, false);
});

test("a managed task reports the files it changed", () => {
  assert.deepEqual(
    changedFilesFor({ taskChangedFiles: ["src/a.ts"], isOrchestrationRoot: false, rootTasks: [] }),
    ["src/a.ts"],
  );
});

test("an orchestration root reports the union only when every task reported", () => {
  assert.deepEqual(
    changedFilesFor({
      isOrchestrationRoot: true,
      rootTasks: [{ changedFiles: ["a"] }, { changedFiles: ["b"] }],
    }),
    ["a", "b"],
  );
  assert.equal(
    changedFilesFor({
      isOrchestrationRoot: true,
      rootTasks: [{ changedFiles: ["a"] }, {}],
    }),
    undefined,
  );
});

test("a plain conversation reports no changed files", () => {
  assert.equal(changedFilesFor({ isOrchestrationRoot: false, rootTasks: [] }), undefined);
});

test("checks come from the task, then the contract, then the whole run", () => {
  const base = { isOrchestrationRoot: true, rootTasks: [{ checks: ["r"] }], finalChecks: ["f"] };
  assert.deepEqual(checksFor({ ...base, taskChecks: ["t"], contractChecks: ["c"] }), ["t"]);
  assert.deepEqual(checksFor({ ...base, contractChecks: ["c"] }), ["c"]);
  assert.deepEqual(checksFor(base), ["r", "f"]);
  assert.equal(
    checksFor({ isOrchestrationRoot: false, rootTasks: [{ checks: ["r"] }], finalChecks: ["f"] }),
    undefined,
  );
});

test("only an orchestration root retains a run, and prefers its own run id", () => {
  assert.deepEqual(
    retainedRunTarget({
      isOrchestrationRoot: true,
      conversationRunId: "run-a",
      orchestrationRunId: "run-b",
      integrationWorktree: "/integration",
      retainedRunWorktree: "/retained",
    }),
    { retainedRunId: "run-a", retainedWorktree: "/integration" },
  );
  assert.deepEqual(
    retainedRunTarget({
      isOrchestrationRoot: true,
      orchestrationRunId: "run-b",
      retainedRunWorktree: "/retained",
    }),
    { retainedRunId: "run-b", retainedWorktree: "/retained" },
  );
});

test("a task points at the worktree it worked in and retains no run", () => {
  assert.deepEqual(
    retainedRunTarget({
      isOrchestrationRoot: false,
      conversationRunId: "run-a",
      orchestrationRunId: "run-b",
      integrationWorktree: "/integration",
      taskWorktreePath: "/task",
    }),
    { retainedRunId: undefined, retainedWorktree: "/task" },
  );
});

test("a task's own summary is the ruling", () => {
  assert.equal(finalRulingFor({ taskSummary: "done", decisionCandidate: "other" }), "done");
});

test("a text candidate is the ruling as written, and a structured one is serialised", () => {
  assert.equal(finalRulingFor({ decisionCandidate: "ship it" }), "ship it");
  assert.equal(finalRulingFor({ decisionCandidate: { verdict: "ship" } }), '{"verdict":"ship"}');
  assert.equal(finalRulingFor({ decisionCandidate: undefined }), undefined);
});

test("a managed task drops the decision's attribution entirely", () => {
  assert.deepEqual(
    rulingAttribution({
      hasTask: true,
      ruledBy: "lead",
      provenance: { kind: "unanimousConsensus" },
      decisionPublished: true,
    }),
    {},
  );
});

test("attribution names who ruled and how, and claims consensus only on a published decision", () => {
  assert.deepEqual(
    rulingAttribution({
      hasTask: false,
      ruledBy: "lead",
      provenance: { kind: "unanimousConsensus" },
      decisionPublished: true,
    }),
    {
      rulingBy: "lead",
      rulingProvenance: { kind: "unanimousConsensus" },
      consensusRuling: true,
    },
  );
  assert.deepEqual(
    rulingAttribution({
      hasTask: false,
      ruledBy: "lead",
      provenance: { kind: "unanimousConsensus" },
      decisionPublished: false,
    }),
    { rulingBy: "lead", rulingProvenance: { kind: "unanimousConsensus" } },
  );
  assert.deepEqual(
    rulingAttribution({
      hasTask: false,
      ruledBy: 7,
      provenance: { kind: "singleRuler" },
      decisionPublished: true,
    }),
    { rulingProvenance: { kind: "singleRuler" } },
  );
  assert.deepEqual(
    rulingAttribution({ hasTask: false, ruledBy: undefined, provenance: undefined, decisionPublished: true }),
    {},
  );
});

test("a window that already reached the execution is not widened", () => {
  assert.equal(
    nextEventWindow({ limit: EVENT_WINDOW_START, returned: EVENT_WINDOW_START, reachedCutoff: true }),
    undefined,
  );
});

test("a window the catalog did not fill has nothing more to give", () => {
  assert.equal(
    nextEventWindow({ limit: EVENT_WINDOW_START, returned: 12, reachedCutoff: false }),
    undefined,
  );
});

test("a full window that has not reached the execution quadruples", () => {
  assert.equal(
    nextEventWindow({ limit: EVENT_WINDOW_START, returned: EVENT_WINDOW_START, reachedCutoff: false }),
    2_000,
  );
});

test("widening stops at the ceiling rather than pulling an unbounded table", () => {
  assert.equal(
    nextEventWindow({
      limit: EVENT_WINDOW_CEILING,
      returned: EVENT_WINDOW_CEILING,
      reachedCutoff: false,
    }),
    undefined,
  );
  assert.equal(EVENT_WINDOW_START, 500);
  assert.equal(EVENT_WINDOW_CEILING, 32_000);
});
