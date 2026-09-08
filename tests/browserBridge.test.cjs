const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const net = require("node:net");
const test = require("node:test");

const {
  createBrowserBridgeServer,
} = require("../dist/browser/bridgeServer.js");
const {
  parseBridgeClientMessage,
} = require("../dist/browser/protocol.js");
const {
  createTextWebSocketServer,
} = require("../dist/browser/webSocketServer.js");

const protocolVersion = 9;
const testExtensionOrigin = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const createCollector = (socket) => {
  const messages = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    messages.push(value);
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index];
      if (!waiter.predicate(value)) {
        continue;
      }
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
      break;
    }
  });
  return {
    next: (predicate, timeoutMs = 3000) => {
      const existing = messages.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new Error("Timed out waiting for WebSocket message"));
          }, timeoutMs),
        };
          waiters.push(waiter);
      });
    },
    // Every frame the server sent, so a test can say what it did *not* send as well.
    seen: () => [...messages],
  };
};

const collect = async (iterable) => {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
};

const session = () => ({
  id: "chatgpt:7:document-token-7:chatgpt%3Ahttps%3A%2F%2Fchatgpt.com%2Fc%2Ftest",
  provider: "chatgpt",
  tabId: 7,
  frameId: 0,
  documentId: "document-7",
  documentToken: "document-token-7",
  conversationUrl: "https://chatgpt.com/c/test",
  conversationIdentity: "chatgpt:https://chatgpt.com/c/test",
  title: "Test chat",
  status: "ready",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
});

const createStartedBridge = async (overrides = {}) => {
  const secrets = new Map();
  const statuses = [];
  const bridge = createBrowserBridgeServer({
    enabled: true,
    secretStore: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => {
        secrets.set(key, value);
      },
      delete: async (key) => {
        secrets.delete(key);
      },
    },
    log: () => undefined,
    onStatusChange: (status) => statuses.push(status),
    pairingTtlMs: 10_000,
    port: 0,
    originOverrideForTests: testExtensionOrigin,
    ...overrides,
  });
  await bridge.start();
  return { bridge, statuses, secrets };
};

const connectAndPair = async (bridge) => {
  const initial = bridge.getStatus();
  assert.match(initial.endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/bachata-browser-bridge-v9$/);
  assert.ok(initial.pairingToken);

  const socket = new WebSocket(initial.endpoint);
  const collector = createCollector(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(
    JSON.stringify({
      type: "bridge.pair",
      protocolVersion,
      token: initial.pairingToken,
    }),
  );
  const paired = await collector.next((value) => value.type === "bridge.paired");
  assert.ok(paired.connectionToken);
  await collector.next((value) => value.type === "bridge.connected");
  await collector.next((value) => value.type === "provider.discover");
  return { socket, collector };
};

const publishSession = async (bridge, socket, value = session()) => {
  socket.send(
    JSON.stringify({
      type: "provider.status",
      protocolVersion,
      sessions: [value],
      selectedSessionId: value.id,
    }),
  );
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (bridge.getStatus().selectedSessionId === value.id) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Bridge did not accept the selected session");
};

test("browser bridge provisions a new provider conversation", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const openPromise = bridge.openConversation("chatgpt");
    const request = await collector.next(
      (value) => value.type === "provider.openConversation",
    );
    assert.equal(request.provider, "chatgpt");
    const opened = session();
    socket.send(
      JSON.stringify({
        type: "provider.openConversation.result",
        protocolVersion,
        requestId: request.requestId,
        provider: "chatgpt",
        success: true,
        session: opened,
      }),
    );
    assert.deepEqual(await openPromise, opened);
    assert.equal(
      bridge.getStatus().sessions.some((candidate) => candidate.id === opened.id),
      true,
    );
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge pairs, binds a session, streams replacements, and preserves captured text", async () => {
  const { bridge, statuses } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const selected = await publishSession(bridge, socket);

    socket.send(
      JSON.stringify({
        type: "bridge.ping",
        protocolVersion,
        nonce: "nonce-1",
      }),
    );
    const pong = await collector.next(
      (value) => value.type === "bridge.pong" && value.nonce === "nonce-1",
    );
    assert.equal(pong.protocolVersion, protocolVersion);

    const eventsPromise = collect(
      bridge.sendConversation(
        "chatgpt",
        "EXACT PROMPT",
        selected.id,
        new AbortController().signal,
      ),
    );
    const send = await collector.next(
      (value) => value.type === "conversation.send",
    );
    assert.equal(send.text, "EXACT PROMPT");
    assert.equal(send.sessionId, selected.id);
    assert.equal(send.tabId, selected.tabId);
    assert.equal(send.frameId, selected.frameId);
    assert.equal(send.documentId, selected.documentId);
    assert.equal(send.documentToken, selected.documentToken);
    assert.equal(send.conversationUrl, selected.conversationUrl);

    socket.send(
      JSON.stringify({
        type: "conversation.submitted",
        protocolVersion,
        requestId: send.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
      }),
    );
    socket.send(
      JSON.stringify({
        type: "conversation.stream",
        protocolVersion,
        requestId: send.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
        mode: "append",
        text: "hello ",
      }),
    );
    socket.send(
      JSON.stringify({
        type: "conversation.stream",
        protocolVersion,
        requestId: send.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
        mode: "replace",
        text: "hello world",
      }),
    );
    socket.send(
      JSON.stringify({
        type: "conversation.response",
        protocolVersion,
        requestId: send.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
        provider: "chatgpt",
        text: "hello world",
        assets: [],
        captureFormat: "renderedText",
        fidelity: "bestEffort",
        segments: [{ type: "text", text: "hello world", start: 0, end: 11 }],
        finalConversationUrl: selected.conversationUrl,
        finalConversationIdentity: selected.conversationIdentity,
        finalSessionId: selected.id,
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
      }),
    );

    const events = await eventsPromise;
    assert.deepEqual(events.map((event) => event.type), [
      "session",
      "submitted",
      "text",
      "text",
      "response",
    ]);
    assert.deepEqual(
      events.filter((event) => event.type === "text"),
      [
        { type: "text", mode: "append", text: "hello " },
        { type: "text", mode: "replace", text: "hello world" },
      ],
    );
    assert.equal(events.at(-1).response.text, "hello world");
    assert.equal(events.at(-1).response.fidelity, "bestEffort");
    assert.equal(statuses.some((status) => status.connected), true);
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge rejects a concurrent request for the same session", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const selected = await publishSession(bridge, socket);

    const firstPromise = collect(
      bridge.sendConversation(
        "chatgpt",
        "FIRST",
        selected.id,
        new AbortController().signal,
      ),
    );
    const firstSend = await collector.next(
      (value) => value.type === "conversation.send" && value.text === "FIRST",
    );

    await assert.rejects(
      collect(
        bridge.sendConversation(
          "chatgpt",
          "SECOND",
          selected.id,
          new AbortController().signal,
        ),
      ),
      /already has an active request/,
    );

    socket.send(
      JSON.stringify({
        type: "conversation.response",
        protocolVersion,
        requestId: firstSend.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
        provider: "chatgpt",
        text: "done",
        assets: [],
        captureFormat: "renderedText",
        fidelity: "bestEffort",
        segments: [{ type: "text", text: "done", start: 0, end: 4 }],
        finalConversationUrl: selected.conversationUrl,
        finalConversationIdentity: selected.conversationIdentity,
        finalSessionId: selected.id,
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
      }),
    );
    await firstPromise;
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge waits for interruption acknowledgement", async () => {
  const { bridge } = await createStartedBridge({ interruptTimeoutMs: 1000 });
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const selected = await publishSession(bridge, socket);
    const controller = new AbortController();

    const eventsPromise = collect(
      bridge.sendConversation(
        "chatgpt",
        "WAIT",
        selected.id,
        controller.signal,
      ),
    );
    const send = await collector.next(
      (value) => value.type === "conversation.send" && value.text === "WAIT",
    );
    controller.abort();
    const interrupt = await collector.next(
      (value) =>
        value.type === "conversation.interrupt" &&
        value.requestId === send.requestId,
    );
    assert.equal(interrupt.sessionId, selected.id);

    socket.send(
      JSON.stringify({
        type: "conversation.interrupted",
        protocolVersion,
        requestId: send.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
      }),
    );
    assert.deepEqual(await eventsPromise, [
      { type: "session", sessionId: selected.id },
      { type: "interrupted" },
    ]);
  } finally {
    socket?.close();
    await bridge.close();
  }
});


// BB-A4-N05. A Stop the browser could not confirm is not the request's terminal outcome. Reported
// as `conversation.error` it was: this server failed the queue and removed the pending operation,
// so the answer that arrived next matched nothing and disappeared. The interruption deadline is
// the same trap from the other side — an operation the Bridge has told us is still running must
// not be failed for an acknowledgement that already came back as a refusal.
test("a failed interruption keeps the request open and its answer still arrives", async () => {
  const { bridge } = await createStartedBridge({ interruptTimeoutMs: 120 });
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const selected = await publishSession(bridge, socket);
    const controller = new AbortController();

    const eventsPromise = collect(
      bridge.sendConversation("chatgpt", "WAIT", selected.id, controller.signal),
    );
    const send = await collector.next(
      (value) => value.type === "conversation.send" && value.text === "WAIT",
    );
    controller.abort();
    await collector.next(
      (value) => value.type === "conversation.interrupt" && value.requestId === send.requestId,
    );

    socket.send(
      JSON.stringify({
        type: "conversation.interruptFailed",
        protocolVersion,
        requestId: send.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
        message: "the stop control vanished",
      }),
    );

    // Well past the interruption deadline: a request the Bridge says is still running must not be
    // failed by a timer that was waiting for an acknowledgement that already came back.
    await new Promise((resolve) => setTimeout(resolve, 400));

    socket.send(
      JSON.stringify({
        type: "conversation.response",
        protocolVersion,
        requestId: send.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
        provider: "chatgpt",
        text: "the answer that raced the stop",
        assets: [],
        captureFormat: "renderedText",
        fidelity: "bestEffort",
        segments: [{ type: "text", text: "the answer that raced the stop", start: 0, end: 30 }],
        finalConversationUrl: selected.conversationUrl,
        finalConversationIdentity: selected.conversationIdentity,
        finalSessionId: selected.id,
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
      }),
    );

    const events = await eventsPromise;
    assert.deepEqual(
      events.map((event) => event.type),
      ["session", "interruptFailed", "response"],
      `a failed Stop consumed the answer that came after it: ${JSON.stringify(events.map((event) => event.type))}`,
    );
    assert.equal(events[1].message, "the stop control vanished");
    assert.equal(events[2].response.text, "the answer that raced the stop");
    assert.equal(
      collector.seen().filter((value) => value.type === "conversation.send").length,
      1,
      "the server resent the turn after the Stop failed",
    );
    assert.equal(
      collector.seen().filter((value) => value.type === "conversation.interrupt").length,
      1,
      "the server reissued the Stop on its own",
    );
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge fails an active request when provider status loses the bound session", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const selected = await publishSession(bridge, socket);
    const eventsPromise = collect(
      bridge.sendConversation(
        "chatgpt",
        "ACTIVE",
        selected.id,
        new AbortController().signal,
      ),
    );
    await collector.next(
      (value) => value.type === "conversation.send" && value.text === "ACTIVE",
    );
    socket.send(
      JSON.stringify({
        type: "provider.status",
        protocolVersion,
        sessions: [],
      }),
    );
    await assert.rejects(eventsPromise, /conversation changed during the active request/);
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge completes an already-aborted request without sending it", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const selected = await publishSession(bridge, socket);
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(
      await collect(
        bridge.sendConversation(
          "chatgpt",
          "ABORTED",
          selected.id,
          controller.signal,
        ),
      ),
      [{ type: "interrupted" }],
    );

    const nextPromise = collect(
      bridge.sendConversation(
        "chatgpt",
        "NEXT",
        selected.id,
        new AbortController().signal,
      ),
    );
    const send = await collector.next(
      (value) => value.type === "conversation.send" && value.text === "NEXT",
    );
    socket.send(
      JSON.stringify({
        type: "conversation.response",
        protocolVersion,
        requestId: send.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
        provider: "chatgpt",
        text: "done",
        assets: [],
        captureFormat: "renderedText",
        fidelity: "bestEffort",
        segments: [{ type: "text", text: "done", start: 0, end: 4 }],
        finalConversationUrl: selected.conversationUrl,
        finalConversationIdentity: selected.conversationIdentity,
        finalSessionId: selected.id,
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
      }),
    );
    await nextPromise;
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge rejects a changed expected session", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const selected = await publishSession(bridge, socket);
    await assert.rejects(
      collect(
        bridge.sendConversation(
          "chatgpt",
          "PROMPT",
          `${selected.id}-stale`,
          new AbortController().signal,
        ),
      ),
      /browser conversation is no longer available|selected ChatGPT conversation changed/,
    );
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge rejects an invalid pairing token", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    socket = new WebSocket(bridge.getStatus().endpoint);
    const collector = createCollector(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(
      JSON.stringify({
        type: "bridge.pair",
        protocolVersion,
        token: "wrong",
      }),
    );
    const error = await collector.next((value) => value.type === "bridge.error");
    assert.equal(error.code, "PAIRING_REJECTED");
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser protocol rejects a selected session missing from the session list", () => {
  const parsed = parseBridgeClientMessage({
    type: "provider.status",
    protocolVersion,
    sessions: [],
    selectedSessionId: "missing",
  });

  assert.equal(parsed.success, false);
  assert.match(parsed.error, /not present in sessions/);
});

const maskedTextFrame = (text) => {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % 4];
  }
  return frame;
};

test("WebSocket server processes a first frame delivered with the upgrade head", async () => {
  let resolveMessage;
  const messagePromise = new Promise((resolve) => {
    resolveMessage = resolve;
  });
  const server = createTextWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/test",
    maxMessageBytes: 1024,
    maxConnections: 2,
    allowOrigin: () => true,
    onConnection: () => undefined,
    onMessage: (_socket, text) => resolveMessage(text),
    onClose: () => undefined,
    onError: () => undefined,
  });
  const port = await server.listen();
  const socket = net.createConnection({ host: "127.0.0.1", port });
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const request = Buffer.from(
      [
        "GET /test HTTP/1.1",
        `Host: 127.0.0.1:${String(port)}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
      "utf8",
    );
    socket.write(Buffer.concat([request, maskedTextFrame("first-frame")]));
    assert.equal(await messagePromise, "first-frame");
  } finally {
    socket.destroy();
    await server.close();
  }
});

test("browser bridge emits a rebound session after an allowed new-chat transition", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const selected = await publishSession(bridge, socket, {
      ...session(),
      id: "chatgpt:7:document-token-7:chatgpt%3Ahttps%3A%2F%2Fchatgpt.com%2F",
      conversationUrl: "https://chatgpt.com/",
      conversationIdentity: "chatgpt:https://chatgpt.com/",
    });
    const eventsPromise = collect(
      bridge.sendConversation(
        "chatgpt",
        "NEW CHAT",
        selected.id,
        new AbortController().signal,
      ),
    );
    const send = await collector.next(
      (value) => value.type === "conversation.send" && value.text === "NEW CHAT",
    );
    assert.equal(send.allowInitialConversationTransition, true);
    socket.send(
      JSON.stringify({
        type: "conversation.response",
        protocolVersion,
        requestId: send.requestId,
        agentId: "chatgpt",
        sessionId: selected.id,
        provider: "chatgpt",
        text: "done",
        segments: [{ type: "text", text: "done", start: 0, end: 4 }],
        assets: [],
        captureFormat: "renderedText",
        fidelity: "bestEffort",
        finalConversationUrl: "https://chatgpt.com/c/new",
        finalConversationIdentity: "chatgpt:https://chatgpt.com/c/new",
        finalSessionId: "chatgpt:7:document-token-7:chatgpt%3Ahttps%3A%2F%2Fchatgpt.com%2Fc%2Fnew",
        startedAt: "2026-08-01T00:00:00.000Z",
        completedAt: "2026-08-01T00:00:01.000Z",
      }),
    );
    const events = await eventsPromise;
    assert.deepEqual(
      events.filter((event) => event.type === "session"),
      [
        { type: "session", sessionId: selected.id },
        {
          type: "session",
          sessionId: "chatgpt:7:document-token-7:chatgpt%3Ahttps%3A%2F%2Fchatgpt.com%2Fc%2Fnew",
        },
      ],
    );
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser protocol rejects response segments that do not cover captured text", () => {
  const parsed = parseBridgeClientMessage({
    type: "conversation.response",
    protocolVersion,
    requestId: "request",
    agentId: "chatgpt",
    sessionId: "session",
    provider: "chatgpt",
    text: "hello",
    segments: [{ type: "text", text: "ell", start: 1, end: 4 }],
    assets: [],
    captureFormat: "renderedText",
    fidelity: "bestEffort",
    finalConversationUrl: "https://chatgpt.com/c/test",
    finalConversationIdentity: "chatgpt:test",
    finalSessionId: "session",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:00:01.000Z",
  });
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /Invalid conversation\.response message/);
});


const maskedFrame = ({ opcode, fin, payload }) => {
  const value = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  assert.ok(value.length < 126);
  const mask = Buffer.from([5, 6, 7, 8]);
  const frame = Buffer.alloc(2 + 4 + value.length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  frame[1] = 0x80 | value.length;
  mask.copy(frame, 2);
  for (let index = 0; index < value.length; index += 1) {
    frame[6 + index] = value[index] ^ mask[index % 4];
  }
  return frame;
};

const readUpgradeStatus = async (port, path = "/test", origin) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const headers = [
    `GET ${path} HTTP/1.1`,
    `Host: 127.0.0.1:${String(port)}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
    "Sec-WebSocket-Version: 13",
  ];
  if (origin) {
    headers.push(`Origin: ${origin}`);
  }
  socket.write([...headers, "", ""].join("\r\n"));
  const response = await new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk) => {
      value += chunk.toString("latin1");
      if (!value.includes("\r\n\r\n")) {
        return;
      }
      socket.off("data", onData);
      resolve(value);
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  socket.destroy();
  return response.split("\r\n")[0];
};

const openRawWebSocket = async (port, path = "/test") => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    [
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${String(port)}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"),
  );
  await new Promise((resolve, reject) => {
    let response = "";
    const onData = (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) {
        return;
      }
      socket.off("data", onData);
      if (!response.startsWith("HTTP/1.1 101")) {
        reject(new Error(`Upgrade rejected: ${response.split("\r\n")[0]}`));
        return;
      }
      resolve();
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
  return socket;
};

test("WebSocket server rejects a new data frame while a fragmented message is active", async () => {
  const errors = [];
  const server = createTextWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/test",
    maxMessageBytes: 1024,
    maxConnections: 2,
    allowOrigin: () => true,
    onConnection: () => undefined,
    onMessage: () => undefined,
    onClose: () => undefined,
    onError: (error) => errors.push(error.message),
  });
  const port = await server.listen();
  const socket = await openRawWebSocket(port);
  try {
    socket.write(
      Buffer.concat([
        maskedFrame({ opcode: 0x1, fin: false, payload: "part" }),
        maskedFrame({ opcode: 0x1, fin: true, payload: "other" }),
      ]),
    );
    for (let attempt = 0; attempt < 50 && errors.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.match(errors.join("\n"), /fragmented WebSocket message is already active/);
  } finally {
    socket.destroy();
    await server.close();
  }
});



test("Browser Bridge rejects an upgrade without an extension Origin", async () => {
  const bridge = createBrowserBridgeServer({
    enabled: true,
    secretStore: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    log: () => undefined,
    onStatusChange: () => undefined,
    pairingTtlMs: 10_000,
    port: 0,
  });
  try {
    await bridge.start();
    const endpoint = new URL(bridge.getStatus().endpoint);
    const status = await readUpgradeStatus(
      Number(endpoint.port),
      endpoint.pathname,
    );
    assert.equal(status, "HTTP/1.1 403 Forbidden");
  } finally {
    await bridge.close();
  }
});

test("Browser Bridge closes unauthenticated sockets after the deadline", async () => {
  const { bridge } = await createStartedBridge({ authenticationTimeoutMs: 30 });
  const endpoint = new URL(bridge.getStatus().endpoint);
  const socket = await openRawWebSocket(Number(endpoint.port), endpoint.pathname);
  try {
    await new Promise((resolve) => socket.once("close", resolve));
    assert.equal(socket.destroyed, true);
  } finally {
    socket.destroy();
    await bridge.close();
  }
});

test("Browser Bridge pairing token disappears when it expires", async () => {
  // The token's window starts when the endpoint is listening, so this polls to a deadline
  // rather than asserting after one fixed sleep: a scheduling delay must not decide the
  // result, and the first observation must still find the token present.
  const pairingTtlMs = 200;
  const { bridge } = await createStartedBridge({ pairingTtlMs });
  try {
    assert.ok(bridge.getStatus().pairingToken, "a started bridge publishes a pairing token");
    const deadline = Date.now() + 10_000;
    let status = bridge.getStatus();
    while (status.pairingToken !== undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      status = bridge.getStatus();
    }
    assert.equal(status.pairingToken, undefined, "the pairing token must not outlive its window");
    assert.equal(status.pairingExpiresAt, undefined);
  } finally {
    await bridge.close();
  }
});

test("a pairing token exists only while an endpoint exists, across every transition", async () => {
  const { bridge } = await createStartedBridge({});
  const holderPort = Number(new URL(bridge.getStatus().endpoint).port);
  const invariant = (status, note) => {
    if (status.pairingToken !== undefined) {
      assert.ok(status.endpoint, `${note}: a pairing token was published with no endpoint`);
    }
    if (status.endpoint === undefined) {
      assert.equal(status.pairingToken, undefined, `${note}: no endpoint may carry a token`);
      assert.equal(status.pairingExpiresAt, undefined, `${note}: no endpoint may carry an expiry`);
    }
  };

  // Listening: a reset rotates the token and keeps the endpoint.
  const before = bridge.getStatus();
  invariant(before, "listening");
  assert.ok(before.pairingToken);
  await bridge.resetPairing();
  const rotated = bridge.getStatus();
  invariant(rotated, "listening after reset");
  assert.ok(rotated.pairingToken, "a listening bridge still offers pairing after a reset");
  assert.notEqual(rotated.pairingToken, before.pairingToken, "the reset rotates the token");
  assert.equal(rotated.error, undefined);

  // Failed listen: no token before or after a reset, and the reason survives.
  const blocked = createBrowserBridgeServer({
    enabled: true,
    port: holderPort,
    secretStore: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    log: () => undefined,
  });
  try {
    await blocked.start();
    const failed = blocked.getStatus();
    invariant(failed, "failed listen");
    assert.equal(failed.pairingToken, undefined);
    const reason = failed.error;
    assert.ok(reason, "a failed listen states why");
    await blocked.resetPairing();
    const afterReset = blocked.getStatus();
    invariant(afterReset, "failed listen after reset");
    assert.equal(afterReset.pairingToken, undefined, "a reset cannot mint a token for an absent endpoint");
    assert.equal(afterReset.error, reason, "a reset preserves the reason the endpoint is unavailable");
  } finally {
    await blocked.close();
  }

  // Closed: no token before or after a reset.
  await bridge.close();
  const closed = bridge.getStatus();
  invariant(closed, "closed");
  assert.equal(closed.pairingToken, undefined, "a closed bridge publishes no pairing token");
  await bridge.resetPairing();
  const closedAfterReset = bridge.getStatus();
  invariant(closedAfterReset, "closed after reset");
  assert.equal(closedAfterReset.pairingToken, undefined, "a reset on a closed bridge mints no token");
});

test("Browser Bridge publishes no pairing token when it cannot listen", async () => {
  const { bridge: holder } = await createStartedBridge({});
  const port = Number(new URL(holder.getStatus().endpoint).port);
  const blocked = createBrowserBridgeServer({
    enabled: true,
    port,
    secretStore: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    log: () => undefined,
  });
  try {
    await blocked.start();
    const status = blocked.getStatus();
    assert.equal(status.pairingToken, undefined, "a failed listen must expose no pairing token");
    assert.equal(status.pairingExpiresAt, undefined);
    assert.equal(status.connected, false);
    assert.equal(status.endpoint, undefined, "no endpoint is published for a listen that failed");
    assert.ok(status.error, "the refusal states why the endpoint is unavailable");
  } finally {
    await blocked.close();
    await holder.close();
  }
});


test("Browser Bridge requires legacy credentials without a pinned origin to pair again", async () => {
  const legacyToken = "legacy-token-v5";
  const secrets = new Map([
    ["bachata.browserBridge.connectionToken.v5", legacyToken],
  ]);
  const operations = [];
  const bridge = createBrowserBridgeServer({
    enabled: true,
    secretStore: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => {
        operations.push(`store:${key}`);
        secrets.set(key, value);
      },
      delete: async (key) => {
        operations.push(`delete:${key}`);
        secrets.delete(key);
      },
    },
    log: () => undefined,
    onStatusChange: () => undefined,
    pairingTtlMs: 10_000,
    port: 0,
    originOverrideForTests: testExtensionOrigin,
  });
  let socket;
  try {
    await bridge.start();
    assert.equal(secrets.has("bachata.browserBridge.connectionToken.v8"), false);
    assert.equal(secrets.has("bachata.browserBridge.connectionToken.v5"), false);
    assert.equal(secrets.has("bachata.browserBridge.extensionOrigin.v8"), false);
    assert.ok(bridge.getStatus().pairingToken);
    assert.ok(
      operations.indexOf("store:bachata.browserBridge.connectionToken.v8") <
        operations.indexOf("delete:bachata.browserBridge.connectionToken.v5"),
    );

    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    assert.equal(
      secrets.get("bachata.browserBridge.extensionOrigin.v8"),
      testExtensionOrigin,
    );
    assert.equal(
      typeof secrets.get("bachata.browserBridge.connectionToken.v8"),
      "string",
    );

    await bridge.resetPairing();
    assert.equal(secrets.has("bachata.browserBridge.connectionToken.v8"), false);
    assert.equal(secrets.has("bachata.browserBridge.extensionOrigin.v8"), false);
    assert.equal(secrets.has("bachata.browserBridge.connectionToken.v4"), false);
    assert.ok(bridge.getStatus().pairingToken);
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("a credential stored under the shipped name is still migrated and cleaned up", async () => {
  // PAIR-ID-01. The key a released build wrote is `pair.browserBridge.connectionToken.v5`. The
  // `pair` to `bachata` rename rewrote the legacy list along with everything else, so the
  // migration looked for a key nothing had ever stored: the user was asked to pair again and the
  // real secret stayed in the store. A test renamed with production could not see that, because
  // it proved only that the list agrees with itself.
  const legacyToken = "legacy-token-shipped-v5";
  const secrets = new Map([["pair.browserBridge.connectionToken.v5", legacyToken]]);
  const operations = [];
  const bridge = createBrowserBridgeServer({
    enabled: true,
    secretStore: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => {
        operations.push(`store:${key}`);
        secrets.set(key, value);
      },
      delete: async (key) => {
        operations.push(`delete:${key}`);
        secrets.delete(key);
      },
    },
    log: () => undefined,
    onStatusChange: () => undefined,
    pairingTtlMs: 10_000,
    port: 0,
    originOverrideForTests: testExtensionOrigin,
  });
  try {
    await bridge.start();
    // The credential was read, carried to the active key, and the old one removed.
    assert.ok(
      operations.includes("store:bachata.browserBridge.connectionToken.v8"),
      JSON.stringify(operations),
    );
    assert.ok(
      operations.includes("delete:pair.browserBridge.connectionToken.v5"),
      JSON.stringify(operations),
    );
    assert.equal(secrets.has("pair.browserBridge.connectionToken.v5"), false);
    // Without a pinned origin the pairing is still required, which is the existing rule and not
    // what this test is about; what it is about is that the legacy secret was found at all.
    assert.ok(bridge.getStatus().pairingToken);
  } finally {
    await bridge.close();
  }
});

test("Browser Bridge rejects a connection token from a different extension origin", async () => {
  const first = await createStartedBridge();
  let firstSocket;
  let secondSocket;
  let secondBridge;
  try {
    const paired = await connectAndPair(first.bridge);
    firstSocket = paired.socket;
    const connectionToken = first.secrets.get("bachata.browserBridge.connectionToken.v8");
    assert.equal(typeof connectionToken, "string");
    firstSocket.close();
    await first.bridge.close();

    const otherOrigin = "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    secondBridge = createBrowserBridgeServer({
      enabled: true,
      secretStore: {
        get: async (key) => first.secrets.get(key),
        store: async (key, value) => first.secrets.set(key, value),
        delete: async (key) => first.secrets.delete(key),
      },
      log: () => undefined,
      onStatusChange: () => undefined,
      pairingTtlMs: 10_000,
      port: 0,
      originOverrideForTests: otherOrigin,
    });
    await secondBridge.start();
    secondSocket = new WebSocket(secondBridge.getStatus().endpoint);
    const collector = createCollector(secondSocket);
    await new Promise((resolve, reject) => {
      secondSocket.addEventListener("open", resolve, { once: true });
      secondSocket.addEventListener("error", reject, { once: true });
    });
    secondSocket.send(JSON.stringify({
      type: "bridge.authenticate",
      protocolVersion,
      connectionToken,
    }));
    const rejection = await collector.next((value) => value.type === "bridge.error");
    assert.equal(rejection.code, "AUTHENTICATION_REJECTED");
    assert.equal(secondBridge.getStatus().connected, false);
  } finally {
    firstSocket?.close();
    secondSocket?.close();
    await secondBridge?.close();
    await first.bridge.close();
  }
});

test("Browser Bridge consumes a pairing token before secure persistence completes", async () => {
  let releaseStore;
  let storeStarted;
  const storedValues = [];
  const storeStartedPromise = new Promise((resolve) => {
    storeStarted = resolve;
  });
  const storeGate = new Promise((resolve) => {
    releaseStore = resolve;
  });
  const { bridge } = await createStartedBridge({
    secretStore: {
      get: async () => undefined,
      store: async (_key, value) => {
        storedValues.push(value);
        storeStarted();
        await storeGate;
      },
      delete: async () => undefined,
    },
  });
  const sockets = [];
  try {
    const status = bridge.getStatus();
    const first = new WebSocket(status.endpoint);
    const second = new WebSocket(status.endpoint);
    sockets.push(first, second);
    const firstCollector = createCollector(first);
    const secondCollector = createCollector(second);
    await Promise.all(
      [first, second].map(
        (socket) =>
          new Promise((resolve, reject) => {
            socket.addEventListener("open", resolve, { once: true });
            socket.addEventListener("error", reject, { once: true });
          }),
      ),
    );
    first.send(JSON.stringify({
      type: "bridge.pair",
      protocolVersion,
      token: status.pairingToken,
    }));
    await storeStartedPromise;
    second.send(JSON.stringify({
      type: "bridge.pair",
      protocolVersion,
      token: status.pairingToken,
    }));
    const rejection = await secondCollector.next(
      (value) => value.type === "bridge.error",
    );
    assert.equal(rejection.code, "AUTHENTICATION_BUSY");
    releaseStore();
    await firstCollector.next((value) => value.type === "bridge.paired");
    assert.deepEqual(storedValues.length, 2);
    assert.equal(storedValues[0], testExtensionOrigin);
  } finally {
    releaseStore?.();
    sockets.forEach((socket) => socket.close());
    await bridge.close();
  }
});

test("Browser Bridge restores pairing when the pairing socket closes during persistence", async () => {
  let releaseStore;
  let storeStarted;
  const secrets = new Map();
  const storeStartedPromise = new Promise((resolve) => {
    storeStarted = resolve;
  });
  const storeGate = new Promise((resolve) => {
    releaseStore = resolve;
  });
  const { bridge } = await createStartedBridge({
    secretStore: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => {
        storeStarted();
        await storeGate;
        secrets.set(key, value);
      },
      delete: async (key) => {
        secrets.delete(key);
      },
    },
  });
  let socket;
  try {
    const status = bridge.getStatus();
    socket = new WebSocket(status.endpoint);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({
      type: "bridge.pair",
      protocolVersion,
      token: status.pairingToken,
    }));
    await storeStartedPromise;
    const closed = new Promise((resolve) => {
      socket.addEventListener("close", resolve, { once: true });
    });
    socket.close();
    await closed;
    releaseStore();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (bridge.getStatus().pairingToken) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(bridge.getStatus().pairingToken);
    assert.equal(bridge.getStatus().connected, false);
    assert.equal(secrets.size, 0);
  } finally {
    releaseStore?.();
    socket?.close();
    await bridge.close();
  }
});

test("Browser Bridge reset invalidates pairing that is still being persisted", async () => {
  let releaseStore;
  let storeStarted;
  const secrets = new Map();
  const storeStartedPromise = new Promise((resolve) => {
    storeStarted = resolve;
  });
  const storeGate = new Promise((resolve) => {
    releaseStore = resolve;
  });
  const { bridge } = await createStartedBridge({
    secretStore: {
      get: async (key) => secrets.get(key),
      store: async (key, value) => {
        storeStarted();
        await storeGate;
        secrets.set(key, value);
      },
      delete: async (key) => {
        secrets.delete(key);
      },
    },
  });
  let socket;
  try {
    const status = bridge.getStatus();
    const originalPairingToken = status.pairingToken;
    socket = new WebSocket(status.endpoint);
    const received = [];
    socket.addEventListener("message", (event) => {
      received.push(JSON.parse(String(event.data)));
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({
      type: "bridge.pair",
      protocolVersion,
      token: originalPairingToken,
    }));
    await storeStartedPromise;

    const reset = bridge.resetPairing();
    releaseStore();
    await reset;

    const resetStatus = bridge.getStatus();
    assert.equal(resetStatus.connected, false);
    assert.ok(resetStatus.pairingToken);
    assert.notEqual(resetStatus.pairingToken, originalPairingToken);
    assert.equal(secrets.size, 0);
    assert.equal(
      received.some((message) => message.type === "bridge.paired"),
      false,
    );
  } finally {
    releaseStore?.();
    socket?.close();
    await bridge.close();
  }
});

test("WebSocket server ignores data frames after a close frame in the same chunk", async () => {
  const messages = [];
  const server = createTextWebSocketServer({
    host: "127.0.0.1",
    port: 0,
    path: "/test",
    maxMessageBytes: 1024,
    maxConnections: 2,
    allowOrigin: () => true,
    onConnection: () => undefined,
    onMessage: (_socket, text) => messages.push(text),
    onClose: () => undefined,
    onError: () => undefined,
  });
  const port = await server.listen();
  const socket = await openRawWebSocket(port);
  try {
    socket.write(
      Buffer.concat([
        maskedFrame({ opcode: 0x8, fin: true, payload: Buffer.alloc(0) }),
        maskedFrame({ opcode: 0x1, fin: true, payload: "after-close" }),
      ]),
    );
    await new Promise((resolve) => socket.once("close", resolve));
    assert.deepEqual(messages, []);
  } finally {
    socket.destroy();
    await server.close();
  }
});

test("Browser Bridge bounds queued messages before authentication work completes", async () => {
  let releaseStore;
  let storeStarted;
  const storeStartedPromise = new Promise((resolve) => {
    storeStarted = resolve;
  });
  const storeGate = new Promise((resolve) => {
    releaseStore = resolve;
  });
  const { bridge } = await createStartedBridge({
    maxQueuedMessages: 1,
    secretStore: {
      get: async () => undefined,
      store: async () => {
        storeStarted();
        await storeGate;
      },
      delete: async () => undefined,
    },
  });
  let socket;
  try {
    const status = bridge.getStatus();
    socket = new WebSocket(status.endpoint);
    const collector = createCollector(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(JSON.stringify({
      type: "bridge.pair",
      protocolVersion,
      token: status.pairingToken,
    }));
    await storeStartedPromise;
    socket.send(JSON.stringify({
      type: "bridge.ping",
      protocolVersion,
      nonce: "queued",
    }));
    const error = await collector.next((value) => value.type === "bridge.error");
    assert.equal(error.code, "RATE_LIMITED");
  } finally {
    releaseStore?.();
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge status subscriptions are independent and disposable", async () => {
  const { bridge } = await createStartedBridge();
  const first = [];
  const second = [];
  const firstSubscription = bridge.subscribeStatus((status) => first.push(status));
  const secondSubscription = bridge.subscribeStatus((status) => second.push(status));
  try {
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
    firstSubscription.dispose();
    await bridge.resetPairing();
    assert.equal(first.length, 1);
    assert.ok(second.length > 1);
  } finally {
    firstSubscription.dispose();
    secondSubscription.dispose();
    await bridge.close();
  }
});

test("browser bridge enforces one participant owner per remote conversation", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const selected = await publishSession(bridge, socket);
    const binding = bridge.bindSession("room-a:agent", selected.id);

    assert.throws(
      () => bridge.bindConversation("room-b:agent", binding),
      /already bound to another pair participant/,
    );

    bridge.releaseBinding("room-a:agent");
    assert.doesNotThrow(() => bridge.bindConversation("room-b:agent", binding));
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge remaps a persisted conversation binding after document reload", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const original = await publishSession(bridge, socket);
    const binding = bridge.bindSession("room-a:agent", original.id);
    const refreshed = {
      ...original,
      id: "chatgpt:7:document-token-8:chatgpt%3Ahttps%3A%2F%2Fchatgpt.com%2Fc%2Ftest",
      documentId: "document-8",
      documentToken: "document-token-8",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    await publishSession(bridge, socket, refreshed);

    const resolved = bridge.resolveBoundSession(
      "room-a:agent",
      binding,
      original.id,
    );

    assert.equal(resolved.id, refreshed.id);
    assert.equal(resolved.documentToken, refreshed.documentToken);
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge permits different remote conversations to have different owners", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const first = session();
    const second = {
      ...session(),
      id: "chatgpt:8:document-token-8:chatgpt%3Ahttps%3A%2F%2Fchatgpt.com%2Fc%2Fother",
      tabId: 8,
      documentId: "document-8",
      documentToken: "document-token-8",
      conversationUrl: "https://chatgpt.com/c/other",
      conversationIdentity: "chatgpt:https://chatgpt.com/c/other",
      title: "Other chat",
    };
    socket.send(
      JSON.stringify({
        type: "provider.status",
        protocolVersion,
        sessions: [first, second],
        selectedSessionId: first.id,
      }),
    );
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (bridge.getStatus().sessions.length === 2) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.doesNotThrow(() => bridge.bindSession("room-a:agent", first.id));
    assert.doesNotThrow(() => bridge.bindSession("room-b:agent", second.id));
  } finally {
    socket?.close();
    await bridge.close();
  }
});



test("generic browser request adopts a same-origin route transition without changing the document token", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const initialUrl = "https://example.ai/new#draft";
    const initialIdentity = `generic:${initialUrl}`;
    const selected = await publishSession(bridge, socket, {
      ...session(),
      id: `generic:7:generic-document-7:${encodeURIComponent(initialIdentity)}`,
      provider: "generic",
      documentId: undefined,
      documentToken: "generic-document-7",
      conversationUrl: initialUrl,
      conversationIdentity: initialIdentity,
      title: "Generic new chat",
    });
    const eventsPromise = collect(
      bridge.sendConversation(
        "worker",
        "GENERIC TRANSITION",
        selected.id,
        new AbortController().signal,
      ),
    );
    const send = await collector.next(
      (value) => value.type === "conversation.send" && value.text === "GENERIC TRANSITION",
    );
    assert.equal(send.allowInitialConversationTransition, true);

    const finalUrl = "https://example.ai/chat/42#thread";
    const finalIdentity = `generic:${finalUrl}`;
    const finalSessionId = `generic:7:generic-document-7:${encodeURIComponent(finalIdentity)}`;
    socket.send(JSON.stringify({
      type: "provider.status",
      protocolVersion,
      sessions: [{
        ...selected,
        id: finalSessionId,
        conversationUrl: finalUrl,
        conversationIdentity: finalIdentity,
        status: "streaming",
      }],
      selectedSessionId: finalSessionId,
    }));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (bridge.getStatus().sessions.some((candidate) => candidate.id === finalSessionId)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    socket.send(JSON.stringify({
      type: "provider.status",
      protocolVersion,
      sessions: [{
        ...selected,
        id: finalSessionId,
        conversationUrl: finalUrl,
        conversationIdentity: finalIdentity,
        status: "ready",
      }],
      selectedSessionId: finalSessionId,
    }));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (bridge.getStatus().sessions.some((candidate) => candidate.id === finalSessionId && candidate.status === "ready")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await assert.rejects(
      collect(bridge.sendConversation("lead", "SECOND", finalSessionId, new AbortController().signal)),
      /already has an active request/,
    );

    socket.send(JSON.stringify({
      type: "conversation.response",
      protocolVersion,
      requestId: send.requestId,
      agentId: "worker",
      sessionId: selected.id,
      provider: "generic",
      text: "done",
      segments: [{ type: "text", text: "done", start: 0, end: 4 }],
      assets: [],
      captureFormat: "renderedText",
      fidelity: "bestEffort",
      finalConversationUrl: finalUrl,
      finalConversationIdentity: finalIdentity,
      finalSessionId,
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
    }));
    const events = await eventsPromise;
    assert.deepEqual(
      events.filter((event) => event.type === "session"),
      [
        { type: "session", sessionId: selected.id },
        { type: "session", sessionId: finalSessionId },
      ],
    );
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("generic browser request preserves hash-routed conversation identity", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const conversationUrl = "https://example.ai/chat#conversation-42";
    const conversationIdentity = `generic:${conversationUrl}`;
    const selected = await publishSession(bridge, socket, {
      ...session(),
      id: `generic:7:generic-document-7:${encodeURIComponent(conversationIdentity)}`,
      provider: "generic",
      documentId: undefined,
      documentToken: "generic-document-7",
      conversationUrl,
      conversationIdentity,
      title: "Generic hash chat",
    });
    const eventsPromise = collect(
      bridge.sendConversation(
        "worker",
        "HASH ROUTE",
        selected.id,
        new AbortController().signal,
      ),
    );
    const send = await collector.next(
      (value) => value.type === "conversation.send" && value.text === "HASH ROUTE",
    );
    socket.send(JSON.stringify({
      type: "conversation.response",
      protocolVersion,
      requestId: send.requestId,
      agentId: "worker",
      sessionId: selected.id,
      provider: "generic",
      text: "hash-ok",
      segments: [{ type: "text", text: "hash-ok", start: 0, end: 7 }],
      assets: [],
      captureFormat: "renderedText",
      fidelity: "bestEffort",
      finalConversationUrl: conversationUrl,
      finalConversationIdentity: conversationIdentity,
      finalSessionId: selected.id,
      startedAt: "2026-08-01T00:00:00.000Z",
      completedAt: "2026-08-01T00:00:01.000Z",
    }));
    const events = await eventsPromise;
    assert.equal(events.some((event) => event.type === "response" && event.response.text === "hash-ok"), true);
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("generic browser bindings isolate same-URL conversations by tab and never silently remap", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const first = {
      ...session(),
      id: "generic:7:generic-document-7:generic%3Ahttps%3A%2F%2Fexample.ai%2F",
      provider: "generic",
      documentId: "generic-document-7",
      documentToken: "generic-document-7",
      conversationUrl: "https://example.ai/",
      conversationIdentity: "generic:https://example.ai/",
      title: "Generic A",
    };
    const second = {
      ...first,
      id: "generic:8:generic-document-8:generic%3Ahttps%3A%2F%2Fexample.ai%2F",
      tabId: 8,
      documentId: "generic-document-8",
      documentToken: "generic-document-8",
      title: "Generic B",
    };
    socket.send(JSON.stringify({
      type: "provider.status",
      protocolVersion,
      sessions: [first, second],
      selectedSessionId: first.id,
    }));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (bridge.getStatus().sessions.length === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const firstBinding = bridge.bindSession("room-a:agent", first.id);
    assert.doesNotThrow(() => bridge.bindSession("room-b:agent", second.id));

    socket.send(JSON.stringify({
      type: "provider.status",
      protocolVersion,
      sessions: [second],
      selectedSessionId: second.id,
    }));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (!bridge.getStatus().sessions.some((candidate) => candidate.id === first.id)) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(bridge.resolveBoundSession("room-a:agent", firstBinding, first.id), undefined);
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge reveals a provider-only asset", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const reveal = bridge.revealAsset("asset-provider-only");
    const request = await collector.next(
      (value) => value.type === "asset.reveal",
    );
    assert.equal(request.assetId, "asset-provider-only");
    socket.send(
      JSON.stringify({
        type: "asset.reveal.result",
        protocolVersion,
        requestId: request.requestId,
        assetId: request.assetId,
        success: true,
      }),
    );
    await reveal;
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge streams a checksummed provider asset", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const payload = Buffer.from("hello asset", "utf8");
    const controller = new AbortController();
    const eventsPromise = collect(
      bridge.fetchAsset("asset-1", 1024, controller.signal),
    );
    const fetch = await collector.next((value) => value.type === "asset.fetch");
    socket.send(JSON.stringify({
      type: "asset.start",
      protocolVersion,
      transferId: fetch.transferId,
      assetId: fetch.assetId,
      name: "report.txt",
      mimeType: "text/plain",
      size: payload.length,
    }));
    socket.send(JSON.stringify({
      type: "asset.chunk",
      protocolVersion,
      transferId: fetch.transferId,
      assetId: fetch.assetId,
      sequence: 0,
      dataBase64: payload.toString("base64"),
    }));
    socket.send(JSON.stringify({
      type: "asset.complete",
      protocolVersion,
      transferId: fetch.transferId,
      assetId: fetch.assetId,
      size: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    }));
    const events = await eventsPromise;
    assert.deepEqual(events.map((event) => event.type), [
      "start",
      "chunk",
      "complete",
    ]);
    assert.equal(events[0].name, "report.txt");
    assert.equal(events[1].data.toString("utf8"), "hello asset");
    assert.equal(events[2].size, payload.length);
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge rejects an asset checksum mismatch", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const transfer = collect(
      bridge.fetchAsset("asset-2", 1024, new AbortController().signal),
    );
    const fetch = await collector.next((value) => value.type === "asset.fetch");
    socket.send(JSON.stringify({
      type: "asset.start",
      protocolVersion,
      transferId: fetch.transferId,
      assetId: fetch.assetId,
      name: "bad.txt",
      size: 1,
    }));
    socket.send(JSON.stringify({
      type: "asset.chunk",
      protocolVersion,
      transferId: fetch.transferId,
      assetId: fetch.assetId,
      sequence: 0,
      dataBase64: "eA==",
    }));
    socket.send(JSON.stringify({
      type: "asset.complete",
      protocolVersion,
      transferId: fetch.transferId,
      assetId: fetch.assetId,
      size: 1,
      sha256: "0".repeat(64),
    }));
    await assert.rejects(transfer, /checksum does not match/);
  } finally {
    socket?.close();
    await bridge.close();
  }
});


test("browser bridge rejects an oversized declared asset before streaming", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const transfer = collect(
      bridge.fetchAsset("asset-oversized", 4, new AbortController().signal),
    );
    const rejection = assert.rejects(transfer, /transfer start is invalid/);
    const fetch = await collector.next((value) => value.type === "asset.fetch");
    socket.send(JSON.stringify({
      type: "asset.start",
      protocolVersion,
      transferId: fetch.transferId,
      assetId: fetch.assetId,
      name: "large.bin",
      size: 5,
    }));
    await rejection;
  } finally {
    socket?.close();
    await bridge.close();
  }
});

test("browser bridge cancels an asset transfer on abort", async () => {
  const { bridge } = await createStartedBridge();
  let socket;
  try {
    const connected = await connectAndPair(bridge);
    socket = connected.socket;
    const { collector } = connected;
    const controller = new AbortController();
    const transfer = collect(bridge.fetchAsset("asset-3", 1024, controller.signal));
    const rejection = assert.rejects(transfer, /cancelled/);
    const fetch = await collector.next((value) => value.type === "asset.fetch");
    controller.abort();
    const cancel = await collector.next(
      (value) => value.type === "asset.cancel" && value.transferId === fetch.transferId,
    );
    assert.equal(cancel.assetId, "asset-3");
    await rejection;
  } finally {
    socket?.close();
    await bridge.close();
  }
});

// EX-AUD-09. Raw-socket handshake and framing rules.
const rawWebSocketServer = (overrides = {}) => createTextWebSocketServer({
  host: "127.0.0.1",
  port: 0,
  path: "/test",
  maxMessageBytes: 1024,
  maxConnections: 2,
  allowOrigin: () => true,
  onConnection: () => undefined,
  onMessage: () => undefined,
  onClose: () => undefined,
  onError: () => undefined,
  ...overrides,
});

const handshakeRequest = (port, key) => Buffer.from(
  [
    "GET /test HTTP/1.1",
    `Host: 127.0.0.1:${String(port)}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n"),
  "utf8",
);

const firstResponseLine = async (port, payload) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const received = new Promise((resolve) => {
      let buffered = "";
      socket.on("data", (chunk) => {
        buffered += chunk.toString("utf8");
        if (buffered.includes("\r\n")) resolve(buffered.split("\r\n")[0]);
      });
      socket.once("close", () => resolve(buffered.split("\r\n")[0] ?? ""));
    });
    socket.write(payload);
    return await received;
  } finally {
    socket.destroy();
  }
};

test("a Sec-WebSocket-Key that is not 16 canonical base64 bytes is refused", async () => {
  const server = rawWebSocketServer();
  const port = await server.listen();
  try {
    // Accepted: the RFC's own example key.
    assert.match(
      await firstResponseLine(port, handshakeRequest(port, "dGhlIHNhbXBsZSBub25jZQ==")),
      /^HTTP\/1\.1 101 /u,
    );
    for (const key of [
      "",
      "short",
      "dGhlIHNhbXBsZSBub25jZQ",
      "dGhlIHNhbXBsZSBub25jZQ=",
      "AAAAAAAAAAAAAAAAAAAAAAAA",
      "!!!!!!!!!!!!!!!!!!!!!!==",
      Buffer.alloc(15).toString("base64"),
      Buffer.alloc(17).toString("base64"),
    ]) {
      assert.match(
        await firstResponseLine(port, handshakeRequest(port, key)),
        /^HTTP\/1\.1 400 /u,
        `key ${JSON.stringify(key)} completed a handshake`,
      );
    }
  } finally {
    await server.close();
  }
});

test("a non-minimal extended length is refused", async () => {
  for (const [label, frame] of [
    ["16-bit field carrying a 7-bit length", (() => {
      const payload = Buffer.from("hi", "utf8");
      const mask = Buffer.from([1, 2, 3, 4]);
      const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      return Buffer.concat([Buffer.from([0x81, 0xfe, 0x00, 0x02]), mask, masked]);
    })()],
    ["64-bit field carrying a 16-bit length", (() => {
      const payload = Buffer.from("hi", "utf8");
      const mask = Buffer.from([1, 2, 3, 4]);
      const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      const header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0xff;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
      return Buffer.concat([header, mask, masked]);
    })()],
  ]) {
    const errors = [];
    const messages = [];
    const server = rawWebSocketServer({
      onError: (error) => errors.push(error.message),
      onMessage: (_socket, text) => messages.push(text),
    });
    const port = await server.listen();
    const socket = net.createConnection({ host: "127.0.0.1", port });
    try {
      await new Promise((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      socket.write(Buffer.concat([
        handshakeRequest(port, "dGhlIHNhbXBsZSBub25jZQ=="),
        frame,
      ]));
      await new Promise((resolve) => {
        socket.once("close", resolve);
        setTimeout(resolve, 500).unref?.();
      });
      assert.equal(messages.length, 0, `${label} was delivered`);
      assert.ok(
        errors.some((message) => /non-minimal length encoding/u.test(message)),
        `${label} was not reported: ${errors.join(", ") || "no error"}`,
      );
    } finally {
      socket.destroy();
      await server.close();
    }
  }
});

test("server shutdown flushes the close frame before destroying the socket", async () => {
  const server = rawWebSocketServer();
  const port = await server.listen();
  const socket = net.createConnection({ host: "127.0.0.1", port });
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const frames = [];
    let upgraded = false;
    socket.on("data", (chunk) => {
      if (!upgraded) {
        const text = chunk.toString("binary");
        const boundary = text.indexOf("\r\n\r\n");
        if (boundary < 0) return;
        upgraded = true;
        const rest = chunk.subarray(Buffer.byteLength(text.slice(0, boundary + 4), "binary"));
        if (rest.length > 0) frames.push(rest);
        return;
      }
      frames.push(chunk);
    });
    socket.write(handshakeRequest(port, "dGhlIHNhbXBsZSBub25jZQ=="));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const received = Buffer.concat(frames);
    assert.ok(received.length >= 2, "no close frame reached the peer");
    assert.equal(received[0] & 0x0f, 0x8, "the first frame after shutdown was not a close frame");
  } finally {
    socket.destroy();
  }
});

// EX-AUD-09 follow-up. The first flush attempt checked `writableEnded`, which `end()` sets
// synchronously, so every socket reported itself already flushed and was destroyed in the
// same tick — the race was unchanged. These cover the multi-socket and slow-reader cases the
// single-socket test could not distinguish.
const openUpgradedSocket = async (port) => {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const frames = [];
  let upgraded = false;
  socket.on("data", (chunk) => {
    if (!upgraded) {
      const text = chunk.toString("binary");
      const boundary = text.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      upgraded = true;
      const rest = chunk.subarray(Buffer.byteLength(text.slice(0, boundary + 4), "binary"));
      if (rest.length > 0) frames.push(rest);
      return;
    }
    frames.push(chunk);
  });
  socket.write(handshakeRequest(port, "dGhlIHNhbXBsZSBub25jZQ=="));
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { socket, frames };
};

test("every connected peer receives a close frame on shutdown", async () => {
  const server = rawWebSocketServer({ maxConnections: 8 });
  const port = await server.listen();
  const peers = [];
  try {
    for (let index = 0; index < 4; index += 1) {
      peers.push(await openUpgradedSocket(port));
    }
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    peers.forEach((peer, index) => {
      const received = Buffer.concat(peer.frames);
      assert.ok(received.length >= 2, `peer ${String(index)} received no close frame`);
      assert.equal(
        received[0] & 0x0f,
        0x8,
        `peer ${String(index)} did not receive a close frame first`,
      );
    });
  } finally {
    peers.forEach((peer) => peer.socket.destroy());
  }
});

test("a close frame queued behind a large payload is still flushed", async () => {
  // Loopback delivers a two-byte close frame before the destroy either way, so a small
  // message cannot tell `writableEnded` from `writableFinished`. Filling the socket buffer
  // first is what makes the difference observable: with the payload still draining,
  // `writableEnded` is already true while `writableFinished` is not.
  let connected;
  const opened = new Promise((resolve) => { connected = resolve; });
  const server = rawWebSocketServer({
    maxMessageBytes: 8 * 1024 * 1024,
    onConnection: (socket) => connected(socket),
  });
  const port = await server.listen();
  const { socket, frames } = await openUpgradedSocket(port);
  try {
    const serverSocket = await opened;
    socket.pause();
    serverSocket.send("x".repeat(4 * 1024 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closing = server.close();
    socket.resume();
    await closing;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const received = Buffer.concat(frames);
    assert.ok(received.length > 1024, "the queued payload never reached the peer");
    // The close frame is an opcode-8 control frame; find it anywhere after the payload.
    let cursor = 0;
    let sawClose = false;
    while (cursor + 2 <= received.length) {
      const opcode = received[cursor] & 0x0f;
      let length = received[cursor + 1] & 0x7f;
      let offset = 2;
      if (length === 126) { length = received.readUInt16BE(cursor + 2); offset = 4; }
      else if (length === 127) { length = Number(received.readBigUInt64BE(cursor + 2)); offset = 10; }
      if (opcode === 0x8) { sawClose = true; break; }
      cursor += offset + length;
    }
    assert.ok(sawClose, "the close frame was destroyed while the payload was still draining");
  } finally {
    socket.destroy();
  }
});

test("shutdown still completes when a peer stops reading", async () => {
  const server = rawWebSocketServer();
  const port = await server.listen();
  const { socket } = await openUpgradedSocket(port);
  try {
    // Pausing the peer means the close frame may never be drained. Shutdown has to finish on
    // its bounded grace rather than wait on a reader that never returns.
    socket.pause();
    const started = Date.now();
    await server.close();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_000, `shutdown took ${String(elapsed)}ms with a paused peer`);
  } finally {
    socket.destroy();
  }
});
