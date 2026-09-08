const assert = require("node:assert/strict");
const test = require("node:test");

const {
  answeredByLead,
  approvalStillCurrent,
  collectInteractionAnswers,
  interactionDeadline,
  interactionRoute,
  mcpFieldOutcome,
} = require("../dist/runtime/interactionLifecycle.js");

const route = (overrides = {}) =>
  interactionRoute({
    hasBroker: false,
    panelFallback: true,
    disposed: false,
    attachedViews: 1,
    ...overrides,
  });

test("a configured broker takes the request even when a panel is attached", () => {
  assert.deepEqual(route({ hasBroker: true }), { route: "broker" });
});

test("a broker is preferred over a panel that could not be shown anyway", () => {
  assert.deepEqual(route({ hasBroker: true, disposed: true, attachedViews: 0 }), {
    route: "broker",
  });
});

test("without a broker an attached panel asks", () => {
  assert.deepEqual(route(), { route: "panel" });
});

test("a disposed runtime asks nobody, and says so", () => {
  assert.deepEqual(route({ disposed: true }), { route: "unavailable", reason: "disposed" });
});

test("a runtime with no view asks nobody", () => {
  assert.deepEqual(route({ attachedViews: 0 }), { route: "unavailable", reason: "noView" });
});

test("a flow with no panel fallback and no broker asks nobody", () => {
  assert.deepEqual(route({ panelFallback: false }), { route: "unavailable", reason: "noView" });
});

test("a deadline is a clock reading, and no auto-resolution is no deadline", () => {
  assert.equal(interactionDeadline({ now: 1_000, autoResolutionMs: 250 }), 1_250);
  assert.equal(interactionDeadline({ now: 1_000 }), undefined);
});

const current = (overrides = {}) =>
  approvalStillCurrent({
    registeredIsThisResolver: true,
    operationTaskId: "task-1",
    currentTaskId: "task-1",
    disposed: false,
    ...overrides,
  });

test("an approval nothing replaced, on the running task, is still current", () => {
  assert.equal(current(), true);
});

test("a replaced pending record is no longer current", () => {
  assert.equal(current({ registeredIsThisResolver: false }), false);
});

test("a task that moved on drops the approval", () => {
  assert.equal(current({ currentTaskId: "task-2" }), false);
});

test("a disposed runtime drops the approval", () => {
  assert.equal(current({ disposed: true }), false);
});

test("an owned approval needs its own operation still running", () => {
  assert.equal(
    current({ operationOwnerId: "owner-1", activeOwnerId: "owner-1", activeAborted: false }),
    true,
  );
  assert.equal(
    current({ operationOwnerId: "owner-1", activeOwnerId: "owner-1", activeAborted: true }),
    false,
  );
  assert.equal(current({ operationOwnerId: "owner-1", activeOwnerId: "owner-2" }), false);
  assert.equal(current({ operationOwnerId: "owner-1" }), false);
});

test("an unowned approval does not ask about an operation", () => {
  assert.equal(current({ activeOwnerId: "owner-9", activeAborted: true }), true);
});

test("every question answered answers the set", async () => {
  const asked = [];
  const answers = await collectInteractionAnswers({
    questions: [{ id: "a" }, { id: "b" }],
    keyOf: (question) => question.id,
    ask: async (question, index) => {
      asked.push([question.id, index]);
      return `answer-${question.id}`;
    },
  });
  assert.deepEqual(answers, { a: "answer-a", b: "answer-b" });
  assert.deepEqual(asked, [["a", 0], ["b", 1]]);
});

test("one unanswered question voids the set and stops the asking", async () => {
  const asked = [];
  const answers = await collectInteractionAnswers({
    questions: [{ id: "a" }, { id: "b" }, { id: "c" }],
    keyOf: (question) => question.id,
    ask: async (question) => {
      asked.push(question.id);
      return question.id === "b" ? undefined : question.id;
    },
  });
  assert.equal(answers, undefined);
  assert.deepEqual(asked, ["a", "b"]);
});

test("no questions is an answered empty set, not a refusal", async () => {
  assert.deepEqual(
    await collectInteractionAnswers({
      questions: [],
      keyOf: (question) => question.id,
      ask: async () => undefined,
    }),
    {},
  );
});

test("the key a question is filed under is the caller's, not the question's identity", async () => {
  const answers = await collectInteractionAnswers({
    questions: [{ prompt: "one" }, { prompt: "two" }],
    keyOf: (question, index) => `${String(index)}:${question.prompt}`,
    ask: async (question) => question.prompt,
  });
  assert.deepEqual(answers, { "0:one": "one", "1:two": "two" });
});

test("the Lead answering is recorded as such; nobody else is", () => {
  assert.equal(answeredByLead("lead"), true);
  assert.equal(answeredByLead("user"), false);
  assert.equal(answeredByLead("timeout"), false);
});

test("an answered field is kept, and its secrecy travels with it", () => {
  assert.deepEqual(mcpFieldOutcome({ required: true, secret: true }, "hunter2"), {
    kind: "keep",
    value: "hunter2",
    secret: true,
  });
  assert.deepEqual(mcpFieldOutcome({ required: false, secret: false }, 0), {
    kind: "keep",
    value: 0,
    secret: false,
  });
});

test("an optional field nobody filled is skipped; a required one cancels the form", () => {
  assert.deepEqual(mcpFieldOutcome({ required: false, secret: false }, undefined), {
    kind: "skip",
  });
  assert.deepEqual(mcpFieldOutcome({ required: true, secret: false }, undefined), {
    kind: "cancel",
  });
});
