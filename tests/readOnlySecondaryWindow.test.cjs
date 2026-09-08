const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createStateCatalog } = require("../dist/state/catalog.js");
const { createLongitudinalService } = require("../dist/longitudinal/service.js");
const { createResourceBroker, resourceKey } = require("../dist/concurrency/resourceBroker.js");
const { canonicalWorkspaceStateIdentity } = require("../dist/state/workspaceIdentity.js");

const root = path.join(__dirname, "..");

const uriOf = (fsPath) => ({
  fsPath,
  path: fsPath,
  scheme: "file",
  toString: () => `file://${fsPath}`,
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate, description, timeoutMs = 8_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await wait(25);
  }
};

const storageBytes = (directory) => {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push([full, fs.statSync(full).size, fs.readFileSync(full).toString("base64")]);
    }
  };
  walk(directory);
  return JSON.stringify(files.sort());
};

const terminalResult = () => ({
  status: "completed",
  changedFiles: ["src/cancel.ts"],
  checks: [{ command: "npm test", status: "passed" }],
  finalRuling: "Cancellation now releases the worktree",
  providers: [{ name: "Lead", adapter: "claude-code" }],
  findings: [],
  unresolvedRisks: [],
  recoveredErrors: [],
});

// The state a writer leaves behind: runs with a recorded result, a Direction, and one
// orchestration run still holding a Git worktree.
const persistWriterState = (storageRoot, repositoryRoot) => {
  const catalog = createStateCatalog(storageRoot);
  let counter = 0;
  const longitudinal = createLongitudinalService({
    store: catalog.longitudinal,
    repositoryRoot,
    createId: (prefix) => `${prefix}${String(++counter).padStart(8, "0")}`,
  });
  longitudinal.defineInitiative({
    title: "Stabilize cancellation",
    goal: "No cancelled run leaks a worktree",
  });
  longitudinal.startCycle({ type: "review" });
  longitudinal.setDirection("Bound every retry path");
  const reviewed = catalog.createRun({
    title: "Review cancellation paths",
    input: "Review the cancellation code",
    legacyConversationId: "conversation-reviewed",
    iterationCount: 2,
    workingRoot: repositoryRoot,
    terminalResult: terminalResult(),
    status: "completed",
  });
  const draft = catalog.createRun({
    title: "Draft follow-up",
    legacyConversationId: "conversation-draft",
    iterationCount: 1,
    status: "draft",
  });
  catalog.setActiveRunRef(reviewed.runRef);
  catalog.appendEvent({
    runRef: reviewed.runRef,
    type: "decision.published",
    title: "Ship the cancellation fix",
    payload: { candidate: "ship" },
  });
  catalog.close();
  return { reviewed, draft };
};

const writeRetainedLedger = (storageRoot, repositoryRoot, runId) => {
  const directory = path.join(storageRoot, "orchestration", "runs", runId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, "ledger.json"),
    `${JSON.stringify({
      version: 1,
      runId,
      title: "[R23456789] Retained integration",
      status: "completed",
      workspaceRoot: repositoryRoot,
      sourceKind: "todoFile",
      todoPath: path.join(repositoryRoot, "TODO.md"),
      todoSourceHash: "b".repeat(64),
      integrationBranch: `bachata/integration/${runId}`,
      integrationWorktree: path.join(directory, "integration"),
      baselineCommit: "a".repeat(40),
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      maxConcurrency: 2,
      masterChecks: [],
      tasks: {
        "BACHATA-001": {
          spec: {
            id: "BACHATA-001",
            title: "Release the worktree on cancel",
            description: "",
            completed: true,
            explicitId: true,
            checksDeclared: true,
            line: 1,
            dependsOn: [],
            pipelineId: "todo-implementation",
            paths: ["src"],
            checks: ["npm test"],
            priority: 0,
            retries: 1,
          },
          status: "done",
          attempts: 1,
        },
      },
      finalChecks: [],
    }, null, 2)}\n`,
    "utf8",
  );
};

const createVscodeStub = (context) => {
  const commands = new Map();
  const errors = [];
  const warnings = [];
  const informationMessages = [];
  const outputLines = [];
  const treeProviders = new Map();
  const quickPicks = [];
  const openedDocuments = [];
  const panels = [];
  let quickPickChoice;

  class Disposable {
    constructor(callOnDispose) {
      this.callOnDispose = callOnDispose;
    }
    dispose() {
      this.callOnDispose?.();
    }
  }

  const vscode = {
    Disposable,
    ViewColumn: { One: 1 },
    ExtensionMode: { Development: 2, Production: 1, Test: 3 },
    StatusBarAlignment: { Left: 1 },
    EventEmitter: class {
      constructor() {
        this.listeners = new Set();
        this.event = (listener) => {
          this.listeners.add(listener);
          return { dispose: () => this.listeners.delete(listener) };
        };
      }
      fire(value) {
        this.listeners.forEach((listener) => listener(value));
      }
      dispose() {
        this.listeners.clear();
      }
    },
    TreeItem: class {
      constructor(label) {
        this.label = label;
      }
    },
    ThemeIcon: class {
      constructor(id) {
        this.id = id;
      }
    },
    Uri: {
      file: (value) => uriOf(value),
      joinPath: (base, ...segments) => uriOf(path.join(base.fsPath, ...segments)),
      parse: (value) => uriOf(value),
    },
    window: {
      createOutputChannel: () => ({
        appendLine: (line) => outputLines.push(line),
        show: () => undefined,
        dispose: () => undefined,
      }),
      showErrorMessage: async (message) => {
        errors.push(message);
        return undefined;
      },
      showWarningMessage: async (message) => {
        warnings.push(message);
        return undefined;
      },
      showInformationMessage: async (message) => {
        informationMessages.push(message);
        return undefined;
      },
      showQuickPick: async (items) => {
        quickPicks.push(items);
        const choice = quickPickChoice;
        quickPickChoice = undefined;
        return typeof choice === "function" ? choice(items) : undefined;
      },
      showOpenDialog: async () => undefined,
      showTextDocument: async () => undefined,
      registerTreeDataProvider: (id, provider) => {
        treeProviders.set(id, provider);
        return { dispose: () => treeProviders.delete(id) };
      },
      registerWebviewPanelSerializer: () => ({ dispose: () => undefined }),
      createWebviewPanel: () => {
        const posted = [];
        const panel = {
          posted,
          html: "",
          messageHandler: undefined,
          webview: {
            html: "",
            cspSource: "vscode-resource:",
            asWebviewUri: (uri) => uri,
            postMessage: async (message) => {
              posted.push(message);
              return true;
            },
            onDidReceiveMessage: (handler) => {
              panel.messageHandler = handler;
              return { dispose: () => undefined };
            },
          },
          reveal: () => undefined,
          onDidDispose: () => ({ dispose: () => undefined }),
          dispose: () => undefined,
        };
        panels.push(panel);
        return panel;
      },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: context.workspaceFolders,
      getWorkspaceFolder: () => context.workspaceFolders?.[0],
      getConfiguration: () => ({ get: (key, fallback) => fallback }),
      openTextDocument: async (options) => {
        openedDocuments.push(options);
        return options;
      },
      fs: {
        readFile: async (uri) => fs.readFileSync(uri.fsPath),
        delete: async () => undefined,
      },
    },
    languages: {
      createDiagnosticCollection: () => ({
        set: () => undefined,
        clear: () => undefined,
        dispose: () => undefined,
      }),
      getDiagnostics: () => [],
    },
    commands: {
      registerCommand: (id, handler) => {
        commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
      },
      executeCommand: async (id, ...args) => {
        const handler = commands.get(id);
        return handler ? handler(...args) : undefined;
      },
    },
    env: { openExternal: async () => true },
  };
  return {
    vscode,
    commands,
    errors,
    warnings,
    informationMessages,
    outputLines,
    treeProviders,
    quickPicks,
    openedDocuments,
    panels,
    pickWith: (chooser) => {
      quickPickChoice = chooser;
    },
  };
};

const injectModule = (filename, exports) => {
  const module = new Module(filename);
  module.filename = filename;
  module.loaded = true;
  module.exports = exports;
  require.cache[filename] = module;
};

// A read-only window must construct none of these. Injected as modules that throw, so the
// test fails on construction rather than on a claim in a comment.
const forbidWritableServices = () => {
  const manager = require.resolve("../dist/conversations/createConversationManager.js");
  const orchestrator = require.resolve("../dist/orchestrator/controller.js");
  const actual = require(manager);
  injectModule(manager, {
    ...actual,
    createConversationManager: () => {
      throw new Error("A read-only window constructed a writable conversation manager");
    },
  });
  const actualOrchestrator = require(orchestrator);
  injectModule(orchestrator, {
    ...actualOrchestrator,
    createTodoOrchestrator: () => {
      throw new Error("A read-only window constructed a TODO orchestrator");
    },
  });
};

const activateSecondaryWindow = async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-secondary-"));
  const globalStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-secondary-global-"));
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-secondary-repo-"));
  const written = persistWriterState(storageRoot, repositoryRoot);
  writeRetainedLedger(storageRoot, repositoryRoot, "run-retained");

  // The window that owns the workspace, still holding the writer lease.
  const owner = createResourceBroker({
    databasePath: path.join(globalStorageRoot, "concurrency", "resources.sqlite"),
  });
  const ownerLease = await owner.acquire({
    resources: [{
      key: resourceKey("workspace-state-writer", canonicalWorkspaceStateIdentity(storageRoot)),
      kind: "abstract",
    }],
    deadlineAt: Date.now() + 5_000,
    label: "test workspace owner",
  });

  const workspaceFolders = [{ uri: uriOf(repositoryRoot), name: path.basename(repositoryRoot), index: 0 }];
  const harness = createVscodeStub({ workspaceFolders });
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") return harness.vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  let extension;
  try {
    forbidWritableServices();
    const extensionPath = require.resolve("../dist/extension.js");
    delete require.cache[extensionPath];
    extension = require(extensionPath);
  } finally {
    // The stub stays installed for the lifetime of the test: activation registers command
    // handlers that reach for vscode long after this call returns.
    Module._load = function load(request, parent, isMain) {
      if (request === "vscode") return harness.vscode;
      return originalLoad.call(this, request, parent, isMain);
    };
  }
  const subscriptions = [];
  const workspaceState = new Map();
  const context = {
    subscriptions,
    storageUri: uriOf(storageRoot),
    globalStorageUri: uriOf(globalStorageRoot),
    extensionUri: uriOf(root),
    extensionMode: harness.vscode.ExtensionMode.Test,
    extension: { id: "local.bachata-vscode" },
    workspaceState: {
      get: (key) => workspaceState.get(key),
      update: async (key, value) => {
        workspaceState.set(key, value);
      },
    },
  };
  await extension.activate(context);
  return {
    harness,
    extension,
    storageRoot,
    globalStorageRoot,
    repositoryRoot,
    written,
    context,
    cleanup: async () => {
      await extension.deactivate().catch(() => undefined);
      subscriptions.forEach((subscription) => {
        try {
          subscription.dispose();
        } catch {
          // Disposal failures are not what this test proves.
        }
      });
      await ownerLease.release().catch(() => undefined);
      await owner.dispose().catch(() => undefined);
      Module._load = originalLoad;
      [storageRoot, globalStorageRoot, repositoryRoot].forEach((directory) =>
        fs.rmSync(directory, { recursive: true, force: true }));
    },
  };
};

// Activation loads the extension with a stubbed vscode module, and module state — the panel
// singleton included — is per process. One activation is therefore shared by every test in
// this file, and the tests that write run last.
let shared;
const secondaryWindow = async () => {
  shared ??= await activateSecondaryWindow();
  return shared;
};

test.after(async () => {
  await shared?.cleanup();
});

let openedPanel;
const openPanel = async (secondary) => {
  if (openedPanel) return openedPanel;
  const open = secondary.harness.commands.get("bachata.open");
  assert.ok(open, "a read-only window registered no bachata.open command");
  await open();
  const panel = secondary.harness.panels[0];
  assert.ok(panel, "bachata.open opened no panel");
  assert.match(panel.webview.html, /<div id="root">/u, "the panel rendered no product HTML");
  await waitFor(() => typeof panel.messageHandler === "function", "the panel to listen for messages");
  await panel.messageHandler({ type: "manager.ready" });
  const snapshot = await waitFor(
    () => panel.posted.filter((message) => message.type === "manager.snapshot")
      .find((message) => message.state.conversations.length > 0),
    "a manager snapshot carrying the writer's runs",
  );
  openedPanel = { panel, snapshot };
  return openedPanel;
};

test("a read-only window opens the normal panel over the state the writer persisted", async () => {
  const secondary = await secondaryWindow();
  const { snapshot } = await openPanel(secondary);
  const state = snapshot.state;

  assert.deepEqual(
    state.conversations.map((conversation) => conversation.title).sort(),
    ["Draft follow-up", "Review cancellation paths"],
    "the panel does not show the runs the writer persisted",
  );
  assert.equal(
    state.activeConversationId,
    "conversation-reviewed",
    "the panel does not open on the run the writer left active",
  );
  assert.equal(
    state.direction.initiative.title,
    "Stabilize cancellation",
    "the panel shows no Direction",
  );
  assert.equal(state.direction.direction.goal, "No cancelled run leaks a worktree");
  assert.equal(state.direction.direction.acceptedDirection, "Bound every retry path");
  assert.ok(state.direction.cycles.length >= 1, "the panel shows no cycle history");

  const result = state.resultsByConversation["conversation-reviewed"];
  assert.ok(result, "the panel hardcodes an empty Result Center");
  assert.equal(result.status, "completed");
  assert.deepEqual(result.changedFiles, ["src/cancel.ts"]);
  assert.equal(result.checks[0].command, "npm test");

  assert.deepEqual(
    state.orchestration.retainedRuns.map((run) => run.runId),
    ["run-retained"],
    "the panel hardcodes an empty retained-run list",
  );
  assert.equal(state.orchestration.retainedRuns[0].integrationBranch, "bachata/integration/run-retained");

  const events = state.eventsByConversation["conversation-reviewed"] ?? [];
  assert.ok(
    events.some((event) => event.type === "decision.published"),
    "the panel shows none of the run's recorded history",
  );

  assert.equal(state.readOnly.owned, false);
  assert.match(state.readOnly.reason, /already controlled by another Bachata Extension Host/u);
  assert.equal(state.readOnly.retryCommand, "Bachata: Workspace Ownership");
});

test("every command a read-only window claims to offer is registered and reads", async () => {
  const secondary = await secondaryWindow();
  const { commands } = secondary.harness;

  ["bachata.open", "bachata.doctor", "bachata.explainPipeline", "bachata.inspectRunBundle", "bachata.localData", "bachata.ownership"]
    .forEach((command) => {
      assert.equal(typeof commands.get(command), "function", `${command} is not registered`);
    });

  await commands.get("bachata.doctor")();
  const doctorLines = secondary.harness.outputLines.filter((line) => /^(ok|BLOCK|optional) /u.test(line));
  assert.ok(doctorLines.length >= 4, "Doctor reported nothing in a read-only window");
  assert.ok(
    doctorLines.some((line) => /Workspace ownership/u.test(line)),
    "Doctor does not state why this window is read-only",
  );
  assert.ok(
    doctorLines.some((line) => /Run catalog: Readable: 2 runs/u.test(line)),
    `Doctor does not report the catalog it read: ${doctorLines.join(" | ")}`,
  );
  assert.ok(
    doctorLines.some((line) => /Retained work: 1 retained run/u.test(line)),
    "Doctor does not report retained work",
  );

  secondary.harness.pickWith((items) => items.find((item) => item.description === "plan"));
  await commands.get("bachata.explainPipeline")();
  const explained = secondary.harness.openedDocuments.at(-1);
  assert.ok(explained, "Explain Pipeline opened no document");
  assert.match(explained.content, /This window is read-only/u);
  assert.match(explained.content, /plan/u, "the explanation does not describe the chosen pipeline");

  secondary.harness.pickWith((items) => items[0]);
  await commands.get("bachata.localData")();
  assert.ok(
    secondary.harness.outputLines.some((line) => /bachata-state\.sqlite/u.test(line)),
    "Local Data reported nothing about the stored catalog",
  );
  const localDataItems = secondary.harness.quickPicks.at(-1);
  assert.ok(localDataItems.length > 0, "Local Data offered no entries");
  assert.equal(
    localDataItems.some((item) => item.cleanup === true),
    false,
    "a read-only window offered to delete stored data",
  );

  // Mutating commands are still registered, and each refuses at the boundary.
  await commands.get("bachata.setup")();
  assert.ok(
    secondary.harness.errors.some((message) => /refused createConversation/u.test(message)),
    "bachata.setup did not refuse in a read-only window",
  );
});

test("the panel refuses protocol mutations below the UI", async () => {
  const secondary = await secondaryWindow();
  const { panel } = await openPanel(secondary);

  await panel.messageHandler({ type: "orchestration.start" });
  const refusal = await waitFor(
    () => panel.posted.filter((message) => message.type === "manager.error").at(-1),
    "a refusal for orchestration.start",
  );
  assert.match(refusal.message, /refused orchestrationStart/u);
  assert.match(refusal.message, /this window is read-only/u);
  assert.match(refusal.message, /Workspace Ownership/u);

  await panel.messageHandler({
    type: "conversation.runtime",
    conversationId: "conversation-reviewed",
    message: { type: "pipeline.run" },
  });
  const runtimeRefusal = await waitFor(
    () => panel.posted.filter((message) => message.type === "manager.error")
      .find((message) => /refused providerExecution/u.test(message.message)),
    "a refusal for a runtime message",
  );
  assert.ok(runtimeRefusal);

  // Selecting a run is reading, so it still answers with a snapshot rather than a refusal.
  const before = panel.posted.filter((message) => message.type === "manager.snapshot").length;
  await panel.messageHandler({ type: "conversation.select", conversationId: "conversation-draft" });
  const selected = await waitFor(
    () => panel.posted.filter((message) => message.type === "manager.snapshot").length > before
      ? panel.posted.filter((message) => message.type === "manager.snapshot").at(-1)
      : undefined,
    "a snapshot after selecting a run",
  );
  assert.equal(selected.state.activeConversationId, "conversation-draft");
});

test("opening and reading the product in a read-only window changes no stored byte", async () => {
  const secondary = await secondaryWindow();
  const { panel } = await openPanel(secondary);
  const before = storageBytes(secondary.storageRoot);
  await panel.messageHandler({ type: "manager.ready" });
  await panel.messageHandler({ type: "conversation.select", conversationId: "conversation-draft" });
  await secondary.harness.commands.get("bachata.doctor")();
  await panel.messageHandler({ type: "orchestration.start" });
  await wait(200);

  assert.equal(
    storageBytes(secondary.storageRoot),
    before,
    "viewing the product in a read-only window wrote to the writer's storage",
  );
});

test("the panel follows the writer's later changes without being reopened", async () => {
  const secondary = await secondaryWindow();
  const { panel } = await openPanel(secondary);

  const catalog = createStateCatalog(secondary.storageRoot);
  let counter = 100;
  const longitudinal = createLongitudinalService({
    store: catalog.longitudinal,
    repositoryRoot: secondary.repositoryRoot,
    createId: (prefix) => `${prefix}${String(++counter).padStart(8, "0")}`,
  });
  catalog.createRun({
    title: "Run created after the secondary opened",
    legacyConversationId: "conversation-later",
    iterationCount: 1,
    status: "draft",
  });
  longitudinal.setDirection("Release the worktree on every path");
  catalog.close();

  const refreshed = await waitFor(
    () => panel.posted.filter((message) => message.type === "manager.snapshot")
      .find((message) => message.state.conversations.some(
        (conversation) => conversation.id === "conversation-later",
      )),
    "a snapshot carrying the writer's later run",
  );
  assert.equal(
    refreshed.state.direction.direction.acceptedDirection,
    "Release the worktree on every path",
    "the panel did not follow the writer's later Direction",
  );
});

test("a read-only window opens the catalog without the ability to write it", async () => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-readonly-catalog-"));
  try {
    const catalog = createStateCatalog(storageRoot);
    catalog.createRun({ title: "Persisted run", iterationCount: 1, status: "draft" });
    catalog.close();

    const { openReadOnlyStateCatalog } = require("../dist/state/readOnlyCatalog.js");
    const reader = openReadOnlyStateCatalog(storageRoot);
    assert.equal(reader.present, true);
    assert.equal(reader.listRuns(true).length, 1);
    [
      "saveInitiative",
      "deleteInitiative",
      "saveCycle",
      "saveDecisions",
      "commitRound",
      "setActiveInitiative",
      "importInitiative",
    ].forEach((method) => {
      assert.equal(
        reader.longitudinal[method],
        undefined,
        `a read-only window exposes the mutating store method ${method}`,
      );
    });
    assert.equal(typeof reader.longitudinal.listInitiatives, "function");
    reader.close();

    // A catalog the writer has never created must not be created by opening it for reading.
    const absentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-readonly-absent-"));
    try {
      const absent = openReadOnlyStateCatalog(absentRoot);
      assert.equal(absent.present, false);
      assert.deepEqual(absent.listRuns(true), []);
      assert.equal(absent.longitudinalSummary().initiative, undefined);
      absent.close();
      assert.deepEqual(fs.readdirSync(absentRoot), [], "opening a reader created catalog files");
    } finally {
      fs.rmSync(absentRoot, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(storageRoot, { recursive: true, force: true });
  }
});
