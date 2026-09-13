const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadRuntimeHarness } = require("./support/runtimeHarness.cjs");
const { scratchRootSync, removeScratchSync } = require("./support/scratch.cjs");

const waitFor = async (condition) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The runtime did not publish its saved decision");
};

const withReview = async (check) => {
  const extensionRoot = scratchRootSync("bachata-deferred-decision-");
  fs.mkdirSync(path.join(extensionRoot, "presets"));
  const definition = {
    version: 1,
    id: "deferred-review",
    name: "Deferred review",
    agents: [
      { id: "chatgpt", name: "Browser reviewer", adapter: "chatgpt-browser" },
      { id: "codex", name: "Local reviewer", adapter: "codex-app-server", permissionMode: "readOnly" },
    ],
    steps: [{
      id: "review", name: "Review", enabled: true, type: "agent", participants: ["chatgpt", "codex"],
      promptTemplate: "{{userPrompt}}", parallel: true, consensus: true,
      consensusConfig: { mode: "unanimous", maxRounds: 1, resultFormat: "json", resultField: "consensus", acceptedValue: true },
      humanGate: "none",
    }],
  };
  fs.writeFileSync(path.join(extensionRoot, "presets", "review.pipeline.json"), JSON.stringify(definition));
  const now = new Date().toISOString();
  const sessions = [{
    id: "ready", provider: "chatgpt", tabId: 1, frameId: 0, documentToken: "ready",
    conversationUrl: "https://chatgpt.com/c/ready", conversationIdentity: "ready", title: "Ready", status: "ready",
    createdAt: now, updatedAt: now,
    capabilities: { submission: "verifiedSend", completion: "verifiedLifecycle", interruption: "confirmed", conversationState: "confirmed" },
  }];
  let attachmentReads = 0;
  const harness = loadRuntimeHarness({
    extensionRoot,
    purgeCompiledModules: true,
    bridgeSessions: sessions,
    onAdapterSend: async ({ agentId }) => ({ answer: JSON.stringify({ consensus: false, answer: `${agentId} recorded conclusion` }) }),
    resolvePaths: async () => {
      attachmentReads += 1;
      return { paths: [], dispose: async () => undefined };
    },
  });
  const messages = [];
  const subscription = harness.runtime.attachWebview({ postMessage: async (message) => { messages.push(message); return true; } });
  const sent = () => harness.adapterControlHistory.reduce((sum, control) => sum + control.sendCount, 0);
  const finalAvailability = () => messages.filter((message) => message.type === "run.patch").at(-1)?.operationActive;
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    const run = harness.runtime.handleMessage({ type: "pipeline.run", prompt: "Review", attachmentIds: [] });
    await waitFor(() => harness.runtime.getState().pendingGate !== undefined);
    assert.equal(harness.runtime.getState().operationActive, true);
    await harness.runtime.handleMessage({ type: "run.gate", action: "cancel" });
    await run;
    assert.equal(harness.runtime.getState().workflowStatus, "interrupted");
    assert.equal(harness.runtime.getState().operationActive, false);
    assert.equal(finalAvailability(), false);
    assert.equal(sent(), 2);
    const disconnect = () => {
      sessions.length = 0;
      harness.bridgeOptions.onStatusChange({ enabled: true, connected: false, sessions: [] });
    };
    await check({ harness, disconnect, sent, finalAvailability, attachmentReads: () => attachmentReads, messages });
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    subscription.dispose();
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
};

test("a deferred decision opens and finishes after its browser participant disconnects", async () => withReview(async ({ harness, disconnect, sent, finalAvailability, attachmentReads }) => {
  disconnect();
  const reads = attachmentReads();
  const resumed = harness.runtime.resumePipeline();
  await waitFor(() => harness.runtime.getState().pendingGate !== undefined);
  const gate = harness.runtime.getState().pendingGate;
  assert.equal(gate.reason, "maxConsensusRounds");
  assert.equal(gate.decisionRound, 1);
  assert.equal(attachmentReads(), reads);
  await harness.runtime.handleMessage({ type: "run.gate", action: "acceptParticipant", selectedParticipant: "codex", rationale: "Keep the recorded conclusion" });
  const result = await resumed;
  assert.equal(result.completionReason, "humanDecision");
  assert.equal(result.decisions.review.at(-1).candidate, "codex recorded conclusion");
  assert.equal(sent(), 2);
  assert.equal(attachmentReads(), reads);
  assert.equal(finalAvailability(), false);
}));

test("an unavailable retry preserves the same decision and invokes no providers", async () => withReview(async ({ harness, disconnect, sent, finalAvailability }) => {
  disconnect();
  const resumed = harness.runtime.resumePipeline();
  const refused = assert.rejects(resumed, /Connect the Browser Bridge/u);
  await waitFor(() => harness.runtime.getState().pendingGate !== undefined);
  const originalGate = structuredClone(harness.runtime.getState().pendingGate);
  await harness.runtime.handleMessage({ type: "run.gate", action: "retry", reviewInstructions: "Reconsider keyboard access" });
  await refused;
  assert.equal(sent(), 2);
  assert.equal(finalAvailability(), false);
  const reopened = harness.runtime.resumePipeline();
  await waitFor(() => harness.runtime.getState().pendingGate !== undefined);
  assert.deepEqual(harness.runtime.getState().pendingGate, originalGate);
  await harness.runtime.handleMessage({ type: "run.gate", action: "acceptUnresolved", rationale: "Preserve both conclusions" });
  assert.equal((await reopened).completionReason, "humanDecision");
  assert.equal(sent(), 2);
  assert.equal(finalAvailability(), false);
}));

test("direct participant completion republishes available controls", async () => {
  const harness = loadRuntimeHarness({ purgeCompiledModules: true });
  const messages = [];
  const subscription = harness.runtime.attachWebview({ postMessage: async (message) => { messages.push(message); return true; } });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const agentId = Object.keys(harness.runtime.getState().agents)[0];
    const direct = harness.runtime.handleMessage({ type: "message.send", recipients: [agentId], prompt: "Review this", mode: "review", attachmentIds: [], delivery: "immediate" });
    await waitFor(() => harness.adapterControls.get(agentId).sendCount > 0);
    assert.equal(harness.runtime.getState().operationActive, true);
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await direct;
    assert.equal(harness.runtime.getState().operationActive, false);
    assert.equal(messages.filter((message) => message.type === "run.patch").at(-1)?.operationActive, false);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    subscription.dispose();
    await harness.runtime.dispose();
    harness.cleanup();
  }
});
