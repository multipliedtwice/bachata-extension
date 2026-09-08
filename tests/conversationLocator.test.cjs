const assert = require("node:assert/strict");
const test = require("node:test");

const {
  conversationOrigin,
  providerConversationLocator,
} = require("../dist/conversations/conversationLocator.js");

const chat = (overrides) => ({
  chatRef: "C1",
  agentId: "lead",
  role: "Lead",
  provider: "claude-code",
  adapter: "claude-code",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

test("a resumable local session records a locator, not a transcript", () => {
  const locator = providerConversationLocator(chat({ providerSessionId: "session-123" }));
  assert.equal(locator.adapter, "claude-code");
  assert.equal(locator.provider, "claude-code");
  assert.equal(locator.role, "Lead");
  assert.equal(locator.providerSessionId, "session-123");
  assert.equal(locator.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(locator.lastSeenAt, "2026-01-02T00:00:00.000Z");
  assert.equal(locator.reconstruction, "available");
  assert.deepEqual(
    Object.keys(locator).sort(),
    [
      "adapter", "agentId", "chatRef", "createdAt", "lastSeenAt", "provider",
      "providerSessionId", "reconstruction", "reconstructionDetail", "role",
    ],
    "a locator carries no message body of any kind",
  );
});

test("a session Bachata never recorded reports unavailable", () => {
  const locator = providerConversationLocator(chat({}));
  assert.equal(locator.reconstruction, "unavailable");
  assert.match(locator.reconstructionDetail, /cannot be reconstructed/u);
});

test("the Z.AI provider reconstructs like any other resumable local session", () => {
  const locator = providerConversationLocator(chat({
    provider: "zai-glm",
    adapter: "zai-glm",
    providerSessionId: "session-9",
  }));
  assert.equal(locator.reconstruction, "available");
  assert.equal(locator.provider, "zai-glm");
});

test("a browser conversation keeps only the origin, never the conversation path", () => {
  const locator = providerConversationLocator(chat({
    provider: "chatgpt",
    adapter: "chatgpt-browser",
    providerConversationUrl: "https://chatgpt.com/c/6a0f-secret-thread-id?model=x",
    providerConversationIdentity: "6a0f-secret-thread-id",
  }));
  assert.equal(locator.conversationOrigin, "https://chatgpt.com");
  assert.equal(locator.reconstruction, "available");
  assert.equal(JSON.stringify(locator).includes("6a0f-secret-thread-id"), false);
});

test("a browser conversation with no recorded binding reports unavailable", () => {
  const locator = providerConversationLocator(chat({
    provider: "claude",
    adapter: "claude-browser",
  }));
  assert.equal(locator.reconstruction, "unavailable");
});

test("an unknown adapter states unknown rather than guessing", () => {
  const locator = providerConversationLocator(chat({
    provider: "custom",
    adapter: "custom-provider",
    providerSessionId: "session-1",
  }));
  assert.equal(locator.reconstruction, "unknown");
  assert.match(locator.reconstructionDetail, /cannot tell/u);
});

test("a malformed conversation URL yields no origin instead of leaking the raw value", () => {
  assert.equal(conversationOrigin(undefined), undefined);
  assert.equal(conversationOrigin("not a url"), undefined);
  assert.equal(conversationOrigin("https://claude.ai/chat/abc"), "https://claude.ai");
});
