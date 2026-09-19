const assert = require("node:assert/strict");
const test = require("node:test");
const { loadProduction } = require("./support/productionSource.cjs");
const { withBridge, browserSession, browserBindingForSession, waitFor, token } = require("./support/repairedBridge.cjs");
const topology = require("../dist/runtime/adapterTopology.js");
const assignment = require("../dist/pipeline/agentAssignment.js");
const { createBrowserProviderAdapter } = require("../dist/adapters/browserProvider.js");
const { createSharedBrowserBridgeClient } = require("../dist/browser/sharedBridgeTransport.js");

const selectionFixture = (bridge, { oldSession, failCreate = false, failPersist = false } = {}) => {
  const disposed = [];
  const persisted = [];
  const pipeline = { id: "review", agents: [{ id: "worker", name: "Worker", adapter: oldSession ? "chatgpt-browser" : "codex-app-server" },
    { id: "lead", name: "Lead", adapter: "codex-app-server" }], roles: [], steps: [] };
  const makeAdapter = (definition, label) => {
    const adapter = definition.adapter === "chatgpt-browser"
      ? createBrowserProviderAdapter({ id: definition.id, ownerId: `runtime:${definition.id}`, provider: "chatgpt", bridge, turnTimeoutMs: 2000 })
      : { id: definition.id, adapterType: definition.adapter, dispose: async () => {} };
    return { ...adapter, dispose: async () => { disposed.push(label); await adapter.dispose(); } };
  };
  const initialAdapters = Object.fromEntries(pipeline.agents.map((definition) => [definition.id, makeAdapter(definition, `old-${definition.id}`)]));
  const state = { workingDirectory: process.cwd(), browserBridge: bridge.getStatus(), agents: Object.fromEntries(pipeline.agents.map((definition) => [definition.id,
    { id: definition.id, name: definition.name, adapterType: definition.adapter, status: "idle", output: "", sessionId: `existing-${definition.id}` }])) };
  if (oldSession) {
    state.agents.worker.sessionId = oldSession.id;
    state.agents.worker.browserBinding = bridge.bindSession("runtime:worker", oldSession.id);
  }
  const before = structuredClone(state.agents);
  let persistAttempts = 0;
  const dependencies = {
    ...assignment, bridge, state, pipeline, initialAdapters, runtimeOwnerId: "runtime", activePipelineScope: { key: "scope" },
    selectedPipelineSnapshot: { definition: pipeline }, disposed: false,
    registry: { types: () => ["chatgpt-browser", "codex-app-server"], create: (definition) => {
      if (failCreate) throw new Error("Provider construction failed");
      return makeAdapter(definition, `new-${definition.id}`);
    } },
    adapterFactoryContext: () => ({}), effectiveDefinition: (definition) => definition,
    assignedPipelineDefinition: assignment.assignedPipelineDefinition, withAssignments: (definition) => definition,
    buildTopology: topology.buildAdapterTopology, disposeTopology: topology.disposeTopology,
    refreshExecutionParticipants: () => {}, bindingFromSession: browserBindingForSession,
    agentAssignmentRefusal: () => undefined, assignmentRefusals: () => [],
    bindBrowserAgentsIn: topology.bindBrowserAgents,
    browserBindingHost: { ownerIdFor: (id) => `runtime:${id}`, bindConversation: (...args) => bridge.bindConversation(...args),
      bindSession: (...args) => bridge.bindSession(...args), resolveBoundSession: (...args) => bridge.resolveBoundSession(...args), releaseBinding: (...args) => bridge.releaseBinding(...args) },
    persistedAgentsFromState: () => topology.persistedAgentsFrom(state.agents),
    persistNow: async () => { persistAttempts += 1; if (failPersist && persistAttempts === 1) throw new Error("Persistence failed"); persisted.push(structuredClone(state.agents)); },
    logOutput: () => {}, checkSelectedReadiness: async () => {}, emitSnapshot: () => {},
  };
  const loaded = loadProduction("src/runtime/createRuntime.ts", ["currentTopology", "bindBrowserAgents", "buildAdapterTopology", "installTopology",
    "commitAgentAssignments", "assignableBrowserSession", "applyAgentAssignment"], dependencies,
  `let adapters = initialAdapters; let definitions = Object.fromEntries(pipeline.agents.map((definition) => [definition.id, definition]));
    let scopedAssignments; const activeAssignments = () => scopedAssignments?.assignments ?? {};`);
  return { ...loaded, before, state, disposed, persisted, initialAdapters, dispose: () => topology.disposeTopology(loaded.currentTopology()) };
};

for (const shared of [false, true]) {
  test(`F5 ${shared ? "shared" : "direct"} occupied selection preserves adapters, configuration, and previous session`, { timeout: 5000 }, async () => {
    await withBridge(async ({ bridge, publish }) => {
      const selected = browserSession(10, "/c/occupied");
      await publish([selected]);
      bridge.bindSession("another-owner", selected.id);
      const transport = shared ? createSharedBrowserBridgeClient({ endpoint: bridge.getStatus().endpoint, token }) : bridge;
      if (shared) await transport.start();
      const fixture = selectionFixture(transport);
      try {
        await assert.rejects(fixture.applyAgentAssignment("worker", "chatgpt-browser", selected.id), /already bound|unavailable/i);
        assert.deepEqual(fixture.state.agents, fixture.before);
        assert.deepEqual(fixture.disposed, []);
        assert.deepEqual(fixture.persisted, []);
        assert.equal(fixture.currentTopology().adapters.worker, fixture.initialAdapters.worker);
      } finally { await fixture.dispose(); if (shared) await transport.close(); }
    });
  });
}

test("F5 persistence failure restores the old adapters and binding", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, publish }) => {
    const previous = browserSession(10, "/c/old");
    const selected = browserSession(11, "/c/new");
    await publish([previous, selected]);
    const fixture = selectionFixture(bridge, { oldSession: previous, failPersist: true });
    try {
      await assert.rejects(fixture.commitAgentAssignments({ worker: { adapter: "chatgpt-browser", model: "changed" } },
        { agentId: "worker", sessionId: selected.id }), /Persistence failed/);
      assert.deepEqual(fixture.state.agents, fixture.before);
      assert.deepEqual(fixture.disposed, ["new-worker"]);
      assert.equal(fixture.currentTopology().adapters.worker, fixture.initialAdapters.worker);
      assert.deepEqual(fixture.persisted.at(-1), fixture.before);
      assert.throws(() => bridge.bindSession("intruder", previous.id), /already bound/);
      bridge.bindSession("new-owner", selected.id);
    } finally { await fixture.dispose(); }
  });
});

test("F5 construction failure cannot damage the previous browser session during rollback", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, publish }) => {
    const previous = browserSession(10, "/c/old");
    const selected = browserSession(11, "/c/new");
    await publish([previous, selected]);
    const fixture = selectionFixture(bridge, { oldSession: previous, failCreate: true });
    try {
      await assert.rejects(fixture.commitAgentAssignments({ worker: { adapter: "chatgpt-browser", model: "changed" } },
        { agentId: "worker", sessionId: selected.id }), /Provider construction failed/);
      assert.deepEqual(fixture.state.agents, fixture.before);
      assert.deepEqual(fixture.disposed, []);
      assert.equal(fixture.currentTopology().adapters.worker, fixture.initialAdapters.worker);
      assert.throws(() => bridge.bindSession("intruder", previous.id), /already bound/);
      bridge.bindSession("new-owner", selected.id);
    } finally { await fixture.dispose(); }
  });
});

test("F5 successful replacement retains the new binding while disposing only the changed adapter", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, publish }) => {
    const previous = browserSession(10, "/c/old");
    const selected = browserSession(11, "/c/new");
    await publish([previous, selected]);
    const fixture = selectionFixture(bridge, { oldSession: previous });
    try {
      await fixture.commitAgentAssignments({ worker: { adapter: "chatgpt-browser", model: "changed" } }, { agentId: "worker", sessionId: selected.id });
      assert.equal(fixture.state.agents.worker.sessionId, selected.id);
      assert.deepEqual(fixture.disposed, ["old-worker"]);
      assert.equal(fixture.currentTopology().adapters.lead, fixture.initialAdapters.lead);
      assert.equal(fixture.state.agents.lead.sessionId, "existing-lead");
      assert.throws(() => bridge.bindSession("intruder", selected.id), /already bound/);
      bridge.bindSession("old-owner", previous.id);
    } finally { await fixture.dispose(); }
  });
});

test("F5 shared ownership reservation holds both claims until commit or rollback", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, publish }) => {
    const first = browserSession(10, "/c/first");
    const second = browserSession(11, "/c/second");
    await publish([first, second]);
    const client = createSharedBrowserBridgeClient({ endpoint: bridge.getStatus().endpoint, token });
    await client.start();
    try {
      const initial = await client.beginBindingChange("run:worker", browserBindingForSession(first));
      await initial.commit();
      const change = await client.beginBindingChange("run:worker", browserBindingForSession(second));
      client.releaseBinding("run:worker");
      assert.throws(() => bridge.bindSession("intruder", first.id), /already bound/);
      assert.throws(() => bridge.bindSession("intruder", second.id), /already bound/);
      await change.rollback();
      assert.throws(() => bridge.bindSession("intruder", first.id), /already bound/);
      bridge.bindSession("intruder", second.id);
    } finally { await client.close(); }
  });
});

test("F5 closing a shared peer during a binding change releases both reservations", { timeout: 5000 }, async () => {
  await withBridge(async ({ bridge, publish }) => {
    const first = browserSession(10, "/c/first");
    const second = browserSession(11, "/c/second");
    await publish([first, second]);
    const client = createSharedBrowserBridgeClient({ endpoint: bridge.getStatus().endpoint, token });
    await client.start();
    const initial = await client.beginBindingChange("run:worker", browserBindingForSession(first));
    await initial.commit();
    await client.beginBindingChange("run:worker", browserBindingForSession(second));
    await client.close();
    for (const session of [first, second]) {
      await waitFor(() => {
        try { bridge.bindSession(`owner-${session.tabId}`, session.id); return true; }
        catch { return false; }
      }, `release session ${session.id}`);
      bridge.releaseBinding(`owner-${session.tabId}`);
    }
  });
});

test("F5 session picker distinguishes occupied durable chats from independent initial tabs", () => {
  const { browserSessionOccupiedLocally } = loadProduction("src/webview-ui/composerRender.ts", ["browserSessionOccupiedLocally"]);
  const first = browserSession(10);
  const second = browserSession(11);
  const panel = { agents: { worker: { id: "worker", adapterType: "chatgpt-browser", sessionId: first.id, browserBinding: browserBindingForSession(first) } } };
  assert.equal(browserSessionOccupiedLocally("lead", first, panel), true);
  assert.equal(browserSessionOccupiedLocally("lead", second, panel), false);
  assert.equal(browserSessionOccupiedLocally("worker", first, panel), false);
  const durable = browserSession(10, "/c/existing");
  panel.agents.worker = { ...panel.agents.worker, sessionId: durable.id, browserBinding: browserBindingForSession(durable) };
  assert.equal(browserSessionOccupiedLocally("lead", browserSession(11, "/c/existing"), panel), true);
});
