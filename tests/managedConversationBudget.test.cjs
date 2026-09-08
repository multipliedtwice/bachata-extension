const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MANAGED_CONVERSATION_DEFAULT_BYTES,
  MANAGED_CONVERSATION_MAX_BYTES,
  MANAGED_CONVERSATION_MIN_BYTES,
  MANAGED_ROLLOVER_NOTICE,
  composeManagedRolloverPrompt,
  managedConversationMaxBytes,
  managedConversationRolloverRequired,
  managedFreshSessionKey,
  managedRolloverTaskId,
} = require("../dist/browser/managedConversationBudget.js");

test("managed conversation budget clamps configured values into the supported range", () => {
  assert.equal(managedConversationMaxBytes(undefined), MANAGED_CONVERSATION_DEFAULT_BYTES);
  assert.equal(managedConversationMaxBytes(Number.NaN), MANAGED_CONVERSATION_DEFAULT_BYTES);
  assert.equal(managedConversationMaxBytes(0), MANAGED_CONVERSATION_MIN_BYTES);
  assert.equal(managedConversationMaxBytes(-1), MANAGED_CONVERSATION_MIN_BYTES);
  assert.equal(managedConversationMaxBytes(1024), MANAGED_CONVERSATION_MIN_BYTES);
  assert.equal(
    managedConversationMaxBytes(MANAGED_CONVERSATION_MAX_BYTES * 4),
    MANAGED_CONVERSATION_MAX_BYTES,
  );
  assert.equal(managedConversationMaxBytes(1_000_000), 1_000_000);
});

test("managed conversation rollover triggers only when the projected total exceeds the budget", () => {
  const max = MANAGED_CONVERSATION_MIN_BYTES;
  assert.equal(managedConversationRolloverRequired(0, 10, max), false);
  assert.equal(managedConversationRolloverRequired(max - 10, 10, max), false);
  assert.equal(managedConversationRolloverRequired(max, 1, max), true);
  assert.equal(managedConversationRolloverRequired(max - 10, 11, max), true);
  assert.equal(managedConversationRolloverRequired(0, max + 1, max), true);
});

test("a low configured budget forces rollover for an ordinary continuation prompt", () => {
  const configured = managedConversationMaxBytes(1);
  assert.equal(configured, MANAGED_CONVERSATION_MIN_BYTES);
  const priorBytes = MANAGED_CONVERSATION_MIN_BYTES - 32;
  const prompt = "x".repeat(64);
  assert.equal(
    managedConversationRolloverRequired(priorBytes, Buffer.byteLength(prompt, "utf8"), configured),
    true,
  );
});

test("rollover rehydrates authoritative controller state ahead of the pending continuation", () => {
  const prompt = composeManagedRolloverPrompt({
    preparedPrompt: "AUTHORITATIVE CONTROLLER STATE",
    continuationPrompt: "PENDING CONTINUATION",
    maxBytes: MANAGED_CONVERSATION_MIN_BYTES,
  });
  const sections = prompt.split("\n\n");
  assert.deepEqual(sections, [
    "AUTHORITATIVE CONTROLLER STATE",
    MANAGED_ROLLOVER_NOTICE,
    "PENDING CONTINUATION",
  ]);
  assert.ok(
    prompt.indexOf("AUTHORITATIVE CONTROLLER STATE") < prompt.indexOf("PENDING CONTINUATION"),
    "the fresh conversation must receive controller state before the pending continuation",
  );
  assert.match(MANAGED_ROLLOVER_NOTICE, /fresh role conversation/u);
});

test("rollover refuses a rehydration prompt that cannot fit the cumulative budget", () => {
  assert.throws(
    () => composeManagedRolloverPrompt({
      preparedPrompt: "x".repeat(MANAGED_CONVERSATION_MIN_BYTES),
      continuationPrompt: "y".repeat(MANAGED_CONVERSATION_MIN_BYTES),
      maxBytes: MANAGED_CONVERSATION_MIN_BYTES,
    }),
    /Managed conversation rehydration exceeds the \d+ byte cumulative limit/u,
  );
});

test("a rollover cycle resets byte accounting so the next turn starts from the fresh conversation", () => {
  const maxBytes = MANAGED_CONVERSATION_MIN_BYTES;
  let conversationBytes = maxBytes - 16;
  const continuationPrompt = "z".repeat(1024);
  assert.equal(
    managedConversationRolloverRequired(
      conversationBytes,
      Buffer.byteLength(continuationPrompt, "utf8"),
      maxBytes,
    ),
    true,
  );
  const rehydrated = composeManagedRolloverPrompt({
    preparedPrompt: "CONTROLLER STATE",
    continuationPrompt,
    maxBytes,
  });
  conversationBytes = 0;
  conversationBytes += Buffer.byteLength(rehydrated, "utf8");
  assert.ok(conversationBytes < maxBytes);
  assert.equal(
    managedConversationRolloverRequired(conversationBytes, 16, maxBytes),
    false,
    "the fresh conversation must not immediately roll over again",
  );
});

test("each rollover requests a distinct fresh-session key so the exhausted conversation is never reused", () => {
  const taskId = "TASK-7";
  const agentId = "gpt-worker";
  const baseKey = managedFreshSessionKey(taskId, agentId);
  const keys = [1, 2, 3].map((index) =>
    managedFreshSessionKey(managedRolloverTaskId(taskId, index), agentId),
  );
  assert.equal(new Set(keys).size, keys.length, "rollover keys must be unique per cycle");
  assert.ok(
    !keys.includes(baseKey),
    "a rollover key must never equal the original turn key, otherwise the fresh-session cache silently skips reopening",
  );
  assert.deepEqual(keys, [
    "TASK-7:rollover:1:gpt-worker",
    "TASK-7:rollover:2:gpt-worker",
    "TASK-7:rollover:3:gpt-worker",
  ]);
});

test("fresh-session keys stay distinct across agents sharing one rollover cycle", () => {
  const rolloverTask = managedRolloverTaskId("TASK-7", 1);
  assert.notEqual(
    managedFreshSessionKey(rolloverTask, "gpt-worker"),
    managedFreshSessionKey(rolloverTask, "gpt-lead"),
  );
});
