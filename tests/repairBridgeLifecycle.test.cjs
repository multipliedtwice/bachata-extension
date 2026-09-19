const assert = require("node:assert/strict");
const test = require("node:test");
const { createBrowserProviderAdapter } = require("../dist/adapters/browserProvider.js");
const { createSharedBrowserBridgeClient } = require("../dist/browser/sharedBridgeTransport.js");
const { withBridge, browserSession, browserBindingForSession, waitFor, observe, requestFor, expectSuccess, token } = require("./support/repairedBridge.cjs");

for (const shared of [false, true]) {
  test(`F3 ${shared ? "shared" : "direct"} adapter sends with scoped ownership and participant attribution`, { timeout: 5000 }, async () => {
    await withBridge(async ({ bridge, collector, publish, terminal }) => {
      const selected = browserSession(10, "/c/worker");
      await publish([selected]);
      const transport = shared ? createSharedBrowserBridgeClient({ endpoint: bridge.getStatus().endpoint, token }) : bridge;
      if (shared) await transport.start();
      const ownerId = "conversation-1:worker";
      transport.bindSession(ownerId, selected.id);
      const adapter = createBrowserProviderAdapter({ id: "worker", ownerId, provider: "chatgpt", bridge: transport, turnTimeoutMs: 2000 });
      try {
        const outcome = observe(adapter.send(requestFor(selected), new AbortController().signal));
        const request = await collector.next((frame) => frame.type === "conversation.send");
        assert.equal(request.agentId, "worker");
        terminal(request, selected);
        const events = expectSuccess(await outcome);
        assert.equal(events.find((event) => event.type === "captured").response.agentId, "worker");
        assert.equal(events.at(-1).status, "completed");
      } finally { await adapter.dispose(); if (shared) await transport.close(); }
    });
  });
}

for (const shared of [false, true]) {
  test(`F4 ${shared ? "shared" : "direct"} failed Stop can be retried without resending the prompt`, { timeout: 5000 }, async () => {
    await withBridge(async ({ bridge, collector, publish, send, terminal, interruptFrames }) => {
      const selected = browserSession(10, "/c/stop");
      await publish([selected]);
      const transport = shared ? createSharedBrowserBridgeClient({ endpoint: bridge.getStatus().endpoint, token }) : bridge;
      if (shared) await transport.start();
      transport.bindSession("run:worker", selected.id);
      const adapter = createBrowserProviderAdapter({ id: "worker", ownerId: "run:worker", provider: "chatgpt", bridge: transport, turnTimeoutMs: 2000 });
      try {
        const events = [];
        const outcome = observe((async function* () { for await (const event of adapter.send(requestFor(selected), new AbortController().signal)) { events.push(event); yield event; } })());
        const request = await collector.next((frame) => frame.type === "conversation.send");
        await adapter.interrupt();
        await waitFor(() => interruptFrames(request.requestId).length === 1, "first Stop");
        send({ type: "conversation.interruptFailed", requestId: request.requestId, agentId: "worker", sessionId: selected.id, message: "Stop refused" });
        await waitFor(() => events.some((event) => event.type === "notice"), "failed Stop notice");
        await adapter.interrupt();
        await waitFor(() => interruptFrames(request.requestId).length === 2, "second Stop");
        terminal(request, selected, "interrupted");
        assert.equal(expectSuccess(await outcome).at(-1).status, "interrupted");
        assert.equal(collector.seen().filter((frame) => frame.type === "conversation.send").length, 1);
      } finally { await adapter.dispose(); if (shared) await transport.close(); }
    });
  });
}

test("F4 timeout settles locally and retains ownership until a later confirmed Stop", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, collector, publish, send, terminal, interruptFrames }) => {
    const selected = browserSession(10, "/c/deadline");
    await publish([selected]);
    bridge.bindSession("run:worker", selected.id);
    const adapter = createBrowserProviderAdapter({ id: "worker", ownerId: "run:worker", provider: "chatgpt", bridge, turnTimeoutMs: 250 });
    try {
      const outcome = observe(adapter.send(requestFor(selected), new AbortController().signal));
      const request = await collector.next((frame) => frame.type === "conversation.send");
      await adapter.interrupt();
      await waitFor(() => interruptFrames(request.requestId).length === 1, "first Stop");
      send({ type: "conversation.interruptFailed", requestId: request.requestId, agentId: "worker", sessionId: selected.id, message: "Stop refused" });
      const result = await outcome;
      assert.match(result.error.message, /timed out|deadline/i);
      bridge.releaseBinding("run:worker");
      assert.throws(() => bridge.bindSession("intruder", selected.id), /already bound/);
      const another = await observe(adapter.send(requestFor(selected, "Must not submit"), new AbortController().signal));
      assert.match(another.error.message, /already running|active|unconfirmed/i);
      await new Promise((resolve) => setTimeout(resolve, 15));
      const refused = await observe(adapter.send(requestFor(selected, "Still must not submit"), new AbortController().signal));
      assert.match(refused.error.message, /active|unconfirmed/i);
      await new Promise((resolve) => setTimeout(resolve, 15));
      send({ type: "conversation.interruptFailed", requestId: request.requestId, agentId: "worker", sessionId: selected.id, message: "Retry Stop" });
      await new Promise((resolve) => setTimeout(resolve, 15));
      const previousStops = interruptFrames(request.requestId).length;
      await adapter.interrupt();
      await waitFor(() => interruptFrames(request.requestId).length > previousStops, "Stop after refused send");
      await bridge.interrupt(request.requestId);
      bridge.releaseBinding("run:worker");
      terminal(request, selected, "interrupted");
      await waitFor(() => {
        try { bridge.bindSession("intruder", selected.id); return true; } catch { return false; }
      }, "release after confirmed Stop");
      assert.equal(collector.seen().filter((frame) => frame.type === "conversation.send").length, 1);
      bridge.releaseBinding("intruder");
    } finally { await adapter.dispose(); }
  });
});

test("F4 disconnection does not release an unconfirmed request claim", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, socket, collector, publish }) => {
    const selected = browserSession(10, "/c/disconnect");
    await publish([selected]);
    const binding = bridge.bindSession("run:worker", selected.id);
    const outcome = observe(bridge.sendConversation("worker", "Review", selected.id, new AbortController().signal, [], Date.now() + 1000, { ownerId: "run:worker" }));
    await collector.next((frame) => frame.type === "conversation.send");
    socket.close();
    assert.match((await outcome).error.message, /termination is unconfirmed/);
    bridge.releaseBinding("run:worker");
    assert.throws(() => bridge.bindConversation("intruder", binding), /already bound/);
    await assert.rejects(bridge.beginBindingChange("run:worker", undefined), /not confirmed termination/);
  });
});

test("F4 mismatched terminal evidence keeps the conversation quarantined", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, collector, publish, send, terminal }) => {
    const selected = browserSession(10, "/c/mismatch");
    await publish([selected]);
    bridge.bindSession("run:worker", selected.id);
    const outcome = observe(bridge.sendConversation("worker", "Review", selected.id,
      new AbortController().signal, [], Date.now() + 2000, { ownerId: "run:worker" }));
    const request = await collector.next((frame) => frame.type === "conversation.send");
    send({ type: "conversation.stream", requestId: request.requestId, agentId: "lead",
      sessionId: selected.id, mode: "replace", text: "wrong participant" });
    assert.match((await outcome).error.message, /termination is unconfirmed/);
    bridge.releaseBinding("run:worker");
    assert.throws(() => bridge.bindSession("intruder", selected.id), /already bound/);
    terminal(request, selected, "interrupted");
    await waitFor(() => {
      try { bridge.bindSession("intruder", selected.id); return true; } catch { return false; }
    }, "release after valid terminal evidence");
    bridge.releaseBinding("intruder");
  });
});

test("F6 initial tabs have separate claims and no missing-tab or document fallback", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, publish }) => {
    const first = browserSession(10);
    const second = browserSession(11);
    await publish([first, second]);
    const binding = bridge.bindSession("worker", first.id);
    bridge.bindSession("lead", second.id);
    await publish([second]);
    assert.equal(bridge.resolveBoundSession("worker", binding, first.id), undefined);
    const reloaded = browserSession(10, "/", "replacement-document");
    await publish([reloaded, second]);
    assert.equal(bridge.resolveBoundSession("worker", binding, first.id), undefined);
    assert.throws(() => bridge.resolveBoundSession("worker", binding, reloaded.id), /does not match/);
  });
});

test("F6 duplicate tabs of an established conversation still conflict", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, publish }) => {
    const first = browserSession(10, "/c/shared");
    const second = browserSession(11, "/c/shared");
    await publish([first, second]);
    bridge.bindSession("worker", first.id);
    assert.throws(() => bridge.bindSession("lead", second.id), /already bound/);
  });
});

for (const outcome of ["response", "interrupted"]) {
  test(`F6 provisional ownership promotes atomically on ${outcome}`, { timeout: 5000 }, async () => {
    await withBridge(async ({ bridge, collector, publish, terminal }) => {
      const initial = browserSession(10);
      const final = browserSession(10, "/c/promoted");
      await publish([initial]);
      const binding = bridge.bindSession("run:worker", initial.id);
      const result = observe(bridge.sendConversation("worker", "Review", initial.id, new AbortController().signal, [], Date.now() + 2000, { ownerId: "run:worker" }));
      const request = await collector.next((frame) => frame.type === "conversation.send");
      await publish([final]);
      assert.throws(() => bridge.bindSession("lead", final.id), /already bound/);
      terminal(request, initial, outcome, final);
      expectSuccess(await result);
      assert.equal(bridge.resolveBoundSession("run:worker", binding, initial.id).id, final.id);
      assert.throws(() => bridge.bindSession("lead", final.id), /already bound/);
      bridge.releaseBinding("run:worker");
      bridge.bindSession("lead", final.id);
    });
  });
}
