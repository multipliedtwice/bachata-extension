const assert = require("node:assert/strict");
const test = require("node:test");
const { randomUUID } = require("node:crypto");
const { createServer, request } = require("node:http");
const {
  createBrowserBridgeServer,
} = require("../dist/browser/bridgeServer.js");
const {
  createSharedBridgeRequestHandler,
  createSharedBrowserBridgeClient,
  probeBrowserBridgeEndpoint,
  reserveBrowserBridgeEndpoint,
} = require("../dist/browser/sharedBridgeTransport.js");

const token = "profile-secret-for-shared-window-authentication";
const bodyRequest = (endpoint, body, headers = {}) => new Promise((resolve, reject) => {
  const url = new URL(endpoint);
  url.protocol = "http:";
  url.pathname = "/bachata-browser-bridge-shared-v1";
  const outgoing = request(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
  }, (response) => {
    let text = "";
    response.on("data", (chunk) => { text += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, text }));
  });
  outgoing.once("error", reject);
  outgoing.end(JSON.stringify(body));
});
const session = (id) => ({
  id,
  provider: "chatgpt",
  tabId: Number(id),
  frameId: 0,
  documentToken: id,
  conversationUrl: `https://chatgpt.com/c/${id}`,
  conversationIdentity: `chatgpt:https://chatgpt.com/c/${id}`,
  status: "ready",
  createdAt: "2026-09-13T00:00:00.000Z",
  updatedAt: "2026-09-13T00:00:00.000Z",
});
const fixture = async (options = {}) => {
  const calls = [];
  const bindings = new Map();
  const signals = new Map();
  const pendingStops = new Map();
  const stopped = new Set();
  const opens = [];
  const sessions = [session("1"), session("2")];
  const bridge = {
    getStatus: () => ({ enabled: true, connected: true, sessions }),
    discover: () => calls.push("discover"),
    refreshLocalModelConfig: () => calls.push("refresh"),
    resetPairing: async () => calls.push("resetPairing"),
    releaseBinding: (id) => bindings.delete(id),
    bindConversation: (id, binding) => {
      for (const [owner, value] of bindings) {
        if (owner !== id && value.conversationIdentity === binding.conversationIdentity) throw Error("already bound");
      }
      bindings.set(id, binding);
    },
    resolveBoundSession: (owner, binding, expected) => {
      const found = sessions.find((item) => item.id === expected || (!expected && item.conversationIdentity === binding.conversationIdentity));
      if (found?.conversationIdentity !== binding.conversationIdentity) throw Error("binding mismatch");
      assert.ok(bindings.has(owner));
      return found;
    },
    openConversation: async (provider, signal) => {
      opens.push(signal);
      if (options.freshSession) {
        const opened = session("3");
        sessions.push(opened);
        return opened;
      }
      if (options.waitForOpen) {
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(Error("opening interrupted"));
          else signal.addEventListener("abort", () => reject(Error("opening interrupted")), { once: true });
        });
      }
      return sessions.find((item) => item.provider === provider);
    },
    sendConversation: async function* (agentId, text, id, signal, _attachments, _deadline, context) {
      calls.push({ owner: context.ownerId, agentId, text, id });
      signals.set(id, signal);
      let stop;
      const stoppedPromise = new Promise((resolve) => { stop = resolve; });
      pendingStops.set(context.requestId, () => { stopped.add(id); stop(); });
      signal.addEventListener("abort", stop, { once: true });
      try {
        yield { type: "session", sessionId: id };
        if (signal.aborted) stop();
        await stoppedPromise;
        yield { type: "interrupted" };
      } finally {
        signal.removeEventListener("abort", stop);
        pendingStops.delete(context.requestId);
      }
    },
    fetchAsset: async function* () {
      yield { type: "start", assetId: "asset", name: "report.txt", size: 3 };
      yield { type: "chunk", assetId: "asset", sequence: 0, data: Buffer.from("abc") };
      yield { type: "complete", assetId: "asset", size: 3, sha256: "digest" };
    },
    revealAsset: async (id) => calls.push({ reveal: id }),
    interrupt: async (requestId) => {
      if (requestId) pendingStops.get(requestId)?.();
      else calls.push("global-interrupt");
    },
    close: async () => calls.push("owner-close"),
  };
  const handler = createSharedBridgeRequestHandler({ getToken: () => token, getBridge: () => bridge });
  const server = createServer(handler.handle);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `ws://127.0.0.1:${server.address().port}`;
  return {
    endpoint, calls, bindings, signals, stopped, opens,
    client: () => createSharedBrowserBridgeClient({ endpoint, token }),
    close: async () => { handler.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
};

test("reservation binds exclusively before reading credentials or enabling either protocol", { timeout: 5000 }, async () => {
  const secrets = new Map([
    ["bachata.browserBridge.connectionToken.v8", "paired-token"],
    ["bachata.browserBridge.extensionOrigin.v8", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ]);
  const before = [...secrets];
  const reads = [];
  const owner = createBrowserBridgeServer({
    enabled: true, port: 0, sharedToken: () => token,
    secretStore: { get: async (key) => { reads.push(key); return secrets.get(key); }, store: async (key, value) => secrets.set(key, value), delete: async (key) => secrets.delete(key) },
    onStatusChange: () => undefined, log: () => undefined,
  });
  try {
    const reservation = await owner.reserve();
    assert.equal(reservation.isHeld(), true);
    assert.equal(reads.length, 0);
    assert.equal(owner.getStatus().endpoint, undefined);
    assert.equal(owner.getStatus().pairingToken, undefined);
    assert.equal((await bodyRequest(reservation.endpoint, { method: "probe" })).status, 503);
    await assert.rejects(reserveBrowserBridgeEndpoint(reservation.endpoint), /EADDRINUSE/u);
    await owner.start();
    assert.equal(reservation.isHeld(), true);
    assert.equal(owner.getStatus().endpoint, reservation.endpoint);
    assert.deepEqual([...secrets], before);
    assert.ok((await probeBrowserBridgeEndpoint(reservation.endpoint, token)).status);
    await reservation.release();
    assert.equal(reservation.isHeld(), false);
  } finally { await owner.close(); }
});

test("startup credential failure rejects, releases the reservation and can retry without rotating pairing credentials", { timeout: 5000 }, async () => {
  let fail = true;
  const owner = createBrowserBridgeServer({
    enabled: true, port: 0,
    secretStore: { get: async () => { if (fail) throw Error("secret store unavailable"); }, store: async () => undefined, delete: async () => undefined },
    onStatusChange: () => undefined, log: () => undefined,
  });
  try {
    const reservation = await owner.reserve();
    await assert.rejects(owner.start(), /secret store unavailable/u);
    assert.equal(reservation.isHeld(), false);
    assert.equal(owner.getStatus().pairingToken, undefined);
    fail = false;
    await owner.start();
    assert.ok(owner.getStatus().endpoint);
  } finally { await owner.close(); }
});

test("unknown reachable servers are preserved and an exclusive prior endpoint guard is releasable", { timeout: 5000 }, async () => {
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `ws://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await probeBrowserBridgeEndpoint(endpoint, token), { reachable: true });
  await assert.rejects(reserveBrowserBridgeEndpoint(endpoint), /EADDRINUSE/u);
  await new Promise((resolve) => server.close(resolve));
  assert.deepEqual(await probeBrowserBridgeEndpoint(endpoint), { reachable: false });
  const reservation = await reserveBrowserBridgeEndpoint(endpoint);
  try { assert.equal(reservation.isHeld(), true); } finally { await reservation.release(); }
  assert.equal(reservation.isHeld(), false);
});

test("shared transport rejects browser origins, wrong credentials, foreign hosts and unknown methods", { timeout: 5000 }, async () => {
  const setup = await fixture();
  try {
    const body = { clientId: randomUUID(), method: "status" };
    assert.equal((await bodyRequest(setup.endpoint, body, { origin: "https://chatgpt.com" })).status, 403);
    assert.equal((await bodyRequest(setup.endpoint, body, { authorization: "Bearer wrong" })).status, 403);
    assert.equal((await bodyRequest(setup.endpoint, body, { host: "example.com" })).status, 403);
    const unknown = await bodyRequest(setup.endpoint, { ...body, method: "clearQuarantine" });
    assert.equal(unknown.status, 409);
    assert.equal(unknown.text.includes("Quarantine"), false);
    assert.equal(setup.calls.length, 0);
    for (let i = 0; i < 70; i += 1) assert.ok((await probeBrowserBridgeEndpoint(setup.endpoint, token)).status);
    assert.equal((await bodyRequest(setup.endpoint, body)).status, 200);
  } finally { await setup.close(); }
});

test("other windows use the owner for discovery, pairing and streamed assets without closing its server", { timeout: 5000 }, async () => {
  const setup = await fixture();
  const client = setup.client();
  try {
    await client.start();
    assert.equal(client.getStatus().connected, true);
    client.discover();
    await client.resetPairing();
    assert.deepEqual(setup.calls, ["discover", "resetPairing"]);
    const events = [];
    for await (const event of client.fetchAsset("asset", 1024, new AbortController().signal)) events.push(event);
    assert.equal(events[1].data.toString(), "abc");
    await client.close();
    assert.equal(setup.calls.includes("owner-close"), false);
    assert.equal((await probeBrowserBridgeEndpoint(setup.endpoint, token)).reachable, true);
  } finally { await client.close(); await setup.close(); }
});

test("shared bindings and interruption are isolated between windows with identical participant names", { timeout: 5000 }, async () => {
  const setup = await fixture();
  const left = setup.client();
  const right = setup.client();
  const signal = new AbortController().signal;
  try {
    await Promise.all([left.start(), right.start()]);
    left.bindSession("reviewer", "1");
    right.bindSession("reviewer", "2");
    const first = left.sendConversation("reviewer", "left", "1", signal)[Symbol.asyncIterator]();
    const second = right.sendConversation("reviewer", "right", "2", signal)[Symbol.asyncIterator]();
    await Promise.all([first.next(), second.next()]);
    assert.equal(setup.bindings.size, 2);
    await left.interrupt();
    assert.equal((await first.next()).value.type, "interrupted");
    assert.equal(setup.stopped.has("1"), true);
    assert.equal(setup.stopped.has("2"), false);
    assert.equal(setup.calls.includes("global-interrupt"), false);
    await left.close();
    assert.equal(setup.bindings.size, 1);
    await right.interrupt();
    assert.equal((await second.next()).value.type, "interrupted");
    await first.return();
    await second.return();
  } finally { await left.close(); await right.close(); await setup.close(); }
});

test("binding refusal reaches the next asynchronous operation and cannot send into another window", { timeout: 5000 }, async () => {
  const setup = await fixture();
  const left = setup.client();
  const right = setup.client();
  try {
    await Promise.all([left.start(), right.start()]);
    left.bindSession("same", "1");
    await left.openConversation("chatgpt");
    right.bindSession("same", "1");
    await assert.rejects(right.openConversation("chatgpt"), /Browser unavailable/u);
    await assert.rejects(async () => {
      for await (const _event of right.sendConversation("same", "wrong", "1", new AbortController().signal)) {}
    }, /Browser unavailable/u);
    assert.equal(setup.calls.filter((value) => typeof value === "object" && value.text).length, 0);
    left.bindSession("same", "1");
    await assert.rejects(async () => {
      for await (const _event of left.sendConversation("same", "wrong", "2", new AbortController().signal)) {}
    }, /Browser unavailable/u);
  } finally { await left.close(); await right.close(); await setup.close(); }
});


test("interrupt and close cancel only this window's pending browser openings", { timeout: 5000 }, async () => {
  const setup = await fixture({ waitForOpen: true });
  const left = setup.client();
  const right = setup.client();
  try {
    await Promise.all([left.start(), right.start()]);
    const first = left.openConversation("chatgpt");
    const firstRejected = assert.rejects(first, /aborted|Browser unavailable/u);
    while (setup.opens.length < 1) await new Promise((resolve) => setImmediate(resolve));
    const second = right.openConversation("chatgpt");
    const secondRejected = assert.rejects(second, /aborted|Browser unavailable/u);
    while (setup.opens.length < 2) await new Promise((resolve) => setImmediate(resolve));
    await left.interrupt();
    await firstRejected;
    while (!setup.opens[0].aborted) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(setup.opens[1].aborted, false);
    await right.close();
    await secondRejected;
    while (!setup.opens[1].aborted) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(setup.calls.includes("owner-close"), false);
  } finally { await left.close(); await right.close(); await setup.close(); }
});


test("a failed shared-window attachment rejects and reports a compact retry state", { timeout: 5000 }, async () => {
  const setup = await fixture();
  const client = createSharedBrowserBridgeClient({ endpoint: setup.endpoint, token: "wrong-token" });
  try {
    await assert.rejects(client.start(), /Browser unavailable/u);
    assert.equal(client.getStatus().connectionState, "retrying");
    assert.equal(client.getStatus().connected, false);
    assert.equal(setup.calls.includes("owner-close"), false);
  } finally { await client.close(); await setup.close(); }
});

test("a newly opened shared conversation can bind immediately before the next status poll", { timeout: 5000 }, async () => {
  const setup = await fixture({ freshSession: true });
  const client = setup.client();
  try {
    await client.start();
    assert.equal(client.getStatus().sessions.some((value) => value.id === "3"), false);
    const opened = await client.openConversation("chatgpt", undefined, undefined, true);
    const bound = client.bindSession("reviewer", opened.id);
    await client.revealAsset("asset");
    assert.equal(bound.conversationIdentity, session("3").conversationIdentity);
    assert.equal(setup.bindings.size, 1);
  } finally { await client.close(); await setup.close(); }
});

test("closing a shared client cancels a stalled queued discovery without waiting for its timeout", { timeout: 5000 }, async () => {
  let discovered;
  const discovery = new Promise((resolve) => { discovered = resolve; });
  const server = createServer(async (incoming, response) => {
    let data = "";
    for await (const chunk of incoming) data += chunk;
    const body = JSON.parse(data);
    if (body.method === "discover") { discovered(); return; }
    response.writeHead(200, { "Content-Type": "application/json", "Connection": "close" });
    response.end(JSON.stringify({ value: body.method === "status" ? { enabled: true, connected: true, sessions: [] } : null }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createSharedBrowserBridgeClient({ endpoint: `ws://127.0.0.1:${server.address().port}`, token });
  try {
    await client.start();
    client.discover();
    await discovery;
    await Promise.race([
      client.close(),
      new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(Error("shared close stalled")), 1000); timer.unref(); }),
    ]);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("endpoint reservations respect cancellation before and after acquisition", { timeout: 5000 }, async () => {
  const setup = await fixture();
  const endpoint = setup.endpoint;
  await setup.close();
  await assert.rejects(reserveBrowserBridgeEndpoint(endpoint, AbortSignal.abort()), /Browser unavailable/u);
  const controller = new AbortController();
  const reservation = await reserveBrowserBridgeEndpoint(endpoint, controller.signal);
  assert.equal(reservation.isHeld(), true);
  controller.abort();
  while (reservation.isHeld()) await new Promise((resolve) => setImmediate(resolve));
  const next = await reserveBrowserBridgeEndpoint(endpoint);
  await next.release();
});

test("cancelling a probe closes a reachable server's stalled authentication request", { timeout: 5000 }, async () => {
  let requested;
  const started = new Promise((resolve) => { requested = resolve; });
  const server = createServer(() => requested());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const probe = probeBrowserBridgeEndpoint(`ws://127.0.0.1:${server.address().port}`, token, 30_000, controller.signal);
  const rejected = assert.rejects(probe, /Browser unavailable/u);
  try {
    await started;
    controller.abort();
    await rejected;
  } finally {
    controller.abort();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("closing during a delayed credential read waits for startup and never migrates credentials afterwards", { timeout: 5000 }, async () => {
  let returnCredential;
  let reading;
  const started = new Promise((resolve) => { reading = resolve; });
  const writes = [];
  const owner = createBrowserBridgeServer({
    enabled: true, port: 0,
    secretStore: {
      get: () => { reading(); return new Promise((resolve) => { returnCredential = resolve; }); },
      store: async (...args) => writes.push(args),
      delete: async (...args) => writes.push(args),
    },
    onStatusChange: () => undefined, log: () => undefined,
  });
  const starting = owner.start();
  const rejected = assert.rejects(starting, /Browser Bridge is unavailable/u);
  try {
    await started;
    let closed = false;
    const closing = owner.close().then(() => { closed = true; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(closed, false);
    returnCredential(undefined);
    await Promise.all([rejected, closing]);
    assert.deepEqual(writes, []);
    assert.equal(owner.getStatus().endpoint, undefined);
    await assert.rejects(owner.start(), /Browser Bridge is unavailable/u);
  } finally {
    returnCredential?.(undefined);
    await owner.close();
  }
});
