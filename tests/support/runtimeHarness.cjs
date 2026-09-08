const Module = require("node:module");
const path = require("node:path");

const { removeScratchSync, scratchRootSync } = require("./scratch.cjs");

// The extension host, faked once.
//
// `installHostDoubles` is everything a test cannot have for real: the `vscode` module, the
// provider adapters, the browser bridge, the attachment store, the transcript store, and a
// scratch storage root. `loadRuntimeHarness` builds the real runtime on it, and
// `loadManagerHarness` builds the real conversation manager on it — which is the whole point:
// a suite that drives the orchestrator through a real manager, a real runtime and the real
// pipeline runner must not be handed a second definition of what "the host" is.

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

/**
 * Forget every compiled module, so the next load captures the doubles this call installs.
 *
 * A module that already ran holds the `vscode` double it was loaded with. Re-requiring only the
 * entry point leaves its dependencies holding the previous test's workspace folders — which is a
 * directory that test has since removed. A suite that builds more than one host in one process
 * therefore starts from a clean module graph, the way a fresh process would.
 */
const purgeCompiledModules = (root) => {
  const prefix = path.join(root, "dist") + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(prefix)) delete require.cache[key];
  }
};

const installHostDoubles = (options = {}) => {
  const root = path.resolve(__dirname, "..", "..");
  const outputLines = [];
  if (options.purgeCompiledModules === true) purgeCompiledModules(root);
  const ownsStorageDirectory = !options.storageDirectory;
  const storageDirectory = options.storageDirectory ?? scratchRootSync("bachata-runtime-storage-");
  const ownsWorkspaceDirectories = !options.workspaceDirectories && !options.noWorkspace;
  const workspaceDirectories = options.noWorkspace
    ? []
    : options.workspaceDirectories ?? [scratchRootSync("bachata-runtime-workspace-")];
  const workspaceDirectory = workspaceDirectories[0];
  const transcript = [...(options.initialTranscript ?? [])];
  let transcriptQueue = Promise.resolve();
  const adapterControls = new Map();
  const adapterControlHistory = [];
  const adapterContexts = new Map();
  const configuration = new Map(Object.entries(options.configuration ?? {}));

  const checkCommandPath = require.resolve("../../dist/process/checkCommand.js");
  injectModule(checkCommandPath, {
    checkCommand: async (command, args, commandOptions) => {
      if (options.onCommandCheck) return options.onCommandCheck({ command, args, commandOptions });
      return `${command} mock-1.0.0`;
    },
  });

  const createControl = (agentId) => {
    const started = deferred();
    const release = deferred();
    const control = {
      agentId,
      sendCount: 0,
      interruptCount: 0,
      resetCount: 0,
      disposeCount: 0,
      started,
      release,
    };
    adapterControls.set(agentId, control);
    adapterControlHistory.push(control);
    return control;
  };

  const registryPath = require.resolve("../../dist/adapters/registry.js");
  injectModule(registryPath, {
    createAdapterRegistry: () => ({
      types: () => ["codex-app-server", "claude-code", "chatgpt-browser", "claude-browser"],
      validatePipeline: () => [],
      create: (definition, context) => {
        options.onAdapterCreate?.({ definition, context });
        adapterContexts.set(definition.id, context);
        const control = createControl(definition.id);
        return {
          id: definition.id,
          adapterType: definition.adapter,
          capabilities: {
            streaming: true,
            resume: true,
            interrupt: true,
            attachments: true,
            repositoryTools: true,
            browserSessionSelection: definition.adapter.endsWith("-browser"),
            passiveActionLoop: definition.adapter.endsWith("-browser"),
            ...(options.adapterCapabilities?.[definition.id] ?? {}),
          },
          checkAvailability: async () =>
            (await options.onCheckAvailability?.({
              agentId: definition.id,
              adapterType: definition.adapter,
              context,
            })) ?? "mock-1.0.0",
          send: async function* (request, signal) {
            control.sendCount += 1;
            control.started.resolve();
            const scripted = await (
              options.onAdapterSend?.({
                agentId: definition.id,
                context,
                signal,
                request,
                sendCount: control.sendCount,
              }) ?? Promise.resolve()
            );
            await Promise.race([
              control.release.promise,
              new Promise((resolve) => {
                if (signal.aborted) {
                  resolve();
                  return;
                }
                signal.addEventListener("abort", resolve, { once: true });
              }),
            ]);
            for (const event of scripted?.events ?? []) {
              yield structuredClone(event);
            }
            if (scripted?.capturedResponse) {
              yield { type: "captured", response: structuredClone(scripted.capturedResponse) };
            }
            yield {
              type: "complete",
              answer: signal.aborted ? "" : scripted?.answer ?? "completed",
              status: signal.aborted ? "interrupted" : scripted?.status ?? "completed",
            };
          },
          interrupt: async () => {
            control.interruptCount += 1;
          },
          resetSession: async () => {
            control.resetCount += 1;
            await options.onAdapterReset?.({
              agentId: definition.id,
              adapterType: definition.adapter,
              context,
              control,
            });
          },
          dispose: async () => {
            control.disposeCount += 1;
            await options.onAdapterDispose?.({
              agentId: definition.id,
              adapterType: definition.adapter,
              context,
              control,
            });
          },
        };
      },
    }),
  });

  const bridgePath = require.resolve("../../dist/browser/bridgeServer.js");
  injectModule(bridgePath, {
    createBrowserBridgeServer: ({ enabled, onStatusChange }) => {
      const status = {
        enabled,
        connected: false,
        sessions: [],
      };
      return {
        start: async () => {
          await (options.bridgeStart?.() ?? Promise.resolve());
          onStatusChange(status);
        },
        getStatus: () => status,
        subscribeStatus: (listener) => {
          listener(status);
          return { dispose: () => undefined };
        },
        resetPairing: async () => undefined,
        discover: () => undefined,
        bindSession: () => {
          throw new Error("Browser bridge session binding is not used by this test");
        },
        bindConversation: () => undefined,
        releaseBinding: () => undefined,
        resolveBoundSession: () => undefined,
        sendConversation: () => {
          throw new Error("Browser bridge conversation transport is not used by this test");
        },
        fetchAsset: (assetId, maxBytes, signal) => {
          if (!options.fetchAsset) {
            throw new Error("Browser asset transfer is not used by this test");
          }
          return options.fetchAsset(assetId, maxBytes, signal);
        },
        revealAsset: async (assetId) => {
          if (!options.revealAsset) {
            throw new Error("Browser asset reveal is not used by this test");
          }
          await options.revealAsset(assetId);
        },
        interrupt: async () => undefined,
        close: async () => undefined,
      };
    },
  });

  const attachmentPath = require.resolve(
    "../../dist/attachments/attachmentStore.js",
  );
  injectModule(attachmentPath, {
    createAttachmentStore: () => ({
      save: options.saveAttachment ?? (async () => {
        throw new Error("Attachment saving is not used by this test");
      }),
      resolvePaths: options.resolvePaths ?? (async () => ({ paths: [], dispose: async () => undefined })),
      remove: options.removeAttachment ?? (async () => undefined),
      clear: options.clearAttachments ?? (async () => undefined),
      backup: options.backupAttachments ?? (async (attachments) =>
        attachments.map((metadata) => ({
          metadata: structuredClone(metadata),
          data: Buffer.alloc(metadata.size),
        }))),
      restore: options.restoreAttachments ?? (async () => undefined),
    }),
  });

  const transcriptPath = require.resolve("../../dist/state/transcriptStore.js");
  injectModule(transcriptPath, {
    createTranscriptStore: () => ({
      load: async () => [...transcript],
      loadRecent: async (limit) => ({
        entries: transcript.slice(-limit),
        total: transcript.length,
        hasMore: transcript.length > limit,
      }),
      loadBefore: async () => ({ entries: [], total: transcript.length, hasMore: false }),
      append: (entry) => {
        const operation = transcriptQueue.then(async () => {
          await (options.beforeTranscriptAppend?.(entry) ?? Promise.resolve());
          transcript.push(entry);
        });
        transcriptQueue = operation.catch(() => undefined);
        return operation;
      },
      replace: (entries) => {
        const operation = transcriptQueue.then(() => {
          transcript.splice(0, transcript.length, ...entries);
        });
        transcriptQueue = operation.catch(() => undefined);
        return operation;
      },
      clear: () => {
        const operation = transcriptQueue.then(() => {
          transcript.splice(0);
        });
        transcriptQueue = operation.catch(() => undefined);
        return operation;
      },
      flush: () => transcriptQueue,
      filePath: path.join(storageDirectory, "transcript.jsonl"),
    }),
  });

  class Disposable {
    constructor(dispose) {
      this.dispose = dispose;
    }
  }

  let activeWorkspaceDirectories = [...workspaceDirectories];
  const workspaceFolderListeners = new Set();

  const vscode = {
    Disposable,
    Uri: {
      file: (fsPath) => ({ fsPath }),
      joinPath: (base, ...segments) => ({
        fsPath: path.join(base.fsPath, ...segments),
      }),
    },
    env: { remoteName: undefined },
    workspace: {
      isTrusted: true,
      get workspaceFolders() {
        return activeWorkspaceDirectories.map((directory) => ({
          uri: { fsPath: directory },
        }));
      },
      getConfiguration: () => ({
        get: (key, defaultValue) =>
          configuration.has(key) ? configuration.get(key) : defaultValue,
      }),
      onDidChangeWorkspaceFolders: (listener) => {
        workspaceFolderListeners.add(listener);
        return new Disposable(() => workspaceFolderListeners.delete(listener));
      },
      onDidChangeConfiguration: () => new Disposable(() => undefined),
      onDidGrantWorkspaceTrust: () => new Disposable(() => undefined),
    },
    window: {
      showWarningMessage: async (...args) =>
        options.showWarningMessage?.(...args),
      showInformationMessage: async () => undefined,
      showOpenDialog: async (dialogOptions) =>
        options.showOpenDialog?.({ dialogOptions, workspaceDirectory }),
      showSaveDialog: async (dialogOptions) =>
        options.showSaveDialog?.({ dialogOptions, workspaceDirectory }),
    },
  };

  /**
   * Load a compiled module with `vscode` resolved to the double.
   *
   * The patch is in place only while the module and everything it pulls in are loaded, so a
   * module cached from an earlier load is evicted first: a module that captured the real
   * `require("vscode")` — which does not exist outside the host — would throw on import.
   */
  const requireWithVscode = (modulePath) => {
    const resolved = require.resolve(modulePath);
    delete require.cache[resolved];
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
      if (request === "vscode") {
        return vscode;
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      return require(resolved);
    } finally {
      Module._load = originalLoad;
    }
  };

  const workspaceState = new Map(Object.entries(options.initialWorkspaceState ?? {}));
  const context = {
    workspaceState: {
      get: (key) => workspaceState.get(key),
      update: async (key, value) => {
        await options.beforeWorkspaceStateUpdate?.({ key, value, workspaceState });
        if (value === undefined) {
          workspaceState.delete(key);
        } else {
          workspaceState.set(key, value);
        }
        await options.afterWorkspaceStateUpdate?.({ key, value, workspaceState });
      },
    },
    storageUri: { fsPath: storageDirectory },
    globalStorageUri: { fsPath: storageDirectory },
    extensionUri: { fsPath: options.extensionRoot ?? root },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
  };

  return {
    root,
    vscode,
    context,
    requireWithVscode,
    // What the runtime said on its output channel. A no-op swallowed the only place some
    // decisions are stated — a quarantined preset, for one — so a test could not tell a file that
    // was reported and skipped from a file that vanished.
    output: { appendLine: (line) => { outputLines.push(String(line)); } },
    outputLines,
    adapterControls,
    adapterControlHistory,
    adapterContexts,
    configuration,
    transcript,
    workspaceState,
    workspaceDirectory,
    workspaceDirectories,
    storageDirectory,
    setWorkspaceDirectories: (directories) => {
      activeWorkspaceDirectories = [...directories];
      [...workspaceFolderListeners].forEach((listener) => listener({
        added: [],
        removed: [],
      }));
    },
    cleanup: () => {
      if (ownsStorageDirectory) {
        removeScratchSync(storageDirectory);
      }
      if (ownsWorkspaceDirectories) {
        workspaceDirectories.forEach((directory) => {
          removeScratchSync(directory);
        });
      }
    },
  };
};

const loadRuntimeHarness = (options = {}) => {
  const host = installHostDoubles(options);
  const { createRuntime } = host.requireWithVscode("../../dist/runtime/createRuntime.js");
  const runtime = createRuntime(host.context, host.output, options.runtimeOptions);

  const acknowledgeCurrentContract = async () => {
    const current = runtime.getState().contractAcknowledgement;
    if (current?.acknowledgementRequired === true) {
      await runtime.handleMessage({
        type: "contract.acknowledge",
        fingerprint: current.fingerprint,
      });
    }
  };

  const guardedRuntime = {
    ...runtime,
    handleMessage: async (message) => {
      if (message?.type === "pipeline.run" && options.enforceContractAcknowledgement !== true) {
        await acknowledgeCurrentContract();
      }
      return runtime.handleMessage(message);
    },
  };

  return { ...host, runtime: guardedRuntime, acknowledgeCurrentContract };
};

/**
 * The real conversation manager on the same host doubles.
 *
 * `createConversationManager` builds a real `createRuntime` per conversation, and that runtime
 * runs the real `executePipeline`. So a harness that returns this manager gives the orchestrator
 * the whole chain — manager, runtime, pipeline runner — with nothing standing in for any of it
 * except the host surface and the provider transports.
 */
const loadManagerHarness = (options = {}) => {
  const host = installHostDoubles({ purgeCompiledModules: true, ...options });
  const { createConversationManager } = host.requireWithVscode(
    "../../dist/conversations/createConversationManager.js",
  );
  const manager = createConversationManager(host.context, host.output, options.managerOptions ?? {});
  return { ...host, manager };
};

module.exports = {
  deferred,
  injectModule,
  installHostDoubles,
  purgeCompiledModules,
  loadManagerHarness,
  loadRuntimeHarness,
};
