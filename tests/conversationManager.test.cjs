const assert = require("node:assert/strict");
const Module = require("node:module");
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { execFileSync } = require("node:child_process");
const {
  createResourceBroker,
  ResourceQuarantinedError,
} = require("../dist/concurrency/resourceBroker.js");
const {
  repositoryExecutionClaims,
  resolveWorkingResourceIdentity,
} = require("../dist/concurrency/repositoryResources.js");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const injectModule = (filename, exports) => {
  const module = new Module(filename);
  module.filename = filename;
  module.loaded = true;
  module.exports = exports;
  require.cache[filename] = module;
};

const readOnlyReviewDefinition = (pipelineId) => ({
  version: 1,
  id: pipelineId,
  name: pipelineId,
  // These fixtures exercise the longitudinal journey, so they declare the intent a
  // user-facing review workflow declares.
  longitudinalIntent: "initiativeRequired",
  agents: [
    { id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "readOnly" },
    { id: "claude", name: "Claude Code", adapter: "claude-code", permissionMode: "plan" },
  ],
  steps: [
    {
      id: "review",
      type: "agent",
      name: "Review",
      enabled: true,
      participants: ["codex", "claude"],
      promptTemplate: "{{userPrompt}}",
      parallel: true,
      consensus: false,
      humanGate: "none",
    },
    {
      id: "review-consensus",
      type: "agent",
      name: "Cross-reference findings",
      enabled: true,
      participants: ["codex", "claude"],
      promptTemplate: "{{peerAnswersTagged}}",
      parallel: true,
      consensus: true,
      consensusConfig: {
        mode: "unanimous",
        maxRounds: 2,
        candidateField: "candidate",
        acceptedField: "accepted",
        candidateShape: "ruledModelFindingSet",
      },
      humanGate: "none",
    },
  ],
});

const readOnlyNonReviewDefinition = (pipelineId) => ({
  ...readOnlyReviewDefinition(pipelineId),
  steps: [
    {
      id: "plan",
      type: "agent",
      name: "Plan",
      enabled: true,
      participants: ["codex"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
      humanGate: "none",
    },
  ],
});

const writeCapableDefinition = (pipelineId) => ({
  ...readOnlyReviewDefinition(pipelineId),
  agents: [
    { id: "codex", name: "Codex", adapter: "codex-app-server", permissionMode: "workspaceWrite" },
  ],
  steps: [
    {
      id: "fix",
      type: "agent",
      name: "Fix",
      enabled: true,
      participants: ["codex"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
      humanGate: "none",
    },
  ],
});

const loadHarness = (persistedManagerState, harnessOptions = {}) => {
  const root = path.resolve(__dirname, "..");
  const ownsStorageRoot = typeof harnessOptions.storageRoot !== "string";
  const storageRoot = harnessOptions.storageRoot ?? mkdtempSync(path.join(os.tmpdir(), "bachata-conversation-manager-"));
  const removeStorageOnDispose = harnessOptions.removeStorageOnDispose ?? ownsStorageRoot;
  const runtimeInstances = [];
  const fileSystemWatchers = [];
  const workspaceFolderListeners = [];
  const workingDirectory = harnessOptions.noWorkingDirectory
    ? undefined
    : harnessOptions.workingDirectory ?? "/workspace";
  const bridge = {
    startCount: 0,
    closeCount: 0,
    start: async () => {
      bridge.startCount += 1;
      await harnessOptions.beforeBridgeStart?.();
      if (harnessOptions.bridgeStartError) {
        throw harnessOptions.bridgeStartError;
      }
    },
    close: async () => {
      bridge.closeCount += 1;
      await harnessOptions.beforeBridgeClose?.();
      if (harnessOptions.bridgeCloseError) {
        throw harnessOptions.bridgeCloseError;
      }
    },
    getStatus: () => ({ enabled: true, connected: false, sessions: [] }),
    subscribeStatus: (listener) => {
      listener({ enabled: true, connected: false, sessions: [] });
      return { dispose: () => undefined };
    },
    resetPairing: async () => undefined,
    discover: () => undefined,
    bindConversation: () => undefined,
    releaseBinding: () => undefined,
    sendConversation: () => {
      throw new Error("unused");
    },
    interrupt: async () => undefined,
  };

  const bridgePath = require.resolve("../dist/browser/bridgeServer.js");
  injectModule(bridgePath, {
    createBrowserBridgeServer: () => bridge,
  });

  const runtimePath = require.resolve("../dist/runtime/createRuntime.js");
  injectModule(runtimePath, {
    createRuntime: (_context, _output, options) => {
      const run = deferred();
      const beforeRun = deferred();
      let target;
      let disposed = false;
      const definitionFor = (pipelineId) => {
        const configured = (harnessOptions.pipelineDefinitions ?? {})[pipelineId];
        if (configured === null) return undefined;
        return configured ?? readOnlyReviewDefinition(pipelineId);
      };
      const state = {
        taskId: `task-${runtimeInstances.length + 1}`,
        workspaceRoots: workingDirectory ? [workingDirectory] : [],
        workingDirectory,
        trusted: true,
        pipelines: [
          { id: "cross-reference-development", name: "Implement and review" },
        ],
        selectedPipelineId: "cross-reference-development",
        agents: {
          codex: {
            id: "codex",
            name: "Codex",
            adapterType: "codex-app-server",
            status: "idle",
            output: "",
          },
          claude: {
            id: "claude",
            name: "Claude",
            adapterType: "claude-code",
            status: "idle",
            output: "",
          },
        },
        roles: {},
        running: false,
        workflowStatus: "idle",
        transcript: [],
        transcriptTotal: 0,
        transcriptHasMore: false,
        transcriptWindowSize: 300,
        approvals: [],
        attachments: structuredClone(harnessOptions.runtimeAttachments ?? []),
        maxAttachmentBytes: 100,
        maxAttachmentCount: 20,
        maxAttachmentTotalBytes: 1000,
        browserBridge: { enabled: true, connected: false, sessions: [] },
        resumableWorkflow: harnessOptions.runtimeResumableWorkflow
          ? structuredClone(harnessOptions.runtimeResumableWorkflow)
          : undefined,
      };
      const instance = {
        options,
        messages: [],
        pipelineCalls: [],
        pipelineRunOptions: [],
        pipelineResults: [],
        configureCalls: [],
        configureError: undefined,
        preflightCalls: [],
        resolveSnapshotCalls: [],
        preflightError: harnessOptions.nextRuntimePreflightError,
        resetSessionsError: undefined,
        beforePipelineRun: undefined,
        resumeCalls: [],
        state,
        run,
        beforeRun,
        delayBeforeRun: false,
        throwOnMessageType: undefined,
        leadFallbackCalls: [],
        leadFallbackError: undefined,
        shutdownIdleProvidersCalls: 0,
        disposeCalls: 0,
        disposeErrors: [],
        pipelineRefreshCalls: [],
        emit: async (message) => target?.postMessage(message),
        runtime: {
          attachWebview: (webview) => {
            target = webview;
            void webview.postMessage({ type: "state.snapshot", state });
            return { dispose: () => { target = undefined; } };
          },
          handleMessage: async (message) => {
            instance.messages.push(message);
            await harnessOptions.beforeRuntimeMessage?.(instance, message);
            if (message.type === instance.throwOnMessageType) {
              throw new Error(`Simulated ${message.type} failure`);
            }
            if (message.type === "ready") {
              await target?.postMessage({ type: "state.snapshot", state });
            }
            if (
              message.type === "pipeline.run" &&
              message.delivery !== undefined &&
              message.delivery !== "immediate" &&
              options.executeQueuedPipeline
            ) {
              await options.executeQueuedPipeline(
                {
                  queueMessageId: `queue-${message.requestId ?? "anonymous"}`,
                  pipelineId: state.selectedPipelineId,
                  prompt: message.prompt,
                  attachmentIds: [...message.attachmentIds],
                  iterationCount: message.iterationCount ?? 1,
                },
                async () => {
                  await target?.postMessage({
                    type: "operation.result",
                    requestId: message.requestId,
                    operation: "pipeline.run",
                    status: "accepted",
                  });
                },
              );
              return;
            }
            if (message.type === "pipeline.run") {
              if (instance.delayBeforeRun) {
                await beforeRun.promise;
              }
              await target?.postMessage({
                type: "transcript.append",
                entry: {
                  id: `prompt-${runtimeInstances.indexOf(instance) + 1}`,
                  kind: "prompt",
                  eventType: "user.message",
                  text: message.prompt,
                  createdAt: new Date().toISOString(),
                },
              });
              state.running = true;
              state.workflowStatus = "running";
              await target?.postMessage({
                type: "run.patch",
                running: true,
                workflowStatus: "running",
              });
              await run.promise;
              state.running = false;
              state.workflowStatus = "completed";
              await target?.postMessage({
                type: "run.patch",
                running: false,
                workflowStatus: "completed",
              });
            }
            if (message.type === "task.reset") {
              state.running = false;
              state.workflowStatus = "idle";
            }
          },
          getState: () => structuredClone(state),
          loadTranscript: async () => structuredClone(state.transcript),
          ...(harnessOptions.providePipelineSnapshot
            ? { getSelectedPipelineSnapshot: () => undefined }
            : {}),
          refreshPipelines: async (change) => {
            instance.pipelineRefreshCalls.push(change);
          },
          configure: async (configuration) => {
            instance.configureCalls.push({ ...configuration });
            if (instance.configureError) {
              throw instance.configureError;
            }
            if (configuration.pipelineId !== undefined) {
              state.selectedPipelineId = configuration.pipelineId;
            }
            if (configuration.workingDirectory !== undefined) {
              state.workingDirectory = configuration.workingDirectory;
            }
          },
          resolvePipelineSnapshot: async (pipelineId, resolveOptions = {}) => {
            instance.resolveSnapshotCalls.push({ pipelineId, options: { ...resolveOptions } });
            const definition = definitionFor(pipelineId);
            if (definition === undefined) {
              throw new Error(`Unknown pipeline ${pipelineId}`);
            }
            return {
              version: 1,
              definition,
              hash: `hash-${pipelineId}`,
              scopeKey: "extension",
            };
          },
          preflightPipeline: async (prompt, attachmentIds = [], snapshot, preflightOptions = {}) => {
            instance.preflightCalls.push({
              prompt,
              attachmentIds: [...attachmentIds],
              snapshotHash: snapshot?.hash,
              options: { ...preflightOptions },
            });
            if (instance.preflightError) {
              throw instance.preflightError;
            }
            return harnessOptions.preflightSnapshot
              ? harnessOptions.preflightSnapshot(snapshot)
              : snapshot;
          },
          pipelineRunRefusal: () => instance.runRefusal,
          resetSessions: async () => {
            instance.messages.push({ type: "session.reset" });
            if (instance.resetSessionsError) {
              throw instance.resetSessionsError;
            }
          },
          runPipeline: async (prompt, attachmentIds = [], runOptions = {}) => {
            instance.pipelineCalls.push({ prompt, attachmentIds: [...attachmentIds] });
            instance.pipelineRunOptions.push({
              appendPrompt: runOptions.appendPrompt,
              sourceQueueMessageId: runOptions.sourceQueueMessageId,
              hasOnAccepted: typeof runOptions.onAccepted === "function",
            });
            await instance.beforePipelineRun?.({ prompt, attachmentIds: [...attachmentIds] });
            await runOptions.onAccepted?.();
            if (instance.reportPipelineStep) {
              instance.options.onPipelineStep?.({
                step: {
                  id: "reported-step",
                  type: "prompt",
                  name: "Reported step",
                  enabled: true,
                  humanGate: "none",
                  prompt,
                  participants: ["codex"],
                  execution: "sequential",
                  consensus: { enabled: false },
                },
                index: 0,
              });
            }
            const result = instance.pipelineResults.shift() ?? {
              status: "completed",
              answers: {},
              outputs: {},
              decisions: [],
              roles: {},
            };
            state.workflowStatus = result.status === "completed" ? "completed" : "interrupted";
            state.running = false;
            state.resumableWorkflow = result.status === "interrupted"
              ? {
                  pipelineId: state.selectedPipelineId,
                  pipelineName: "Implement and review",
                  userPrompt: prompt,
                  attachmentIds: [...attachmentIds],
                  nextStepIndex: 1,
                  totalSteps: 2,
                  updatedAt: new Date().toISOString(),
                  ...(runOptions.sourceQueueMessageId
                    ? { sourceQueueMessageId: runOptions.sourceQueueMessageId }
                    : {}),
                }
              : undefined;
            return result;
          },
          resumePipeline: async (runOptions = {}) => {
            const recovery = state.resumableWorkflow;
            if (!recovery) {
              throw new Error("No recoverable workflow is available");
            }
            instance.resumeCalls.push({ recovery: structuredClone(recovery) });
            await runOptions.onAccepted?.();
            instance.options.onPipelineStep?.({
              step: {
                id: "resumed-step",
                type: "prompt",
                name: "Resumed step",
                enabled: true,
                humanGate: "none",
                prompt: "Continue",
                participants: ["codex"],
                execution: "sequential",
                consensus: { enabled: false },
              },
              index: 1,
            });
            const result = instance.pipelineResults.shift() ?? {
              status: "completed",
              answers: {},
              outputs: {},
              decisions: [],
              roles: {},
            };
            state.workflowStatus = result.status === "completed" ? "completed" : "interrupted";
            state.running = false;
            if (result.status === "completed") {
              state.resumableWorkflow = undefined;
            }
            return result;
          },
          interrupt: async () => undefined,
          shutdownIdleProviders: async () => {
            instance.shutdownIdleProvidersCalls += 1;
            await harnessOptions.beforeProviderShutdown?.(instance);
            if (harnessOptions.providerShutdownError) {
              throw harnessOptions.providerShutdownError;
            }
          },
          answerSemanticQuestionWithLead: async (originAgentId, request) => {
            instance.leadFallbackCalls.push({ originAgentId, request });
            if (instance.leadFallbackError) {
              throw instance.leadFallbackError;
            }
            return {
              selected: request.options.slice(0, 1).map((option) => option.id),
              freeText: "",
              source: "lead",
            };
          },
          isBusy: () => state.running,
          flush: async () => undefined,
          dispose: async () => {
            disposed = true;
            instance.disposeCalls += 1;
            await harnessOptions.beforeRuntimeDispose?.(instance);
            const queuedError = instance.disposeErrors.shift();
            if (queuedError) {
              throw queuedError;
            }
            if (harnessOptions.runtimeDisposeError) {
              throw harnessOptions.runtimeDisposeError;
            }
          },
        },
        get disposed() {
          return disposed;
        },
      };
      harnessOptions.nextRuntimePreflightError = undefined;
      runtimeInstances.push(instance);
      harnessOptions.onRuntimeCreated?.(instance, runtimeInstances.length - 1);
      return instance.runtime;
    },
  });

  class Disposable {
    constructor(dispose) {
      this.dispose = dispose;
    }
  }

  const workspaceState = harnessOptions.workspaceState ?? new Map();
  if (persistedManagerState !== undefined) {
    workspaceState.set("bachata.conversationManager.v1", persistedManagerState);
  }
  const executedCommands = [];
  const savedFiles = [];
  class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  }

  const exportPreviews = [];
  const exportConfirmations = [];
  const vscode = {
    Disposable,
    RelativePattern,
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      executeCommand: async (...args) => {
        executedCommands.push(args);
      },
    },
    env: { remoteName: undefined },
    window: {
      showInformationMessage: async () => undefined,
      showWarningMessage: async (message, options, ...actions) => {
        exportConfirmations.push({ message, options, actions });
        return harnessOptions.cancelExport ? undefined : actions[0];
      },
      showTextDocument: async (document) => {
        exportPreviews.push(document);
        return { document };
      },
      showSaveDialog: async () => harnessOptions.saveDialogPath
        ? vscode.Uri.file(harnessOptions.saveDialogPath)
        : undefined,
    },
    workspace: {
      openTextDocument: async (options) => ({ ...options }),
      fs: {
        writeFile: async (uri, content) => {
          writeFileSync(uri.fsPath, content);
          savedFiles.push(uri.fsPath);
        },
      },
      workspaceFolders: harnessOptions.workspaceFolders ?? (workingDirectory
        ? [{ uri: { fsPath: workingDirectory } }]
        : []),
      createFileSystemWatcher: harnessOptions.enableFileSystemWatchers
        ? (pattern) => {
            const callbacks = { create: [], change: [], delete: [] };
            const watcher = {
              pattern,
              callbacks,
              onDidCreate: (callback) => callbacks.create.push(callback),
              onDidChange: (callback) => callbacks.change.push(callback),
              onDidDelete: (callback) => callbacks.delete.push(callback),
              dispose: () => {
                watcher.disposed = true;
              },
              disposed: false,
            };
            fileSystemWatchers.push(watcher);
            return watcher;
          }
        : undefined,
      onDidChangeWorkspaceFolders: harnessOptions.enableFileSystemWatchers
        ? (callback) => {
            workspaceFolderListeners.push(callback);
            return new Disposable(() => undefined);
          }
        : undefined,
      onDidChangeConfiguration: () => new Disposable(() => undefined),
      getConfiguration: () => ({
        get: (key, fallback) => Object.prototype.hasOwnProperty.call(
          harnessOptions.configurationValues ?? {},
          key,
        )
          ? harnessOptions.configurationValues[key]
          : fallback,
      }),
    },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return vscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const managerPath = require.resolve(
    "../dist/conversations/createConversationManager.js",
  );
  delete require.cache[managerPath];
  let createConversationManager;
  try {
    ({ createConversationManager } = require(managerPath));
  } finally {
    Module._load = originalLoad;
  }

  const manager = createConversationManager(
    {
      workspaceState: {
        get: (key) => workspaceState.get(key),
        update: async (key, value) => {
          await harnessOptions.beforeWorkspaceStateUpdate?.({ key, value, workspaceState });
          if (value === undefined) {
            workspaceState.delete(key);
          } else {
            workspaceState.set(key, value);
          }
          await harnessOptions.afterWorkspaceStateUpdate?.({ key, value, workspaceState });
        },
      },
      storageUri: { fsPath: storageRoot },
      globalStorageUri: { fsPath: storageRoot },
      extensionMode: harnessOptions.extensionMode ?? vscode.ExtensionMode.Production,
      secrets: {},
    },
    { appendLine: (line) => outputLines.push(line) },
    {
      resourceBroker: harnessOptions.resourceBroker,
      workspaceLease: harnessOptions.workspaceLease,
      withWorkspaceMutation: harnessOptions.withWorkspaceMutation,
    },
  );
  const originalDispose = manager.dispose.bind(manager);
  manager.dispose = async () => {
    try {
      await originalDispose();
    } finally {
      if (removeStorageOnDispose) {
        rmSync(storageRoot, { recursive: true, force: true });
      }
    }
  };
  const posted = [];
  const outputLines = [];
  const subscription = manager.attachWebview({
    postMessage: async (message) => {
      posted.push(message);
      return true;
    },
    ...(harnessOptions.webviewUris
      ? { asWebviewUri: (uri) => ({ toString: () => `webview:${uri.fsPath}` }) }
      : {}),
  });

  return {
    manager,
    outputLines,
    options: harnessOptions,
    bridge,
    runtimeInstances,
    workspaceState,
    posted,
    subscription,
    storageRoot,
    executedCommands,
    savedFiles,
    exportPreviews,
    exportConfirmations,
    fileSystemWatchers,
    workspaceFolderListeners,
  };
};

const waitFor = async (condition, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not reached");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("history search matches full runtime transcript evidence", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    harness.runtimeInstances[0].state.transcript.push({
      id: "answer-1",
      kind: "answer",
      eventType: "agent.answer",
      agentId: "codex",
      text: "The hidden regression was fixed in the retained worktree",
      createdAt: new Date().toISOString(),
    });

    await harness.manager.handleMessage({
      type: "history.search",
      query: "hidden regression",
      requestId: "search-1",
    });

    const result = harness.posted.findLast((message) =>
      message.type === "manager.historyResults" && message.requestId === "search-1"
    );
    assert.deepEqual(result?.conversationIds, [conversationId]);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("run bundle export writes redacted bounded local evidence", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-run-export-"));
  const saveDialogPath = path.join(storageRoot, "run.bachata-run.json");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    providePipelineSnapshot: true,
    runtimeAttachments: [{
      id: "attachment-1",
      name: "review.txt",
      mimeType: "text/plain",
      size: 12,
      relativePath: "attachments/review.txt",
    }],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    harness.runtimeInstances[0].state.transcript.push({
      id: "answer-1",
      kind: "answer",
      eventType: "agent.answer",
      agentId: "codex",
      text: "Authorization: Bearer secret-value",
      createdAt: new Date().toISOString(),
    });
    harness.runtimeInstances[0].state.transcript.push({
      id: "event-1",
      kind: "event",
      eventType: "browser.session.selected",
      agentId: "chatgpt",
      text: "chatgpt bound to https://chatgpt.com/c/1f0c2a44-4d2f-4a5e-9b0a-2f3f0f9c1234",
      createdAt: new Date().toISOString(),
      data: {
        agentId: "chatgpt",
        provider: "chatgpt",
        sessionId: "session-7f21",
        conversationUrl: "https://chatgpt.com/c/1f0c2a44-4d2f-4a5e-9b0a-2f3f0f9c1234",
        conversationIdentity: "chatgpt:1f0c2a44-4d2f-4a5e-9b0a-2f3f0f9c1234",
      },
    });

    await harness.manager.handleMessage({
      type: "conversation.exportBundle",
      conversationId,
    });

    assert.deepEqual(harness.savedFiles, [saveDialogPath]);
    const exported = readFileSync(saveDialogPath, "utf8");
    assert.doesNotMatch(exported, /secret-value/u);
    const bundle = JSON.parse(exported);
    assert.equal(bundle.version, 1);
    assert.equal(bundle.run.schema, "bachata.run-bundle.v1");
    assert.deepEqual(bundle.run.attachments, [{
      id: "attachment-1",
      mimeType: "text/plain",
      name: "review.txt",
      size: 12,
    }]);
    assert.equal(bundle.run.omissions.length, 4);
    assert.doesNotMatch(exported, /1f0c2a44-4d2f-4a5e-9b0a-2f3f0f9c1234/u);
    assert.doesNotMatch(exported, /session-7f21/u);
    const sessionEntry = bundle.run.transcript.find((entry) => entry.id === "event-1");
    assert.equal(sessionEntry.data.sessionId, "[EXCLUDED]");
    assert.equal(sessionEntry.data.conversationUrl, "[EXCLUDED]");
    assert.equal(sessionEntry.data.conversationIdentity, "[EXCLUDED]");
    assert.equal(
      sessionEntry.text,
      "chatgpt bound to https://chatgpt.com/[REDACTED]",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("the repository export policy filters every bundle section, not only changed files", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-run-export-policy-"));
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-export-policy-repo-"));
  mkdirSync(path.join(repositoryRoot, ".bachata"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, ".bachata", "export-policy.json"),
    JSON.stringify({ version: 1, redactLiterals: [], excludePathPrefixes: ["private/"] }),
    "utf8",
  );
  const saveDialogPath = path.join(storageRoot, "run.bachata-run.json");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    providePipelineSnapshot: true,
    workingDirectory: repositoryRoot,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    harness.runtimeInstances[0].state.transcript.push({
      id: "event-secret",
      kind: "event",
      eventType: "workspace.changed",
      agentId: "codex",
      text: "workspace changed",
      createdAt: new Date().toISOString(),
      data: { changedFiles: ["private/secret.ts", "src/public.ts"], path: "src/public.ts" },
    });

    await harness.manager.handleMessage({ type: "conversation.exportBundle", conversationId });

    const exported = readFileSync(saveDialogPath, "utf8");
    assert.doesNotMatch(exported, /private\/secret\.ts/u);
    const bundle = JSON.parse(exported);
    const entry = bundle.run.transcript.find((item) => item.id === "event-secret");
    assert.deepEqual(entry.data.changedFiles, ["src/public.ts"]);
    assert.ok(bundle.run.omissions.some((omission) =>
      omission.includes("excluded from every bundle section")));
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("every export is previewed and confirmed before it is written", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-export-preview-"));
  const saveDialogPath = path.join(storageRoot, "run.bachata-run.json");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    providePipelineSnapshot: true,
    cancelExport: true,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    await harness.manager.handleMessage({ type: "conversation.exportBundle", conversationId });

    assert.equal(harness.exportPreviews.length, 1);
    assert.deepEqual(harness.savedFiles, []);
    const confirmation = harness.exportConfirmations.at(-1);
    assert.equal(confirmation.options.modal, true);
    assert.match(confirmation.options.detail, /Applied redaction rules:/u);
    assert.match(confirmation.options.detail, /Redaction is heuristic/u);
    assert.deepEqual(confirmation.actions, ["Save export"]);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("evidence exports render markdown and SARIF from the same recorded result", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-export-evidence-"));
  const saveDialogPath = path.join(storageRoot, "run.bachata-evidence.md");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    providePipelineSnapshot: true,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    // The export needs a run to export. A conversation that has never run is not projected into a
    // result at all, so asking it for evidence is refused rather than answered with an empty
    // "Evidence gaps" document about a run that did not happen.
    const running = harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId,
      message: { type: "pipeline.run", prompt: "Deliver the change", attachmentIds: [] },
    });
    await waitFor(() => harness.runtimeInstances[0].state.running);
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    await running;

    await harness.manager.handleMessage({
      type: "conversation.exportBundle",
      conversationId,
      format: "markdown",
    });
    assert.deepEqual(harness.savedFiles, [saveDialogPath]);
    const markdown = readFileSync(saveDialogPath, "utf8");
    assert.match(markdown, /^# /u);
    assert.match(markdown, /## Evidence gaps/u);

    await harness.manager.handleMessage({
      type: "conversation.exportBundle",
      conversationId,
      format: "sarif",
    });
    const sarif = JSON.parse(readFileSync(saveDialogPath, "utf8"));
    assert.equal(sarif.version, "2.1.0");
    assert.equal(sarif.runs[0].tool.driver.name, "Bachata");

    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.exportBundle",
        conversationId,
        format: "csv",
      }),
      /invalid format/u,
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("attachment snapshots include webview-safe preview URIs without mutating runtime metadata", async () => {
  const attachment = {
    id: "image-1",
    name: "screen.png",
    mimeType: "image/png",
    size: 12,
    relativePath: "attachments/image-1.png",
  };
  const harness = loadHarness(undefined, {
    runtimeAttachments: [attachment],
    webviewUris: true,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await waitFor(() => harness.posted.some((message) =>
      message.type === "conversation.message" &&
      message.message.type === "state.snapshot" &&
      message.message.state.attachments.length === 1,
    ));
    const snapshot = harness.posted.findLast((message) =>
      message.type === "conversation.message" &&
      message.message.type === "state.snapshot" &&
      message.message.state.attachments.length === 1,
    );
    assert.match(snapshot.message.state.attachments[0].previewUri, /^webview:/u);
    assert.equal(snapshot.message.state.attachments[0].previewUri.endsWith("attachments/image-1.png"), true);
    assert.equal(harness.runtimeInstances[0].state.attachments[0].previewUri, undefined);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("failed conversation rename retains the live and persisted title", async () => {
  let failRename = false;
  const harness = loadHarness(undefined, {
    beforeWorkspaceStateUpdate: ({ key, value }) => {
      if (
        failRename &&
        key === "bachata.conversationManager.v1" &&
        value?.conversations?.some((conversation) =>
          conversation.title.includes("Renamed run")
        )
      ) {
        throw new Error("conversation rename persistence failed");
      }
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    const originalTitle = harness.manager.getState().conversations.find(
      (conversation) => conversation.id === conversationId,
    ).title;
    failRename = true;

    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.rename",
        conversationId,
        title: "Renamed run",
      }),
      /conversation rename persistence failed/,
    );

    const liveTitle = harness.manager.getState().conversations.find(
      (conversation) => conversation.id === conversationId,
    ).title;
    const persistedTitle = harness.workspaceState
      .get("bachata.conversationManager.v1")
      .conversations.find((conversation) => conversation.id === conversationId)
      .title;
    assert.equal(liveTitle, originalTitle);
    assert.equal(persistedTitle, originalTitle);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("prepared command drafts are transient and consumed once", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Prepared review",
      preparedDraft: "Review src/a.ts",
    });
    assert.equal(
      harness.manager.getState().conversations.find((item) => item.id === conversation.id).preparedDraft,
      "Review src/a.ts",
    );
    await harness.manager.handleMessage({
      type: "conversation.consumePreparedDraft",
      conversationId: conversation.id,
    });
    assert.equal(
      harness.manager.getState().conversations.find((item) => item.id === conversation.id).preparedDraft,
      undefined,
    );
    await harness.manager.handleMessage({
      type: "conversation.consumePreparedDraft",
      conversationId: conversation.id,
    });
    assert.equal(
      harness.manager.getState().conversations.find((item) => item.id === conversation.id).preparedDraft,
      undefined,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("conversation tabs use isolated runtime storage and one shared bridge", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    assert.equal(harness.bridge.startCount, 1);
    assert.equal(harness.runtimeInstances.length, 1);
    assert.equal(
      harness.runtimeInstances[0].options.storageKey,
      "bachata.runtimeState.v5",
    );
    assert.equal(harness.runtimeInstances[0].options.bridge, harness.bridge);

    await harness.manager.handleMessage({ type: "conversation.create" });
    assert.equal(harness.runtimeInstances.length, 2);
    const active = harness.manager.getState().activeConversationId;
    assert.notEqual(active, "default");
    assert.equal(
      harness.runtimeInstances[1].options.storageKey,
      `bachata.conversationRuntime.v2.${active}`,
    );
    assert.match(
      harness.runtimeInstances[1].options.storageDirectory,
      new RegExp(`conversations[\\/]${active}$`),
    );
    assert.equal(harness.runtimeInstances[1].options.bridge, harness.bridge);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("no-workspace runs share a pipeline catalog outside conversation storage", async () => {
  const harness = loadHarness(undefined, { noWorkingDirectory: true });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const sharedDirectory = path.join(harness.storageRoot, "pipelines");
    assert.equal(
      harness.runtimeInstances[0].options.pipelineStorageDirectory,
      sharedDirectory,
    );

    await harness.manager.handleMessage({ type: "conversation.create" });
    assert.equal(harness.runtimeInstances.length, 2);
    assert.equal(
      harness.runtimeInstances[1].options.pipelineStorageDirectory,
      sharedDirectory,
    );
    mkdirSync(sharedDirectory, { recursive: true });
    const pipelineFile = path.join(sharedDirectory, "shared.pipeline.json");
    writeFileSync(pipelineFile, "{}\n");

    const createdConversationId = harness.manager.getState().activeConversationId;
    await harness.manager.handleMessage({
      type: "conversation.close",
      conversationId: createdConversationId,
    });
    assert.equal(existsSync(pipelineFile), true);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("separate managers serialize ordinary sessions over one codebase and share one Browser Bridge owner", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bachata-conversation-contention-"));
  const workingDirectory = path.join(root, "repository");
  const databasePath = path.join(root, "global", "resources.sqlite");
  require("node:fs").mkdirSync(workingDirectory, { recursive: true });
  const firstBroker = createResourceBroker({
    databasePath,
    ownerId: "first-manager",
    pollIntervalMs: 10,
  });
  const secondBroker = createResourceBroker({
    databasePath,
    ownerId: "second-manager",
    pollIntervalMs: 10,
  });
  const configurationValues = {
    maxConcurrentPairRuns: 2,
    maxConcurrentLocalAgents: 4,
    maxConcurrentRepositoryTasks: 2,
    executionSlotTimeoutMs: 2000,
    browserBridgeOwnerTimeoutMs: 80,
    providerCleanupTimeoutMs: 1000,
  };
  const first = loadHarness(undefined, {
    storageRoot: path.join(root, "first"),
    removeStorageOnDispose: false,
    workingDirectory,
    resourceBroker: firstBroker,
    configurationValues,
  });
  const second = loadHarness(undefined, {
    storageRoot: path.join(root, "second"),
    removeStorageOnDispose: false,
    workingDirectory,
    resourceBroker: secondBroker,
    configurationValues,
  });
  const gate = deferred();
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    await second.manager.handleMessage({ type: "manager.ready" });
    assert.equal(first.bridge.startCount + second.bridge.startCount, 1);
    first.runtimeInstances[0].beforePipelineRun = async () => gate.promise;
    const firstRun = first.manager.runConversation("default", "first run");
    await waitFor(() => first.runtimeInstances[0].pipelineCalls.length === 1);
    const secondRun = second.manager.runConversation("default", "second run");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(second.runtimeInstances[0].pipelineCalls.length, 0);
    gate.resolve();
    await firstRun;
    await waitFor(() => second.runtimeInstances[0].pipelineCalls.length === 1);
    await secondRun;
    assert.equal(first.runtimeInstances[0].shutdownIdleProvidersCalls, 1);
    assert.equal(second.runtimeInstances[0].shutdownIdleProvidersCalls, 1);
  } finally {
    gate.resolve();
    first.subscription.dispose();
    second.subscription.dispose();
    await first.manager.dispose().catch(() => undefined);
    await second.manager.dispose().catch(() => undefined);
    await firstBroker.dispose().catch(() => undefined);
    await secondBroker.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});




test("a replaced workspace owner cannot mutate manager or runtime state", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bachata-workspace-fence-manager-"));
  const databasePath = path.join(root, "global", "resources.sqlite");
  const storageRoot = path.join(root, "workspace-state");
  const firstBroker = createResourceBroker({
    databasePath,
    ownerId: "workspace-owner-first",
    pollIntervalMs: 10,
    heartbeatIntervalMs: 10_000,
    staleOwnerMs: 20_000,
  });
  const secondBroker = createResourceBroker({
    databasePath,
    ownerId: "workspace-owner-second",
    pollIntervalMs: 10,
    heartbeatIntervalMs: 10_000,
    staleOwnerMs: 20_000,
  });
  const resource = { key: "workspace-state-writer:test", capacity: 1 };
  const firstLease = await firstBroker.acquire({
    resources: [resource],
    deadlineAt: Date.now() + 1000,
  });
  const first = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: false,
    workspaceLease: firstLease,
  });
  let second;
  let secondLease;
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    const database = new DatabaseSync(databasePath);
    database.prepare("DELETE FROM resource_owner WHERE owner_id = ?").run("workspace-owner-first");
    database.close();
    secondLease = await secondBroker.acquire({
      resources: [resource],
      deadlineAt: Date.now() + 1000,
    });
    second = loadHarness(undefined, {
      storageRoot,
      removeStorageOnDispose: false,
      workspaceLease: secondLease,
    });
    await second.manager.handleMessage({ type: "manager.ready" });

    await assert.rejects(
      first.manager.createConversation({ title: "stale mutation" }),
      /ownership was replaced or expired/u,
    );
    assert.throws(
      () => first.runtimeInstances[0].options.assertWritable(),
      /ownership was replaced or expired/u,
    );
  } finally {
    first.subscription.dispose();
    second?.subscription.dispose();
    await first.manager.dispose().catch(() => undefined);
    await second?.manager.dispose().catch(() => undefined);
    await firstLease.release().catch(() => undefined);
    await secondLease?.release().catch(() => undefined);
    await firstBroker.dispose().catch(() => undefined);
    await secondBroker.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("parallel local-agent demand cannot exceed the configured hard maximum", async () => {
  const harness = loadHarness(undefined, {
    configurationValues: { maxConcurrentLocalAgents: 1 },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.selectedPipelineDefinition = {
      steps: [{
        id: "parallel",
        type: "agent",
        enabled: true,
        parallel: true,
        participants: ["codex", "claude"],
      }],
    };
    await assert.rejects(
      harness.manager.runConversation("default", "Run both local agents"),
      /needs 2 concurrent local provider processes.*maxConcurrentLocalAgents is 1/u,
    );
    assert.equal(runtime.pipelineCalls.length, 0);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("role assignments are included in local-agent demand", async () => {
  const harness = loadHarness(undefined, {
    configurationValues: { maxConcurrentLocalAgents: 1 },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.selectedPipelineDefinition = {
      steps: [
        {
          id: "assign",
          type: "assignRoles",
          enabled: true,
          roleAssignments: [
            { role: "lead", agentId: "codex" },
            { role: "worker", agentId: "claude" },
          ],
        },
        {
          id: "parallel",
          type: "agent",
          enabled: true,
          parallel: true,
          participants: ["lead", "worker"],
        },
      ],
    };
    await assert.rejects(
      harness.manager.runConversation("default", "Run assigned local roles"),
      /needs 2 concurrent local provider processes.*maxConcurrentLocalAgents is 1/u,
    );
    assert.equal(runtime.pipelineCalls.length, 0);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("sequential Codex then Claude steps reserve both overlapping provider processes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bachata-agent-demand-"));
  const databasePath = path.join(root, "resources.sqlite");
  const value = createResourceBroker({
    databasePath,
    ownerId: "agent-demand-manager",
    pollIntervalMs: 10,
  });
  const harness = loadHarness(undefined, {
    storageRoot: path.join(root, "manager"),
    removeStorageOnDispose: false,
    resourceBroker: value,
    configurationValues: {
      maxConcurrentPairRuns: 2,
      maxConcurrentLocalAgents: 2,
      maxConcurrentRepositoryTasks: 1,
      executionSlotTimeoutMs: 5_000,
      browserBridgeOwnerTimeoutMs: 100,
    },
  });
  const gate = deferred();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.selectedPipelineDefinition = {
      steps: [
        { id: "codex-step", type: "agent", enabled: true, parallel: false, participants: ["codex"] },
        { id: "claude-step", type: "agent", enabled: true, parallel: false, participants: ["claude"] },
      ],
    };
    runtime.beforePipelineRun = async () => gate.promise;
    const running = harness.manager.runConversation("default", "Run sequentially");
    await waitFor(() => runtime.pipelineCalls.length === 1);
    const database = new DatabaseSync(databasePath);
    const claim = database.prepare(
      "SELECT units, capacity, kind FROM resource_lease_item WHERE resource_key = 'local-agents:global'",
    ).get();
    database.close();
    assert.equal(claim.units, 2);
    assert.equal(claim.capacity, 2);
    assert.equal(claim.kind, "physical");
    gate.resolve();
    await running;
  } finally {
    gate.resolve();
    harness.subscription.dispose();
    await harness.manager.dispose().catch(() => undefined);
    await value.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("sequential Codex agents count as persistent provider processes", async () => {
  const harness = loadHarness(undefined, {
    configurationValues: { maxConcurrentLocalAgents: 1 },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.agents.codex2 = {
      id: "codex2",
      name: "Codex 2",
      adapterType: "codex-app-server",
      status: "idle",
      output: "",
    };
    runtime.state.selectedPipelineDefinition = {
      steps: [
        { id: "first", type: "agent", enabled: true, parallel: false, participants: ["codex"] },
        { id: "second", type: "agent", enabled: true, parallel: false, participants: ["codex2"] },
      ],
    };
    await assert.rejects(
      harness.manager.runConversation("default", "Run sequential Codex agents"),
      /needs 2 concurrent local provider processes.*maxConcurrentLocalAgents is 1/u,
    );
    assert.equal(runtime.pipelineCalls.length, 0);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("sequential Claude agents share one transient provider-process slot", async () => {
  const harness = loadHarness(undefined, {
    configurationValues: { maxConcurrentLocalAgents: 1 },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.agents.claude2 = {
      id: "claude2",
      name: "Claude 2",
      adapterType: "claude-code",
      status: "idle",
      output: "",
    };
    runtime.state.selectedPipelineDefinition = {
      steps: [
        { id: "first", type: "agent", enabled: true, parallel: false, participants: ["claude"] },
        { id: "second", type: "agent", enabled: true, parallel: false, participants: ["claude2"] },
      ],
    };
    await harness.manager.runConversation("default", "Run sequential Claude agents");
    assert.equal(runtime.pipelineCalls.length, 1);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a waiting conversation can be cancelled and never starts after capacity returns", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bachata-wait-cancel-"));
  const workingDirectory = path.join(root, "repository");
  const databasePath = path.join(root, "global", "resources.sqlite");
  require("node:fs").mkdirSync(workingDirectory, { recursive: true });
  const holderBroker = createResourceBroker({
    databasePath,
    ownerId: "wait-holder",
    pollIntervalMs: 10,
  });
  const managerBroker = createResourceBroker({
    databasePath,
    ownerId: "wait-manager",
    pollIntervalMs: 10,
  });
  const identity = await resolveWorkingResourceIdentity(workingDirectory);
  const repositoryClaims = repositoryExecutionClaims(identity, {
    managedTask: false,
    repositoryCapacity: 1,
  }).filter((claim) => claim.kind === "physical");
  const heldLease = await holderBroker.acquire({
    resources: repositoryClaims,
    deadlineAt: Date.now() + 1000,
    label: "hold repository",
  });
  const harness = loadHarness(undefined, {
    storageRoot: path.join(root, "manager"),
    removeStorageOnDispose: false,
    workingDirectory,
    resourceBroker: managerBroker,
    configurationValues: {
      maxConcurrentPairRuns: 2,
      maxConcurrentLocalAgents: 4,
      maxConcurrentRepositoryTasks: 1,
      executionSlotTimeoutMs: 2000,
      browserBridgeOwnerTimeoutMs: 100,
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const run = harness.manager.runConversation("default", "cancel this waiting run");
    await waitFor(() => harness.manager.getState().conversations[0].waitingForResources === true);
    await harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: "default",
      message: { type: "run.interrupt" },
    });
    await assert.rejects(run, (error) => error?.name === "ResourceAcquireCancelledError");
    assert.equal(harness.manager.getState().conversations[0].waitingForResources, false);
    await heldLease.release();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(harness.runtimeInstances[0].pipelineCalls.length, 0);
  } finally {
    await heldLease.release().catch(() => undefined);
    harness.subscription.dispose();
    await harness.manager.dispose().catch(() => undefined);
    await holderBroker.dispose().catch(() => undefined);
    await managerBroker.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("losing Browser Bridge ownership closes the local server", async () => {
  const controller = new AbortController();
  let releaseCount = 0;
  const lease = {
    id: "browser-lease",
    resources: [{ key: "browser-bridge:profile", kind: "physical" }],
    fences: { "browser-bridge:profile": 1 },
    signal: controller.signal,
    isValid: () => !controller.signal.aborted,
    assertValid: () => {
      if (controller.signal.aborted) {
        throw new Error("Browser Bridge ownership was lost");
      }
    },
    release: async () => {
      releaseCount += 1;
    },
    quarantine: async () => undefined,
  };
  const harness = loadHarness(undefined, {
    resourceBroker: {
      acquire: async (request) => {
        assert.equal(request.resources[0].key, "browser-bridge:profile");
        return lease;
      },
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    assert.equal(harness.bridge.startCount, 1);
    controller.abort(new Error("replaced"));
    await waitFor(() => harness.bridge.closeCount === 1);
    assert.equal(releaseCount, 0);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose().catch(() => undefined);
  }
});

test("a surviving manager can acquire Browser Bridge ownership without reloading", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bachata-bridge-failover-"));
  const databasePath = path.join(root, "global", "resources.sqlite");
  const firstBroker = createResourceBroker({
    databasePath,
    ownerId: "bridge-owner-first",
    pollIntervalMs: 10,
  });
  const secondBroker = createResourceBroker({
    databasePath,
    ownerId: "bridge-owner-second",
    pollIntervalMs: 10,
  });
  const options = {
    removeStorageOnDispose: false,
    configurationValues: { browserBridgeOwnerTimeoutMs: 100 },
  };
  const first = loadHarness(undefined, {
    ...options,
    storageRoot: path.join(root, "first"),
    resourceBroker: firstBroker,
  });
  const second = loadHarness(undefined, {
    ...options,
    storageRoot: path.join(root, "second"),
    resourceBroker: secondBroker,
  });
  let owner;
  let standby;
  try {
    await Promise.all([
      first.manager.handleMessage({ type: "manager.ready" }),
      second.manager.handleMessage({ type: "manager.ready" }),
    ]);
    await waitFor(() => first.bridge.startCount + second.bridge.startCount === 1);
    owner = first.bridge.startCount === 1 ? first : second;
    standby = owner === first ? second : first;
    assert.equal(standby.bridge.startCount, 0);

    owner.subscription.dispose();
    await owner.manager.dispose();
    await standby.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: "default",
      message: { type: "bridge.discover" },
    });
    assert.equal(standby.bridge.startCount, 1);
  } finally {
    first.subscription.dispose();
    second.subscription.dispose();
    await first.manager.dispose().catch(() => undefined);
    await second.manager.dispose().catch(() => undefined);
    await firstBroker.dispose().catch(() => undefined);
    await secondBroker.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("provider cleanup failure quarantines physical codebase resources but releases abstract capacity", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bachata-provider-cleanup-quarantine-"));
  const workingDirectory = path.join(root, "repository");
  const databasePath = path.join(root, "global", "resources.sqlite");
  require("node:fs").mkdirSync(workingDirectory, { recursive: true });
  const broker = createResourceBroker({
    databasePath,
    ownerId: "cleanup-failure-manager",
    pollIntervalMs: 10,
  });
  const observer = createResourceBroker({
    databasePath,
    ownerId: "cleanup-failure-observer",
    pollIntervalMs: 10,
  });
  const harness = loadHarness(undefined, {
    storageRoot: path.join(root, "manager"),
    removeStorageOnDispose: false,
    workingDirectory,
    resourceBroker: broker,
    providerShutdownError: new Error("provider remained alive"),
    configurationValues: {
      maxConcurrentPairRuns: 1,
      maxConcurrentLocalAgents: 2,
      maxConcurrentRepositoryTasks: 1,
      executionSlotTimeoutMs: 1000,
      providerCleanupTimeoutMs: 1000,
      browserBridgeOwnerTimeoutMs: 100,
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await assert.rejects(
      harness.manager.runConversation("default", "run with failed cleanup"),
      /provider remained alive/u,
    );
    const identity = await resolveWorkingResourceIdentity(workingDirectory);
    const physicalClaims = repositoryExecutionClaims(identity, {
      managedTask: false,
      repositoryCapacity: 1,
    });
    assert.equal(
      broker.listQuarantine().some((item) =>
        physicalClaims.some((claim) => claim.key === item.key)),
      true,
    );
    assert.equal(
      broker.listQuarantine().some((item) => item.key === "local-agents:global"),
      true,
    );
    const abstractLease = await observer.acquire({
      resources: [{ key: "bachata-runs:global", capacity: 1 }],
      deadlineAt: Date.now() + 500,
      label: "abstract capacity after cleanup failure",
    });
    await abstractLease.release();
    await assert.rejects(
      observer.acquire({
        resources: [{ key: "local-agents:global", units: 2, capacity: 2, kind: "physical" }],
        deadlineAt: Date.now() + 200,
        label: "quarantined provider capacity",
      }),
      ResourceQuarantinedError,
    );
    await assert.rejects(
      observer.acquire({
        resources: physicalClaims,
        deadlineAt: Date.now() + 200,
        label: "quarantined codebase",
      }),
      ResourceQuarantinedError,
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose().catch(() => undefined);
    await broker.dispose().catch(() => undefined);
    await observer.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Browser Bridge close failure quarantines cross-window ownership", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bachata-bridge-close-quarantine-"));
  const broker = createResourceBroker({
    databasePath: path.join(root, "global", "resources.sqlite"),
    ownerId: "bridge-close-manager",
    pollIntervalMs: 10,
  });
  const harness = loadHarness(undefined, {
    storageRoot: path.join(root, "manager"),
    removeStorageOnDispose: false,
    resourceBroker: broker,
    bridgeCloseError: new Error("bridge process remained alive"),
    configurationValues: {
      browserBridgeOwnerTimeoutMs: 100,
      browserBridgeCloseTimeoutMs: 1000,
      managerDisposeTimeoutMs: 1000,
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    assert.equal(harness.bridge.startCount, 1);
    harness.subscription.dispose();
    await assert.rejects(
      harness.manager.dispose(),
      /bridge process remained alive/u,
    );
    assert.equal(
      broker.listQuarantine().some((item) => item.key === "browser-bridge:profile"),
      true,
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose().catch(() => undefined);
    await broker.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("manager disposal reports runtime cleanup failures after attempting remaining shutdown work", async () => {
  const harness = loadHarness(undefined, {
    runtimeDisposeError: new Error("runtime cleanup remained uncertain"),
  });
  await harness.manager.handleMessage({ type: "manager.ready" });
  harness.subscription.dispose();
  await assert.rejects(
    harness.manager.dispose(),
    /runtime cleanup remained uncertain/u,
  );
  assert.equal(harness.bridge.closeCount, 1);
  assert.equal(harness.runtimeInstances[0].disposed, true);
});

test("a running conversation does not block switching to another tab", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({ type: "conversation.create" });
    const runningId = harness.manager.getState().activeConversationId;
    const run = harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: runningId,
      message: {
        type: "pipeline.run",
        prompt: "Review and implement the auth changes",
        attachmentIds: [],
      },
    });
    await waitFor(() => harness.runtimeInstances[1].state.running);

    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: "default",
    });
    assert.equal(harness.manager.getState().activeConversationId, "default");
    assert.match(
      harness.manager.getState().conversations.find((item) => item.id === runningId)
        .title,
      /^\[R[2-9A-HJ-NP-Z]{8}\] Review and implement the auth changes$/,
    );

    harness.runtimeInstances[1].run.resolve();
    await run;
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("inactive conversation activity increments unread state and selecting clears it", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({ type: "conversation.create" });
    const secondId = harness.manager.getState().activeConversationId;
    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: "default",
    });

    await harness.runtimeInstances[1].emit({
      type: "transcript.append",
      entry: {
        id: "answer-1",
        kind: "answer",
        agentId: "claude",
        text: "Reviewed",
        createdAt: new Date().toISOString(),
      },
    });
    assert.equal(
      harness.manager.getState().conversations.find((item) => item.id === secondId)
        .unread,
      1,
    );

    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: secondId,
    });
    assert.equal(
      harness.manager.getState().conversations.find((item) => item.id === secondId)
        .unread,
      0,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a running conversation cannot be closed", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.running = true;
    runtime.state.workflowStatus = "running";
    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.close",
        conversationId: "default",
      }),
      /Interrupt .* before/u,
    );
    assert.equal(harness.manager.getState().conversations.length, 1);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
    assert.equal(harness.bridge.closeCount, 1);
  }
});

test("closing is rejected while a runtime message is entering the runtime", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.delayBeforeRun = true;
    const run = harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: "default",
      message: {
        type: "pipeline.run",
        prompt: "Inspect the close race",
        attachmentIds: [],
      },
    });
    await waitFor(() =>
      runtime.messages.some((message) => message.type === "pipeline.run"),
    );

    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.close",
        conversationId: "default",
      }),
      /Interrupt .* before/u,
    );

    runtime.beforeRun.resolve();
    runtime.run.resolve();
    await run;
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("invalid persisted conversation ids are discarded before storage paths are built", async () => {
  const harness = loadHarness({
    activeConversationId: "../outside",
    conversations: [
      {
        id: "../outside",
        title: "Unsafe",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        running: false,
        workflowStatus: "idle",
        unread: 0,
      },
    ],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    assert.deepEqual(
      harness.manager.getState().conversations.map((item) => item.id),
      ["default"],
    );
    assert.equal(harness.runtimeInstances[0].options.storageDirectory, harness.storageRoot);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("direct agent activity updates the tab presence state", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.agents.codex.status = "running";
    await runtime.emit({
      type: "agent.patch",
      agentId: "codex",
      patch: { status: "running" },
    });
    assert.equal(harness.manager.getState().conversations[0].running, true);

    runtime.state.agents.codex.status = "idle";
    await runtime.emit({
      type: "agent.patch",
      agentId: "codex",
      patch: { status: "idle" },
    });
    assert.equal(harness.manager.getState().conversations[0].running, false);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});


test("persisted active work is restored as interrupted without creating inactive runtimes", async () => {
  const inactiveId = "70f79d31-bbde-48e8-b07d-c456a6784782";
  const now = new Date().toISOString();
  const harness = loadHarness({
    activeConversationId: "default",
    conversations: [
      {
        id: "default",
        title: "Active",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "idle",
        unread: 0,
      },
      {
        id: inactiveId,
        title: "Interrupted on reload",
        createdAt: now,
        updatedAt: now,
        running: true,
        workflowStatus: "paused",
        unread: 2,
      },
    ],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    assert.equal(harness.runtimeInstances.length, 1);
    const restored = harness.manager
      .getState()
      .conversations.find((item) => item.id === inactiveId);
    assert.equal(restored.running, false);
    assert.equal(restored.workflowStatus, "interrupted");
    assert.equal(restored.unread, 2);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("rejected auxiliary commands do not fabricate workflow state", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({ type: "conversation.create" });
    const secondId = harness.manager.getState().activeConversationId;
    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: "default",
    });
    harness.runtimeInstances[1].throwOnMessageType = "availability.check";

    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.runtime",
        conversationId: secondId,
        message: { type: "availability.check" },
      }),
      /Simulated availability\.check failure/,
    );

    assert.equal(harness.manager.getState().activeConversationId, "default");
    const failed = harness.manager
      .getState()
      .conversations.find((item) => item.id === secondId);
    assert.equal(failed.running, false);
    assert.equal(failed.workflowStatus, "idle");
    assert.equal(failed.unread, 0);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("an archived persisted active room is not activated", async () => {
  const now = new Date().toISOString();
  const activeId = "70f79d31-bbde-48e8-b07d-c456a6784782";
  const harness = loadHarness({
    activeConversationId: "default",
    conversations: [
      {
        id: "default",
        title: "Archived",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "idle",
        unread: 0,
        archived: true,
      },
      {
        id: activeId,
        title: "Available",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "idle",
        unread: 0,
        archived: false,
      },
    ],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    assert.equal(harness.manager.getState().activeConversationId, activeId);
    assert.equal(harness.runtimeInstances.length, 1);
    assert.match(harness.runtimeInstances[0].options.storageDirectory, new RegExp(`${activeId}$`));
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("all archived persisted rooms are retained and a new active room is created", async () => {
  const now = new Date().toISOString();
  const archivedId = "70f79d31-bbde-48e8-b07d-c456a6784782";
  const harness = loadHarness({
    activeConversationId: archivedId,
    conversations: [
      {
        id: archivedId,
        title: "Archived",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "idle",
        unread: 0,
        archived: true,
      },
    ],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const state = harness.manager.getState();
    assert.equal(state.conversations.some((item) => item.id === archivedId && item.archived), true);
    assert.match(state.activeConversationId, /^R[2-9A-HJ-NP-Z]{8}$/);
    assert.equal(
      state.conversations.find((item) => item.id === state.activeConversationId).archived,
      false,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("archived rooms open read-only and reject runtime mutations", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "conversation.archive",
      conversationId: "default",
      archived: true,
    });
    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: "default",
    });
    assert.equal(harness.manager.getState().activeConversationId, "default");

    await harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: "default",
      message: { type: "transcript.loadOlder" },
    });
    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.runtime",
        conversationId: "default",
        message: { type: "availability.check" },
      }),
      /Archived conversations are read-only/,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("interaction submissions require valid explicit responses", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    const responsePromise = runtime.options.requestInteraction({
      sourceKey: "permission-validation",
      kind: "permission",
      title: "Permission",
      prompt: "Allow this operation?",
      options: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
      allowFreeText: false,
      secret: false,
    });
    await waitFor(() => harness.manager.getState().interactions.length === 1);
    const interactionRef = harness.manager.getState().interactions[0].interactionRef;

    await assert.rejects(
      harness.manager.handleMessage({
        type: "interaction.submit",
        interactionRef,
        selected: [],
        freeText: "",
      }),
      /Permission requires one choice/,
    );
    await assert.rejects(
      harness.manager.handleMessage({
        type: "interaction.submit",
        interactionRef,
        selected: ["other"],
        freeText: "",
      }),
      /Unknown option/,
    );
    assert.equal(harness.manager.getState().interactions.length, 1);

    const validSubmission = {
      type: "interaction.submit",
      interactionRef,
      selected: ["allow"],
      freeText: "",
    };
    await harness.manager.handleMessage(validSubmission);
    await harness.manager.handleMessage(validSubmission);
    assert.deepEqual(await responsePromise, {
      selected: ["allow"],
      freeText: "",
      source: "user",
    });
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("execution checklists can continue with no selected work", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    const responsePromise = runtime.options.requestInteraction({
      sourceKey: "empty-checklist",
      kind: "executionChecklist",
      title: "Checklist",
      prompt: "Select work",
      options: [{ id: "task-1", label: "Task 1" }],
      allowFreeText: true,
      secret: false,
    });
    await waitFor(() => harness.manager.getState().interactions.length === 1);
    const interactionRef = harness.manager.getState().interactions[0].interactionRef;

    await harness.manager.handleMessage({
      type: "interaction.submit",
      interactionRef,
      selected: [],
      freeText: "",
    });
    assert.deepEqual(await responsePromise, {
      selected: [],
      freeText: "",
      source: "user",
    });
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});


test("semantic timeout uses the persisted Lead fallback descriptor", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    const responsePromise = runtime.options.requestInteraction({
      sourceKey: "semantic-restart-safe",
      kind: "semanticQuestion",
      title: "Strategy",
      prompt: "Choose one",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
      allowFreeText: false,
      secret: false,
      timeoutMs: 20,
      fallback: {
        type: "lead",
        originAgentId: "claude",
        title: "Strategy",
        prompt: "Choose one",
        options: [
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ],
        allowFreeText: false,
      },
    });
    const response = await responsePromise;
    assert.deepEqual(response, {
      selected: ["a"],
      freeText: "",
      source: "lead",
    });
    assert.deepEqual(runtime.leadFallbackCalls, [
      {
        originAgentId: "claude",
        request: {
          title: "Strategy",
          prompt: "Choose one",
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          allowFreeText: false,
        },
      },
    ]);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("semantic timeout falls back deterministically when Lead is unavailable", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.leadFallbackError = new Error("Lead unavailable");
    const response = await runtime.options.requestInteraction({
      sourceKey: "semantic-lead-unavailable",
      kind: "semanticQuestion",
      title: "Strategy",
      prompt: "Choose one",
      options: [
        { id: "a", label: "A" },
        { id: "cancel", label: "Cancel" },
      ],
      allowFreeText: false,
      secret: false,
      timeoutMs: 20,
      fallback: {
        type: "lead",
        originAgentId: "claude",
        title: "Strategy",
        prompt: "Choose one",
        options: [
          { id: "a", label: "A" },
          { id: "cancel", label: "Cancel" },
        ],
        allowFreeText: false,
      },
    });
    assert.deepEqual(response, {
      selected: ["cancel"],
      freeText: "",
      source: "timeout",
    });
    assert.equal(runtime.leadFallbackCalls.length, 1);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("interrupt cancels persisted interactions and releases waiting provider hooks", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    const responsePromise = runtime.options.requestInteraction({
      kind: "singleSelect",
      title: "Claude permission",
      prompt: "Allow this operation?",
      options: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
      allowFreeText: false,
      secret: false,
      timeoutMs: 60_000,
    });
    await waitFor(() => harness.manager.getState().interactions.length === 1);

    await harness.manager.interruptConversation("default");
    const response = await responsePromise;

    assert.deepEqual(response, {
      selected: [],
      freeText: "",
      source: "cancel",
    });
    assert.equal(harness.manager.getState().interactions.length, 0);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a second execution never inherits the first execution's terminal evidence", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    const runtime = harness.runtimeInstances[0];
    runtime.state.transcript.push({
      id: "error-1",
      kind: "error",
      text: "Verification command exited with 1",
      createdAt: new Date().toISOString(),
    });

    await harness.manager.runConversation(conversationId, "first execution");
    const first = harness.manager.getState().resultsByConversation[conversationId];
    assert.deepEqual(first.unresolvedRisks, ["Verification command exited with 1"]);
    assert.match(first.executionRef, /^E\d+$/u);

    runtime.state.transcript.length = 0;
    await harness.manager.runConversation(conversationId, "second execution");
    const second = harness.manager.getState().resultsByConversation[conversationId];
    assert.deepEqual(second.unresolvedRisks, []);
    assert.deepEqual(second.recoveredErrors, []);
    assert.notEqual(second.executionRef, first.executionRef);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("pipeline iterations use fresh sessions, run sequentially, and persist exact Bachata bindings", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "ORCH-4",
      pipelineId: "cross-reference-development",
      workingDirectory: "/workspace/.bachata/worktrees/ORCH-4",
      orchestrationRunId: "todo-run-1",
      orchestrationTaskId: "ORCH-4",
      orchestrationBranch: "bachata/task/orch-4",
      orchestrationBaseCommit: "abc123",
      orchestrationPaths: ["src/orchestrator", "tests"],
    });
    const runtime = harness.runtimeInstances.at(-1);
    const result = await harness.manager.runConversation(
      conversation.id,
      "Fix stop and resume",
      ["attachment-1"],
      2,
    );

    assert.equal(result.iterations.length, 2);
    assert.deepEqual(runtime.pipelineCalls, [
      { prompt: "Fix stop and resume", attachmentIds: ["attachment-1"] },
      { prompt: "Fix stop and resume", attachmentIds: ["attachment-1"] },
    ]);
    assert.equal(
      runtime.messages.filter((message) => message.type === "session.reset").length,
      2,
    );

    const database = new DatabaseSync(path.join(harness.storageRoot, "bachata-state.sqlite"));
    const pairs = database.prepare(`
      SELECT task_id, working_root, worktree_path, branch, base_commit, scope_json
      FROM pairs WHERE run_ref = ? ORDER BY created_at, pair_ref
    `).all(conversation.runRef);
    assert.equal(pairs.length, 2);
    for (const pair of pairs) {
      assert.equal(pair.task_id, "ORCH-4");
      assert.equal(pair.working_root, "/workspace/.bachata/worktrees/ORCH-4");
      assert.equal(pair.worktree_path, "/workspace/.bachata/worktrees/ORCH-4");
      assert.equal(pair.branch, "bachata/task/orch-4");
      assert.equal(pair.base_commit, "abc123");
      assert.deepEqual(JSON.parse(pair.scope_json), {
        taskId: "ORCH-4",
        paths: ["src/orchestrator", "tests"],
      });
    }
    database.close();
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("completed checklist work does not reacquire the released parent capacity lease", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bachata-checklist-capacity-"));
  const workingDirectory = path.join(root, "workspace");
  require("node:fs").mkdirSync(workingDirectory, { recursive: true });
  const databasePath = path.join(root, "global", "resources.sqlite");
  const managerBroker = createResourceBroker({
    databasePath,
    ownerId: "checklist-parent-manager",
    pollIntervalMs: 10,
  });
  const observer = createResourceBroker({
    databasePath,
    ownerId: "checklist-child-observer",
    pollIntervalMs: 10,
  });
  const harness = loadHarness(undefined, {
    storageRoot: path.join(root, "manager"),
    removeStorageOnDispose: false,
    workingDirectory,
    resourceBroker: managerBroker,
    configurationValues: {
      maxConcurrentPairRuns: 1,
      maxConcurrentLocalAgents: 2,
      maxConcurrentRepositoryTasks: 1,
      executionSlotTimeoutMs: 1_000,
      browserBridgeOwnerTimeoutMs: 100,
    },
  });
  let competingLease;
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    const identity = await resolveWorkingResourceIdentity(workingDirectory);
    harness.manager.setChecklistExecutor(async () => {
      competingLease = await observer.acquire({
        resources: [
          { key: "bachata-runs:global", capacity: 1 },
          ...repositoryExecutionClaims(identity, {
            managedTask: false,
            repositoryCapacity: 1,
          }),
          { key: "local-agents:global", units: 2, capacity: 2, kind: "physical" },
        ],
        deadlineAt: Date.now() + 500,
        label: "checklist child capacity",
      });
      return {
        runRef: "RCHILDCAP",
        status: "completed",
        workingDirectory,
        integrationBranch: "bachata/integration/checklist-capacity",
      };
    });
    runtime.beforePipelineRun = async () => {
      await runtime.options.executeChecklist({
        step: {
          id: "execute-checklist",
          type: "executeChecklist",
          name: "Execute checklist",
          enabled: true,
          humanGate: "none",
          inputName: "executionChecklist",
          pipelineId: "todo-implementation",
          checks: [],
        },
        checklist: {
          issues: [{ id: "ISSUE-1", title: "Issue", details: "Fix it", dependencies: [], paths: ["src"] }],
          selectedIssueIds: ["ISSUE-1"],
          userNote: "",
          selectionSource: "user",
        },
        signal: new AbortController().signal,
      });
    };

    const result = await harness.manager.runConversation("default", "Execute the checklist");
    assert.equal(result.pipeline.status, "completed");
    assert.ok(competingLease);
    assert.equal(runtime.shutdownIdleProvidersCalls >= 1, true);
  } finally {
    await competingLease?.release().catch(() => undefined);
    harness.subscription.dispose();
    await harness.manager.dispose().catch(() => undefined);
    await managerBroker.dispose().catch(() => undefined);
    await observer.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("TODO task pipelines reject nested checklist orchestration immediately", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Managed TODO task",
      pipelineId: "cross-reference-development",
      workingDirectory: "/workspace",
      orchestrationTaskId: "TASK-1",
      orchestrationRunId: "RUN-1",
    });
    const runtime = harness.runtimeInstances.at(-1);
    harness.manager.setChecklistExecutor(async () => {
      throw new Error("nested executor must not be called");
    });

    await assert.rejects(
      runtime.options.executeChecklist({
        step: {
          id: "execute-checklist",
          type: "executeChecklist",
          name: "Execute checklist",
          enabled: true,
          humanGate: "none",
          inputName: "executionChecklist",
          pipelineId: "todo-implementation",
          checks: [],
        },
        checklist: {
          issues: [{ id: "ISSUE-1", title: "Issue", details: "Fix it", dependencies: [], paths: ["src"] }],
          selectedIssueIds: ["ISSUE-1"],
          userNote: "",
          selectionSource: "user",
        },
        signal: new AbortController().signal,
      }),
      /Nested checklist orchestration is not supported/u,
    );
    assert.equal(conversation.orchestrationTaskId, "TASK-1");
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a completed checklist run becomes the working directory for the next iteration", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Iterative implementation",
      pipelineId: "cross-reference-development",
      workingDirectory: "/workspace",
    });
    const runtime = harness.runtimeInstances.at(-1);
    runtime.state.selectedPipelineDefinition = {
      roles: [{ id: "lead" }, { id: "worker" }],
    };
    const integrationDirectories = [
      "/workspace/.bachata/integration/iteration-1",
      "/workspace/.bachata/integration/iteration-2",
    ];
    let checklistRun = 0;
    harness.manager.setChecklistExecutor(async () => ({
      runRef: `RCHILD${String(checklistRun + 1)}`,
      status: "completed",
      workingDirectory: integrationDirectories[checklistRun++],
      integrationBranch: `bachata/integration/iteration-${String(checklistRun)}`,
    }));
    runtime.beforePipelineRun = async () => {
      await runtime.options.executeChecklist({
        step: {
          id: "execute-checklist",
          type: "executeChecklist",
          name: "Execute checklist",
          enabled: true,
          humanGate: "none",
          inputName: "executionChecklist",
          pipelineId: "todo-implementation",
          checks: [],
        },
        checklist: {
          issues: [{ id: "ISSUE-1", title: "Issue", details: "Fix it", dependencies: [], paths: ["src"] }],
          selectedIssueIds: ["ISSUE-1"],
          userNote: "",
          selectionSource: "user",
        },
        signal: new AbortController().signal,
      });
    };

    const result = await harness.manager.runConversation(
      conversation.id,
      "Review and repair twice",
      [],
      2,
    );

    assert.equal(result.iterations.length, 2);
    assert.deepEqual(runtime.configureCalls.slice(-2), [
      {
        pipelineId: "cross-reference-development",
        workingDirectory: integrationDirectories[0],
        preserveHistory: true,
      },
      {
        pipelineId: "cross-reference-development",
        workingDirectory: integrationDirectories[1],
        preserveHistory: true,
      },
    ]);
    assert.equal(
      harness.manager.getState().conversations.find((item) => item.id === conversation.id).workingDirectory,
      integrationDirectories[1],
    );

    const database = new DatabaseSync(path.join(harness.storageRoot, "bachata-state.sqlite"));
    const pairs = database.prepare(`
      SELECT working_root FROM pairs WHERE run_ref = ? ORDER BY created_at, pair_ref
    `).all(conversation.runRef);
    assert.deepEqual(pairs.map((pair) => pair.working_root), [
      "/workspace",
      integrationDirectories[0],
    ]);
    database.close();
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("post-completion working-directory failure finalizes the iteration once", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Failed handoff",
      pipelineId: "cross-reference-development",
      workingDirectory: "/workspace",
    });
    const runtime = harness.runtimeInstances.at(-1);
    runtime.state.selectedPipelineDefinition = {
      roles: [{ id: "lead" }, { id: "worker" }],
    };
    harness.manager.setChecklistExecutor(async () => ({
      runRef: "RCHILDFAIL",
      status: "completed",
      workingDirectory: "/workspace/.bachata/integration/failed-handoff",
      integrationBranch: "bachata/integration/failed-handoff",
    }));
    runtime.beforePipelineRun = async () => {
      await runtime.options.executeChecklist({
        step: {
          id: "execute-checklist",
          type: "executeChecklist",
          name: "Execute checklist",
          enabled: true,
          humanGate: "none",
          inputName: "executionChecklist",
          pipelineId: "todo-implementation",
          checks: [],
        },
        checklist: {
          issues: [{ id: "ISSUE-1", title: "Issue", details: "Fix it", dependencies: [], paths: ["src"] }],
          selectedIssueIds: ["ISSUE-1"],
          userNote: "",
          selectionSource: "user",
        },
        signal: new AbortController().signal,
      });
      runtime.configureError = new Error("Simulated handoff failure");
    };

    await assert.rejects(
      harness.manager.runConversation(conversation.id, "Complete then fail handoff"),
      /Simulated handoff failure/u,
    );

    const summary = harness.manager.getState().conversations.find(
      (item) => item.id === conversation.id,
    );
    assert.equal(summary.running, false);
    assert.equal(summary.workflowStatus, "error");

    const database = new DatabaseSync(path.join(harness.storageRoot, "bachata-state.sqlite"));
    const iteration = database.prepare(`
      SELECT status, completed_at FROM iterations WHERE run_ref = ? ORDER BY created_at DESC LIMIT 1
    `).get(conversation.runRef);
    assert.equal(iteration.status, "failed");
    assert.equal(typeof iteration.completed_at, "string");
    const pair = database.prepare(`
      SELECT status, completed_at FROM pairs WHERE run_ref = ? ORDER BY created_at DESC LIMIT 1
    `).get(conversation.runRef);
    assert.equal(pair.status, "failed");
    assert.equal(typeof pair.completed_at, "string");
    const events = database.prepare(`
      SELECT type, status FROM events WHERE run_ref = ? ORDER BY id
    `).all(conversation.runRef);
    assert.equal(events.filter((event) => event.type === "iteration.failed").length, 1);
    assert.equal(events.filter((event) => event.type === "iteration.completed").length, 0);
    assert.equal(events.filter((event) => event.type === "run.failed").length, 1);
    database.close();
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a failed pipeline iteration stops the run group", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Repeat review",
      pipelineId: "cross-reference-development",
      workingDirectory: "/workspace",
    });
    const runtime = harness.runtimeInstances.at(-1);
    runtime.pipelineResults.push({
      status: "interrupted",
      answers: {},
      outputs: {},
      decisions: [],
      roles: {},
    });

    const result = await harness.manager.runConversation(
      conversation.id,
      "Perform comprehensive code review",
      [],
      4,
    );

    assert.equal(result.iterations.length, 1);
    assert.equal(runtime.pipelineCalls.length, 1);
    assert.equal(
      runtime.messages.filter((message) => message.type === "session.reset").length,
      1,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("one conversation claims execution before any iteration setup can race", async () => {
  const harness = loadHarness();
  const release = deferred();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Atomic execution",
      pipelineId: "cross-reference-development",
      workingDirectory: "/workspace/.bachata/worktrees/TASK_A",
      orchestrationRunId: "todo-run",
      orchestrationTaskId: "TASK_A",
      orchestrationBranch: "bachata/task/TASK_A",
      orchestrationBaseCommit: "abc123",
      orchestrationPaths: ["src"],
    });
    const runtime = harness.runtimeInstances.at(-1);
    runtime.beforePipelineRun = async () => release.promise;

    const first = harness.manager.runConversation(conversation.id, "Run once");
    await waitFor(() => runtime.pipelineCalls.length === 1);
    await assert.rejects(
      harness.manager.runConversation(conversation.id, "Run twice"),
      /already active/u,
    );
    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.archive",
        conversationId: conversation.id,
        archived: true,
      }),
      /Interrupt .* before/u,
    );
    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.close",
        conversationId: conversation.id,
      }),
      /Interrupt .* before/u,
    );
    release.resolve();
    const result = await first;
    assert.equal(result.iterations.length, 1);
    assert.equal(runtime.pipelineCalls.length, 1);
    assert.equal(
      runtime.messages.filter((message) => message.type === "session.reset").length,
      1,
    );

    const database = new DatabaseSync(path.join(harness.storageRoot, "bachata-state.sqlite"));
    assert.equal(
      Number(database.prepare("SELECT COUNT(*) AS count FROM iterations WHERE run_ref = ?").get(conversation.runRef).count),
      1,
    );
    assert.equal(
      Number(database.prepare("SELECT COUNT(*) AS count FROM pairs WHERE run_ref = ?").get(conversation.runRef).count),
      1,
    );
    database.close();
  } finally {
    release.resolve();
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});


test("duplicate creates an independent root conversation", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const child = await harness.manager.createConversation({
      title: "Task history",
      parentConversationId: "default",
    });

    await harness.manager.handleMessage({
      type: "conversation.duplicate",
      conversationId: child.id,
    });

    const state = harness.manager.getState();
    const duplicate = state.conversations.find(
      (conversation) => conversation.id === state.activeConversationId,
    );
    assert.ok(duplicate);
    assert.equal(duplicate.parentConversationId, undefined);
    assert.match(duplicate.title, /Task history copy/u);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("archive, unarchive, and delete operate on the complete run tree", async () => {
  const now = new Date().toISOString();
  const childId = "11111111-1111-4111-8111-111111111111";
  const otherRootId = "22222222-2222-4222-8222-222222222222";
  const harness = loadHarness({
    activeConversationId: otherRootId,
    conversations: [
      {
        id: "default",
        title: "Parent",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "idle",
        unread: 0,
        archived: false,
      },
      {
        id: childId,
        title: "Task",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "completed",
        unread: 0,
        archived: false,
        parentConversationId: "default",
      },
      {
        id: otherRootId,
        title: "Other",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "idle",
        unread: 0,
        archived: false,
      },
    ],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });

    await harness.manager.archiveConversation(childId, true);
    let state = harness.manager.getState();
    assert.equal(state.conversations.find((item) => item.id === "default").archived, true);
    assert.equal(state.conversations.find((item) => item.id === childId).archived, true);
    assert.equal(state.conversations.find((item) => item.id === otherRootId).archived, false);

    await harness.manager.archiveConversation(childId, false);
    state = harness.manager.getState();
    assert.equal(state.conversations.find((item) => item.id === "default").archived, false);
    assert.equal(state.conversations.find((item) => item.id === childId).archived, false);

    await harness.manager.closeConversation(childId);
    state = harness.manager.getState();
    assert.deepEqual(state.conversations.map((item) => item.id), [otherRootId]);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});



test("task conversations cannot be created beneath archived runs", async () => {
  const now = new Date().toISOString();
  const activeRootId = "33333333-3333-4333-8333-333333333333";
  const harness = loadHarness({
    activeConversationId: activeRootId,
    conversations: [
      {
        id: "default",
        title: "Archived parent",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "completed",
        unread: 0,
        archived: true,
      },
      {
        id: activeRootId,
        title: "Active root",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "idle",
        unread: 0,
        archived: false,
      },
    ],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await assert.rejects(
      harness.manager.createConversation({
        title: "Rejected task",
        parentConversationId: "default",
      }),
      /Unarchive the parent run/u,
    );
    assert.equal(harness.manager.getState().conversations.length, 2);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("deleting the final active root creates a new unarchived root", async () => {
  const now = new Date().toISOString();
  const archivedRootId = "44444444-4444-4444-8444-444444444444";
  const harness = loadHarness({
    activeConversationId: "default",
    conversations: [
      {
        id: "default",
        title: "Only active root",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "idle",
        unread: 0,
        archived: false,
      },
      {
        id: archivedRootId,
        title: "Archived root",
        createdAt: now,
        updatedAt: now,
        running: false,
        workflowStatus: "completed",
        unread: 0,
        archived: true,
      },
    ],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.closeConversation("default");

    const state = harness.manager.getState();
    const active = state.conversations.find(
      (conversation) => conversation.id === state.activeConversationId,
    );
    assert.ok(active);
    assert.equal(active.archived, false);
    assert.equal(active.parentConversationId, undefined);
    assert.notEqual(active.id, archivedRootId);
    assert.equal(
      state.conversations.some(
        (conversation) => conversation.id === archivedRootId && conversation.archived,
      ),
      true,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("pipeline prompts are acknowledged only after runtime acceptance", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.run.resolve();

    await harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: "default",
      message: {
        type: "pipeline.run",
        requestId: "run-request-1",
        prompt: "Accepted prompt",
        attachmentIds: [],
        iterationCount: 1,
        delivery: "immediate",
      },
    });

    const result = harness.posted.find(
      (message) =>
        message.type === "conversation.message" &&
        message.conversationId === "default" &&
        message.message?.type === "operation.result" &&
        message.message.requestId === "run-request-1",
    );
    assert.deepEqual(result?.message, {
      type: "operation.result",
      requestId: "run-request-1",
      operation: "pipeline.run",
      status: "accepted",
    });
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("preflight rejection leaves run history, title, sessions, and input unchanged", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.preflightError = new Error("Pipeline capability validation failed: attachments unavailable");
    const before = structuredClone(
      harness.manager.getState().conversations.find((item) => item.id === "default"),
    );

    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.runtime",
        conversationId: "default",
        message: {
          type: "pipeline.run",
          requestId: "rejected-before-acceptance",
          prompt: "This must remain only in the composer",
          attachmentIds: [],
          iterationCount: 2,
          delivery: "immediate",
        },
      }),
      /Pipeline capability validation failed/u,
    );

    const after = harness.manager.getState().conversations.find(
      (item) => item.id === "default",
    );
    assert.deepEqual(after, before);
    assert.deepEqual(
      runtime.preflightCalls.map((call) => ({
        prompt: call.prompt,
        attachmentIds: call.attachmentIds,
      })),
      [{ prompt: "This must remain only in the composer", attachmentIds: [] }],
    );
    assert.equal(
      runtime.messages.filter((message) => message.type === "session.reset").length,
      0,
    );
    assert.equal(runtime.pipelineCalls.length, 0);
    assert.equal(
      harness.posted.some(
        (message) =>
          message.type === "conversation.message" &&
          message.message?.type === "operation.result" &&
          message.message.requestId === "rejected-before-acceptance" &&
          message.message.status === "accepted",
      ),
      false,
    );

    const database = new DatabaseSync(path.join(harness.storageRoot, "bachata-state.sqlite"));
    const run = database.prepare("SELECT run_ref FROM runs WHERE run_ref = ?").get(before.runRef);
    assert.ok(run);
    assert.equal(
      Number(
        database.prepare("SELECT COUNT(*) AS count FROM iterations WHERE run_ref = ?").get(before.runRef).count,
      ),
      0,
    );
    assert.equal(
      Number(
        database.prepare("SELECT COUNT(*) AS count FROM events WHERE run_ref = ? AND type = 'run.started'").get(before.runRef).count,
      ),
      0,
    );
    database.close();
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("duplicate preserves a selected pipeline when no working folder is selected", async () => {
  const harness = loadHarness(undefined, { noWorkingDirectory: true });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const source = await harness.manager.createConversation({
      title: "Pipeline-only run",
      pipelineId: "cross-reference-development",
    });

    await harness.manager.handleMessage({
      type: "conversation.duplicate",
      conversationId: source.id,
    });

    const state = harness.manager.getState();
    const duplicate = state.conversations.find(
      (conversation) => conversation.id === state.activeConversationId,
    );
    assert.ok(duplicate);
    assert.notEqual(duplicate.id, source.id);
    assert.equal(duplicate.parentConversationId, undefined);
    assert.equal(duplicate.selectedPipelineId, "cross-reference-development");
    assert.equal(duplicate.workingDirectory, undefined);
    assert.deepEqual(harness.runtimeInstances.at(-1).configureCalls, [
      { pipelineId: "cross-reference-development" },
    ]);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("duplicate drops a pipeline scope whose workspace root was removed", async () => {
  const currentRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-duplicate-current-root-"));
  const removedRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-duplicate-removed-root-"));
  const now = new Date().toISOString();
  const staleId = "11111111-1111-4111-8111-111111111111";
  const harness = loadHarness({
    activeConversationId: "default",
    conversations: [
      {
        id: "default",
        title: "Current run",
        createdAt: now,
        updatedAt: now,
        workingDirectory: currentRoot,
        selectedPipelineId: "cross-reference-development",
      },
      {
        id: staleId,
        title: "Removed workspace pipeline",
        createdAt: now,
        updatedAt: now,
        selectedPipelineId: "removed-root-pipeline",
        workingDirectory: removedRoot,
        pipelineScopeRoot: removedRoot,
      },
    ],
  }, {
    noWorkingDirectory: true,
    workspaceFolders: [{ uri: { fsPath: currentRoot } }],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "conversation.duplicate",
      conversationId: staleId,
    });

    const state = harness.manager.getState();
    const duplicate = state.conversations.find(
      (conversation) => conversation.id === state.activeConversationId,
    );
    assert.ok(duplicate);
    assert.equal(duplicate.selectedPipelineId, "review-only");
    assert.equal(duplicate.workingDirectory, undefined);
    assert.equal(duplicate.pipelineScopeRoot, undefined);
    assert.deepEqual(harness.runtimeInstances.at(-1).configureCalls, [
      { pipelineId: "review-only" },
    ]);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
    rmSync(currentRoot, { recursive: true, force: true });
    rmSync(removedRoot, { recursive: true, force: true });
  }
});

test("queued execution waits for the previous manager-owned run before claiming the conversation", async () => {
  const harness = loadHarness();
  const firstStarted = deferred();
  const releaseFirst = deferred();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.beforePipelineRun = async () => {
      if (runtime.pipelineCalls.length === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
    };

    const first = harness.manager.runConversation(
      "default",
      "First execution",
      [],
      1,
    );
    await firstStarted.promise;

    const queued = harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: "default",
      message: {
        type: "pipeline.run",
        requestId: "queued-after-active",
        prompt: "Queued execution",
        attachmentIds: [],
        iterationCount: 2,
        delivery: "queue",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(runtime.pipelineCalls.length, 1);

    releaseFirst.resolve();
    await Promise.all([first, queued]);

    assert.deepEqual(
      runtime.pipelineCalls.map((call) => call.prompt),
      ["First execution", "Queued execution", "Queued execution"],
    );
    assert.deepEqual(runtime.pipelineRunOptions, [
      { appendPrompt: undefined, sourceQueueMessageId: undefined, hasOnAccepted: false },
      { appendPrompt: false, sourceQueueMessageId: "queue-queued-after-active", hasOnAccepted: true },
      { appendPrompt: false, sourceQueueMessageId: "queue-queued-after-active", hasOnAccepted: false },
    ]);
    assert.equal(
      harness.posted.some(
        (message) =>
          message.type === "conversation.message" &&
          message.message?.type === "operation.result" &&
          message.message.requestId === "queued-after-active" &&
          message.message.status === "accepted",
      ),
      true,
    );
  } finally {
    releaseFirst.resolve();
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("session reset failure finalizes accepted run state without clearing the draft", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.resetSessionsError = new Error("Simulated session reset failure");

    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.runtime",
        conversationId: "default",
        message: {
          type: "pipeline.run",
          requestId: "reset-failure",
          prompt: "Keep this draft",
          attachmentIds: [],
          iterationCount: 1,
          delivery: "immediate",
        },
      }),
      /Simulated session reset failure/u,
    );

    const summary = harness.manager.getState().conversations.find(
      (conversation) => conversation.id === "default",
    );
    assert.equal(summary.running, false);
    assert.equal(summary.workflowStatus, "error");
    assert.equal(
      harness.posted.some(
        (message) =>
          message.type === "conversation.message" &&
          message.message?.type === "operation.result" &&
          message.message.requestId === "reset-failure" &&
          message.message.status === "accepted",
      ),
      false,
    );

    const database = new DatabaseSync(path.join(harness.storageRoot, "bachata-state.sqlite"));
    const iteration = database.prepare(`
      SELECT status, completed_at FROM iterations ORDER BY created_at DESC LIMIT 1
    `).get();
    assert.equal(iteration.status, "failed");
    assert.equal(typeof iteration.completed_at, "string");
    const events = database.prepare(`
      SELECT type, status FROM events ORDER BY id
    `).all();
    assert.equal(events.some((event) => event.type === "iteration.failed" && event.status === "failed"), true);
    assert.equal(
      events.filter((event) => event.type === "run.failed" && event.status === "failed").length,
      1,
    );
    database.close();
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("workflow resume restores catalog context after restart and completes all remaining iterations", async () => {
  const first = loadHarness(undefined, { removeStorageOnDispose: false });
  let second;
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    const conversation = await first.manager.createConversation({
      title: "Recover three iterations",
      pipelineId: "cross-reference-development",
      workingDirectory: "/workspace",
    });
    const firstRuntime = first.runtimeInstances.at(-1);
    firstRuntime.state.selectedPipelineDefinition = {
      roles: [{ id: "lead" }, { id: "worker" }],
    };
    firstRuntime.pipelineResults.push(
      {
        status: "completed",
        answers: {},
        outputs: {},
        decisions: [],
        roles: { lead: "claude", worker: "codex" },
      },
      {
        status: "interrupted",
        answers: {},
        outputs: {},
        decisions: [],
        roles: { lead: "claude", worker: "codex" },
      },
    );

    const interrupted = await first.manager.runConversation(
      conversation.id,
      "Resume and continue",
      [],
      3,
    );
    assert.equal(interrupted.pipeline.status, "interrupted");
    assert.ok(firstRuntime.state.resumableWorkflow);
    const recovery = structuredClone(firstRuntime.state.resumableWorkflow);
    const storageRoot = first.storageRoot;
    const workspaceState = first.workspaceState;

    first.subscription.dispose();
    await first.manager.dispose();

    second = loadHarness(undefined, {
      storageRoot,
      workspaceState,
      runtimeResumableWorkflow: recovery,
      removeStorageOnDispose: true,
    });
    await second.manager.handleMessage({ type: "manager.ready" });
    const secondRuntime = second.runtimeInstances[0];
    secondRuntime.state.selectedPipelineDefinition = {
      roles: [{ id: "lead" }, { id: "worker" }],
    };
    secondRuntime.pipelineResults.push(
      {
        status: "completed",
        answers: {},
        outputs: {},
        decisions: [],
        roles: { lead: "claude", worker: "codex" },
      },
      {
        status: "completed",
        answers: {},
        outputs: {},
        decisions: [],
        roles: { lead: "claude", worker: "codex" },
      },
    );

    await second.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: conversation.id,
      message: { type: "workflow.resume" },
    });

    const summary = second.manager.getState().conversations.find(
      (item) => item.id === conversation.id,
    );
    assert.equal(summary.workflowStatus, "completed");
    assert.equal(summary.activeIteration, 3);
    assert.equal(secondRuntime.resumeCalls.length, 1);
    assert.equal(secondRuntime.pipelineCalls.length, 1);
    assert.equal(
      secondRuntime.messages.filter((message) => message.type === "session.reset").length,
      1,
    );

    const database = new DatabaseSync(path.join(storageRoot, "bachata-state.sqlite"));
    const iterations = database.prepare(`
      SELECT iteration_index, status, completed_at
      FROM iterations WHERE run_ref = ? ORDER BY iteration_index
    `).all(conversation.runRef);
    assert.deepEqual(
      iterations.map((iteration) => [iteration.iteration_index, iteration.status, typeof iteration.completed_at]),
      [
        [1, "completed", "string"],
        [2, "completed", "string"],
        [3, "completed", "string"],
      ],
    );
    const pairs = database.prepare(`
      SELECT iteration_ref, status, completed_at
      FROM pairs WHERE run_ref = ? ORDER BY created_at, pair_ref
    `).all(conversation.runRef);
    assert.equal(pairs.length, 3);
    assert.equal(pairs.every((pair) => pair.status === "completed" && typeof pair.completed_at === "string"), true);
    const resumedSteps = database.prepare(`
      SELECT pipeline_step_id, status FROM steps
      WHERE run_ref = ? AND pipeline_step_id = 'resumed-step'
    `).all(conversation.runRef);
    assert.deepEqual(
      resumedSteps.map((step) => [step.pipeline_step_id, step.status]),
      [["resumed-step", "completed"]],
    );
    const eventTypes = database.prepare(`
      SELECT type FROM events WHERE run_ref = ? ORDER BY id
    `).all(conversation.runRef).map((event) => event.type);
    assert.equal(eventTypes.includes("run.interrupted"), true);
    assert.equal(eventTypes.includes("run.resumed"), true);
    assert.equal(eventTypes.includes("iteration.resumed"), true);
    assert.equal(eventTypes.at(-1), "run.completed");
    const completedRun = database.prepare(`
      SELECT payload_json FROM events
      WHERE run_ref = ? AND type = 'run.completed' ORDER BY id DESC LIMIT 1
    `).get(conversation.runRef);
    assert.equal(JSON.parse(completedRun.payload_json).completedIterations, 3);
    database.close();
  } finally {
    if (second) {
      second.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
      second.runtimeInstances.forEach((instance) => instance.run.resolve());
      second.subscription.dispose();
      await second.manager.dispose();
    } else {
      first.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
      first.runtimeInstances.forEach((instance) => instance.run.resolve());
      first.subscription.dispose();
      await first.manager.dispose();
    }
  }
});


test("decision events expose the final ruling without duplicating participant candidates", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.beforePipelineRun = async () => {
      runtime.options.onPipelineDecision({
        stepId: "decision-step",
        round: 2,
        policy: "arbiter",
        status: "ruled",
        candidateId: "DABC",
        candidateHash: "abc",
        candidate: {
          findings: [{
            id: "finding-1",
            subject: "Fallback",
            message: "The fallback must remain",
            disposition: "accepted",
            severity: "warning",
            location: { file: "src/fallback.ts", startLine: 8 },
            evidence: ["Both participants inspected the fallback path"],
            challenges: ["Removal was considered and rejected"],
          }],
        },
        participants: [
          {
            agentId: "codex",
            valid: true,
            accepted: false,
            candidate: { large: "not copied to the event summary" },
            candidateHash: "def",
            objections: ["Keep the fallback"],
            unresolvedRisks: ["Provider DOM drift"],
            validationErrors: [],
          },
          {
            agentId: "claude",
            valid: true,
            accepted: true,
            candidate: { summary: "Use the selected implementation" },
            candidateHash: "abc",
            objections: [],
            unresolvedRisks: [],
            validationErrors: [],
          },
        ],
        objections: [{ agentId: "codex", text: "Keep the fallback", accepted: false }],
        unresolvedRisks: ["Provider DOM drift"],
        ruledBy: "claude",
      });
    };

    await harness.manager.runConversation("default", "Publish a ruling");
    const state = harness.manager.getState();
    const decision = state.eventsByConversation.default.find(
      (event) => event.type === "decision.published",
    );
    assert.equal(decision.payload.ruledBy, "claude");
    assert.equal(decision.payload.status, "ruled");
    assert.deepEqual(decision.payload.candidate, {
      findings: [{
        id: "finding-1",
        subject: "Fallback",
        message: "The fallback must remain",
        disposition: "accepted",
        severity: "warning",
        location: { file: "src/fallback.ts", startLine: 8 },
        evidence: ["Both participants inspected the fallback path"],
        challenges: ["Removal was considered and rejected"],
      }],
    });
    assert.equal(decision.payload.participants[0].candidate, undefined);
    assert.deepEqual(decision.payload.participants[0], {
      agentId: "codex",
      valid: true,
      accepted: false,
      candidateHash: "def",
      validationErrors: [],
    });
    assert.deepEqual(state.resultsByConversation.default.findings, [{
      id: "finding-1",
      subject: "Fallback",
      message: "The fallback must remain",
      disposition: "accepted",
      severity: "warning",
      location: { file: "src/fallback.ts", startLine: 8 },
      evidence: ["Both participants inspected the fallback path"],
      challenges: ["Removal was considered and rejected"],
      provenance: {
        source: "pipelineDecision",
        stepId: "decision-step",
        participantIds: ["codex", "claude"],
        decisionStatus: "ruled",
        ruledBy: "claude",
      },
    }]);
    assert.equal(
      state.eventsByConversation.default.find((event) => event.type === "run.started").payload,
      undefined,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("retained TODO resources can be revealed and cleaned through manager messages", async () => {
  const harness = loadHarness();
  const cleanupCalls = [];
  const revealCalls = [];
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    harness.manager.setTodoOrchestrator({
      start: async () => undefined,
      resume: async () => undefined,
      stop: async () => undefined,
      abandon: async () => undefined,
      cleanupRetained: async (runId) => {
        cleanupCalls.push(runId);
      },
      resolveRetainedWorktree: async (runId) => {
        revealCalls.push(runId);
        return `/workspace/.bachata/worktrees/${runId}`;
      },
      getSnapshot: () => ({
        active: false,
        retainedRuns: [{
          runId: "retained-a",
          title: "Retained A",
          status: "completed",
          integrationBranch: "bachata/integration/retained-a",
          integrationWorktree: "/workspace/.bachata/worktrees/retained-a",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T01:00:00.000Z",
          taskCount: 2,
        }],
      }),
      onDidChange: () => ({ dispose: () => undefined }),
    });

    await harness.manager.handleMessage({
      type: "orchestration.reveal",
      runId: "retained-a",
    });
    await harness.manager.handleMessage({
      type: "orchestration.cleanup",
      runId: "retained-a",
    });

    assert.deepEqual(revealCalls, ["retained-a"]);
    assert.deepEqual(cleanupCalls, ["retained-a"]);
    assert.deepEqual(harness.executedCommands, [[
      "revealFileInOS",
      { fsPath: "/workspace/.bachata/worktrees/retained-a" },
    ]]);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});


test("run handoff refuses a run the displayed result does not own, and refuses an unbound message", async () => {
  const harness = loadHarness();
  const applyCalls = [];
  const patchCalls = [];
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    harness.manager.setTodoOrchestrator({
      start: async () => undefined,
      resume: async () => undefined,
      stop: async () => undefined,
      abandon: async () => undefined,
      cleanupRetained: async () => undefined,
      resolveRetainedWorktree: async (runId) => `/workspace/.bachata/worktrees/${runId}`,
      retainedRunPatch: async (runId) => {
        patchCalls.push(runId);
        return "diff --git a/a b/a\n";
      },
      applyRetained: async (runId) => {
        applyCalls.push(runId);
        return { applied: true, targetBranch: "main", stagedFiles: ["a"], conflicts: [] };
      },
      rerunRetainedChecks: async () => [],
      getSnapshot: () => ({ active: false, retainedRuns: [] }),
      onDidChange: () => ({ dispose: () => undefined }),
    });
    const conversationId = harness.manager.getState().activeConversationId;

    await assert.rejects(
      harness.manager.handleMessage({
        type: "orchestration.apply",
        runId: "run-b",
        conversationId,
      }),
      /not bound to a retained orchestration run/u,
    );

    await assert.rejects(
      harness.manager.handleMessage({
        type: "orchestration.patch",
        runId: "run-b",
        conversationId,
      }),
      /not bound to a retained orchestration run/u,
    );
    await assert.rejects(
      harness.manager.handleMessage({
        type: "orchestration.recheck",
        runId: "run-b",
        conversationId,
      }),
      /not bound to a retained orchestration run/u,
    );

    for (const type of ["orchestration.patch", "orchestration.apply", "orchestration.recheck"]) {
      await assert.rejects(
        harness.manager.handleMessage({ type, runId: "run-a" }),
        /requires the conversation whose run result is displayed/u,
        `${type} accepted a message with no conversation binding`,
      );
      await assert.rejects(
        harness.manager.handleMessage({ type, runId: "run-a", conversationId: "   " }),
        /requires the conversation whose run result is displayed/u,
        `${type} accepted a blank conversation binding`,
      );
    }

    assert.deepEqual(applyCalls, []);
    assert.deepEqual(patchCalls, []);

    await harness.manager.handleMessage({ type: "orchestration.reveal", runId: "run-a" });
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("retained execution ownership enforces aggregate local-agent demand", async () => {
  const harness = loadHarness(undefined, {
    configurationValues: { maxConcurrentLocalAgents: 2 },
  });
  const releasePipeline = deferred();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.selectedPipelineDefinition = {
      steps: [{
        id: "codex-only",
        type: "agent",
        enabled: true,
        parallel: false,
        participants: ["codex"],
      }],
    };
    const pipelineEntered = deferred();
    runtime.beforePipelineRun = async () => {
      pipelineEntered.resolve();
      await releasePipeline.promise;
    };
    const running = harness.manager.runConversation("default", "Hold one local provider");
    await pipelineEntered.promise;

    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.runtime",
        conversationId: "default",
        message: {
          type: "message.send",
          recipients: ["codex", "claude"],
          prompt: "Use two more local providers",
          mode: "review",
          attachmentIds: [],
          delivery: "immediate",
        },
      }),
      /Concurrent work in this conversation needs 3 local provider processes.*maxConcurrentLocalAgents is 2/u,
    );
    assert.equal(
      runtime.messages.some((message) =>
        message.type === "message.send" && message.prompt === "Use two more local providers"
      ),
      false,
    );

    releasePipeline.resolve();
    await running;
  } finally {
    releasePipeline.resolve();
    harness.subscription.dispose();
    await harness.manager.dispose().catch(() => undefined);
  }
});


test("transient supplemental local-agent capacity is released while the parent run remains active", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "bachata-transient-local-capacity-"));
  const workingDirectory = path.join(root, "repository");
  const databasePath = path.join(root, "global", "resources.sqlite");
  require("node:fs").mkdirSync(workingDirectory, { recursive: true });
  const broker = createResourceBroker({
    databasePath,
    ownerId: "transient-capacity-manager",
    pollIntervalMs: 10,
  });
  const pipelineRelease = deferred();
  const directEntered = deferred();
  const directRelease = deferred();
  const harness = loadHarness(undefined, {
    storageRoot: path.join(root, "state"),
    removeStorageOnDispose: false,
    workingDirectory,
    resourceBroker: broker,
    configurationValues: {
      maxConcurrentPairRuns: 2,
      maxConcurrentLocalAgents: 2,
      maxConcurrentRepositoryTasks: 1,
      executionSlotTimeoutMs: 2000,
      providerCleanupTimeoutMs: 1000,
    },
    beforeRuntimeMessage: async (_instance, message) => {
      if (message.type === "message.send" && message.prompt === "transient direct") {
        directEntered.resolve();
        await directRelease.promise;
      }
    },
  });
  const localUnits = () => {
    const database = new DatabaseSync(databasePath);
    try {
      return database.prepare(
        "SELECT COALESCE(SUM(units), 0) AS units FROM resource_lease_item WHERE resource_key = 'local-agents:global'",
      ).get().units;
    } finally {
      database.close();
    }
  };
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.selectedPipelineDefinition = {
      steps: [{
        id: "codex-parent",
        type: "agent",
        enabled: true,
        parallel: false,
        participants: ["codex"],
      }],
    };
    runtime.beforePipelineRun = async () => pipelineRelease.promise;
    const running = harness.manager.runConversation("default", "hold parent capacity");
    await waitFor(() => runtime.pipelineCalls.length === 1);
    assert.equal(localUnits(), 1);

    const direct = harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: "default",
      message: {
        type: "message.send",
        recipients: ["claude"],
        prompt: "transient direct",
        mode: "review",
        attachmentIds: [],
        delivery: "immediate",
      },
    });
    await directEntered.promise;
    assert.equal(localUnits(), 2);
    directRelease.resolve();
    await direct;
    await waitFor(() => localUnits() === 1);

    runtime.state.agents.codex2 = {
      id: "codex2",
      name: "Codex 2",
      adapterType: "codex-app-server",
      status: "idle",
      output: "",
    };
    await harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId: "default",
      message: {
        type: "message.send",
        recipients: ["codex2"],
        prompt: "persistent direct",
        mode: "review",
        attachmentIds: [],
        delivery: "immediate",
      },
    });
    assert.equal(localUnits(), 2);

    pipelineRelease.resolve();
    await running;
    await waitFor(() => localUnits() === 0);
  } finally {
    pipelineRelease.resolve();
    directRelease.resolve();
    harness.subscription.dispose();
    await harness.manager.dispose().catch(() => undefined);
    await broker.dispose().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});


test("failed configured conversation creation disposes the unreachable runtime and removes durable state", async () => {
  const harness = loadHarness(undefined, {
    onRuntimeCreated: (instance, index) => {
      if (index === 1) {
        instance.configureError = new Error("Simulated conversation configuration failure");
      }
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await assert.rejects(
      harness.manager.createConversation({
        title: "Rejected run",
        pipelineId: "cross-reference-development",
        workingDirectory: "/workspace/rejected",
      }),
      /Simulated conversation configuration failure/u,
    );

    assert.equal(harness.runtimeInstances.length, 2);
    assert.equal(harness.runtimeInstances[1].disposed, true);
    assert.equal(harness.runtimeInstances[1].disposeCalls, 1);
    assert.deepEqual(
      harness.manager.getState().conversations.map((conversation) => conversation.id),
      ["default"],
    );
    assert.deepEqual(
      harness.workspaceState.get("bachata.conversationManager.v1").conversations.map(
        (conversation) => conversation.id,
      ),
      ["default"],
    );
    const database = new DatabaseSync(path.join(harness.storageRoot, "bachata-state.sqlite"));
    assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM runs").get().count), 1);
    database.close();
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("archive disposal failure restores the runtime and never persists the archive mutation", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const replacement = await harness.manager.createConversation({ title: "Replacement" });
    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: "default",
    });
    harness.runtimeInstances[0].disposeErrors.push(
      new Error("Simulated archive disposal failure"),
    );

    await assert.rejects(
      harness.manager.archiveConversation("default", true),
      /Simulated archive disposal failure/u,
    );

    const state = harness.manager.getState();
    assert.equal(state.activeConversationId, "default");
    assert.equal(state.conversations.find((item) => item.id === "default").archived, false);
    assert.equal(state.conversations.find((item) => item.id === replacement.id).archived, false);
    const persisted = harness.workspaceState.get("bachata.conversationManager.v1");
    assert.equal(persisted.activeConversationId, "default");
    assert.equal(persisted.conversations.find((item) => item.id === "default").archived, false);
    assert.equal(harness.runtimeInstances[0].disposed, true);
    assert.equal(harness.runtimeInstances.length, 3);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("failed conversation selection leaves the previous active run durable and can be retried", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const second = await harness.manager.createConversation({ title: "Second" });
    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: "default",
    });
    const secondRuntime = harness.runtimeInstances[1];
    secondRuntime.throwOnMessageType = "ready";

    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.select",
        conversationId: second.id,
      }),
      /Simulated ready failure/u,
    );

    assert.equal(harness.manager.getState().activeConversationId, "default");
    assert.equal(
      harness.workspaceState.get("bachata.conversationManager.v1").activeConversationId,
      "default",
    );

    secondRuntime.throwOnMessageType = undefined;
    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: second.id,
    });
    assert.equal(harness.manager.getState().activeConversationId, second.id);
    assert.equal(
      harness.workspaceState.get("bachata.conversationManager.v1").activeConversationId,
      second.id,
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("manager initialization retries after a transient active-runtime readiness failure", async () => {
  let remainingFailures = 1;
  const harness = loadHarness(undefined, {
    beforeRuntimeMessage: async (_instance, message) => {
      if (message.type === "ready" && remainingFailures > 0) {
        remainingFailures -= 1;
        throw new Error("Simulated initialization readiness failure");
      }
    },
  });
  try {
    await waitFor(() => harness.runtimeInstances.length === 1 && harness.runtimeInstances[0].disposed);
    await harness.manager.handleMessage({ type: "manager.ready" });
    assert.equal(remainingFailures, 0);
    assert.equal(harness.runtimeInstances.length, 2);
    assert.equal(harness.runtimeInstances[1].disposed, false);
    assert.equal(harness.manager.getState().activeConversationId, "default");
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("late subtree deletion persistence failure restores storage, catalog rows, runtimes, and visible state", async () => {
  let rejectDeletionCommit = false;
  const harness = loadHarness(undefined, {
    beforeWorkspaceStateUpdate: async ({ key, value }) => {
      if (
        rejectDeletionCommit &&
        key === "bachata.conversationManager.v1" &&
        value?.conversations?.length === 1
      ) {
        rejectDeletionCommit = false;
        throw new Error("Simulated deletion state commit failure");
      }
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const child = await harness.manager.createConversation({
      title: "Child",
      parentConversationId: "default",
    });
    const other = await harness.manager.createConversation({ title: "Other root" });
    const before = harness.manager.getState();
    const parent = before.conversations.find((conversation) => conversation.id === "default");
    const childSummary = before.conversations.find((conversation) => conversation.id === child.id);
    const parentTranscript = path.join(harness.storageRoot, "transcript.jsonl");
    const childDirectory = path.join(harness.storageRoot, "conversations", child.id);
    const childTranscript = path.join(childDirectory, "transcript.jsonl");
    mkdirSync(childDirectory, { recursive: true });
    writeFileSync(parentTranscript, "parent-history\n", "utf8");
    writeFileSync(childTranscript, "child-history\n", "utf8");

    rejectDeletionCommit = true;
    await assert.rejects(
      harness.manager.closeConversation(child.id),
      /Simulated deletion state commit failure/u,
    );

    assert.deepEqual(
      harness.manager.getState().conversations.map((conversation) => conversation.id).sort(),
      ["default", child.id, other.id].sort(),
    );
    assert.equal(harness.manager.getState().activeConversationId, other.id);
    assert.equal(readFileSync(parentTranscript, "utf8"), "parent-history\n");
    assert.equal(readFileSync(childTranscript, "utf8"), "child-history\n");
    assert.equal(
      harness.workspaceState.get("bachata.conversationManager.v1").conversations.length,
      3,
    );
    const database = new DatabaseSync(path.join(harness.storageRoot, "bachata-state.sqlite"));
    assert.equal(
      Number(
        database.prepare(
          "SELECT COUNT(*) AS count FROM runs WHERE run_ref IN (?, ?)",
        ).get(parent.runRef, childSummary.runRef).count,
      ),
      2,
    );
    database.close();
    assert.equal(harness.runtimeInstances.filter((instance) => !instance.disposed).length, 3);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("startup reconciliation restores staged deletion data when catalog rows still exist", async () => {
  const workspaceState = new Map();
  const first = loadHarness(undefined, {
    workspaceState,
    removeStorageOnDispose: false,
  });
  let second;
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    const child = await first.manager.createConversation({
      title: "Recoverable child",
      parentConversationId: "default",
    });
    const childDirectory = path.join(first.storageRoot, "conversations", child.id);
    const original = path.join(childDirectory, "transcript.jsonl");
    mkdirSync(childDirectory, { recursive: true });
    writeFileSync(original, "recover me\n", "utf8");
    first.subscription.dispose();
    await first.manager.dispose();

    const operationDirectory = path.join(
      first.storageRoot,
      ".trash",
      "conversation-deletions",
      "simulated-crash",
    );
    const staged = path.join(operationDirectory, "data", "0");
    mkdirSync(path.dirname(staged), { recursive: true });
    renameSync(childDirectory, staged);
    writeFileSync(
      path.join(operationDirectory, "manifest.json"),
      `${JSON.stringify({
        version: 1,
        runRefs: [child.runRef],
        entries: [{ original: childDirectory, staged }],
        runtimeValues: [],
      })}\n`,
      "utf8",
    );

    second = loadHarness(undefined, {
      storageRoot: first.storageRoot,
      workspaceState,
      removeStorageOnDispose: true,
    });
    await second.manager.handleMessage({ type: "manager.ready" });
    assert.equal(readFileSync(original, "utf8"), "recover me\n");
    assert.equal(existsSync(operationDirectory), false);
  } finally {
    if (second) {
      second.subscription.dispose();
      await second.manager.dispose();
    } else {
      rmSync(first.storageRoot, { recursive: true, force: true });
    }
  }
});

test("external custom-pipeline file events refresh every open runtime", async () => {
  const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-manager-catalog-watch-"));
  const harness = loadHarness(undefined, {
    workingDirectory: workspaceRoot,
    workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
    enableFileSystemWatchers: true,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    assert.equal(harness.fileSystemWatchers.length, 2);
    assert.equal(harness.runtimeInstances.length, 1);
    harness.fileSystemWatchers[0].callbacks.change.forEach((callback) => callback());
    await waitFor(() => harness.runtimeInstances[0].pipelineRefreshCalls.length === 1);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
    assert.equal(harness.fileSystemWatchers.every((watcher) => watcher.disposed), true);
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("run participants are published with the conversation summary and persist for unopened runs", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.state.selectedPipelineDefinition = {
      id: "custom-a",
      name: "Custom A",
      agents: [
        { id: "lead", name: "Lead", adapter: "codex-app-server", model: "gpt-5-codex" },
        { id: "worker", name: "Worker", adapter: "claude-code" },
      ],
      steps: [],
    };
    await runtime.emit({ type: "state.snapshot", state: runtime.state });
    await waitFor(() => harness.posted.some((message) =>
      message.type === "manager.snapshot" &&
      message.state.conversations.some((conversation) => conversation.participants?.length === 2),
    ));
    const snapshot = harness.posted.findLast((message) => message.type === "manager.snapshot");
    const summary = snapshot.state.conversations.find((conversation) => conversation.participants);
    assert.deepEqual(summary.participants, [
      { name: "Lead", adapter: "codex-app-server", model: "gpt-5-codex" },
      { name: "Worker", adapter: "claude-code" },
    ]);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("participants recorded for a run are restored after the manager restarts", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-participants-restart-"));
  const first = loadHarness(undefined, { storageRoot, removeStorageOnDispose: false });
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    const runtime = first.runtimeInstances[0];
    runtime.state.selectedPipelineDefinition = {
      id: "custom-a",
      name: "Custom A",
      agents: [{ id: "lead", name: "Lead", adapter: "codex-app-server", model: "gpt-5-codex" }],
      steps: [],
    };
    await runtime.emit({ type: "state.snapshot", state: runtime.state });
    await waitFor(() => first.posted.some((message) =>
      message.type === "manager.snapshot" &&
      message.state.conversations.some((conversation) => conversation.participants?.length === 1),
    ));
  } finally {
    first.subscription.dispose();
    await first.manager.dispose();
  }

  const second = loadHarness(undefined, { storageRoot, removeStorageOnDispose: true });
  try {
    await second.manager.handleMessage({ type: "manager.ready" });
    await waitFor(() => second.posted.some((message) => message.type === "manager.snapshot"));
    const snapshot = second.posted.findLast((message) => message.type === "manager.snapshot");
    const restored = snapshot.state.conversations.find((conversation) => conversation.participants);
    assert.deepEqual(restored?.participants, [
      { name: "Lead", adapter: "codex-app-server", model: "gpt-5-codex" },
    ]);
  } finally {
    second.subscription.dispose();
    await second.manager.dispose();
  }
});

test("prepared command drafts survive panel reloads and restarts until cleared", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-prepared-draft-"));
  const workspaceState = new Map();
  let conversationId;
  const first = loadHarness(undefined, { storageRoot, workspaceState, removeStorageOnDispose: false });
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    const conversation = await first.manager.createConversation({
      title: "Review a.ts",
      preparedDraft: "Review file: src/a.ts",
    });
    conversationId = conversation.id;
    assert.equal(conversation.preparedDraft, "Review file: src/a.ts");
  } finally {
    first.subscription.dispose();
    await first.manager.dispose();
  }

  const second = loadHarness(undefined, { storageRoot, workspaceState, removeStorageOnDispose: false });
  try {
    await second.manager.handleMessage({ type: "manager.ready" });
    const restored = second.manager
      .getState()
      .conversations.find((item) => item.id === conversationId);
    assert.equal(restored.preparedDraft, "Review file: src/a.ts");

    await second.manager.handleMessage({
      type: "conversation.saveDraft",
      conversationId,
      text: "Review file: src/a.ts and explain the retry path",
    });
    assert.equal(
      second.manager.getState().conversations.find((item) => item.id === conversationId).preparedDraft,
      "Review file: src/a.ts and explain the retry path",
    );

  } finally {
    second.subscription.dispose();
    await second.manager.dispose();
  }

  const third = loadHarness(undefined, { storageRoot, workspaceState, removeStorageOnDispose: true });
  try {
    await third.manager.handleMessage({ type: "manager.ready" });
    const restored = third.manager
      .getState()
      .conversations.find((item) => item.id === conversationId);
    assert.equal(restored.preparedDraft, "Review file: src/a.ts and explain the retry path");

    await third.manager.handleMessage({
      type: "conversation.consumePreparedDraft",
      conversationId,
    });
    assert.equal(
      third.manager.getState().conversations.find((item) => item.id === conversationId).preparedDraft,
      undefined,
    );
  } finally {
    third.subscription.dispose();
    await third.manager.dispose();
  }
});

test("completed run evidence stays in Result Center after a restart", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-result-restart-"));
  const workspaceState = new Map();
  const first = loadHarness(undefined, { storageRoot, workspaceState, removeStorageOnDispose: false });
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    await first.manager.runConversation("default", "Produce evidence");
    const runtime = first.runtimeInstances[0];
    runtime.state.transcript.push({
      id: "error-1",
      kind: "error",
      eventType: "agent.error",
      agentId: "codex",
      text: "Verification command exited with 1",
      createdAt: new Date().toISOString(),
    });
    await runtime.emit({ type: "state.snapshot", state: runtime.state });
    const live = first.manager.getState().resultsByConversation.default;
    assert.equal(live.status, "completed");
    assert.deepEqual(live.unresolvedRisks, ["Verification command exited with 1"]);
    await first.manager.flush();
  } finally {
    first.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    first.runtimeInstances.forEach((instance) => instance.run.resolve());
    first.subscription.dispose();
    await first.manager.dispose();
  }

  const second = loadHarness(undefined, { storageRoot, workspaceState, removeStorageOnDispose: true });
  try {
    await second.manager.handleMessage({ type: "manager.ready" });
    const restored = second.manager.getState().resultsByConversation.default;
    assert.deepEqual(restored.unresolvedRisks, ["Verification command exited with 1"]);
    assert.equal(restored.status, "completed");
    const runtime = second.runtimeInstances[0];
    runtime.state.transcript.push({
      id: "error-2",
      kind: "error",
      eventType: "agent.error",
      agentId: "claude",
      text: "Later provider failure",
      createdAt: new Date().toISOString(),
    });
    await runtime.emit({ type: "state.snapshot", state: runtime.state });
    const merged = second.manager.getState().resultsByConversation.default;
    assert.deepEqual(merged.unresolvedRisks.slice().sort(), [
      "Later provider failure",
      "Verification command exited with 1",
    ]);
    assert.equal(merged.status, "completed");

    runtime.state.transcript.push({
      id: "recovery-1",
      kind: "event",
      eventType: "agent.recovered",
      agentId: "claude",
      text: "claude recovered",
      createdAt: new Date().toISOString(),
    });
    await runtime.emit({ type: "state.snapshot", state: runtime.state });
    const promoted = second.manager.getState().resultsByConversation.default;
    assert.deepEqual(promoted.recoveredErrors, ["Later provider failure"]);
    assert.deepEqual(promoted.unresolvedRisks, ["Verification command exited with 1"]);
    assert.equal(
      promoted.unresolvedRisks.some((risk) => promoted.recoveredErrors.includes(risk)),
      false,
      "an error was reported as both unresolved and recovered",
    );
  } finally {
    second.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    second.runtimeInstances.forEach((instance) => instance.run.resolve());
    second.subscription.dispose();
    await second.manager.dispose();
  }
});

test("result files hand off to the diff editor and Source Control", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-result-handoff-"));
  const harness = loadHarness(undefined, { storageRoot, removeStorageOnDispose: true });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Handoff",
      workingDirectory: storageRoot,
    });
    writeFileSync(path.join(storageRoot, "changed.ts"), "export const a = 1;\n", "utf8");

    await harness.manager.handleMessage({
      type: "conversation.openChanges",
      conversationId: conversation.id,
      path: "changed.ts",
    });
    await harness.manager.handleMessage({
      type: "conversation.openSourceControl",
      conversationId: conversation.id,
    });

    const commands = harness.executedCommands.map((call) => call[0]);
    assert.ok(commands.includes("git.openChange"));
    assert.ok(commands.includes("workbench.view.scm"));

    const outside = path.join(path.dirname(storageRoot), `outside-${path.basename(storageRoot)}.ts`);
    writeFileSync(outside, "export const b = 2;\n", "utf8");
    try {
      await assert.rejects(
        harness.manager.handleMessage({
          type: "conversation.openChanges",
          conversationId: conversation.id,
          path: outside,
        }),
        /outside the run working directory/u,
      );
    } finally {
      rmSync(outside, { force: true });
    }
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("history search reports truncated evidence instead of silently dropping it", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    harness.runtimeInstances[0].state.transcript.push({
      id: "answer-huge",
      kind: "answer",
      eventType: "agent.answer",
      agentId: "codex",
      text: `${"z".repeat(3_000_000)} hidden-tail-token`,
      createdAt: new Date().toISOString(),
    });

    await harness.manager.handleMessage({
      type: "history.search",
      query: "hidden-tail-token",
      requestId: "search-truncated",
    });

    const result = harness.posted.findLast((message) =>
      message.type === "manager.historyResults" && message.requestId === "search-truncated"
    );
    assert.deepEqual(result.conversationIds, []);
    assert.equal(result.truncated, true);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a pipeline that declares controller verification records its checks as run evidence", async () => {
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-contract-verify-"));
  execFileSync("git", ["init", "--quiet", repositoryRoot]);
  execFileSync("git", ["config", "user.name", "Bachata test"], { cwd: repositoryRoot });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: repositoryRoot });
  writeFileSync(path.join(repositoryRoot, "a.txt"), "one\n", "utf8");
  execFileSync("git", ["add", "a.txt"], { cwd: repositoryRoot });
  execFileSync("git", ["commit", "--quiet", "-m", "base"], { cwd: repositoryRoot });
  const harness = loadHarness(undefined, {
    workingDirectory: repositoryRoot,
    providePipelineSnapshot: true,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    const runtime = harness.runtimeInstances[0];
    runtime.state.selectedPipelineDefinition = {
      version: 1,
      id: "managed-fix",
      name: "Managed fix",
      agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
      steps: [{
        id: "fix",
        name: "Fix",
        enabled: true,
        humanGate: "none",
        type: "agent",
        participants: ["codex"],
        promptTemplate: "x",
        parallel: false,
        consensus: false,
      }],
      managedPolicy: {
        writeScope: "configured",
        commitMode: "never",
        verificationChecks: [{ id: "integrity", command: "bachata:workspace-integrity" }],
      },
    };

    await harness.manager.runConversation(conversationId, "fix it");

    const result = harness.manager.getState().resultsByConversation[conversationId];
    assert.deepEqual(result.checks, [{ command: "bachata:workspace-integrity", status: "passed" }]);
    assert.equal(result.expectations.verification, true);
    assert.equal(
      result.evidence.find((entry) => entry.kind === "verification").state,
      "recorded",
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

const retainedOrchestrator = (options) => {
  const state = { checks: options.finalChecks, calls: [], applyCalls: [] };
  return {
    orchestrator: {
      start: async () => undefined,
      resume: async () => undefined,
      stop: async () => undefined,
      abandon: async () => undefined,
      cleanupRetained: async () => undefined,
      resolveRetainedWorktree: async () => "/workspace/.bachata/worktrees/retained-a",
      retainedRunPatch: async () => "diff --git a/a b/a\n",
      applyRetained: async (runId, selection) => {
        state.applyCalls.push({ runId, selection });
        return { applied: true, targetBranch: "main", stagedFiles: ["src/a.ts"], conflicts: [] };
      },
      rerunRetainedChecks: async (runId) => {
        state.calls.push(runId);
        return (options.recheckQueue.shift() ?? []).map((check) => ({
          stdout: "",
          stderr: "",
          ...check,
        }));
      },
      getSnapshot: () => ({
        active: false,
        retainedRuns: [],
        run: {
          runId: "retained-a",
          title: "Retained A",
          status: "completed",
          integrationBranch: "bachata/integration/retained-a",
          integrationWorktree: "/workspace/.bachata/worktrees/retained-a",
          parentConversationId: "default",
          masterConversationId: "default",
          masterChecks: [],
          tasks: {},
          finalChecks: state.checks,
        },
      }),
      onDidChange: () => ({ dispose: () => undefined }),
    },
    state,
  };
};

test("a recheck replaces the run's verification evidence and survives a restart", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-recheck-restart-"));
  const workspaceState = new Map();
  const first = loadHarness(undefined, { storageRoot, workspaceState, removeStorageOnDispose: false });
  const bound = retainedOrchestrator({
    finalChecks: [{ command: "bachata:project-checks", status: "passed" }],
    recheckQueue: [[{ command: "bachata:project-checks", status: "failed" }]],
  });
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    first.manager.setTodoOrchestrator(bound.orchestrator);
    await first.manager.runConversation("default", "Produce retained evidence");

    const before = first.manager.getState().resultsByConversation.default;
    assert.equal(before.retainedRunId, "retained-a");
    assert.deepEqual(before.checks, [{ command: "bachata:project-checks", status: "passed" }]);
    assert.equal(before.applyBlockedReason, undefined);

    await first.manager.handleMessage({
      type: "orchestration.recheck",
      runId: "retained-a",
      conversationId: "default",
    });

    const after = first.manager.getState().resultsByConversation.default;
    assert.deepEqual(after.checks, [{ command: "bachata:project-checks", status: "failed" }]);
    assert.equal(after.finalAssessment.outcome, "verificationFailed");
    assert.match(after.applyBlockedReason, /Verification did not pass/u);
    assert.equal(after.verificationProvenance.source, "recheck");
    assert.equal(typeof after.verificationProvenance.recordedAt, "string");
    await first.manager.flush();
  } finally {
    first.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    first.runtimeInstances.forEach((instance) => instance.run.resolve());
    first.subscription.dispose();
    await first.manager.dispose();
  }

  const second = loadHarness(undefined, { storageRoot, workspaceState, removeStorageOnDispose: true });
  const rebound = retainedOrchestrator({
    finalChecks: [{ command: "bachata:project-checks", status: "passed" }],
    recheckQueue: [],
  });
  try {
    await second.manager.handleMessage({ type: "manager.ready" });
    second.manager.setTodoOrchestrator(rebound.orchestrator);
    const restored = second.manager.getState().resultsByConversation.default;
    assert.deepEqual(
      restored.checks,
      [{ command: "bachata:project-checks", status: "failed" }],
      "a stale passing check survived a failed recheck across a restart",
    );
    assert.equal(restored.finalAssessment.outcome, "verificationFailed");
    assert.match(restored.applyBlockedReason, /Verification did not pass/u);
    assert.equal(restored.verificationProvenance.source, "recheck");
  } finally {
    second.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    second.runtimeInstances.forEach((instance) => instance.run.resolve());
    second.subscription.dispose();
    await second.manager.dispose();
  }
});

test("a failed recheck blocks Apply and a later passing recheck restores it", async () => {
  const harness = loadHarness();
  const bound = retainedOrchestrator({
    finalChecks: [{ command: "bachata:project-checks", status: "passed" }],
    recheckQueue: [
      [{ command: "bachata:project-checks", status: "timedOut" }],
      [{ command: "bachata:project-checks", status: "cancelled" }],
      [{ command: "bachata:project-checks", status: "passed" }],
    ],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    harness.manager.setTodoOrchestrator(bound.orchestrator);
    await harness.manager.runConversation("default", "Produce retained evidence");

    const recheck = () => harness.manager.handleMessage({
      type: "orchestration.recheck",
      runId: "retained-a",
      conversationId: "default",
    });
    const apply = () => harness.manager.handleMessage({
      type: "orchestration.apply",
      runId: "retained-a",
      conversationId: "default",
    });

    await recheck();
    await apply();
    assert.deepEqual(bound.state.applyCalls, [], "apply ran after a timed-out recheck");
    assert.match(harness.exportConfirmations.at(-1).message, /Verification did not pass/u);

    await recheck();
    await apply();
    assert.deepEqual(bound.state.applyCalls, [], "apply ran after a cancelled recheck");
    assert.match(harness.exportConfirmations.at(-1).message, /cancelled/u);
    assert.equal(
      harness.manager.getState().resultsByConversation.default.finalAssessment.outcome,
      "inconclusive",
    );

    await recheck();
    const restored = harness.manager.getState().resultsByConversation.default;
    assert.equal(restored.applyBlockedReason, undefined);
    assert.deepEqual(restored.checks, [{ command: "bachata:project-checks", status: "passed" }]);
    assert.equal(restored.verificationProvenance.source, "recheck");
    assert.equal(
      restored.evidenceGaps.includes("Expected but missing: no verification check was recorded"),
      false,
    );
    await apply();
    assert.deepEqual(bound.state.applyCalls, [{ runId: "retained-a", selection: {} }]);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("hunk selection reaches the orchestrator and an unreadable selection is refused", async () => {
  const harness = loadHarness();
  const calls = [];
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    harness.manager.setTodoOrchestrator({
      start: async () => undefined,
      resume: async () => undefined,
      stop: async () => undefined,
      abandon: async () => undefined,
      cleanupRetained: async () => undefined,
      resolveRetainedWorktree: async () => "/workspace/.bachata/worktrees/retained-a",
      retainedRunPatch: async (runId, selection) => {
        calls.push({ kind: "patch", runId, selection });
        return "diff --git a/src/a.ts b/src/a.ts\n";
      },
      retainedRunPatchFiles: async (runId) => {
        calls.push({ kind: "files", runId });
        return [{
          path: "src/a.ts",
          binary: false,
          renamed: false,
          wholeFileOnly: false,
          hunks: [{ index: 0, header: "@@ -1 +1 @@", added: 1, removed: 1, preview: "-a\n+b" }],
        }];
      },
      applyRetained: async (runId, selection) => {
        calls.push({ kind: "apply", runId, selection });
        return { applied: true, targetBranch: "main", stagedFiles: ["src/a.ts"], conflicts: [] };
      },
      rerunRetainedChecks: async () => [],
      verifyRetainedSelection: async (runId, selection) => {
        calls.push({ kind: "verify-selection", runId, selection });
        return [{ command: "bachata:project-checks", status: "passed", stdout: "", stderr: "" }];
      },
      getSnapshot: () => ({
        active: false,
        retainedRuns: [],
        run: {
          runId: "retained-a",
          title: "Retained A",
          status: "completed",
          integrationBranch: "bachata/integration/retained-a",
          integrationWorktree: "/workspace/.bachata/worktrees/retained-a",
          parentConversationId: "default",
          masterConversationId: "default",
          masterChecks: [],
          tasks: {},
          finalChecks: [{ command: "bachata:project-checks", status: "passed" }],
        },
      }),
      onDidChange: () => ({ dispose: () => undefined }),
    });
    await harness.manager.runConversation("default", "Produce retained evidence");

    await harness.manager.handleMessage({
      type: "orchestration.diff",
      runId: "retained-a",
      conversationId: "default",
    });
    const diff = harness.posted.filter((message) => message.type === "manager.runDiff").at(-1);
    assert.ok(diff, "no run diff was posted to the webview");
    assert.equal(diff.runId, "retained-a");
    assert.deepEqual(diff.files.map((file) => file.path), ["src/a.ts"]);

    await harness.manager.handleMessage({
      type: "orchestration.patch",
      runId: "retained-a",
      conversationId: "default",
      hunks: [{ path: "src/a.ts", index: 0 }],
    });
    assert.deepEqual(calls.at(-1), {
      kind: "patch",
      runId: "retained-a",
      selection: { hunks: [{ path: "src/a.ts", index: 0 }] },
    });

    await harness.manager.handleMessage({
      type: "orchestration.apply",
      runId: "retained-a",
      conversationId: "default",
      paths: ["src/a.ts"],
      hunks: [{ path: "src/a.ts", index: 0 }],
    });
    assert.deepEqual(calls.at(-2), {
      kind: "verify-selection",
      runId: "retained-a",
      selection: { paths: ["src/a.ts"], hunks: [{ path: "src/a.ts", index: 0 }] },
    });
    assert.deepEqual(calls.at(-1), {
      kind: "apply",
      runId: "retained-a",
      selection: { paths: ["src/a.ts"], hunks: [{ path: "src/a.ts", index: 0 }] },
    });

    await assert.rejects(
      harness.manager.handleMessage({
        type: "orchestration.apply",
        runId: "retained-a",
        conversationId: "default",
        hunks: [{ path: "src/a.ts", index: "one" }],
      }),
      /hunk selection Bachata cannot read/u,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("applying an inconclusive run needs an explicit override action", async () => {
  const harness = loadHarness();
  const bound = retainedOrchestrator({
    finalChecks: [{ command: "bachata:project-checks", status: "passed" }],
    recheckQueue: [],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    harness.manager.setTodoOrchestrator(bound.orchestrator);
    await harness.manager.runConversation("default", "Produce retained evidence");

    const result = harness.manager.getState().resultsByConversation.default;
    assert.equal(result.applyBlockedReason, undefined);
    assert.match(
      result.applyOverrideReason,
      /no final ruling was recorded|Required evidence is missing/u,
    );

    await harness.manager.handleMessage({
      type: "orchestration.apply",
      runId: "retained-a",
      conversationId: "default",
    });
    const confirmation = harness.exportConfirmations.at(-1);
    assert.deepEqual(
      confirmation.actions,
      ["Apply despite inconclusive result"],
      "an inconclusive run offered the ordinary Apply action",
    );
    assert.match(confirmation.options.detail, /This run is inconclusive/u);
    assert.match(confirmation.options.detail, /explicit override/u);
    assert.equal(bound.state.applyCalls.length, 1, "the override action still applies once confirmed");
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a recheck that cannot be persisted is rolled back and never shown", async () => {
  const persistence = { failures: 0 };
  const harness = loadHarness(undefined, {
    beforeWorkspaceStateUpdate: () => {
      if (persistence.failures <= 0) return;
      persistence.failures -= 1;
      throw new Error("workspace state is read-only");
    },
  });
  const bound = retainedOrchestrator({
    finalChecks: [{ command: "bachata:project-checks", status: "passed" }],
    recheckQueue: [[{ command: "bachata:project-checks", status: "failed" }]],
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    harness.manager.setTodoOrchestrator(bound.orchestrator);
    await harness.manager.runConversation("default", "Produce retained evidence");

    const before = harness.manager.getState().resultsByConversation.default;
    assert.deepEqual(before.checks, [{ command: "bachata:project-checks", status: "passed" }]);

    persistence.failures = 1;
    await assert.rejects(
      harness.manager.handleMessage({
        type: "orchestration.recheck",
        runId: "retained-a",
        conversationId: "default",
      }),
      /workspace state is read-only/u,
    );
    persistence.failures = 0;

    const after = harness.manager.getState().resultsByConversation.default;
    assert.deepEqual(
      after.checks,
      [{ command: "bachata:project-checks", status: "passed" }],
      "an unpersisted recheck leaked into the shown result",
    );
    assert.equal(after.verificationProvenance?.source ?? "run", "run");
    assert.equal(after.applyBlockedReason, undefined);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("an immediate composer run through the manager is refused when the runtime refuses it", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.runConversation("default", "prime the runtime");
    const instance = harness.runtimeInstances.at(-1);
    instance.runRefusal = "Read and acknowledge this run's execution contract before starting it";
    const before = instance.pipelineCalls.length;

    await assert.rejects(
      harness.manager.handleMessage({
        type: "conversation.runtime",
        conversationId: "default",
        message: {
          type: "pipeline.run",
          requestId: "composer-1",
          prompt: "Fix the retry",
          attachmentIds: [],
          iterationCount: 1,
          delivery: "immediate",
        },
      }),
      /acknowledge this run's execution contract/u,
    );
    assert.equal(
      instance.pipelineCalls.length,
      before,
      "the manager started a pipeline the runtime had refused",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("validated single-model findings stay proposed and never cross an execution boundary", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.beforePipelineRun = async () => {
      runtime.options.onPipelineOutput({
        stepId: "review",
        agentId: "codex",
        name: "modelFindings",
        value: {
          findings: [{
            id: "single-review",
            subject: "Possible race",
            message: "The race needs another reviewer",
            disposition: "accepted",
            evidence: ["One trace reaches the race"],
            challenges: [],
          }],
        },
        hash: "finding-hash",
        validationErrors: [],
      });
    };
    await harness.manager.runConversation("default", "first review");
    const first = harness.manager.getState().resultsByConversation.default;
    assert.deepEqual(first.findings.map((finding) => finding.disposition), ["proposed"]);

    runtime.beforePipelineRun = undefined;
    await harness.manager.runConversation("default", "second review");
    const second = harness.manager.getState().resultsByConversation.default;
    assert.deepEqual(second.findings, []);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a rerun without a new decision does not inherit the previous ruling", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.beforePipelineRun = async () => {
      runtime.options.onPipelineDecision({
        stepId: "converge",
        round: 1,
        policy: "unanimous",
        status: "accepted",
        candidateId: "DABC",
        candidateHash: "abc",
        candidate: { summary: "Accepted by both" },
        participants: [],
        objections: [],
        unresolvedRisks: ["a risk from the first run"],
      });
    };
    await harness.manager.runConversation("default", "first run");
    const first = harness.manager.getState().resultsByConversation.default;
    assert.equal(
      first.consensusRuling,
      undefined,
      "a decision without valid multi-provider provenance was recorded as consensus",
    );
    assert.equal(
      first.finalAssessment.method,
      "none",
      "a ruling without multi-provider provenance was mislabeled as consensus",
    );
    assert.equal(first.unresolvedRisks.includes("a risk from the first run"), true);

    runtime.beforePipelineRun = undefined;
    await harness.manager.runConversation("default", "second run");
    const second = harness.manager.getState().resultsByConversation.default;
    assert.equal(
      second.consensusRuling,
      undefined,
      "a rerun inherited the previous execution's consensus ruling",
    );
    assert.equal(
      second.unresolvedRisks.includes("a risk from the first run"),
      false,
      "a rerun inherited the previous execution's unresolved risks",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a two-provider arbiter ruling is not recorded as consensus", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    runtime.beforePipelineRun = async () => {
      runtime.options.onPipelineDecision({
        stepId: "arbiter",
        round: 1,
        policy: "arbiter",
        status: "ruled",
        ruledBy: "claude",
        candidateId: "D-ARBITER",
        candidateHash: "arbiter-hash",
        candidate: { summary: "Claude ruled after disagreement" },
        participants: [
          { agentId: "codex", valid: true, accepted: false, candidate: null, candidateHash: "a", objections: [], unresolvedRisks: [], validationErrors: [] },
          { agentId: "claude", valid: true, accepted: true, candidate: null, candidateHash: "b", objections: [], unresolvedRisks: [], validationErrors: [] },
        ],
        objections: [],
        unresolvedRisks: [],
        rulingProvenance: {
          kind: "arbiterRuling",
          participants: [{ agentId: "codex" }, { agentId: "claude" }],
          ruledBy: "claude",
        },
        hash: "arbiter-artifact-hash",
        validationErrors: [],
      });
    };
    await harness.manager.runConversation("default", "arbiter review");
    const result = harness.manager.getState().resultsByConversation.default;
    assert.equal(result.rulingProvenance.kind, "arbiterRuling");
    assert.equal(result.consensusRuling, undefined);
    assert.equal(result.finalAssessment.method, "arbiter");
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("the direction surface is published with every manager snapshot", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const state = harness.manager.getState();
    assert.ok(state.direction, "the manager published no direction state");
    assert.equal(state.direction.direction.nextAction.kind, "defineInitiative");
    assert.deepEqual(state.direction.cycles, []);
    assert.deepEqual(state.direction.findings, []);
    assert.equal(state.direction.saturation.saturated, false);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a baseline capture completing after shutdown cannot publish through the closed catalog", async () => {
  const baselineModule = require("../dist/longitudinal/repositoryBaseline.js");
  const originalCapture = baselineModule.captureCycleBaseline;
  const started = deferred();
  const released = deferred();
  baselineModule.captureCycleBaseline = async () => {
    started.resolve();
    await released.promise;
    return { branch: "main", commit: "a".repeat(40), dirty: false, contentComplete: true, capturedAt: new Date().toISOString() };
  };
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await started.promise;
    await harness.manager.dispose();
    const posted = harness.posted.length;
    released.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.posted.length, posted);
  } finally {
    released.resolve();
    baselineModule.captureCycleBaseline = originalCapture;
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("an initiative, its direction, and its cycles survive a manager restart", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-initiative-"));
  const first = loadHarness(undefined, { storageRoot, removeStorageOnDispose: false });
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    await first.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
      desiredOutcome: "Every cancel path is proven",
      acceptanceCriteria: ["No leaked worktree after cancel"],
      constraints: ["No new dependencies"],
    });
    await first.manager.handleMessage({
      type: "initiative.setDirection",
      direction: "Guard the cleanup path in the controller",
    });
    await first.manager.handleMessage({ type: "cycle.start", cycleType: "review" });
    const live = first.manager.getState().direction;
    assert.equal(live.direction.goal, "Cancellation never leaks a worktree");
    assert.equal(live.direction.acceptedDirection, "Guard the cleanup path in the controller");
    assert.equal(live.cycles.length, 2);
    assert.equal(live.currentCycle.type, "review");
  } finally {
    first.subscription.dispose();
    await first.manager.dispose();
  }

  const second = loadHarness(undefined, { storageRoot, removeStorageOnDispose: true });
  try {
    await second.manager.handleMessage({ type: "manager.ready" });
    const restored = second.manager.getState().direction;
    assert.equal(restored.initiative.title, "Stabilize cancellation");
    assert.equal(restored.direction.acceptedDirection, "Guard the cleanup path in the controller");
    assert.deepEqual(restored.direction.acceptanceCriteria, ["No leaked worktree after cancel"]);
    assert.equal(restored.cycles.length, 2);
    assert.equal(
      restored.direction.nextAction.kind,
      "freshReview",
      "a cycle with no recorded round must ask for a review, not for checks nobody ran",
    );
    assert.ok(
      restored.direction.saturation.reasons.every((reason) =>
        !reason.includes("No required check has been run against the current candidate")),
      "a check expectation was invented from a selected run instead of the cycle",
    );
    assert.equal(restored.direction.verification, undefined);
  } finally {
    second.subscription.dispose();
    await second.manager.dispose();
  }
});

test("a fresh review runs one real pipeline with fresh sessions and no prior conclusions", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
      desiredOutcome: "Every cancel path is proven",
      scope: ["src/orchestrator"],
      constraints: ["No new dependencies"],
      acceptanceCriteria: ["No leaked worktree after cancel"],
    });
    const conversationsBefore = harness.manager.getState().conversations.length;
    const cyclesBefore = harness.manager.getState().direction.cycles.length;

    await harness.manager.handleMessage({ type: "review.startFresh" });

    const state = harness.manager.getState();
    assert.equal(
      state.conversations.length,
      conversationsBefore + 1,
      "a fresh review must run in its own conversation",
    );
    const created = state.conversations.at(-1);
    const runtime = harness.runtimeInstances.at(-1);
    assert.equal(runtime.pipelineCalls.length, 1, "a fresh review must launch one pipeline run");
    assert.equal(
      runtime.messages.filter((message) => message.type === "session.reset").length >= 1,
      true,
      "a fresh review must not carry prior provider conversation state",
    );

    const prompt = runtime.pipelineCalls[0].prompt;
    assert.deepEqual(prompt.split("\n"), [
      "Review the current repository state independently.",
      "",
      "Goal: Cancellation never leaks a worktree",
      "Desired outcome: Every cancel path is proven",
      "Scope: src/orchestrator",
      "Constraints: No new dependencies",
      "Acceptance criteria: No leaked worktree after cancel",
      "",
      "Judge only what the current repository shows. No earlier finding, ruling, decision, or confidence is carried into this review.",
    ], "a fresh review prompt carries the initiative and nothing else");
    assert.equal(runtime.pipelineCalls[0].attachmentIds.length, 0);

    const after = harness.manager.getState().direction;
    assert.equal(after.cycles.length, cyclesBefore + 1);
    assert.equal(after.currentCycle.type, "review");
    assert.deepEqual(after.currentCycle.runRefs, [created.runRef]);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a second fresh review stays a round inside the same review cycle", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await harness.manager.handleMessage({ type: "review.startFresh" });
    const firstCycle = harness.manager.getState().direction.currentCycle;
    await harness.manager.handleMessage({ type: "review.startFresh" });
    const secondCycle = harness.manager.getState().direction.currentCycle;
    assert.equal(secondCycle.id, firstCycle.id, "saturation cannot accumulate across new cycles");
    assert.equal(secondCycle.runRefs.length, 2);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a fresh review that cannot run leaves no cycle and no round behind", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    const cyclesBefore = harness.manager.getState().direction.cycles.length;
    harness.options.nextRuntimePreflightError = new Error("Simulated preflight refusal");
    await assert.rejects(
      harness.manager.handleMessage({ type: "review.startFresh" }),
      /Simulated preflight refusal/u,
    );
    const after = harness.manager.getState().direction;
    assert.equal(after.cycles.length, cyclesBefore, "a refused fresh review must open no cycle");
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("conversations in different repositories read and write their own initiative", async () => {
  const harness = loadHarness(undefined, { workingDirectory: "/workspace/alpha" });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Alpha initiative",
      goal: "Alpha goal",
    });
    assert.equal(harness.manager.getState().direction.initiative.title, "Alpha initiative");

    const beta = await harness.manager.createConversation({
      title: "Beta run",
      workingDirectory: "/workspace/beta",
    });
    await harness.manager.handleMessage({ type: "conversation.select", conversationId: beta.id });
    assert.equal(
      harness.manager.getState().direction.initiative,
      undefined,
      "a different repository must not inherit another repository's initiative",
    );

    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Beta initiative",
      goal: "Beta goal",
    });
    assert.equal(harness.manager.getState().direction.initiative.title, "Beta initiative");

    const alphaId = harness.manager.getState().conversations[0].id;
    await harness.manager.handleMessage({ type: "conversation.select", conversationId: alphaId });
    assert.equal(harness.manager.getState().direction.initiative.title, "Alpha initiative");
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("resolution intents are refused when the record is unknown and applied when it exists", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await assert.rejects(
      harness.manager.handleMessage({
        type: "resolution.apply",
        target: "finding",
        id: "FH-does-not-exist",
        action: "accept",
      }),
      /Bachata refused this resolution: no finding is recorded as FH-does-not-exist/u,
    );
    await assert.rejects(
      harness.manager.handleMessage({
        type: "resolution.apply",
        target: "finding",
        id: "FH-does-not-exist",
        action: "reopen",
      }),
      /Reopening requires a reason/u,
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("cycles cannot be started or closed before a goal is recorded", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await assert.rejects(
      harness.manager.handleMessage({ type: "cycle.start", cycleType: "review" }),
      /State the initiative goal before starting a cycle/u,
    );
    await assert.rejects(
      harness.manager.handleMessage({ type: "review.startFresh" }),
      /State the initiative goal before starting a fresh review/u,
    );
    await assert.rejects(
      harness.manager.handleMessage({ type: "cycle.close" }),
      /There is no open cycle to close/u,
    );
    await assert.rejects(
      harness.manager.handleMessage({ type: "initiative.setDirection", direction: "Guess" }),
      /State the initiative goal before recording an accepted direction/u,
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("Bachata refuses to bind an initiative when there is no repository", async () => {
  const harness = loadHarness(undefined, { noWorkingDirectory: true, workspaceFolders: [] });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    assert.equal(harness.manager.getState().direction.initiative, undefined);
    await assert.rejects(
      harness.manager.handleMessage({
        type: "initiative.define",
        title: "Nowhere",
        goal: "Nowhere goal",
      }),
      /cannot bind an initiative without a repository/u,
    );
    assert.equal(
      harness.manager.getState().direction.direction.nextAction.kind,
      "defineInitiative",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

const journeyFinding = (overrides = {}) => ({
  id: overrides.id ?? "cancellation-guard",
  subject: overrides.subject ?? "Cancellation guard",
  message: overrides.message ?? "Cancellation bypasses cleanup",
  disposition: overrides.disposition ?? "accepted",
  evidence: ["Both participants traced the bypass"],
  challenges: ["The finally block was inspected"],
  ...(overrides.location === null ? {} : { location: overrides.location ?? { file: "src/a.ts", startLine: 12 } }),
});

const journeyDecision = {
  subject: "Retry policy for cancelled runs",
  question: "Should a cancelled run retry automatically?",
  affectedScope: ["src/orchestrator"],
  evidence: ["Both participants read the cancel path and disagreed on intent"],
  options: [
    { id: "auto", summary: "Retry once automatically", tradeOffs: ["Hides flaky cancellation"] },
    { id: "manual", summary: "Never retry without a human", tradeOffs: ["More manual work"] },
  ],
  tradeOffs: ["An automatic retry hides the failure that caused the cancel"],
};

const publishJourneyDecision = (instance, candidate, overrides = {}) => {
  instance.beforePipelineRun = async () => {
    instance.options.onPipelineDecision({
      stepId: "review-consensus",
      round: 1,
      policy: "unanimous",
      status: "accepted",
      candidateId: "DJOURNEY",
      candidateHash: `hash-${String(candidate.findings.length)}-${String((candidate.decisions ?? []).length)}`,
      candidate,
      participants: [{ agentId: "codex" }, { agentId: "claude" }],
      objections: [],
      // EX-A5-R04. A real unanimous consensus records who ruled. A fixture that omits it is a
      // review whose ruling provider was never recorded, which is a genuine evidence gap.
      ...(overrides.recordRulingProvenance
        ? {
            rulingProvenance: {
              kind: "unanimousConsensus",
              participants: [{ agentId: "codex" }, { agentId: "claude" }],
            },
          }
        : {}),
      unresolvedRisks: overrides.unresolvedRisks
        ?? ["The provider timed out once", "No reproduction exists yet"],
    });
  };
};

const directionFingerprint = (state) => structuredClone(state.direction);

test("the next action opens a scoped fix for the accepted finding", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-scopedfix-"));
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    configurationValues: {
      freshReviewPipelineId: "review-only",
      fixPipelineId: "fix-only",
    },
    pipelineDefinitions: {
      "cross-reference-development": writeCapableDefinition("cross-reference-development"),
      "review-only": readOnlyReviewDefinition("review-only"),
      "fix-only": writeCapableDefinition("fix-only"),
    },
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(instance, { findings: [journeyFinding()] });
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await harness.manager.handleMessage({ type: "review.startFresh" });

    const reviewed = harness.manager.getState().direction;
    assert.equal(reviewed.direction.nextAction.kind, "fixAcceptedFindings");
    const identity = reviewed.findings[0].identity;
    assert.equal(reviewed.findings[0].humanResolution, undefined);
    assert.deepEqual(reviewed.direction.nextAction.command, {
      type: "startScopedFix",
      identity,
    });

    const conversationsBefore = harness.manager.getState().conversations.length;
    await harness.manager.handleMessage({ type: "direction.runNextAction" });
    const afterFix = harness.manager.getState();
    assert.equal(
      afterFix.conversations.length,
      conversationsBefore + 1,
      "the next action opened no fix conversation",
    );

    const fixRuntime = harness.runtimeInstances.at(-1);
    assert.equal(fixRuntime.pipelineCalls.length, 1, "the scoped fix launched no pipeline run");
    const prompt = fixRuntime.pipelineCalls[0].prompt;
    assert.ok(prompt.includes(reviewed.findings[0].subject), "the fix prompt lost the finding");
    assert.ok(
      prompt.includes("Lead/Worker pipeline accepted this challenged finding"),
      "the fix prompt did not state the finding's pipeline disposition",
    );
    assert.ok(!prompt.includes("A human accepted"), "the fix prompt faked a human resolution");

    const linked = afterFix.direction.fixRuns;
    assert.equal(linked.length, 1, "the fix run was not linked to the finding");
    assert.equal(linked[0].identity, identity);
    assert.equal(linked[0].state, "fixRunning");
    assert.equal(afterFix.direction.findings[0].fixState, "fixRunning");
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("direction stays identical when the human selects a different run tab", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-tabbound-"));
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(instance, { findings: [journeyFinding()] });
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await harness.manager.handleMessage({ type: "review.startFresh" });
    await harness.manager.handleMessage({ type: "review.startFresh" });

    const conversations = harness.manager.getState().conversations;
    assert.ok(conversations.length >= 3, "the journey did not create separate run tabs");

    const seen = [];
    for (const conversation of conversations) {
      await harness.manager.handleMessage({
        type: "conversation.select",
        conversationId: conversation.id,
      });
      seen.push(structuredClone(harness.manager.getState().direction));
    }
    for (const observed of seen.slice(1)) {
      assert.deepEqual(
        observed,
        seen[0],
        "selecting a different run tab changed the recorded direction",
      );
    }
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("the flagship longitudinal journey survives restart and terminal replay", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-journey-"));
  const workspaceState = new Map();
  const milestones = [];
  const first = loadHarness(undefined, {
    storageRoot,
    workspaceState,
    removeStorageOnDispose: false,
    // EX-A5-R04. A review that counts as an independent observation is one that reached a usable
    // assessment: no unresolved risk, and every piece of evidence its read-only workflow declares
    // recorded.
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(instance, {
        findings: [journeyFinding()],
        decisions: [journeyDecision],
      }, { unresolvedRisks: [], recordRulingProvenance: true });
    },
  });
  let fingerprint;
  try {
    first.manager.setOnboardingObserver((event) => milestones.push(event.kind));
    await first.manager.handleMessage({ type: "manager.ready" });
    await first.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
      desiredOutcome: "Every cancel path is proven",
      scope: ["src/orchestrator"],
      constraints: ["No new dependencies"],
      acceptanceCriteria: ["No leaked worktree after cancel"],
    });

    const conversationsBefore = first.manager.getState().conversations.length;
    await first.manager.handleMessage({ type: "review.startFresh" });
    const afterFirst = first.manager.getState();
    assert.equal(
      afterFirst.conversations.length,
      conversationsBefore + 1,
      "the fresh review did not run in its own conversation",
    );
    const firstRuntime = first.runtimeInstances.at(-1);
    assert.equal(firstRuntime.pipelineCalls.length, 1, "the fresh review launched no pipeline run");
    assert.equal(
      firstRuntime.messages.some((message) => message.type === "session.reset"),
      true,
      "the fresh review reused provider sessions",
    );
    const prompt = firstRuntime.pipelineCalls[0].prompt;
    assert.equal(prompt.includes("Cancellation never leaks a worktree"), true);
    for (const leak of [
      "Cancellation bypasses cleanup",
      "Cancellation guard",
      "Retry policy",
      "Both participants traced the bypass",
      "The finally block was inspected",
      "occurrences",
    ]) {
      assert.equal(
        prompt.includes(leak),
        false,
        `a prior conclusion leaked into the fresh review prompt: ${leak}`,
      );
    }

    const cycle = afterFirst.direction.currentCycle;
    assert.equal(cycle.type, "review");
    assert.equal(afterFirst.direction.artifacts.length, 1, "no findingSet artifact was produced");
    const artifact = afterFirst.direction.artifacts[0];
    assert.equal(artifact.type, "findingSet");
    assert.equal(artifact.state, "proposed");
    assert.deepEqual(cycle.outputArtifactIds, [artifact.id]);
    assert.equal(afterFirst.direction.decisions.length, 1, "no typed decision was produced");
    assert.equal(afterFirst.direction.decisions[0].question, journeyDecision.question);
    assert.deepEqual(
      afterFirst.direction.decisions.map((decision) => decision.subject),
      ["Retry policy for cancelled runs"],
      "an operational error or unresolved risk was promoted to a decision",
    );
    assert.equal(afterFirst.direction.findings.length, 1);
    assert.equal(afterFirst.direction.direction.nextAction.kind, "resolveDecisions");

    await first.manager.handleMessage({
      type: "resolution.apply",
      target: "artifact",
      id: artifact.id,
      action: "accept",
    });
    await first.manager.handleMessage({
      type: "resolution.apply",
      target: "decision",
      id: afterFirst.direction.decisions[0].id,
      action: "accept",
    });
    await first.manager.handleMessage({
      type: "resolution.apply",
      target: "finding",
      id: afterFirst.direction.findings[0].identity,
      action: "defer",
    });
    const resolved = first.manager.getState().direction;
    assert.deepEqual(
      resolved.direction.acceptedArtifacts.map((item) => item.id),
      [artifact.id],
    );
    assert.deepEqual(resolved.direction.decisionsNeedingHuman, []);
    assert.equal(resolved.decisions[0].humanResolution.action, "accept");
    assert.equal(resolved.artifacts[0].humanResolution.action, "accept");
    assert.equal(resolved.findings[0].humanResolution.action, "defer");
    assert.ok(resolved.artifacts[0].evidence.length > 0, "the artifact recorded no evidence");
    assert.deepEqual(resolved.decisions[0].affectedScope, ["src/orchestrator"]);
    assert.ok(resolved.decisions[0].evidence.length > 0, "the decision recorded no evidence");

    await first.manager.handleMessage({ type: "review.startFresh" });
    const afterSecond = first.manager.getState().direction;
    assert.equal(
      afterSecond.currentCycle.id,
      cycle.id,
      "the second fresh review opened a new cycle, so saturation cannot accumulate",
    );
    assert.equal(afterSecond.currentCycle.runRefs.length, 2);
    assert.equal(
      afterSecond.findings.length,
      1,
      "a repeated finding was tracked as a second finding",
    );
    assert.equal(afterSecond.findings[0].occurrences, 2);
    assert.deepEqual(
      afterSecond.direction.latestChange.newMaterial.map((item) => item.identity),
      [],
      "a repeated finding was reported as new material",
    );
    assert.equal(afterSecond.artifacts.length, 1, "an unchanged finding set produced a revision");
    assert.equal(afterSecond.saturation.quietFreshReviews, 1);
    assert.deepEqual(
      afterSecond.direction.latestChange.decisionChanges,
      [],
      "a retained decision was reported as changed by the second round",
    );
    assert.deepEqual(
      afterSecond.direction.latestChange.resolved,
      [],
      "an earlier human resolution was attributed to the second round",
    );
    assert.ok(afterSecond.direction.nextAction.kind);
    fingerprint = directionFingerprint(first.manager.getState());

    await first.manager.handleMessage({ type: "manager.ready" });
    assert.deepEqual(
      directionFingerprint(first.manager.getState()),
      fingerprint,
      "re-projecting the terminal executions changed longitudinal state",
    );
    assert.deepEqual(
      milestones.filter((kind) => kind.startsWith("freshReview")),
      ["freshReviewCompleted", "freshReviewCompleted", "freshReviewCompared"],
      "the comparison milestone did not require a second round",
    );
  } finally {
    first.subscription.dispose();
    await first.manager.dispose();
  }

  const second = loadHarness(undefined, {
    storageRoot,
    workspaceState,
    removeStorageOnDispose: true,
  });
  try {
    await second.manager.handleMessage({ type: "manager.ready" });
    const restored = second.manager.getState();
    assert.deepEqual(
      directionFingerprint(restored),
      fingerprint,
      "longitudinal state changed across a manager and catalog restart",
    );
    assert.equal(restored.direction.decisions[0].humanResolution.action, "accept");
    assert.equal(restored.direction.artifacts[0].humanResolution.action, "accept");
    assert.equal(restored.direction.findings[0].humanResolution.action, "defer");
    assert.deepEqual(restored.direction.direction.latestChange.decisionChanges, []);
  } finally {
    second.subscription.dispose();
    await second.manager.dispose();
  }
});

test("a fresh review refuses a workflow that can write", async () => {
  const harness = loadHarness(undefined, {
    pipelineDefinitions: { "cross-reference-development": writeCapableDefinition("cross-reference-development") },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    const conversationsBefore = harness.manager.getState().conversations.length;
    const cyclesBefore = harness.manager.getState().direction.cycles.length;
    await assert.rejects(
      harness.manager.handleMessage({ type: "review.startFresh" }),
      /is interactive, not read-only/u,
    );
    const after = harness.manager.getState();
    assert.equal(
      after.conversations.length,
      conversationsBefore,
      "a refused fresh review still created a conversation",
    );
    assert.equal(after.direction.cycles.length, cyclesBefore);
    assert.equal(
      harness.runtimeInstances.every((instance) => instance.pipelineCalls.length === 0),
      true,
      "a write-capable workflow was launched by a fresh review",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a fresh review refuses a checklist workflow even when it is configured", async () => {
  const harness = loadHarness(undefined, {
    configurationValues: { freshReviewPipelineId: "todo-master" },
    pipelineDefinitions: {
      "cross-reference-development": writeCapableDefinition("cross-reference-development"),
      "todo-master": {
        ...readOnlyReviewDefinition("todo-master"),
        steps: [{
          id: "execute",
          type: "executeChecklist",
          name: "Execute",
          enabled: true,
          humanGate: "none",
        }],
      },
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await assert.rejects(
      harness.manager.handleMessage({ type: "review.startFresh" }),
      /bachata\.freshReviewPipelineId workflow todo-master is orchestration, not read-only/u,
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a fresh review falls back to the configured read-only workflow and resets sessions once", async () => {
  const harness = loadHarness(undefined, {
    configurationValues: { freshReviewPipelineId: "review-only" },
    pipelineDefinitions: {
      "cross-reference-development": writeCapableDefinition("cross-reference-development"),
      "review-only": readOnlyReviewDefinition("review-only"),
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await harness.manager.handleMessage({ type: "review.startFresh" });
    const created = harness.manager.getState().conversations.at(-1);
    assert.equal(created.selectedPipelineId, "review-only");
    const runtime = harness.runtimeInstances.at(-1);
    assert.equal(runtime.pipelineCalls.length, 1);
    assert.equal(
      runtime.messages.filter((message) => message.type === "session.reset").length,
      1,
      "provider sessions were reset more than once for one fresh review",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

const gitRepository = (root) => {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  return root;
};

test("nested and symlinked paths to one repository share the initiative, separate repositories do not", async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bachata-canonical-")));
  const repository = gitRepository(path.join(base, "repo"));
  const nested = path.join(repository, "package");
  mkdirSync(nested, { recursive: true });
  const alias = path.join(base, "alias");
  symlinkSync(repository, alias, "dir");
  const other = gitRepository(path.join(base, "other"));

  const harness = loadHarness(undefined, { workingDirectory: repository });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Canonical initiative",
      goal: "One repository, one initiative",
    });
    assert.equal(
      harness.manager.getState().direction.initiative.title,
      "Canonical initiative",
    );

    for (const [label, directory] of [["nested", nested], ["symlinked", alias]]) {
      const conversation = await harness.manager.createConversation({
        title: `${label} run`,
        workingDirectory: directory,
      });
      await harness.manager.handleMessage({
        type: "conversation.select",
        conversationId: conversation.id,
      });
      assert.equal(
        harness.manager.getState().direction.initiative?.title,
        "Canonical initiative",
        `a ${label} path to the same repository opened a separate initiative`,
      );
    }

    const separate = await harness.manager.createConversation({
      title: "other repository",
      workingDirectory: other,
    });
    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: separate.id,
    });
    assert.equal(
      harness.manager.getState().direction.initiative,
      undefined,
      "a separate repository inherited another repository's initiative",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
    rmSync(base, { recursive: true, force: true });
  }
});

test("a fresh review refuses a read-only workflow that produces no review findings", async () => {
  for (const pipelineId of ["claude-plan", "core-decisions", "custom-readonly"]) {
    const harness = loadHarness(undefined, {
      pipelineDefinitions: {
        "cross-reference-development": readOnlyNonReviewDefinition(pipelineId),
      },
    });
    try {
      await harness.manager.handleMessage({ type: "manager.ready" });
      await harness.manager.handleMessage({
        type: "initiative.define",
        title: "Stabilize cancellation",
        goal: "Cancellation never leaks a worktree",
      });
      const cyclesBefore = harness.manager.getState().direction.cycles.length;
      await assert.rejects(
        harness.manager.handleMessage({ type: "review.startFresh" }),
        /produces no review findings/u,
        `${pipelineId} was accepted as a fresh review workflow`,
      );
      assert.equal(harness.manager.getState().direction.cycles.length, cyclesBefore);
      assert.equal(
        harness.runtimeInstances.every((instance) => instance.pipelineCalls.length === 0),
        true,
      );
    } finally {
      harness.subscription.dispose();
      await harness.manager.dispose();
    }
  }
});

test("a fresh review validates against the current catalog and executes that exact snapshot", async () => {
  const harness = loadHarness(undefined, {
    pipelineDefinitions: {
      "cross-reference-development": readOnlyReviewDefinition("cross-reference-development"),
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await harness.manager.handleMessage({ type: "review.startFresh" });
    const source = harness.runtimeInstances[0];
    assert.equal(
      source.resolveSnapshotCalls.some((call) => call.options.requireCurrentCatalog === true),
      true,
      "the fresh review workflow was not validated against the current catalog",
    );
    assert.equal(
      source.resolveSnapshotCalls.every((call) => call.options.rejectChecklist === true),
      true,
    );
    const runtime = harness.runtimeInstances.at(-1);
    assert.equal(
      runtime.preflightCalls[0].snapshotHash,
      "hash-cross-reference-development",
      "the validated snapshot was not the snapshot handed to preflight",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a workflow that changes after validation cannot execute in a fresh review", async () => {
  const harness = loadHarness(undefined, {
    pipelineDefinitions: {
      "cross-reference-development": readOnlyReviewDefinition("cross-reference-development"),
    },
    preflightSnapshot: (snapshot) => ({
      ...snapshot,
      hash: "hash-mutated",
      definition: writeCapableDefinition("cross-reference-development"),
    }),
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await assert.rejects(
      harness.manager.handleMessage({ type: "review.startFresh" }),
      /changed after it was validated/u,
    );
    assert.equal(
      harness.runtimeInstances.every((instance) => instance.pipelineCalls.length === 0),
      true,
      "a mutated workflow was executed by a fresh review",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a linked worktree shares the initiative of its main worktree", async () => {
  const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bachata-worktree-")));
  const repository = gitRepository(path.join(base, "repo"));
  writeFileSync(path.join(repository, "a.txt"), "a\n");
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"], { cwd: repository });
  execFileSync(
    "git",
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "--quiet", "-m", "seed"],
    { cwd: repository },
  );
  const linked = path.join(base, "linked");
  execFileSync("git", ["worktree", "add", "--quiet", "-b", "linked-branch", linked], { cwd: repository });

  const harness = loadHarness(undefined, { workingDirectory: repository });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Worktree initiative",
      goal: "One repository, one initiative",
    });
    const conversation = await harness.manager.createConversation({
      title: "linked worktree run",
      workingDirectory: linked,
    });
    await harness.manager.handleMessage({
      type: "conversation.select",
      conversationId: conversation.id,
    });
    assert.equal(
      harness.manager.getState().direction.initiative?.title,
      "Worktree initiative",
      "a linked worktree of the same repository opened a separate initiative",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
    execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: repository });
    rmSync(base, { recursive: true, force: true });
  }
});

test("a terminal run stays in the cycle it ran in when a new cycle is opened", async () => {
  const harness = loadHarness(undefined, {
    // This run records against an initiative, so it resolves the snapshot that declares it.
    preflightSnapshot: (snapshot) => snapshot ?? {
      version: 1,
      definition: readOnlyReviewDefinition("review-only"),
      hash: "hash-review-only",
      scopeKey: "workspace:/repo",
    },
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(instance, { findings: [journeyFinding()] });
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await harness.manager.handleMessage({ type: "cycle.start", cycleType: "review" });
    const reviewCycle = harness.manager.getState().direction.currentCycle;

    await harness.manager.runConversation("default", "review the repository");
    const afterRun = harness.manager.getState().direction;
    assert.equal(afterRun.findings.length, 1);
    assert.equal(afterRun.findings[0].occurrences, 1);
    assert.deepEqual(
      afterRun.cycles.find((cycle) => cycle.id === reviewCycle.id).runRefs.length,
      1,
      "an ordinary run was not bound to the cycle it ran in",
    );

    await harness.manager.handleMessage({ type: "cycle.start", cycleType: "planning" });
    const planning = harness.manager.getState().direction.currentCycle;
    assert.notEqual(planning.id, reviewCycle.id);
    await harness.manager.handleMessage({ type: "manager.ready" });

    const after = harness.manager.getState().direction;
    assert.equal(
      after.findings[0].occurrences,
      1,
      "the same execution was folded a second time into a later cycle",
    );
    assert.deepEqual(
      after.cycles.find((cycle) => cycle.id === planning.id).runRefs,
      [],
      "a terminal run from an earlier cycle was replayed into the new cycle",
    );
    assert.deepEqual(
      after.cycles.find((cycle) => cycle.id === planning.id).acceptedStateDelta.newFindingIdentities,
      [],
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

const { mainWorktreeRootFromCommonDir } = require("../dist/concurrency/repositoryResources.js");

test("the main worktree root is derived without assuming POSIX separators", () => {
  assert.equal(mainWorktreeRootFromCommonDir("/repo/.git"), "/repo");
  assert.equal(mainWorktreeRootFromCommonDir("/repo/.git/"), "/repo");
  assert.equal(mainWorktreeRootFromCommonDir("C:\\repo\\.git"), "C:/repo");
  assert.equal(mainWorktreeRootFromCommonDir("C:/repo/.git"), "C:/repo");
  assert.equal(mainWorktreeRootFromCommonDir("/a/b/c/.git"), "/a/b/c");
  assert.equal(mainWorktreeRootFromCommonDir("/.git"), "/");

  for (const notARoot of [
    "/repo/not.git",
    "/repo/.github",
    "/repo/.git/modules/x",
    "C:\\repo\\.git\\worktrees\\linked",
    "/repo",
    ".git",
    "",
  ]) {
    assert.equal(
      mainWorktreeRootFromCommonDir(notARoot),
      undefined,
      `${notARoot} was treated as a main worktree root`,
    );
  }

  const { repositoryIdentity } = require("../dist/longitudinal/service.js");
  assert.equal(
    repositoryIdentity(mainWorktreeRootFromCommonDir("C:\\repo\\.git")),
    repositoryIdentity("C:\\repo"),
    "the Windows-shaped main root did not normalise to the same repository identity",
  );
});

test("applying a fix records against its own initiative after the human switched away", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-applyswitch-"));
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    configurationValues: {
      freshReviewPipelineId: "review-only",
      fixPipelineId: "fix-only",
    },
    pipelineDefinitions: {
      "cross-reference-development": writeCapableDefinition("cross-reference-development"),
      "review-only": readOnlyReviewDefinition("review-only"),
      "fix-only": writeCapableDefinition("fix-only"),
    },
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(instance, { findings: [journeyFinding()] });
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await harness.manager.handleMessage({ type: "review.startFresh" });
    const identity = harness.manager.getState().direction.findings[0].identity;
    await harness.manager.handleMessage({
      type: "resolution.apply",
      target: "finding",
      id: identity,
      action: "accept",
    });
    await harness.manager.handleMessage({ type: "direction.runNextAction" });

    const firstInitiativeId = harness.manager.getState().direction.initiative.id;
    assert.equal(harness.manager.getState().direction.fixRuns.length, 1);

    await harness.manager.handleMessage({
      type: "initiative.create",
      title: "Unrelated work",
      goal: "Something else",
    });
    const switched = harness.manager.getState().direction;
    assert.notEqual(switched.initiative.id, firstInitiativeId);
    assert.deepEqual(switched.fixRuns, [], "the new initiative inherited a fix run");

    await harness.manager.handleMessage({
      type: "initiative.switch",
      initiativeId: firstInitiativeId,
    });
    const restored = harness.manager.getState().direction;
    assert.equal(restored.fixRuns.length, 1);
    assert.equal(restored.fixRuns[0].identity, identity);
    assert.equal(restored.findings[0].fixState, "fixRunning");
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

// EX-G6-03. A review that errored or was interrupted stopped looking before it finished. It did
// not observe the absence of anything, so its silence must not mark findings unobserved, must not
// promote an applied fix to verified, and must not add a quiet round to the signal that says the
// cycle can close. The round is still recorded; what it is not is an independent review.
test("a fresh review that was interrupted does not count as a quiet review", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-incomplete-review-"));
  let runtimes = 0;
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    configurationValues: { freshReviewPipelineId: "review-only" },
    pipelineDefinitions: {
      "cross-reference-development": writeCapableDefinition("cross-reference-development"),
      "review-only": readOnlyReviewDefinition("review-only"),
    },
    onRuntimeCreated: (instance) => {
      runtimes += 1;
      publishJourneyDecision(instance, { findings: [] }, {
        unresolvedRisks: [],
        recordRulingProvenance: true,
      });
      // The manager's own conversation is the first runtime, so this is the third review: the
      // one that stops partway. It still leaves evidence behind, which is what makes it reach
      // the recorder at all.
      if (runtimes === 4) {
        instance.pipelineResults.push({
          status: "interrupted",
          answers: {},
          outputs: {},
          decisions: [],
          roles: {},
        });
      }
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });

    await harness.manager.handleMessage({ type: "review.startFresh" });
    await harness.manager.handleMessage({ type: "review.startFresh" });
    const afterCompleted = harness.manager.getState().direction;
    const quietAfterCompleted = afterCompleted.saturation.quietFreshReviews;
    assert.ok(
      quietAfterCompleted >= 1,
      `two completed quiet fresh reviews counted ${String(quietAfterCompleted)}`,
    );

    await harness.manager.handleMessage({ type: "review.startFresh" });
    const afterInterrupted = harness.manager.getState().direction;
    assert.equal(
      afterInterrupted.saturation.quietFreshReviews,
      quietAfterCompleted,
      "an interrupted review was counted as a quiet independent review of the candidate",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

// EX-A5-R04. Workflow completion is not an observation. A round may resolve findings and count
// toward saturation only when the pipeline it executed is known, the evidence that pipeline
// declares was recorded, and the run's own assessment came out usable. The expectations are the
// executed pipeline's, kept with the run, never inferred as "everything is owed" because the
// definition was mislaid — and an inconclusive or uninspected round stays visible history.
const freshReviewRound = async (options = {}) => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-review-eligibility-"));
  const milestones = [];
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    configurationValues: { freshReviewPipelineId: "review-only" },
    pipelineDefinitions: {
      "cross-reference-development": writeCapableDefinition("cross-reference-development"),
      "review-only": options.reviewDefinition ?? readOnlyReviewDefinition("review-only"),
    },
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(
        instance,
        { findings: [journeyFinding(options.finding ?? {})] },
        { unresolvedRisks: [], recordRulingProvenance: true, ...(options.decision ?? {}) },
      );
    },
  });
  harness.manager.setOnboardingObserver((event) => milestones.push(event.kind));
  await harness.manager.handleMessage({ type: "manager.ready" });
  await harness.manager.handleMessage({
    type: "initiative.define",
    title: "Stabilize cancellation",
    goal: "Cancellation never leaks a worktree",
  });
  await harness.manager.handleMessage({ type: "review.startFresh" });
  const counted = milestones.includes("freshReviewCompleted");
  const direction = harness.manager.getState().direction;
  return { harness, counted, direction };
};

test("a read-only review that recorded what its workflow declares counts as an independent review", async () => {
  const round = await freshReviewRound();
  try {
    // The read-only workflow declares no write authority and no controller verification, so
    // neither is owed. Under the fallback that inferred every expectation as true this round
    // owed changed files and a check result, and was inconclusive for lacking both.
    assert.equal(round.counted, true, "a complete read-only review did not count as one");
  } finally {
    round.harness.subscription.dispose();
    await round.harness.manager.dispose();
  }
});

test("a review that recorded it could not inspect what it was asked to does not count", async () => {
  const round = await freshReviewRound({
    decision: {
      unresolvedRisks: ["src/orchestrator could not be read, so it was not inspected"],
    },
  });
  try {
    assert.equal(round.counted, false, "an uninspected review counted as an independent review");
  } finally {
    round.harness.subscription.dispose();
    await round.harness.manager.dispose();
  }
});

test("an inconclusive review is recorded as history and resolves no finding", async () => {
  const round = await freshReviewRound({ finding: { disposition: "unresolved" } });
  try {
    // A finding the review itself left unresolved makes its assessment inconclusive, so the
    // round observed nothing it may act on — and it is still recorded, because it happened.
    assert.equal(round.counted, false, "an inconclusive review counted as an independent review");
    assert.equal(round.direction.saturation.quietFreshReviews, 0);
    assert.ok(round.direction.findings.length > 0, "the round was dropped rather than recorded");
  } finally {
    round.harness.subscription.dispose();
    await round.harness.manager.dispose();
  }
});

test("a review workflow that declares controller verification still owes a check result", async () => {
  const round = await freshReviewRound({
    reviewDefinition: {
      ...readOnlyReviewDefinition("review-only"),
      roles: [{ id: "reviewer", verificationChecks: ["npm test"] }],
    },
  });
  try {
    assert.equal(
      round.counted,
      false,
      "a workflow declaring controller verification counted a review that recorded none",
    );
  } finally {
    round.harness.subscription.dispose();
    await round.harness.manager.dispose();
  }
});

test("a fresh review against an unchanged candidate keeps the quiet streak", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-quiet-"));
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    configurationValues: { freshReviewPipelineId: "review-only" },
    pipelineDefinitions: {
      "cross-reference-development": writeCapableDefinition("cross-reference-development"),
      "review-only": readOnlyReviewDefinition("review-only"),
    },
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(instance, { findings: [] });
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });

    await harness.manager.handleMessage({ type: "review.startFresh" });
    const first = harness.manager.getState().direction;
    const epochAfterFirst = first.currentCycle.baselineEpoch ?? 1;

    await harness.manager.handleMessage({ type: "review.startFresh" });
    const second = harness.manager.getState().direction;

    assert.equal(
      second.currentCycle.baselineEpoch ?? 1,
      epochAfterFirst,
      "a fresh review against an unchanged candidate bumped the baseline epoch",
    );
    assert.equal(
      second.cycles.filter((item) => item.type === "review").length,
      1,
      "the second fresh review opened a second review cycle",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("initiative export drops a digest whose content path exclusion changed", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-initiative-export-"));
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-initiative-repo-"));
  mkdirSync(path.join(repositoryRoot, ".bachata"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, ".bachata", "export-policy.json"),
    JSON.stringify({ version: 1, redactLiterals: [], excludePathPrefixes: ["private/"] }),
    "utf8",
  );
  const saveDialogPath = path.join(storageRoot, "initiative.json");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    workingDirectory: repositoryRoot,
    configurationValues: { freshReviewPipelineId: "review-only" },
    pipelineDefinitions: {
      "cross-reference-development": writeCapableDefinition("cross-reference-development"),
      "review-only": readOnlyReviewDefinition("review-only"),
    },
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(instance, {
        findings: [journeyFinding({ location: { file: "private/secret.ts", startLine: 3 } })],
      });
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await harness.manager.handleMessage({ type: "review.startFresh" });

    const before = harness.manager.getState().direction.artifacts;
    assert.ok(before.length > 0, "the journey produced no artifact to export");
    assert.ok(
      before.some((artifact) => artifact.contentDigest),
      "the exported artifact carries no digest, so this test proves nothing",
    );
    assert.ok(
      before.some((artifact) => artifact.body.includes("private/secret.ts")),
      "the artifact body does not carry the excluded path, so this test proves nothing",
    );

    await harness.manager.handleMessage({ type: "initiative.export" });

    const written = JSON.parse(readFileSync(saveDialogPath, "utf8"));
    assert.equal(
      JSON.stringify(written).includes("private/secret.ts"),
      false,
      "an excluded path survived the initiative export",
    );
    const changed = written.artifacts.filter((artifact) => {
      const original = before.find((item) => item.id === artifact.id);
      return original !== undefined && original.body !== artifact.body;
    });
    assert.ok(
      changed.length > 0,
      "path exclusion changed no artifact body, so this test proves nothing",
    );
    changed.forEach((artifact) => {
      assert.equal(
        artifact.contentDigest,
        undefined,
        "an artifact whose body changed kept the digest of its original content",
      );
    });
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("an initiative-required run refuses before any provider executes", async () => {
  const harness = loadHarness(undefined, {
    preflightSnapshot: (snapshot) => snapshot ?? {
      version: 1,
      definition: readOnlyReviewDefinition("review-only"),
      hash: "hash-review-only",
      scopeKey: "workspace:/repo",
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    // No initiative is defined.
    const refusal = await harness.manager
      .runConversation("default", "review the repository")
      .then(() => undefined, (error) => error);
    assert.ok(refusal, "an initiative-required run started without an initiative");
    assert.match(refusal.message, /refused this run before starting any provider/u);
    assert.match(refusal.message, /records its result against an initiative/u);
    assert.match(refusal.message, /state the goal|Bachata: Setup/u);

    assert.deepEqual(
      harness.runtimeInstances.flatMap((instance) =>
        (instance.messages ?? []).filter((message) => message.type === "pipeline.run")),
      [],
      "a provider was started by a run that should have been refused",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a run-local workflow runs with no initiative and reports no longitudinal failure", async () => {
  const runLocal = {
    ...readOnlyReviewDefinition("chatgpt-browser-spike"),
    longitudinalIntent: "runLocal",
  };
  const harness = loadHarness(undefined, {
    pipelineDefinitions: { "chatgpt-browser-spike": runLocal },
    preflightSnapshot: () => ({
      version: 1,
      definition: runLocal,
      hash: "hash-spike",
      scopeKey: "workspace:/repo",
    }),
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(instance, { findings: [journeyFinding()] });
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.runConversation("default", "poke the browser");
    const direction = harness.manager.getState().direction;
    assert.equal(direction.initiative, undefined, "a run-local workflow created an initiative");
    assert.deepEqual(direction.findings, [], "a run-local workflow wrote durable state");
    assert.deepEqual(
      harness.outputLines.filter((message) => /longitudinal|initiative/iu.test(message)),
      [],
      "a run-local workflow reported a longitudinal failure it never attempted",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a run keeps the intent it started with across a restart", async () => {
  const harness = loadHarness(undefined, {
    preflightSnapshot: (snapshot) => snapshot ?? {
      version: 1,
      definition: readOnlyReviewDefinition("review-only"),
      hash: "hash-review-only",
      scopeKey: "workspace:/repo",
    },
    onRuntimeCreated: (instance) => {
      publishJourneyDecision(instance, { findings: [journeyFinding()] });
    },
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    await harness.manager.handleMessage({
      type: "initiative.define",
      title: "Stabilize cancellation",
      goal: "Cancellation never leaks a worktree",
    });
    await harness.manager.handleMessage({ type: "cycle.start", cycleType: "review" });
    await harness.manager.runConversation("default", "review the repository");
    const conversation = harness.manager.getState().conversations
      .find((item) => item.id === "default");
    assert.equal(
      conversation.longitudinalIntent,
      "initiativeRequired",
      "the run did not persist the intent it started with",
    );
    assert.equal(harness.manager.getState().direction.findings.length, 1);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

const forgedRunSettings = () => ({
  schema: "bachata.run-settings.v1",
  values: { agentTurnTimeoutMs: 111_000 },
  recorded: { todoFile: "ATTACKER.md" },
  authority: {
    disabledProviders: ["claude-code"],
    codexCommand: "/tmp/attacker",
    browserActionDestructivePolicy: "auto",
  },
  secretReferences: ["somethingElse"],
});

const effectiveRunSettings = () => ({
  schema: "bachata.run-settings.v1",
  values: { agentTurnTimeoutMs: 111_000 },
  recorded: { todoFile: "TODO.md" },
  authority: {
    disabledProviders: [],
    codexCommand: "codex",
    browserActionDestructivePolicy: "ask",
  },
  secretReferences: ["providerEnvironmentVariables"],
});

test("a replayed run exports the settings it executed under, not the ones its source recorded", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-replay-provenance-"));
  const saveDialogPath = path.join(storageRoot, "replay.bachata-run.json");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    providePipelineSnapshot: true,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Replay of R1234",
      runSettings: forgedRunSettings(),
    });

    const runtime = harness.runtimeInstances.at(-1);
    runtime.state.executionContract = {
      provenance: { extensionVersion: "0.7.0", runSettings: effectiveRunSettings() },
    };
    runtime.reportPipelineStep = true;
    runtime.pipelineResults.push({
      status: "completed",
      answers: {},
      outputs: {},
      decisions: [],
      roles: {},
    });

    await harness.manager.runConversation(conversation.id, "Replay the recorded input");

    await harness.manager.handleMessage({
      type: "conversation.exportBundle",
      conversationId: conversation.id,
    });
    const bundle = JSON.parse(readFileSync(saveDialogPath, "utf8"));

    assert.deepEqual(
      bundle.run.runSettings.authority,
      effectiveRunSettings().authority,
      "the run must publish the authority it actually executed under",
    );
    assert.equal(bundle.run.runSettings.recorded.todoFile, "TODO.md");
    assert.deepEqual(bundle.run.runSettings.secretReferences, ["providerEnvironmentVariables"]);
    assert.equal(
      bundle.run.runSettings.values.agentTurnTimeoutMs,
      111_000,
      "a pinned value the source recorded is still what the run ran on",
    );
    assert.deepEqual(
      bundle.run.replaySourceSettings.authority,
      forgedRunSettings().authority,
      "the source snapshot is kept, but only as the source's own evidence",
    );
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a replay that has not run yet claims no settings of its own", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-replay-unrun-"));
  const saveDialogPath = path.join(storageRoot, "unrun.bachata-run.json");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    providePipelineSnapshot: true,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Replay of R1234",
      runSettings: forgedRunSettings(),
    });
    await harness.manager.handleMessage({
      type: "conversation.exportBundle",
      conversationId: conversation.id,
    });
    const bundle = JSON.parse(readFileSync(saveDialogPath, "utf8"));
    assert.equal(
      bundle.run.runSettings,
      null,
      "a run that has executed nothing must not present imported settings as its own",
    );
    assert.deepEqual(bundle.run.replaySourceSettings.authority, forgedRunSettings().authority);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("an unstarted replay still executes on its recorded settings after a restart", async () => {
  const first = loadHarness(undefined, { removeStorageOnDispose: false });
  let second;
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    const conversation = await first.manager.createConversation({
      title: "Replay of R1234",
      pipelineId: "cross-reference-development",
      workingDirectory: "/workspace",
      runSettings: forgedRunSettings(),
    });
    const storageRoot = first.storageRoot;
    const workspaceState = first.workspaceState;
    first.subscription.dispose();
    await first.manager.dispose();

    const saveDialogPath = path.join(storageRoot, "restarted.bachata-run.json");
    second = loadHarness(undefined, {
      storageRoot,
      workspaceState,
      saveDialogPath,
      providePipelineSnapshot: true,
      removeStorageOnDispose: true,
    });
    await second.manager.handleMessage({ type: "manager.ready" });
    await second.manager.handleMessage({
      type: "conversation.select",
      conversationId: conversation.id,
    });
    const runtime = second.runtimeInstances.at(-1);
    assert.deepEqual(
      runtime.options.recordedRunSettings.values,
      forgedRunSettings().values,
      "a replay that had not run must still be handed the pinned values it was created with",
    );
    assert.equal(
      runtime.options.recordedRunSettings.secretReferences.includes("somethingElse"),
      false,
      "a stored snapshot is rebuilt from Bachata's declarations on the way back in",
    );

    runtime.state.executionContract = {
      provenance: { extensionVersion: "0.7.0", runSettings: effectiveRunSettings() },
    };
    runtime.reportPipelineStep = true;
    runtime.pipelineResults.push({
      status: "completed",
      answers: {},
      outputs: {},
      decisions: [],
      roles: {},
    });
    await second.manager.runConversation(conversation.id, "Replay the recorded input");
    await second.manager.handleMessage({
      type: "conversation.exportBundle",
      conversationId: conversation.id,
    });
    const bundle = JSON.parse(readFileSync(saveDialogPath, "utf8"));
    assert.deepEqual(
      bundle.run.replaySourceSettings.authority,
      forgedRunSettings().authority,
      "the source snapshot must survive a restart as the source's own evidence",
    );
    assert.deepEqual(
      bundle.run.runSettings.authority,
      effectiveRunSettings().authority,
      "and the run must still publish the authority it executed under",
    );
  } finally {
    second?.subscription.dispose();
    await second?.manager.dispose();
  }
});

test("a stored snapshot Bachata cannot apply is disclosed after a restart, not resumed in silence", async () => {
  const first = loadHarness(undefined, { removeStorageOnDispose: false });
  let second;
  try {
    await first.manager.handleMessage({ type: "manager.ready" });
    const conversation = await first.manager.createConversation({
      title: "Replay of R1234",
      pipelineId: "cross-reference-development",
      workingDirectory: "/workspace",
      runSettings: forgedRunSettings(),
    });
    const storageRoot = first.storageRoot;
    const workspaceState = first.workspaceState;
    first.subscription.dispose();
    await first.manager.dispose();

    // Someone edits the stored row: an out-of-enum value and a key Bachata does not record.
    const database = new DatabaseSync(path.join(storageRoot, "bachata-state.sqlite"));
    const row = database
      .prepare("SELECT replay_source_settings_json FROM runs WHERE run_ref = ?")
      .get(conversation.runRef ?? conversation.id);
    const damaged = JSON.parse(row.replay_source_settings_json);
    damaged.values.browserSelectorHealingBackend = "attacker-backend";
    damaged.values.notAKnownSetting = 1;
    database
      .prepare("UPDATE runs SET replay_source_settings_json = ? WHERE run_ref = ?")
      .run(JSON.stringify(damaged), conversation.runRef ?? conversation.id);
    database.close();

    second = loadHarness(undefined, {
      storageRoot,
      workspaceState,
      removeStorageOnDispose: true,
    });
    await second.manager.handleMessage({ type: "manager.ready" });
    await second.manager.handleMessage({
      type: "conversation.select",
      conversationId: conversation.id,
    });
    const runtime = second.runtimeInstances.at(-1);
    const rejected = runtime.options.rejectedRecordedRunSettings ?? [];
    const keys = rejected.map((entry) => entry.key);
    assert.equal(
      keys.includes("browserSelectorHealingBackend"),
      true,
      "a stored value outside its declared enum must reach the run as a refusal",
    );
    assert.equal(keys.includes("notAKnownSetting"), true);
    assert.equal(
      runtime.options.recordedRunSettings.values.browserSelectorHealingBackend,
      undefined,
      "and must not be applied",
    );
  } finally {
    second?.subscription.dispose();
    await second?.manager.dispose();
  }
});

const summaryOf = (harness, conversationId) =>
  harness.manager.getState().conversations.find((item) => item.id === conversationId);

const persistedSummaryOf = (harness, conversationId) =>
  harness.workspaceState
    .get("bachata.conversationManager.v1")
    .conversations.find((item) => item.id === conversationId);

test("a runtime snapshot that clears its selection drops the summary keys instead of holding undefined", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const runtime = harness.runtimeInstances[0];
    const conversationId = harness.manager.getState().activeConversationId;

    runtime.state.selectedPipelineId = "cross-reference-development";
    runtime.state.selectedPipelineHash = "hash-1";
    runtime.state.pipelineScopeRoot = "/workspace";
    runtime.state.workingDirectory = "/workspace";
    await runtime.emit({ type: "state.snapshot", state: runtime.state });
    const selected = summaryOf(harness, conversationId);
    ["selectedPipelineId", "selectedPipelineHash", "pipelineScopeRoot", "workingDirectory"].forEach((key) => {
      assert.equal(Object.hasOwn(selected, key), true, `${key} was never recorded`);
    });

    delete runtime.state.selectedPipelineId;
    delete runtime.state.selectedPipelineHash;
    delete runtime.state.pipelineScopeRoot;
    delete runtime.state.workingDirectory;
    await runtime.emit({ type: "state.snapshot", state: runtime.state });

    const cleared = summaryOf(harness, conversationId);
    ["selectedPipelineId", "selectedPipelineHash", "pipelineScopeRoot", "workingDirectory"].forEach((key) => {
      assert.equal(
        Object.hasOwn(cleared, key),
        false,
        `${key} stayed on the summary as an own property holding undefined`,
      );
    });

    await waitFor(() => {
      const record = persistedSummaryOf(harness, conversationId);
      return record !== undefined && !Object.hasOwn(record, "selectedPipelineId");
    });
    const persisted = persistedSummaryOf(harness, conversationId);
    ["selectedPipelineId", "selectedPipelineHash", "pipelineScopeRoot", "workingDirectory"].forEach((key) => {
      assert.equal(Object.hasOwn(persisted, key), false, `${key} was persisted as an own property`);
    });
    // A later merge over the persisted record must be able to reinstate a value; an own key
    // holding undefined would instead win over the base in the opposite direction.
    assert.equal({ ...persisted, workingDirectory: "/restored" }.workingDirectory, "/restored");
    assert.equal(Object.hasOwn(structuredClone(persisted), "workingDirectory"), false);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a consumed prepared draft is removed from the summary and its persisted record", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({
      title: "Absent draft",
      preparedDraft: "Review src/a.ts",
    });
    assert.equal(Object.hasOwn(summaryOf(harness, conversation.id), "preparedDraft"), true);

    await harness.manager.handleMessage({
      type: "conversation.consumePreparedDraft",
      conversationId: conversation.id,
    });

    assert.equal(
      Object.hasOwn(summaryOf(harness, conversation.id), "preparedDraft"),
      false,
      "preparedDraft stayed on the summary as an own property holding undefined",
    );
    await waitFor(() => persistedSummaryOf(harness, conversation.id) !== undefined);
    assert.equal(
      Object.hasOwn(persistedSummaryOf(harness, conversation.id), "preparedDraft"),
      false,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("an emptied draft message removes preparedDraft rather than storing an undefined key", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversation = await harness.manager.createConversation({ title: "Draft edits" });
    await harness.manager.handleMessage({
      type: "conversation.saveDraft",
      conversationId: conversation.id,
      text: "Draft in progress",
    });
    assert.equal(summaryOf(harness, conversation.id).preparedDraft, "Draft in progress");

    await harness.manager.handleMessage({
      type: "conversation.saveDraft",
      conversationId: conversation.id,
      text: "   ",
    });
    assert.equal(Object.hasOwn(summaryOf(harness, conversation.id), "preparedDraft"), false);
    await waitFor(() => persistedSummaryOf(harness, conversation.id) !== undefined);
    assert.equal(
      Object.hasOwn(persistedSummaryOf(harness, conversation.id), "preparedDraft"),
      false,
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

const eventTypesOf = (harness, conversationId) =>
  (harness.manager.getState().eventsByConversation[conversationId] ?? []).map((event) => event.type);

test("creating a room is not running one, so a pristine room has no Run Result", async () => {
  // THE FAILURE THIS PINS. Proof of execution was `events.length > 0`, and creating a room appends
  // `run.created`. A room a user had only opened therefore projected a full Run Result about a
  // run that never happened: no changed files, no verification, an evidence warning and an apply
  // blocker, all describing nothing.
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const first = harness.manager.getState().activeConversationId;
    await harness.manager.handleMessage({ type: "conversation.create" });
    const state = harness.manager.getState();
    const created = state.activeConversationId;
    assert.notEqual(created, first);
    // The created room holds exactly the event that used to be mistaken for execution.
    assert.deepEqual(eventTypesOf(harness, created), ["run.created"]);
    assert.equal(state.conversations.length, 2);
    assert.equal(Object.hasOwn(state.resultsByConversation, created), false);
    // Neither room has run, so nothing at all is projected.
    assert.deepEqual(Object.keys(state.resultsByConversation), []);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a second room opened beside a completed run carries no result of its own", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const first = harness.manager.getState().activeConversationId;
    await harness.manager.runConversation(first, "first execution");
    await harness.manager.handleMessage({ type: "conversation.create" });
    const state = harness.manager.getState();
    const second = state.activeConversationId;
    assert.notEqual(second, first);
    assert.deepEqual(eventTypesOf(harness, second), ["run.created"]);
    // The completed run keeps its result and the new room does not borrow it.
    assert.ok(state.resultsByConversation[first] !== undefined);
    assert.equal(Object.hasOwn(state.resultsByConversation, second), false);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("only an execution event is proof of execution", () => {
  // Membership is stated, not derived from "an event exists", so a type added later has to be
  // classified deliberately. `run.created` records that a room exists and
  // `resourceDependencies.observed` records what was declared before anything ran; neither is a
  // run.
  const { executionProvingEventTypes } = require("../dist/conversations/createConversationManager.js");
  assert.equal(executionProvingEventTypes.has("run.created"), false);
  assert.equal(executionProvingEventTypes.has("resourceDependencies.observed"), false);
  for (const type of [
    "run.started",
    "run.resumed",
    "run.completed",
    "run.interrupted",
    "run.failed",
    "run.resume.failed",
    "iteration.started",
    "iteration.resumed",
    "iteration.failed",
    "iteration.resume.failed",
    "step.started",
    "step.round.started",
    "output.validated",
    "output.invalid",
    "decision.published",
    "verification.completed",
    "interaction.opened",
    "interaction.resolved",
    "interaction.answeredByLead",
    "interaction.timeout",
  ]) {
    assert.ok(executionProvingEventTypes.has(type), `${type} is not counted as execution`);
  }
});

test("a run that has started is projected while it is still running", async () => {
  const harness = loadHarness();
  const held = deferred();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    harness.runtimeInstances[0].beforePipelineRun = () => held.promise;
    const running = harness.manager.runConversation(conversationId, "held execution");
    await waitFor(() => eventTypesOf(harness, conversationId).includes("run.started"));
    await waitFor(() => harness.manager.getState().resultsByConversation[conversationId] !== undefined);
    held.resolve();
    await running;
  } finally {
    held.resolve();
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a completed run and a failed run are both projected", async () => {
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    await harness.manager.runConversation(conversationId, "completed execution");
    assert.ok(harness.manager.getState().resultsByConversation[conversationId] !== undefined);
    assert.ok(eventTypesOf(harness, conversationId).includes("run.completed"));

    await harness.manager.handleMessage({ type: "conversation.create" });
    const failing = harness.manager.getState().activeConversationId;
    const instance = harness.runtimeInstances.at(-1);
    instance.beforePipelineRun = () => {
      throw new Error("Simulated pipeline failure");
    };
    await assert.rejects(() => harness.manager.runConversation(failing, "failing execution"));
    assert.ok(eventTypesOf(harness, failing).includes("run.failed"));
    assert.ok(harness.manager.getState().resultsByConversation[failing] !== undefined);
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a run bundle redacted by the repository policy still verifies against its own digest", async () => {
  // THE FAILURE THIS PINS. The digest was computed before the export policy rewrote the
  // serialized bundle, so every export from a repository that declares a literal shipped a
  // digest over bytes it did not contain: Inspect Run Bundle reported "mismatch" and told the
  // reader to treat every claim in it as unproven, and Replay Run refused the file outright.
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-run-export-digest-"));
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-export-digest-repo-"));
  mkdirSync(path.join(repositoryRoot, ".bachata"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, ".bachata", "export-policy.json"),
    JSON.stringify({
      version: 1,
      redactLiterals: ["acme-internal-customer"],
      excludePathPrefixes: [],
    }),
    "utf8",
  );
  const saveDialogPath = path.join(storageRoot, "run.bachata-run.json");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    providePipelineSnapshot: true,
    workingDirectory: repositoryRoot,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    harness.runtimeInstances[0].state.transcript.push({
      id: "answer-literal",
      kind: "answer",
      eventType: "agent.answer",
      agentId: "codex",
      text: "The regression reproduces for acme-internal-customer only",
      createdAt: new Date().toISOString(),
    });

    await harness.manager.handleMessage({ type: "conversation.exportBundle", conversationId });

    const exported = readFileSync(saveDialogPath, "utf8");
    assert.doesNotMatch(exported, /acme-internal-customer/u);
    assert.match(exported, /\[REDACTED\]/u);
    const { inspectRunBundle } = require("../dist/export/runBundleReport.js");
    const inspection = inspectRunBundle(exported);
    assert.equal(inspection.integrity.state, "verified");
    assert.equal(inspection.integrity.declared, inspection.integrity.computed);
    const confirmation = harness.exportConfirmations.at(-1);
    assert.match(confirmation.options.detail, /Repository literal redacted/u);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("a literal that redaction would break the bundle with is refused, not written", async () => {
  // A declared literal spans JSON escaping and structure once redaction runs over serialized
  // bytes. Bachata reads the redacted bundle back and refuses rather than writing a file no
  // reader can parse.
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-run-export-broken-"));
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-export-broken-repo-"));
  mkdirSync(path.join(repositoryRoot, ".bachata"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, ".bachata", "export-policy.json"),
    JSON.stringify({ version: 1, redactLiterals: ['": '], excludePathPrefixes: [] }),
    "utf8",
  );
  const saveDialogPath = path.join(storageRoot, "run.bachata-run.json");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    providePipelineSnapshot: true,
    workingDirectory: repositoryRoot,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;

    await assert.rejects(
      harness.manager.handleMessage({ type: "conversation.exportBundle", conversationId }),
      /could not read back/u,
    );
    assert.deepEqual(harness.savedFiles, []);
    assert.deepEqual(harness.exportPreviews, []);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("redaction that removes the bundle's own integrity record is refused", async () => {
  const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-run-export-unsealed-"));
  const repositoryRoot = mkdtempSync(path.join(os.tmpdir(), "bachata-export-unsealed-repo-"));
  mkdirSync(path.join(repositoryRoot, ".bachata"), { recursive: true });
  writeFileSync(
    path.join(repositoryRoot, ".bachata", "export-policy.json"),
    JSON.stringify({ version: 1, redactLiterals: ["integrity"], excludePathPrefixes: [] }),
    "utf8",
  );
  const saveDialogPath = path.join(storageRoot, "run.bachata-run.json");
  const harness = loadHarness(undefined, {
    storageRoot,
    removeStorageOnDispose: true,
    saveDialogPath,
    providePipelineSnapshot: true,
    workingDirectory: repositoryRoot,
  });
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;

    await assert.rejects(
      harness.manager.handleMessage({ type: "conversation.exportBundle", conversationId }),
      /could not read back/u,
    );
    assert.deepEqual(harness.savedFiles, []);
  } finally {
    harness.subscription.dispose();
    await harness.manager.dispose();
    rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test("an execution longer than one event page keeps the findings of its earliest outputs", async () => {
  // THE FAILURE THIS PINS. The result was projected from the newest 500 catalog events, so the
  // `output.validated` events of a long execution fell out of the window, their outputs were
  // filtered out of the projection, and the findings they carried were dropped from the result
  // that is persisted for the run. One execution runs up to 50 iterations, each appending
  // iteration, step, output and decision events, so the window is reached well inside one run.
  const harness = loadHarness();
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    const runtime = harness.runtimeInstances[0];
    runtime.beforePipelineRun = async () => {
      runtime.options.onPipelineOutput({
        stepId: "review",
        agentId: "codex",
        name: "findings",
        hash: "hash-earliest",
        validationErrors: [],
        value: {
          findings: [{
            id: "earliest-finding",
            subject: "Boundary",
            message: "The earliest validated output recorded a finding",
            evidence: [],
            challenges: [],
          }],
        },
      });
      // The rest of the execution, appended the way a long run appends it: after this the
      // validated output above is no longer among the newest 500 events of the run.
      const runRef = harness.manager.getState().conversations
        .find((conversation) => conversation.id === conversationId).runRef;
      const database = new DatabaseSync(path.join(harness.storageRoot, "bachata-state.sqlite"));
      try {
        const insert = database.prepare(
          "INSERT INTO events(run_ref, type, status, title, payload_json, created_at) VALUES(?, 'step.started', 'running', 'Later step', 'null', ?)",
        );
        database.exec("BEGIN");
        for (let index = 0; index < 520; index += 1) {
          insert.run(runRef, new Date().toISOString());
        }
        database.exec("COMMIT");
      } finally {
        database.close();
      }
    };

    await harness.manager.runConversation(conversationId, "long execution");

    const state = harness.manager.getState();
    // The execution really is longer than the window the projection used to read.
    assert.equal(state.eventsByConversation[conversationId].length, 500);
    assert.ok(
      state.resultsByConversation[conversationId].findings
        .some((finding) => finding.id === "earliest-finding"),
      "the earliest validated output's finding was dropped from the projected result",
    );
  } finally {
    harness.runtimeInstances.forEach((instance) => instance.beforeRun.resolve());
    harness.runtimeInstances.forEach((instance) => instance.run.resolve());
    harness.subscription.dispose();
    await harness.manager.dispose();
  }
});

test("a conversation releases its execution lease while a second message waits for local providers", async () => {
  // THE FAILURE THIS PINS. The top-up acquire ran inside the per-conversation lease mutation
  // queue, so the release of the finished run queued behind it. The broker only admits the
  // top-up after this conversation releases what it holds, so the conversation waited on itself
  // and held the repository slot until the execution-slot timeout fired.
  const released = [];
  const leaseFor = (resources) => {
    const key = resources[0].key;
    const controller = new AbortController();
    return {
      id: key,
      resources,
      fences: {},
      signal: controller.signal,
      isValid: () => true,
      assertValid: () => undefined,
      release: async () => {
        released.push(key);
      },
      quarantine: async () => {
        released.push(`${key}:quarantined`);
      },
    };
  };
  const topUpGate = deferred();
  let topUpRequests = 0;
  const harness = loadHarness(undefined, {
    configurationValues: { maxConcurrentLocalAgents: 8, executionSlotTimeoutMs: 60_000 },
    resourceBroker: {
      acquire: async (request) => {
        if (
          request.resources.length === 1 &&
          request.resources[0].key === "local-agents:global"
        ) {
          topUpRequests += 1;
          await topUpGate.promise;
        }
        return leaseFor(request.resources);
      },
    },
  });
  const runGate = deferred();
  let availabilityOutcome;
  let running;
  try {
    await harness.manager.handleMessage({ type: "manager.ready" });
    const conversationId = harness.manager.getState().activeConversationId;
    const runtime = harness.runtimeInstances[0];
    runtime.beforePipelineRun = () => runGate.promise;
    running = harness.manager.runConversation(conversationId, "held execution");
    await waitFor(() => runtime.pipelineCalls.length === 1);

    availabilityOutcome = harness.manager.handleMessage({
      type: "conversation.runtime",
      conversationId,
      message: { type: "availability.check" },
    }).then(() => undefined, (error) => error);
    await waitFor(() => topUpRequests === 1);

    runGate.resolve();
    // The finished run hands its repository slot back even though the top-up is still waiting.
    await waitFor(() => released.includes("bachata-runs:global"));
    await running;

    topUpGate.resolve();
    const outcome = await availabilityOutcome;
    assert.match(outcome.message, /released its execution lease/u);
    // The reservation the broker eventually granted is not leaked.
    assert.ok(released.includes("local-agents:global"));
  } finally {
    runGate.resolve();
    topUpGate.resolve();
    await availabilityOutcome;
    await running?.catch(() => undefined);
    harness.subscription.dispose();
    await harness.manager.dispose().catch(() => undefined);
  }
});
