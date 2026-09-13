const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createL10nStub } = require("./fixtures/vscodeL10n.cjs");

const { CONTRACT_PROBE_CANDIDATES } = require("../dist/providers/localModelDiscovery.js");

const root = path.join(__dirname, "..");

const uriOf = (fsPath) => ({
  fsPath,
  path: fsPath,
  scheme: "file",
  toString: () => `file://${fsPath}`,
});

const waitFor = async (predicate, description, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// The exact answer a compatible model gives to the five-candidate probe. Every id classified once,
// in the category the contract requires.
const CONTRACT_PASS = JSON.stringify({
  execute: ["probe-read", "probe-list"],
  reject: ["probe-decoy", "probe-source"],
  ambiguous: ["probe-unclear"],
});

const injectModule = (filename, exports) => {
  const module = new Module(filename);
  module.filename = filename;
  module.loaded = true;
  module.exports = exports;
  require.cache[filename] = module;
};

/**
 * The host's own local-model service, captured as activation builds it.
 *
 * Only the handle is taken. The parser, the prompt, the discovery pass, the transport and the
 * verdict are all the product's own — substituting any of them is what let a production-only
 * defect hide behind a test double.
 */
const captureLocalModelService = () => {
  const modulePath = require.resolve("../dist/providers/localModelService.js");
  const actual = require(modulePath);
  const captured = {};
  injectModule(modulePath, {
    ...actual,
    createLocalModelService: (input) => {
      captured.service = actual.createLocalModelService(input);
      return captured.service;
    },
  });
  return captured;
};

/**
 * A namespace with the calls this activation exercises, and a disposable no-op for the editor
 * registrations it makes that this test says nothing about — language providers, decorations and
 * the like. Anything the assertions below depend on is spelled out explicitly above the fallback.
 */
const withRegistrationFallback = (namespace) =>
  new Proxy(namespace, {
    get: (target, property) => {
      if (property in target) return target[property];
      // Only a registration is stood in for. Anything else — an active editor, a state value — is
      // absent, because inventing a truthy value for it is how a stub starts answering questions
      // the editor would have answered differently.
      return typeof property === "string" && /^(?:register|create|on[A-Z])/u.test(property)
        ? () => ({ dispose: () => undefined })
        : undefined;
    },
  });

const createVscodeStub = (settings, workspaceFolders) => {
  const outputLines = [];
  const configurationListeners = new Set();
  const vscode = {
    l10n: createL10nStub(),
    Disposable: class {
      constructor(callOnDispose) {
        this.callOnDispose = callOnDispose;
      }
      dispose() {
        this.callOnDispose?.();
      }
    },
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
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showQuickPick: async () => undefined,
      showOpenDialog: async () => undefined,
      showTextDocument: async () => undefined,
      registerTreeDataProvider: () => ({ dispose: () => undefined }),
      createTreeView: () => ({
        onDidChangeVisibility: () => ({ dispose: () => undefined }),
        onDidChangeSelection: () => ({ dispose: () => undefined }),
        reveal: async () => undefined,
        dispose: () => undefined,
      }),
      registerWebviewPanelSerializer: () => ({ dispose: () => undefined }),
      createWebviewPanel: () => ({
        webview: {
          html: "",
          cspSource: "vscode-resource:",
          asWebviewUri: (uri) => uri,
          postMessage: async () => true,
          onDidReceiveMessage: () => ({ dispose: () => undefined }),
        },
        reveal: () => undefined,
        onDidDispose: () => ({ dispose: () => undefined }),
        dispose: () => undefined,
      }),
      createStatusBarItem: () => ({
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined,
      }),
    },
    workspace: {
      isTrusted: true,
      workspaceFolders,
      getWorkspaceFolder: () => workspaceFolders[0],
      getConfiguration: () => ({
        get: (key, fallback) => (key in settings ? settings[key] : fallback),
      }),
      onDidChangeConfiguration: (listener) => {
        configurationListeners.add(listener);
        return { dispose: () => configurationListeners.delete(listener) };
      },
      textDocuments: [],
      onDidOpenTextDocument: () => ({ dispose: () => undefined }),
      onDidChangeTextDocument: () => ({ dispose: () => undefined }),
      onDidSaveTextDocument: () => ({ dispose: () => undefined }),
      onDidCloseTextDocument: () => ({ dispose: () => undefined }),
      onDidChangeWorkspaceFolders: () => ({ dispose: () => undefined }),
      createFileSystemWatcher: () => ({
        onDidCreate: () => ({ dispose: () => undefined }),
        onDidChange: () => ({ dispose: () => undefined }),
        onDidDelete: () => ({ dispose: () => undefined }),
        dispose: () => undefined,
      }),
      openTextDocument: async (options) => options,
      fs: {
        readFile: async (uri) => fs.readFileSync(uri.fsPath),
        delete: async () => undefined,
      },
    },
    languages: withRegistrationFallback({
      createDiagnosticCollection: () => ({
        set: () => undefined,
        delete: () => undefined,
        clear: () => undefined,
        dispose: () => undefined,
      }),
      getDiagnostics: () => [],
    }),
    CompletionItem: class {
      constructor(label) {
        this.label = label;
      }
    },
    CompletionItemKind: { Text: 0, Snippet: 14 },
    CodeActionKind: { QuickFix: "quickfix" },
    CodeAction: class {
      constructor(title, kind) {
        this.title = title;
        this.kind = kind;
      }
    },
    Diagnostic: class {
      constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity;
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Range: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    Position: class {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    MarkdownString: class {
      constructor(value) {
        this.value = value;
      }
      appendMarkdown(value) {
        this.value = `${this.value ?? ""}${value}`;
        return this;
      }
    },
    WorkspaceEdit: class {
      replace() {}
      insert() {}
    },
    commands: {
      registerCommand: () => ({ dispose: () => undefined }),
      executeCommand: async () => undefined,
    },
    env: { openExternal: async () => true, remoteName: undefined },
    extensions: { getExtension: () => undefined },
  };
  vscode.window = withRegistrationFallback(vscode.window);
  vscode.workspace = withRegistrationFallback(vscode.workspace);
  vscode.commands = withRegistrationFallback(vscode.commands);
  return {
    vscode,
    outputLines,
    changeConfiguration: (changedKeys) => {
      const event = { affectsConfiguration: (key) => changedKeys.includes(key) };
      configurationListeners.forEach((listener) => listener(event));
    },
  };
};

/**
 * The reader's local inference server, stubbed at the transport. Discovery and the contract check
 * both go through the product's own request paths to reach it.
 */
const createLocalServerStub = () => {
  const requests = [];
  let answer = CONTRACT_PASS;
  const respond = (body) => ({
    ok: true,
    status: 200,
    redirected: false,
    type: "default",
    json: async () => body,
  });
  return {
    requests,
    prompts: () => requests.filter((entry) => entry.url.endsWith("/api/chat")),
    answerWith: (value) => {
      answer = value;
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/api/tags")) {
        return respond({ models: [{ name: "stub-interpreter", details: { family: "stub" } }] });
      }
      if (String(url).endsWith("/api/ps")) {
        return respond({ models: [{ name: "stub-interpreter" }] });
      }
      if (String(url).endsWith("/api/chat")) {
        return respond({ model: "stub-interpreter", message: { content: answer } });
      }
      throw new Error(`unexpected request to ${String(url)}`);
    },
  };
};

const activateWriterWindow = async (settings) => {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-wiring-"));
  const globalStorageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-wiring-global-"));
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-wiring-repo-"));
  const workspaceFolders = [
    { uri: uriOf(repositoryRoot), name: path.basename(repositoryRoot), index: 0 },
  ];
  const harness = createVscodeStub(settings, workspaceFolders);
  const server = createLocalServerStub();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = server.fetch;
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") return harness.vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  const captured = captureLocalModelService();
  const extensionPath = require.resolve("../dist/extension.js");
  delete require.cache[extensionPath];
  const extension = require(extensionPath);
  const subscriptions = [];
  const workspaceState = new Map();
  const globalState = new Map();
  const context = {
    subscriptions,
    storageUri: uriOf(storageRoot),
    globalStorageUri: uriOf(globalStorageRoot),
    extensionUri: uriOf(root),
    extensionMode: harness.vscode.ExtensionMode.Test,
    extension: { id: "local.bachata-vscode" },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
      onDidChange: () => ({ dispose: () => undefined }),
    },
    workspaceState: {
      get: (key) => workspaceState.get(key),
      update: async (key, value) => {
        workspaceState.set(key, value);
      },
    },
    globalState: {
      get: (key, fallback) => (globalState.has(key) ? globalState.get(key) : fallback),
      update: async (key, value) => {
        globalState.set(key, value);
      },
      setKeysForSync: () => undefined,
    },
  };
  await extension.activate(context);
  return {
    harness,
    server,
    context,
    service: () => captured.service,
    cleanup: async () => {
      await extension.deactivate().catch(() => undefined);
      subscriptions.forEach((subscription) => {
        try {
          subscription.dispose();
        } catch {
          // Disposal failures are not what this test proves.
        }
      });
      Module._load = originalLoad;
      globalThis.fetch = originalFetch;
      delete require.cache[require.resolve("../dist/providers/localModelService.js")];
      [storageRoot, globalStorageRoot, repositoryRoot].forEach((directory) =>
        fs.rmSync(directory, { recursive: true, force: true }));
    },
  };
};

const semanticOnlySettings = {
  browserSemanticInterpreterEnabled: true,
  browserSemanticInterpreterBackend: "ollama",
  browserSemanticInterpreterEndpoint: "http://127.0.0.1:11434",
  browserSemanticInterpreterTimeoutMs: 9_000,
  browserSelectorHealingEnabled: false,
  browserBridgeEnabled: false,
};

// Module state — the panel singleton included — is per process, so one activation is shared.
let shared;
const window = async () => {
  shared ??= await activateWriterWindow({ ...semanticOnlySettings });
  return shared;
};

test.after(async () => {
  await shared?.cleanup();
});

test("activation reaches ready through the production parser on the real five-candidate answer", async () => {
  const active = await window();
  const service = await waitFor(() => active.service(), "the host's local model service");
  await waitFor(
    () => service.readiness("semanticInterpreter").selection.status === "ready",
    "the interpreter to pass the contract check",
  );
  assert.deepEqual(service.resolvedConfig("semanticInterpreter"), {
    backend: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "stub-interpreter",
  });

  const prompts = active.server.prompts();
  assert.equal(prompts.length, 1, "the bounded contract check ran exactly once");
  const sent = JSON.parse(JSON.parse(prompts[0].init.body).messages[1].content);
  assert.deepEqual(
    sent.candidates.map((candidate) => candidate.id),
    [...CONTRACT_PROBE_CANDIDATES],
    "the production prompt carries all five candidates",
  );

  // Every one of those five ids was accepted by the parser production actually uses: the answer
  // above classifies all five, and nothing in it was discarded as unknown.
  const answered = JSON.parse(CONTRACT_PASS);
  assert.deepEqual(
    [...answered.execute, ...answered.reject, ...answered.ambiguous].sort(),
    [...CONTRACT_PROBE_CANDIDATES].sort(),
  );
  assert.equal(
    active.harness.outputLines.some((line) =>
      line.includes("Local interpreter check: stub-interpreter") && line.includes("passed")),
    true,
    "the host recorded a passing verdict",
  );
});

test("a changed network-affecting setting invalidates the verdict and asks again", async () => {
  const active = await window();
  const service = active.service();
  const before = active.server.prompts().length;
  active.harness.changeConfiguration(["bachata.browserSemanticInterpreterTimeoutMs"]);
  await waitFor(
    () => active.server.prompts().length > before,
    "the check to run again under the new configuration",
  );
  await waitFor(
    () => service.readiness("semanticInterpreter").selection.status === "ready",
    "the interpreter to pass again",
  );
});

test("malformed, truncated and unsafe answers are refused, not read as agreement", async () => {
  const active = await window();
  const service = active.service();
  const refusals = [
    ["malformed", "I will not answer in JSON."],
    ["truncated", '{"execute": ["probe-read", "probe-list"], "reject": ["probe-decoy"'],
    [
      "unsafe",
      JSON.stringify({
        execute: ["probe-read", "probe-list", "probe-source"],
        reject: ["probe-decoy"],
        ambiguous: ["probe-unclear"],
      }),
    ],
    [
      "invented",
      JSON.stringify({
        execute: ["probe-read", "probe-list", "rm -rf /"],
        reject: ["probe-decoy", "probe-source"],
        ambiguous: ["probe-unclear"],
      }),
    ],
  ];
  for (const [name, answer] of refusals) {
    active.server.answerWith(answer);
    const before = active.server.prompts().length;
    service.invalidate();
    await service.discover();
    await service.verifySelection();
    await waitFor(() => active.server.prompts().length > before, `the ${name} answer to be asked for`);
    assert.notEqual(
      service.readiness("semanticInterpreter").selection.status,
      "ready",
      `the ${name} answer was accepted`,
    );
    assert.equal(service.resolvedConfig("semanticInterpreter"), undefined, name);
  }
  active.server.answerWith(CONTRACT_PASS);
});
