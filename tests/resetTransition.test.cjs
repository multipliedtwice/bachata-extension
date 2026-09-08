const assert = require("node:assert/strict");
const test = require("node:test");

const {
  resetAgentProjection,
  resetBoundSession,
} = require("../dist/runtime/resetTransition.js");

// EX-AUD-12. What a reset leaves each agent as. This lived in the middle of the reset's own
// destructive sequence — abort, interrupt, clear, persist, roll back — so the only way to ask it
// anything was to reset a whole runtime.

const session = (overrides = {}) => ({
  id: "session-1",
  status: "ready",
  provider: "chatgpt",
  conversationIdentity: "chatgpt:https://chatgpt.com/c/one",
  ...overrides,
});

test("a browser agent stays idle while the session it recorded is still ready", () => {
  const agent = { adapterType: "codex-browser", sessionId: "session-1" };
  assert.deepEqual(resetAgentProjection(agent, [session()]), {
    status: "idle",
    keepsSession: true,
  });
});

test("a browser agent whose session is gone is available, and still keeps its session id", () => {
  const agent = { adapterType: "codex-browser", sessionId: "session-1" };
  assert.deepEqual(resetAgentProjection(agent, []), {
    status: "available",
    keepsSession: true,
  });
  // A session that exists but is not ready is not a session it is bound to.
  assert.equal(
    resetAgentProjection(agent, [session({ status: "closed" })]).status,
    "available",
  );
});

test("a renumbered session is found by the conversation the agent was bound to", () => {
  const agent = {
    adapterType: "claude-browser",
    sessionId: "session-old",
    browserBinding: {
      provider: "claude",
      conversationIdentity: "claude:https://claude.ai/chat/one",
    },
  };
  const renumbered = session({
    id: "session-new",
    provider: "claude",
    conversationIdentity: "claude:https://claude.ai/chat/one",
  });
  assert.equal(resetBoundSession(agent, [renumbered]), renumbered);
  assert.equal(resetAgentProjection(agent, [renumbered]).status, "idle");
  // Another conversation on the same provider is not the one it was bound to.
  assert.equal(
    resetAgentProjection(agent, [
      session({ id: "session-new", provider: "claude", conversationIdentity: "claude:https://claude.ai/chat/two" }),
    ]).status,
    "available",
  );
});

test("an agent with no binding at all matches only by the session id it recorded", () => {
  const agent = { adapterType: "codex-browser", sessionId: "session-1" };
  assert.equal(
    resetBoundSession(agent, [session({ id: "another" })]),
    undefined,
  );
});

test("a local agent loses its session and is described by whether it was ever reached", () => {
  assert.deepEqual(
    resetAgentProjection({ adapterType: "codex-app-server", sessionId: "session-1", version: "1.2.3" }, []),
    { status: "available", keepsSession: false },
  );
  assert.deepEqual(
    resetAgentProjection({ adapterType: "codex-app-server", sessionId: "session-1" }, []),
    { status: "unknown", keepsSession: false },
  );
  // A live browser session says nothing about a local agent.
  assert.equal(
    resetAgentProjection({ adapterType: "codex-app-server", sessionId: "session-1" }, [session()]).status,
    "unknown",
  );
});

// EX-3. What a failed reset may undo, decided from how far it got.
const { TASK_RESET_ROLLBACK_INCOMPLETE, taskResetRollbackPlan } = require("../dist/runtime/resetTransition.js");

const phase = (overrides = {}) =>
  taskResetRollbackPlan({
    destructivePhaseStarted: false,
    hasStateBackup: false,
    hasStoreBackups: false,
    transitionPrepared: false,
    transitionCommitted: false,
    runtimeStatePersisted: false,
    ...overrides,
  });

test("a failure before anything was cleared puts the task id back and restores nothing", () => {
  assert.deepEqual(phase(), {
    restoreStores: false,
    rollbackTransition: false,
    restoreTaskId: true,
    persistAgain: false,
  });
});

test("a failure after the stores were cleared restores them and does not take the task id back", () => {
  assert.deepEqual(
    phase({ destructivePhaseStarted: true, hasStateBackup: true, hasStoreBackups: true }),
    { restoreStores: true, rollbackTransition: false, restoreTaskId: false, persistAgain: false },
  );
});

test("a destructive failure with no usable backup restores nothing rather than half of it", () => {
  for (const missing of [
    { hasStateBackup: false, hasStoreBackups: true },
    { hasStateBackup: true, hasStoreBackups: false },
  ]) {
    const plan = phase({ destructivePhaseStarted: true, ...missing });
    assert.equal(plan.restoreStores, false, JSON.stringify(missing));
    assert.equal(plan.restoreTaskId, false);
  }
});

test("a prepared transition is rolled back until it commits, and never after", () => {
  assert.equal(phase({ transitionPrepared: true }).rollbackTransition, true);
  assert.equal(phase({ transitionPrepared: true, transitionCommitted: true }).rollbackTransition, false);
  assert.equal(phase({ transitionCommitted: true }).rollbackTransition, false);
});

test("the record is written again only when memory and storage now disagree", () => {
  // Nothing was persisted: there is no record to correct.
  assert.equal(phase({ destructivePhaseStarted: true, hasStateBackup: true, hasStoreBackups: true }).persistAgain, false);
  // Persisted and then restored, or persisted and never cleared: both leave storage stale.
  assert.equal(
    phase({ runtimeStatePersisted: true, destructivePhaseStarted: true, hasStateBackup: true, hasStoreBackups: true }).persistAgain,
    true,
  );
  assert.equal(phase({ runtimeStatePersisted: true }).persistAgain, true);
  // Cleared, persisted, and no backup to put back: writing again would record a half reset.
  assert.equal(phase({ runtimeStatePersisted: true, destructivePhaseStarted: true }).persistAgain, false);
});

test("the aggregate a failed rollback raises names both failures", () => {
  assert.equal(TASK_RESET_ROLLBACK_INCOMPLETE, "Task reset failed and rollback was incomplete");
});
