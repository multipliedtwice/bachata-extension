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

test("every event carries a bounded, redacted projection of what it recorded", () => {
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
  // A payload small enough to travel travels as it was recorded, a published decision included.
  // Every event carries a bounded, redacted projection instead of nothing at all: the panel renders
  // it only inside a closed disclosure, and a reader who opens one needs something there.
  assert.deepEqual(
    catalogEventView({
      id: 2,
      type: "verification.completed",
      payload: { detail: "provider output", exitCode: 2 },
      createdAt: "2026-01-01T00:00:00.000Z",
    }).payload,
    { detail: "provider output", exitCode: 2 },
  );
  // A credential and a resumable provider session handle are not part of that projection.
  const guarded = catalogEventView({
    id: 3,
    type: "provider.failure",
    payload: { apiKey: "sk-live-1234567890", sessionId: "sess-abc", error: "exit 1" },
    createdAt: "2026-01-01T00:00:00.000Z",
  }).payload;
  assert.deepEqual(guarded, {
    apiKey: "[REDACTED]",
    sessionId: "[WITHHELD]",
    error: "exit 1",
  });
  assert.equal(JSON.stringify(guarded).includes("sk-live-1234567890"), false);
  assert.equal(JSON.stringify(guarded).includes("sess-abc"), false);
  // An event that recorded nothing still carries nothing, so no disclosure opens onto an empty box.
  assert.equal(
    catalogEventView({ id: 4, type: "run.started", createdAt: "t" }).payload,
    undefined,
  );
  assert.equal(
    catalogEventView({ id: 5, type: "run.started", payload: {}, createdAt: "t" }).payload,
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

// The aggregate boundary.
//
// A per-event cap bounds one row. The snapshot sends five hundred of them per conversation, for
// every conversation, on every refresh — so the rows share one budget, spent newest first because
// the newest rows are the ones a reader is looking at and the current attempt's rows are the newest
// rows.

const {
  EVENT_HISTORY_AGGREGATE_BYTES,
  catalogEventViews,
} = require("../dist/conversations/catalogViews.js");
const { MAX_EVENT_DETAIL_BYTES } = require("../dist/conversations/eventDetail.js");

const payloadBytes = (views) =>
  views.reduce(
    (total, view) =>
      total + (view.payload === undefined ? 0 : Buffer.byteLength(JSON.stringify(view.payload), "utf8")),
    0,
  );

const bigStepPayload = (index) => ({
  stepId: "plan",
  attempt: index,
  stdout: "x".repeat(8_000),
  extra: Object.fromEntries(
    Array.from({ length: 24 }, (_, field) => [`k${String(field)}`, "y".repeat(1_024)]),
  ),
});

const ruling = (id) => ({
  id,
  type: "decision.published",
  status: "ruled",
  title: "DABC",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: {
    stepId: "decide",
    status: "ruled",
    candidateId: "DABC",
    candidate: { summary: "z".repeat(100_000) },
    objections: [{ agentId: "codex", text: "Keep the fallback", accepted: false }],
    unresolvedRisks: ["Provider DOM drift"],
    ruledBy: "claude",
  },
});

const restart = (id) => ({
  id,
  type: "run.restarted",
  status: "running",
  title: "Test run",
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: {
    stdout: "x".repeat(8_000),
    pipeline: {
      hash: "a".repeat(64),
      steps: [{ id: "plan", name: "Plan" }, { id: "implement", name: "Implement" }],
    },
  },
});

const longHistory = () => {
  const events = Array.from({ length: 500 }, (_, index) => ({
    id: index + 1,
    type: "step.started",
    status: "running",
    title: `step ${String(index + 1)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: bigStepPayload(index + 1),
  }));
  return [
    ...events.slice(0, 10),
    ruling(11),
    restart(12),
    ...events.slice(12),
  ];
};

test("a history of five hundred events shares one budget instead of five hundred caps", () => {
  const views = catalogEventViews(longHistory());
  assert.equal(views.length, 500);
  const bytes = payloadBytes(views);
  assert.ok(
    bytes <= EVENT_HISTORY_AGGREGATE_BYTES,
    `${String(bytes)} bytes of event detail travelled`,
  );
  // Worth stating in the unit the defect was in: five hundred rows at the per-event cap is what
  // this replaces.
  assert.ok(bytes < 500 * MAX_EVENT_DETAIL_BYTES);
});

test("the newest rows are the ones that carry detail, and the oldest are the ones that lose it", () => {
  const views = catalogEventViews(longHistory());
  assert.notEqual(views[499].payload, undefined, "the newest event lost its detail");
  assert.equal(views[0].payload, undefined, "the budget reached the oldest event first");
});

test("the newest ruling keeps its payload however far back the history pushed it", () => {
  const views = catalogEventViews(longHistory());
  const published = views[10];
  assert.equal(published.type, "decision.published");
  assert.notEqual(published.payload, undefined, "the run's final ruling lost its payload");
  assert.equal(published.payload.ruledBy, "claude");
  assert.equal(published.payload.candidateId, "DABC");
  assert.deepEqual(published.payload.unresolvedRisks, ["Provider DOM drift"]);
  assert.deepEqual(
    published.payload.objections,
    [{ agentId: "codex", text: "Keep the fallback", accepted: false }],
  );
});

test("a row the budget did not reach still carries everything the run's progress is read from", () => {
  const views = catalogEventViews(longHistory());
  const starved = views[0];
  assert.equal(starved.payload, undefined);
  assert.equal(starved.id, 1);
  assert.equal(starved.type, "step.started");
  assert.equal(starved.status, "running");
  assert.equal(starved.title, "step 1");
  assert.equal(starved.stepId, "plan", "the step the row belongs to was lost with its payload");
  assert.equal(starved.createdAt, "2026-01-01T00:00:00.000Z");
  // The attempt boundary is what stops a restarted run from inheriting the previous attempt's rows.
  const restarted = views[11];
  assert.equal(restarted.type, "run.restarted");
  assert.deepEqual(restarted.attempt, {
    pipelineHash: "a".repeat(64),
    steps: [{ id: "plan", name: "Plan" }, { id: "implement", name: "Implement" }],
  });
});

test("a short history is not rationed at all", () => {
  const views = catalogEventViews([
    { id: 1, type: "run.started", createdAt: "t", payload: { iterations: 1 } },
    { id: 2, type: "step.started", createdAt: "t", payload: { stepId: "plan" } },
  ]);
  assert.deepEqual(views.map((view) => view.payload), [{ iterations: 1 }, { stepId: "plan" }]);
});

test("an empty history projects to nothing rather than to a row", () => {
  assert.deepEqual(catalogEventViews([]), []);
});

test("a published decision is bounded like every other payload", () => {
  const view = catalogEventView(ruling(1));
  const bytes = Buffer.byteLength(JSON.stringify(view.payload), "utf8");
  assert.ok(bytes <= MAX_EVENT_DETAIL_BYTES, `${String(bytes)} bytes travelled`);
  assert.equal(view.payload.ruledBy, "claude");
  assert.ok(view.payload.candidate.summary.length < 2_000, "the candidate travelled whole");
});

test("a decision's free-form text is redacted, controller envelope or not", () => {
  const view = catalogEventView({
    id: 1,
    type: "decision.published",
    createdAt: "t",
    payload: {
      status: "ruled",
      candidate: { note: "the provider printed sk-live-1234567890abcdefgh in its reasoning" },
      objections: [{ agentId: "codex", text: "Keep the fallback", accepted: false }],
      sessionId: "sess-must-not-travel",
    },
  });
  const serialised = JSON.stringify(view.payload);
  assert.equal(serialised.includes("sk-live-1234567890abcdefgh"), false);
  assert.ok(serialised.includes("[REDACTED]"));
  assert.equal(serialised.includes("sess-must-not-travel"), false);
});

// One conversation's five hundred rows sharing one budget bounded one conversation.
//
// `eventsByConversation` holds every conversation in the panel, and a cap applied once per
// conversation is N times a cap. The ceiling below is over the whole value, metadata included,
// because metadata is what the pipeline summary and the run's progress are read from and it is not
// free of charge either: an attempt boundary carries a step list, and a title carries provider text.

const { catalogEventHistories } = require("../dist/conversations/catalogViews.js");

const wholeMessageBytes = (state) => Buffer.byteLength(JSON.stringify(state), "utf8");

const manyConversations = (count) => {
  // One history object shared by every conversation: the projection reads it, it does not own it,
  // and five hundred maximum-size events materialised forty times over is a gigabyte of fixture.
  const events = longHistory();
  return Array.from({ length: count }, (_unused, index) => ({
    conversationId: `run-${String(index)}`,
    events,
  }));
};

test("many conversations of five hundred maximum-size events share one whole-message ceiling", () => {
  for (const count of [1, 2, 8, 40]) {
    const state = catalogEventHistories({
      histories: manyConversations(count),
      activeConversationId: "run-0",
    });
    const bytes = wholeMessageBytes(state);
    assert.ok(
      bytes <= EVENT_HISTORY_AGGREGATE_BYTES,
      `${String(count)} conversations sent ${String(bytes)} bytes`,
    );
    assert.equal(Object.keys(state).length, count);
  }
});

test("every conversation keeps the newest metadata its status is read from", () => {
  const state = catalogEventHistories({
    histories: manyConversations(40),
    activeConversationId: "run-0",
  });
  Object.entries(state).forEach(([conversationId, views]) => {
    assert.ok(views.length > 0, `${conversationId} lost every row`);
    const newest = views[views.length - 1];
    assert.equal(newest.id, 500, `${conversationId} kept an older row instead of the newest`);
    assert.equal(typeof newest.type, "string");
    assert.equal(typeof newest.createdAt, "string");
    views.forEach((view) => {
      assert.equal(typeof view.type, "string");
      assert.equal(typeof view.id, "number");
    });
  });
});

test("the active conversation is the one the detail budget is spent on first", () => {
  const histories = manyConversations(8);
  const state = catalogEventHistories({ histories, activeConversationId: "run-5" });
  const activeDetail = payloadBytes(state["run-5"]);
  const otherDetail = payloadBytes(state["run-0"]);
  assert.ok(activeDetail > 0, "the active conversation carried no detail at all");
  assert.ok(
    activeDetail >= otherDetail,
    `active carried ${String(activeDetail)} bytes, inactive ${String(otherDetail)}`,
  );
  const ruled = state["run-5"].find((view) => view.type === "decision.published");
  assert.notEqual(ruled, undefined);
  assert.notEqual(ruled.payload, undefined, "the active conversation's newest ruling lost its payload");
  assert.equal(ruled.payload.ruledBy, "claude");
});

test("selecting another conversation gives it the active share, with nothing stale left over", () => {
  const histories = manyConversations(8);
  const before = catalogEventHistories({ histories, activeConversationId: "run-0" });
  const after = catalogEventHistories({ histories, activeConversationId: "run-7" });
  const ruled = after["run-7"].find((view) => view.type === "decision.published");
  assert.notEqual(ruled.payload, undefined, "the newly active conversation's ruling stayed empty");
  assert.ok(payloadBytes(after["run-7"]) >= payloadBytes(before["run-7"]));
  assert.ok(payloadBytes(before["run-0"]) >= payloadBytes(after["run-0"]));
  // The projection is a function of what it was handed, so a second read of the same inputs is the
  // same answer: nothing from the previous active conversation survives into this one.
  assert.deepEqual(
    catalogEventHistories({ histories, activeConversationId: "run-7" }),
    after,
  );
});

test("an execution plan longer than the schema allows is refused, never cut into a shorter one", () => {
  const steps = Array.from({ length: 200 }, (_unused, index) => ({
    id: `s${String(index)}`,
    name: `Step ${String(index)}`,
  }));
  const view = catalogEventView({
    id: 1,
    type: "run.restarted",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { pipeline: { hash: "a".repeat(64), steps } },
  });
  assert.equal(view.attempt, undefined, "a two-hundred-step plan was truncated into a shorter one");
});

test("an attempt whose identifiers exceed the schema is refused rather than trimmed", () => {
  const view = catalogEventView({
    id: 2,
    type: "run.restarted",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: {
      pipeline: {
        hash: "a".repeat(64),
        steps: [{ id: "plan", name: "N".repeat(5_000) }],
      },
    },
  });
  assert.equal(view.attempt, undefined);
});

test("event metadata is bounded and redacted, not trusted because the controller wrote it", () => {
  const view = catalogEventView({
    id: 3,
    type: "step.started",
    status: "s".repeat(5_000),
    title: `authorization: Bearer sk-live-ABCDEFGHIJKLMNOP ${"T".repeat(5_000)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload: { stepId: "p".repeat(5_000) },
  });
  assert.ok(Buffer.byteLength(view.status, "utf8") <= 128);
  assert.ok(Buffer.byteLength(view.title, "utf8") <= 512);
  assert.ok(Buffer.byteLength(view.stepId, "utf8") <= 130);
  assert.match(view.title, /authorization: \[REDACTED\]/u);
  assert.equal(view.title.includes("sk-live"), false);
});

// The refusals and the empty cases, stated once each: an attempt boundary is either the plan that
// ran or absent, and the whole-message budget has to behave at its edges as well as in the middle.

const attemptOf = (pipeline) =>
  catalogEventView({ id: 9, type: "run.restarted", createdAt: "t", payload: { pipeline } }).attempt;

test("an attempt is refused whenever the plan it names cannot be trusted", () => {
  assert.equal(attemptOf({ steps: [{ id: "a", name: "A" }] }), undefined, "no hash");
  assert.equal(attemptOf({ hash: 7, steps: [{ id: "a", name: "A" }] }), undefined, "hash is not a string");
  assert.equal(attemptOf({ hash: "h", steps: "not an array" }), undefined, "steps is not an array");
  assert.equal(attemptOf({ hash: "h".repeat(200), steps: [{ id: "a", name: "A" }] }), undefined, "hash too long");
  assert.equal(
    attemptOf({ hash: "h", steps: [{ id: "i".repeat(200), name: "A" }] }),
    undefined,
    "identifier too long",
  );
  assert.equal(attemptOf({ hash: "h", steps: [] }), undefined, "no steps at all");
  assert.equal(attemptOf({ hash: "h", steps: ["plan", { id: 1, name: "A" }, { id: "a", name: 2 }] }), undefined,
    "every entry was unreadable, so no plan survived");
  assert.deepEqual(
    attemptOf({ hash: "h", steps: ["plan", { id: "a", name: "A" }] }),
    { pipelineHash: "h", steps: [{ id: "a", name: "A" }] },
    "a readable step beside an unreadable one still describes the plan",
  );
});

test("no conversations is an empty message, not a divide by zero", () => {
  assert.deepEqual(catalogEventHistories({ histories: [] }), {});
  assert.deepEqual(catalogEventHistories({ histories: [], activeConversationId: "run-1" }), {});
});

test("with no active conversation named, the histories are still spent in listing order", () => {
  const state = catalogEventHistories({ histories: manyConversations(2) });
  assert.equal(Object.keys(state).length, 2);
  assert.ok(payloadBytes(state["run-0"]) > 0);
});

test("a ceiling too small for one row's metadata sends the rows it can and no detail", () => {
  const tiny = catalogEventHistories({
    histories: manyConversations(1),
    activeConversationId: "run-0",
    aggregateBytes: 64,
  });
  assert.deepEqual(tiny, { "run-0": [] });
  // Smaller than the cost of attaching one detail, so the detail pass stops before it looks at a
  // row rather than after.
  assert.deepEqual(
    catalogEventHistories({
      histories: manyConversations(1),
      activeConversationId: "run-0",
      aggregateBytes: 14,
    }),
    { "run-0": [] },
  );
  const some = catalogEventHistories({
    histories: manyConversations(1),
    activeConversationId: "run-0",
    aggregateBytes: 4_096,
  });
  assert.ok(some["run-0"].length > 0, "a four-kilobyte ceiling sent no row at all");
  assert.ok(
    Buffer.byteLength(JSON.stringify(some), "utf8") <= 4_096,
    "a four-kilobyte ceiling was exceeded",
  );
});

test("a detail that would not fit what is left is skipped rather than half sent", () => {
  // Sized so the metadata pass leaves a few hundred bytes: enough for the projector to produce a
  // detail, not enough to keep every one it produces.
  for (const aggregateBytes of [12_000, 20_000, 48_000]) {
    const state = catalogEventHistories({
      histories: manyConversations(1),
      activeConversationId: "run-0",
      aggregateBytes,
    });
    const bytes = Buffer.byteLength(JSON.stringify(state), "utf8");
    assert.ok(bytes <= aggregateBytes, `${String(bytes)} bytes against a ${String(aggregateBytes)} ceiling`);
  }
});
