const assert = require("node:assert/strict");
const test = require("node:test");
const { createManagedPromptSender, freshManagedBrowserBinding, managedPromptGeneration } = require("../dist/browser/managedPromptSession.js");
const { composeManagedRolloverPrompt, MANAGED_CONVERSATION_MIN_BYTES } = require("../dist/browser/managedConversationBudget.js");
const { browserControlProtocolPrompt, browserReadOnlyControlProtocolReminder } = require("../dist/browser/controlProtocol.js");
const { managedBrowserWirePrompt } = require("../dist/runtime/browserPromptContracts.js");

const full = "Current evidence\n\n" + browserControlProtocolPrompt;
const compact = "Current evidence\n\n" + browserReadOnlyControlProtocolReminder;
test("fresh native handoffs discard provisional blank-page identity while preserving stable and generic bindings", () => {
  for (const [provider, url] of [["chatgpt", "https://chatgpt.com/"], ["claude", "https://claude.ai/new"]]) {
    assert.equal(freshManagedBrowserBinding({ provider, conversationUrl: url, conversationIdentity: `${provider}:${url}`,
      preferredTabId: 1, provisionalDocumentToken: "blank-document" }), undefined);
  }
  const stable = { provider: "chatgpt", conversationUrl: "https://chatgpt.com/c/test", conversationIdentity: "chatgpt:https://chatgpt.com/c/test", preferredTabId: 1 };
  assert.equal(freshManagedBrowserBinding(stable), stable);
  const generic = { provider: "generic", conversationUrl: "https://chat.example/chat", conversationIdentity: "generic:chat", preferredTabId: 2 };
  assert.equal(freshManagedBrowserBinding(generic), generic);
});
const prompt = { full, compact, fullContract: true };
const session = () => ({ provider: "chatgpt", tabId: 1, frameId: 0, documentToken: "document-1",
  conversationUrl: "https://chatgpt.com/c/test", conversationIdentity: "chatgpt:https://chatgpt.com/c/test",
  capabilities: { conversationState: "confirmed" }, status: "ready" });
const setup = (options = {}) => {
  let generation = "generation-1";
  const sent = [], rehydrations = [];
  const send = createManagedPromptSender({ compactReadOnly: true, maxBytes: MANAGED_CONVERSATION_MIN_BYTES,
    initialPrompt: full, initialAnswer: "", initialSucceeded: true, generation: () => generation,
    rehydrate: async (continuation, reason) => {
      rehydrations.push({ continuation, reason }); generation = "generation-" + String(rehydrations.length + 1);
      return composeManagedRolloverPrompt({ preparedPrompt: "CURRENT SOURCE\n\n" + browserControlProtocolPrompt,
        continuationPrompt: continuation, maxBytes: MANAGED_CONVERSATION_MIN_BYTES });
    },
    send: async (text) => { sent.push(text); return { result: { status: "completed", answer: "" } }; }, ...options });
  return { send, sent, rehydrations, setGeneration: (value) => { generation = value; } };
};

test("only opted-in operations with confirmed full-contract exposure compact", async () => {
  const active = setup(); await active.send(prompt, "results"); assert.deepEqual(active.sent, [compact]);
  for (const options of [{ compactReadOnly: false }, { initialSucceeded: false }, { generation: () => undefined }]) {
    const ordinary = setup(options); await ordinary.send(prompt, "results"); assert.deepEqual(ordinary.sent, [full]);
  }
});

test("unique wire markers preserve the source and count before rollover admission", async () => {
  const first = managedBrowserWirePrompt(full), second = managedBrowserWirePrompt(full);
  assert.match(first, /^BACHATA_REQUEST_ID:[0-9a-f-]{36}\n\n/u);
  assert.equal(first.slice(first.indexOf("\n\n") + 2), full); assert.notEqual(first, second);
  const sent = [], rehydrations = [];
  const markerBytes = Buffer.byteLength(first) - Buffer.byteLength(full);
  const send = createManagedPromptSender({ compactReadOnly: true, maxBytes: MANAGED_CONVERSATION_MIN_BYTES,
    initialPrompt: "x".repeat(MANAGED_CONVERSATION_MIN_BYTES - Buffer.byteLength(compact) - markerBytes + 1),
    initialAnswer: "", initialSucceeded: true, generation: () => "stable", framePrompt: managedBrowserWirePrompt,
    rehydrate: async (continuation, reason) => { rehydrations.push(reason); return "fresh handoff\n" + continuation; },
    send: async (text) => { sent.push(text); return { result: { status: "completed", answer: "" } }; } });
  await send(prompt, "result");
  assert.deepEqual(rehydrations, ["budget"]); assert.equal(sent.length, 1);
  assert.match(sent[0], /^BACHATA_REQUEST_ID:/u); assert.ok(sent[0].endsWith(browserControlProtocolPrompt));
});

test("actual compact bytes determine rollover, and returned answer bytes count toward the next dispatch", async () => {
  let generation = "first";
  const sent = [], rehydrations = [];
  const send = createManagedPromptSender({ compactReadOnly: true, maxBytes: MANAGED_CONVERSATION_MIN_BYTES,
    initialPrompt: "x".repeat(MANAGED_CONVERSATION_MIN_BYTES - Buffer.byteLength(compact)), initialAnswer: "",
    initialSucceeded: true, generation: () => generation,
    send: async (text) => { sent.push(text); return { result: { status: "completed", answer: "ญ" } }; },
    rehydrate: async (continuation, reason) => { rehydrations.push({ continuation, reason }); generation = "fresh";
      return composeManagedRolloverPrompt({ preparedPrompt: "FRESH FULL HANDOFF", continuationPrompt: continuation, maxBytes: MANAGED_CONVERSATION_MIN_BYTES }); },
  });
  await send(prompt, "results"); assert.equal(sent[0], compact); assert.equal(rehydrations.length, 0);
  await send(prompt, "results"); assert.equal(rehydrations[0].reason, "budget"); assert.equal(rehydrations[0].continuation, full);
  assert.ok(sent[1].includes("FRESH FULL HANDOFF")); assert.ok(sent[1].endsWith(browserControlProtocolPrompt));
  await send(prompt, "results"); assert.equal(sent[2], compact); assert.equal(rehydrations.length, 1);
});

test("changed and uncertain generations receive a full handoff before continuing", async () => {
  for (const generation of ["other-chat", undefined]) {
    const active = setup(); active.setGeneration(generation); await active.send(prompt, "results");
    assert.equal(active.rehydrations[0].reason, "generation");
    assert.equal(active.rehydrations[0].continuation, full); assert.ok(active.sent[0].includes("CURRENT SOURCE"));
    await active.send(prompt, "results"); assert.equal(active.sent[1], compact);
  }
});

test("a generation change during a compact send rehydrates the next dispatch", async () => {
  let generation = "old"; const sent = [];
  const send = createManagedPromptSender({ compactReadOnly: true, maxBytes: MANAGED_CONVERSATION_MIN_BYTES,
    initialPrompt: full, initialAnswer: "", initialSucceeded: true, generation: () => generation,
    send: async (text) => { sent.push(text); generation = "new"; return { result: { status: "completed", answer: "" } }; },
    rehydrate: async (continuation, reason) => { assert.equal(reason, "generation"); return "FRESH SOURCE\n\n" + continuation; },
  });
  await send(prompt, "results"); await send(prompt, "results");
  assert.equal(sent[0], compact); assert.ok(sent[1].startsWith("FRESH SOURCE"));
});

test("repairs remain full, failed sends lose exposure, and a restarted sender never inherits it", async () => {
  const active = setup(); await active.send({ full: "REPAIR\n\n" + browserControlProtocolPrompt, fullContract: true }, "repair");
  assert.ok(active.sent[0].startsWith("REPAIR")); await active.send(prompt, "results"); assert.equal(active.sent[1], compact);
  const restarted = setup({ initialSucceeded: false }); await restarted.send(prompt, "results");
  assert.equal(restarted.sent[0], full); await restarted.send(prompt, "results"); assert.equal(restarted.sent[1], compact);
  let fail = true; const calls = [];
  const failed = setup({ send: async (text) => { calls.push(text); if (fail) { fail = false; throw new Error("disconnected"); }
    return { result: { status: "completed", answer: "" } }; } });
  await assert.rejects(failed.send(prompt, "results"), /disconnected/);
  await failed.send(prompt, "results"); assert.deepEqual(calls, [compact, full]);
});

test("oversized rehydration cannot reach the provider", async () => {
  const active = setup({ initialPrompt: "x".repeat(MANAGED_CONVERSATION_MIN_BYTES),
    rehydrate: async () => "x".repeat(MANAGED_CONVERSATION_MIN_BYTES + 1) });
  await assert.rejects(active.send(prompt, "results"), /rehydration exceeds/); assert.equal(active.sent.length, 0);
});

test("conversation identity includes the provider, frame, tab and document, and refuses uncertain sessions", () => {
  const current = session(); const key = managedPromptGeneration(current); assert.ok(key);
  for (const patch of [{ documentToken: "reloaded" }, { tabId: 2 }, { frameId: 1 },
    { conversationUrl: "https://chatgpt.com/c/next", conversationIdentity: "chatgpt:https://chatgpt.com/c/next" }]) {
    assert.notEqual(managedPromptGeneration({ ...current, ...patch }), key);
  }
  for (const patch of [{ capabilities: { conversationState: "uncertain" } }, { documentToken: "" }, { status: "failed" },
    { conversationUrl: "https://chatgpt.com/", conversationIdentity: "chatgpt:https://chatgpt.com/" }]) {
    assert.equal(managedPromptGeneration({ ...current, ...patch }), undefined);
  }
  assert.equal(managedPromptGeneration(), undefined);
});
