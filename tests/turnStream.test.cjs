const assert = require("node:assert/strict");
const test = require("node:test");

const {
  capturedBrowserBinding,
  capturedResponseTranscript,
  emptyTurnStream,
  responseOverflowMessage,
  turnDeadlineBreach,
  turnDeadlineMessages,
  turnStreamOutcome,
  turnStreamStep,
  turnWorkspacePolicy,
} = require("../dist/runtime/turnStream.js");

const limits = { agentId: "worker", maxStoredResponseBytes: 16 };

const capturedResponse = (overrides = {}) => ({
  requestId: "req-1",
  agentId: "worker",
  sessionId: "session-1",
  provider: "chatgpt",
  text: "answer",
  segments: [{ kind: "text", text: "answer" }],
  assets: [
    {
      id: "asset-1",
      provider: "chatgpt",
      kind: "image",
      name: "diagram.png",
      mimeType: "image/png",
      size: 12,
      sourceElement: "img",
      downloadAvailable: true,
      previewText: "a diagram",
    },
  ],
  captureFormat: "renderedText",
  fidelity: "bestEffort",
  finalConversationUrl: "https://provider.example/c/2",
  finalConversationIdentity: "conversation-2",
  finalSessionId: "session-2",
  startedAt: "2026-01-01T00:00:00.000Z",
  completedAt: "2026-01-01T00:00:01.000Z",
  ...overrides,
});

// Every event is driven through the reducer from a state the previous events produced, because the
// accounting is the thing under test: a byte ceiling that is only ever checked against a fresh
// state is not the ceiling the turn loop enforces.
const drive = (events, streamLimits = limits) => {
  let state = emptyTurnStream();
  const actions = [];
  for (const event of events) {
    const advanced = turnStreamStep(state, event, streamLimits);
    state = advanced.state;
    actions.push(advanced.action);
  }
  return { state, actions };
};

test("a session event carries the new session id and accounts nothing", () => {
  const { state, actions } = drive([{ type: "session", sessionId: "session-9" }]);
  assert.deepEqual(actions, [{ kind: "session", sessionId: "session-9" }]);
  assert.equal(state.streamedBytes, 0);
  assert.equal(state.result, undefined);
});

test("text appends and accumulates bytes across events", () => {
  const { state, actions } = drive([
    { type: "text", text: "ab" },
    { type: "text", text: "cd" },
  ]);
  assert.deepEqual(actions, [
    { kind: "append", text: "ab" },
    { kind: "append", text: "cd" },
  ]);
  assert.equal(state.streamedBytes, 4);
});

test("byte accounting is utf-8, not code units", () => {
  const { state } = drive([{ type: "text", text: "é" }]);
  assert.equal(state.streamedBytes, 2);
});

test("accumulated text over the ceiling overflows, and the message names the ceiling", () => {
  const { actions } = drive([
    { type: "text", text: "0123456789" },
    { type: "text", text: "0123456789" },
  ]);
  assert.deepEqual(actions[1], {
    kind: "overflow",
    message: responseOverflowMessage("worker", 16),
  });
  assert.equal(responseOverflowMessage("worker", 16), "worker response exceeded 16 bytes");
});

test("replace resets the running count rather than adding to it", () => {
  const { state, actions } = drive([
    { type: "text", text: "0123456789" },
    { type: "replace", text: "abc" },
  ]);
  assert.deepEqual(actions[1], { kind: "replace", text: "abc" });
  assert.equal(state.streamedBytes, 3);
});

test("a replace over the ceiling overflows on its own length", () => {
  const { actions } = drive([{ type: "replace", text: "0123456789abcdefg" }]);
  assert.deepEqual(actions[0], {
    kind: "overflow",
    message: responseOverflowMessage("worker", 16),
  });
});

test("status is ignored and a notice is said without ending the turn", () => {
  const { state, actions } = drive([
    { type: "status", value: "thinking" },
    { type: "notice", message: "Stop did not take" },
    { type: "complete", status: "completed", answer: "done" },
  ]);
  assert.deepEqual(actions[0], { kind: "ignore" });
  assert.deepEqual(actions[1], { kind: "notice", message: "Stop did not take" });
  assert.deepEqual(actions[2], { kind: "completed" });
  assert.deepEqual(state.result, { status: "completed", answer: "done" });
});

test("an error event is a failure the turn must raise", () => {
  const { actions } = drive([{ type: "error", message: "provider refused" }]);
  assert.deepEqual(actions[0], { kind: "failure", message: "provider refused" });
});

test("a captured response is retained and handed to the boundary", () => {
  const response = capturedResponse();
  const { state, actions } = drive([{ type: "captured", response }]);
  assert.deepEqual(actions[0], { kind: "captured", response });
  assert.equal(state.capturedResponse, response);
});

test("a second completion replaces the first and late events still account", () => {
  const { state, actions } = drive([
    { type: "complete", status: "interrupted", answer: "partial" },
    { type: "text", text: "more" },
    { type: "complete", status: "completed", answer: "final" },
  ]);
  assert.deepEqual(actions[1], { kind: "append", text: "more" });
  assert.deepEqual(state.result, { status: "completed", answer: "final" });
  assert.equal(state.streamedBytes, 4);
});

test("a stream that never completed is a failure, not an empty answer", () => {
  const outcome = turnStreamOutcome(emptyTurnStream(), limits);
  assert.equal(outcome.failure, "worker stream ended without a completion event");
  assert.equal(outcome.entry, undefined);
});

test("a final answer over the ceiling is refused even when nothing streamed crossed it", () => {
  const { state } = drive([
    { type: "complete", status: "completed", answer: "0123456789abcdefg" },
  ]);
  assert.equal(state.streamedBytes, 0);
  assert.equal(turnStreamOutcome(state, limits).failure, responseOverflowMessage("worker", 16));
});

test("a completed turn without a capture writes a plain answer entry", () => {
  const { state } = drive([{ type: "complete", status: "completed", answer: "done" }]);
  const outcome = turnStreamOutcome(state, limits);
  assert.equal(outcome.failure, undefined);
  assert.deepEqual(outcome.entry, { kind: "answer", answer: "done" });
  assert.equal(outcome.capturedResponse, undefined);
  assert.deepEqual(outcome.result, { status: "completed", answer: "done" });
});

test("an interrupted turn writes an interrupted entry", () => {
  const { state } = drive([{ type: "complete", status: "interrupted", answer: "half" }]);
  assert.equal(turnStreamOutcome(state, limits).entry.kind, "interrupted");
});

test("a captured turn carries the browser ledger payload and the capture itself", () => {
  const response = capturedResponse();
  const { state } = drive([
    { type: "captured", response },
    { type: "complete", status: "completed", answer: "done" },
  ]);
  const outcome = turnStreamOutcome(state, limits);
  assert.equal(outcome.entry.eventType, "browser.response");
  assert.equal(outcome.capturedResponse, response);
  assert.deepEqual(outcome.entry.payload, capturedResponseTranscript(response));
});

test("the ledger payload carries the capture's identity and sanitised assets, and nothing else", () => {
  const payload = capturedResponseTranscript(capturedResponse());
  assert.deepEqual(Object.keys(payload).sort(), [
    "assets",
    "completedAt",
    "finalSessionId",
    "provider",
    "requestId",
    "segments",
    "sessionId",
    "startedAt",
  ]);
  assert.equal(payload.assets[0].id, "asset-1");
  assert.equal(payload.assets[0].sourceOrigin, undefined);
  assert.equal(payload.text, undefined);
});

test("a browser agent binds the conversation the capture ended on", () => {
  const response = capturedResponse();
  assert.deepEqual(
    capturedBrowserBinding({ adapterType: "chatgpt-browser", response, preferredTabId: 7 }),
    {
      provider: "chatgpt",
      conversationUrl: "https://provider.example/c/2",
      conversationIdentity: "conversation-2",
      preferredTabId: 7,
    },
  );
});

test("no preferred tab is carried when the person never chose one", () => {
  const binding = capturedBrowserBinding({
    adapterType: "chatgpt-browser",
    response: capturedResponse(),
  });
  assert.equal("preferredTabId" in binding, false);
});

test("a local adapter binds nothing even if it captured a response", () => {
  assert.equal(
    capturedBrowserBinding({ adapterType: "claude-code", response: capturedResponse() }),
    undefined,
  );
});

test("a turn never commits, and an automated turn gets no shell and no network", () => {
  const policy = turnWorkspacePolicy({
    readOnly: false,
    writeScope: "task",
    allowedPaths: ["/repo"],
    automated: true,
  });
  assert.equal(policy.commitMode, "never");
  assert.equal(policy.disableShell, true);
  assert.equal(policy.disableNetwork, true);
  assert.equal(policy.automated, true);
  assert.equal("readPaths" in policy, false);
  assert.equal("restrictedPaths" in policy, false);
});

test("a typed turn keeps its shell and network, and its path lists are copies", () => {
  const allowedPaths = ["/repo"];
  const readPaths = ["/repo/docs"];
  const protectedPaths = ["/repo/.git"];
  const policy = turnWorkspacePolicy({
    readOnly: true,
    allowedPaths,
    readPaths,
    protectedPaths,
    automated: false,
  });
  assert.equal(policy.disableShell, false);
  assert.equal(policy.commitMode, "never");
  assert.deepEqual(policy.readPaths, ["/repo/docs"]);
  assert.deepEqual(policy.restrictedPaths, ["/repo/.git"]);
  assert.equal(policy.writeScope, undefined);
  allowedPaths.push("/elsewhere");
  assert.deepEqual(policy.allowedPaths, ["/repo"]);
});

test("no deadline in scope is no breach", () => {
  assert.equal(turnDeadlineBreach([], 10_000), undefined);
  assert.equal(
    turnDeadlineBreach([{ kind: "managed", at: undefined, expired: false }], 10_000),
    undefined,
  );
  assert.equal(
    turnDeadlineBreach([{ kind: "browserOperation", at: 20_000, expired: false }], 10_000),
    undefined,
  );
});

test("a deadline already marked expired breaches whatever the clock says", () => {
  assert.deepEqual(
    turnDeadlineBreach([{ kind: "browserOperation", at: 99_000, expired: true }], 10_000),
    { kind: "browserOperation", message: turnDeadlineMessages.browserOperation },
  );
});

test("the clock alone breaches, and the first deadline in scope is the one reported", () => {
  assert.deepEqual(
    turnDeadlineBreach(
      [
        { kind: "managed", at: 5_000, expired: false },
        { kind: "browserOperation", at: 1_000, expired: false },
      ],
      10_000,
    ),
    { kind: "managed", message: "Managed task deadline expired" },
  );
  assert.equal(turnDeadlineMessages.browserOperation, "Browser operation deadline expired");
});
