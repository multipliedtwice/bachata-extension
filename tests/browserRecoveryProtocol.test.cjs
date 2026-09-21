const assert = require("node:assert/strict");
const test = require("node:test");
const { parseBridgeClientMessage } = require("../dist/browser/protocol.js");
const { maximumRecoverableConversations } = require("../dist/browser/recovery.js");
const contract = require("../protocol/browser-protocol-v9.contract.json");
const list = contract.clientCompatibilityFixtures.find((entry) => entry.type === "provider.listRecoverableConversations.result");
const promoted = contract.clientCompatibilityFixtures.find((entry) => entry.type === "conversation.binding");

test("recovery protocol fixtures stay ready for the paired source parity gate", () => {
  for (const fixture of contract.clientCompatibilityFixtures) assert.equal(parseBridgeClientMessage(fixture).success, true, fixture.type);
});
test("recovery list validation refuses malformed, duplicate, oversized and unsafe records", () => {
  assert.equal(parseBridgeClientMessage(list).success, true);
  const record = list.records[0];
  const invalid = [
    [record, record], Array(maximumRecoverableConversations + 1).fill(record), null,
    ...[{ provider: "generic" }, { provider: "claude" }, { id: "latest" }, { createdAt: 0 }, { prompt: "private" }, { title: "private" }, { tabId: 1 }, { conversationIdentity: "chatgpt:other" },
      ...["https://chatgpt.com/", "https://chatgpt.com/c/a?x=1", "https://chatgpt.com:443/c/a", "https://user:secret@chatgpt.com/c/a", "https://evil.test/c/a", `https://chatgpt.com/c/${"x".repeat(3000)}`].map((conversationUrl) => ({ conversationUrl, conversationIdentity: `chatgpt:${conversationUrl}` }))
    ].map((patch) => [{ ...record, ...patch }]),
  ];
  for (const records of invalid) assert.equal(parseBridgeClientMessage({ ...list, records }).success, false, JSON.stringify(records)?.slice(0, 200));
  assert.equal(parseBridgeClientMessage({ ...list, latest: true }).success, false);
});

test("early binding requires an exact stable built-in conversation and valid document session", () => {
  assert.equal(parseBridgeClientMessage(promoted).success, true);
  for (const patch of [{ provider: "generic" }, { provider: "claude" }, { conversationUrl: "https://chatgpt.com/" }, { conversationIdentity: "wrong" }, { status: "notAuthenticated" }, { documentToken: "" }]) {
    assert.equal(parseBridgeClientMessage({ ...promoted, session: { ...promoted.session, ...patch } }).success, false);
  }
  assert.equal(parseBridgeClientMessage({ ...promoted, registryId: "extra" }).success, false);
});
