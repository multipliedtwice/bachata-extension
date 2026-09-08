const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const {
  createPipelineExecutionSnapshot,
  createPipelineSnapshot,
} = require("../dist/pipeline/identity.js");
const { removeScratchSync, scratchRootSync } = require("./support/scratch.cjs");

const {
  deferred,
  injectModule,
  loadRuntimeHarness,
} = require("./support/runtimeHarness.cjs");

const createBrowserSession = (id, title) => ({
  id,
  provider: "chatgpt",
  tabId: id === "old-session" ? 1 : 2,
  frameId: 0,
  documentToken: `document-${id}`,
  conversationUrl: `https://chatgpt.com/c/${id}`,
  conversationIdentity: id,
  title,
  status: "ready",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

const createCapturedBrowserResponse = (text, segments, requestId) => {
  const timestamp = new Date().toISOString();
  return {
    requestId,
    agentId: "chatgpt",
    sessionId: "browser-session",
    provider: "chatgpt",
    text,
    segments,
    assets: [],
    captureFormat: "renderedText",
    fidelity: "bestEffort",
    finalConversationUrl: "https://chatgpt.com/c/browser-action-boundary",
    finalConversationIdentity: "browser-action-boundary",
    finalSessionId: "browser-session",
    startedAt: timestamp,
    completedAt: timestamp,
  };
};

const createStructuredBrowserActionResponse = (value, requestId) => {
  const payload = JSON.stringify(value);
  const text = `\`\`\`bachata-action\n${payload}\n\`\`\``;
  return createCapturedBrowserResponse(
    text,
    [{ type: "codeBlock", text: payload, start: 0, end: text.length, language: "bachata-action" }],
    requestId,
  );
};

const createNaturalBrowserResponse = (text, requestId) =>
  createCapturedBrowserResponse(
    text,
    [{ type: "text", text, start: 0, end: text.length }],
    requestId,
  );

test("first run keeps the deterministic default until Setup selects a workflow", async () => {
  const harness = loadRuntimeHarness({
    onCommandCheck: ({ command }) => {
      if (command === "codex") throw new Error("codex unavailable");
      return "claude mock-1.0.0";
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(harness.runtime.getState().selectedPipelineId, "review-only");
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("the runtime publishes an execution contract for the selected pipeline", async () => {
  const harness = loadRuntimeHarness({
    onCommandCheck: ({ command, args }) => {
      if (command === "git" && args[0] === "--version") return "git version 2.39.5";
      if (command === "git" && args[0] === "status") return "";
      return `${command} mock-1.0.0`;
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.configure({ pipelineId: "codex-review" });
    const contract = harness.runtime.getState().executionContract;
    assert.equal(contract.pipelineId, "codex-review");
    assert.equal(contract.safetyLevel, "review");
    assert.equal(contract.scope.writeScope, "readOnly");
    assert.equal(contract.commitPolicy, "never");
    assert.ok(contract.limits.maxIterations >= 1);
    assert.equal(contract.providers[0].agentId, "codex");
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("readiness inspection probes providers and Git workspace state", async () => {
  const harness = loadRuntimeHarness({
    // Codex readiness is an app-server handshake, so the probe drives the protocol mock rather
    // than a --version stub.
    configuration: {
      codexCommand: path.join(__dirname, "fixtures", "mock-codex.cjs"),
      codexWorkspaceScope: "wholeWorkingDirectory",
    },
    onCommandCheck: ({ command, args }) => {
      if (command === "claude") throw new Error("claude unavailable");
      if (command === "git" && args[0] === "--version") return "git version 2.39.5";
      if (command === "git" && args[0] === "status") return " M src/a.ts";
      return `${command} mock-1.0.0`;
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const report = await harness.runtime.inspectReadiness(["codex-review"]);
    assert.equal(report.adapters.find((adapter) => adapter.type === "codex-app-server").available, true);
    assert.equal(report.adapters.find((adapter) => adapter.type === "claude-code").available, false);
    assert.equal(report.git.clean, false);
    assert.equal(report.pipelines[0].status, "ready");
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

const createTrackedBridge = (sessions, options = {}) => {
  const status = { enabled: true, connected: true, sessions };
  const opened = [];
  const bindings = new Map();
  const bindingForSession = (session) => ({
    provider: session.provider,
    conversationUrl: session.conversationUrl,
    conversationIdentity: session.conversationIdentity,
    preferredTabId: session.tabId,
  });
  const findSession = (binding, sessionId) =>
    sessions.find(
      (session) =>
        session.id === sessionId ||
        (binding &&
          session.provider === binding.provider &&
          session.conversationIdentity === binding.conversationIdentity),
    );
  return {
    status,
    bindings,
    opened,
    bridge: {
      start: async () => undefined,
      close: async () => undefined,
      getStatus: () => status,
      subscribeStatus: (listener) => {
        listener(status);
        return { dispose: () => undefined };
      },
      resetPairing: async () => undefined,
      discover: () => undefined,
      bindSession: (ownerId, sessionId) => {
        const session = sessions.find((item) => item.id === sessionId);
        if (!session) {
          throw new Error(`Unknown browser session: ${sessionId}`);
        }
        const binding = bindingForSession(session);
        bindings.set(ownerId, binding);
        return structuredClone(binding);
      },
      bindConversation: (ownerId, binding) => {
        bindings.set(ownerId, structuredClone(binding));
      },
      releaseBinding: (ownerId) => {
        bindings.delete(ownerId);
      },
      resolveBoundSession: (ownerId, binding, sessionId) => {
        const effectiveBinding = binding ?? bindings.get(ownerId);
        return findSession(effectiveBinding, sessionId);
      },
      openConversation: async (provider, signal, preferredBinding, fresh) => {
        opened.push({ provider, preferredBinding, fresh: fresh === true });
        const next = options.onOpenConversation?.({ provider, preferredBinding, fresh, index: opened.length });
        if (!next) {
          throw new Error("unused");
        }
        if (!sessions.includes(next)) {
          sessions.push(next);
        }
        return next;
      },
      sendConversation: () => {
        throw new Error("unused");
      },
      fetchAsset: () => {
        throw new Error("unused");
      },
      revealAsset: async () => undefined,
      interrupt: async () => undefined,
    },
  };
};

test("a shared bridge may publish its current status synchronously", async () => {
  const status = { enabled: true, connected: false, sessions: [] };
  const bridge = {
    start: async () => undefined,
    close: async () => undefined,
    getStatus: () => status,
    subscribeStatus: (listener) => {
      listener(status);
      return { dispose: () => undefined };
    },
    resetPairing: async () => undefined,
    discover: () => undefined,
    bindSession: () => {
      throw new Error("unused");
    },
    bindConversation: () => undefined,
    releaseBinding: () => undefined,
    resolveBoundSession: () => undefined,
    sendConversation: () => {
      throw new Error("unused");
    },
    fetchAsset: () => {
      throw new Error("unused");
    },
    interrupt: async () => undefined,
  };
  const harness = loadRuntimeHarness({
    runtimeOptions: {
      bridge,
      startBridge: false,
      closeBridge: false,
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.deepEqual(harness.runtime.getState().browserBridge, status);
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("failed browser selection persistence restores the previous routing", async () => {
  const oldSession = createBrowserSession("old-session", "Old conversation");
  const newSession = createBrowserSession("new-session", "New conversation");
  const tracked = createTrackedBridge([oldSession, newSession]);
  const oldBinding = {
    provider: oldSession.provider,
    conversationUrl: oldSession.conversationUrl,
    conversationIdentity: oldSession.conversationIdentity,
    preferredTabId: oldSession.tabId,
  };
  let failSelection = false;
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "chatgpt-browser-spike",
        taskDirty: false,
        agents: {
          chatgpt: {
            version: "browser-mock",
            sessionId: oldSession.id,
            browserBinding: oldBinding,
          },
        },
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
    beforeWorkspaceStateUpdate: ({ value }) => {
      if (
        failSelection &&
        value?.agents?.chatgpt?.sessionId === newSession.id
      ) {
        throw new Error("browser selection persistence failed");
      }
    },
    runtimeOptions: {
      bridge: tracked.bridge,
      startBridge: false,
      closeBridge: false,
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    failSelection = true;
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "browser.session.select",
        agentId: "chatgpt",
        sessionId: newSession.id,
      }),
      /browser selection persistence failed/,
    );

    const liveAgent = harness.runtime.getState().agents.chatgpt;
    assert.equal(liveAgent.sessionId, oldSession.id);
    assert.equal(liveAgent.browserBinding.conversationIdentity, oldSession.id);
    const persistedAgent = harness.workspaceState.get("bachata.runtimeState.v5").agents.chatgpt;
    assert.equal(persistedAgent.sessionId, oldSession.id);
    assert.equal(persistedAgent.browserBinding.conversationIdentity, oldSession.id);
    assert.deepEqual(
      Array.from(tracked.bindings.values()).map(
        (binding) => binding.conversationIdentity,
      ),
      [oldSession.id],
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("browser selection audit failure keeps the committed routing and reports the audit error", async () => {
  const oldSession = createBrowserSession("old-session", "Old conversation");
  const newSession = createBrowserSession("new-session", "New conversation");
  const tracked = createTrackedBridge([oldSession, newSession]);
  let failAudit = false;
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "chatgpt-browser-spike",
        taskDirty: false,
        agents: {
          chatgpt: {
            version: "browser-mock",
            sessionId: oldSession.id,
            browserBinding: {
              provider: oldSession.provider,
              conversationUrl: oldSession.conversationUrl,
              conversationIdentity: oldSession.conversationIdentity,
              preferredTabId: oldSession.tabId,
            },
          },
        },
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
    beforeTranscriptAppend: (entry) => {
      if (failAudit && entry.eventType === "browser.session.selected") {
        throw new Error("browser selection audit failed");
      }
    },
    runtimeOptions: {
      bridge: tracked.bridge,
      startBridge: false,
      closeBridge: false,
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    failAudit = true;
    await harness.runtime.handleMessage({
      type: "browser.session.select",
      agentId: "chatgpt",
      sessionId: newSession.id,
    });

    const liveAgent = harness.runtime.getState().agents.chatgpt;
    assert.equal(liveAgent.sessionId, newSession.id);
    assert.equal(liveAgent.browserBinding.conversationIdentity, newSession.id);
    const persistedAgent = harness.workspaceState.get("bachata.runtimeState.v5").agents.chatgpt;
    assert.equal(persistedAgent.sessionId, newSession.id);
    assert.equal(persistedAgent.browserBinding.conversationIdentity, newSession.id);
    assert.match(harness.runtime.getState().transcriptError, /audit entry could not be saved/);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

const sendMessage = (prompt = "prompt", recipients = ["codex"]) => ({
  type: "message.send",
  recipients,
  prompt,
  mode: "review",
  attachmentIds: [],
});

const waitFor = async (condition, message, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const singleAgentPipelineDefinition = () => ({
  version: 1,
  id: "cross-reference-development",
  name: "Single-agent pipeline",
  agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
  steps: [
    {
      id: "implementation",
      name: "Implementation",
      enabled: true,
      participants: ["codex"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
      humanGate: "none",
      type: "agent",
    },
  ],
});

const browserActionPipelineDefinition = () => ({
  version: 1,
  id: "browser-action-boundary",
  name: "Browser action boundary",
  agents: [{ id: "chatgpt", name: "ChatGPT", adapter: "chatgpt-browser" }],
  steps: [
    {
      id: "browser-action",
      name: "Browser action",
      enabled: true,
      participants: ["chatgpt"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
      humanGate: "none",
      type: "agent",
    },
  ],
});

const builtInPipelineDefinition = () =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../presets/cross-reference.pipeline.json"),
      "utf8",
    ),
  );

const createSingleAgentPipelineRoot = (definition = singleAgentPipelineDefinition()) => {
  const extensionRoot = scratchRootSync("bachata-runtime-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "cross-reference.pipeline.json"),
    JSON.stringify(definition),
  );
  return extensionRoot;
};

const queuedPipelineState = (
  id = "queued-work",
  definition = builtInPipelineDefinition(),
) => ({
  id,
  kind: "pipeline",
  pipelineId: definition.id,
  pipelineSnapshot: createPipelineSnapshot(definition, "builtin"),
  prompt: "Queued request",
  recipients: [],
  mode: "implementation",
  attachmentIds: [],
  iterationCount: 1,
  composerAuthorized: true,
  createdAt: new Date().toISOString(),
});

const singleAgentRecoveryState = (
  sourceQueueMessageId,
  definition = singleAgentPipelineDefinition(),
) => {
  const pipelineSnapshot = createPipelineSnapshot(definition, "builtin");
  return {
    pipelineId: definition.id,
    pipelineName: definition.name,
    pipelineHash: pipelineSnapshot.hash,
    pipelineSnapshot,
    userPrompt: "Recover this request",
    attachmentIds: [],
    nextStepIndex: 0,
    totalSteps: definition.steps.length,
    updatedAt: new Date().toISOString(),
    checkpoint: {
      version: 1,
      nextStepIndex: 0,
      snapshot: {
        roles: {},
        answers: {},
        latestAnswers: {},
        previousStepAnswers: { order: [], values: {} },
        latestInterventions: { order: [], values: {} },
      },
    },
    ...(sourceQueueMessageId ? { sourceQueueMessageId } : {}),
  };
};

const pipelineHash = (runtime, pipelineId) => {
  const summary = runtime.getState().pipelines.find((item) => item.id === pipelineId);
  assert.ok(summary?.hash);
  return summary.hash;
};

const createCustomPipeline = (runtime, pipeline, requestId) =>
  runtime.handleMessage({
    type: "pipeline.save",
    requestId,
    mode: "create",
    scopeKey: runtime.getState().pipelineScopeKey,
    pipeline,
  });

const updateCustomPipeline = (runtime, pipeline, requestId) =>
  runtime.handleMessage({
    type: "pipeline.save",
    requestId,
    mode: "update",
    scopeKey: runtime.getState().pipelineScopeKey,
    sourcePipelineId: pipeline.id,
    expectedHash: pipelineHash(runtime, pipeline.id),
    pipeline,
  });

const deleteCustomPipeline = (runtime, pipelineId, requestId) =>
  runtime.handleMessage({
    type: "pipeline.delete",
    requestId,
    pipelineId,
    scopeKey: runtime.getState().pipelineScopeKey,
    expectedHash: pipelineHash(runtime, pipelineId),
  });

const customPipelineDefinition = (id, name, promptTemplate = "{{userPrompt}}") => ({
  ...singleAgentPipelineDefinition(),
  id,
  name,
  steps: [
    {
      ...singleAgentPipelineDefinition().steps[0],
      promptTemplate,
    },
  ],
});

const checklistExecutionPipeline = (id, name, taskPipelineId) => ({
  ...customPipelineDefinition(id, name),
  steps: [
    {
      id: "prepare",
      name: "Prepare",
      enabled: true,
      participants: ["codex"],
      promptTemplate: "{{userPrompt}}",
      humanGate: "none",
      type: "checklist",
      outputName: "executionChecklist",
    },
    {
      id: "execute",
      name: "Execute",
      enabled: true,
      humanGate: "none",
      type: "executeChecklist",
      inputName: "executionChecklist",
      pipelineId: taskPipelineId,
      checks: [],
      allowNoChecks: true,
      allowedPaths: ["."],
      retries: 1,
      maxConcurrency: 1,
    },
  ],
});

const writeCustomPipeline = (workspaceRoot, pipeline) => {
  const directory = path.join(workspaceRoot, ".bachata", "pipelines");
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${pipeline.id}.pipeline.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(pipeline, null, 2)}\n`);
  return filePath;
};

const createPipelineCatalogCoordinator = () => {
  const runtimes = new Set();
  let mutationQueue = Promise.resolve();
  return {
    register: (runtime) => runtimes.add(runtime),
    withMutation: (_catalogDirectory, operation) => {
      const result = mutationQueue.then(operation, operation);
      mutationQueue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    notify: async (change) => {
      await Promise.all(Array.from(runtimes, (runtime) => runtime.refreshPipelines(change)));
    },
  };
};

test("queued execution retains its exact pipeline snapshot after the catalog changes", async () => {
  const original = customPipelineDefinition(
    "cross-reference-development",
    "Queued v1",
    "V1 {{userPrompt}}",
  );
  const replacement = customPipelineDefinition(
    "cross-reference-development",
    "Queued v2",
    "V2 {{userPrompt}}",
  );
  const selectedPipelineSnapshot = createPipelineSnapshot(original, "builtin");
  const queued = queuedPipelineState("queued-snapshot", original);
  const extensionRoot = createSingleAgentPipelineRoot(replacement);
  const executions = [];
  const harness = loadRuntimeHarness({
    extensionRoot,
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: original.id,
        selectedPipelineSnapshot,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [queued],
        queuePaused: true,
      },
    },
    runtimeOptions: {
      executeQueuedPipeline: async (request, onAccepted) => {
        executions.push(structuredClone(request));
        await onAccepted();
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(
      harness.runtime.getState().selectedPipelineDefinition.steps[0].promptTemplate,
      "V1 {{userPrompt}}",
    );
    await harness.runtime.handleMessage({ type: "queue.resume" });
    await waitFor(() => executions.length === 1, "queued snapshot did not execute");
    assert.equal(executions[0].pipelineSnapshot.hash, selectedPipelineSnapshot.hash);
    assert.equal(
      executions[0].pipelineSnapshot.definition.steps[0].promptTemplate,
      "V1 {{userPrompt}}",
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("workflow recovery retains its exact pipeline snapshot after the catalog changes", async () => {
  const original = customPipelineDefinition(
    "cross-reference-development",
    "Recovery v1",
    "V1 {{userPrompt}}",
  );
  const replacement = customPipelineDefinition(
    "cross-reference-development",
    "Recovery v2",
    "V2 {{userPrompt}}",
  );
  const selectedPipelineSnapshot = createPipelineSnapshot(original, "builtin");
  const extensionRoot = createSingleAgentPipelineRoot(replacement);
  const prompts = [];
  const harness = loadRuntimeHarness({
    extensionRoot,
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: original.id,
        selectedPipelineSnapshot,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow: singleAgentRecoveryState(undefined, original),
      },
    },
    onAdapterSend: ({ request }) => {
      prompts.push(request.prompt);
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(harness.runtime.getState().resumableWorkflow.pipelineHash, selectedPipelineSnapshot.hash);
    harness.adapterControls.get("codex").release.resolve();
    await harness.runtime.resumePipeline();
    assert.deepEqual(prompts, ["V1 Recover this request"]);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("legacy queued pipelines remain visible but cannot run without an immutable snapshot", async () => {
  const legacyQueued = queuedPipelineState("legacy-queued");
  delete legacyQueued.pipelineSnapshot;
  let executions = 0;
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: legacyQueued.pipelineId,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [legacyQueued],
        queuePaused: false,
      },
    },
    runtimeOptions: {
      executeQueuedPipeline: async () => {
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const restored = harness.runtime.getState().queuedMessages[0];
    assert.equal(restored.id, legacyQueued.id);
    assert.match(restored.blockedReason, /immutable pipeline snapshots/u);
    assert.equal(harness.runtime.getState().queuePaused, true);

    await assert.rejects(
      harness.runtime.handleMessage({ type: "queue.resume" }),
      /immutable pipeline snapshots/u,
    );
    assert.equal(executions, 0);
    assert.equal(harness.runtime.getState().queuePaused, true);
    assert.equal(harness.runtime.getState().queuedMessages[0].id, legacyQueued.id);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("legacy recoverable workflows fail closed with a durable transcript warning", async () => {
  const legacyRecovery = singleAgentRecoveryState();
  delete legacyRecovery.pipelineHash;
  delete legacyRecovery.pipelineSnapshot;
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: legacyRecovery.pipelineId,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow: legacyRecovery,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const state = harness.runtime.getState();
    assert.equal(state.resumableWorkflow, undefined);
    assert.equal(
      state.transcript.some((entry) => entry.eventType === "workflow.recovery.blocked"),
      true,
    );
    assert.match(
      state.transcript.find((entry) => entry.eventType === "workflow.recovery.blocked").text,
      /could not be verified/u,
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("legacy global custom pipelines migrate once into every available storage scope", async () => {
  const firstRoot = scratchRootSync("bachata-legacy-root-a-");
  const secondRoot = scratchRootSync("bachata-legacy-root-b-");
  const storageDirectory = scratchRootSync("bachata-legacy-storage-");
  const legacy = customPipelineDefinition("legacy-custom", "Legacy custom");
  const harness = loadRuntimeHarness({
    storageDirectory,
    workspaceDirectories: [firstRoot, secondRoot],
    initialWorkspaceState: {
      "bachata.customPipelines.v1": [legacy],
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    for (const directory of [
      path.join(firstRoot, ".bachata", "pipelines"),
      path.join(secondRoot, ".bachata", "pipelines"),
      path.join(storageDirectory, "pipelines"),
    ]) {
      const stored = JSON.parse(
        fs.readFileSync(path.join(directory, `${legacy.id}.pipeline.json`), "utf8"),
      );
      assert.equal(stored.name, legacy.name);
    }
    assert.equal(harness.workspaceState.has("bachata.customPipelines.v1"), false);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(firstRoot);
    removeScratchSync(secondRoot);
    removeScratchSync(storageDirectory);
  }
});

test("legacy custom pipeline migration preserves source state after a partial write failure", async () => {
  const firstRoot = scratchRootSync("bachata-legacy-partial-a-");
  const blockedRoot = scratchRootSync("bachata-legacy-partial-b-");
  const storageDirectory = scratchRootSync("bachata-legacy-partial-storage-");
  fs.writeFileSync(path.join(blockedRoot, ".bachata"), "blocked");
  const legacy = customPipelineDefinition("legacy-partial", "Legacy partial");
  const harness = loadRuntimeHarness({
    storageDirectory,
    workspaceDirectories: [firstRoot, blockedRoot],
    initialWorkspaceState: {
      "bachata.customPipelines.v1": [legacy],
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(
      fs.existsSync(
        path.join(firstRoot, ".bachata", "pipelines", `${legacy.id}.pipeline.json`),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        path.join(storageDirectory, "pipelines", `${legacy.id}.pipeline.json`),
      ),
      true,
    );
    assert.deepEqual(harness.workspaceState.get("bachata.customPipelines.v1"), [legacy]);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(firstRoot);
    removeScratchSync(blockedRoot);
    removeScratchSync(storageDirectory);
  }
});

test("clean persisted selections adopt the active root scope even when definitions match", async () => {
  const firstRoot = scratchRootSync("bachata-scope-root-a-");
  const secondRoot = scratchRootSync("bachata-scope-root-b-");
  const definition = customPipelineDefinition("same-definition", "Same definition");
  writeCustomPipeline(firstRoot, definition);
  writeCustomPipeline(secondRoot, definition);
  const firstSnapshot = createPipelineSnapshot(
    definition,
    `workspace:${firstRoot}`,
    firstRoot,
  );
  const harness = loadRuntimeHarness({
    workspaceDirectories: [firstRoot, secondRoot],
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        workingDirectory: secondRoot,
        selectedPipelineId: definition.id,
        selectedPipelineSnapshot: firstSnapshot,
        taskDirty: false,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const canonicalSecondRoot = fs.realpathSync.native(secondRoot);
    const snapshot = harness.runtime.getSelectedPipelineSnapshot();
    assert.equal(snapshot.scopeRoot, secondRoot);
    assert.equal(snapshot.scopeKey, `workspace:${process.platform === "win32" ? canonicalSecondRoot.toLowerCase() : canonicalSecondRoot}`);
    assert.equal(harness.runtime.getState().pipelineScopeRoot, secondRoot);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(firstRoot);
    removeScratchSync(secondRoot);
  }
});

test("shared custom pipeline revisions reject stale saves and deletes", async () => {
  const workspaceRoot = scratchRootSync("bachata-shared-pipelines-");
  const coordinator = createPipelineCatalogCoordinator();
  const runtimeOptions = (ownerId) => ({
    ownerId,
    withPipelineCatalogMutation: coordinator.withMutation,
    onPipelineCatalogChanged: coordinator.notify,
  });
  const first = loadRuntimeHarness({
    workspaceDirectories: [workspaceRoot],
    runtimeOptions: runtimeOptions("run-a"),
  });
  const second = loadRuntimeHarness({
    workspaceDirectories: [workspaceRoot],
    runtimeOptions: runtimeOptions("run-b"),
  });
  coordinator.register(first.runtime);
  coordinator.register(second.runtime);
  try {
    await Promise.all([
      first.runtime.handleMessage({ type: "ready" }),
      second.runtime.handleMessage({ type: "ready" }),
    ]);
    const original = customPipelineDefinition("shared-custom", "Shared v1");
    await createCustomPipeline(first.runtime, original, "create-shared");
    assert.equal(
      second.runtime.getState().pipelines.find((item) => item.id === original.id).name,
      "Shared v1",
    );
    await assert.rejects(
      createCustomPipeline(
        second.runtime,
        { ...original, name: "Accidental replacement" },
        "create-collision",
      ),
      /already exists/u,
    );
    await second.runtime.handleMessage({
      type: "pipeline.select",
      pipelineId: original.id,
    });
    const staleHash = pipelineHash(second.runtime, original.id);
    const current = { ...original, name: "Shared v2" };
    await updateCustomPipeline(first.runtime, current, "update-shared");
    assert.equal(second.runtime.getState().selectedPipelineDefinition.name, "Shared v2");

    await assert.rejects(
      second.runtime.handleMessage({
        type: "pipeline.save",
        mode: "update",
        scopeKey: second.runtime.getState().pipelineScopeKey,
        sourcePipelineId: original.id,
        expectedHash: staleHash,
        pipeline: { ...original, name: "Stale overwrite" },
      }),
      /changed in another run/u,
    );
    await assert.rejects(
      second.runtime.handleMessage({
        type: "pipeline.delete",
        pipelineId: original.id,
        scopeKey: second.runtime.getState().pipelineScopeKey,
        expectedHash: staleHash,
      }),
      /changed in another run/u,
    );
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(workspaceRoot, ".bachata", "pipelines", `${original.id}.pipeline.json`),
        "utf8",
      ),
    );
    assert.equal(stored.name, "Shared v2");
  } finally {
    first.adapterControls.forEach((control) => control.release.resolve());
    second.adapterControls.forEach((control) => control.release.resolve());
    await Promise.all([first.runtime.dispose(), second.runtime.dispose()]);
    first.cleanup();
    second.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

test("catalog deletion stays visible across runs and reset drops a deleted immutable selection", async () => {
  const workspaceRoot = scratchRootSync("bachata-shared-delete-");
  const coordinator = createPipelineCatalogCoordinator();
  const runtimeOptions = (ownerId) => ({
    ownerId,
    withPipelineCatalogMutation: coordinator.withMutation,
    onPipelineCatalogChanged: coordinator.notify,
  });
  const first = loadRuntimeHarness({
    workspaceDirectories: [workspaceRoot],
    runtimeOptions: runtimeOptions("delete-a"),
  });
  const second = loadRuntimeHarness({
    workspaceDirectories: [workspaceRoot],
    saveAttachment: async (input) => ({
      id: input.id,
      name: input.name,
      mimeType: input.mimeType,
      size: 1,
      relativePath: `attachments/${input.id}.png`,
    }),
    runtimeOptions: runtimeOptions("delete-b"),
  });
  coordinator.register(first.runtime);
  coordinator.register(second.runtime);
  try {
    await Promise.all([
      first.runtime.handleMessage({ type: "ready" }),
      second.runtime.handleMessage({ type: "ready" }),
    ]);
    const custom = customPipelineDefinition("delete-custom", "Delete custom");
    await createCustomPipeline(first.runtime, custom, "create-delete");
    await second.runtime.handleMessage({
      type: "pipeline.select",
      pipelineId: custom.id,
    });
    await second.runtime.handleMessage({
      type: "attachment.add",
      clientId: "attachment-for-delete",
      taskId: second.runtime.getState().taskId,
      name: "screen.png",
      mimeType: "image/png",
      dataBase64: "AA==",
    });

    await deleteCustomPipeline(first.runtime, custom.id, "delete-shared");
    assert.equal(
      second.runtime.getState().pipelines.some((item) => item.id === custom.id),
      false,
    );
    assert.equal(second.runtime.getState().selectedPipelineId, custom.id);
    assert.equal(second.runtime.getState().pipelineMutable, false);

    await second.runtime.handleMessage({ type: "task.reset" });
    const resetState = second.runtime.getState();
    assert.equal(resetState.selectedPipelineId, "review-only");
    assert.equal(resetState.attachments.length, 0);
    assert.equal(
      resetState.pipelines.some((item) => item.id === resetState.selectedPipelineId),
      true,
    );
  } finally {
    first.adapterControls.forEach((control) => control.release.resolve());
    second.adapterControls.forEach((control) => control.release.resolve());
    await Promise.all([first.runtime.dispose(), second.runtime.dispose()]);
    first.cleanup();
    second.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

test("multi-root custom pipeline ids resolve and save within the selected root", async () => {
  const firstRoot = scratchRootSync("bachata-root-a-");
  const secondRoot = scratchRootSync("bachata-root-b-");
  const firstDefinition = customPipelineDefinition("root-shared", "Root A", "A {{userPrompt}}");
  const secondDefinition = customPipelineDefinition("root-shared", "Root B", "B {{userPrompt}}");
  const firstFile = writeCustomPipeline(firstRoot, firstDefinition);
  const secondFile = writeCustomPipeline(secondRoot, secondDefinition);
  const harness = loadRuntimeHarness({
    workspaceDirectories: [firstRoot, secondRoot],
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(
      harness.runtime.getState().pipelines.find((item) => item.id === "root-shared").name,
      "Root A",
    );

    await harness.runtime.configure({ workingDirectory: secondRoot });
    const scoped = harness.runtime.getState().pipelines.find(
      (item) => item.id === "root-shared",
    );
    assert.equal(scoped.name, "Root B");
    assert.equal(scoped.scopeRoot, secondRoot);
    await harness.runtime.handleMessage({
      type: "pipeline.select",
      pipelineId: "root-shared",
    });
    await updateCustomPipeline(
      harness.runtime,
      { ...secondDefinition, name: "Root B updated" },
      "update-root-b",
    );

    assert.equal(JSON.parse(fs.readFileSync(firstFile, "utf8")).name, "Root A");
    assert.equal(JSON.parse(fs.readFileSync(secondFile, "utf8")).name, "Root B updated");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(firstRoot);
    removeScratchSync(secondRoot);
  }
});

test("scoped pipeline resolution reads the requested root, not the active conversation scope", async () => {
  const firstRoot = scratchRootSync("bachata-scope-a-");
  const secondRoot = scratchRootSync("bachata-scope-b-");
  writeCustomPipeline(firstRoot, customPipelineDefinition("root-a-only", "Root A only"));
  writeCustomPipeline(secondRoot, customPipelineDefinition("root-b-only", "Root B only"));
  const harness = loadRuntimeHarness({ workspaceDirectories: [firstRoot, secondRoot] });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(harness.runtime.getState().pipelineScopeRoot, firstRoot);

    const scoped = await harness.runtime.resolvePipelineSnapshotInScope(
      secondRoot,
      "root-b-only",
      { requireCurrentCatalog: true },
    );
    assert.equal(scoped.definition.name, "Root B only");
    assert.equal(scoped.scopeRoot, secondRoot);

    await assert.rejects(
      harness.runtime.resolvePipelineSnapshotInScope(secondRoot, "root-a-only", {}),
      /Unknown pipeline: root-a-only/u,
    );

    const active = await harness.runtime.resolvePipelineSnapshotInScope(
      firstRoot,
      "root-a-only",
      {},
    );
    assert.equal(active.definition.name, "Root A only");

    const builtIn = await harness.runtime.resolvePipelineSnapshotInScope(
      secondRoot,
      "codex-review",
      {},
    );
    assert.equal(builtIn.scopeKey, "builtin");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(firstRoot);
    removeScratchSync(secondRoot);
  }
});

test("startup clears an interrupted queue claim and keeps the request paused", async () => {
  const queued = queuedPipelineState("interrupted-claim");
  let executions = 0;
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [queued],
        queuePaused: false,
        queueStart: {
          messageId: queued.id,
          claimedAt: new Date().toISOString(),
        },
      },
    },
    runtimeOptions: {
      executeQueuedPipeline: async () => {
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });

    const live = harness.runtime.getState();
    assert.deepEqual(live.queuedMessages.map((item) => item.id), [queued.id]);
    assert.equal(live.queuePaused, true);
    assert.equal(executions, 0);
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.deepEqual(persisted.queuedMessages.map((item) => item.id), [queued.id]);
    assert.equal(persisted.queuePaused, true);
    assert.equal(persisted.queueStart, undefined);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("startup adopts a claimed queued pipeline checkpoint without retaining duplicate work", async () => {
  const extensionRoot = createSingleAgentPipelineRoot();
  const definition = singleAgentPipelineDefinition();
  const queued = queuedPipelineState("claimed-recovery", definition);
  const recovery = singleAgentRecoveryState(queued.id, definition);
  let executions = 0;
  const harness = loadRuntimeHarness({
    extensionRoot,
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [queued],
        queuePaused: false,
        queueStart: {
          messageId: queued.id,
          claimedAt: new Date().toISOString(),
        },
        resumableWorkflow: recovery,
      },
    },
    runtimeOptions: {
      executeQueuedPipeline: async () => {
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });

    const live = harness.runtime.getState();
    assert.equal(live.queuedMessages.length, 0);
    assert.equal(live.queuePaused, false);
    assert.equal(live.resumableWorkflow?.sourceQueueMessageId, queued.id);
    assert.equal(executions, 0);
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persisted.queuedMessages.length, 0);
    assert.equal(persisted.queuePaused, false);
    assert.equal(persisted.queueStart, undefined);
    assert.equal(persisted.resumableWorkflow?.sourceQueueMessageId, queued.id);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("a claimed queue item cannot be cancelled while its execution is being prepared", async () => {
  const executionStarted = deferred();
  const releaseExecution = deferred();
  const harness = loadRuntimeHarness({
    runtimeOptions: {
      executeQueuedPipeline: async (_request, onAccepted) => {
        executionStarted.resolve();
        await releaseExecution.promise;
        await onAccepted();
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const run = harness.runtime.handleMessage({
      type: "pipeline.run",
      requestId: "claimed-cancel",
      prompt: "Prepare this request",
      attachmentIds: [],
      iterationCount: 1,
      delivery: "queue",
    });
    await executionStarted.promise;
    const queued = harness.runtime.getState().queuedMessages[0];
    assert.ok(queued);

    await assert.rejects(
      harness.runtime.handleMessage({
        type: "queue.cancel",
        messageId: queued.id,
      }),
      /already started/,
    );
    assert.deepEqual(
      harness.runtime.getState().queuedMessages.map((item) => item.id),
      [queued.id],
    );

    releaseExecution.resolve();
    await run;
    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
  } finally {
    releaseExecution.resolve();
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("resuming a paused queue waits for an active mutation and retries automatically", async () => {
  const saveStarted = deferred();
  const releaseSave = deferred();
  let attempts = 0;
  const harness = loadRuntimeHarness({
    saveAttachment: async (input) => {
      saveStarted.resolve();
      await releaseSave.promise;
      return {
        id: input.id,
        name: input.name,
        mimeType: input.mimeType,
        size: 1,
        relativePath: `attachments/${input.id}.png`,
      };
    },
    runtimeOptions: {
      executeQueuedPipeline: async (_request, onAccepted) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("retryable queue failure");
        }
        await onAccepted();
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      requestId: "queue-retry",
      prompt: "queued pipeline",
      attachmentIds: [],
      iterationCount: 1,
      delivery: "queue",
    });
    assert.equal(attempts, 1);
    assert.equal(harness.runtime.getState().queuePaused, true);
    assert.equal(harness.runtime.getState().queuedMessages.length, 1);

    const taskId = harness.runtime.getState().taskId;
    const attachment = harness.runtime.handleMessage({
      type: "attachment.add",
      clientId: "queue-race-attachment",
      taskId,
      name: "queue-race.png",
      mimeType: "image/png",
      dataBase64: "AA==",
    });
    await saveStarted.promise;
    const resume = harness.runtime.handleMessage({ type: "queue.resume" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(attempts, 1);

    releaseSave.resolve();
    await Promise.all([attachment, resume]);
    await waitFor(
      () => attempts === 2 && harness.runtime.getState().queuedMessages.length === 0,
      "resumed queue did not commit its dequeue",
    );
    assert.equal(harness.runtime.getState().queuePaused, false);
    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
  } finally {
    releaseSave.resolve();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("failed queue persistence publishes no work and cannot execute it after a directory change", async () => {
  let failEnqueue = false;
  let targetDirectory;
  let executions = 0;
  const harness = loadRuntimeHarness({
    beforeWorkspaceStateUpdate: ({ value }) => {
      if (
        failEnqueue &&
        value?.queuedMessages?.length === 1 &&
        value.queueStart === undefined
      ) {
        throw new Error("queue enqueue persistence failed");
      }
    },
    showOpenDialog: () => [{ fsPath: targetDirectory }],
    runtimeOptions: {
      executeQueuedPipeline: async (_request, onAccepted) => {
        await onAccepted();
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    targetDirectory = path.join(harness.workspaceDirectory, "replacement");
    fs.mkdirSync(targetDirectory);
    failEnqueue = true;

    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        requestId: "failed-queue-enqueue",
        prompt: "This request must not be retained",
        attachmentIds: [],
        iterationCount: 1,
        delivery: "queue",
      }),
      /queue enqueue persistence failed/,
    );
    failEnqueue = false;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(executions, 0);
    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").queuedMessages.length,
      0,
    );
    assert.equal(
      harness.transcript.some((entry) => entry.eventType === "user.message"),
      false,
    );

    await harness.runtime.handleMessage({ type: "workingDirectory.pick" });
    assert.equal(harness.runtime.getState().workingDirectory, fs.realpathSync.native(targetDirectory));
    assert.equal(executions, 0);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("queue transcript audit failure does not reject or duplicate committed work", async () => {
  let failAudit = true;
  let executions = 0;
  const harness = loadRuntimeHarness({
    beforeTranscriptAppend: (entry) => {
      if (failAudit && entry.eventType === "user.message") {
        failAudit = false;
        throw new Error("queue audit failed");
      }
    },
    runtimeOptions: {
      executeQueuedPipeline: async (_request, onAccepted) => {
        await onAccepted();
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      requestId: "queue-audit-failure",
      prompt: "Execute once",
      attachmentIds: [],
      iterationCount: 1,
      delivery: "queue",
    });

    assert.equal(executions, 1);
    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").queuedMessages.length,
      0,
    );
    assert.equal(
      harness.transcript.filter((entry) => entry.eventType === "message.dequeued").length,
      1,
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("failed queue cancellation retains the live and persisted request", async () => {
  const queued = queuedPipelineState();
  let failCancellation = false;
  let executions = 0;
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [queued],
        queuePaused: true,
      },
    },
    beforeWorkspaceStateUpdate: ({ value }) => {
      if (failCancellation && value?.queuedMessages?.length === 0) {
        throw new Error("queue cancellation persistence failed");
      }
    },
    runtimeOptions: {
      executeQueuedPipeline: async () => {
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    failCancellation = true;
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "queue.cancel",
        messageId: queued.id,
      }),
      /queue cancellation persistence failed/,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(executions, 0);
    assert.deepEqual(
      harness.runtime.getState().queuedMessages.map((item) => item.id),
      [queued.id],
    );
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.deepEqual(persisted.queuedMessages.map((item) => item.id), [queued.id]);
    assert.equal(persisted.queuePaused, true);
    assert.equal(persisted.queueStart, undefined);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("queued work remains durably claimed until executor completion", async () => {
  const executionStarted = deferred();
  const releaseExecution = deferred();
  let executions = 0;
  const harness = loadRuntimeHarness({
    runtimeOptions: {
      executeQueuedPipeline: async (request, onAccepted) => {
        await onAccepted();
        executions += 1;
        executionStarted.resolve(request.queueMessageId);
        await releaseExecution.promise;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const run = harness.runtime.handleMessage({
      type: "pipeline.run",
      requestId: "claimed-through-completion",
      prompt: "Keep this claimed until completion",
      attachmentIds: [],
      iterationCount: 1,
      delivery: "queue",
    });
    const messageId = await executionStarted.promise;

    assert.equal(executions, 1);
    assert.deepEqual(
      harness.runtime.getState().queuedMessages.map((item) => item.id),
      [messageId],
    );
    const persistedWhileRunning = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.deepEqual(
      persistedWhileRunning.queuedMessages.map((item) => item.id),
      [messageId],
    );
    assert.equal(persistedWhileRunning.queueStart?.messageId, messageId);

    releaseExecution.resolve();
    await run;

    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
    const persistedAfterCompletion = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persistedAfterCompletion.queuedMessages.length, 0);
    assert.equal(persistedAfterCompletion.queueStart, undefined);
  } finally {
    releaseExecution.resolve();
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("queued direct work remains recoverable until provider completion", async () => {
  const harness = loadRuntimeHarness();
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const control = harness.adapterControls.get("codex");
    const run = harness.runtime.handleMessage({
      type: "message.send",
      recipients: ["codex"],
      prompt: "Keep this direct request durable",
      mode: "review",
      attachmentIds: [],
      delivery: "queue",
    });
    await control.started.promise;

    assert.equal(control.sendCount, 1);
    assert.equal(harness.runtime.getState().queuedMessages.length, 1);
    const queuedId = harness.runtime.getState().queuedMessages[0].id;
    const persistedWhileRunning = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persistedWhileRunning.queuedMessages[0].id, queuedId);
    assert.equal(persistedWhileRunning.queueStart?.messageId, queuedId);

    control.release.resolve();
    await run;

    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
    const persistedAfterCompletion = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persistedAfterCompletion.queuedMessages.length, 0);
    assert.equal(persistedAfterCompletion.queueStart, undefined);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("persistent completion persistence failure retains one claimed paused request", async () => {
  let claimObserved = false;
  let failCompletion = true;
  let executions = 0;
  const harness = loadRuntimeHarness({
    beforeWorkspaceStateUpdate: ({ value }) => {
      if (value?.queueStart?.messageId) {
        claimObserved = true;
      }
      if (
        claimObserved &&
        failCompletion &&
        value?.queuedMessages?.length === 0 &&
        value.queueStart === undefined
      ) {
        throw new Error("queue completion persistence failed");
      }
    },
    runtimeOptions: {
      executeQueuedPipeline: async (_request, onAccepted) => {
        await onAccepted();
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      requestId: "failed-completion-commit",
      prompt: "Execute once and retain uncertainty",
      attachmentIds: [],
      iterationCount: 1,
      delivery: "queue",
    });

    assert.equal(executions, 1);
    assert.equal(harness.runtime.getState().queuePaused, true);
    assert.equal(harness.runtime.getState().queuedMessages.length, 1);
    const queuedId = harness.runtime.getState().queuedMessages[0].id;
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persisted.queuePaused, true);
    assert.equal(persisted.queuedMessages[0].id, queuedId);
    assert.equal(persisted.queueStart?.messageId, queuedId);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(executions, 1);

    failCompletion = false;
    await harness.runtime.handleMessage({
      type: "queue.cancel",
      messageId: queuedId,
    });
    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").queueStart,
      undefined,
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("interrupt delivery cannot restart the request it superseded", async () => {
  const prompts = [];
  const harness = loadRuntimeHarness({
    onAdapterSend: async ({ request }) => {
      prompts.push(request.prompt);
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const control = harness.adapterControls.get("codex");
    const first = harness.runtime.handleMessage({
      type: "message.send",
      recipients: ["codex"],
      prompt: "First queued request",
      mode: "review",
      attachmentIds: [],
      delivery: "queue",
    });
    await control.started.promise;
    assert.deepEqual(prompts, ["First queued request"]);

    const second = harness.runtime.handleMessage({
      type: "message.send",
      recipients: ["codex"],
      prompt: "Superseding request",
      mode: "review",
      attachmentIds: [],
      delivery: "interrupt",
    });
    await waitFor(
      () => control.sendCount === 2,
      "the superseding request did not start",
    );
    assert.deepEqual(prompts, ["First queued request", "Superseding request"]);
    assert.equal(
      prompts.filter((prompt) => prompt === "First queued request").length,
      1,
    );

    control.release.resolve();
    await Promise.all([first, second]);
    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").queueStart,
      undefined,
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("failed interrupt preparation keeps the committed request paused and recoverable", async () => {
  const extensionRoot = createSingleAgentPipelineRoot();
  const recovery = singleAgentRecoveryState();
  let failDiscard = false;
  let executions = 0;
  const harness = loadRuntimeHarness({
    extensionRoot,
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow: recovery,
      },
    },
    beforeWorkspaceStateUpdate: ({ value }) => {
      if (failDiscard && value?.resumableWorkflow === undefined) {
        throw new Error("interrupt recovery discard failed");
      }
    },
    runtimeOptions: {
      executeQueuedDirect: async () => {
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    failDiscard = true;
    await harness.runtime.handleMessage({
      type: "message.send",
      recipients: ["codex"],
      prompt: "Supersede only after a durable interrupt",
      mode: "review",
      attachmentIds: [],
      delivery: "interrupt",
    });

    assert.equal(executions, 0);
    assert.equal(harness.runtime.getState().queuedMessages.length, 1);
    assert.equal(harness.runtime.getState().queuePaused, true);
    assert.equal(harness.runtime.getState().resumableWorkflow?.pipelineId, recovery.pipelineId);
    assert.match(harness.runtime.getState().transcriptError, /interrupt preparation failed/);
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persisted.queuedMessages.length, 1);
    assert.equal(persisted.queuePaused, true);
    assert.equal(persisted.resumableWorkflow?.pipelineId, recovery.pipelineId);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("failed queue resume remains paused and schedules no execution", async () => {
  const queued = queuedPipelineState();
  let failResume = false;
  let executions = 0;
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [queued],
        queuePaused: true,
      },
    },
    beforeWorkspaceStateUpdate: ({ value }) => {
      if (
        failResume &&
        value?.queuedMessages?.length === 1 &&
        value.queuePaused === false
      ) {
        throw new Error("queue resume persistence failed");
      }
    },
    runtimeOptions: {
      executeQueuedPipeline: async () => {
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    failResume = true;
    await assert.rejects(
      harness.runtime.handleMessage({ type: "queue.resume" }),
      /queue resume persistence failed/,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.equal(executions, 0);
    assert.equal(harness.runtime.getState().queuePaused, true);
    assert.equal(harness.runtime.getState().queuedMessages.length, 1);
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persisted.queuePaused, true);
    assert.equal(persisted.queuedMessages.length, 1);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a failed queued pipeline execution becomes one recoverable workflow without duplicate work", async () => {
  const extensionRoot = createSingleAgentPipelineRoot();
  let failFirstExecution = true;
  const harness = loadRuntimeHarness({
    extensionRoot,
    onAdapterSend: async () => {
      if (failFirstExecution) {
        failFirstExecution = false;
        throw new Error("queued provider failed after recovery commit");
      }
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      requestId: "recoverable-queue-start",
      prompt: "Recover exactly once",
      attachmentIds: [],
      iterationCount: 1,
      delivery: "queue",
    });

    const failedState = harness.runtime.getState();
    assert.equal(failedState.queuedMessages.length, 0);
    assert.equal(failedState.resumableWorkflow?.sourceQueueMessageId !== undefined, true);
    assert.equal(harness.adapterControls.get("codex").sendCount, 1);
    const persistedAfterFailure = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persistedAfterFailure.queuedMessages.length, 0);
    assert.equal(persistedAfterFailure.queueStart, undefined);
    assert.equal(
      persistedAfterFailure.resumableWorkflow?.sourceQueueMessageId,
      failedState.resumableWorkflow.sourceQueueMessageId,
    );

    harness.adapterControls.get("codex").release.resolve();
    await harness.runtime.handleMessage({ type: "workflow.resume" });

    assert.equal(harness.adapterControls.get("codex").sendCount, 2);
    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
    assert.equal(harness.runtime.getState().resumableWorkflow, undefined);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("failed recovery creation publishes no runnable checkpoint", async () => {
  const extensionRoot = createSingleAgentPipelineRoot();
  let failRecovery = false;
  const harness = loadRuntimeHarness({
    extensionRoot,
    beforeWorkspaceStateUpdate: ({ value }) => {
      if (failRecovery && value?.resumableWorkflow) {
        throw new Error("recovery persistence failed");
      }
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    failRecovery = true;
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        requestId: "failed-recovery-start",
        prompt: "Do not expose recovery",
        attachmentIds: [],
        iterationCount: 1,
        delivery: "immediate",
      }),
      /recovery persistence failed/,
    );

    assert.equal(harness.runtime.getState().resumableWorkflow, undefined);
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").resumableWorkflow,
      undefined,
    );
    assert.equal(harness.adapterControls.get("codex").sendCount, 0);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("failed recovery discard retains the live and persisted checkpoint", async () => {
  const extensionRoot = createSingleAgentPipelineRoot();
  const recovery = singleAgentRecoveryState();
  let failDiscard = false;
  const harness = loadRuntimeHarness({
    extensionRoot,
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow: recovery,
      },
    },
    beforeWorkspaceStateUpdate: ({ value }) => {
      if (failDiscard && value?.resumableWorkflow === undefined) {
        throw new Error("recovery discard persistence failed");
      }
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    failDiscard = true;
    await assert.rejects(
      harness.runtime.handleMessage({ type: "workflow.discard" }),
      /recovery discard persistence failed/,
    );

    assert.equal(
      harness.runtime.getState().resumableWorkflow?.userPrompt,
      recovery.userPrompt,
    );
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").resumableWorkflow.userPrompt,
      recovery.userPrompt,
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("a rejected overlapping direct send does not interrupt the request that owns the agent", async () => {
  const harness = loadRuntimeHarness();
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const control = harness.adapterControls.get("codex");
    const first = harness.runtime.handleMessage(sendMessage("first"));
    await control.started.promise;

    await assert.rejects(
      harness.runtime.handleMessage(sendMessage("second")),
      /codex is already running/,
    );
    assert.equal(control.interruptCount, 0);

    control.release.resolve();
    await first;
    assert.equal(control.sendCount, 1);
    assert.equal(harness.runtime.getState().agents.codex.status, "idle");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("interrupt waits for a reserved direct send to leave attachment resolution", async () => {
  const resolveStarted = deferred();
  const releaseResolve = deferred();
  const harness = loadRuntimeHarness({
    resolvePaths: async () => {
      resolveStarted.resolve();
      await releaseResolve.promise;
      return { paths: [], dispose: async () => undefined };
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(sendMessage());
    await resolveStarted.promise;

    let interrupted = false;
    const interrupt = harness.runtime
      .handleMessage({ type: "run.interrupt", agentId: "codex" })
      .then(() => {
        interrupted = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(interrupted, false);

    releaseResolve.resolve();
    await Promise.all([send, interrupt]);
    assert.equal(harness.adapterControls.get("codex").sendCount, 0);
  } finally {
    releaseResolve.resolve();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("interrupting one reserved recipient does not cancel the other recipient", async () => {
  const resolveStarted = deferred();
  const releaseResolve = deferred();
  const harness = loadRuntimeHarness({
    resolvePaths: async () => {
      resolveStarted.resolve();
      await releaseResolve.promise;
      return { paths: [], dispose: async () => undefined };
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(
      sendMessage("shared", ["codex", "claude"]),
    );
    await resolveStarted.promise;

    const interrupt = harness.runtime.handleMessage({
      type: "run.interrupt",
      agentId: "codex",
    });
    releaseResolve.resolve();
    await interrupt;

    const codex = harness.adapterControls.get("codex");
    const claude = harness.adapterControls.get("claude");
    assert.equal(codex.sendCount, 0);
    await claude.started.promise;
    assert.equal(claude.sendCount, 1);

    claude.release.resolve();
    await send;
  } finally {
    releaseResolve.resolve();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});




test("pipeline preflight failures keep the run idle and preserve an editable draft state", async () => {
  const extensionRoot = scratchRootSync("bachata-runtime-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "capability.pipeline.json"),
    JSON.stringify({
      version: 1,
      id: "capability-preflight",
      name: "Capability preflight",
      agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
      steps: [
        {
          id: "implementation",
          name: "Implementation",
          enabled: true,
          participants: ["codex"],
          promptTemplate: "{{userPrompt}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
          type: "agent",
          requiredCapabilities: ["repositoryTools"],
        },
      ],
    }),
  );
  const harness = loadRuntimeHarness({
    extensionRoot,
    adapterCapabilities: {
      codex: { repositoryTools: false },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        requestId: "preflight-run",
        prompt: "Keep this prompt in the composer",
        attachmentIds: [],
        delivery: "immediate",
      }),
      /Pipeline capability validation failed/u,
    );

    const state = harness.runtime.getState();
    assert.equal(state.workflowStatus, "idle");
    assert.equal(state.running, false);
    assert.equal(state.resumableWorkflow, undefined);
    assert.equal(state.pipelineMutable, true);
    assert.equal(harness.transcript.length, 0);
    assert.equal(harness.adapterControls.get("codex").sendCount, 0);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("a direct send cannot enter while a pipeline is resolving attachments", async () => {
  const resolveStarted = deferred();
  const releaseResolve = deferred();
  const harness = loadRuntimeHarness({
    resolvePaths: async () => {
      resolveStarted.resolve();
      await releaseResolve.promise;
      return { paths: [], dispose: async () => undefined };
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const run = harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "pipeline",
      attachmentIds: [],
    });
    await resolveStarted.promise;

    await assert.rejects(
      harness.runtime.handleMessage(sendMessage("direct")),
      /Pause or interrupt the pipeline/,
    );

    const interrupt = harness.runtime.handleMessage({ type: "run.interrupt" });
    releaseResolve.resolve();
    await Promise.all([run, interrupt]);
    assert.ok(
      Array.from(harness.adapterControls.values()).every(
        (control) => control.sendCount === 0,
      ),
    );
  } finally {
    releaseResolve.resolve();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("runtime disposal is idempotent and waits for foreground reservations", async () => {
  const resolveStarted = deferred();
  const releaseResolve = deferred();
  const harness = loadRuntimeHarness({
    resolvePaths: async () => {
      resolveStarted.resolve();
      await releaseResolve.promise;
      return { paths: [], dispose: async () => undefined };
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(sendMessage());
    await resolveStarted.promise;

    const firstDispose = harness.runtime.dispose();
    const secondDispose = harness.runtime.dispose();
    assert.equal(firstDispose, secondDispose);

    let disposed = false;
    firstDispose.then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(disposed, false);

    releaseResolve.resolve();
    await Promise.all([send, firstDispose]);
    assert.equal(disposed, true);
    await assert.rejects(
      harness.runtime.handleMessage({ type: "ready" }),
      /runtime is disposed/,
    );
  } finally {
    releaseResolve.resolve();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});


test("runtime disposal waits for initialization before releasing adapters", async () => {
  const bridgeStarted = deferred();
  const releaseBridge = deferred();
  const harness = loadRuntimeHarness({
    bridgeStart: async () => {
      bridgeStarted.resolve();
      await releaseBridge.promise;
    },
  });
  try {
    const dispose = harness.runtime.dispose();
    await bridgeStarted.promise;

    let disposed = false;
    dispose.then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(disposed, false);

    releaseBridge.resolve();
    await dispose;
    assert.equal(disposed, true);
    assert.ok(
      Array.from(harness.adapterControls.values()).every(
        (control) => control.disposeCount === 1,
      ),
    );
  } finally {
    releaseBridge.resolve();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});


test("browser action loop accepts a terminal continuation after the last action round", async () => {
  const extensionRoot = createSingleAgentPipelineRoot(browserActionPipelineDefinition());
  const responses = [
    createStructuredBrowserActionResponse(
      { kind: "workspace.read", path: "sample.ts" },
      "boundary-action-1",
    ),
    createNaturalBrowserResponse(
      "The requested file was read and the task is complete.",
      "boundary-final-1",
    ),
  ];
  const harness = loadRuntimeHarness({
    extensionRoot,
    configuration: {
      browserActionMaxRounds: 1,
      browserActionReadOnlyPolicy: "auto",
    },
    onAdapterSend: async ({ sendCount }) => ({
      answer: responses[sendCount - 1].text,
      capturedResponse: responses[sendCount - 1],
    }),
  });
  try {
    fs.writeFileSync(path.join(harness.workspaceDirectory, "sample.ts"), "export const sample = true;\n");
    await harness.runtime.handleMessage({ type: "ready" });
    const control = harness.adapterControls.get("chatgpt");
    control.release.resolve();

    await harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "Read sample.ts and finish.",
      attachmentIds: [],
    });

    assert.equal(control.sendCount, 2);
    assert.equal(harness.runtime.getState().workflowStatus, "completed");
    assert.equal(
      harness.transcript.some((entry) => entry.eventType === "browser.action.limit"),
      false,
    );
    assert.equal(
      harness.transcript.some(
        (entry) => entry.kind === "answer" && /task is complete/u.test(entry.text),
      ),
      true,
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("browser action loop fails when the terminal-only continuation requests another action", async () => {
  const extensionRoot = createSingleAgentPipelineRoot(browserActionPipelineDefinition());
  const responses = [
    createStructuredBrowserActionResponse(
      { kind: "workspace.read", path: "first.ts" },
      "boundary-action-2",
    ),
    createStructuredBrowserActionResponse(
      { kind: "workspace.read", path: "second.ts" },
      "boundary-overflow-2",
    ),
  ];
  const harness = loadRuntimeHarness({
    extensionRoot,
    configuration: {
      browserActionMaxRounds: 1,
      browserActionReadOnlyPolicy: "auto",
    },
    onAdapterSend: async ({ sendCount }) => ({
      answer: responses[sendCount - 1].text,
      capturedResponse: responses[sendCount - 1],
    }),
  });
  try {
    fs.writeFileSync(path.join(harness.workspaceDirectory, "first.ts"), "export const first = true;\n");
    fs.writeFileSync(path.join(harness.workspaceDirectory, "second.ts"), "export const second = true;\n");
    await harness.runtime.handleMessage({ type: "ready" });
    const control = harness.adapterControls.get("chatgpt");
    control.release.resolve();

    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        prompt: "Read both files.",
        attachmentIds: [],
      }),
      /round budget exhausted with unexecuted actions/u,
    );

    assert.equal(control.sendCount, 2);
    assert.equal(harness.runtime.getState().workflowStatus, "error");
    assert.equal(
      harness.transcript.some((entry) => entry.eventType === "browser.action.limit"),
      true,
    );
    assert.equal(
      harness.transcript.filter((entry) => entry.eventType === "browser.action.detected").length,
      1,
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("a pipeline can continue through its own human gate", async () => {
  const harness = loadRuntimeHarness();
  try {
    const webview = { postMessage: async () => true };
    const subscription = harness.runtime.attachWebview(webview);
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({
      type: "pipeline.select",
      pipelineId: "chatgpt-browser-spike",
    });
    const run = harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "pipeline",
      attachmentIds: [],
    });
    const control = harness.adapterControls.get("chatgpt");
    await control.started.promise;
    control.release.resolve();
    await waitFor(
      () => harness.runtime.getState().workflowStatus === "paused",
      "Pipeline did not reach its human gate",
    );
    await harness.runtime.handleMessage({
      type: "run.gate",
      action: "continue",
    });
    await run;
    assert.equal(harness.runtime.getState().workflowStatus, "completed");
    subscription.dispose();
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("pipeline import returns an unsaved draft without changing active pipelines", async () => {
  let importPath;
  const posted = [];
  const harness = loadRuntimeHarness({
    showOpenDialog: async () => [{ fsPath: importPath }],
  });
  try {
    const subscription = harness.runtime.attachWebview({
      postMessage: async (message) => {
        posted.push(message);
        return true;
      },
    });
    await harness.runtime.handleMessage({ type: "ready" });
    const imported = structuredClone(harness.runtime.getState().selectedPipelineDefinition);
    imported.id = "imported-draft";
    imported.name = "Imported draft";
    importPath = path.join(harness.workspaceDirectory, "imported-pipeline.json");
    fs.writeFileSync(importPath, JSON.stringify(imported));
    const selectedBefore = harness.runtime.getState().selectedPipelineId;
    const pipelineIdsBefore = harness.runtime.getState().pipelines.map((pipeline) => pipeline.id);

    await harness.runtime.handleMessage({
      type: "pipeline.import",
      requestId: "import-1",
    });

    const result = posted.find(
      (message) => message.type === "operation.result" && message.requestId === "import-1",
    );
    assert.equal(result.status, "completed");
    assert.equal(result.pipeline.id, "imported-draft");
    assert.equal(harness.runtime.getState().selectedPipelineId, selectedBefore);
    assert.deepEqual(
      harness.runtime.getState().pipelines.map((pipeline) => pipeline.id),
      pipelineIdsBefore,
    );
    assert.equal(
      fs.existsSync(path.join(harness.workspaceDirectory, ".bachata", "pipelines", "imported-draft.json")),
      false,
    );
    subscription.dispose();
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("duplicate approval responses are idempotent", async () => {
  const harness = loadRuntimeHarness();
  try {
    const subscription = harness.runtime.attachWebview({ postMessage: async () => true });
    await harness.runtime.handleMessage({ type: "ready" });
    const context = harness.adapterContexts.get("codex");
    const approval = context.requestCodexApproval("codex", {
      requestId: "approval-idempotent",
      kind: "command",
      method: "item/commandExecution/requestApproval",
      choices: [
        { id: "accept", label: "Accept" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    await waitFor(
      () => harness.runtime.getState().approvals.length === 1,
      "Approval was not published",
    );
    const response = {
      type: "approval.respond",
      agentId: "codex",
      requestId: "approval-idempotent",
      choiceId: "accept",
    };
    await harness.runtime.handleMessage(response);
    await harness.runtime.handleMessage(response);
    assert.equal(await approval, "accept");
    assert.equal(harness.runtime.getState().approvals.length, 0);
    assert.equal(
      harness.transcript.filter((entry) => entry.eventType === "approval.decided").length,
      1,
    );
    subscription.dispose();
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("task reset cancels an approval before requested-event persistence finishes", async () => {
  const appendStarted = deferred();
  const releaseAppend = deferred();
  const harness = loadRuntimeHarness({
    beforeTranscriptAppend: async (entry) => {
      if (entry.eventType === "approval.requested") {
        appendStarted.resolve();
        await releaseAppend.promise;
      }
    },
  });
  try {
    const subscription = harness.runtime.attachWebview({
      postMessage: async () => true,
    });
    await harness.runtime.handleMessage({ type: "ready" });
    const context = harness.adapterContexts.get("codex");
    const approval = context.requestCodexApproval("codex", {
      requestId: "approval-1",
      kind: "command",
      method: "item/commandExecution/requestApproval",
      choices: [
        { id: "accept", label: "Accept" },
        { id: "cancel", label: "Cancel" },
      ],
    });
    await appendStarted.promise;
    assert.equal(harness.runtime.getState().approvals.length, 1);

    const reset = harness.runtime.handleMessage({ type: "task.reset" });
    releaseAppend.resolve();
    assert.equal(await approval, "cancel");
    await reset;

    assert.equal(harness.runtime.getState().approvals.length, 0);
    assert.equal(harness.transcript.length, 0);
    subscription.dispose();
  } finally {
    releaseAppend.resolve();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("task reset prevents a replacement approval from publishing after cancellation persistence", async () => {
  const replacementAppendStarted = deferred();
  const releaseReplacementAppend = deferred();
  const harness = loadRuntimeHarness({
    beforeTranscriptAppend: async (entry) => {
      if (
        entry.eventType === "approval.cancelled" &&
        entry.text.includes("was replaced")
      ) {
        replacementAppendStarted.resolve();
        await releaseReplacementAppend.promise;
      }
    },
  });
  try {
    const subscription = harness.runtime.attachWebview({
      postMessage: async () => true,
    });
    await harness.runtime.handleMessage({ type: "ready" });
    const context = harness.adapterContexts.get("codex");
    const request = {
      requestId: "approval-replaced",
      kind: "command",
      method: "item/commandExecution/requestApproval",
      choices: [
        { id: "accept", label: "Accept" },
        { id: "cancel", label: "Cancel" },
      ],
    };
    const first = context.requestCodexApproval("codex", request);
    await waitFor(
      () =>
        harness.transcript.some(
          (entry) => entry.eventType === "approval.requested",
        ),
      "Initial approval was not persisted",
    );

    const replacement = context.requestCodexApproval("codex", request);
    assert.equal(await first, "cancel");
    await replacementAppendStarted.promise;

    const reset = harness.runtime.handleMessage({ type: "task.reset" });
    releaseReplacementAppend.resolve();
    assert.equal(await replacement, "cancel");
    await reset;

    assert.equal(harness.runtime.getState().approvals.length, 0);
    assert.equal(harness.transcript.length, 0);
    subscription.dispose();
  } finally {
    releaseReplacementAppend.resolve();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("an approval requested by an operation after task invalidation is cancelled immediately", async () => {
  let lateApprovalResult;
  const harness = loadRuntimeHarness({
    onAdapterSend: async ({ context, signal }) => {
      if (!signal.aborted) {
        await new Promise((resolve) => {
          signal.addEventListener("abort", resolve, { once: true });
        });
      }
      lateApprovalResult = await context.requestCodexApproval("codex", {
        requestId: "approval-after-reset",
        kind: "command",
        method: "item/commandExecution/requestApproval",
        choices: [
          { id: "accept", label: "Accept" },
          { id: "cancel", label: "Cancel" },
        ],
      });
    },
  });
  try {
    const subscription = harness.runtime.attachWebview({
      postMessage: async () => true,
    });
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(sendMessage("approval race"));
    await harness.adapterControls.get("codex").started.promise;

    const reset = harness.runtime.handleMessage({ type: "task.reset" });
    await Promise.all([send, reset]);

    assert.equal(lateApprovalResult, "cancel");
    assert.equal(harness.runtime.getState().approvals.length, 0);
    assert.equal(harness.transcript.length, 0);
    subscription.dispose();
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("one explicit user message is recorded before per-agent rendered prompts", async () => {
  const harness = loadRuntimeHarness();
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(
      sendMessage("Review this together", ["codex", "claude"]),
    );
    await Promise.all([
      harness.adapterControls.get("codex").started.promise,
      harness.adapterControls.get("claude").started.promise,
    ]);
    harness.adapterControls.get("codex").release.resolve();
    harness.adapterControls.get("claude").release.resolve();
    await send;

    const userMessages = harness.transcript.filter(
      (entry) => entry.eventType === "user.message",
    );
    const renderedPrompts = harness.transcript.filter(
      (entry) => entry.eventType === "agent.prompt",
    );
    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0].text, "Review this together");
    assert.deepEqual(
      renderedPrompts.map((entry) => entry.agentId).sort(),
      ["claude", "codex"],
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("conversation mode cannot change after the first explicit user message", async () => {
  const harness = loadRuntimeHarness();
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(sendMessage("Start the room"));
    await harness.adapterControls.get("codex").started.promise;
    harness.adapterControls.get("codex").release.resolve();
    await send;

    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.select",
        pipelineId: "chatgpt-browser-spike",
      }),
      /Start a new run or reset this run/,
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("provider-only browser assets can be revealed in their source tab", async () => {
  const revealed = [];
  const harness = loadRuntimeHarness({
    revealAsset: async (assetId) => {
      revealed.push(assetId);
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.transcript.push({
      id: "browser-response-provider-only",
      kind: "answer",
      agentId: "chatgpt",
      text: "I created the report.",
      eventType: "browser.response",
      createdAt: "2026-08-02T00:00:00.000Z",
      data: {
        assets: [
          {
            id: "asset-provider-only",
            provider: "chatgpt",
            kind: "generatedFile",
            name: "report.docx",
            sourceElement: "assistantMessage",
            downloadAvailable: false,
          },
        ],
      },
    });

    await harness.runtime.handleMessage({
      type: "browser.asset.reveal",
      assetId: "asset-provider-only",
    });

    assert.deepEqual(revealed, ["asset-provider-only"]);
    const event = harness.transcript.find(
      (entry) => entry.eventType === "browser.asset.revealed",
    );
    assert.equal(event.data.assetId, "asset-provider-only");
    assert.equal(event.data.downloadAvailable, false);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("browser assets are saved as verified files inside the run workspace", async () => {
  const bytes = Buffer.from("generated report\n", "utf8");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let destination;
  const harness = loadRuntimeHarness({
    showSaveDialog: async ({ workspaceDirectory }) => {
      destination = path.join(workspaceDirectory, "generated-report.txt");
      return { fsPath: destination };
    },
    fetchAsset: async function* (assetId, maxBytes, signal) {
      assert.equal(assetId, "asset-report");
      assert.ok(maxBytes >= bytes.length);
      assert.equal(signal.aborted, false);
      yield {
        type: "start",
        assetId,
        name: "generated-report.txt",
        mimeType: "text/plain",
        size: bytes.length,
      };
      yield { type: "chunk", assetId, sequence: 0, data: bytes };
      yield { type: "complete", assetId, size: bytes.length, sha256 };
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.transcript.push({
      id: "browser-response-with-asset",
      kind: "answer",
      agentId: "chatgpt",
      text: "I created the report.",
      eventType: "browser.response",
      createdAt: "2026-08-02T00:00:00.000Z",
      data: {
        assets: [
          {
            id: "asset-report",
            provider: "chatgpt",
            kind: "generatedFile",
            name: "generated-report.txt",
            mimeType: "text/plain",
            size: bytes.length,
            sourceElement: "assistantMessage",
            downloadAvailable: true,
          },
        ],
      },
    });

    await harness.runtime.handleMessage({
      type: "browser.asset.save",
      assetId: "asset-report",
    });

    assert.deepEqual(fs.readFileSync(destination), bytes);
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
    }
    const saved = harness.transcript.find(
      (entry) => entry.eventType === "browser.asset.saved",
    );
    assert.equal(saved.data.relativePath, "generated-report.txt");
    assert.equal(saved.data.sha256, sha256);
    assert.equal(saved.data.size, bytes.length);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("browser assets cannot be saved outside the run workspace", async () => {
  let fetchCount = 0;
  const outsideDirectory = scratchRootSync("bachata-runtime-outside-");
  const harness = loadRuntimeHarness({
    showSaveDialog: async () => ({
      fsPath: path.join(outsideDirectory, "escaped.txt"),
    }),
    fetchAsset: async function* () {
      fetchCount += 1;
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.transcript.push({
      id: "browser-response-outside",
      kind: "answer",
      agentId: "chatgpt",
      text: "Asset",
      eventType: "browser.response",
      createdAt: "2026-08-02T00:00:00.000Z",
      data: {
        assets: [
          {
            id: "asset-outside",
            provider: "chatgpt",
            kind: "generatedFile",
            name: "escaped.txt",
            sourceElement: "assistantMessage",
            downloadAvailable: true,
          },
        ],
      },
    });

    await assert.rejects(
      harness.runtime.handleMessage({
        type: "browser.asset.save",
        assetId: "asset-outside",
      }),
      /inside the run working directory/,
    );
    assert.equal(fetchCount, 0);
    assert.equal(fs.existsSync(path.join(outsideDirectory, "escaped.txt")), false);
  } finally {
    removeScratchSync(outsideDirectory);
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("browser asset default filenames are normalized and contained", async () => {
  let defaultPath;
  let fetchCount = 0;
  const harness = loadRuntimeHarness({
    showSaveDialog: async ({ dialogOptions }) => {
      defaultPath = dialogOptions.defaultUri.fsPath;
      return undefined;
    },
    fetchAsset: async function* () {
      fetchCount += 1;
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.transcript.push({
      id: "browser-response-unsafe-name",
      kind: "answer",
      agentId: "chatgpt",
      text: "Asset",
      eventType: "browser.response",
      createdAt: "2026-08-02T00:00:00.000Z",
      data: {
        assets: [
          {
            id: "asset-unsafe-name",
            provider: "chatgpt",
            kind: "generatedFile",
            name: `../../.${"x".repeat(240)}\\report.txt`,
            sourceElement: "assistantMessage",
            downloadAvailable: true,
          },
        ],
      },
    });

    await harness.runtime.handleMessage({
      type: "browser.asset.save",
      assetId: "asset-unsafe-name",
    });

    assert.equal(path.dirname(defaultPath), fs.realpathSync.native(harness.workspaceDirectory));
    assert.equal(path.basename(defaultPath).startsWith("."), false);
    assert.ok(path.basename(defaultPath).length <= 180);
    assert.doesNotMatch(path.basename(defaultPath), /[\\/:*?"<>|\u0000-\u001f\u007f]/u);
    assert.equal(fetchCount, 0);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("browser asset saving rejects a checksum mismatch and publishes no file", async () => {
  const bytes = Buffer.from("tampered report\n", "utf8");
  let destination;
  const harness = loadRuntimeHarness({
    showSaveDialog: async ({ workspaceDirectory }) => {
      destination = path.join(workspaceDirectory, "tampered-report.txt");
      return { fsPath: destination };
    },
    fetchAsset: async function* (assetId) {
      yield {
        type: "start",
        assetId,
        name: "tampered-report.txt",
        mimeType: "text/plain",
        size: bytes.length,
      };
      yield { type: "chunk", assetId, sequence: 0, data: bytes };
      yield {
        type: "complete",
        assetId,
        size: bytes.length,
        sha256: "0".repeat(64),
      };
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.transcript.push({
      id: "browser-response-bad-checksum",
      kind: "answer",
      agentId: "chatgpt",
      text: "I created the report.",
      eventType: "browser.response",
      createdAt: "2026-08-02T00:00:00.000Z",
      data: {
        assets: [
          {
            id: "asset-bad-checksum",
            provider: "chatgpt",
            kind: "generatedFile",
            name: "tampered-report.txt",
            mimeType: "text/plain",
            size: bytes.length,
            sourceElement: "assistantMessage",
            downloadAvailable: true,
          },
        ],
      },
    });

    await assert.rejects(
      harness.runtime.handleMessage({
        type: "browser.asset.save",
        assetId: "asset-bad-checksum",
      }),
      /checksum does not match/,
    );

    assert.equal(fs.existsSync(destination), false);
    assert.equal(
      harness.transcript.some(
        (entry) =>
          entry.eventType === "browser.asset.error" &&
          /checksum does not match/.test(entry.text),
      ),
      true,
    );
    assert.equal(
      fs.readdirSync(harness.workspaceDirectory).some((name) =>
        name.endsWith(".bachata-download"),
      ),
      false,
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("human-gate free text is delivered to Lead as a pipeline intervention", async () => {
  const extensionRoot = scratchRootSync("bachata-runtime-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "human-gate.pipeline.json"),
    JSON.stringify({
      version: 1,
      id: "human-gate-lead",
      name: "Human gate Lead",
      agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
      roles: [
        {
          id: "lead",
          name: "Lead",
          instructions: "Lead the task.",
        },
      ],
      steps: [
        {
          id: "assign",
          name: "Assign Lead",
          enabled: true,
          humanGate: "none",
          roleAssignments: [{ agentId: "codex", role: "lead" }],
          type: "assignRoles",
        },
        {
          id: "first",
          name: "First",
          enabled: true,
          participants: ["lead"],
          promptTemplate: "First turn",
          parallel: false,
          consensus: false,
          humanGate: "after",
          type: "agent",
        },
        {
          id: "second",
          name: "Second",
          enabled: true,
          participants: ["lead"],
          promptTemplate: "Instruction: {{interventionAnswer}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
          type: "agent",
        },
      ],
    }),
  );
  const interactions = [];
  const prompts = [];
  const harness = loadRuntimeHarness({
    extensionRoot,
    runtimeOptions: {
      requestInteraction: async (request) => {
        interactions.push(request);
        return {
          selected: ["continue"],
          freeText: "Keep the public API stable",
          source: "user",
        };
      },
    },
    onAdapterSend: async ({ request }) => {
      prompts.push(request.prompt);
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.adapterControls.get("codex").release.resolve();
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "Run the pipeline",
      attachmentIds: [],
    });

    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].allowFreeText, true);
    assert.match(interactions[0].prompt, /sent to Lead/u);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Keep the public API stable/u);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("human-gate free text is disabled when the pipeline has no Lead", async () => {
  const extensionRoot = scratchRootSync("bachata-runtime-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "human-gate.pipeline.json"),
    JSON.stringify({
      version: 1,
      id: "human-gate-no-lead",
      name: "Human gate without Lead",
      agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
      steps: [
        {
          id: "first",
          name: "First",
          enabled: true,
          participants: ["codex"],
          promptTemplate: "First turn",
          parallel: false,
          consensus: false,
          humanGate: "after",
          type: "agent",
        },
        {
          id: "second",
          name: "Second",
          enabled: true,
          participants: ["codex"],
          promptTemplate: "Instruction: {{interventionAnswer}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
          type: "agent",
        },
      ],
    }),
  );
  const interactions = [];
  const prompts = [];
  const harness = loadRuntimeHarness({
    extensionRoot,
    runtimeOptions: {
      requestInteraction: async (request) => {
        interactions.push(request);
        return {
          selected: ["continue"],
          freeText: "This must be ignored",
          source: "user",
        };
      },
    },
    onAdapterSend: async ({ request }) => {
      prompts.push(request.prompt);
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.adapterControls.get("codex").release.resolve();
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "Run the pipeline",
      attachmentIds: [],
    });

    assert.equal(interactions.length, 1);
    assert.equal(interactions[0].allowFreeText, false);
    assert.doesNotMatch(interactions[0].prompt, /sent to Lead/u);
    assert.equal(prompts.length, 2);
    assert.doesNotMatch(prompts[1], /This must be ignored/u);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("queued pipeline delivery preserves the requested iteration count for the manager executor", async () => {
  const executions = [];
  const accepted = [];
  const harness = loadRuntimeHarness({
    runtimeOptions: {
      executeQueuedPipeline: async (request, onAccepted) => {
        executions.push(structuredClone(request));
        const queuedBeforeAcceptance = harness.runtime.getState().queuedMessages;
        assert.equal(queuedBeforeAcceptance.length, 1);
        assert.equal(queuedBeforeAcceptance[0].id, request.queueMessageId);
        await onAccepted();
        assert.equal(harness.runtime.getState().queuedMessages.length, 1);
        assert.equal(
          harness.workspaceState.get("bachata.runtimeState.v5").queueStart?.messageId,
          request.queueMessageId,
        );
        accepted.push(request.iterationCount);
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      requestId: "queued-three-iterations",
      prompt: "Run three sequential passes",
      attachmentIds: [],
      iterationCount: 3,
      delivery: "queue",
    });

    assert.equal(executions.length, 1);
    assert.equal(typeof executions[0].queueMessageId, "string");
    assert.ok(executions[0].queueMessageId.length > 0);
    const selectedSnapshot = harness.runtime.getSelectedPipelineSnapshot();
    assert.equal(executions[0].pipelineId, selectedSnapshot.definition.id);
    assert.equal(executions[0].prompt, "Run three sequential passes");
    assert.deepEqual(executions[0].attachmentIds, []);
    assert.equal(executions[0].iterationCount, 3);
    assert.equal(executions[0].pipelineSnapshot.hash, selectedSnapshot.hash);
    assert.equal(
      executions[0].pipelineSnapshot.definition.id,
      selectedSnapshot.definition.id,
    );
    assert.deepEqual(accepted, [3]);
    assert.equal(harness.runtime.getState().queuedMessages.length, 0);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("native availability checks respect the configured local-process limit", async () => {
  let activeLocalChecks = 0;
  let maximumActiveLocalChecks = 0;
  const checkedLocalAgents = [];
  const harness = loadRuntimeHarness({
    configuration: { maxConcurrentLocalAgents: 1 },
    onCheckAvailability: async ({ agentId, adapterType }) => {
      if (adapterType !== "codex-app-server" && adapterType !== "claude-code") {
        return "browser-mock";
      }
      checkedLocalAgents.push(agentId);
      activeLocalChecks += 1;
      maximumActiveLocalChecks = Math.max(maximumActiveLocalChecks, activeLocalChecks);
      await new Promise((resolve) => setTimeout(resolve, 20));
      activeLocalChecks -= 1;
      return "local-mock";
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({ type: "availability.check" });
    assert.deepEqual(checkedLocalAgents.sort(), ["claude", "codex"]);
    assert.equal(maximumActiveLocalChecks, 1);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("failed custom-pipeline saves do not enter runtime state", async () => {
  const harness = loadRuntimeHarness();
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const pipeline = structuredClone(harness.runtime.getState().selectedPipelineDefinition);
    pipeline.id = "failed-new-save";
    pipeline.name = "Failed new save";
    const target = path.join(
      harness.workspaceDirectory,
      ".bachata",
      "pipelines",
      `${pipeline.id}.pipeline.json`,
    );
    fs.mkdirSync(target, { recursive: true });

    await assert.rejects(
      createCustomPipeline(
        harness.runtime,
        pipeline,
        "failed-new-save",
      ),
    );
    assert.equal(
      harness.runtime.getState().pipelines.some((item) => item.id === pipeline.id),
      false,
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("failed custom-pipeline overwrites retain the last persisted definition", async () => {
  const harness = loadRuntimeHarness();
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const pipeline = structuredClone(harness.runtime.getState().selectedPipelineDefinition);
    pipeline.id = "transactional-overwrite";
    pipeline.name = "Persisted name";
    await createCustomPipeline(harness.runtime, pipeline, "save-original");
    const target = path.join(
      harness.workspaceDirectory,
      ".bachata",
      "pipelines",
      `${pipeline.id}.pipeline.json`,
    );
    fs.rmSync(target, { force: true });
    fs.mkdirSync(target);
    const changed = structuredClone(pipeline);
    changed.name = "Unpersisted name";

    await assert.rejects(
      updateCustomPipeline(
        harness.runtime,
        changed,
        "save-overwrite",
      ),
    );
    assert.equal(harness.runtime.getState().selectedPipelineDefinition.name, "Persisted name");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("failed custom-pipeline deletes retain runtime state", async () => {
  let failDelete = false;
  const harness = loadRuntimeHarness({
    runtimeOptions: {
      withWorkspaceMutation: async (operation) => {
        if (failDelete) {
          throw new Error("pipeline delete persistence failed");
        }
        return operation();
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const pipeline = structuredClone(harness.runtime.getState().selectedPipelineDefinition);
    pipeline.id = "transactional-delete";
    pipeline.name = "Transactional delete";
    await createCustomPipeline(harness.runtime, pipeline, "save-before-delete");
    failDelete = true;

    await assert.rejects(
      deleteCustomPipeline(
        harness.runtime,
        pipeline.id,
        "failed-delete",
      ),
      /pipeline delete persistence failed/,
    );
    failDelete = false;
    assert.equal(
      harness.runtime.getState().pipelines.some((item) => item.id === pipeline.id),
      true,
    );
    assert.equal(harness.runtime.getState().selectedPipelineId, pipeline.id);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("pipeline mutation remains blocked when the user message is outside the recent transcript window", async () => {
  const initialTranscript = Array.from({ length: 51 }, (_, index) => ({
    id: `rollover-${String(index)}`,
    timestamp: new Date(1_700_000_000_000 + index).toISOString(),
    kind: index === 0 ? "prompt" : "event",
    text: index === 0 ? "Original user request" : `status ${String(index)}`,
    ...(index === 0 ? { eventType: "user.message" } : { eventType: "run.status" }),
  }));
  const harness = loadRuntimeHarness({
    configuration: { transcriptWindowSize: 50 },
    initialTranscript,
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(
      harness.runtime.getState().transcript.some((entry) => entry.eventType === "user.message"),
      false,
    );
    assert.equal(harness.runtime.getState().pipelineMutable, false);
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.select",
        pipelineId: "chatgpt-browser-spike",
      }),
      /Start a new run or reset this run/,
    );
    assert.equal(harness.transcript.length, 51);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("persisted task work and queued requests independently block pipeline mutation", async () => {
  const queued = queuedPipelineState();
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [queued],
        queuePaused: true,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(harness.runtime.getState().pipelineMutable, false);
    assert.equal(harness.runtime.getState().queuedMessages.length, 1);
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.select",
        pipelineId: "chatgpt-browser-spike",
      }),
      /Start a new run or reset this run/,
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("task reset restores transcript, attachments, and task identity after late storage failure", async () => {
  const entry = {
    id: "reset-history",
    timestamp: new Date().toISOString(),
    kind: "prompt",
    text: "Keep this request",
    eventType: "user.message",
  };
  const attachment = {
    id: "reset-attachment",
    name: "evidence.png",
    mimeType: "image/png",
    size: 1,
    relativePath: "attachments/reset-attachment.png",
  };
  let clearAttempts = 0;
  let restoreAttempts = 0;
  const harness = loadRuntimeHarness({
    initialTranscript: [entry],
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [attachment],
        queuedMessages: [],
        queuePaused: false,
      },
    },
    clearAttachments: async () => {
      clearAttempts += 1;
      throw new Error("attachment cleanup failed");
    },
    restoreAttachments: async () => {
      restoreAttempts += 1;
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const taskId = harness.runtime.getState().taskId;
    await assert.rejects(
      harness.runtime.handleMessage({ type: "task.reset" }),
      /attachment cleanup failed/,
    );
    assert.equal(clearAttempts, 1);
    assert.equal(restoreAttempts, 1);
    assert.equal(harness.runtime.getState().taskId, taskId);
    assert.equal(harness.runtime.getState().attachments.length, 1);
    assert.equal(harness.runtime.getState().transcript.length, 1);
    assert.equal(harness.transcript.length, 1);
    assert.equal(harness.transcript[0].text, "Keep this request");
    assert.equal(harness.runtime.getState().pipelineMutable, false);
    const originalControls = harness.adapterControlHistory.slice(0, 2);
    const candidateControls = harness.adapterControlHistory.slice(2);
    assert.ok(originalControls.every((control) => control.resetCount === 0));
    assert.ok(originalControls.every((control) => control.disposeCount === 0));
    assert.ok(candidateControls.length > 0);
    assert.ok(candidateControls.every((control) => control.disposeCount === 1));
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("session reset stages a complete replacement topology before committing", async () => {
  let failCandidate = false;
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: false,
        agents: {
          codex: { version: "codex-v1", sessionId: "codex-session" },
          claude: { version: "claude-v1", sessionId: "claude-session" },
        },
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
    onAdapterCreate: ({ definition }) => {
      if (failCandidate && definition.id === "claude") {
        throw new Error("session reset candidate failed");
      }
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const originalControls = harness.adapterControlHistory.slice();
    const previousState = structuredClone(harness.runtime.getState().agents);
    failCandidate = true;

    await assert.rejects(
      harness.runtime.handleMessage({ type: "session.reset", agentId: "codex" }),
      /session reset candidate failed/,
    );

    assert.deepEqual(harness.runtime.getState().agents, previousState);
    assert.ok(originalControls.every((control) => control.disposeCount === 0));
    assert.ok(originalControls.every((control) => control.resetCount === 0));
    const candidateControls = harness.adapterControlHistory.slice(originalControls.length);
    assert.equal(candidateControls.length, 1);
    assert.equal(candidateControls[0].disposeCount, 1);
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persisted.agents.codex.sessionId, "codex-session");
    assert.equal(persisted.agents.claude.sessionId, "claude-session");
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("targeted session reset preserves non-target session state and output", async () => {
  const claudeAnswer = {
    id: "claude-answer-before-reset",
    timestamp: new Date().toISOString(),
    kind: "answer",
    agentId: "claude",
    text: "Preserve this output",
  };
  const harness = loadRuntimeHarness({
    initialTranscript: [claudeAnswer],
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {
          codex: { version: "codex-v1", sessionId: "codex-session" },
          claude: { version: "claude-v1", sessionId: "claude-session" },
        },
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const originalControls = harness.adapterControlHistory.slice();

    await harness.runtime.handleMessage({ type: "session.reset", agentId: "codex" });

    const agents = harness.runtime.getState().agents;
    assert.equal(agents.codex.sessionId, undefined);
    assert.equal(agents.codex.output, "");
    assert.equal(agents.codex.status, "available");
    assert.equal(agents.claude.sessionId, "claude-session");
    assert.equal(agents.claude.output, "Preserve this output");
    assert.ok(originalControls.every((control) => control.disposeCount === 1));
    assert.ok(originalControls.every((control) => control.resetCount === 0));
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persisted.agents.codex.sessionId, undefined);
    assert.equal(persisted.agents.claude.sessionId, "claude-session");
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("working directory reset prepares replacement adapters for the target directory", async () => {
  const entry = {
    id: "working-directory-history",
    timestamp: new Date().toISOString(),
    kind: "prompt",
    text: "Keep the directory change destructive",
    eventType: "user.message",
  };
  const harness = loadRuntimeHarness({
    initialTranscript: [entry],
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const originalControls = harness.adapterControlHistory.slice();
    const targetDirectory = path.join(harness.workspaceDirectory, "nested");
    fs.mkdirSync(targetDirectory);

    await harness.runtime.configure({ workingDirectory: targetDirectory });

    const canonicalTarget = fs.realpathSync.native(targetDirectory);
    assert.equal(harness.runtime.getState().workingDirectory, canonicalTarget);
    assert.equal(harness.adapterContexts.get("codex").environment.PWD, canonicalTarget);
    assert.equal(harness.adapterContexts.get("claude").environment.PWD, canonicalTarget);
    assert.ok(originalControls.every((control) => control.resetCount === 0));
    assert.ok(originalControls.every((control) => control.disposeCount === 1));
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("history-preserving directory change stages replacement adapters before committing", async () => {
  const entry = {
    id: "preserved-directory-history",
    timestamp: new Date().toISOString(),
    kind: "prompt",
    text: "Keep this history",
    eventType: "user.message",
  };
  const harness = loadRuntimeHarness({
    initialTranscript: [entry],
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const originalControls = harness.adapterControlHistory.slice();
    const targetDirectory = path.join(harness.workspaceDirectory, "preserved-target");
    fs.mkdirSync(targetDirectory);

    await harness.runtime.configure({
      workingDirectory: targetDirectory,
      preserveHistory: true,
    });

    const canonicalTarget = fs.realpathSync.native(targetDirectory);
    assert.equal(harness.runtime.getState().workingDirectory, canonicalTarget);
    assert.equal(harness.runtime.getState().transcript[0].text, entry.text);
    assert.equal(harness.transcript[0].text, entry.text);
    assert.equal(harness.adapterContexts.get("codex").environment.PWD, canonicalTarget);
    assert.equal(harness.adapterContexts.get("claude").environment.PWD, canonicalTarget);
    assert.ok(originalControls.every((control) => control.resetCount === 0));
    assert.ok(originalControls.every((control) => control.disposeCount === 1));
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persisted.workingDirectory, canonicalTarget);
    assert.equal(persisted.taskDirty, true);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("failed history-preserving directory preparation retains the prior topology and directory", async () => {
  const entry = {
    id: "preserved-directory-failure",
    timestamp: new Date().toISOString(),
    kind: "prompt",
    text: "Retain this history",
    eventType: "user.message",
  };
  let failCandidate = false;
  const harness = loadRuntimeHarness({
    initialTranscript: [entry],
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
    onAdapterCreate: ({ definition }) => {
      if (failCandidate && definition.id === "claude") {
        throw new Error("preserved directory candidate failed");
      }
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const previousDirectory = harness.runtime.getState().workingDirectory;
    const originalControls = harness.adapterControlHistory.slice();
    const targetDirectory = path.join(harness.workspaceDirectory, "failed-target");
    fs.mkdirSync(targetDirectory);
    failCandidate = true;

    await assert.rejects(
      harness.runtime.configure({
        workingDirectory: targetDirectory,
        preserveHistory: true,
      }),
      /preserved directory candidate failed/,
    );

    assert.equal(harness.runtime.getState().workingDirectory, previousDirectory);
    assert.equal(harness.runtime.getState().transcript[0].text, entry.text);
    assert.ok(originalControls.every((control) => control.resetCount === 0));
    assert.ok(originalControls.every((control) => control.disposeCount === 0));
    const candidateControls = harness.adapterControlHistory.slice(originalControls.length);
    assert.equal(candidateControls.length, 1);
    assert.equal(candidateControls[0].disposeCount, 1);
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persisted.workingDirectory, previousDirectory);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("partial adapter preparation is disposed without replacing the active topology", async () => {
  let failCandidate = false;
  const harness = loadRuntimeHarness({
    onAdapterCreate: ({ definition }) => {
      if (failCandidate && definition.id === "claude") {
        throw new Error("candidate adapter failed");
      }
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const originalPipelineId = harness.runtime.getState().selectedPipelineId;
    const originalCodex = harness.adapterControls.get("codex");
    const originalClaude = harness.adapterControls.get("claude");
    const pipeline = structuredClone(harness.runtime.getState().selectedPipelineDefinition);
    pipeline.id = "partial-adapter-failure";
    pipeline.name = "Partial adapter failure";
    failCandidate = true;

    await assert.rejects(
      createCustomPipeline(
        harness.runtime,
        pipeline,
        "partial-adapter-failure",
      ),
      /candidate adapter failed/,
    );

    assert.equal(harness.runtime.getState().selectedPipelineId, originalPipelineId);
    assert.equal(
      harness.runtime.getState().pipelines.some((item) => item.id === pipeline.id),
      false,
    );
    assert.equal(originalCodex.disposeCount, 0);
    assert.equal(originalClaude.disposeCount, 0);
    const candidateCodex = harness.adapterControlHistory.at(-1);
    assert.notEqual(candidateCodex, originalCodex);
    assert.equal(candidateCodex.agentId, "codex");
    assert.equal(candidateCodex.disposeCount, 1);

    const send = harness.runtime.handleMessage(sendMessage("Old topology still works"));
    await originalCodex.started.promise;
    originalCodex.release.resolve();
    await send;
    assert.equal(originalCodex.sendCount, 1);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("pipeline selection restores history and topology when state persistence fails", async () => {
  let failSelection = false;
  const harness = loadRuntimeHarness({
    beforeWorkspaceStateUpdate: async ({ value }) => {
      if (
        failSelection &&
        value?.selectedPipelineId === "chatgpt-browser-spike"
      ) {
        failSelection = false;
        throw new Error("selection persistence failed");
      }
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const originalPipelineId = harness.runtime.getState().selectedPipelineId;
    const originalControls = Array.from(harness.adapterControls.values());
    failSelection = true;

    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.select",
        pipelineId: "chatgpt-browser-spike",
      }),
      /selection persistence failed/,
    );

    assert.equal(harness.runtime.getState().selectedPipelineId, originalPipelineId);
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").selectedPipelineId,
      originalPipelineId,
    );
    assert.ok(originalControls.every((control) => control.disposeCount === 0));
    const candidateControls = harness.adapterControlHistory.filter(
      (control) => !originalControls.includes(control),
    );
    assert.ok(candidateControls.length > 0);
    assert.ok(candidateControls.every((control) => control.disposeCount === 1));
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("pipeline save removes its file and catalog entry when activation persistence fails", async () => {
  let failed = false;
  const pipelineId = "activation-persistence-failure";
  const harness = loadRuntimeHarness({
    beforeWorkspaceStateUpdate: async ({ value }) => {
      if (!failed && value?.selectedPipelineId === pipelineId) {
        failed = true;
        throw new Error("activation state failed");
      }
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const originalPipelineId = harness.runtime.getState().selectedPipelineId;
    const pipeline = structuredClone(harness.runtime.getState().selectedPipelineDefinition);
    pipeline.id = pipelineId;
    pipeline.name = "Activation persistence failure";
    const target = path.join(
      harness.workspaceDirectory,
      ".bachata",
      "pipelines",
      `${pipeline.id}.pipeline.json`,
    );

    await assert.rejects(
      createCustomPipeline(
        harness.runtime,
        pipeline,
        "activation-persistence-failure",
      ),
      /activation state failed/,
    );

    assert.equal(fs.existsSync(target), false);
    assert.equal(harness.runtime.getState().selectedPipelineId, originalPipelineId);
    assert.equal(
      harness.runtime.getState().pipelines.some((item) => item.id === pipeline.id),
      false,
    );
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").selectedPipelineId,
      originalPipelineId,
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("selected pipeline deletion restores its file, state, and topology after a late fenced-write failure", async () => {
  let mutationCount = 0;
  let failDeleteCommit = false;
  const harness = loadRuntimeHarness({
    runtimeOptions: {
      withWorkspaceMutation: async (operation) => {
        const value = await operation();
        if (failDeleteCommit) {
          mutationCount += 1;
          if (mutationCount === 2) {
            failDeleteCommit = false;
            throw new Error("late delete fence failure");
          }
        }
        return value;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const pipeline = structuredClone(harness.runtime.getState().selectedPipelineDefinition);
    pipeline.id = "late-delete-rollback";
    pipeline.name = "Late delete rollback";
    await createCustomPipeline(
      harness.runtime,
      pipeline,
      "save-late-delete-rollback",
    );
    const target = path.join(
      harness.workspaceDirectory,
      ".bachata",
      "pipelines",
      `${pipeline.id}.pipeline.json`,
    );
    assert.equal(fs.existsSync(target), true);

    mutationCount = 0;
    failDeleteCommit = true;
    await assert.rejects(
      deleteCustomPipeline(
        harness.runtime,
        pipeline.id,
        "late-delete-rollback",
      ),
      /late delete fence failure/,
    );

    assert.equal(fs.existsSync(target), true);
    assert.equal(harness.runtime.getState().selectedPipelineId, pipeline.id);
    assert.equal(
      harness.runtime.getState().pipelines.some((item) => item.id === pipeline.id),
      true,
    );
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").selectedPipelineId,
      pipeline.id,
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("independent runtimes reject one concurrent update to the same physical pipeline catalog", async () => {
  const workspaceRoot = scratchRootSync("bachata-cross-host-catalog-");
  const first = loadRuntimeHarness({ workspaceDirectories: [workspaceRoot] });
  const second = loadRuntimeHarness({ workspaceDirectories: [workspaceRoot] });
  try {
    await first.runtime.handleMessage({ type: "ready" });
    const original = customPipelineDefinition("physical-shared", "Original");
    await createCustomPipeline(first.runtime, original, "create-physical-shared");
    await second.runtime.handleMessage({ type: "ready" });
    await second.runtime.handleMessage({
      type: "pipeline.select",
      pipelineId: original.id,
    });
    const firstHash = pipelineHash(first.runtime, original.id);
    const secondHash = pipelineHash(second.runtime, original.id);
    assert.equal(firstHash, secondHash);
    const updates = [
      first.runtime.handleMessage({
        type: "pipeline.save",
        requestId: "physical-update-a",
        mode: "update",
        scopeKey: first.runtime.getState().pipelineScopeKey,
        sourcePipelineId: original.id,
        expectedHash: firstHash,
        pipeline: { ...original, name: "Updated by A" },
      }),
      second.runtime.handleMessage({
        type: "pipeline.save",
        requestId: "physical-update-b",
        mode: "update",
        scopeKey: second.runtime.getState().pipelineScopeKey,
        sourcePipelineId: original.id,
        expectedHash: secondHash,
        pipeline: { ...original, name: "Updated by B" },
      }),
    ];
    const settled = await Promise.allSettled(updates);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    const rejection = settled.find((result) => result.status === "rejected");
    assert.match(String(rejection.reason), /changed in another run|changed on disk/u);
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(workspaceRoot, ".bachata", "pipelines", `${original.id}.pipeline.json`),
        "utf8",
      ),
    );
    assert.ok(["Updated by A", "Updated by B"].includes(stored.name));
  } finally {
    first.adapterControls.forEach((control) => control.release.resolve());
    second.adapterControls.forEach((control) => control.release.resolve());
    await Promise.allSettled([first.runtime.dispose(), second.runtime.dispose()]);
    first.cleanup();
    second.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

test("pipeline updates reject an external edit made before catalog commit", async () => {
  const workspaceRoot = scratchRootSync("bachata-external-catalog-edit-");
  const original = customPipelineDefinition("external-edit", "Original");
  const target = writeCustomPipeline(workspaceRoot, original);
  let injectExternalEdit = false;
  const harness = loadRuntimeHarness({
    workspaceDirectories: [workspaceRoot],
    runtimeOptions: {
      withPipelineCatalogMutation: async (_catalogDirectory, operation) => {
        if (injectExternalEdit) {
          injectExternalEdit = false;
          fs.writeFileSync(
            target,
            `${JSON.stringify({ ...original, name: "External edit" }, null, 2)}\n`,
          );
        }
        return operation();
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({
      type: "pipeline.select",
      pipelineId: original.id,
    });
    injectExternalEdit = true;
    await assert.rejects(
      updateCustomPipeline(
        harness.runtime,
        { ...original, name: "Editor update" },
        "update-after-external-edit",
      ),
      /changed in another run|changed on disk/u,
    );
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).name, "External edit");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

test("multi-root runtime keeps a symlinked workspace root in its canonical pipeline scope", async () => {
  const realRoot = scratchRootSync("bachata-runtime-real-root-");
  const linkParent = scratchRootSync("bachata-runtime-link-parent-");
  const secondRoot = scratchRootSync("bachata-runtime-second-root-");
  const linkedRoot = path.join(linkParent, "linked-root");
  fs.symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  const pipeline = customPipelineDefinition("linked-pipeline", "Linked pipeline");
  writeCustomPipeline(realRoot, pipeline);
  const harness = loadRuntimeHarness({
    workspaceDirectories: [linkedRoot, secondRoot],
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(
      harness.runtime.getState().pipelines.some((item) => item.id === pipeline.id),
      true,
    );
    assert.equal(harness.runtime.getState().pipelineScopeRoot, path.resolve(linkedRoot));
    await harness.runtime.configure({ workingDirectory: linkedRoot });
    assert.equal(harness.runtime.getState().pipelineScopeRoot, path.resolve(linkedRoot));
    assert.equal(
      harness.runtime.getState().pipelines.some((item) => item.id === pipeline.id),
      true,
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await Promise.resolve(harness.runtime.dispose()).catch(() => undefined);
    harness.cleanup();
    removeScratchSync(linkParent);
    removeScratchSync(realRoot);
    removeScratchSync(secondRoot);
  }
});

test("runtime refuses a workspace pipeline catalog redirected outside its root", async () => {
  const workspaceRoot = scratchRootSync("bachata-runtime-safe-root-");
  const externalRoot = scratchRootSync("bachata-runtime-unsafe-target-");
  fs.symlinkSync(externalRoot, path.join(workspaceRoot, ".bachata"), process.platform === "win32" ? "junction" : "dir");
  const harness = loadRuntimeHarness({ workspaceDirectories: [workspaceRoot] });
  try {
    await assert.rejects(
      harness.runtime.handleMessage({ type: "ready" }),
      /resolves outside workspace root/u,
    );
    assert.equal(fs.existsSync(path.join(externalRoot, "pipelines")), false);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await Promise.resolve(harness.runtime.dispose()).catch(() => undefined);
    harness.cleanup();
    removeScratchSync(workspaceRoot);
    removeScratchSync(externalRoot);
  }
});

test("invalid duplicate pipeline files block the custom catalog until the collision is resolved", async () => {
  const workspaceRoot = scratchRootSync("bachata-invalid-catalog-");
  const definition = customPipelineDefinition("duplicate-definition", "Duplicate definition");
  const directory = path.join(workspaceRoot, ".bachata", "pipelines");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${definition.id}.pipeline.json`),
    `${JSON.stringify(definition, null, 2)}\n`,
  );
  const duplicatePath = path.join(directory, "copied.pipeline.json");
  fs.writeFileSync(duplicatePath, `${JSON.stringify(definition, null, 2)}\n`);
  const harness = loadRuntimeHarness({ workspaceDirectories: [workspaceRoot] });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const blocked = harness.runtime.getState();
    assert.equal(blocked.pipelines.some((item) => item.id === definition.id), false);
    assert.equal(blocked.pipelineMutable, false);
    assert.match(blocked.pipelineMutationReason, /must be named|catalog is invalid/u);
    fs.rmSync(duplicatePath);
    const symbolicPath = path.join(directory, "symbolic.pipeline.json");
    fs.symlinkSync(
      path.join(directory, `${definition.id}.pipeline.json`),
      symbolicPath,
      process.platform === "win32" ? "file" : undefined,
    );
    await harness.runtime.refreshPipelines();
    assert.equal(
      harness.runtime.getState().pipelines.some((item) => item.id === definition.id),
      false,
    );
    assert.match(harness.runtime.getState().pipelineMutationReason, /not a regular file/u);
    fs.rmSync(symbolicPath);
    await harness.runtime.refreshPipelines();
    const recovered = harness.runtime.getState();
    assert.equal(recovered.pipelines.some((item) => item.id === definition.id), true);
    assert.equal(recovered.pipelineMutable, true);
    await deleteCustomPipeline(harness.runtime, definition.id, "delete-recovered-pipeline");
    await harness.runtime.refreshPipelines();
    assert.equal(
      harness.runtime.getState().pipelines.some((item) => item.id === definition.id),
      false,
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

test("current-catalog preflight rejects a custom pipeline changed outside the runtime", async () => {
  const workspaceRoot = scratchRootSync("bachata-stale-run-catalog-");
  const definition = customPipelineDefinition("stale-before-run", "Original");
  const target = writeCustomPipeline(workspaceRoot, definition);
  const harness = loadRuntimeHarness({ workspaceDirectories: [workspaceRoot] });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({ type: "pipeline.select", pipelineId: definition.id });
    const snapshot = harness.runtime.getSelectedPipelineSnapshot();
    fs.writeFileSync(
      target,
      `${JSON.stringify({ ...definition, name: "Changed externally" }, null, 2)}\n`,
    );
    await assert.rejects(
      harness.runtime.preflightPipeline("Run", [], snapshot, {
        requireCurrentCatalog: true,
      }),
      /changed on disk|changed since it was selected/u,
    );
    assert.equal(harness.adapterControls.get("codex").sendCount, 0);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

test("checklist parent preflight rejects a missing task pipeline before provider work", async () => {
  const workspaceRoot = scratchRootSync("bachata-missing-task-pipeline-");
  const parent = checklistExecutionPipeline(
    "missing-task-parent",
    "Missing task parent",
    "missing-task-pipeline",
  );
  const harness = loadRuntimeHarness({
    workspaceDirectories: [workspaceRoot],
    runtimeOptions: {
      preflightChecklistExecution: async () => undefined,
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await createCustomPipeline(harness.runtime, parent, "create-missing-task-parent");
    await assert.rejects(
      harness.runtime.preflightPipeline("Review then execute", [], undefined, {
        requireCurrentCatalog: true,
      }),
      /references missing task pipeline missing-task-pipeline/u,
    );
    assert.equal(harness.adapterControls.get("codex").sendCount, 0);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

test("accepted checklist work retains the exact task pipeline after catalog edits and deletion", async () => {
  const workspaceRoot = scratchRootSync("bachata-frozen-task-pipeline-");
  const taskPipeline = customPipelineDefinition(
    "frozen-task-pipeline",
    "Frozen task pipeline",
    "Original task instructions: {{userPrompt}}",
  );
  const parent = checklistExecutionPipeline(
    "frozen-task-parent",
    "Frozen task parent",
    taskPipeline.id,
  );
  const harness = loadRuntimeHarness({
    workspaceDirectories: [workspaceRoot],
    runtimeOptions: {
      preflightChecklistExecution: async () => undefined,
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await createCustomPipeline(harness.runtime, taskPipeline, "create-frozen-task");
    await createCustomPipeline(harness.runtime, parent, "create-frozen-parent");
    const accepted = await harness.runtime.preflightPipeline(
      "Review then execute",
      [],
      undefined,
      { requireCurrentCatalog: true },
    );
    assert.equal(
      accepted.dependencies[taskPipeline.id].definition.steps[0].promptTemplate,
      "Original task instructions: {{userPrompt}}",
    );

    const taskPipelinePath = path.join(
      workspaceRoot,
      ".bachata",
      "pipelines",
      `${taskPipeline.id}.pipeline.json`,
    );
    fs.writeFileSync(
      taskPipelinePath,
      `${JSON.stringify({
        ...taskPipeline,
        name: "Changed task pipeline",
        steps: [{
          ...taskPipeline.steps[0],
          promptTemplate: "Changed task instructions: {{userPrompt}}",
        }],
      }, null, 2)}\n`,
    );
    fs.rmSync(taskPipelinePath);

    const revalidated = await harness.runtime.preflightPipeline(
      "Review then execute",
      [],
      accepted,
      { requireCurrentCatalog: false },
    );
    assert.deepEqual(revalidated, accepted);
    assert.equal(
      revalidated.dependencies[taskPipeline.id].definition.steps[0].promptTemplate,
      "Original task instructions: {{userPrompt}}",
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

test("checklist parent preflight rejects nested checklist task pipelines before provider work", async () => {
  const workspaceRoot = scratchRootSync("bachata-nested-task-pipeline-");
  const nested = checklistExecutionPipeline(
    "nested-task-pipeline",
    "Nested task pipeline",
    "todo-implementation",
  );
  const parent = checklistExecutionPipeline(
    "nested-task-parent",
    "Nested task parent",
    nested.id,
  );
  const harness = loadRuntimeHarness({
    workspaceDirectories: [workspaceRoot],
    runtimeOptions: {
      preflightChecklistExecution: async () => undefined,
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await createCustomPipeline(harness.runtime, nested, "create-nested-task");
    await createCustomPipeline(harness.runtime, parent, "create-nested-parent");
    await assert.rejects(
      harness.runtime.preflightPipeline("Review then execute", [], undefined, {
        requireCurrentCatalog: true,
      }),
      /cannot contain executeChecklist steps/u,
    );
    assert.equal(harness.adapterControls.get("codex").sendCount, 0);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

test("removing the selected workspace root clears its catalog and blocks multi-root execution", async () => {
  const firstRoot = scratchRootSync("bachata-removed-root-first-");
  const secondRoot = scratchRootSync("bachata-removed-root-second-");
  const thirdRoot = scratchRootSync("bachata-removed-root-third-");
  const pipeline = customPipelineDefinition("removed-root-pipeline", "Removed root pipeline");
  const harness = loadRuntimeHarness({
    workspaceDirectories: [firstRoot, secondRoot, thirdRoot],
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.configure({ workingDirectory: firstRoot });
    await createCustomPipeline(harness.runtime, pipeline, "create-removed-root-pipeline");
    assert.equal(harness.runtime.getState().selectedPipelineId, pipeline.id);
    assert.equal(harness.runtime.getState().pipelineScopeRoot, path.resolve(firstRoot));

    harness.setWorkspaceDirectories([secondRoot, thirdRoot]);
    await waitFor(
      () => {
        const state = harness.runtime.getState();
        return state.workingDirectory === undefined &&
          state.workspaceRoots.length === 2 &&
          state.pipelineScopeRoot === undefined &&
          state.selectedPipelineId === "review-only";
      },
      "removed workspace scope was not invalidated",
    );

    const state = harness.runtime.getState();
    assert.equal(state.pipelines.some((item) => item.id === pipeline.id), false);
    assert.match(state.pipelineScopeKey, /^extension:/u);
    await harness.runtime.flush();
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(persisted.workingDirectory, undefined);
    assert.equal(persisted.selectedPipelineSnapshot.scopeRoot, undefined);
    assert.equal(persisted.selectedPipelineSnapshot.definition.id, "review-only");
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        requestId: "run-after-root-removal",
        prompt: "Do not run against an implicit root",
        attachmentIds: [],
        delivery: "immediate",
      }),
      /Select a working directory before starting a session in a multi-root workspace/u,
    );
    assert.equal(harness.adapterControls.get("codex").sendCount, 0);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    [firstRoot, secondRoot, thirdRoot].forEach((root) => {
      removeScratchSync(root);
    });
  }
});

test("checklist Git preflight runs before provider work and receives only the active custom catalog", async () => {
  const workspaceRoot = scratchRootSync("bachata-checklist-preflight-");
  const pipeline = {
    ...customPipelineDefinition("custom-execution", "Custom execution"),
    steps: [
      {
        id: "prepare",
        name: "Prepare",
        enabled: true,
        participants: ["codex"],
        promptTemplate: "{{userPrompt}}",
        humanGate: "none",
        type: "checklist",
        outputName: "executionChecklist",
      },
      {
        id: "execute",
        name: "Execute",
        enabled: true,
        humanGate: "none",
        type: "executeChecklist",
        inputName: "executionChecklist",
        pipelineId: "todo-implementation",
        checks: [],
        allowNoChecks: true,
        allowedPaths: ["."],
        retries: 1,
        maxConcurrency: 1,
      },
    ],
  };
  const preflightRequests = [];
  const harness = loadRuntimeHarness({
    workspaceDirectories: [workspaceRoot],
    runtimeOptions: {
      preflightChecklistExecution: async (request) => {
        preflightRequests.push(request);
        throw new Error("repository preflight blocked");
      },
      executeChecklist: async () => {
        throw new Error("checklist execution must not start after preflight failure");
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await createCustomPipeline(harness.runtime, pipeline, "create-custom-execution");
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        requestId: "preflight-custom-execution",
        prompt: "Review then execute",
        attachmentIds: [],
        delivery: "immediate",
      }),
      /repository preflight blocked/u,
    );
    assert.equal(preflightRequests.length, 1);
    assert.deepEqual(preflightRequests[0], {
      workingDirectory: fs.realpathSync.native(workspaceRoot),
      allowedDirtyPaths: [
        path.join(fs.realpathSync.native(workspaceRoot), ".bachata", "pipelines"),
      ],
    });
    assert.equal(harness.adapterControls.get("codex").sendCount, 0);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(workspaceRoot);
  }
});

const managedBrowserPipelineDefinition = () => ({
  version: 1,
  id: "cross-reference-development",
  name: "Managed browser worker",
  agents: [{ id: "chatgpt", name: "ChatGPT", adapter: "chatgpt-browser" }],
  managedPolicy: {
    writeScope: "workspace",
    commitMode: "never",
    allowedPaths: [],
    maxRevisionCycles: 1,
    verificationChecks: [],
  },
  roles: [
    {
      id: "worker",
      name: "Worker",
      instructions: "Implement the task.",
      requiredCapabilities: ["browserSessionSelection", "passiveActionLoop"],
      preferredAdapters: ["chatgpt-browser"],
      managed: true,
      managedRole: "worker",
      readOnly: false,
      commitMode: "never",
    },
  ],
  steps: [
    {
      id: "assign-roles",
      name: "Assign worker",
      enabled: true,
      humanGate: "none",
      roleAssignments: [{ agentId: "chatgpt", role: "worker" }],
      type: "assignRoles",
    },
    {
      id: "worker-turn",
      name: "Worker turn",
      enabled: true,
      participants: ["worker"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
      humanGate: "none",
      attachments: "none",
      type: "agent",
    },
  ],
});

test("managed conversation rollover opens a fresh role conversation and rehydrates controller state", async () => {
  const extensionRoot = createSingleAgentPipelineRoot(managedBrowserPipelineDefinition());
  const first = createBrowserSession("managed-session", "Managed");
  let freshCount = 0;
  const tracked = createTrackedBridge([first], {
    onOpenConversation: ({ fresh }) => {
      freshCount += 1;
      return createBrowserSession(`fresh-session-${String(freshCount)}`, `Fresh ${String(freshCount)}`);
    },
  });
  const oversized = "z".repeat(300 * 1024);
  const prompts = [];
  const harness = loadRuntimeHarness({
    extensionRoot,
    configuration: {
      browserManagedConversationMaxBytes: 1,
      browserActionMaxRounds: 3,
    },
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: false,
        agents: {
          chatgpt: {
            version: "browser-mock",
            sessionId: first.id,
            browserBinding: {
              provider: first.provider,
              conversationUrl: first.conversationUrl,
              conversationIdentity: first.conversationIdentity,
              preferredTabId: first.tabId,
            },
          },
        },
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
    runtimeOptions: { bridge: tracked.bridge, startBridge: false },
    onAdapterSend: async ({ sendCount, request }) => {
      prompts.push(request.prompt);
      const text = sendCount === 1 ? oversized : "still not a control envelope";
      return {
        answer: text,
        capturedResponse: createNaturalBrowserResponse(text, `managed-${String(sendCount)}`),
      };
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    harness.adapterControls.get("chatgpt")?.release.resolve();

    await harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "Do the managed task.",
      attachmentIds: [],
    }).catch(() => undefined);

    const rollovers = harness.transcript.filter(
      (entry) => entry.eventType === "browser.managed.conversationRollover",
    );
    assert.equal(rollovers.length, 1, "the oversized first turn must trigger exactly one rollover");

    const freshOpens = tracked.opened.filter((call) => call.fresh === true);
    assert.ok(freshOpens.length >= 2, "the managed turn and the rollover must each open a fresh conversation");
    assert.ok(
      tracked.bindings.size > 0,
      "the rollover must bind the runtime to the newly opened conversation",
    );

    const continuation = prompts[1];
    assert.ok(continuation, "a continuation prompt must be sent after the rollover");
    assert.match(
      continuation,
      /Bachata opened a fresh role conversation because the previous managed conversation reached its cumulative context budget/u,
      "the fresh conversation must receive the rehydration notice",
    );
    assert.ok(
      continuation.indexOf("Bachata opened a fresh role conversation")
        < continuation.indexOf("valid final bachata-control object"),
      "authoritative controller state must precede the pending continuation",
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("composer authorization is re-checked after preflight refreshes policy and acknowledgement", async () => {
  const harness = loadRuntimeHarness({ enforceContractAcknowledgement: true });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({
      type: "pipeline.select",
      requestId: "select-managed",
      pipelineId: "managed-fix",
    });
    const contract = harness.runtime.getState().contractAcknowledgement;
    assert.equal(
      contract?.acknowledgementRequired,
      true,
      "this harness pipeline does not require acknowledgement, so the test proves nothing",
    );

    await assert.rejects(
      harness.runtime.preflightPipeline("do the work", [], undefined, { composerAuthorized: true }),
      /acknowledge this run's execution contract/u,
      "preflight accepted a composer run whose contract was never acknowledged",
    );

    await harness.runtime.preflightPipeline("do the work", []);

    await harness.acknowledgeCurrentContract();
    await harness.runtime.preflightPipeline("do the work", [], undefined, { composerAuthorized: true });
  } finally {
    harness.cleanup();
  }
});

test("a queued composer run carries its origin and is reauthorized when it is dequeued", async () => {
  const dequeued = [];
  const harness = loadRuntimeHarness({
    enforceContractAcknowledgement: true,
    runtimeOptions: {
      executeQueuedPipeline: async (request, onAccepted) => {
        dequeued.push(request);
        await onAccepted();
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({
      type: "pipeline.select",
      requestId: "select-managed",
      pipelineId: "managed-fix",
    });
    await harness.acknowledgeCurrentContract();
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      requestId: "queued-1",
      prompt: "queue this",
      attachmentIds: [],
      iterationCount: 1,
      delivery: "queue",
    });
    assert.equal(dequeued.length, 1, "the queued composer run was never dequeued");
    assert.equal(
      dequeued[0].composerAuthorized,
      true,
      "a dequeued composer run does not carry its origin, so execution-time preflight skips reauthorization",
    );
  } finally {
    harness.cleanup();
  }
});

test("a persisted queued composer run keeps its origin, and one without an origin is blocked", async () => {
  const authorized = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        taskDirty: false,
        queuedMessages: [queuedPipelineState("queued-authorized")],
      },
    },
  });
  try {
    await authorized.runtime.handleMessage({ type: "ready" });
    const restored = authorized.runtime.getState().queuedMessages[0];
    assert.ok(restored, "the queued request did not survive a restart");
    assert.equal(
      restored.composerAuthorized,
      true,
      "a restored composer run lost its origin, so it can never be reauthorized",
    );
    assert.equal(restored.blockedReason, undefined);
  } finally {
    authorized.cleanup();
  }

  const legacyEntry = queuedPipelineState("queued-legacy");
  delete legacyEntry.composerAuthorized;
  const legacy = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        taskDirty: false,
        queuedMessages: [legacyEntry],
      },
    },
  });
  try {
    await legacy.runtime.handleMessage({ type: "ready" });
    const restored = legacy.runtime.getState().queuedMessages[0];
    assert.ok(restored);
    assert.equal(restored.composerAuthorized, undefined);
    assert.match(
      restored.blockedReason ?? "",
      /predates recorded run authorization/u,
      "a queued run with unknown origin was left runnable",
    );
  } finally {
    legacy.cleanup();
  }
});

const snapshotHarness = (options = {}) => {
  const disposals = [];
  const harness = loadRuntimeHarness({
    ...options,
    resolvePaths: async () => {
      const record = { attempts: 0 };
      disposals.push(record);
      return {
        paths: options.snapshotPaths ?? [],
        dispose: async () => {
          record.attempts += 1;
          if (options.disposeFailure) throw new Error(options.disposeFailure);
        },
      };
    },
  });
  return { harness, disposals };
};

const attemptCounts = (disposals) => disposals.map((record) => record.attempts);

test("a completed direct send removes the attachment snapshot it created", async () => {
  const { harness, disposals } = snapshotHarness({ snapshotPaths: ["/snapshot/one.png"] });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(sendMessage());
    await harness.adapterControls.get("codex").started.promise;
    harness.adapterControls.get("codex").release.resolve();
    await send;
    assert.deepEqual(attemptCounts(disposals), [1], "the direct send left its plaintext snapshot");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a failed direct send removes the attachment snapshot it created", async () => {
  const { harness, disposals } = snapshotHarness({
    snapshotPaths: ["/snapshot/one.png"],
    onAdapterSend: async () => {
      throw new Error("adapter refused this send");
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage(sendMessage()).catch(() => undefined);
    assert.deepEqual(attemptCounts(disposals), [1], "a failed direct send left its plaintext snapshot");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a direct send whose snapshot cannot be removed retries once and reports it", async () => {
  const { harness, disposals } = snapshotHarness({
    snapshotPaths: ["/snapshot/one.png"],
    disposeFailure: "snapshot is busy",
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const send = harness.runtime.handleMessage(sendMessage());
    await harness.adapterControls.get("codex").started.promise;
    harness.adapterControls.get("codex").release.resolve();
    await assert.rejects(send, /Attachment snapshot for this direct message could not be removed/u);
    assert.deepEqual(attemptCounts(disposals), [2], "the failed removal was never retried");
    assert.equal(harness.runtime.getState().agents.codex.status, "idle");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

const capabilityPipelineRoot = () => {
  const extensionRoot = scratchRootSync("bachata-runtime-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "capability.pipeline.json"),
    JSON.stringify({
      version: 1,
      id: "capability-preflight",
      name: "Capability preflight",
      agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
      steps: [
        {
          id: "implementation",
          name: "Implementation",
          enabled: true,
          participants: ["codex"],
          promptTemplate: "{{userPrompt}}",
          parallel: false,
          consensus: false,
          humanGate: "none",
          type: "agent",
          requiredCapabilities: ["repositoryTools"],
        },
      ],
    }),
  );
  return extensionRoot;
};

test("a pipeline refused by capability validation removes the snapshot preflight created", async () => {
  const extensionRoot = capabilityPipelineRoot();
  const { harness, disposals } = snapshotHarness({
    extensionRoot,
    snapshotPaths: ["/snapshot/one.png"],
    adapterCapabilities: { codex: { repositoryTools: false } },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        requestId: "capability-refusal",
        prompt: "Refuse this run",
        attachmentIds: [],
        delivery: "immediate",
      }),
      /Pipeline capability validation failed/u,
    );
    assert.deepEqual(
      attemptCounts(disposals),
      [1],
      "a capability refusal left the plaintext snapshot preflight created",
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

const checklistPipelineRoot = () => {
  const extensionRoot = scratchRootSync("bachata-runtime-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.copyFileSync(
    path.resolve(__dirname, "../presets/todo-implementation.pipeline.json"),
    path.join(extensionRoot, "presets", "todo-implementation.pipeline.json"),
  );
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "checklist.pipeline.json"),
    JSON.stringify({
      version: 1,
      id: "checklist-preflight",
      name: "Checklist preflight",
      agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
      steps: [
        {
          id: "plan",
          name: "Plan",
          enabled: true,
          type: "checklist",
          participants: ["codex"],
          promptTemplate: "{{userPrompt}}",
          outputName: "executionChecklist",
          humanGate: "none",
        },
        {
          id: "execute",
          name: "Execute the checklist",
          enabled: true,
          type: "executeChecklist",
          humanGate: "none",
          inputName: "executionChecklist",
          pipelineId: "todo-implementation",
          allowedPaths: ["src"],
          checks: ["bachata:workspace-integrity"],
          retries: 0,
          maxConcurrency: 1,
        },
      ],
    }),
  );
  return extensionRoot;
};

test("a pipeline refused by the checklist preflight removes the snapshot preflight created", async () => {
  const extensionRoot = checklistPipelineRoot();
  const { harness, disposals } = snapshotHarness({
    extensionRoot,
    snapshotPaths: ["/snapshot/one.png"],
    runtimeOptions: {
      preflightChecklistExecution: async () => {
        throw new Error("the workspace is not clean enough to execute a checklist");
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        requestId: "checklist-refusal",
        prompt: "Refuse this run",
        attachmentIds: [],
        delivery: "immediate",
      }),
      /the workspace is not clean enough to execute a checklist/u,
    );
    assert.deepEqual(
      attemptCounts(disposals),
      [1],
      "a checklist refusal left the plaintext snapshot preflight created",
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("an interrupted pipeline run removes the attachment snapshot it created", async () => {
  const { harness, disposals } = snapshotHarness({ snapshotPaths: ["/snapshot/one.png"] });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const run = harness.runtime.handleMessage({
      type: "pipeline.run",
      requestId: "interrupted-run",
      prompt: "Interrupt this run",
      attachmentIds: [],
      delivery: "immediate",
    });
    await harness.adapterControlHistory[0].started.promise;
    const interrupt = harness.runtime.handleMessage({ type: "run.interrupt" });
    await Promise.all([run, interrupt]);
    assert.deepEqual(
      attemptCounts(disposals),
      [1],
      "an interrupted pipeline run left its plaintext snapshot",
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a programmatic preflight removes the snapshot it created before returning", async () => {
  const { harness, disposals } = snapshotHarness({ snapshotPaths: ["/snapshot/one.png"] });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const snapshot = await harness.runtime.preflightPipeline("programmatic prompt", []);
    assert.equal(typeof snapshot.hash, "string");
    assert.deepEqual(
      attemptCounts(disposals),
      [1],
      "a programmatic preflight left the plaintext snapshot it created",
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a programmatic preflight whose snapshot cannot be removed refuses to return a snapshot", async () => {
  const { harness, disposals } = snapshotHarness({
    snapshotPaths: ["/snapshot/one.png"],
    disposeFailure: "snapshot is busy",
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await assert.rejects(
      harness.runtime.preflightPipeline("programmatic prompt", []),
      /Attachment snapshot for this preflight could not be removed/u,
    );
    assert.deepEqual(attemptCounts(disposals), [2], "the failed removal was never retried");
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

const recordedRunSettings = () => ({
  schema: "bachata.run-settings.v1",
  values: { agentTurnTimeoutMs: 111_000, maxPipelineIterations: 7, defaultPipelineIterations: 1 },
  authority: { disabledProviders: [] },
  secretReferences: [],
});

test("a resumed run executes on the settings it recorded, not on settings changed since", async () => {
  const definition = singleAgentPipelineDefinition();
  const selectedPipelineSnapshot = createPipelineSnapshot(definition, "builtin");
  const recovery = singleAgentRecoveryState(undefined, definition);
  recovery.runSettings = recordedRunSettings();
  const harness = loadRuntimeHarness({
    configuration: { agentTurnTimeoutMs: 222_000, maxPipelineIterations: 3 },
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: definition.id,
        selectedPipelineSnapshot,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow: recovery,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(harness.runtime.getState().executionContract.limits.maxIterations, 3);
    const resume = harness.runtime.resumePipeline();
    await waitFor(
      () => harness.runtime.getState().executionContract?.provenance?.runSettings
        ?.values.agentTurnTimeoutMs === 111_000,
      "the resumed run never published its recorded settings",
    );
    const contract = harness.runtime.getState().executionContract;
    assert.equal(contract.provenance.runSettings.values.agentTurnTimeoutMs, 111_000);
    assert.equal(contract.limits.agentTurnTimeoutMs, 111_000);
    assert.equal(contract.limits.maxIterations, 7);
    harness.adapterControls.get("codex").release.resolve();
    await resume;
    assert.equal(harness.runtime.getState().running, false);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a fresh run records the settings it started with and never records a secret", async () => {
  const definition = singleAgentPipelineDefinition();
  const selectedPipelineSnapshot = createPipelineSnapshot(definition, "builtin");
  const harness = loadRuntimeHarness({
    configuration: {
      agentTurnTimeoutMs: 222_000,
      todoCheckEnvironmentVariables: ["BACHATA_TEST_TOKEN"],
    },
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: definition.id,
        selectedPipelineSnapshot,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow: singleAgentRecoveryState(undefined, definition),
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const resume = harness.runtime.resumePipeline();
    await waitFor(
      () => harness.runtime.getState().executionContract?.provenance?.runSettings
        ?.recorded.todoCheckEnvironmentVariables?.length === 1,
      "the run never published its settings",
    );
    const snapshot = harness.runtime.getState().executionContract.provenance.runSettings;
    assert.equal(snapshot.values.agentTurnTimeoutMs, 222_000);
    assert.deepEqual(snapshot.recorded.todoCheckEnvironmentVariables, ["BACHATA_TEST_TOKEN"]);
    assert.equal(snapshot.secretReferences.includes("todoCheckEnvironmentVariables"), true);
    assert.equal(
      Object.prototype.hasOwnProperty.call(snapshot.values, "disabledProviders"),
      false,
      "an authority control must not be pinned into a run",
    );
    harness.adapterControls.get("codex").release.resolve();
    await resume;
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a Codex workflow is blocked until whole-working-directory reads are accepted", async () => {
  const harness = loadRuntimeHarness({
    configuration: { codexCommand: path.join(__dirname, "fixtures", "mock-codex.cjs") },
    onCommandCheck: ({ command, args }) => {
      if (command === "git" && args[0] === "--version") return "git version 2.39.5";
      if (command === "git" && args[0] === "status") return "";
      return `${command} mock-1.0.0`;
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const report = await harness.runtime.inspectReadiness(["codex-review"]);
    assert.equal(report.adapters.find((adapter) => adapter.type === "codex-app-server").available, true);
    assert.equal(report.pipelines[0].status, "blocked");
    assert.equal(
      report.pipelines[0].findings.find((finding) => finding.status === "blocked").remediationId,
      "provider.readScope",
    );
    assert.equal(report.codexWorkspaceScope, "refuseNarrowedScope");
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a disabled provider makes its workflow unsupported and refuses the turn", async () => {
  const harness = loadRuntimeHarness({
    configuration: {
      codexCommand: path.join(__dirname, "fixtures", "mock-codex.cjs"),
      codexWorkspaceScope: "wholeWorkingDirectory",
      disabledProviders: ["codex-app-server"],
    },
    onCommandCheck: ({ command, args }) => {
      if (command === "git" && args[0] === "--version") return "git version 2.39.5";
      if (command === "git" && args[0] === "status") return "";
      return `${command} mock-1.0.0`;
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const report = await harness.runtime.inspectReadiness(["codex-review"]);
    assert.equal(report.pipelines[0].status, "unsupported");
    assert.deepEqual(report.disabledProviders, ["codex-app-server"]);
    await harness.runtime.configure({ pipelineId: "codex-review" });
    await assert.rejects(
      harness.runtime.runPipeline("do the work"),
      /disabled in bachata\.disabledProviders/u,
    );
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a recorded snapshot restores pinned values only and never records another run's authority", async () => {
  const definition = singleAgentPipelineDefinition();
  const selectedPipelineSnapshot = createPipelineSnapshot(definition, "builtin");
  const forged = {
    schema: "bachata.run-settings.v1",
    values: { agentTurnTimeoutMs: 111_000 },
    recorded: { todoFile: "ATTACKER.md" },
    authority: {
      disabledProviders: ["claude-code"],
      codexCommand: "/tmp/attacker",
      browserActionDestructivePolicy: "auto",
    },
    secretReferences: ["somethingElse"],
  };
  const harness = loadRuntimeHarness({
    configuration: { agentTurnTimeoutMs: 222_000, todoFile: "TODO.md" },
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: definition.id,
        selectedPipelineSnapshot,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow: {
          ...singleAgentRecoveryState(undefined, definition),
          runSettings: forged,
        },
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const resume = harness.runtime.resumePipeline();
    await waitFor(
      () => harness.runtime.getState().executionContract?.provenance?.runSettings
        ?.values.agentTurnTimeoutMs === 111_000,
      "the resumed run never published its recorded settings",
    );
    const snapshot = harness.runtime.getState().executionContract.provenance.runSettings;
    assert.equal(snapshot.values.agentTurnTimeoutMs, 111_000, "a pinned value is restored");
    assert.deepEqual(
      snapshot.authority.disabledProviders,
      [],
      "authority is rebuilt from live settings, never carried in from a snapshot",
    );
    assert.equal(snapshot.authority.codexCommand, "codex");
    assert.equal(snapshot.authority.browserActionDestructivePolicy, "ask");
    assert.equal(
      snapshot.recorded.todoFile,
      "TODO.md",
      "recorded-only settings describe this run, not the one the snapshot came from",
    );
    assert.equal(snapshot.secretReferences.includes("somethingElse"), false);
    harness.adapterControls.get("codex").release.resolve();
    await resume;
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a persisted snapshot Bachata cannot fully apply says so instead of resuming in silence", async () => {
  const definition = singleAgentPipelineDefinition();
  const selectedPipelineSnapshot = createPipelineSnapshot(definition, "builtin");
  const damaged = {
    schema: "bachata.run-settings.v1",
    values: { agentTurnTimeoutMs: 111_000, browserSelectorHealingBackend: "attacker-backend" },
    recorded: {},
    authority: {},
    secretReferences: [],
  };
  const harness = loadRuntimeHarness({
    configuration: { agentTurnTimeoutMs: 222_000 },
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: definition.id,
        selectedPipelineSnapshot,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow: {
          ...singleAgentRecoveryState(undefined, definition),
          runSettings: damaged,
        },
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const resume = harness.runtime.resumePipeline();
    await waitFor(
      () => harness.runtime.getState().transcript.some(
        (entry) => entry.eventType === "workflow.settingsRejected"),
      "the resume never disclosed the values it could not apply",
    );
    const disclosure = harness.runtime.getState().transcript.find(
      (entry) => entry.eventType === "workflow.settingsRejected");
    assert.match(disclosure.text, /browserSelectorHealingBackend .*not one of auto/u);
    assert.match(disclosure.text, /maxPipelineIterations is missing/u);
    assert.match(disclosure.text, /used the current value instead/u);
    const snapshot = harness.runtime.getState().executionContract.provenance.runSettings;
    assert.equal(snapshot.values.agentTurnTimeoutMs, 111_000, "a value it could apply is applied");
    assert.equal(
      snapshot.values.browserSelectorHealingBackend,
      "auto",
      "a value it refused falls back to the live one",
    );
    harness.adapterControls.get("codex").release.resolve();
    await resume;
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a live authority change during a run is published, while pinned values stay put", async () => {
  const definition = singleAgentPipelineDefinition();
  const selectedPipelineSnapshot = createPipelineSnapshot(definition, "builtin");
  const harness = loadRuntimeHarness({
    configuration: {
      agentTurnTimeoutMs: 222_000,
      disabledProviders: [],
      codexCommand: path.join(__dirname, "fixtures", "mock-codex.cjs"),
      codexWorkspaceScope: "wholeWorkingDirectory",
    },
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: definition.id,
        selectedPipelineSnapshot,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow: {
          ...singleAgentRecoveryState(undefined, definition),
          runSettings: recordedRunSettings(),
        },
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const resume = harness.runtime.resumePipeline();
    await waitFor(
      () => harness.runtime.getState().executionContract?.provenance?.runSettings
        ?.values.agentTurnTimeoutMs === 111_000,
      "the resumed run never published its recorded settings",
    );
    assert.deepEqual(
      harness.runtime.getState().executionContract.provenance.runSettings.authority.disabledProviders,
      [],
    );

    harness.configuration.set("disabledProviders", ["claude-code"]);
    await harness.runtime.inspectReadiness([definition.id]);
    const republished = harness.runtime.getState().executionContract.provenance.runSettings;
    assert.deepEqual(
      republished.authority.disabledProviders,
      ["claude-code"],
      "an authority control the human changed mid-run must be published as it now stands",
    );
    assert.equal(
      republished.values.agentTurnTimeoutMs,
      111_000,
      "a pinned value must not move when authority is refreshed",
    );
    harness.adapterControls.get("codex").release.resolve();
    await resume;
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("the browser asset save dialog names only a validated linked source origin", async () => {
  const titles = new Map();
  let fetchCount = 0;
  let pending;
  const harness = loadRuntimeHarness({
    showSaveDialog: async ({ dialogOptions }) => {
      titles.set(pending, dialogOptions.title);
      return undefined;
    },
    fetchAsset: async function* () {
      fetchCount += 1;
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const asset = (id, overrides) => ({
      id,
      provider: "chatgpt",
      kind: "generatedFile",
      name: "report.txt",
      sourceElement: "assistantMessage",
      downloadAvailable: true,
      ...overrides,
    });
    harness.transcript.push({
      id: "browser-response-origins",
      kind: "answer",
      agentId: "chatgpt",
      text: "I created the report.",
      eventType: "browser.response",
      createdAt: "2026-08-02T00:00:00.000Z",
      data: {
        assets: [
          asset("asset-linked", { sourceOrigin: "https://cdn.example.invalid:8443" }),
          asset("asset-no-origin"),
          asset("asset-full-url", {
            sourceOrigin: "https://cdn.example.invalid/download/report.txt?token=secret#part",
          }),
        ],
      },
    });

    for (const assetId of ["asset-linked", "asset-no-origin"]) {
      pending = assetId;
      await harness.runtime.handleMessage({ type: "browser.asset.save", assetId });
    }

    // A stored record whose origin is not a canonical HTTP(S) origin fails the same field
    // rules the wire parser applies, so it is not a captured asset at all: the save is
    // refused rather than offered without the origin it could not validate.
    pending = "asset-full-url";
    await assert.rejects(
      harness.runtime.handleMessage({ type: "browser.asset.save", assetId: "asset-full-url" }),
      /not present in the transcript/u,
    );

    assert.equal(
      titles.get("asset-linked"),
      "Save browser asset linked from https://cdn.example.invalid:8443",
    );
    assert.equal(titles.get("asset-no-origin"), undefined);
    assert.equal(titles.has("asset-full-url"), false);
    assert.equal(fetchCount, 0);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

// Absent-key regressions. Every optional runtime-state field below has two distinct cleared
// shapes — the key removed, and the key present holding undefined — and structuredClone,
// object spread, Object.keys and the persisted patch merges all tell them apart. JSON.stringify
// does not, so nothing here compares serialized text.
const CLEARED_RUN_KEYS = ["activeStep", "activeStepId", "consensusRound", "pendingGate"];

const assertAbsentKeys = (record, keys, label) => {
  keys.forEach((key) => {
    assert.equal(
      Object.hasOwn(record, key),
      false,
      `${label} carries ${key} as an own property instead of dropping it`,
    );
  });
};

test("an idle runtime drops every cleared optional state key instead of holding undefined", async () => {
  const harness = loadRuntimeHarness();
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const state = harness.runtime.getState();
    assertAbsentKeys(
      state,
      [...CLEARED_RUN_KEYS, "transcriptError", "pipelineMutationReason"],
      "the idle runtime state",
    );
    assert.equal(state.pipelineMutable, true);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("pipelineMutationReason is a real key only while the pipeline is locked", async () => {
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const locked = harness.runtime.getState();
    assert.equal(locked.pipelineMutable, false);
    assert.equal(Object.hasOwn(locked, "pipelineMutationReason"), true);
    assert.equal(typeof locked.pipelineMutationReason, "string");

    await harness.runtime.handleMessage({ type: "task.reset" });
    const cleared = harness.runtime.getState();
    assert.equal(cleared.pipelineMutable, true);
    assert.equal(Object.hasOwn(cleared, "pipelineMutationReason"), false);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a task reset drops a native agent sessionId rather than assigning undefined", async () => {
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: { codex: { version: "mock-1.0.0", sessionId: "stale-session" } },
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(harness.runtime.getState().agents.codex.sessionId, "stale-session");

    await harness.runtime.handleMessage({ type: "task.reset" });
    const reset = harness.runtime.getState();
    const agent = reset.agents.codex;
    assert.equal(Object.hasOwn(agent, "sessionId"), false);
    assert.equal(Object.hasOwn(agent, "error"), false);
    assertAbsentKeys(reset, ["transcriptError", "resumableWorkflow"], "the reset runtime state");

    await harness.runtime.flush();
    const persistedAgent = harness.workspaceState.get("bachata.runtimeState.v5").agents.codex;
    assert.equal(Object.hasOwn(persistedAgent, "sessionId"), false);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a human gate publishes pendingGate as a key and removes it when the run ends", async () => {
  const extensionRoot = scratchRootSync("bachata-runtime-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "absent-key-gate.pipeline.json"),
    JSON.stringify({
      version: 1,
      id: "absent-key-gate",
      name: "Absent key gate",
      agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
      roles: [{ id: "lead", name: "Lead", instructions: "Lead the task." }],
      steps: [
        {
          id: "assign",
          name: "Assign Lead",
          enabled: true,
          humanGate: "none",
          roleAssignments: [{ agentId: "codex", role: "lead" }],
          type: "assignRoles",
        },
        {
          id: "gated",
          name: "Gated",
          enabled: true,
          participants: ["lead"],
          promptTemplate: "One turn",
          parallel: false,
          consensus: false,
          humanGate: "after",
          type: "agent",
        },
      ],
    }),
  );
  const duringGate = [];
  const runPatches = [];
  const harness = loadRuntimeHarness({
    extensionRoot,
    runtimeOptions: {
      requestInteraction: async () => {
        duringGate.push(harness.runtime.getState());
        return { selected: ["continue"], freeText: "", source: "user" };
      },
    },
  });
  const subscription = harness.runtime.attachWebview({
    postMessage: async (message) => {
      if (message.type === "run.patch") runPatches.push(message);
      return true;
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.adapterControls.get("codex").release.resolve();
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "Run to the gate",
      attachmentIds: [],
    });

    assert.equal(duringGate.length, 1);
    const gated = duringGate[0];
    assert.equal(Object.hasOwn(gated, "pendingGate"), true);
    assert.equal(Object.hasOwn(gated, "activeStep"), true);
    assert.equal(Object.hasOwn(gated, "activeStepId"), true);
    // The gated step is not a consensus round, so the field must never be created at all.
    assert.equal(Object.hasOwn(gated, "consensusRound"), false);

    const finished = harness.runtime.getState();
    assertAbsentKeys(finished, CLEARED_RUN_KEYS, "the finished runtime state");

    // Snapshots are published as structuredClone(state), which keeps an own key holding
    // undefined but drops an absent one, so the cloned finished state is the snapshot shape.
    assertAbsentKeys(structuredClone(finished), CLEARED_RUN_KEYS, "the published snapshot shape");
    assert.ok(
      runPatches.some((patch) => Object.hasOwn(patch, "pendingGate")),
      "no run patch carried pendingGate as an own property",
    );
    const lastPatch = runPatches[runPatches.length - 1];
    assert.ok(lastPatch, "no run patch was published");
    assertAbsentKeys(lastPatch, CLEARED_RUN_KEYS, "the final run patch");
  } finally {
    subscription.dispose();
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("a removed workspace root leaves no workingDirectory or pipelineScopeRoot key behind", async () => {
  const firstRoot = scratchRootSync("bachata-absent-key-first-");
  const secondRoot = scratchRootSync("bachata-absent-key-second-");
  const thirdRoot = scratchRootSync("bachata-absent-key-third-");
  const pipeline = customPipelineDefinition("absent-key-pipeline", "Absent key pipeline");
  const harness = loadRuntimeHarness({
    workspaceDirectories: [firstRoot, secondRoot, thirdRoot],
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.configure({ workingDirectory: firstRoot });
    await createCustomPipeline(harness.runtime, pipeline, "create-absent-key-pipeline");
    const selected = harness.runtime.getState();
    assert.equal(Object.hasOwn(selected, "workingDirectory"), true);
    assert.equal(Object.hasOwn(selected, "pipelineScopeRoot"), true);
    assert.equal(Object.hasOwn(selected, "selectedPipelineHash"), true);

    harness.setWorkspaceDirectories([secondRoot, thirdRoot]);
    await waitFor(
      () => {
        const state = harness.runtime.getState();
        return state.workingDirectory === undefined &&
          state.pipelineScopeRoot === undefined &&
          state.selectedPipelineId === "review-only";
      },
      "removed workspace scope was not invalidated",
    );

    const cleared = harness.runtime.getState();
    assertAbsentKeys(cleared, ["workingDirectory", "pipelineScopeRoot"], "the rescoped state");
    assert.equal(Object.hasOwn(cleared, "selectedPipelineId"), true);

    await harness.runtime.flush();
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.equal(Object.hasOwn(persisted, "workingDirectory"), false);
    // A patch merge over the persisted value must not resurrect the cleared directory, which
    // is exactly what an own key holding undefined would let through in reverse.
    assert.equal(Object.hasOwn({ ...persisted, taskDirty: true }, "workingDirectory"), false);
    assert.equal(
      Object.hasOwn(structuredClone(persisted), "workingDirectory"),
      false,
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    [firstRoot, secondRoot, thirdRoot].forEach((directory) => {
      removeScratchSync(directory);
    });
  }
});

test("a bound browser conversation that is gone clears the agent sessionId key", async () => {
  const tracked = createTrackedBridge([]);
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "chatgpt-browser-spike",
        taskDirty: false,
        agents: {
          chatgpt: {
            version: "browser-mock",
            sessionId: "vanished-session",
            browserBinding: {
              provider: "chatgpt",
              conversationUrl: "https://chatgpt.com/c/vanished",
              conversationIdentity: "vanished",
              preferredTabId: 7,
            },
          },
        },
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
    runtimeOptions: { bridge: tracked.bridge, startBridge: false, closeBridge: false },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const agent = harness.runtime.getState().agents.chatgpt;
    assert.equal(Object.hasOwn(agent, "sessionId"), false);
    assert.equal(agent.status, "unknown");
    assert.match(agent.error, /not currently available/u);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a browser binding failure clears the agent sessionId key and reports the error", async () => {
  const tracked = createTrackedBridge([]);
  tracked.bridge.bindConversation = () => {
    throw new Error("bridge refused the binding");
  };
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "chatgpt-browser-spike",
        taskDirty: false,
        agents: {
          chatgpt: {
            version: "browser-mock",
            sessionId: "unbindable-session",
            browserBinding: {
              provider: "chatgpt",
              conversationUrl: "https://chatgpt.com/c/unbindable",
              conversationIdentity: "unbindable",
              preferredTabId: 9,
            },
          },
        },
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
      },
    },
    runtimeOptions: { bridge: tracked.bridge, startBridge: false, closeBridge: false },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const agent = harness.runtime.getState().agents.chatgpt;
    assert.equal(Object.hasOwn(agent, "sessionId"), false);
    assert.equal(agent.status, "unknown");
    assert.match(agent.error, /not currently available/u);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a queued request alone locks pipeline mutation and names the reason as a key", async () => {
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: false,
        agents: {},
        attachments: [],
        queuedMessages: [queuedPipelineState("durable-queued")],
        queuePaused: true,
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const locked = harness.runtime.getState();
    assert.equal(locked.pipelineMutable, false);
    assert.equal(Object.hasOwn(locked, "pipelineMutationReason"), true);
    assert.match(locked.pipelineMutationReason, /new run or reset/u);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a transcript append failure records transcriptError and a task reset drops the key", async () => {
  let failAppend = true;
  const harness = loadRuntimeHarness({
    beforeTranscriptAppend: async () => {
      if (failAppend) throw new Error("transcript disk is full");
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(Object.hasOwn(harness.runtime.getState(), "transcriptError"), false);

    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        prompt: "Record this request",
        attachmentIds: [],
      }),
      /Transcript persistence failed/u,
    );
    const failed = harness.runtime.getState();
    assert.equal(Object.hasOwn(failed, "transcriptError"), true);
    assert.match(failed.transcriptError, /transcript disk is full/u);

    failAppend = false;
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.handleMessage({ type: "task.reset" });
    assert.equal(Object.hasOwn(harness.runtime.getState(), "transcriptError"), false);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a malformed persisted runtime value is discarded field by field instead of adopted", async () => {
  const validBinding = {
    provider: "chatgpt",
    conversationUrl: "https://chatgpt.com/c/kept",
    conversationIdentity: "kept",
    preferredTabId: 3,
  };
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        taskId: 17,
        workingDirectory: 42,
        selectedPipelineId: "chatgpt-browser-spike",
        selectedPipelineSnapshot: "not-a-snapshot",
        taskDirty: "yes",
        agents: {
          notARecord: "string",
          badProvider: { browserBinding: { ...validBinding, provider: "netscape" } },
          missingUrl: { browserBinding: { ...validBinding, conversationUrl: 7 } },
          emptyUrl: { browserBinding: { ...validBinding, conversationUrl: "" } },
          missingIdentity: { browserBinding: { ...validBinding, conversationIdentity: null } },
          emptyIdentity: { browserBinding: { ...validBinding, conversationIdentity: "" } },
          fractionalTab: { browserBinding: { ...validBinding, preferredTabId: 1.5 } },
          bindingNotARecord: { browserBinding: [] },
          badVersion: { version: 3, sessionId: 9 },
          chatgpt: { version: "browser-mock", browserBinding: validBinding },
        },
        attachments: [
          "not-a-record",
          { name: "a", mimeType: "text/plain", size: 1, relativePath: "a" },
          { id: "b", mimeType: "text/plain", size: 1, relativePath: "b" },
          { id: "c", name: "c", size: 1, relativePath: "c" },
          { id: "d", name: "d", mimeType: "text/plain", relativePath: "d" },
          { id: "e", name: "e", mimeType: "text/plain", size: 1 },
        ],
        queuedMessages: ["not-a-record", { id: 5 }, {}],
        queuePaused: "maybe",
        resumableWorkflow: "not-a-checkpoint",
        managedPairCheckpoints: "not-an-array",
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const state = harness.runtime.getState();
    assert.equal(typeof state.workingDirectory, "string");
    assert.equal(state.resumableWorkflow, undefined);
    assert.deepEqual(state.attachments, []);
    assert.deepEqual(state.queuedMessages, []);
    assert.equal(state.queuePaused, false);
    assert.equal(typeof state.taskId, "string");
    const agent = state.agents.chatgpt;
    assert.equal(agent.version, "browser-mock");
    assert.equal(agent.browserBinding.conversationIdentity, "kept");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

// The optional fields of PanelState that carry no value on a runtime with nothing persisted
// and no workspace. Construction has to leave every one of them absent, because every later
// write of them deletes rather than assigns, and a snapshot, a spread merge or Object.keys
// tells the two apart.
const UNSET_PANEL_KEYS = [
  "workingDirectory",
  "selectedPipelineId",
  "selectedPipelineDefinition",
  "selectedPipelineHash",
  "pipelineScopeRoot",
  "pipelineMutationReason",
  "executionContract",
  "contractAcknowledgement",
  "activeStep",
  "activeStepId",
  "consensusRound",
  "pendingGate",
  "transcriptError",
  "resumableWorkflow",
];

test("a constructed runtime creates no optional state key it has no value for", async () => {
  const harness = loadRuntimeHarness({ noWorkspace: true });
  try {
    const constructed = harness.runtime.getState();
    UNSET_PANEL_KEYS.forEach((key) => {
      assert.equal(
        Object.hasOwn(constructed, key),
        false,
        `${key} was created at construction as an own property holding undefined`,
      );
    });
    assert.deepEqual(
      Object.keys(constructed).filter((key) => UNSET_PANEL_KEYS.includes(key)),
      [],
    );
    assert.deepEqual(
      Object.keys(structuredClone(constructed)).filter((key) => UNSET_PANEL_KEYS.includes(key)),
      [],
    );
    // A merge over the constructed state must be able to supply a value; an own key holding
    // undefined would instead win over the base in the opposite direction.
    const merged = { ...{ workingDirectory: "/from-base" }, ...constructed };
    assert.equal(merged.workingDirectory, "/from-base");
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a ready runtime still holds no optional state key it has no value for", async () => {
  const harness = loadRuntimeHarness({ noWorkspace: true });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const ready = harness.runtime.getState();
    ["workingDirectory", "pipelineScopeRoot", "pipelineMutationReason", "transcriptError", "resumableWorkflow"]
      .forEach((key) => {
        assert.equal(
          Object.hasOwn(ready, key),
          false,
          `${key} is present holding undefined after initialization`,
        );
      });
    // The runtime does select a pipeline, so these are keys with real values by now.
    assert.equal(Object.hasOwn(ready, "selectedPipelineId"), true);
    assert.equal(Object.hasOwn(ready, "selectedPipelineDefinition"), true);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

const recoveryHarness = (mutate) => {
  const definition = customPipelineDefinition("cross-reference-development", "Recovery");
  const selectedPipelineSnapshot = createPipelineSnapshot(definition, "builtin");
  const resumableWorkflow = singleAgentRecoveryState(undefined, definition);
  mutate?.(resumableWorkflow, definition);
  return loadRuntimeHarness({
    extensionRoot: createSingleAgentPipelineRoot(definition),
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: definition.id,
        selectedPipelineSnapshot,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [],
        queuePaused: false,
        resumableWorkflow,
      },
    },
  });
};

test("a valid persisted checkpoint is offered, and the run reads as interrupted", async () => {
  const harness = recoveryHarness();
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const state = harness.runtime.getState();
    assert.equal(Object.hasOwn(state, "resumableWorkflow"), true);
    assert.equal(state.workflowStatus, "interrupted");
    assert.equal(state.running, false);
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a discarded invalid checkpoint leaves the run idle, exactly like a discarded valid one", async () => {
  const cases = [
    ["a step index past the end", (recovery, definition) => {
      recovery.nextStepIndex = definition.steps.length + 1;
    }],
    ["a negative step index", (recovery) => {
      recovery.nextStepIndex = -1;
    }],
    ["an attachment the store no longer holds", (recovery) => {
      recovery.attachmentIds = ["missing-attachment"];
    }],
    ["a checkpoint too old to parse", (recovery) => {
      delete recovery.pipelineHash;
      delete recovery.pipelineSnapshot;
    }],
  ];
  for (const [label, mutate] of cases) {
    const harness = recoveryHarness(mutate);
    try {
      await harness.runtime.handleMessage({ type: "ready" });
      const state = harness.runtime.getState();
      assert.equal(
        Object.hasOwn(state, "resumableWorkflow"),
        false,
        `${label} left resumableWorkflow as an own property`,
      );
      assert.equal(
        state.workflowStatus,
        "idle",
        `${label} left the run interrupted with nothing to resume`,
      );
      assert.equal(state.running, false, label);
    } finally {
      harness.adapterControls.forEach((control) => control.release.resolve());
      await harness.runtime.dispose();
      harness.cleanup();
    }
  }
});

test("discarding a valid checkpoint is what an invalid one is measured against", async () => {
  const harness = recoveryHarness();
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(harness.runtime.getState().workflowStatus, "interrupted");

    await harness.runtime.handleMessage({ type: "workflow.discard" });
    const discarded = harness.runtime.getState();
    assert.equal(Object.hasOwn(discarded, "resumableWorkflow"), false);
    assert.equal(discarded.workflowStatus, "idle");
    assert.equal(discarded.running, false);
    await harness.runtime.flush();
    assert.equal(
      harness.workspaceState.get("bachata.runtimeState.v5").resumableWorkflow,
      undefined,
    );
  } finally {
    harness.adapterControls.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

// EX-AUD-12. The queue's admission rule now lives in `runtime/queueTransitions.ts`. These prove
// the runtime still applies it, in the runtime's own words, to a request that arrives normally.

test("a queued request past the configured limit is refused with the limit that stopped it", async () => {
  const existing = queuedPipelineState("already-queued");
  const harness = loadRuntimeHarness({
    configuration: { maxQueuedMessages: 1 },
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: existing.pipelineId,
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [existing],
        queuePaused: true,
      },
    },
    runtimeOptions: {
      executeQueuedPipeline: async () => undefined,
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        requestId: "over-limit",
        prompt: "One too many",
        attachmentIds: [],
        iterationCount: 1,
        delivery: "queue",
      }),
      /Queued message limit is 1/u,
    );
    assert.deepEqual(
      harness.runtime.getState().queuedMessages.map((item) => item.id),
      [existing.id],
      "a refused request still joined the queue",
    );
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a queued request naming an attachment the workspace does not hold is refused by name", async () => {
  const harness = loadRuntimeHarness({
    runtimeOptions: {
      executeQueuedPipeline: async () => undefined,
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.run",
        requestId: "missing-attachment",
        prompt: "Queue this",
        attachmentIds: ["ghost"],
        iterationCount: 1,
        delivery: "queue",
      }),
      /Unknown attachment: ghost/u,
    );
    assert.deepEqual(harness.runtime.getState().queuedMessages, []);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

// PAIR-ID-01. A legacy storage key list is a record of what shipped.
//
// The `pair` to `bachata` rename rewrote `defaultLegacyStorageKeys` along with every other
// occurrence, and that turned a historical record into a list of names no released build ever
// wrote: a user upgrading from a release has `pair.runtimeState.v4` in workspace state and nothing
// named `bachata` anything. The migration then found nothing, and the run started from an empty
// state without reporting a problem. `llmPipeline.runtimeState.v2` surviving the rename untouched
// is the proof that this list is history rather than identity.
test("runtime state persisted under the shipped key is still read and then migrated", async () => {
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "pair.runtimeState.v4": {
        selectedPipelineId: "review-only",
        workingDirectory: "/legacy/working/directory",
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const state = harness.runtime.getState();
    assert.equal(state.selectedPipelineId, "review-only", "the legacy record was not read");
    assert.equal(state.workingDirectory, "/legacy/working/directory");
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("every runtime key a released build wrote is on the legacy list", async () => {
  // Driven one key at a time rather than by reading the list, so what is proved is that the
  // runtime reads the key — not that the list matches a copy of itself kept here.
  for (const key of [
    "pair.runtimeState.v4",
    "pair.runtimeState.v3",
    "pair.runtimeState.v2",
    "llmPipeline.runtimeState.v2",
    "bachata.runtimeState.v4",
    "bachata.runtimeState.v3",
    "bachata.runtimeState.v2",
  ]) {
    // The working directory, not the selected pipeline: a fresh runtime already selects a
    // pipeline, so asserting on that would pass whether or not the legacy record was read.
    const directory = `/legacy/${key}`;
    const harness = loadRuntimeHarness({
      initialWorkspaceState: { [key]: { workingDirectory: directory } },
    });
    try {
      await harness.runtime.handleMessage({ type: "ready" });
      assert.equal(harness.runtime.getState().workingDirectory, directory, key);
    } finally {
      await harness.runtime.dispose();
      harness.cleanup();
    }
  }
});

// EX-3. The stored-response bound. A provider that streams without end would otherwise be held
// whole in workspace state and in the transcript, so the cap is enforced while the stream runs
// rather than after it: a run that exceeds it is aborted and interrupted mid-turn, and the answer
// it produced is refused. These were the only decisions in the turn loop that no test drove.

const maxStoredBytesHarness = (onAdapterSend) =>
  loadRuntimeHarness({
    extensionRoot: createSingleAgentPipelineRoot(),
    configuration: { maxStoredResponseBytes: 32 },
    onAdapterSend,
  });

const runToFailure = async (harness) => {
  await harness.runtime.handleMessage({ type: "ready" });
  harness.adapterControls.get("codex").release.resolve();
  await harness.runtime.handleMessage({
    type: "pipeline.run",
    prompt: "Stream too much.",
    attachmentIds: [],
  });
};

test("a streamed answer past the stored-response bound is interrupted, not stored", async () => {
  const harness = maxStoredBytesHarness(async () => ({
    events: [
      { type: "text", text: "x".repeat(20) },
      { type: "text", text: "y".repeat(20) },
    ],
    answer: "unreachable",
  }));
  try {
    await assert.rejects(runToFailure(harness), /codex response exceeded 32 bytes/u);
    assert.equal(harness.adapterControls.get("codex").interruptCount, 1);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a replacement answer past the bound is measured whole, not added to what it replaced", async () => {
  // WHY REPLACE IS DIFFERENT. A `replace` event supersedes everything streamed so far, so its
  // size is the new total. Adding it to the running count would refuse a legal answer; ignoring
  // the count entirely would let an over-size replacement through.
  const harness = maxStoredBytesHarness(async () => ({
    events: [
      { type: "text", text: "x".repeat(30) },
      { type: "replace", text: "z".repeat(10) },
      { type: "replace", text: "w".repeat(40) },
    ],
    answer: "unreachable",
  }));
  try {
    await assert.rejects(runToFailure(harness), /codex response exceeded 32 bytes/u);
    assert.equal(harness.adapterControls.get("codex").interruptCount, 1);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a final answer past the bound is refused even when nothing streamed", async () => {
  const harness = maxStoredBytesHarness(async () => ({ answer: "a".repeat(64) }));
  try {
    await assert.rejects(runToFailure(harness), /codex response exceeded 32 bytes/u);
    // Nothing streamed, so nothing was interrupted: the refusal is on the final answer alone.
    assert.equal(harness.adapterControls.get("codex").interruptCount, 0);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

test("a status event carries no answer and never ends the turn on its own", async () => {
  const harness = maxStoredBytesHarness(async () => ({
    events: [{ type: "status", status: "thinking" }],
    answer: "ok",
  }));
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    harness.adapterControls.get("codex").release.resolve();
    await harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "Think first.",
      attachmentIds: [],
    });
    assert.equal(harness.runtime.getState().workflowStatus, "completed");
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

// EX-G6-17. The editor holds a request open until an `operation.result` comes back with its id.
// `pipeline.fork` throws before it posts one when the pipeline is unknown, so that request stayed
// pending for the life of the panel while the error surfaced as an uncorrelated banner that said
// nothing about the operation being waited on.
test("a failed editor operation still answers the request it was given", async () => {
  const posted = [];
  const harness = loadRuntimeHarness();
  try {
    const subscription = harness.runtime.attachWebview({
      postMessage: async (message) => {
        posted.push(message);
        return true;
      },
    });
    await harness.runtime.handleMessage({ type: "ready" });

    await assert.rejects(
      harness.runtime.handleMessage({
        type: "pipeline.fork",
        pipelineId: "no-such-pipeline",
        requestId: "fork-1",
      }),
      /Unknown pipeline/u,
    );
    const failure = posted.find(
      (message) => message.type === "operation.result" && message.requestId === "fork-1",
    );
    assert.ok(failure, "the fork request was never answered");
    assert.equal(failure.operation, "pipeline.fork");
    assert.equal(failure.status, "failed");
    assert.match(failure.message, /Unknown pipeline/u);

    // A fork that succeeds still answers exactly once, and as a completion.
    const existing = harness.runtime.getState().selectedPipelineId;
    await harness.runtime.handleMessage({
      type: "pipeline.fork",
      pipelineId: existing,
      requestId: "fork-2",
    });
    const answers = posted.filter(
      (message) => message.type === "operation.result" && message.requestId === "fork-2",
    );
    assert.equal(answers.length, 1);
    assert.equal(answers[0].status, "completed");
    subscription.dispose();
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
  }
});

// Stopping is not recording. Every test below drives the same event — the workspace lease is
// lost, or the transcript store refuses a write — through a cleanup path, and asserts that the
// providers are still stopped, the adapters still disposed and the queue still refused.

const leaseHarness = (extra = {}) => {
  const lease = { writable: true };
  const harness = loadRuntimeHarness({
    ...extra,
    runtimeOptions: {
      ...(extra.runtimeOptions ?? {}),
      assertWritable: () => {
        if (!lease.writable) {
          throw new Error("Shared-resource lease is no longer active");
        }
      },
    },
  });
  return { ...harness, lease };
};

// The decision is handed back wrapped: an async helper that returned the promise itself would
// adopt it, and the caller would wait for the approval it is about to test.
const raiseApproval = async (harness, requestId) => {
  const decision = harness.adapterContexts.get("codex").requestCodexApproval("codex", {
    requestId,
    kind: "command",
    method: "item/commandExecution/requestApproval",
    choices: [
      { id: "accept", label: "Accept" },
      { id: "cancel", label: "Cancel" },
    ],
  });
  await waitFor(
    () => harness.runtime.getState().approvals.length === 1,
    `Approval ${requestId} was not published`,
  );
  return { decision };
};

test("an interrupt stops the providers when the lost lease refuses the approval audit write", async () => {
  const extensionRoot = createSingleAgentPipelineRoot();
  const harness = leaseHarness({ extensionRoot });
  try {
    const subscription = harness.runtime.attachWebview({ postMessage: async () => true });
    await harness.runtime.handleMessage({ type: "ready" });
    const run = harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "Work until interrupted.",
      attachmentIds: [],
    });
    const control = harness.adapterControls.get("codex");
    await control.started.promise;
    const { decision } = await raiseApproval(harness, "approval-interrupted");

    // The event that makes a user want to stop everything is the event that made the stop throw.
    harness.lease.writable = false;
    await harness.runtime.interrupt();

    assert.equal(await decision, "cancel");
    assert.ok(
      control.interruptCount >= 1,
      "the provider was never interrupted",
    );
    await run.catch(() => undefined);
    subscription.dispose();
  } finally {
    harness.lease.writable = true;
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose().catch(() => undefined);
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});

test("disposal still disposes the adapters when the shutdown audit write fails", async () => {
  let refuseAppend = false;
  const harness = loadRuntimeHarness({
    beforeTranscriptAppend: async () => {
      if (refuseAppend) {
        throw new Error("the storage directory is gone");
      }
    },
  });
  try {
    const subscription = harness.runtime.attachWebview({ postMessage: async () => true });
    await harness.runtime.handleMessage({ type: "ready" });
    const { decision } = await raiseApproval(harness, "approval-shutdown");

    refuseAppend = true;
    await assert.rejects(harness.runtime.dispose(), /the storage directory is gone/u);

    assert.equal(await decision, "cancel");
    assert.ok(
      harness.adapterControlHistory.length > 0,
      "no adapter was built to dispose",
    );
    harness.adapterControlHistory.forEach((control) => {
      assert.equal(control.disposeCount, 1, `${control.agentId} was never disposed`);
    });
    // A shutdown that cannot write its audit line is still a shutdown, but never a silent one.
    assert.ok(
      harness.outputLines.some((line) => line.includes("Failed to record the agent shutdown")),
      "the failed shutdown audit was not reported",
    );
    subscription.dispose();
  } finally {
    refuseAppend = false;
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    harness.cleanup();
  }
});

test("a queued run claimed while the runtime is disposing is paused, not started", async () => {
  const queued = queuedPipelineState("claimed-during-disposal");
  const claimStarted = deferred();
  const releaseClaim = deferred();
  let blockClaim = true;
  let executions = 0;
  const harness = loadRuntimeHarness({
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        selectedPipelineId: "cross-reference-development",
        taskDirty: true,
        agents: {},
        attachments: [],
        queuedMessages: [queued],
        queuePaused: true,
      },
    },
    beforeWorkspaceStateUpdate: async ({ value }) => {
      if (blockClaim && value?.queueStart?.messageId === queued.id) {
        blockClaim = false;
        claimStarted.resolve();
        await releaseClaim.promise;
      }
    },
    runtimeOptions: {
      executeQueuedPipeline: async () => {
        executions += 1;
      },
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({ type: "queue.resume" });
    await claimStarted.promise;

    const disposal = harness.runtime.dispose();
    releaseClaim.resolve();
    await disposal;

    assert.equal(executions, 0);
    const persisted = harness.workspaceState.get("bachata.runtimeState.v5");
    assert.deepEqual(persisted.queuedMessages.map((item) => item.id), [queued.id]);
    assert.equal(persisted.queuePaused, true);
    assert.equal(persisted.queueStart, undefined);
    await assert.rejects(harness.runtime.runPipeline("late", []), /runtime is disposed/u);
    await assert.rejects(harness.runtime.resumePipeline(), /runtime is disposed/u);
  } finally {
    releaseClaim.resolve();
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    harness.cleanup();
  }
});

test("a failed approval-cancellation audit does not destroy the answer the turn produced", async () => {
  const extensionRoot = createSingleAgentPipelineRoot();
  const harness = loadRuntimeHarness({
    extensionRoot,
    beforeTranscriptAppend: async (entry) => {
      if (entry.eventType === "approval.cancelled") {
        throw new Error("transcript disk is full");
      }
    },
    onAdapterSend: async () => ({ answer: "the completed answer" }),
  });
  try {
    const subscription = harness.runtime.attachWebview({ postMessage: async () => true });
    await harness.runtime.handleMessage({ type: "ready" });
    const run = harness.runtime.handleMessage({
      type: "pipeline.run",
      prompt: "Answer this.",
      attachmentIds: [],
    });
    const control = harness.adapterControls.get("codex");
    await control.started.promise;
    const { decision } = await raiseApproval(harness, "approval-still-pending");
    control.release.resolve();

    await run;

    assert.equal(await decision, "cancel");
    assert.match(
      harness.runtime.getState().agents.codex.output,
      /the completed answer/u,
    );
    assert.ok(
      harness.outputLines.some((line) =>
        line.includes("Approval cancellation committed, but its transcript audit entry could not be saved"),
      ),
      "the failed cancellation audit was not reported",
    );
    subscription.dispose();
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose().catch(() => undefined);
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});
