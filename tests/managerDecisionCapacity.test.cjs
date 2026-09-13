const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { deferred, loadManagerHarness } = require("./support/runtimeHarness.cjs");
const { scratchRootSync, removeScratchSync } = require("./support/scratch.cjs");

const waitFor = async (condition) => {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("The manager did not reach the expected decision state");
};

const withSavedDecision = async (check, scenario = {}) => {
  const extensionRoot = scratchRootSync("bachata-manager-decision-capacity-");
  fs.mkdirSync(path.join(extensionRoot, "presets"));
  const definition = {
    version: 1, id: "review", name: "Review", longitudinalIntent: "runLocal",
    agents: [
      { id: "a", name: "First reviewer", adapter: "codex-app-server", permissionMode: "readOnly" },
      { id: "b", name: "Second reviewer", adapter: "claude-code", permissionMode: "readOnly" },
    ],
    steps: [{
      id: "review", name: "Reconcile", enabled: true, type: "agent", participants: ["a", "b"],
      promptTemplate: "{{userPrompt}}", parallel: true, consensus: true, humanGate: "none",
      consensusConfig: { mode: "unanimous", maxRounds: 1, resultFormat: "json", resultField: "consensus", acceptedValue: true },
    }],
  };
  fs.writeFileSync(path.join(extensionRoot, "presets", "review.pipeline.json"), JSON.stringify(definition));
  const active = new Set();
  const acquisitions = [];
  let capacityWait;
  const broker = {
    acquire: async (request) => {
      acquisitions.push(request);
      if (request.resources.some((resource) => resource.key === "local-agents:global")) await capacityWait?.promise;
      const lease = {
        id: `lease-${acquisitions.length}`, resources: request.resources, fences: {}, signal: new AbortController().signal,
        isValid: () => active.has(lease),
        assertValid: () => assert.ok(active.has(lease), "execution lease must remain valid"),
        release: async () => { active.delete(lease); },
        quarantine: async () => { active.delete(lease); },
      };
      active.add(lease);
      return lease;
    },
    listQuarantine: () => [],
  };
  const options = {
    extensionRoot,
    configuration: { maxConcurrentLocalAgents: 4 },
    managerOptions: { resourceBroker: broker },
    onAdapterSend: async ({ agentId }) => {
      assert.ok([...active].some((lease) => lease.resources.some((resource) => resource.key === "local-agents:global" && resource.units >= 2)), "provider execution requires reserved capacity");
      harness.adapterControlHistory.forEach((control) => control.release.resolve());
      return { answer: scenario.invalidConsensus ? "Unstructured response" : JSON.stringify({ consensus: false, answer: `${agentId} recorded conclusion` }) };
    },
  };
  let harness = loadManagerHarness(options);
  const original = harness;
  const openGate = () => harness.manager.getState().interactions.find((interaction) => interaction.kind === "humanGate" && interaction.status !== "resolved" && interaction.status !== "cancelled");
  const sent = () => harness.adapterControlHistory.reduce((sum, control) => sum + control.sendCount, 0);
  const executionRequests = () => acquisitions.filter((request) => request.resources.some((resource) => resource.key === "local-agents:global"));
  let conversation;
  const submit = async (selected, freeText = "") => harness.manager.handleMessage({ type: "interaction.submit", interactionRef: openGate().interactionRef, selected: [selected], freeText });
  const resume = () => harness.manager.handleMessage({ type: "conversation.runtime", conversationId: conversation.id, message: { type: "workflow.resume" } });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    conversation = await harness.manager.createConversation({ title: "Review", pipelineId: "review", workingDirectory: harness.workspaceDirectory });
    const started = harness.manager.runConversation(conversation.id, "Review UI", [], scenario.iterationCount ?? 1);
    await waitFor(openGate);
    await submit("cancel");
    await started;
    assert.equal(sent(), 2);
    assert.equal(executionRequests().length, 1);
    assert.equal([...active].filter((lease) => lease.resources.some((resource) => resource.key === "local-agents:global")).length, 0);
    await check({
      get harness() { return harness; }, conversation, openGate, sent, submit, resume, executionRequests,
      waitForCapacity: () => { capacityWait = deferred(); return capacityWait; },
      reloadWithInvalidCheckpoint: async () => {
        await harness.manager.dispose();
        const initialWorkspaceState = Object.fromEntries(harness.workspaceState);
        const recorded = Object.values(initialWorkspaceState).find((value) => value?.resumableWorkflow);
        assert.ok(recorded);
        recorded.resumableWorkflow.checkpoint.snapshot.pendingConsensus.review.participants.a = "missing-participant";
        harness = loadManagerHarness({ ...options, initialWorkspaceState, storageDirectory: original.storageDirectory, workspaceDirectories: original.workspaceDirectories });
        await harness.manager.handleMessage({ type: "manager.ready" });
      },
    });
  } finally {
    capacityWait?.resolve();
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.manager.dispose();
    harness.cleanup();
    if (harness !== original) original.cleanup();
    removeScratchSync(extensionRoot);
  }
};

test("the editor reopens and completes a saved decision without reserving provider capacity", async () => withSavedDecision(async (context) => {
  context.harness.configuration.set("maxConcurrentLocalAgents", 1);
  const resumed = context.resume();
  await waitFor(context.openGate);
  assert.equal(context.executionRequests().length, 1);
  assert.equal(context.sent(), 2);
  await context.submit("acceptParticipant:b", "Keep the recorded conclusion");
  await resumed;
  assert.equal(context.harness.manager.getState().conversations.find((entry) => entry.id === context.conversation.id).workflowStatus, "completed");
  assert.equal(context.sent(), 2);
  assert.equal(context.executionRequests().length, 1);
}));

test("an editor retry waits for full execution capacity before sending any provider request", async () => withSavedDecision(async (context) => {
  const resumed = context.resume();
  await waitFor(context.openGate);
  const wait = context.waitForCapacity();
  await context.submit("retry", "Reconsider keyboard access");
  await waitFor(() => context.executionRequests().length === 2);
  assert.equal(context.sent(), 2);
  assert.equal(context.executionRequests().at(-1).resources.find((resource) => resource.key === "local-agents:global").units, 2);
  wait.resolve();
  await waitFor(context.openGate);
  assert.equal(context.sent(), 4);
  await context.submit("acceptUnresolved", "Retain the disagreement");
  await resumed;
  assert.equal(context.sent(), 4);
}));

test("a refused editor retry preserves the saved decision for completion without new provider work", async () => withSavedDecision(async (context) => {
  context.harness.configuration.set("maxConcurrentLocalAgents", 1);
  const resumed = context.resume();
  const refused = assert.rejects(resumed, /needs 2 concurrent local provider processes/u);
  await waitFor(context.openGate);
  const before = context.openGate();
  await context.submit("retry", "Review the conflicting conclusions");
  await refused;
  assert.equal(context.sent(), 2);
  const reopened = context.resume();
  await waitFor(context.openGate);
  assert.deepEqual(context.openGate().options, before.options);
  await context.submit("acceptUnresolved", "Keep both conclusions");
  await reopened;
  assert.equal(context.sent(), 2);
  assert.equal(context.executionRequests().length, 1);
}));

test("the editor refuses a saved checkpoint with invalid participant ownership before provider acquisition", async () => withSavedDecision(async (context) => {
  await context.reloadWithInvalidCheckpoint();
  context.harness.configuration.set("maxConcurrentLocalAgents", 1);
  await assert.rejects(context.resume(), /saved consensus checkpoint does not match this pipeline decision/u);
  assert.equal(context.openGate(), undefined);
  assert.equal(context.sent(), 0);
  assert.equal(context.executionRequests().length, 1);
}));

test("discarding a saved invalid result acquires capacity for the next configured iteration", async () => withSavedDecision(async (context) => {
  const resumed = context.resume();
  await waitFor(context.openGate);
  const wait = context.waitForCapacity();
  await context.submit("discardStep");
  await waitFor(() => context.executionRequests().length === 2);
  assert.equal(context.sent(), 2);
  wait.resolve();
  await waitFor(context.openGate);
  assert.equal(context.sent(), 4);
  await context.submit("cancel");
  await resumed;
}, { invalidConsensus: true, iterationCount: 2 }));
