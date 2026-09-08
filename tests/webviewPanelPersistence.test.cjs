const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

const uri = (fsPath) => ({ fsPath, toString: () => `file://${fsPath}` });

const panelHarness = () => {
  let messageHandler;
  let disposeHandler;
  const posted = [];
  const webview = {
    html: "",
    options: {},
    postMessage: async (message) => {
      posted.push(message);
      return true;
    },
    onDidReceiveMessage: (handler) => {
      messageHandler = handler;
      return { dispose: () => undefined };
    },
  };
  const panel = {
    webview,
    reveal: () => undefined,
    dispose: () => disposeHandler?.(),
    onDidDispose: (handler) => {
      disposeHandler = handler;
      return { dispose: () => undefined };
    },
  };
  return {
    panel,
    posted,
    receive: async (message) => messageHandler?.(message),
  };
};

const loadPanelModule = () => {
  const serializers = [];
  const createdPanels = [];
  const vscode = {
    ViewColumn: { One: 1 },
    Uri: {
      joinPath: (base, ...segments) => uri(path.posix.join(base.fsPath, ...segments)),
    },
    window: {
      createWebviewPanel: () => {
        const harness = panelHarness();
        createdPanels.push(harness);
        return harness.panel;
      },
      registerWebviewPanelSerializer: (viewType, serializer) => {
        serializers.push({ viewType, serializer });
        return { dispose: () => undefined };
      },
    },
  };
  const htmlPath = require.resolve("../dist/webview/html.js");
  const htmlModule = new Module(htmlPath);
  htmlModule.filename = htmlPath;
  htmlModule.loaded = true;
  htmlModule.exports = { getWebviewHtml: () => "<html>restored Bachata</html>" };
  require.cache[htmlPath] = htmlModule;

  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  const modulePath = require.resolve("../dist/webview/openPipelinePanel.js");
  delete require.cache[modulePath];
  try {
    return { panelModule: require(modulePath), serializers, createdPanels };
  } finally {
    Module._load = originalLoad;
  }
};

test("open Bachata panel is serialized and rebound after an Extension Host restart", async () => {
  const { panelModule, serializers, createdPanels } = loadPanelModule();
  const attached = [];
  const manager = {
    attachWebview: (webview) => {
      attached.push(webview);
      return { dispose: () => undefined };
    },
    handleMessage: async () => undefined,
  };
  const context = {
    extensionUri: uri("/extension"),
    storageUri: uri("/workspace-state"),
    globalStorageUri: uri("/global-state"),
  };

  panelModule.registerPipelinePanelSerializer(context, manager);
  assert.equal(serializers.length, 1);
  assert.equal(serializers[0].viewType, "bachata");

  const restored = panelHarness();
  await serializers[0].serializer.deserializeWebviewPanel(restored.panel, { drafts: {} });

  assert.equal(createdPanels.length, 0, "revival must reuse VS Code's restored editor tab");
  assert.equal(attached.length, 1);
  assert.equal(attached[0], restored.panel.webview);
  assert.equal(restored.panel.webview.html, "<html>restored Bachata</html>");
  assert.equal(restored.panel.webview.options.enableScripts, true);
  assert.equal(restored.panel.webview.options.retainContextWhenHidden, true);
  assert.deepEqual(
    restored.panel.webview.options.localResourceRoots.map((entry) => entry.fsPath),
    ["/extension/dist", "/workspace-state", "/global-state"],
  );

  await restored.receive({ type: "manager.ready" });
  await panelModule.waitForPipelinePanelReady();

  restored.panel.dispose();
  assert.rejects(panelModule.waitForPipelinePanelReady(), /not open/u);

  panelModule.openPipelinePanel(context, manager);
  assert.equal(createdPanels.length, 1, "an explicit close stays closed until the user opens Bachata again");
});

test("activation registers restoration for writable and read-only managers", () => {
  const source = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
  assert.match(source, /registerPipelinePanelSerializer\(context, manager\)/u);
  assert.match(source, /registerPipelinePanelSerializer\(context, readOnlyManager\)/u);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(manifest.activationEvents.includes("onWebviewPanel:bachata"));
});

// EX-A5-R17. The editor holds a request open until an `operation.result` carrying its id comes
// back. When the handler throws before the runtime ever posts one — a fork the manager refuses
// before dispatch — this panel is the last place that can answer it, and it answered only the
// operations it happened to list. `pipeline.fork` was not among them, so the editor's request
// stayed pending for the life of the panel and the person saw an uncorrelated error banner
// instead. The operations are a value the protocol already owns; every dispatch failure path
// reads that one classifier rather than its own copy.
test("a dispatch failure answers the request for every runtime operation", async () => {
  const { panelModule, createdPanels } = loadPanelModule();
  const manager = {
    attachWebview: () => ({ dispose: () => undefined }),
    handleMessage: async () => {
      throw new Error("Pipelines cannot be changed while a run is in flight");
    },
  };
  const context = {
    extensionUri: uri("/extension"),
    storageUri: uri("/workspace-state"),
    globalStorageUri: uri("/global-state"),
  };
  panelModule.openPipelinePanel(context, manager);
  const opened = createdPanels.at(-1);
  assert.notEqual(opened, undefined, "no panel was created");

  const { RUNTIME_OPERATIONS } = require("../dist/webview/protocol.js");
  assert.ok(RUNTIME_OPERATIONS.includes("pipeline.fork"), "pipeline.fork is not a runtime operation");

  for (const operation of RUNTIME_OPERATIONS) {
    const requestId = `request-${operation}`;
    await opened.receive({
      type: "conversation.runtime",
      conversationId: "conversation-1",
      message: { type: operation, requestId, pipelineId: "pipeline-1" },
    });
  }
  await new Promise((resolve) => setImmediate(resolve));

  const answered = opened.posted
    .filter((message) => message?.type === "conversation.message")
    .map((message) => message.message)
    .filter((message) => message?.type === "operation.result");
  assert.deepEqual(
    answered.map((message) => message.operation).sort(),
    [...RUNTIME_OPERATIONS].sort(),
    `a dispatch failure left a request pending: ${JSON.stringify(answered.map((message) => message.operation))}`,
  );
  for (const message of answered) {
    assert.equal(message.status, "failed", JSON.stringify(message));
    assert.equal(message.requestId, `request-${message.operation}`, JSON.stringify(message));
    assert.match(String(message.message), /run is in flight/u);
  }
  opened.panel.dispose();
});
