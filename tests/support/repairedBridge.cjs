const assert = require("node:assert/strict");
const { loadFixture } = require("./productionSource.cjs");
const { createStartedBridge, connectAndPair } = loadFixture("tests/browserBridge.test.cjs", ["createStartedBridge", "connectAndPair"]);
const { browserBindingForSession } = require("../../dist/browser/conversationOwnership.js");
const token = "repair-profile-shared-token";
const waitFor = async (predicate, description = "condition", timeout = 2000) => {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const browserSession = (tabId, route = "/", documentToken = `document-${tabId}`) => {
  const conversationUrl = `https://chatgpt.com${route}`;
  const conversationIdentity = `chatgpt:${conversationUrl}`;
  return { id: `chatgpt:${tabId}:${documentToken}:${encodeURIComponent(conversationIdentity)}`, provider: "chatgpt", tabId, frameId: 0,
    documentToken, conversationUrl, conversationIdentity, status: "ready", createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z" };
};
const observe = async (iterable) => {
  const events = [];
  try { for await (const event of iterable) events.push(event); return { events }; }
  catch (error) { return { events, error }; }
};
const withBridge = async (execute) => {
  const { bridge } = await createStartedBridge({ sharedToken: () => token, interruptTimeoutMs: 800 });
  const { socket, collector } = await connectAndPair(bridge);
  const send = (message) => socket.send(JSON.stringify({ protocolVersion: 9, ...message }));
  const publish = async (sessions) => {
    send({ type: "provider.status", sessions, selectedSessionId: sessions[0]?.id });
    await waitFor(() => JSON.stringify(bridge.getStatus().sessions.map((item) => [item.id, item.status])) === JSON.stringify(sessions.map((item) => [item.id, item.status])), "published sessions");
  };
  const terminal = (request, selected, type = "response", final = selected) => {
    const base = { type: `conversation.${type}`, requestId: request.requestId, agentId: request.agentId, sessionId: selected.id };
    if (type === "response") send({ ...base, provider: selected.provider, text: "answer", assets: [], captureFormat: "renderedText", fidelity: "bestEffort",
      segments: [{ type: "text", text: "answer", start: 0, end: 6 }], finalConversationUrl: final.conversationUrl,
      finalConversationIdentity: final.conversationIdentity, finalSessionId: final.id,
      startedAt: "2026-09-19T00:00:00.000Z", completedAt: "2026-09-19T00:00:01.000Z" });
    else send(base);
  };
  const interruptFrames = (id) => collector.seen().filter((frame) => frame.type === "conversation.interrupt" && frame.requestId === id);
  try { return await execute({ bridge, socket, collector, publish, send, terminal, interruptFrames }); }
  finally { socket.close(); await bridge.close(); }
};
const requestFor = (session, prompt = "Review") => ({ prompt, attachments: [], workingDirectory: process.cwd(),
  sessionId: session.id, browserBinding: browserBindingForSession(session) });
const expectSuccess = (result) => { assert.equal(result.error, undefined); return result.events; };
module.exports = { withBridge, browserSession, browserBindingForSession, waitFor, observe, requestFor, expectSuccess, token };
