const assert = require("node:assert/strict");
const test = require("node:test");
const { loadRuntimeHarness } = require("./support/runtimeHarness.cjs");
const request = { type: "message.send", recipients: ["codex"], prompt: "Inspect the output redaction boundary", mode: "review", attachmentIds: [] };

test("host state and every outgoing message redact streamed, replaced and final credentials", async () => {
  const secret = "SPLIT_SECRET_1234567890";
  const answer = `Authorization: Bearer ${secret}\nInspection complete.\n`;
  const posted = [];
  const harness = loadRuntimeHarness({ onAdapterSend: async () => ({
    events: [
      { type: "delta", text: "Authorization: Bea" },
      { type: "delta", text: `rer ${secret.slice(0, 10)}` },
      { type: "status", value: "running" },
      { type: "delta", text: `${secret.slice(10)}\n` },
      { type: "replace", text: answer },
    ], answer,
  }) });
  const subscription = harness.runtime.attachWebview({ postMessage: async (message) => { posted.push(structuredClone(message)); return true; } });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(request);
    const control = harness.adapterControls.get("codex");
    await control.started.promise;
    control.release.resolve();
    await send;
    assert.ok(posted.some((message) => message.type === "agent.replace"));
    for (const message of posted) {
      assert.equal(JSON.stringify(message).includes(secret), false, message.type);
      assert.equal(JSON.stringify(message).includes("SPLIT_SECR"), false, message.type);
    }
    const output = harness.runtime.getState().agents.codex.output;
    assert.equal(output, "Authorization: [REDACTED]\nInspection complete.\n");
  } finally {
    subscription.dispose();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("runtime user stop does not publish an agent failure for a late abort exception", async () => {
  const harness = loadRuntimeHarness({ onAdapterSend: async ({ signal }) => {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    throw new Error("Provider stream aborted after Stop");
  } });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(request);
    await harness.adapterControls.get("codex").started.promise;
    await harness.runtime.handleMessage({ type: "run.interrupt", agentId: "codex" });
    await send;
    const state = harness.runtime.getState();
    assert.equal(state.agents.codex.status, "interrupted");
    assert.equal(state.agents.codex.error, undefined);
    assert.equal(state.transcript.some((entry) => entry.kind === "error"), false);
    assert.ok(state.transcript.some((entry) => entry.text === "Stopped by you"));
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("provider API assignments cannot escape through transcript messages or restored output", async () => {
  const secret = "PROVIDER_SECRET_0123456789";
  const answer = `API_KEY="${secret}"\nInspection complete.\n`;
  const posted = [];
  const harness = loadRuntimeHarness({ onAdapterSend: async () => ({ answer, events: [{ type: "delta", text: answer }] }) });
  const subscription = harness.runtime.attachWebview({ postMessage: async (message) => { posted.push(structuredClone(message)); return true; } });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(request);
    const control = harness.adapterControls.get("codex");
    await control.started.promise;
    control.release.resolve();
    await send;
    for (const message of posted) assert.equal(JSON.stringify(message).includes(secret), false, message.type);
    assert.equal(JSON.stringify(harness.transcript).includes(secret), false);
  } finally {
    subscription.dispose();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("bridge discovery preserves the local endpoint and forwards every refresh request", async () => {
  let starts = 0;
  let discoveries = 0;
  const harness = loadRuntimeHarness({
    bridgeStart: async () => { starts += 1; },
    bridgeDiscover: () => { discoveries += 1; },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await Promise.all([
      harness.runtime.handleMessage({ type: "bridge.discover" }),
      harness.runtime.handleMessage({ type: "bridge.discover" }),
    ]);
    assert.equal(starts, 1);
    assert.equal(discoveries, 2);
  } finally { await harness.runtime.dispose(); harness.cleanup(); }
});
