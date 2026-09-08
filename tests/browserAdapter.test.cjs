const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createBrowserChatGptAdapter,
} = require("../dist/adapters/browserChatGpt.js");
const {
  createBrowserClaudeAdapter,
} = require("../dist/adapters/browserClaude.js");

const collect = async (iterable) => {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
};

const request = (overrides = {}) => ({
  prompt: "exact prompt",
  workingDirectory: "/tmp",
  attachments: [],
  ...overrides,
});

const session = (provider, id = `${provider}-session`) => ({
  id,
  provider,
  tabId: provider === "chatgpt" ? 1 : 2,
  frameId: 0,
  documentToken: `${provider}-document-token`,
  conversationUrl:
    provider === "chatgpt"
      ? "https://chatgpt.com/c/test"
      : "https://claude.ai/chat/test",
  conversationIdentity: `${provider}-conversation`,
  status: "ready",
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
});

const capturedResponse = (provider, id, text = "different final") => ({
  requestId: "request-1",
  agentId: provider,
  sessionId: id,
  provider,
  text,
  segments: [
    { type: "text", text, start: 0, end: text.length },
  ],
  captureFormat: "renderedText",
  fidelity: "bestEffort",
  finalConversationUrl:
    provider === "chatgpt"
      ? "https://chatgpt.com/c/test"
      : "https://claude.ai/chat/test",
  finalConversationIdentity: `${provider}-conversation`,
  finalSessionId: id,
  startedAt: "2026-08-02T00:00:00.000Z",
  completedAt: "2026-08-02T00:00:01.000Z",
});

const addBindingMethods = (bridge) => {
  bridge.bindSession = (_ownerId, sessionId) => {
    const selected = bridge.getStatus().sessions.find((candidate) => candidate.id === sessionId);
    if (!selected) {
      throw new Error("Browser session is not available");
    }
    return {
      provider: selected.provider,
      conversationUrl: selected.conversationUrl,
      conversationIdentity: selected.conversationIdentity,
      preferredTabId: selected.tabId,
    };
  };
  bridge.resolveBoundSession = (_ownerId, binding, expectedSessionId) => {
    const sessions = bridge.getStatus().sessions;
    if (expectedSessionId) {
      return sessions.find((candidate) => candidate.id === expectedSessionId);
    }
    if (!binding) {
      return undefined;
    }
    const candidates = sessions.filter(
      (candidate) =>
        candidate.provider === binding.provider &&
        candidate.conversationIdentity === binding.conversationIdentity,
    );
    return (
      candidates.find((candidate) => candidate.tabId === binding.preferredTabId) ??
      (candidates.length === 1 ? candidates[0] : undefined)
    );
  };
  bridge.releaseBinding = () => undefined;
};

test("browser adapter streams and finishes with authoritative captured text", async () => {
  const browserSession = session("chatgpt", "session-1");
  const bridge = {
    getStatus: () => ({
      enabled: true,
      connected: true,
      selectedSessionId: browserSession.id,
      sessions: [browserSession],
    }),
    sendConversation: async function* () {
      yield { type: "session", sessionId: browserSession.id };
      yield { type: "submitted" };
      yield { type: "text", mode: "append", text: "partial" };
      yield {
        type: "response",
        response: capturedResponse("chatgpt", browserSession.id),
      };
    },
    interrupt: async () => undefined,
  };
  addBindingMethods(bridge);
  const adapter = createBrowserChatGptAdapter({
    id: "chatgpt",
    bridge,
    turnTimeoutMs: 1000,
  });
  try {
    const events = await collect(
      adapter.send(request(), new AbortController().signal),
    );
    assert.equal(
      events.find((event) => event.type === "session").sessionId,
      browserSession.id,
    );
    assert.deepEqual(events.find((event) => event.type === "complete"), {
      type: "complete",
      status: "completed",
      answer: "different final",
    });
    assert.deepEqual(
      events.filter((event) => event.type === "text").map((event) => event.text),
      ["partial"],
    );
    assert.deepEqual(events.find((event) => event.type === "replace"), {
      type: "replace",
      text: "different final",
    });
    assert.equal(
      events.find((event) => event.type === "captured").response.provider,
      "chatgpt",
    );
    assert.equal(adapter.capabilities.resume, true);
    assert.equal(adapter.capabilities.attachments, true);
    assert.equal(adapter.capabilities.repositoryTools, true);
    assert.equal(adapter.capabilities.passiveActionLoop, true);
  } finally {
    await adapter.dispose();
  }
});

test("browser adapter transmits image attachments and binds the requested session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bachata-browser-adapter-"));
  const attachmentPath = path.join(directory, "image.png");
  await writeFile(attachmentPath, Buffer.from([137, 80, 78, 71, 1, 2, 3]));
  const browserSession = session("chatgpt", "session-explicit");
  let observed;
  const bridge = {
    getStatus: () => ({
      enabled: true,
      connected: true,
      sessions: [browserSession, session("chatgpt", "session-other")],
    }),
    sendConversation: async function* (
      agentId,
      prompt,
      expectedSessionId,
      _signal,
      attachments,
    ) {
      observed = { agentId, prompt, expectedSessionId, attachments };
      yield { type: "session", sessionId: expectedSessionId };
      yield { type: "submitted" };
      yield {
        type: "response",
        response: capturedResponse("chatgpt", expectedSessionId, "ok"),
      };
    },
    interrupt: async () => undefined,
  };
  addBindingMethods(bridge);
  const adapter = createBrowserChatGptAdapter({
    id: "chatgpt-agent",
    bridge,
    turnTimeoutMs: 1000,
  });
  try {
    await collect(
      adapter.send(
        request({
          attachments: [attachmentPath],
          sessionId: browserSession.id,
        }),
        new AbortController().signal,
      ),
    );
    assert.equal(observed.agentId, "chatgpt-agent");
    assert.equal(observed.prompt, "exact prompt");
    assert.equal(observed.expectedSessionId, browserSession.id);
    assert.deepEqual(observed.attachments, [
      {
        name: "image.png",
        mimeType: "image/png",
        size: 7,
        dataBase64: Buffer.from([137, 80, 78, 71, 1, 2, 3]).toString("base64"),
      },
    ]);
  } finally {
    await adapter.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser adapter requires explicit selection when multiple provider sessions are ready", async () => {
  const bridge = {
    getStatus: () => ({
      enabled: true,
      connected: true,
      sessions: [session("chatgpt", "one"), session("chatgpt", "two")],
    }),
    sendConversation: async function* () {},
    interrupt: async () => undefined,
  };
  addBindingMethods(bridge);
  const adapter = createBrowserChatGptAdapter({
    id: "chatgpt",
    bridge,
    turnTimeoutMs: 1000,
  });
  try {
    await assert.rejects(
      collect(adapter.send(request(), new AbortController().signal)),
      /Select a ChatGPT browser conversation/,
    );
  } finally {
    await adapter.dispose();
  }
});

test("browser adapter times out an unresponsive browser turn", async () => {
  const browserSession = session("chatgpt", "session-timeout");
  const bridge = {
    getStatus: () => ({
      enabled: true,
      connected: true,
      sessions: [browserSession],
    }),
    sendConversation: async function* (
      _agentId,
      _prompt,
      _expectedSessionId,
      signal,
    ) {
      if (!signal.aborted) {
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
      }
    },
    interrupt: async () => undefined,
  };
  addBindingMethods(bridge);
  const adapter = createBrowserChatGptAdapter({
    id: "chatgpt",
    bridge,
    turnTimeoutMs: 25,
  });
  try {
    await assert.rejects(
      collect(adapter.send(request(), new AbortController().signal)),
      /timed out after 25 ms/,
    );
  } finally {
    await adapter.dispose();
  }
});

test("Claude browser adapter filters sessions by provider", async () => {
  const claudeSession = session("claude", "claude-ready");
  let selected;
  const bridge = {
    getStatus: () => ({
      enabled: true,
      connected: true,
      sessions: [session("chatgpt", "chatgpt-ready"), claudeSession],
    }),
    sendConversation: async function* (
      _agentId,
      _prompt,
      expectedSessionId,
    ) {
      selected = expectedSessionId;
      yield { type: "session", sessionId: expectedSessionId };
      yield { type: "submitted" };
      yield {
        type: "response",
        response: capturedResponse("claude", expectedSessionId, "claude answer"),
      };
    },
    interrupt: async () => undefined,
  };
  addBindingMethods(bridge);
  const adapter = createBrowserClaudeAdapter({
    id: "claude-browser-agent",
    bridge,
    turnTimeoutMs: 1000,
  });
  try {
    const events = await collect(
      adapter.send(request(), new AbortController().signal),
    );
    assert.equal(selected, claudeSession.id);
    assert.equal(
      events.find((event) => event.type === "captured").response.provider,
      "claude",
    );
  } finally {
    await adapter.dispose();
  }
});
