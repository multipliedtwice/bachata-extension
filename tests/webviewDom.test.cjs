const assert = require("node:assert/strict");
const test = require("node:test");

const camel = (value) => value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.id = "";
    this.dataset = {};
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.className = "";
    this.textContent = "";
    this.tabIndex = 0;
    this.open = false;
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.parentElement = null;
    this.attributes = new Map();
  }

  focus() {
    document.activeElement = this;
  }

  click() {
    if (this.disabled) return;
    this.focus();
    document.root.dispatch("click", {
      target: this,
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
    });
  }

  closest(selector) {
    if (selector === "[data-action]") {
      return this.dataset.action ? this : null;
    }
    return null;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "id") this.id = String(value);
    if (name === "class") this.className = String(value);
    if (name.startsWith("data-")) this.dataset[camel(name.slice(5))] = String(value);
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    if (name.startsWith("data-")) delete this.dataset[camel(name.slice(5))];
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  scrollIntoView() {}
}

class FakeHTMLElement extends FakeElement {}
class FakeHTMLButtonElement extends FakeHTMLElement {}
class FakeHTMLInputElement extends FakeHTMLElement {
  constructor(tagName = "input") {
    super(tagName);
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.selectionDirection = "none";
    this.files = null;
  }

  setSelectionRange(start, end, direction = "none") {
    this.selectionStart = start;
    this.selectionEnd = end;
    this.selectionDirection = direction;
  }

  select() {
    this.selectionStart = 0;
    this.selectionEnd = this.value.length;
  }
}
class FakeHTMLTextAreaElement extends FakeHTMLInputElement {}
class FakeHTMLSelectElement extends FakeHTMLElement {}
class FakeHTMLDetailsElement extends FakeHTMLElement {}

const elementForTag = (tagName) => {
  if (tagName === "button") return new FakeHTMLButtonElement(tagName);
  if (tagName === "input") return new FakeHTMLInputElement(tagName);
  if (tagName === "textarea") return new FakeHTMLTextAreaElement(tagName);
  if (tagName === "select") return new FakeHTMLSelectElement(tagName);
  if (tagName === "details") return new FakeHTMLDetailsElement(tagName);
  return new FakeHTMLElement(tagName);
};

const matchesSelector = (element, selector) => {
  const trimmed = selector.trim();
  if (trimmed.startsWith("#")) return element.id === trimmed.slice(1);
  // A class selector, so a test can count one KIND of alert rather than every element carrying
  // role="alert". "At least one alert exists" is not an assertion when the defect is that the
  // same alert is drawn twice.
  if (/^\.[A-Za-z0-9_-]+$/u.test(trimmed)) {
    return String(element.getAttribute("class") ?? "").split(/\s+/u).includes(trimmed.slice(1));
  }
  if (trimmed.includes(":checked") && !element.checked) return false;
  const attributes = Array.from(trimmed.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g));
  // A bare tag selector, which is how the read-only pass sweeps every control.
  if (attributes.length === 0 && /^[a-z]+$/u.test(trimmed)) {
    return element.tagName === trimmed.toUpperCase();
  }
  if (attributes.length === 0) return false;
  return attributes.every((match) => {
    const name = match[1];
    const expected = match[2];
    const actual = name.startsWith("data-")
      ? element.dataset[camel(name.slice(5))]
      : element.getAttribute(name);
    return expected === undefined ? actual !== undefined && actual !== null : actual === expected;
  });
};

class FakeRoot extends FakeHTMLElement {
  constructor() {
    super("div");
    this.id = "root";
    this.listeners = new Map();
    this.elements = [];
    this._innerHTML = "";
  }

  addEventListener(type, listener) {
    const values = this.listeners.get(type) ?? [];
    values.push(listener);
    this.listeners.set(type, values);
  }

  dispatch(type, event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  set innerHTML(value) {
    this._innerHTML = value;
    this.elements = [];
    document.elements = new Map([["root", this]]);
    const expression = /<(button|input|textarea|select|details|summary|section|article|footer|div|main|aside|p|h1|h2|h3)\b([^>]*)>/g;
    for (const match of value.matchAll(expression)) {
      const element = elementForTag(match[1]);
      const attributes = match[2];
      for (const attribute of attributes.matchAll(/([a-zA-Z_:][\w:.-]*)(?:="([^"]*)")?/g)) {
        const name = attribute[1];
        const attributeValue = attribute[2] ?? "";
        element.setAttribute(name, attributeValue);
        if (name === "disabled") element.disabled = true;
        if (name === "checked") element.checked = true;
        if (name === "open") element.open = true;
        if (name === "value") element.value = attributeValue;
      }
      this.elements.push(element);
      if (element.id) document.elements.set(element.id, element);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  querySelector(selector) {
    for (const option of selector.split(",")) {
      const found = this.elements.find((element) => matchesSelector(element, option));
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    return this.elements.filter((element) =>
      selector.split(",").some((option) => matchesSelector(element, option)));
  }
}

class FakeDocument {
  constructor() {
    this.activeElement = null;
    this.elements = new Map();
    this.documentElement = { scrollTop: 0 };
    this.root = new FakeRoot();
    this.liveStatus = new FakeHTMLElement("div");
    this.liveStatus.id = "bachata-live-status";
    this.elements.set("root", this.root);
    this.elements.set("bachata-live-status", this.liveStatus);
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }

  // The webview listens for keydown on the document, because a modal must still answer Escape
  // when a click on its own text has moved focus to the body. The fake document delivers those
  // events through the same listener map the root uses, so dispatching on either reaches them.
  addEventListener(type, listener, options) {
    this.root.addEventListener(type, listener, options);
  }

  dispatch(type, event) {
    this.root.dispatch(type, event);
  }

  querySelector(selector) {
    return this.root.querySelector(selector);
  }

  querySelectorAll(selector) {
    return this.root.querySelectorAll(selector);
  }
}

// The panel validates captured source origins with `new URL(...)`, so the stub has to stay a
// real URL constructor and only add the object-URL helpers the attachment preview calls.
const RealURL = globalThis.URL;

const installGlobals = () => {
  const names = [
    "document",
    "window",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "HTMLTextAreaElement",
    "HTMLSelectElement",
    "HTMLDetailsElement",
    "CSS",
    "Prism",
    "acquireVsCodeApi",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "setInterval",
    "bachataWebviewBehavior",
    "FileReader",
    "URL",
    "crypto",
    "navigator",
  ];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const messages = [];
  const webviewState = { value: undefined };
  const clipboard = { writes: [], refuse: false };
  const windowListeners = new Map();
  const documentValue = new FakeDocument();
  const windowValue = {
    innerWidth: 1200,
    innerHeight: 900,
    addEventListener: (type, listener) => {
      const values = windowListeners.get(type) ?? [];
      values.push(listener);
      windowListeners.set(type, values);
    },
    getSelection: () => null,
  };
  Object.defineProperties(globalThis, {
    document: { configurable: true, writable: true, value: documentValue },
    window: { configurable: true, writable: true, value: windowValue },
    Element: { configurable: true, writable: true, value: FakeElement },
    HTMLElement: { configurable: true, writable: true, value: FakeHTMLElement },
    HTMLButtonElement: { configurable: true, writable: true, value: FakeHTMLButtonElement },
    HTMLInputElement: { configurable: true, writable: true, value: FakeHTMLInputElement },
    HTMLTextAreaElement: { configurable: true, writable: true, value: FakeHTMLTextAreaElement },
    HTMLSelectElement: { configurable: true, writable: true, value: FakeHTMLSelectElement },
    HTMLDetailsElement: { configurable: true, writable: true, value: FakeHTMLDetailsElement },
    CSS: { configurable: true, writable: true, value: { escape: (value) => String(value) } },
    Prism: { configurable: true, writable: true, value: { languages: {}, highlight: (value) => value } },
    acquireVsCodeApi: {
      configurable: true,
      writable: true,
      value: () => ({
        postMessage: (message) => messages.push(structuredClone(message)),
        getState: () => webviewState.value,
        setState: (value) => {
          webviewState.value = structuredClone(value);
        },
      }),
    },
    requestAnimationFrame: { configurable: true, writable: true, value: (callback) => { callback(Date.now()); return 1; } },
    cancelAnimationFrame: { configurable: true, writable: true, value: () => undefined },
    setInterval: { configurable: true, writable: true, value: () => 1 },
    FileReader: {
      configurable: true,
      writable: true,
      value: class {
        readAsDataURL(file) {
          this.result = `data:${String(file.type ?? "")};base64,${Buffer.from(file.contents ?? "", "utf8").toString("base64")}`;
          queueMicrotask(() => this.onload?.());
        }
      },
    },
    URL: {
      configurable: true,
      writable: true,
      value: Object.assign(class BachataTestURL extends RealURL {}, {
        createObjectURL: () => "blob:preview",
        revokeObjectURL: () => undefined,
      }),
    },
    crypto: {
      configurable: true,
      writable: true,
      value: { randomUUID: () => `client-${String(Math.floor(Math.random() * 1e9))}` },
    },
    // Copying is a real effect with a real failure mode, so the tests get to see both: every write
    // is recorded, and `clipboard.refuse` makes the next one reject the way a denied permission does.
    navigator: {
      configurable: true,
      writable: true,
      value: {
        clipboard: {
          writeText: (value) => {
            clipboard.writes.push(value);
            return clipboard.refuse
              ? Promise.reject(new Error("Clipboard write refused"))
              : Promise.resolve();
          },
        },
      },
    },
  });
  return {
    document: documentValue,
    messages,
    webviewState,
    clipboard,
    sendWindowMessage: (data) => {
      for (const listener of windowListeners.get("message") ?? []) listener({ data });
    },
    sendWindowEvent: (type, event) => {
      for (const listener of windowListeners.get(type) ?? []) listener(event);
    },
    restore: () => {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
  };
};

test("compiled webview renders destructive dialogs, defaults to cancel, and restores trigger focus", () => {
  const harness = installGlobals();
  try {
    delete require.cache[require.resolve("../dist/webview-behavior.js")];
    delete require.cache[require.resolve("../dist/webview.js")];
    require("../dist/webview-behavior.js");
    require("../dist/webview.js");
    assert.deepEqual(harness.messages[0], { type: "manager.ready" });

    const timestamp = new Date().toISOString();
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: {
        conversations: [{
          id: "run-1",
          runRef: "run-1",
          title: "Test run",
          preparedDraft: "Review me safely",
          iterationCount: 1,
          activeIteration: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          running: false,
          workflowStatus: "idle",
          unread: 0,
          archived: false,
        }],
        activeConversationId: "run-1",
        defaultPipelineIterations: 1,
        maxPipelineIterations: 10,
        interactions: [],
        eventsByConversation: {},
        orchestration: { active: false, masterChecks: [], tasks: [], finalChecks: [], retainedRuns: [] },
      },
    });

    assert.match(harness.document.root.innerHTML, /Review me safely/);
    assert.equal(harness.messages.filter((message) =>
      message.type === "conversation.consumePreparedDraft"
    ).length, 0);
    const consumedCount = 0;
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: {
        conversations: [{
          id: "run-1",
          runRef: "run-1",
          title: "Test run",
          iterationCount: 1,
          activeIteration: 0,
          createdAt: timestamp,
          updatedAt: timestamp,
          running: false,
          workflowStatus: "idle",
          unread: 0,
          archived: false,
        }],
        activeConversationId: "run-1",
        defaultPipelineIterations: 1,
        maxPipelineIterations: 10,
        interactions: [],
        eventsByConversation: {},
        orchestration: { active: false, masterChecks: [], tasks: [], finalChecks: [], retainedRuns: [] },
      },
    });
    assert.equal(harness.messages.filter((message) =>
      message.type === "conversation.consumePreparedDraft"
    ).length, consumedCount);

    let reset = harness.document.root.querySelector('[data-action="task-reset"]');
    assert.ok(reset);
    reset.click();
    assert.match(harness.document.root.innerHTML, /Reset run state\?/);
    assert.equal(harness.document.activeElement.dataset.dialogDefault, "cancel");

    harness.document.root.querySelector('[data-dialog-default="cancel"]').click();
    reset = harness.document.root.querySelector('[data-action="task-reset"]');
    assert.equal(harness.document.activeElement, reset);

    reset.click();
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(harness.document.activeElement, harness.document.root.querySelector('[data-action="task-reset"]'));
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime",
      conversationId: "run-1",
      message: { type: "task.reset" },
    });
  } finally {
    harness.restore();
  }
});

const timestamp = "2026-08-05T00:00:00.000Z";
const customAHash = "a".repeat(64);
const customBHash = "b".repeat(64);

const pipelineDefinition = (id = "custom-a", name = "Custom A") => ({
  version: 1,
  id,
  name,
  description: `${name} description`,
  agents: [{ id: "lead", name: "Lead", adapter: "codex-app-server" }],
  roles: [],
  steps: [{
    id: "step-1",
    name: "Implement",
    enabled: true,
    humanGate: "none",
    type: "agent",
    participants: ["lead"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    attachments: "selected",
  }],
});

const conversationSummary = () => ({
  id: "run-1",
  runRef: "run-1",
  title: "Test run",
  iterationCount: 1,
  activeIteration: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  running: false,
  workflowStatus: "idle",
  unread: 0,
  archived: false,
  selectedPipelineId: "custom-a",
  selectedPipelineHash: customAHash,
  pipelineScopeRoot: "/workspace",
});

const managerState = (overrides = {}) => ({
  conversations: [conversationSummary()],
  activeConversationId: "run-1",
  defaultPipelineIterations: 1,
  maxPipelineIterations: 10,
  interactions: [],
  eventsByConversation: {},
  orchestration: { active: false, masterChecks: [], tasks: [], finalChecks: [], retainedRuns: [] },
  ...overrides,
});

const panelState = (overrides = {}) => ({
  taskId: "run-1",
  workspaceRoots: ["/workspace"],
  trusted: true,
  pipelines: [
    {
      id: "custom-a",
      name: "Custom A",
      editable: true,
      hash: customAHash,
      scopeKey: "workspace:/workspace",
      scopeRoot: "/workspace",
    },
    {
      id: "custom-b",
      name: "Custom B",
      editable: true,
      hash: customBHash,
      scopeKey: "workspace:/workspace",
      scopeRoot: "/workspace",
    },
  ],
  selectedPipelineId: "custom-a",
  selectedPipelineHash: customAHash,
  pipelineScopeKey: "workspace:/workspace",
  pipelineScopeRoot: "/workspace",
  selectedPipelineDefinition: pipelineDefinition(),
  adapterTypes: ["codex-app-server"],
  agents: {
    lead: { id: "lead", name: "Lead", adapterType: "codex-app-server", status: "idle", output: "" },
    worker: { id: "worker", name: "Worker", adapterType: "claude-code", status: "idle", output: "" },
  },
  roles: {},
  running: false,
  workflowStatus: "idle",
  transcript: [],
  transcriptTotal: 0,
  transcriptHasMore: false,
  transcriptWindowSize: 300,
  approvals: [],
  attachments: [],
  maxAttachmentBytes: 20_971_520,
  maxAttachmentCount: 20,
  maxAttachmentTotalBytes: 52_428_800,
  pipelineMutable: true,
  browserActionPolicies: { readOnly: "ask", mutation: "ask", destructive: "ask", shell: "disabled" },
  browserBridge: { enabled: true, connected: false, sessions: [] },
  queuedMessages: [],
  queuePaused: false,
  ...overrides,
});

const bootWebview = (manager = managerState(), panel = panelState()) => {
  const harness = installGlobals();
  delete require.cache[require.resolve("../dist/webview-behavior.js")];
  delete require.cache[require.resolve("../dist/webview.js")];
  require("../dist/webview-behavior.js");
  require("../dist/webview.js");
  harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
  harness.sendWindowMessage({
    type: "conversation.message",
    conversationId: "run-1",
    message: { type: "state.snapshot", state: panel },
  });
  return harness;
};

test("composer controls have accessible names", () => {
  const harness = bootWebview();
  try {
    assert.equal(harness.document.getElementById("composer-prompt").getAttribute("aria-label"), "Run input");
    assert.equal(
      harness.document.root.querySelector('[data-action="attachment-pick"]').getAttribute("aria-label"),
      "Attach image, text, log, or specification",
    );
    assert.equal(harness.document.getElementById("pipeline-select").getAttribute("aria-label"), "Pipeline");
  } finally {
    harness.restore();
  }
});

test("non-editor disclosures preserve user state across rerenders", () => {
  const browserPanel = panelState({
    adapterTypes: ["codex-app-server", "chatgpt-browser"],
    agents: {
      ...panelState().agents,
      browser: {
        id: "browser",
        name: "Browser",
        adapterType: "chatgpt-browser",
        status: "idle",
        output: "",
      },
    },
  });
  const harness = bootWebview(managerState({
    // The orchestration card is only rendered when orchestration has state, so this case declares
    // some: the disclosure whose persistence is under test has to exist to be toggled.
    orchestration: { active: true, runId: "R1", masterChecks: [], tasks: [], finalChecks: [], retainedRuns: [] },
  }), browserPanel);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    harness.document.root.querySelector('[data-action="inspector-toggle"]').click();
    const states = [
      ["run-1:orchestration", true],
      ["run-1:participant:lead", true],
      ["run-1:browser-bindings", false],
      ["run-1:inspector:pipeline", true],
    ];
    for (const [key, open] of states) {
      const details = harness.document.root.querySelector(`[data-disclosure-key="${key}"]`);
      assert.ok(details, `missing disclosure ${key}`);
      details.open = open;
      harness.document.root.dispatch("toggle", { target: details });
    }
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "state.snapshot", state: browserPanel },
    });
    for (const [key, open] of states) {
      const details = harness.document.root.querySelector(`[data-disclosure-key="${key}"]`);
      assert.ok(details, `missing rerendered disclosure ${key}`);
      assert.equal(details.open, open, `wrong persisted state for ${key}`);
    }
  } finally {
    harness.restore();
  }
});

test("run menu state survives a snapshot before its native toggle event", () => {
  const harness = bootWebview();
  try {
    for (const open of [true, false]) {
      const menu = harness.document.root.querySelector(".run-action-menu");
      assert.ok(menu, "the run tab has no action menu");
      menu.open = open;
      harness.sendWindowMessage({
        type: "conversation.message",
        conversationId: "run-1",
        message: { type: "state.snapshot", state: panelState() },
      });
      assert.equal(harness.document.root.querySelector(".run-action-menu").open, open);
    }
  } finally {
    harness.restore();
  }
});

test("pipeline editor preserves omitted attachment defaults and uses one checklist summarizer", () => {
  const checklist = pipelineDefinition();
  checklist.steps = [{
    id: "checklist",
    name: "Summarize",
    enabled: true,
    humanGate: "none",
    type: "checklist",
    participants: ["lead"],
    promptTemplate: "{{userPrompt}}",
    outputName: "issues",
  }];
  const harness = bootWebview(
    managerState(),
    panelState({ selectedPipelineDefinition: checklist, advancedMode: true }),
  );
  try {
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    const participant = harness.document.root.querySelector('[data-editor-step="0"][data-field="participants"]');
    assert.ok(participant);
    assert.equal(participant.hasAttribute("multiple"), false);
    const attachment = harness.document.root.querySelector('[data-editor-step="0"][data-field="attachments"]');
    assert.ok(attachment);
    assert.match(
      harness.document.root.innerHTML,
      /data-field="attachments"><option value="none" selected>No attachments<\/option><option value="selected" >Attachments picked in the composer<\/option>/u,
    );
  } finally {
    harness.restore();
  }
});

test("a disabled Send states every blocking condition with a direct fix", () => {
  const harness = bootWebview(
    managerState(),
    panelState({
      workspaceRoots: ["/workspace", "/other"],
      workingDirectory: undefined,
      readiness: {
        status: "needsSetup",
        findings: [
          { id: "workspace", label: "Workspace", status: "ready", detail: "/workspace" },
          {
            id: "adapter.codex",
            label: "Codex",
            status: "needsSetup",
            detail: "codex unavailable: spawn codex ENOENT",
            remediationId: "provider.install.codex",
          },
        ],
      },
    }),
  );
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /Send is disabled/u);
    assert.match(html, /No working root is selected in this multi-root window\./u);
    assert.match(html, /codex unavailable: spawn codex ENOENT/u);
    assert.match(html, /Resolve this before the run can start\./u);
    // EX-UI-02. The empty input is what the field's own placeholder says, and the intro card says
    // it a second time. A third copy at the top of the blocker list was the first thing a reader
    // met in an empty room. It still refuses Send, and the refusal still travels on the control.
    assert.doesNotMatch(html, /The run input is empty\./u);
    const send = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(send.getAttribute("aria-disabled"), "true");
    assert.equal(send.getAttribute("aria-describedby"), "composer-blockers");

    harness.document.root.querySelector('[data-action="readiness-remediate"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "readiness.remediate",
      remediationId: "provider.install.codex",
      detail: "codex unavailable: spawn codex ENOENT",
    });
  } finally {
    harness.restore();
  }
});

test("advanced pipeline settings stay hidden until advanced mode is on", () => {
  const harness = bootWebview(managerState(), panelState());
  try {
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    assert.equal(
      harness.document.root.querySelector('[data-editor-step="0"][data-field="attachments"]'),
      null,
      "advanced fields must not render with advanced mode off",
    );
    const unlock = harness.document.root.querySelector('[data-action="advanced-mode-open"]');
    assert.ok(unlock, "no way to turn advanced mode on");
    assert.match(harness.document.root.innerHTML, /Advanced settings are hidden/u);
    unlock.click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "settings.open",
      setting: "bachata.advancedMode",
    });
  } finally {
    harness.restore();
  }
});

test("checklist execution selects a scoped immutable task pipeline", () => {
  const checklist = pipelineDefinition();
  checklist.steps = [{
    id: "execute",
    name: "Execute",
    enabled: true,
    humanGate: "none",
    type: "executeChecklist",
    inputName: "issues",
    pipelineId: "custom-b",
    allowedPaths: ["."],
    checks: ["npm test"],
  }];
  const harness = bootWebview(managerState(), panelState({ selectedPipelineDefinition: checklist }));
  try {
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    const selector = harness.document.root.querySelector('[data-editor-step="0"][data-field="pipelineId"]');
    assert.ok(selector);
    assert.equal(selector.tagName, "SELECT");
    const options = harness.document.root.innerHTML.match(
      /<select data-editor-step="0" data-field="pipelineId">([\s\S]*?)<\/select>/u,
    )?.[1];
    assert.match(options, /Custom B · custom-b · workspace workspace/u);
    assert.match(options, /title="Revision bbbbbbbb"/u, "the pipeline revision is no longer in reach");
    assert.doesNotMatch(options, /Custom A · custom-a/u);
  } finally {
    harness.restore();
  }
});

test("new pipeline cannot delete the selected custom pipeline", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="pipeline-new"]').click();
    assert.match(harness.document.root.innerHTML, /Pipeline editor/);
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-delete"]'), null);

    harness.document.root.querySelector('[data-action="pipeline-editor-close"]').click();
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    const pipelineId = harness.document.root.querySelector('[data-editor-meta="id"]');
    assert.equal(pipelineId.disabled, true);
    const deleteButton = harness.document.root.querySelector('[data-action="pipeline-delete"]');
    assert.ok(deleteButton);
    deleteButton.click();
    assert.match(harness.document.root.innerHTML, /Delete Custom A\?/);
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    const request = harness.messages.at(-1);
    assert.equal(request.type, "conversation.runtime");
    assert.equal(request.conversationId, "run-1");
    assert.equal(request.message.type, "pipeline.delete");
    assert.equal(request.message.pipelineId, "custom-a");
    assert.equal(request.message.scopeKey, "workspace:/workspace");
    assert.equal(request.message.expectedHash, customAHash);
  } finally {
    harness.restore();
  }
});

test("pipeline editor sends revision-aware create and update mutations", () => {
  const updateHarness = bootWebview();
  try {
    updateHarness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    updateHarness.document.root.querySelector('[data-action="pipeline-save"]').click();
    const update = updateHarness.messages.at(-1);
    assert.equal(update.message.type, "pipeline.save");
    assert.equal(update.message.mode, "update");
    assert.equal(update.message.scopeKey, "workspace:/workspace");
    assert.equal(update.message.sourcePipelineId, "custom-a");
    assert.equal(update.message.expectedHash, customAHash);
  } finally {
    updateHarness.restore();
  }

  const createHarness = bootWebview();
  try {
    createHarness.document.root.querySelector('[data-action="pipeline-new"]').click();
    createHarness.document.root.querySelector('[data-action="pipeline-save"]').click();
    const create = createHarness.messages.at(-1);
    assert.equal(create.message.type, "pipeline.save");
    assert.equal(create.message.mode, "create");
    assert.equal(create.message.scopeKey, "workspace:/workspace");
    assert.equal(create.message.sourcePipelineId, undefined);
    assert.equal(create.message.expectedHash, undefined);
  } finally {
    createHarness.restore();
  }
});

test("legacy blocked queue requests expose cancellation without a misleading resume action", () => {
  const harness = bootWebview(
    managerState(),
    panelState({
      queuePaused: true,
      queuedMessages: [{
        id: "legacy-queue",
        kind: "pipeline",
        pipelineId: "custom-a",
        blockedReason: "Cancel and queue this request again.",
        prompt: "Old request",
        recipients: [],
        mode: "implementation",
        attachmentIds: [],
        iterationCount: 1,
        createdAt: timestamp,
      }],
    }),
  );
  try {
    assert.match(harness.document.root.innerHTML, /Cancel and queue this request again\./u);
    assert.equal(harness.document.root.querySelector('[data-action="queue-resume"]'), null);
    assert.ok(harness.document.root.querySelector('[data-action="queue-cancel"]'));
  } finally {
    harness.restore();
  }
});

test("pending pipeline editor operations cannot be dismissed with Escape", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="pipeline-new"]').click();
    harness.document.root.querySelector('[data-action="pipeline-import"]').click();
    const request = harness.messages.at(-1);
    assert.equal(request.message.type, "pipeline.import");
    harness.document.root.dispatch("keydown", {
      key: "Escape",
      shiftKey: false,
      preventDefault: () => undefined,
      target: harness.document.root,
    });
    assert.match(harness.document.root.innerHTML, /Pipeline editor/);
    assert.doesNotMatch(harness.document.root.innerHTML, /Discard pipeline changes/);
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-editor-close"]').disabled, true);
  } finally {
    harness.restore();
  }
});

test("pipeline selection locks editing until the selected definition is confirmed", () => {
  const harness = bootWebview();
  try {
    const select = harness.document.getElementById("pipeline-select");
    select.value = "custom-b";
    harness.document.root.dispatch("change", { target: select });
    const request = harness.messages.at(-1);
    assert.equal(request.message.type, "pipeline.select");
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-edit"]').disabled, true);
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-new"]').disabled, true);
    assert.match(harness.document.root.innerHTML, /Switching pipeline/);

    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "state.snapshot",
        state: panelState({
          selectedPipelineId: "custom-b",
          selectedPipelineDefinition: pipelineDefinition("custom-b", "Custom B"),
        }),
      },
    });
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "operation.result",
        operation: "pipeline.select",
        requestId: request.message.requestId,
        status: "completed",
      },
    });
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    assert.equal(harness.document.root.querySelector('[data-editor-meta="id"]').value, "custom-b");
    assert.match(harness.document.root.innerHTML, /Delete Custom B/);
  } finally {
    harness.restore();
  }
});

test("pipeline import replaces only the draft until the user saves it", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="pipeline-new"]').click();
    harness.document.root.querySelector('[data-action="pipeline-import"]').click();
    const request = harness.messages.at(-1);
    const imported = pipelineDefinition("imported", "Imported pipeline");
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "operation.result",
        operation: "pipeline.import",
        requestId: request.message.requestId,
        status: "completed",
        pipeline: imported,
      },
    });
    assert.match(harness.document.root.innerHTML, /Pipeline editor/);
    assert.equal(harness.document.root.querySelector('[data-editor-meta="id"]').value, "imported");
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-delete"]'), null);
    assert.equal(harness.messages.filter((message) => message.message?.type === "pipeline.save").length, 0);
    harness.document.root.querySelector('[data-action="pipeline-editor-close"]').click();
    assert.match(harness.document.root.innerHTML, /Discard pipeline changes/);
  } finally {
    harness.restore();
  }
});

test("interaction and approval submissions are locally idempotent", () => {
  const interaction = {
    interactionRef: "interaction-1",
    conversationId: "run-1",
    runRef: "run-1",
    kind: "permission",
    title: "Permission",
    prompt: "Continue?",
    options: [{ id: "yes", label: "Yes" }],
    allowFreeText: false,
    secret: false,
    selected: ["yes"],
    freeText: "",
    status: "pending",
    createdAt: timestamp,
  };
  const approval = {
    agentId: "lead",
    requestId: "approval-1",
    kind: "command",
    command: "npm test",
    choices: [{ id: "allow", label: "Allow" }],
  };
  const harness = bootWebview(managerState({ interactions: [interaction] }), panelState({ approvals: [approval] }));
  try {
    const interactionButton = harness.document.root.querySelector('[data-action="interaction-submit"]');
    interactionButton.click();
    interactionButton.click();
    assert.equal(harness.messages.filter((message) => message.type === "interaction.submit").length, 1);
    assert.match(harness.document.root.innerHTML, /Submitting…/);

    assert.match(harness.document.root.innerHTML, /Run needs your input/u);
    assert.match(harness.document.root.innerHTML, /Execution \(1\)/u);
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const approvalButton = harness.document.root.querySelector('[data-action="approval"]');
    assert.ok(approvalButton);
    approvalButton.click();
    approvalButton.click();
    assert.equal(harness.messages.filter((message) => message.message?.type === "approval.respond").length, 1);
  } finally {
    harness.restore();
  }
});

test("workflow renders the lead ruling with objections, risks, and participant navigation", () => {
  const event = {
    id: 1,
    type: "decision.published",
    status: "ruled",
    title: "DABC123",
    createdAt: timestamp,
    payload: {
      stepId: "step-1",
      round: 2,
      policy: "arbiter",
      candidateId: "DABC123",
      candidate: "Use the selected implementation.",
      participants: [
        { agentId: "lead", valid: true, accepted: true, candidate: "A", candidateHash: "a", objections: [], unresolvedRisks: [], validationErrors: [] },
        { agentId: "worker", valid: true, accepted: true, candidate: "B", candidateHash: "b", objections: ["Needs another check"], unresolvedRisks: ["Provider DOM may change"], validationErrors: [] },
      ],
      objections: [{ agentId: "worker", text: "Needs another check", accepted: false }],
      unresolvedRisks: ["Provider DOM may change"],
      ruledBy: "lead",
    },
  };
  const panel = panelState({
    transcript: [{ id: "answer-1", kind: "answer", agentId: "worker", text: "Worker output", createdAt: timestamp }],
    transcriptTotal: 1,
  });
  const harness = bootWebview(managerState({ eventsByConversation: { "run-1": [event] } }), panel);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    assert.match(harness.document.root.innerHTML, /Lead’s Final Ruling/);
    assert.match(harness.document.root.innerHTML, /Use the selected implementation/);
    assert.match(harness.document.root.innerHTML, /Overruled/);
    assert.match(harness.document.root.innerHTML, /Provider DOM may change/);
    const worker = harness.document.root.querySelector('[data-action="focus-agent-output"][data-agent="worker"]');
    worker.click();
    assert.equal(harness.document.activeElement.dataset.agentId, "worker");
  } finally {
    harness.restore();
  }
});

test("participants can be compared side by side and iterations traced against each other", () => {
  const ruling = (id, createdAt, risks, objectionAccepted) => ({
    id,
    type: "decision.published",
    status: "ruled",
    title: `D${String(id)}`,
    createdAt,
    payload: {
      stepId: "step-1",
      round: id,
      policy: "arbiter",
      candidateId: `D${String(id)}`,
      candidate: "Use the selected implementation.",
      participants: [
        {
          agentId: "lead",
          valid: true,
          accepted: true,
          candidate: "Lead proposal",
          candidateHash: "aaaaaaaaaaaaaaaa",
          objections: [],
          unresolvedRisks: [],
          validationErrors: [],
        },
        {
          agentId: "worker",
          valid: false,
          accepted: false,
          candidate: "Worker proposal",
          candidateHash: "bbbbbbbbbbbbbbbb",
          objections: ["Needs another check"],
          unresolvedRisks: ["Provider DOM may change"],
          validationErrors: ["missing field: summary"],
        },
      ],
      objections: [{ agentId: "worker", text: "Needs another check", accepted: objectionAccepted }],
      unresolvedRisks: risks,
      ruledBy: "lead",
    },
  });
  const harness = bootWebview(
    managerState({
      eventsByConversation: {
        "run-1": [
          ruling(1, timestamp, ["Provider DOM may change", "Windows untested"], false),
          ruling(2, timestamp, ["Windows untested"], true),
        ],
      },
    }),
    panelState(),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Iteration comparison/u);
    assert.match(html, /first ruling/u);
    assert.match(html, /1 resolved/u);
    assert.match(html, /Compare 2 participant outputs side by side/u);
    assert.match(html, /Lead proposal/u);
    assert.match(html, /Worker proposal/u);
    assert.match(html, /Validation errors/u);
    assert.match(html, /missing field: summary/u);
    assert.match(html, /Raised no objection\./u);
    assert.match(html, /aaaaaaaaaaaa/u);
  } finally {
    harness.restore();
  }
});

test("retained TODO runs can be revealed and cleaned up independently", () => {
  const retainedRun = {
    runId: "todo-a",
    title: "TODO · A",
    status: "completed",
    integrationBranch: "bachata/integration/todo-a",
    integrationWorktree: "/workspace/.bachata/todo-a",
    createdAt: timestamp,
    updatedAt: timestamp,
    taskCount: 2,
  };
  const harness = bootWebview(managerState({
    orchestration: { active: false, tasks: [], retainedRuns: [retainedRun] },
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    assert.match(harness.document.root.innerHTML, /Retained TODO runs/);
    assert.match(harness.document.root.innerHTML, /bachata\/integration\/todo-a/);
    harness.document.root.querySelector('[data-action="orchestration-reveal"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "orchestration.reveal", runId: "todo-a" });
    harness.document.root.querySelector('[data-action="orchestration-cleanup"]').click();
    assert.match(harness.document.root.innerHTML, /Clean up TODO · A\?/);
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "orchestration.cleanup", runId: "todo-a" });
  } finally {
    harness.restore();
  }
});

test("browser conversation binding is available in the main run view", () => {
  const harness = bootWebview(
    managerState(),
    panelState({
      adapterTypes: ["chatgpt-browser"],
      agents: {
        browser: {
          id: "browser",
          name: "Browser Lead",
          adapterType: "chatgpt-browser",
          status: "idle",
          output: "",
        },
      },
      browserBridge: {
        enabled: true,
        connected: true,
        sessions: [{
          id: "session-1",
          provider: "chatgpt",
          tabId: 7,
          conversationIdentity: "conversation-1",
          conversationUrl: "https://chatgpt.com/c/conversation-1",
          title: "Main browser conversation",
          status: "ready",
        }],
      },
    }),
  );
  try {
    assert.match(harness.document.root.innerHTML, /browser-binding-bar/u);
    const select = harness.document.root.querySelector('[data-action="browser-session"][data-agent="browser"]');
    assert.ok(select);
    assert.equal(select.disabled, false);
    select.value = "session-1";
    harness.document.root.dispatch("change", { target: select });
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime",
      conversationId: "run-1",
      message: {
        type: "browser.session.select",
        agentId: "browser",
        sessionId: "session-1",
      },
    });
  } finally {
    harness.restore();
  }
});

test("resource waiting is visible and cancellable before providers start", () => {
  const waitingConversation = {
    ...conversationSummary(),
    waitingForResources: true,
  };
  const harness = bootWebview(
    managerState({ conversations: [waitingConversation] }),
    panelState({ running: false, workflowStatus: "idle" }),
  );
  try {
    assert.match(harness.document.root.innerHTML, /Waiting for shared capacity/);
    const cancel = harness.document.root.querySelector('[data-action="interrupt-run"]');
    assert.ok(cancel);
    assert.match(harness.document.root.innerHTML, /Cancel wait/);
    // Send cannot start a run while the panel waits for shared capacity. Non-activation is what
    // is asserted, by dispatching the control, rather than the `disabled` attribute that used to
    // enforce it — and the control stays in the tab order so a keyboard reader reaches the
    // conditions it points at instead of skipping past a control it can never focus.
    const submit = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(submit.getAttribute("aria-disabled"), "true");
    assert.equal(submit.getAttribute("aria-describedby"), "composer-blockers");
    assert.equal(submit.disabled, false, "a blocked Send is out of the tab order");
    const beforeSubmit = harness.messages.length;
    submit.click();
    assert.equal(
      harness.messages.length,
      beforeSubmit,
      "Send started a run while the panel waited for shared capacity",
    );
    cancel.click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime",
      conversationId: "run-1",
      message: { type: "run.interrupt" },
    });
  } finally {
    harness.restore();
  }
});


test("active run and pipeline editor modes expose semantic selection state", () => {
  const harness = bootWebview();
  try {
    const activeRun = harness.document.root.querySelector(
      '[data-action="select-conversation"][data-conversation="run-1"]',
    );
    assert.equal(activeRun.getAttribute("aria-current"), "page");

    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    const structured = harness.document.root.querySelector(
      '[data-action="editor-mode"][data-mode="form"]',
    );
    const json = harness.document.root.querySelector(
      '[data-action="editor-mode"][data-mode="json"]',
    );
    assert.equal(structured.getAttribute("aria-pressed"), "true");
    assert.equal(json.getAttribute("aria-pressed"), "false");
    json.click();
    assert.equal(
      harness.document.root.querySelector(
        '[data-action="editor-mode"][data-mode="form"]',
      ).getAttribute("aria-pressed"),
      "false",
    );
    assert.equal(
      harness.document.root.querySelector(
        '[data-action="editor-mode"][data-mode="json"]',
      ).getAttribute("aria-pressed"),
      "true",
    );
  } finally {
    harness.restore();
  }
});

test("dynamic manager and runtime failures render as alert regions", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({ type: "manager.error", message: "Manager failed" });
    const managerAlert = harness.document.root.querySelector('[role="alert"]');
    assert.ok(managerAlert);
    assert.match(harness.document.root.innerHTML, /Manager failed/u);

    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "attachment.failed",
        clientId: "upload-1",
        message: "Runtime failed",
      },
    });
    assert.match(harness.document.root.innerHTML, /Runtime failed/u);
    // Two DIFFERENT failures are two facts and both are shown. Counted exactly, because ">= 1"
    // passes whether the view shows one alert, two, or the same alert twice — and showing the
    // same alert twice is the defect this pins.
    assert.equal(harness.document.root.querySelectorAll(".global-error").length, 2);
    assert.match(
      harness.document.root.innerHTML,
      /global-error[^>]*>Manager failed<[\s\S]*?global-error[^>]*>Runtime failed</u,
    );

    // render() replaces the whole tree, so an unrelated snapshot re-inserts both alerts and a
    // screen reader reads them out again. The region keeps role="alert" — it is still an alert
    // in the accessibility tree, and still findable — and says with an explicit aria-live="off"
    // that this insertion carries nothing new.
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "state.snapshot", state: panelState() },
    });
    assert.equal(harness.document.root.querySelectorAll(".global-error").length, 2);
    assert.match(
      harness.document.root.innerHTML,
      /class="global-error" role="alert" aria-live="off">Manager failed</u,
    );
    assert.match(
      harness.document.root.innerHTML,
      /class="global-error" role="alert" aria-live="off">Runtime failed</u,
    );
  } finally {
    harness.restore();
  }
});

test("a failure banner can be put away without waiting for the state behind it to change", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({ type: "manager.error", message: "Manager failed" });
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "attachment.failed",
        clientId: "upload-1",
        message: "Runtime failed",
      },
    });
    assert.equal(harness.document.root.querySelectorAll(".global-error").length, 2);

    const dismiss = harness.document.root.querySelectorAll('[data-action="error-dismiss"]');
    assert.equal(dismiss.length, 2, "a failure banner offers no way to put it away");
    dismiss[0].click();
    // Dismissing one failure leaves the other standing: two failures are still two facts.
    assert.equal(harness.document.root.querySelectorAll(".global-error").length, 1);
    assert.doesNotMatch(harness.document.root.innerHTML, /Manager failed/u);
    assert.match(harness.document.root.innerHTML, /Runtime failed/u);

    // And it stays gone: the message is cleared where it was recorded, not just off the screen.
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "state.snapshot", state: panelState() },
    });
    assert.equal(harness.document.root.querySelectorAll(".global-error").length, 1);
    assert.doesNotMatch(harness.document.root.innerHTML, /Manager failed/u);
  } finally {
    harness.restore();
  }
});

test("one failure recorded in two places is shown once", () => {
  // A conversation that cannot be initialized records the failure twice: the manager holds it
  // because the manager is what failed to build the conversation, and the conversation holds it
  // because the conversation is what cannot run. One cause, one message, and it was drawn as two
  // identical alerts stacked on each other.
  const harness = bootWebview();
  try {
    const message = "Invalid pipeline feature-delivery.pipeline.json";
    harness.sendWindowMessage({ type: "manager.error", message });
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "error", message },
    });
    assert.equal(harness.document.root.querySelectorAll(".global-error").length, 1);
    assert.match(harness.document.root.innerHTML, /Invalid pipeline feature-delivery.pipeline.json/u);
  } finally {
    harness.restore();
  }
});

test("retained cleanup-pending runs disable reveal and allow deterministic cleanup retry", () => {
  const retainedRun = {
    runId: "todo-pending",
    title: "TODO · Pending cleanup",
    status: "cleanupPending",
    integrationBranch: "bachata/integration/todo-pending",
    integrationWorktree: "/workspace/.bachata/todo-pending",
    createdAt: timestamp,
    updatedAt: timestamp,
    taskCount: 1,
  };
  const harness = bootWebview(managerState({
    orchestration: { active: false, tasks: [], retainedRuns: [retainedRun] },
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    assert.match(harness.document.root.innerHTML, /cleanup pending/u);
    const reveal = harness.document.root.querySelector('[data-action="orchestration-reveal"]');
    const cleanup = harness.document.root.querySelector('[data-action="orchestration-cleanup"]');
    assert.equal(reveal.disabled, true);
    assert.equal(cleanup.disabled, false);
    assert.match(cleanup.textContent || harness.document.root.innerHTML, /Retry cleanup/u);
    const before = harness.messages.length;
    reveal.click();
    assert.equal(harness.messages.length, before);
    cleanup.click();
    assert.match(harness.document.root.innerHTML, /Retry cleanup for TODO · Pending cleanup\?/u);
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.cleanup",
      runId: "todo-pending",
    });
  } finally {
    harness.restore();
  }
});


test("webview announces run and capacity transitions without making the transcript live", () => {
  const harness = bootWebview();
  try {
    assert.equal(harness.document.liveStatus.textContent, "");
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "run.patch", running: true, workflowStatus: "running" },
    });
    assert.equal(harness.document.liveStatus.textContent, "Run started.");

    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "run.patch", running: false, workflowStatus: "completed" },
    });
    assert.equal(harness.document.liveStatus.textContent, "Run completed.");

    const waitingConversation = {
      ...conversationSummary(),
      running: false,
      workflowStatus: "idle",
      waitingForResources: true,
    };
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({ conversations: [waitingConversation] }),
    });
    assert.equal(harness.document.liveStatus.textContent, "Run is waiting for shared capacity.");
    assert.doesNotMatch(harness.document.root.innerHTML, /conversation-scroll[^>]*aria-live/u);
  } finally {
    harness.restore();
  }
});

test("pipeline editor renders managed policy as guardrail summaries with working fields", () => {
  const harness = bootWebview(managerState(), panelState({ selectedPipelineDefinition: pipelineDefinition() }));
  try {
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /data-guardrail="reads"[\s\S]*?codicon-eye[\s\S]*?Can read[\s\S]*?Whole workspace/u);
    assert.match(html, /data-guardrail="writes"[\s\S]*?Can change[\s\S]*?Nothing — review only/u);
    assert.match(html, /data-guardrail="protected"[\s\S]*?Never touches/u);
    assert.match(html, /data-guardrail="commits"[\s\S]*?Commits[\s\S]*?Pipeline default/u);
    assert.match(html, /data-guardrail="checks"[\s\S]*?Runs checks[\s\S]*?None configured/u);
    const writes = harness.document.root.querySelector('[data-editor-policy="allowedPaths"]');
    assert.ok(writes);
    writes.value = "src/api\n";
    harness.document.root.dispatch("input", { target: writes });
    const raw = harness.document.getElementById("pipeline-raw");
    if (raw) {
      assert.match(raw.textContent, /src\/api/u);
    }
  } finally {
    harness.restore();
  }
});

test("composer hides iteration and delivery controls behind an options toggle with chip summary", () => {
  const harness = bootWebview(managerState(), panelState({ selectedPipelineDefinition: pipelineDefinition() }));
  try {
    assert.doesNotMatch(harness.document.root.innerHTML, /id="pipeline-iterations"/u);
    assert.match(harness.document.root.innerHTML, /data-action="composer-options-toggle"[^>]*><i class="codicon codicon-settings-gear[^>]*><\/i><span>Options<\/span>/u);
    harness.document.root.querySelector('[data-action="composer-options-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /class="composer-advanced"/u);
    assert.match(harness.document.root.innerHTML, /id="pipeline-iterations"/u);
    const delivery = harness.document.root.querySelector("#message-delivery");
    delivery.value = "queue";
    harness.document.root.dispatch("change", { target: delivery });
    assert.match(
      harness.document.root.innerHTML,
      /<span>Options · queued<\/span>/u,
    );
    assert.match(harness.document.root.innerHTML, /data-action="submit-message" data-delivery="queue"/u);
  } finally {
    harness.restore();
  }
});

test("prepared drafts stay durable until the composer is cleared", async () => {
  const harness = installGlobals();
  try {
    delete require.cache[require.resolve("../dist/webview-behavior.js")];
    delete require.cache[require.resolve("../dist/webview.js")];
    require("../dist/webview-behavior.js");
    require("../dist/webview.js");

    const createdAt = new Date().toISOString();
    const snapshot = (preparedDraft) => ({
      type: "manager.snapshot",
      state: {
        conversations: [{
          id: "run-1",
          runRef: "run-1",
          title: "Test run",
          ...(preparedDraft ? { preparedDraft } : {}),
          iterationCount: 1,
          activeIteration: 0,
          createdAt,
          updatedAt: createdAt,
          running: false,
          workflowStatus: "idle",
          unread: 0,
          archived: false,
        }],
        activeConversationId: "run-1",
        defaultPipelineIterations: 1,
        maxPipelineIterations: 10,
        interactions: [],
        eventsByConversation: {},
        orchestration: { active: false, masterChecks: [], tasks: [], finalChecks: [], retainedRuns: [] },
      },
    });

    harness.sendWindowMessage(snapshot("Review file: src/a.ts"));
    assert.match(harness.document.root.innerHTML, /Review file: src\/a\.ts/);
    assert.equal(
      harness.messages.some((message) => message.type === "conversation.consumePreparedDraft"),
      false,
    );

    const composer = harness.document.root.querySelector("#composer-prompt");
    assert.ok(composer);
    composer.value = "Review file: src/a.ts with extra context";
    harness.document.root.dispatch("input", { target: composer });
    assert.equal(
      harness.messages.some((message) => message.type === "conversation.saveDraft"),
      false,
      "the draft was saved before its debounce elapsed",
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.saveDraft",
      conversationId: "run-1",
      text: "Review file: src/a.ts with extra context",
    });

    composer.value = "";
    harness.document.root.dispatch("input", { target: composer });
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.consumePreparedDraft",
      conversationId: "run-1",
    });
  } finally {
    harness.restore();
  }
});

test("the composer shows the execution contract before a run starts", () => {
  const contract = {
    pipelineId: "custom-a",
    pipelineName: "Custom A",
    safetyLevel: "managed",
    providers: [
      { agentId: "lead", name: "Lead", adapter: "codex-app-server", adapterLabel: "Codex CLI", model: "gpt-5-codex", modelSource: "configured", runtimeVersion: "codex 1.2.3", runtimeVersionSource: "detected", roles: ["lead"], status: "ready", detail: "codex 1.0" },
      { agentId: "worker", name: "Worker", adapter: "claude-code", adapterLabel: "Claude Code", modelSource: "unreported", runtimeVersionSource: "unreported", roles: ["worker"], status: "needsSetup", detail: "claude unavailable" },
    ],
    scope: {
      workingDirectory: "/workspace",
      writeScope: "task",
      writablePaths: ["src"],
      readablePaths: ["docs"],
      protectedPaths: ["policy"],
    },
    roles: [
      {
        id: "worker",
        name: "Worker",
        managed: true,
        optional: false,
        readOnly: false,
        writeScope: "task",
        writablePaths: ["src"],
        readablePaths: [],
        protectedPaths: [],
        commitPolicy: "allow",
        verification: ["bachata:project-checks"],
        candidateAgentIds: ["worker"],
      },
      {
        id: "reviewer",
        name: "Reviewer",
        managed: true,
        optional: true,
        readOnly: true,
        writeScope: "readOnly",
        writablePaths: [],
        readablePaths: [],
        protectedPaths: [],
        commitPolicy: "never",
        verification: [],
        candidateAgentIds: [],
      },
    ],
    commitPolicy: "never",
    verification: ["bachata:project-checks"],
    verificationResources: ["port:4173"],
    humanGates: [{ stepId: "step-1", stepName: "Implement", gate: "after" }],
    limits: {
      iterations: 1,
      maxIterations: 10,
      iterationMode: "fixed",
      agentTurnTimeoutMs: 1_800_000,
      managedTaskTimeoutMs: 7_200_000,
      maxRevisionCycles: 1,
      maxConsensusRounds: 6,
      maxParticipantTurns: 24,
      participantTurnsBounded: true,
      consensusSteps: [
        { stepId: "converge", stepName: "Converge", maxRounds: 6, roundLimitRetryable: true },
      ],
    },
    provenance: {
      extensionVersion: "0.6.12",
      pipelineHash: "abcdef012345".padEnd(64, "0"),
    },
    fallbacks: ["Worker: gpt-worker → generic-worker"],
    completion: ["Every enabled step of Custom A completes"],
    blockers: ["Worker: claude unavailable"],
  };
  const harness = bootWebview(managerState(), panelState({ executionContract: contract }));
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /Managed implementation/u);
    assert.match(html, /Lead · Codex CLI · model gpt-5-codex/u);
    assert.match(html, /Worker · Claude Code · model not reported/u);
    assert.match(html, /Role authority/u);
    assert.match(html, /Worker · managed · writes isolated task worktree · paths src · commits allowed · checks bachata:project-checks/u);
    assert.match(html, /Reviewer · managed · optional · read-only · no commits/u);
    assert.match(html, /isolated task worktree/u);
    assert.match(html, /no commits are created/u);
    assert.match(html, /bachata:project-checks/u);
    assert.match(html, /port:4173/u);
    assert.match(html, /Provider turn limit: 30 min/u);
    assert.match(html, /Managed task limit: 2 h/u);
    assert.match(html, /Consensus rounds, Converge: at most 6 before a human decision/u);
    assert.match(html, /retrying at the round limit grants another 6/u);
    assert.match(html, /Participant turns: at most 24 for the whole run/u);
    assert.match(html, /Provenance/u);
    assert.match(html, /Extension version: 0\.6\.12/u);
    assert.match(html, /Pipeline hash: abcdef012345…/u);
    assert.match(html, /Lead: model gpt-5-codex, runtime codex 1\.2\.3/u);
    // A provider that reported no model and no runtime says which of the two it is: a model
    // nobody configured and a runtime nothing detected are different absences.
    assert.match(html, /Worker: model not reported, runtime not detected/u);
    assert.match(html, /Implement · after/u);
    assert.match(html, /gpt-worker/u);
    assert.match(html, /1 unresolved/u);
    assert.match(html, /Worker: claude unavailable/u);
  } finally {
    harness.restore();
  }
});

test("the result center exposes provenance and developer-tool handoff", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: ["src/a.ts"],
            checks: [{ command: "bachata:project-checks", status: "passed" }],
            finalRuling: "Accepted with follow-up",
            rulingBy: "claude",
            providers: [
              { name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" },
              { name: "Claude", adapter: "claude-code" },
            ],
            unresolvedRisks: [],
            recoveredErrors: ["Adapter restart required"],
            evidenceGaps: [],
          },
        },
      }),
    });

    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Ruled by claude/u);
    assert.match(html, /Codex \(codex-app-server · gpt-5-codex\)/u);
    assert.match(html, /Recovered errors/u);
    assert.match(html, /Adapter restart required/u);

    harness.document.root.querySelector('[data-action="result-open-changes"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.openChanges",
      conversationId: "run-1",
      path: "src/a.ts",
    });

    harness.document.root.querySelector('[data-action="result-source-control"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.openSourceControl",
      conversationId: "run-1",
    });
  } finally {
    harness.restore();
  }
});

test("a retained run offers one inspect, recheck, patch, and apply handoff", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        orchestration: {
          active: false,
          runId: "RLATERRUN",
          masterChecks: [],
          tasks: [],
          finalChecks: [],
          retainedRuns: [],
        },
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: ["src/a.ts"],
            checks: [{ command: "bachata:project-checks", status: "passed" }],
            finalRuling: "Accepted",
            rulingBy: "claude",
            providers: [],
            unresolvedRisks: ["Windows path handling is unverified"],
            recoveredErrors: [],
            evidenceGaps: ["No end-to-end run was executed"],
            retainedWorktree: "/work/.bachata/runs/R7K3M9QAB/integration",
            retainedRunId: "R7K3M9QAB",
          },
        },
      }),
    });

    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Inspect and apply/u);
    assert.match(html, /nothing has been committed/u);
    assert.match(html, /1 unresolved risk, 1 evidence gap/u);
    assert.match(html, /Ruled by claude/u);
    assert.match(html, /On conflict the working tree is restored/u);

    harness.document.root.querySelector('[data-action="orchestration-recheck"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.recheck",
      runId: "R7K3M9QAB",
      conversationId: "run-1",
    });
    harness.document.root.querySelector('[data-action="orchestration-patch"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.patch",
      runId: "R7K3M9QAB",
      conversationId: "run-1",
    });
    harness.document.root.querySelector('[data-action="orchestration-apply"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.apply",
      runId: "R7K3M9QAB",
      conversationId: "run-1",
    });
    harness.document.root.querySelector('[data-action="orchestration-reveal"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.reveal",
      runId: "R7K3M9QAB",
      conversationId: "run-1",
    });
  } finally {
    harness.restore();
  }
});

test("the handoff targets the displayed run, never the globally active one", () => {
  const harness = bootWebview(
    managerState({
      orchestration: {
        active: true,
        runId: "RGLOBALRUN",
        masterChecks: [],
        tasks: [],
        finalChecks: [],
        retainedRuns: [],
      },
      resultsByConversation: {
        "run-1": {
          status: "completed",
          changedFiles: ["src/a.ts"],
          checks: [],
          providers: [],
          unresolvedRisks: [],
          recoveredErrors: [],
          evidenceGaps: [],
          retainedWorktree: "/work/.bachata/runs/RSHOWNRUN/integration",
          retainedRunId: "RSHOWNRUN",
        },
      },
    }),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    harness.document.root.querySelector('[data-action="orchestration-apply"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.apply",
      runId: "RSHOWNRUN",
      conversationId: "run-1",
    });
    assert.equal(harness.document.root.innerHTML.includes("RGLOBALRUN"), false);
  } finally {
    harness.restore();
  }
});

test("a result with a worktree but no bound run offers no handoff", () => {
  const harness = bootWebview(
    managerState({
      orchestration: {
        active: false,
        runId: "RGLOBALRUN",
        masterChecks: [],
        tasks: [],
        finalChecks: [],
        retainedRuns: [],
      },
      resultsByConversation: {
        "run-1": {
          status: "completed",
          changedFiles: ["src/a.ts"],
          checks: [],
          providers: [],
          unresolvedRisks: [],
          recoveredErrors: [],
          evidenceGaps: [],
          retainedWorktree: "/work/.bachata/runs/RSHOWNRUN/integration",
        },
      },
    }),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    assert.equal(harness.document.root.innerHTML.includes("Inspect and apply"), false);
    assert.equal(harness.document.root.querySelector('[data-action="orchestration-apply"]'), null);
    assert.equal(harness.document.root.querySelector('[data-action="orchestration-reveal"]'), null);
  } finally {
    harness.restore();
  }
});

test("a handoff control without a conversation binding sends nothing", () => {
  const harness = bootWebview(
    managerState({
      resultsByConversation: {
        "run-1": {
          status: "completed",
          changedFiles: ["src/a.ts"],
          checks: [],
          providers: [],
          unresolvedRisks: [],
          recoveredErrors: [],
          evidenceGaps: [],
          retainedWorktree: "/work/.bachata/runs/RSHOWNRUN/integration",
          retainedRunId: "RSHOWNRUN",
        },
      },
    }),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const apply = harness.document.root.querySelector('[data-action="orchestration-apply"]');
    delete apply.dataset.conversation;
    const before = harness.messages.length;
    apply.click();
    assert.equal(harness.messages.length, before, "an unbound apply must not be sent");
  } finally {
    harness.restore();
  }
});

test("a run without a retained worktree offers no apply handoff", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: [],
            checks: [],
            providers: [],
            unresolvedRisks: [],
            recoveredErrors: [],
            evidenceGaps: [],
          },
        },
      }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    assert.equal(harness.document.root.innerHTML.includes("Inspect and apply"), false);
    assert.equal(harness.document.root.querySelector('[data-action="orchestration-apply"]'), null);
  } finally {
    harness.restore();
  }
});

test("a draft edited just before panel disposal survives reload", () => {
  const harness = installGlobals();
  try {
    delete require.cache[require.resolve("../dist/webview-behavior.js")];
    delete require.cache[require.resolve("../dist/webview.js")];
    require("../dist/webview-behavior.js");
    require("../dist/webview.js");

    const createdAt = new Date().toISOString();
    const snapshot = (preparedDraft) => ({
      type: "manager.snapshot",
      state: {
        conversations: [{
          id: "run-1",
          runRef: "run-1",
          title: "Test run",
          ...(preparedDraft ? { preparedDraft } : {}),
          iterationCount: 1,
          activeIteration: 0,
          createdAt,
          updatedAt: createdAt,
          running: false,
          workflowStatus: "idle",
          unread: 0,
          archived: false,
        }],
        activeConversationId: "run-1",
        defaultPipelineIterations: 1,
        maxPipelineIterations: 10,
        interactions: [],
        eventsByConversation: {},
        orchestration: { active: false, masterChecks: [], tasks: [], finalChecks: [], retainedRuns: [] },
      },
    });

    harness.sendWindowMessage(snapshot("Review file: src/a.ts"));
    const composer = harness.document.root.querySelector("#composer-prompt");
    composer.value = "Review file: src/a.ts and explain the retry path";
    harness.document.root.dispatch("input", { target: composer });

    assert.equal(
      harness.messages.some((message) => message.type === "conversation.saveDraft"),
      false,
      "the debounce already fired",
    );
    assert.equal(
      harness.webviewState.value.drafts["run-1"],
      "Review file: src/a.ts and explain the retry path",
      "the edit was not stored synchronously",
    );

    harness.sendWindowEvent("beforeunload", {});
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.saveDraft",
      conversationId: "run-1",
      text: "Review file: src/a.ts and explain the retry path",
    });

    const persisted = harness.webviewState.value;
    harness.restore();

    const reloaded = installGlobals();
    reloaded.webviewState.value = persisted;
    try {
      delete require.cache[require.resolve("../dist/webview-behavior.js")];
      delete require.cache[require.resolve("../dist/webview.js")];
      require("../dist/webview-behavior.js");
      require("../dist/webview.js");
      reloaded.sendWindowMessage(snapshot("Review file: src/a.ts"));

      assert.match(
        reloaded.document.root.innerHTML,
        /Review file: src\/a\.ts and explain the retry path/u,
        "the reloaded panel restored the original generated draft",
      );
      assert.ok(
        reloaded.messages.some((message) =>
          message.type === "conversation.saveDraft" &&
          message.text === "Review file: src/a.ts and explain the retry path"
        ),
        "the restored edit was not reconciled with catalog state",
      );
    } finally {
      reloaded.restore();
    }
  } finally {
    harness.restore();
  }
});

test("the result center states evidence as recorded, not applicable, or expected but missing", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: [],
            checks: [],
            providers: [{ name: "Codex", adapter: "codex-app-server" }],
            unresolvedRisks: [],
            recoveredErrors: [],
            expectations: { changedFiles: false, verification: false, finalRuling: false },
            evidence: [
              { kind: "changedFiles", label: "Changed files", state: "notApplicable", detail: "This contract grants no write authority, so changed files are not expected" },
              { kind: "verification", label: "Verification", state: "notApplicable", detail: "This pipeline declares no controller-owned verification, so no check evidence is expected" },
              { kind: "finalRuling", label: "Final ruling", state: "notApplicable", detail: "This pipeline declares no consensus or checklist ruling, so no final ruling is expected" },
              { kind: "rulingProvenance", label: "Ruling provenance", state: "recorded", detail: "Ruled by codex" },
            ],
            evidenceGaps: [],
            finalAssessment: {
              outcome: "completed",
              method: "singleProvider",
              summary: "Every enabled step completed",
              producedBy: [{ name: "Codex", adapter: "codex-app-server" }],
            },
          },
        },
      }),
    });

    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Not applicable<\/span>/u);
    assert.match(html, /Recorded<\/span>/u);
    assert.doesNotMatch(html, /Expected but missing/u);
    assert.match(html, /Run assessment/u);
    assert.match(html, /Completed · single provider · unverified/u);
    const assessment = html.slice(html.indexOf("result-decision"), html.indexOf("result-grid"));
    assert.doesNotMatch(assessment, /Accepted|Rejected/u);
    assert.match(html, /Not applicable: this contract grants no write authority/u);

    harness.document.root.querySelector('[data-action="result-publish-findings"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.publishFindings",
      conversationId: "run-1",
    });
  } finally {
    harness.restore();
  }
});

test("a model-reviewed run with no controller checks is still stated as unverified", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: [],
            checks: [],
            consensusRuling: true,
            providers: [
              { name: "Codex", adapter: "codex-app-server" },
              { name: "Claude", adapter: "claude-code" },
            ],
            unresolvedRisks: [],
            recoveredErrors: [],
            expectations: { changedFiles: false, verification: false, finalRuling: true },
            evidence: [],
            evidenceGaps: [],
            finalRuling: "Both providers agreed the retry path is correct",
            finalAssessment: {
              outcome: "completed",
              method: "consensus",
              summary: "Every enabled step completed",
              producedBy: [
                { name: "Codex", adapter: "codex-app-server" },
                { name: "Claude", adapter: "claude-code" },
              ],
            },
          },
        },
      }),
    });

    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Completed · model-reviewed · unverified/u);
    assert.doesNotMatch(html, /controller-verified/u);
  } finally {
    harness.restore();
  }
});

test("typed findings use one concise count and keep unresolved evidence in drill-down", () => {
  const harness = bootWebview();
  try {
    const provenance = {
      source: "pipelineDecision",
      stepId: "review-consensus",
      participantIds: ["codex", "claude"],
      decisionStatus: "accepted",
    };
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: [],
            checks: [],
            providers: [
              { name: "Codex", adapter: "codex-app-server" },
              { name: "Claude", adapter: "claude-code" },
            ],
            findings: [
              { id: "accepted", subject: "Guard", message: "Guard is missing", disposition: "accepted", evidence: ["Both traced it"], challenges: ["Caller checked"], provenance },
              { id: "unresolved", subject: "Product choice", message: "Human must choose behavior", disposition: "unresolved", evidence: ["Both options pass"], challenges: ["No direction exists"], provenance },
              { id: "proposed", subject: "Possible race", message: "Race is only suspected", disposition: "proposed", evidence: [], challenges: [], provenance },
              { id: "rejected", subject: "False alarm", message: "Claim was disproved", disposition: "rejected", evidence: ["Guard exists"], challenges: [], provenance },
            ],
            unresolvedRisks: [],
            recoveredErrors: [],
            expectations: { changedFiles: false, verification: false, finalRuling: true },
            evidence: [],
            evidenceGaps: [],
            finalRuling: "Typed findings recorded",
            finalAssessment: {
              outcome: "inconclusive",
              method: "consensus",
              summary: "1 model finding needs human resolution",
              producedBy: [
                { name: "Codex", adapter: "codex-app-server" },
                { name: "Claude", adapter: "claude-code" },
              ],
            },
          },
        },
      }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.equal(html.match(/Findings · 1 actionable · 1 need human/gu)?.length, 1);
    assert.match(html, /<summary>Finding details<\/summary>/u);
    assert.match(html, /Human must choose behavior/u);
    assert.match(html, /Race is only suspected/u);
    assert.match(html, /Claim was disproved/u);
  } finally {
    harness.restore();
  }
});

test("selecting changed files narrows apply and patch export to those paths", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: ["src/a.ts", "src/b.ts"],
            checks: [],
            providers: [],
            unresolvedRisks: [],
            recoveredErrors: [],
            evidenceGaps: [],
            retainedWorktree: "/work/.bachata/runs/R7K3M9QAB/integration",
            retainedRunId: "R7K3M9QAB",
          },
        },
      }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    assert.match(harness.document.root.innerHTML, /No file or hunk is selected: apply and patch export cover the whole run\./u);

    const checkbox = harness.document.root.querySelector('[data-action="result-file-select"][data-path="src/b.ts"]');
    checkbox.checked = true;
    harness.document.root.dispatch("change", { target: checkbox });

    assert.match(harness.document.root.innerHTML, /1 of 2 files selected/u);
    harness.document.root.querySelector('[data-action="orchestration-apply"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.apply",
      runId: "R7K3M9QAB",
      conversationId: "run-1",
      paths: ["src/b.ts"],
    });
  } finally {
    harness.restore();
  }
});

test("the result center leads with a decision summary before the evidence ledger", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: ["src/a.ts", "src/b.ts"],
            checks: [{ command: "bachata:project-checks", status: "passed" }],
            providers: [{ name: "Codex", adapter: "codex-app-server" }],
            unresolvedRisks: ["Cancellation path is unproven"],
            recoveredErrors: [],
            expectations: { changedFiles: true, verification: true, finalRuling: false },
            evidence: [
              { kind: "changedFiles", label: "Changed files", state: "recorded", detail: "2 changed files were recorded" },
              { kind: "verification", label: "Verification", state: "recorded", detail: "1 check was recorded" },
            ],
            evidenceGaps: [],
            finalAssessment: {
              outcome: "inconclusive",
              method: "controller",
              summary: "1 unresolved risk was recorded",
              producedBy: [{ name: "Codex", adapter: "codex-app-server" }],
            },
            retainedWorktree: "/work/.bachata/runs/R7K3M9QAB/integration",
            retainedRunId: "R7K3M9QAB",
            verificationProvenance: { source: "run", recordedAt: "2026-08-24T10:00:00.000Z" },
          },
        },
      }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;

    const decisionIndex = html.indexOf("result-decision");
    const ledgerIndex = html.indexOf("evidence-ledger");
    assert.notEqual(decisionIndex, -1, "no decision summary was rendered");
    assert.notEqual(ledgerIndex, -1, "no evidence ledger was rendered");
    assert.ok(decisionIndex < ledgerIndex, "the evidence ledger came before the decision summary");

    assert.match(html, /Changed scope<\/dt><dd>2 changed files/u);
    assert.match(html, /Verification<\/dt><dd>1 check, all passed\./u);
    assert.match(html, /Remaining risk<\/dt><dd>1 unresolved risk/u);
    // EX-UI-01. The next safe action is beside the outcome, not inside the collapsed assessment
    // disclosure the reader has to open to find it.
    const nextActionIndex = html.indexOf(`class="result-next-action"`);
    const assessmentIndex = html.indexOf("result-assessment-details");
    assert.notEqual(nextActionIndex, -1, "no next action was rendered");
    assert.ok(
      nextActionIndex < assessmentIndex,
      "the next action is still buried inside the assessment disclosure",
    );
    assert.match(html, /data-verification-source="run"/u);
  } finally {
    harness.restore();
  }
});

test("a controller-verified consensus run shows both assurance dimensions once", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: ["src/a.ts"],
            checks: [{ command: "bachata:project-checks", status: "passed" }],
            finalRuling: "Both reviewers aligned",
            rulingBy: "Claude",
            consensusRuling: true,
            providers: [
              { name: "Codex", adapter: "codex-app-server" },
              { name: "Claude", adapter: "claude-code" },
            ],
            unresolvedRisks: [],
            recoveredErrors: [],
            expectations: { changedFiles: true, verification: true, finalRuling: true },
            evidence: [],
            evidenceGaps: [],
            finalAssessment: {
              outcome: "completed",
              method: "controller",
              summary: "Both reviewers aligned",
              producedBy: [
                { name: "Codex", adapter: "codex-app-server" },
                { name: "Claude", adapter: "claude-code" },
              ],
            },
          },
        },
      }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    const assessment = html.slice(html.indexOf("result-decision"), html.indexOf("result-grid"));
    // The controller names the checks it actually ran rather than claiming a broad verdict.
    assert.match(assessment, /Controller-checked: integrity, syntax and types · model-reviewed/u);
    assert.equal(
      assessment.match(/Controller-checked: integrity, syntax and types · model-reviewed/gu)?.length,
      1,
    );
    assert.doesNotMatch(assessment, /Accepted|Rejected/u);
  } finally {
    harness.restore();
  }
});

test("a failed recheck disables apply and names the current verification", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: ["src/a.ts"],
            checks: [{ command: "bachata:project-checks", status: "failed" }],
            providers: [],
            unresolvedRisks: [],
            recoveredErrors: [],
            expectations: { changedFiles: true, verification: true, finalRuling: false },
            evidenceGaps: [],
            finalAssessment: {
              outcome: "verificationFailed",
              method: "controller",
              summary: "Controller verification failed: bachata:project-checks",
              producedBy: [],
            },
            retainedWorktree: "/work/.bachata/runs/R7K3M9QAB/integration",
            retainedRunId: "R7K3M9QAB",
            verificationProvenance: { source: "recheck", recordedAt: "2026-08-24T12:00:00.000Z" },
            applyBlockedReason: "Verification did not pass: bachata:project-checks",
          },
        },
      }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;

    assert.match(html, /data-verification-source="recheck"/u);
    assert.match(html, /Verification failed · controller-recorded/u);
    assert.match(html, /rerun of the approved checks/u);
    assert.match(html, /Apply is disabled: Verification did not pass: bachata:project-checks/u);
    const applyButton = harness.document.root.querySelector('[data-action="orchestration-apply"]');
    assert.notEqual(applyButton, null);
    assert.match(
      html.slice(html.indexOf('data-action="orchestration-apply"')).slice(0, 400),
      /disabled/u,
    );
    assert.match(html, /<p class="result-next-action">Do not apply\./u);
    const failedNextAction = html.indexOf(`class="result-next-action"`);
    assert.ok(
      failedNextAction !== -1 && failedNextAction < html.indexOf("result-assessment-details"),
      "a failed verification hid its next action inside a disclosure",
    );
  } finally {
    harness.restore();
  }
});

test("hunk selection drives both apply and patch export", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: ["src/a.ts", "logo.png"],
            checks: [{ command: "bachata:project-checks", status: "passed" }],
            providers: [],
            unresolvedRisks: [],
            recoveredErrors: [],
            expectations: { changedFiles: true, verification: true, finalRuling: false },
            evidenceGaps: [],
            retainedWorktree: "/work/.bachata/runs/R7K3M9QAB/integration",
            retainedRunId: "R7K3M9QAB",
          },
        },
      }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();

    harness.document.root.querySelector('[data-action="orchestration-diff"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.diff",
      runId: "R7K3M9QAB",
      conversationId: "run-1",
    });

    harness.sendWindowMessage({
      type: "manager.runDiff",
      conversationId: "run-1",
      runId: "R7K3M9QAB",
      files: [
        {
          path: "src/a.ts",
          binary: false,
          renamed: false,
          wholeFileOnly: false,
          hunks: [
            { index: 0, header: "@@ -1,3 +1,3 @@", added: 1, removed: 1, preview: "-old\n+new" },
            { index: 1, header: "@@ -30,3 +30,3 @@", added: 1, removed: 1, preview: "-tail\n+fixed" },
          ],
        },
        {
          path: "logo.png",
          binary: true,
          renamed: false,
          wholeFileOnly: true,
          hunks: [],
        },
      ],
    });

    const html = harness.document.root.innerHTML;
    assert.match(html, /@@ -1,3 \+1,3 @@/u);
    assert.match(html, /Whole file only \(binary\)/u);

    const hunk = harness.document.root.querySelector('[data-action="result-hunk-select"][data-path="src/a.ts"][data-hunk="1"]');
    assert.notEqual(hunk, null, "no hunk checkbox was rendered");
    hunk.checked = true;
    harness.document.root.dispatch("change", { target: hunk });

    assert.match(harness.document.root.innerHTML, /1 hunk selected/u);

    harness.document.root.querySelector('[data-action="orchestration-patch"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.patch",
      runId: "R7K3M9QAB",
      conversationId: "run-1",
      hunks: [{ path: "src/a.ts", index: 1 }],
    });

    harness.document.root.querySelector('[data-action="orchestration-apply"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "orchestration.apply",
      runId: "R7K3M9QAB",
      conversationId: "run-1",
      hunks: [{ path: "src/a.ts", index: 1 }],
    });

    const file = harness.document.root.querySelector('[data-action="result-file-select"][data-path="src/a.ts"]');
    file.checked = true;
    harness.document.root.dispatch("change", { target: file });
    harness.document.root.querySelector('[data-action="orchestration-apply"]').click();
    assert.deepEqual(
      harness.messages.at(-1),
      {
        type: "orchestration.apply",
        runId: "R7K3M9QAB",
        conversationId: "run-1",
        paths: ["src/a.ts"],
      },
      "a whole-file selection must not also send that file's hunks",
    );
  } finally {
    harness.restore();
  }
});

const inconclusiveResult = {
  status: "completed",
  changedFiles: ["src/a.ts"],
  checks: [{ command: "bachata:project-checks", status: "passed" }],
  providers: [],
  unresolvedRisks: ["Cancellation path is unproven"],
  recoveredErrors: [],
  expectations: { changedFiles: true, verification: true, finalRuling: false },
  evidenceGaps: [],
  finalAssessment: {
    outcome: "inconclusive",
    method: "controller",
    summary: "1 unresolved risk was recorded",
    producedBy: [],
  },
  retainedWorktree: "/work/.bachata/runs/R7K3M9QAB/integration",
  retainedRunId: "R7K3M9QAB",
  applyOverrideReason: "1 unresolved risk was recorded",
};

test("an inconclusive run labels Apply as an explicit override", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({ resultsByConversation: { "run-1": inconclusiveResult } }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;

    assert.match(html, /This run is inconclusive: 1 unresolved risk was recorded/u);
    assert.match(html, /explicit override/u);
    assert.match(html, /Apply to current branch despite an inconclusive result/u);
    const applyButton = html.slice(html.indexOf('data-action="orchestration-apply"')).slice(0, 300);
    assert.doesNotMatch(applyButton, /disabled/u, "an override run must stay applicable");
  } finally {
    harness.restore();
  }
});

test("the loaded diff and its selections are dropped when the conversation disappears", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({ resultsByConversation: { "run-1": inconclusiveResult } }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    harness.sendWindowMessage({
      type: "manager.runDiff",
      conversationId: "run-1",
      runId: "R7K3M9QAB",
      files: [{
        path: "src/a.ts",
        binary: false,
        renamed: false,
        wholeFileOnly: false,
        hunks: [{ index: 0, header: "@@ -1 +1 @@", added: 1, removed: 1, preview: "-a\n+b" }],
      }],
      truncated: "This view omits 2 more changed files. Export the patch to see the whole diff, or apply the whole run.",
    });

    let html = harness.document.root.innerHTML;
    assert.match(html, /@@ -1 \+1 @@/u);
    assert.match(html, /This view omits 2 more changed files/u);

    const hunk = harness.document.root.querySelector('[data-action="result-hunk-select"][data-path="src/a.ts"][data-hunk="0"]');
    hunk.checked = true;
    harness.document.root.dispatch("change", { target: hunk });
    assert.match(harness.document.root.innerHTML, /1 hunk selected/u);

    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({ resultsByConversation: { "run-1": inconclusiveResult } }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    assert.match(
      harness.document.root.innerHTML,
      /1 hunk selected/u,
      "a live conversation lost its selection",
    );

    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        conversations: [{
          id: "run-2",
          runRef: "run-2",
          title: "Other run",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
          workflowStatus: "idle",
          iterationCount: 1,
          activeIteration: 1,
          unread: 0,
          archived: false,
        }],
        activeConversationId: "run-2",
        resultsByConversation: {},
      }),
    });
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({ resultsByConversation: { "run-1": inconclusiveResult } }),
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    html = harness.document.root.innerHTML;
    assert.doesNotMatch(html, /@@ -1 \+1 @@/u, "a removed conversation kept its diff payload");
    assert.doesNotMatch(html, /1 hunk selected/u, "a removed conversation kept its hunk selection");
    assert.match(html, /Select hunks/u);
  } finally {
    harness.restore();
  }
});

const retainedResult = (runId, changedFiles = ["src/a.ts"]) => ({
  ...inconclusiveResult,
  changedFiles,
  retainedRunId: runId,
  retainedWorktree: `/work/.bachata/runs/${runId}/integration`,
});

const loadDiff = (harness, runId, paths = ["src/a.ts"]) => {
  harness.sendWindowMessage({
    type: "manager.runDiff",
    conversationId: "run-1",
    runId,
    files: paths.map((path) => ({
      path,
      binary: false,
      renamed: false,
      modeChanged: false,
      wholeFileOnly: false,
      hunks: [{ index: 0, header: "@@ -1 +1 @@", added: 1, removed: 1, preview: "-a\n+b" }],
    })),
  });
};

const selectFirstHunk = (harness, path = "src/a.ts") => {
  const hunk = harness.document.root.querySelector(`[data-action="result-hunk-select"][data-path="${path}"][data-hunk="0"]`);
  assert.notEqual(hunk, null, `no hunk checkbox for ${path}`);
  hunk.checked = true;
  harness.document.root.dispatch("change", { target: hunk });
};

const showResult = (harness, result) => {
  harness.sendWindowMessage({
    type: "manager.snapshot",
    state: managerState({ resultsByConversation: { "run-1": result } }),
  });
  harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
};

test("a new retained run never inherits the previous run's selection", () => {
  const harness = bootWebview();
  try {
    showResult(harness, retainedResult("RUN-A"));
    loadDiff(harness, "RUN-A");
    selectFirstHunk(harness);
    assert.match(harness.document.root.innerHTML, /1 hunk selected/u);

    harness.document.root.querySelector('[data-action="orchestration-apply"]').click();
    assert.deepEqual(harness.messages.at(-1).hunks, [{ path: "src/a.ts", index: 0 }]);

    showResult(harness, retainedResult("RUN-B"));
    const html = harness.document.root.innerHTML;
    assert.doesNotMatch(html, /1 hunk selected/u, "the new run inherited the old hunk selection");
    assert.doesNotMatch(html, /@@ -1 \+1 @@/u, "the new run inherited the old diff");

    harness.document.root.querySelector('[data-action="orchestration-apply"]').click();
    const sent = harness.messages.at(-1);
    assert.equal(sent.runId, "RUN-B");
    assert.equal(sent.hunks, undefined, "a stale hunk selection was sent to a new run");
    assert.equal(sent.paths, undefined, "a stale path selection was sent to a new run");
  } finally {
    harness.restore();
  }
});

test("a path the current result no longer records is never sent", () => {
  const harness = bootWebview();
  try {
    showResult(harness, retainedResult("RUN-A", ["src/a.ts", "src/gone.ts"]));
    const file = harness.document.root.querySelector('[data-action="result-file-select"][data-path="src/gone.ts"]');
    file.checked = true;
    harness.document.root.dispatch("change", { target: file });
    harness.document.root.querySelector('[data-action="orchestration-patch"]').click();
    assert.deepEqual(harness.messages.at(-1).paths, ["src/gone.ts"]);

    showResult(harness, retainedResult("RUN-A", ["src/a.ts"]));
    harness.document.root.querySelector('[data-action="orchestration-patch"]').click();
    assert.equal(
      harness.messages.at(-1).paths,
      undefined,
      "a path missing from the current result was still sent",
    );
  } finally {
    harness.restore();
  }
});

test("archiving a conversation drops its cached diff and selection", () => {
  const harness = bootWebview();
  try {
    showResult(harness, retainedResult("RUN-A"));
    loadDiff(harness, "RUN-A");
    selectFirstHunk(harness);
    assert.match(harness.document.root.innerHTML, /1 hunk selected/u);

    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        conversations: [{
          id: "run-1",
          runRef: "run-1",
          title: "Test run",
          createdAt: "2026-08-05T00:00:00.000Z",
          updatedAt: "2026-08-05T00:00:00.000Z",
          workflowStatus: "completed",
          iterationCount: 1,
          activeIteration: 1,
          unread: 0,
          archived: true,
        }],
        resultsByConversation: { "run-1": retainedResult("RUN-A") },
      }),
    });
    showResult(harness, retainedResult("RUN-A"));

    const html = harness.document.root.innerHTML;
    assert.doesNotMatch(html, /@@ -1 \+1 @@/u, "an archived conversation kept its diff payload");
    assert.doesNotMatch(html, /1 hunk selected/u, "an archived conversation kept its selection");
  } finally {
    harness.restore();
  }
});

test("cached diffs are bounded across runs", () => {
  const harness = bootWebview();
  try {
    for (let index = 0; index < 12; index += 1) {
      const runId = `RUN-${String(index)}`;
      showResult(harness, retainedResult(runId));
      loadDiff(harness, runId);
    }
    showResult(harness, retainedResult("RUN-0"));
    assert.doesNotMatch(
      harness.document.root.innerHTML,
      /@@ -1 \+1 @@/u,
      "the oldest cached diff was retained past the bound",
    );
    showResult(harness, retainedResult("RUN-11"));
    assert.match(
      harness.document.root.innerHTML,
      /@@ -1 \+1 @@/u,
      "the newest cached diff was evicted",
    );
  } finally {
    harness.restore();
  }
});

test("Send stays refused while a readiness finding blocks the run", () => {
  const blocked = panelState({
    readiness: {
      status: "needsSetup",
      findings: [
        { id: "workspace", label: "Workspace", status: "ready", detail: "/workspace" },
        {
          id: "adapter.codex",
          label: "Codex",
          status: "needsSetup",
          detail: "codex unavailable: spawn codex ENOENT",
          remediationId: "provider.install.codex",
        },
      ],
    },
  });
  const harness = bootWebview(managerState(), blocked);
  try {
    const prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "Review the cancellation path";
    harness.document.root.dispatch("input", { target: prompt });
    const submit = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(
      submit.getAttribute("aria-disabled"),
      "true",
      "Send was offered as available while a provider readiness finding was unresolved",
    );
    assert.equal(submit.disabled, false, "a blocked Send is out of the tab order");
    const beforeSubmit = harness.messages.length;
    submit.click();
    assert.equal(
      harness.messages.length,
      beforeSubmit,
      "Send started a run while a provider readiness finding was unresolved",
    );
    assert.match(harness.document.root.innerHTML, /codex unavailable: spawn codex ENOENT/u);
  } finally {
    harness.restore();
  }
});

test("Send becomes available once every readiness finding is ready", () => {
  const ready = panelState({
    readiness: {
      status: "ready",
      findings: [
        { id: "workspace", label: "Workspace", status: "ready", detail: "/workspace" },
        { id: "adapter.codex", label: "Codex", status: "ready", detail: "codex 1.2.3" },
      ],
    },
  });
  const harness = bootWebview(managerState(), ready);
  try {
    const prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "Review the cancellation path";
    harness.document.root.dispatch("input", { target: prompt });
    // "Available" is only worth asserting if pressing it does something, so activation is what
    // is checked: the control carries no aria-disabled and dispatching it starts the run.
    const submit = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(submit.getAttribute("aria-disabled"), null);
    const beforeSubmit = harness.messages.length;
    submit.click();
    assert.equal(harness.messages.length, beforeSubmit + 1);
    assert.equal(harness.messages.at(-1).message.type, "pipeline.run");
  } finally {
    harness.restore();
  }
});

test("a diff larger than the panel cache bound is dropped instead of retained", () => {
  const harness = bootWebview();
  try {
    showResult(harness, retainedResult("RUN-BIG"));
    harness.sendWindowMessage({
      type: "manager.runDiff",
      conversationId: "run-1",
      runId: "RUN-BIG",
      files: [{
        path: "src/a.ts",
        binary: false,
        renamed: false,
        modeChanged: false,
        wholeFileOnly: false,
        hunks: [{
          index: 0,
          header: "@@ -1 +1 @@",
          added: 1,
          removed: 1,
          preview: "x".repeat(9 * 1_048_576),
        }],
      }],
    });
    showResult(harness, retainedResult("RUN-BIG"));
    const html = harness.document.root.innerHTML;
    assert.doesNotMatch(html, /xxxxxxxxxx/u, "an oversized diff stayed in the panel cache");
    assert.match(html, /larger than the panel keeps in memory/u);
  } finally {
    harness.restore();
  }
});

test("Ctrl+Enter cannot bypass the send blockers the button enforces", () => {
  const blocked = panelState({
    readiness: {
      status: "needsSetup",
      findings: [
        {
          id: "adapter.codex",
          label: "Codex",
          status: "needsSetup",
          detail: "codex unavailable: spawn codex ENOENT",
        },
      ],
    },
  });
  const harness = bootWebview(managerState(), blocked);
  try {
    const prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "Review the cancellation path";
    harness.document.root.dispatch("input", { target: prompt });
    harness.messages.length = 0;
    harness.document.root.dispatch("keydown", {
      key: "Enter",
      ctrlKey: true,
      target: prompt,
      preventDefault: () => undefined,
    });
    assert.equal(
      harness.messages.some((message) => message.message?.type === "pipeline.run"),
      false,
      "a keyboard submit started a run while a readiness finding blocked it",
    );
    assert.match(harness.document.root.innerHTML, /Bachata did not send this run/u);
  } finally {
    harness.restore();
  }
});

test("an unacknowledged contract cannot be submitted from the keyboard either", () => {
  const unacknowledged = panelState({
    contractAcknowledgement: {
      fingerprint: "abc",
      acknowledgementRequired: true,
      open: true,
      diff: { changes: [], expanded: false },
    },
  });
  const harness = bootWebview(managerState(), unacknowledged);
  try {
    const prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "Fix the retry";
    harness.document.root.dispatch("input", { target: prompt });
    harness.messages.length = 0;
    harness.document.root.dispatch("keydown", {
      key: "Enter",
      metaKey: true,
      target: prompt,
      preventDefault: () => undefined,
    });
    assert.equal(
      harness.messages.some((message) => message.message?.type === "pipeline.run"),
      false,
      "a keyboard submit started a run with an unacknowledged execution contract",
    );
  } finally {
    harness.restore();
  }
});

test("the attachment picker accepts text, log, and specification files, not images alone", () => {
  const harness = bootWebview();
  try {
    const accept = harness.document.getElementById("attachment-input").getAttribute("accept");
    ["text/plain", "text/markdown", "application/json", ".txt", ".log", ".md", ".json"].forEach((entry) => {
      assert.equal(accept.includes(entry), true, `the picker does not accept ${entry}`);
    });
    assert.match(
      harness.document.root.querySelector('[data-action="attachment-pick"]').getAttribute("aria-label"),
      /text, log, or specification/u,
    );
  } finally {
    harness.restore();
  }
});

test("a Markdown specification is accepted and typed, while an unsupported binary is refused", async () => {
  const harness = bootWebview();
  try {
    harness.messages.length = 0;
    const input = harness.document.getElementById("attachment-input");
    input.files = [
      { name: "retry-spec.md", type: "", size: 24, contents: "# Spec" },
      { name: "payload.bin", type: "application/octet-stream", size: 12, contents: "x" },
    ];
    harness.document.root.dispatch("change", { target: input });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const added = harness.messages.filter((message) => message.message?.type === "attachment.add");
    assert.deepEqual(
      added.map((message) => [message.message.name, message.message.mimeType]),
      [["retry-spec.md", "text/markdown"]],
      "the composer did not accept a Markdown specification, or accepted a binary payload",
    );
  } finally {
    harness.restore();
  }
});

const directionState = (overrides = {}) => ({
  initiative: {
    id: "N1",
    title: "Stabilize cancellation",
    goal: "Cancellation never leaks a worktree",
    desiredOutcome: "Every cancel path is proven",
    scope: ["src/orchestrator"],
    constraints: ["No new dependencies"],
    acceptanceCriteria: ["No leaked worktree after cancel"],
    currentDirection: "Guard the cleanup path in the controller",
    status: "active",
  },
  cycles: [{
    id: "Y1",
    sequence: 1,
    type: "review",
    completion: "open",
    runRefs: ["run-1"],
    repositoryBaseline: "abc1234",
  }],
  currentCycle: {
    id: "Y1",
    sequence: 1,
    type: "review",
    completion: "open",
    runRefs: ["run-1"],
  },
  artifacts: [],
  decisions: [],
  findings: [],
  saturation: { saturated: false, quietFreshReviews: 0, quietReviewSignal: 2, signalReached: false, reasons: ["1 core decisions are still open"] },
  direction: {
    goal: "Cancellation never leaks a worktree",
    desiredOutcome: "Every cancel path is proven",
    acceptedDirection: "Guard the cleanup path in the controller",
    acceptanceCriteria: ["No leaked worktree after cancel"],
    constraints: ["No new dependencies"],
    initiativeStatus: "active",
    currentCycle: { id: "Y1", sequence: 1, type: "review", completion: "open", runCount: 1 },
    latestChange: {
      cycleId: "Y1",
      newMaterial: [{
        identity: "FH1",
        subject: "Cancellation guard",
        message: "Cancellation bypasses cleanup",
        state: "accepted",
        location: { file: "src/a.ts", startLine: 12 },
        occurrences: 1,
        actionable: true,
        materialDelta: [],
        evidence: ["Both traced the bypass"],
        challenges: ["The finally block was inspected"],
      }],
      repeated: [],
      resolved: [],
      regressed: [{
        identity: "FH2",
        subject: "Worktree leak",
        message: "The worktree survives a cancel",
        state: "regressed",
        occurrences: 3,
        actionable: false,
        materialDelta: ["A reproducing test now exists"],
        evidence: [],
        challenges: [],
      }],
      reopened: [],
      outstandingAccepted: [],
      decisionChanges: [{ decisionId: "D1", subject: "Cancellation ownership", from: "proposed", to: "accepted" }],
    },
    acceptedArtifacts: [{
      id: "T1",
      title: "Ruled findings · cycle 1",
      body: "accepted · Cancellation guard (src/a.ts)",
      type: "findingSet",
      revision: 1,
      state: "accepted",
    }],
    proposedArtifacts: [{
      id: "T2",
      title: "Ruled findings · cycle 1",
      body: "unresolved · Worktree leak",
      type: "findingSet",
      revision: 2,
      state: "proposed",
    }],
    decisionsNeedingHuman: [{
      id: "D2",
      subject: "Retry policy",
      question: "Should cancelled runs retry automatically?",
      state: "proposed",
      tradeOffs: ["Automatic retries hide flakiness"],
      evidence: ["Both providers disagreed"],
      affectedScope: ["src/orchestrator"],
      materialEvidenceDelta: [],
    }],
    findingsNeedingRuling: [{
      identity: "FH3",
      subject: "Retry loop",
      message: "The retry loop never terminates",
      state: "unresolved",
      occurrences: 1,
      actionable: false,
      materialDelta: [],
      evidence: [],
      challenges: ["The loop bound was traced"],
    }],
    outstandingAcceptedFindings: [{
      identity: "FH1",
      subject: "Cancellation guard",
      message: "Cancellation bypasses cleanup",
      state: "accepted",
      occurrences: 1,
      actionable: true,
      fixState: "awaitingFix",
      materialDelta: [],
      evidence: [],
      challenges: [],
      humanResolution: { action: "accept", resolvedBy: "human", resolvedAt: "2026-01-01T00:00:00.000Z" },
    }],
    unresolvedFindings: [],
    baselineDrift: ["the working tree changed since this cycle was baselined"],
    baseline: {
      commit: "1111111111111111111111111111111111111111",
      branch: "main",
      dirty: false,
      worktreeDigest: "WT1",
      capturedAt: "2026-01-01T00:00:00.000Z",
    },
    verification: {
      runRef: "run-1",
      checks: [{ command: "npm test", status: "passed" }],
      expected: true,
      recordedAt: "2026-01-01T00:00:00.000Z",
    },
    saturation: { saturated: false, quietFreshReviews: 0, quietReviewSignal: 2, signalReached: false, reasons: ["1 core decisions are still open"] },
    saturationDisclaimer: "Saturation means repeated fresh review stopped producing material findings. It is not a correctness proof.",
    nextAction: {
      kind: "resolveDecisions",
      label: "Resolve 1 decision",
      detail: "Retry policy",
      command: { type: "focusDirection", section: "decisions" },
    },
  },
  initiatives: [
    { id: "N1", title: "Stabilize cancellation", goal: "g", status: "active", updatedAt: "t" },
    { id: "N2", title: "Second initiative", goal: "g2", status: "paused", updatedAt: "t" },
  ],
  findingAliases: [{
    aliasIdentity: "FH9",
    canonicalIdentity: "FH1",
    reason: "Same skipped cleanup",
    createdBy: "human",
    createdAt: "2026-01-01T00:00:00.000Z",
  }],
  fixRuns: [],
  ...overrides,
});

test("the direction surface answers the top-level questions without a transcript", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const html = harness.document.root.innerHTML;
    for (const marker of [
      "What are we trying to achieve?",
      "What direction is accepted?",
      "What materially changed in the latest round?",
      "Which artifacts are accepted?",
      "Which decisions require human judgment?",
      "Which findings need human judgment?",
      "Which accepted findings still need a fix?",
      "Cancellation never leaks a worktree",
      "Guard the cleanup path in the controller",
      "Resolve 1 decision",
      "Regressions",
      "New material findings",
      "Retry policy",
      "not a correctness proof",
    ]) {
      assert.ok(html.includes(marker), `direction surface is missing: ${marker}`);
    }
    assert.equal(html.includes("conversation-scroll"), true);
  } finally {
    harness.restore();
  }
});

test("every run view states the goal, the pending human judgment, and the next action", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("direction-banner"));
    assert.ok(html.includes("Cancellation never leaks a worktree"));
    assert.ok(html.includes("1 decision for you"));
    assert.ok(html.includes("1 accepted finding outstanding"));
    assert.ok(html.includes("Resolve 1 decision"));
  } finally {
    harness.restore();
  }
});

test("the direction surface sends initiative, cycle, fresh review, and resolution intents", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    harness.messages.length = 0;

    harness.document.root.querySelector('[data-action="review-fresh"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "review.startFresh", cycleType: "review" });

    harness.document.root.querySelector('[data-action="cycle-close"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "cycle.close" });

    harness.document.getElementById("initiative-direction").value = "Ship the controller guard";
    harness.document.root.querySelector('[data-action="initiative-direction-save"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "initiative.setDirection",
      direction: "Ship the controller guard",
    });

    harness.document.root
      .querySelector('[data-action="resolve-record"][data-target="decision"][data-resolution="accept"]')
      .click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "resolution.apply",
      target: "decision",
      id: "D2",
      action: "accept",
    });
  } finally {
    harness.restore();
  }
});

test("the direction surface states the candidate, its drift, and the recorded checks", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const html = harness.document.root.innerHTML;
    for (const marker of [
      "Which repository state is this cycle about?",
      "main@111111111111",
      "the working tree changed since this cycle was baselined",
      "npm test",
      "Which initiative is this?",
      "Which findings are folded together?",
      "Same skipped cleanup",
      "Pipeline accepted; no fix has started",
    ]) {
      assert.ok(html.includes(marker), `direction surface is missing: ${marker}`);
    }
  } finally {
    harness.restore();
  }
});

test("the direction surface sends candidate, fix, merge, and initiative intents", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    harness.messages.length = 0;

    harness.document.root.querySelector('[data-action="cycle-rebaseline"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "cycle.rebaseline" });

    harness.document.root.querySelector('[data-action="direction-next-action"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "direction.runNextAction" });

    harness.document.root
      .querySelector('[data-action="finding-start-fix"][data-record="FH1"]')
      .click();
    assert.deepEqual(harness.messages.at(-1), { type: "finding.startFix", identity: "FH1" });
    assert.equal(
      harness.document.root.querySelector(
        '[data-action="resolve-record"][data-target="finding"][data-record="FH1"][data-resolution="accept"]',
      ),
      null,
      "a pipeline-accepted routine finding still asked for redundant human acceptance",
    );
    assert.equal(harness.document.root.innerHTML.includes("waiting on your ruling"), false);

    harness.document.root.querySelector('[data-action="finding-unmerge"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "finding.unmerge", aliasIdentity: "FH9" });

    harness.document.getElementById("initiative-switch").value = "N2";
    harness.document.root.querySelector('[data-action="initiative-switch"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "initiative.switch", initiativeId: "N2" });

    harness.document.getElementById("initiative-status").value = "paused";
    harness.document.root.querySelector('[data-action="initiative-status"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "initiative.setStatus",
      initiativeId: "N1",
      status: "paused",
    });

    harness.document.root.querySelector('[data-action="initiative-import"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "initiative.import" });
  } finally {
    harness.restore();
  }
});

test("merging a finding collects a target and a reason before it is sent", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    harness.messages.length = 0;

    harness.document.root
      .querySelector('[data-action="finding-merge"][data-record="FH1"]')
      .click();
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(
      harness.messages.some((message) => message.type === "finding.merge"),
      false,
      "a merge was sent without a target",
    );

    harness.document.getElementById("app-dialog-input").value = "FH1";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(
      harness.messages.some((message) => message.type === "finding.merge"),
      false,
      "a finding was merged into itself",
    );

    harness.document.getElementById("app-dialog-input").value = "FH2";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(
      harness.messages.some((message) => message.type === "finding.merge"),
      false,
      "a merge was sent with no reason",
    );

    harness.document.getElementById("app-dialog-delta").value = "Same defect, different wording";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "finding.merge",
      absorbedIdentity: "FH1",
      canonicalIdentity: "FH2",
      reason: "Same defect, different wording",
    });
  } finally {
    harness.restore();
  }
});

test("reopening a finding collects a reason and a material evidence delta before it is sent", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    harness.messages.length = 0;
    harness.document.root
      .querySelector('[data-action="resolve-record"][data-target="finding"][data-record="FH1"][data-resolution="reopen"]')
      .click();
    assert.equal(harness.messages.length, 0);
    const input = harness.document.getElementById("app-dialog-input");
    const delta = harness.document.getElementById("app-dialog-delta");
    assert.ok(input);
    assert.ok(delta);

    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(harness.messages.length, 0, "an empty reason must not be sent");

    input.value = "The bypass returned";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(harness.messages.length, 0, "an empty material evidence delta must not be sent");

    delta.value = "A reproducing test now exists\n\n";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "resolution.apply",
      target: "finding",
      id: "FH1",
      action: "reopen",
      reason: "The bypass returned",
      materialEvidenceDelta: ["A reproducing test now exists"],
    });
  } finally {
    harness.restore();
  }
});

test("the lifecycle matrix decides which resolutions a record offers", () => {
  const matrix = {
    finding: { accepted: ["reject", "defer"], resolved: ["reopen"] },
    decision: { proposed: ["accept", "reject", "defer", "supersede"], superseded: [] },
    artifact: { proposed: ["accept"], superseded: [] },
  };
  const harness = bootWebview(managerState({
    direction: directionState({
      resolutionMatrix: matrix,
      artifacts: [
        {
          id: "T1",
          title: "Ruled findings",
          type: "findingSet",
          revision: 1,
          state: "superseded",
        },
        {
          id: "T2",
          title: "Ruled findings",
          type: "findingSet",
          revision: 2,
          state: "proposed",
        },
      ],
    }),
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const actionsFor = (record) =>
      Array.from(
        harness.document.root.querySelectorAll(`[data-action="resolve-record"][data-record="${record}"]`),
      ).map((button) => button.getAttribute("data-resolution"));
    assert.deepEqual(actionsFor("T1"), [], "a superseded artifact still offered resolutions");
    assert.deepEqual(Array.from(new Set(actionsFor("T2"))), ["accept"]);
    assert.deepEqual(actionsFor("D2"), ["accept", "reject", "defer", "supersede"]);
    assert.deepEqual(
      actionsFor("FH1").includes("reopen"),
      false,
      "an accepted finding offered a reopen",
    );
  } finally {
    harness.restore();
  }
});

test("the direction surface states longitudinal failures instead of hiding them", () => {
  const harness = bootWebview(managerState({
    direction: directionState({
      validationErrors: ["Decision 2 has no evidence", "The review round for R1 was not recorded"],
    }),
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("Bachata could not record some longitudinal state"), html.slice(0, 400));
    assert.ok(html.includes("Decision 2 has no evidence"));
    assert.ok(html.includes("The review round for R1 was not recorded"));
  } finally {
    harness.restore();
  }
});

test("superseding a record requires an explicit replacement that is not itself", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    harness.messages.length = 0;
    harness.document.root
      .querySelector('[data-action="resolve-record"][data-target="decision"][data-resolution="supersede"]')
      .click();
    const input = harness.document.getElementById("app-dialog-input");
    assert.ok(input, "supersede must be reachable from the direction surface");

    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(harness.messages.length, 0, "an empty replacement must not be sent");

    input.value = "D2";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(harness.messages.length, 0, "a record must not supersede itself");

    input.value = "D9";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "resolution.apply",
      target: "decision",
      id: "D2",
      action: "supersede",
      supersededById: "D9",
    });
  } finally {
    harness.restore();
  }
});

test("no direction state hides the Direction tab and the Direction banner", () => {
  // A banner reading "No goal is recorded · No accepted direction · 0 decisions for you · 0
  // accepted findings outstanding" is four ways of saying nothing, and a tab beside it leads to a
  // page that says the same. Neither is offered before there is direction to show.
  const harness = bootWebview();
  try {
    const html = harness.document.root.innerHTML;
    assert.equal(html.includes(">Direction<"), false, "the Direction tab is still offered");
    assert.equal(html.includes("direction-banner"), false);
    assert.equal(html.includes("No goal is recorded"), false);
    // Defining an initiative is only reachable in that view, so the route survives in the room's
    // overflow menu: this is disclosure, not removal.
    assert.ok(html.includes(">Open direction<"), "the Direction route was removed, not disclosed");
  } finally {
    harness.restore();
  }
});

test("the direction surface degrades safely when a cycle exists but nothing is recorded", () => {
  const base = directionState();
  const harness = bootWebview(managerState({
    direction: {
      ...base,
      direction: {
        ...base.direction,
        goal: undefined,
        desiredOutcome: undefined,
        acceptedDirection: undefined,
        decisionsNeedingHuman: [...base.direction.decisionsNeedingHuman],
      },
    },
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("No goal is recorded"));
    assert.ok(html.includes(base.direction.nextAction.label));
  } finally {
    harness.restore();
  }
});

test("the notification bell shows an unread count and the newest line inline", () => {
  const harness = bootWebview(managerState({
    notifications: {
      mode: "material",
      unread: 2,
      events: [
        {
          id: "converged:Y1:3-1-0-1",
          kind: "findingsConverged",
          level: "material",
          text: "Review converged: 3 resolved, 1 new, 0 regressed, 1 needs you.",
          action: "inspect",
          recordedAt: "2026-01-01T00:00:00.000Z",
          read: false,
        },
        {
          id: "retained-run:run-1:/tmp/wt",
          kind: "retainedWorkAvailable",
          level: "routine",
          text: "Managed fix kept its work in a retained worktree. Inspect, apply, or discard it.",
          action: "discard",
          recordedAt: "2026-01-01T00:00:00.000Z",
          read: true,
        },
      ],
    },
  }));
  try {
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("notification-center"), "the bell control is rendered");
    assert.ok(html.includes("notification-unread"));
    assert.ok(html.includes("Review converged: 3 resolved, 1 new, 0 regressed, 1 needs you."));
    assert.ok(html.includes("notification-bubble"), "the newest unread line appears inline");
    assert.ok(html.includes(">Discard<"), "Bachata owns that retained worktree");
    assert.ok(html.includes("never enter a reviewer prompt"));

    harness.messages.length = 0;
    harness.document.root
      .querySelector('[data-action="notification-open"][data-record="converged:Y1:3-1-0-1"]')
      .click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "notifications.open",
      id: "converged:Y1:3-1-0-1",
    });

    harness.document.root.querySelector('[data-action="notification-read-all"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "notifications.markAllRead" });

    const mode = harness.document.getElementById("notification-mode");
    mode.value = "off";
    harness.document.root.dispatch("change", { target: mode });
    assert.deepEqual(harness.messages.at(-1), { type: "notifications.setMode", mode: "off" });
  } finally {
    harness.restore();
  }
});

test("notifications turned off render no bell badge and no inline bubble", () => {
  const harness = bootWebview(managerState({
    notifications: { mode: "off", unread: 0, events: [] },
  }));
  try {
    const html = harness.document.root.innerHTML;
    assert.equal(html.includes("notification-unread"), false);
    assert.equal(html.includes("notification-bubble"), false);
    // An empty bell is not rendered at all, and the setting that turned it off stays reachable in
    // the room's overflow menu, so hiding it is disclosure and not removal.
    assert.equal(html.includes("notification-center"), false);
    assert.ok(harness.document.getElementById("notification-mode") !== null);
  } finally {
    harness.restore();
  }
});

test("the direction surface reports the quiet-review fact and keeps close available", () => {
  const direction = directionState();
  const harness = bootWebview(managerState({
    direction: {
      ...direction,
      saturation: {
        saturated: false,
        quietFreshReviews: 1,
        quietReviewSignal: 2,
        signalReached: false,
        reasons: ["1 of 2 consecutive fresh reviews found no material change"],
      },
      direction: {
        ...direction.direction,
        saturation: {
          saturated: false,
          quietFreshReviews: 1,
          quietReviewSignal: 2,
          signalReached: false,
          reasons: ["1 of 2 consecutive fresh reviews found no material change"],
        },
        quietReviewStatement:
          "One of 2 consecutive fresh reviews found no material change. Continue or close the cycle.",
        closeCycleAvailable: true,
      },
    },
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("One of 2 consecutive fresh reviews found no material change."));
    assert.ok(html.includes("Continue or close the cycle."));
    assert.equal(/\bneeded\b/u.test(html), false, "Bachata never says more reviews are needed");
    const close = harness.document.root.querySelector('[data-action="cycle-close"]');
    assert.equal(close.disabled, false, "the human can close the cycle before the signal");
  } finally {
    harness.restore();
  }
});

test("only ambiguous finding mappings ask the human, and they offer the candidate merge", () => {
  const direction = directionState();
  const harness = bootWebview(managerState({
    direction: {
      ...direction,
      direction: {
        ...direction.direction,
        reconciliationQuestions: [{
          freshIdentity: "FH77",
          subject: "Unbounded retry loop in the worker",
          kind: "ambiguous",
          detail: "This description matches more than one tracked finding equally well.",
          candidates: [
            { identity: "FH11", subject: "Unbounded retry loop in the worker queue", score: 100 },
            { identity: "FH12", subject: "Unbounded retry loop in the worker poller", score: 95 },
          ],
        }],
      },
    },
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("Which findings need an identity decision?"));
    assert.ok(html.includes("Ambiguous match"));
    assert.ok(html.includes("Bachata merged every clear match on its own."));
    assert.ok(html.includes("Leaving them separate is a valid answer."));

    harness.messages.length = 0;
    harness.document.root
      .querySelector('[data-action="finding-merge"][data-candidate="FH11"]')
      .click();
    assert.equal(harness.document.getElementById("app-dialog-input").value, "FH11");
  } finally {
    harness.restore();
  }
});

test("the execution view states where provider history lives and whether it can be rebuilt", () => {
  const harness = bootWebview(managerState({
    conversationLocators: {
      "run-1": [
        {
          chatRef: "C1",
          agentId: "lead",
          role: "Lead",
          provider: "claude-code",
          adapter: "claude-code",
          providerSessionId: "session-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-02T00:00:00.000Z",
          reconstruction: "available",
          reconstructionDetail:
            "Bachata can resume this provider session and the provider still owns the full history.",
        },
        {
          chatRef: "C2",
          agentId: "worker",
          role: "Worker",
          provider: "chatgpt",
          adapter: "chatgpt-browser",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastSeenAt: "2026-01-02T00:00:00.000Z",
          reconstruction: "unavailable",
          reconstructionDetail:
            "Bachata recorded no provider conversation locator, so the provider history cannot be reconstructed.",
        },
      ],
    },
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("provider history live?"));
    assert.ok(html.includes("history reconstructable"));
    assert.ok(html.includes("history unavailable"));
    assert.ok(html.includes("It never stores a full provider transcript"));
  } finally {
    harness.restore();
  }
});

test("the banner states the specific next action and the direction centre labels its button with the concrete verb", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="chat"]').click();
    assert.ok(
      harness.document.root.innerHTML.includes('data-action="direction-next-action">Resolve 1 decision</button>'),
      "the direction banner no longer states the specific next action",
    );
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const centre = harness.document.root.innerHTML;
    assert.ok(
      centre.includes('data-action="direction-next-action">Resolve decisions</button>'),
      "the direction centre does not label the next action with a concrete verb",
    );
    assert.ok(
      !centre.includes('data-action="direction-next-action">Do it</button>'),
      "the generic next action label is still rendered",
    );
  } finally {
    harness.restore();
  }
});

test("resolved, rejected and superseded records stay reachable in history", () => {
  const harness = bootWebview(managerState({
    direction: directionState({
      direction: {
        ...directionState().direction,
        decisionHistory: [
          {
            id: "D1",
            revision: 2,
            subject: "Retry ownership",
            question: "Who owns the retry budget?",
            state: "accepted",
            recommendation: "The caller owns it",
            tradeOffs: ["Callers must pass a budget"],
            evidence: ["Both traced the unbounded loop"],
            affectedScope: ["src/retry.ts"],
            materialEvidenceDelta: [],
            options: ["Caller owns it", "Helper owns it"],
            producedByRunRef: "run-1",
            supersedesId: "D0",
            humanResolution: { action: "accept", resolvedBy: "human", reason: "Matches the goal" },
            resolutionHistory: [{ action: "defer", resolvedBy: "human", reason: "Needed evidence" }],
          },
          {
            id: "D2",
            subject: "Vendor the parser",
            question: "Should the parser be vendored?",
            state: "rejected",
            tradeOffs: [],
            evidence: [],
            affectedScope: [],
            materialEvidenceDelta: [],
            supersededById: "D3",
          },
        ],
        findingHistory: [{
          identity: "FH1",
          subject: "Cancellation guard",
          message: "Cancellation bypasses cleanup",
          state: "resolved",
          fixState: "verified",
          occurrences: 3,
          actionable: false,
          materialDelta: [],
          evidence: ["Fresh review did not report this finding after its fix was applied"],
          challenges: ["The finally block was inspected"],
          firstCycleId: "Y1",
          lastCycleId: "Y2",
          lastRunRef: "run-1",
          location: { file: "src/a.ts", startLine: 12 },
          humanResolution: { action: "accept", resolvedBy: "human" },
        }],
      },
    }),
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const html = harness.document.root.innerHTML;
    for (const marker of [
      "History",
      "Retry ownership",
      "Vendor the parser",
      "Cancellation guard",
      "superseded by D3",
      "supersedes D0",
      "revision 2",
      "Caller owns it",
      "Needed evidence",
      "did not report this finding",
      "Open the run that produced this",
    ]) {
      assert.ok(html.includes(marker), `history did not render ${marker}`);
    }
  } finally {
    harness.restore();
  }
});

test("a history record opens the run that produced it and the file it names", () => {
  const harness = bootWebview(managerState({
    direction: directionState({
      direction: {
        ...directionState().direction,
        decisionHistory: [],
        findingHistory: [{
          identity: "FH1",
          subject: "Cancellation guard",
          message: "Cancellation bypasses cleanup",
          state: "resolved",
          occurrences: 1,
          actionable: false,
          materialDelta: [],
          evidence: [],
          challenges: [],
          lastRunRef: "run-1",
          location: { file: "src/a.ts", startLine: 12 },
        }],
      },
    }),
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    harness.document.root.querySelector('[data-action="open-producing-run"]').click();
    assert.deepEqual(
      harness.messages.filter((message) => message.type === "history.openRun"),
      [{ type: "history.openRun", runRef: "run-1" }],
    );
    harness.document.root.querySelector('[data-action="reveal-finding"]').click();
    assert.ok(
      harness.messages.some((message) =>
        message.type === "conversation.revealFile" && message.path === "src/a.ts"),
      "a history record did not open the file it names",
    );
  } finally {
    harness.restore();
  }
});

test("history filtering narrows the semantic record without losing it", () => {
  const harness = bootWebview(managerState({
    direction: directionState({
      direction: {
        ...directionState().direction,
        decisionHistory: [],
        findingHistory: [
          {
            identity: "FH1", subject: "Cancellation guard", message: "bypasses cleanup",
            state: "resolved", occurrences: 1, actionable: false, materialDelta: [],
            evidence: [], challenges: [],
          },
          {
            identity: "FH2", subject: "Retry budget", message: "unbounded loop",
            state: "rejected", occurrences: 1, actionable: false, materialDelta: [],
            evidence: [], challenges: [],
          },
        ],
      },
    }),
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    assert.ok(harness.document.root.innerHTML.includes("Retry budget"));
    const filter = harness.document.root.querySelector("#history-filter");
    filter.value = "cancellation";
    harness.document.root.dispatch("input", { target: filter });
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("Cancellation guard"), "the filter hid the record it matched");
    assert.ok(!html.includes("Retry budget"), "the filter kept a record it did not match");
  } finally {
    harness.restore();
  }
});

test("a surfaced judgment carries what it rests on, or says nothing was supplied", () => {
  const base = directionState();
  const harness = bootWebview(managerState({
    direction: directionState({
      direction: {
        ...base.direction,
        decisionsNeedingHuman: [{
          id: "D1",
          subject: "Retry ownership",
          question: "Who owns the retry budget?",
          state: "proposed",
          tradeOffs: ["Callers must pass a budget"],
          evidence: ["Both traced the unbounded loop"],
          affectedScope: ["src/retry.ts"],
          materialEvidenceDelta: [],
          options: ["Caller owns it", "Helper owns it"],
          producedByRunRef: "run-1",
        }],
        outstandingAcceptedFindings: [{
          identity: "FH2",
          subject: "Unbounded retry",
          message: "retry never stops",
          state: "accepted",
          occurrences: 1,
          actionable: true,
          materialDelta: [],
          evidence: ["Traced to src/retry.ts:23"],
          challenges: ["The bound was checked twice"],
          lastRunRef: "run-1",
        }],
      },
    }),
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const html = harness.document.root.innerHTML;
    for (const marker of [
      "Options (2)",
      "Caller owns it",
      "Evidence (1)",
      "Both traced the unbounded loop",
      "Challenges (1)",
      "Traced to src/retry.ts:23",
      "Open the run that produced this",
    ]) {
      assert.ok(html.includes(marker), `a judgment card is missing: ${marker}`);
    }
  } finally {
    harness.restore();
  }
});

test("a judgment with nothing supplied says so instead of looking complete", () => {
  const base = directionState();
  const harness = bootWebview(managerState({
    direction: directionState({
      direction: {
        ...base.direction,
        decisionsNeedingHuman: [{
          id: "D1",
          subject: "Bare decision",
          question: "What should happen?",
          state: "proposed",
          tradeOffs: [],
          evidence: [],
          affectedScope: [],
          materialEvidenceDelta: [],
        }],
      },
    }),
  }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("No recommendation was supplied."));
    assert.ok(html.includes("No options were supplied."));
    assert.ok(html.includes("No evidence was supplied."));
    assert.ok(html.includes("No affected scope was recorded."));
  } finally {
    harness.restore();
  }
});

test("banners that did not change are re-inserted without being announced again", () => {
  const approval = {
    agentId: "lead",
    requestId: "approval-1",
    kind: "command",
    command: "npm test",
    choices: [{ id: "allow", label: "Allow" }],
  };
  const panel = panelState({ approvals: [approval] });
  const harness = bootWebview(
    managerState({
      readOnly: {
        owned: false,
        reason: "Another Bachata Extension Host owns this workspace.",
        retryCommand: "Bachata: Workspace Ownership",
      },
      notifications: {
        mode: "material",
        unread: 1,
        events: [{
          id: "converged:Y1",
          kind: "findingsConverged",
          level: "material",
          text: "Review converged: 1 needs you.",
          action: "inspect",
          recordedAt: "2026-01-01T00:00:00.000Z",
          read: false,
        }],
      },
    }),
    panel,
  );
  try {
    // A region is silenced only once it has already been read out: the blocking banner arrives
    // with the panel snapshot, and that render carries no aria-live override.
    const first = harness.document.root.innerHTML;
    assert.match(first, /class="blocking-workflow-banner" role="status">/u);
    assert.match(first, /class="read-only-banner"/u);
    assert.match(first, /class="notification-bubble"/u);

    // render() replaces the whole tree, so an unrelated snapshot re-inserts all three and a
    // screen reader reads them out again. Each keeps its role — it is still a status region in
    // the accessibility tree — and says with aria-live="off" that this insertion carries nothing
    // new.
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "state.snapshot", state: panel },
    });
    const second = harness.document.root.innerHTML;
    assert.match(second, /class="read-only-banner" role="status" aria-live="off" data-read-only-banner/u);
    assert.match(second, /class="blocking-workflow-banner" role="status" aria-live="off">/u);
    assert.match(second, /class="notification-bubble" role="status" aria-live="off">/u);
  } finally {
    harness.restore();
  }
});

test("a read-only window renders the product with every mutating control disabled", () => {
  const harness = bootWebview(managerState({
    readOnly: {
      owned: false,
      reason: "Another Bachata Extension Host owns this workspace.",
      holderDescription: "pid 4242 on MacBook",
      holderLastSeenSecondsAgo: 12,
      retryCommand: "Bachata: Workspace Ownership",
    },
  }));
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /read-only-banner/u, "the panel does not say it is read-only");
    assert.match(html, /pid 4242 on MacBook/u, "the banner does not name the window that owns the state");
    assert.match(html, /Workspace Ownership/u, "the banner does not say how to take ownership");
    assert.match(html, /active 12s ago/u);

    const submit = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.ok(submit, "the composer is not rendered at all in a read-only window");
    // A read-only window's controls cannot be activated, and are still reachable: `disabled`
    // would take them out of the tab order and hide the title, so a keyboard reader could never
    // find out why the panel will not act. The refusal is asserted by dispatching the control and
    // seeing nothing leave the panel; the reason travels with the control.
    assert.equal(submit.getAttribute("aria-disabled"), "true", "the run control is not marked unavailable in a read-only window");
    assert.equal(submit.disabled, false, "a read-only window's run control is out of the tab order");
    const beforeSubmit = harness.messages.length;
    submit.click();
    assert.equal(harness.messages.length, beforeSubmit, "a read-only window let the run control send");
    assert.match(submit.title, /owns this repository's state/u, "a disabled control does not explain itself");
    assert.match(
      submit.getAttribute("aria-describedby") ?? "",
      /read-only-explanation/u,
      "the reason the control is dead is not attached to it",
    );

    const prompt = harness.document.getElementById("composer-prompt");
    assert.equal(prompt.getAttribute("aria-disabled"), "true", "the prompt is not marked unavailable in a read-only window");
    assert.equal(prompt.readOnly, true, "the prompt is still editable in a read-only window");
    assert.equal(prompt.disabled, false, "a read-only window's prompt is out of the tab order");

    // Navigating and reading stay live: they change nothing the writer owns.
    const navigation = harness.document.root.querySelector('[data-action="room-view"]');
    if (navigation) {
      assert.equal(navigation.disabled, false, "a read-only window disabled navigation");
    }
  } finally {
    harness.restore();
  }
});

test("restored drafts fill an untouched run and never replace one typed in this session", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.restoreState",
      state: { drafts: { "run-1": "Restored from the host" } },
    });
    assert.match(
      harness.document.root.innerHTML,
      /Restored from the host/u,
      "a draft the host kept was not put back into a run this window had not typed into",
    );

    const prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "Typed in this session";
    harness.document.root.dispatch("input", { target: prompt });
    harness.sendWindowMessage({
      type: "manager.restoreState",
      state: { drafts: { "run-1": "The host's older copy" } },
    });
    // Nothing was restored, so nothing re-rendered; the snapshot is what draws the composer again.
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });

    assert.match(
      harness.document.root.innerHTML,
      /Typed in this session/u,
      "a restored draft replaced text the reader had already typed in this session",
    );
    assert.doesNotMatch(harness.document.root.innerHTML, /The host's older copy/u);
  } finally {
    harness.restore();
  }
});

test("a window that owns the workspace renders no read-only banner and no disabled sweep", () => {
  const harness = bootWebview();
  try {
    assert.doesNotMatch(harness.document.root.innerHTML, /read-only-banner/u);
    const submit = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.ok(submit);
    // aria-disabled on Send now also means "the composer has its own blockers", so on its own it
    // no longer distinguishes a swept window. What only the sweep leaves is the ownership
    // explanation attached to every mutating control — and a mutating control that has no reason
    // of its own is left completely untouched.
    assert.doesNotMatch(submit.getAttribute("aria-describedby") ?? "", /read-only-explanation/u);
    assert.doesNotMatch(String(submit.title ?? ""), /owns this repository's state/u);
    const attach = harness.document.root.querySelector('[data-action="attachment-pick"]');
    assert.ok(attach);
    assert.equal(attach.disabled, false);
    assert.equal(attach.getAttribute("aria-disabled"), null);
  } finally {
    harness.restore();
  }
});

// EX-4 and EX-8. Both inputs below are chosen by whatever the agent emitted, so neither may
// reach a prototype value or recurse once per character.
test("a fence language cannot reach a prototype value", () => {
  const harness = bootWebview();
  for (const language of ["constructor", "__proto__", "toString", "valueOf"]) {
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "state.snapshot",
        state: panelState({
          transcriptTotal: 1,
          transcript: [{ id: "m1", kind: "answer", agentId: "worker", text: "```" + language + "\ncode\n```", createdAt: timestamp }],
        }),
      },
    });
    const html = document.getElementById("root").innerHTML;
    assert.equal(
      /\[native code\]|\[object Object\]/u.test(html),
      false,
      `a ${language} fence language rendered a prototype value`,
    );
    // normalizeLanguage lowercases before lookup, so the class carries the lowercased name.
    assert.equal(
      html.includes(`language-${language.toLowerCase()}`),
      true,
      `the ${language} fence lost its own name`,
    );
  }
});

test("deeply nested quotes render instead of overflowing the stack", () => {
  const harness = bootWebview();
  for (const depth of [4, 64, 20_000]) {
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "state.snapshot",
        state: panelState({
          transcriptTotal: 1,
          transcript: [{ id: "m1", kind: "answer", agentId: "worker", text: `${">".repeat(depth)} deep`, createdAt: timestamp }],
        }),
      },
    });
    const html = document.getElementById("root").innerHTML;
    assert.equal(html.includes("render-failure"), false, `depth ${String(depth)} dropped the panel into its failure banner`);
    assert.equal(html.includes("<blockquote>"), true, `depth ${String(depth)} rendered no quote at all`);
  }
});

test("a captured asset discloses its linked source origin before the save action", () => {
  const capturedAsset = (overrides) => ({
    id: "asset-1",
    provider: "chatgpt",
    kind: "generatedFile",
    name: "report.txt",
    sourceElement: "assistantMessage",
    downloadAvailable: true,
    ...overrides,
  });
  const assetSectionHtml = (harness, assets) => {
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "state.snapshot",
        state: panelState({
          transcriptTotal: 1,
          transcript: [
            {
              id: "m1",
              kind: "answer",
              agentId: "worker",
              eventType: "browser.response",
              text: "Here is the report.",
              createdAt: timestamp,
              data: { assets },
            },
          ],
        }),
      },
    });
    const html = document.getElementById("root").innerHTML;
    const start = html.indexOf('class="browser-assets"');
    assert.notEqual(start, -1);
    return html.slice(start, html.indexOf("</section>", start));
  };

  const harness = bootWebview();
  try {
    const disclosed = assetSectionHtml(harness, [
      capturedAsset({ sourceOrigin: "https://cdn.example.invalid:8443" }),
    ]);
    assert.match(disclosed, /Source link: https:\/\/cdn\.example\.invalid:8443/u);
    assert.ok(
      disclosed.indexOf("Source link:") <
        disclosed.indexOf('data-action="browser-asset-save"'),
    );

    const withoutOrigin = assetSectionHtml(harness, [capturedAsset()]);
    assert.doesNotMatch(withoutOrigin, /Source link/u);
    assert.doesNotMatch(withoutOrigin, /chatgpt\.com/u);

    const fullUrl = assetSectionHtml(harness, [
      capturedAsset({
        sourceOrigin: "https://cdn.example.invalid/download/report.txt?token=secret#part",
      }),
    ]);
    assert.doesNotMatch(fullUrl, /Source link/u);
    assert.doesNotMatch(fullUrl, /token=secret/u);

    for (const rejected of [
      "https://evil.invalid<script>",
      "javascript://evil",
      "https://user:secret@cdn.example.invalid",
      "https://cdn.example.invalid:443",
      "https://cdn.example.invalid ",
    ]) {
      const dropped = assetSectionHtml(harness, [
        capturedAsset({ sourceOrigin: rejected }),
      ]);
      assert.doesNotMatch(dropped, /Source link/u, rejected);
      assert.doesNotMatch(dropped, /script/u, rejected);
      assert.doesNotMatch(dropped, /evil\.invalid/u, rejected);
      assert.doesNotMatch(dropped, /secret/u, rejected);
    }

    for (const accepted of [
      "http://localhost:8443",
      "https://[::1]",
      "https://xn--80ak6aa92e.com",
    ]) {
      const shown = assetSectionHtml(harness, [
        capturedAsset({ sourceOrigin: accepted }),
      ]);
      assert.ok(shown.includes(`Source link: ${accepted}`), accepted);
      assert.ok(
        shown.indexOf("Source link:") <
          shown.indexOf('data-action="browser-asset-save"'),
        accepted,
      );
    }
  } finally {
    harness.restore();
  }
});

test("reopening the editor fresh drops the source pipeline revision from the save request", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    harness.document.root.querySelector('[data-action="pipeline-save"]').click();
    const update = harness.messages.at(-1);
    assert.equal(update.message.mode, "update");
    assert.equal(Object.hasOwn(update.message, "expectedHash"), true);

    harness.document.root.querySelector('[data-action="pipeline-editor-close"]').click();
    harness.document.root.querySelector('[data-action="pipeline-new"]').click();
    harness.document.root.querySelector('[data-action="pipeline-save"]').click();
    const create = harness.messages.at(-1);
    assert.equal(create.message.mode, "create");
    assert.equal(
      Object.hasOwn(create.message, "expectedHash"),
      false,
      "a fresh editor still sent the previous pipeline revision",
    );
    assert.equal(Object.hasOwn(create.message, "sourcePipelineId"), false);
  } finally {
    harness.restore();
  }
});

test("the result center names the exact verifier that ran, not a summary of it", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "completed",
            changedFiles: [],
            checks: [
              {
                command: "npm run check-types",
                status: "passed",
                exitCode: 0,
                workingDirectory: "/workspace/candidate",
                candidateTree: "tree-9f13c2",
                outputReference: "runs/run-1/checks/check-types.log",
              },
              { command: "npm test", status: "failed", exitCode: 1 },
            ],
            finalRuling: "Blocked",
            rulingBy: "claude",
            providers: [],
            unresolvedRisks: [],
            recoveredErrors: [],
            evidenceGaps: [],
          },
        },
      }),
    });

    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /npm run check-types/u);
    assert.match(html, /Exit status<\/dt><dd>0<\/dd>/u);
    assert.match(html, /Working directory<\/dt><dd>\/workspace\/candidate<\/dd>/u);
    assert.match(html, /Candidate tree<\/dt><dd>tree-9f13c2<\/dd>/u);
    assert.match(html, /Output reference<\/dt><dd>runs\/run-1\/checks\/check-types\.log<\/dd>/u);
    // A check that recorded only an exit status still shows it, and invents no other field.
    assert.match(html, /npm test/u);
    assert.match(html, /Exit status<\/dt><dd>1<\/dd>/u);
    assert.equal((html.match(/Candidate tree/gu) ?? []).length, 1);
    assert.equal((html.match(/Output reference/gu) ?? []).length, 1);
  } finally {
    harness.restore();
  }
});

// THE JOURNEY THE EDITOR TESTS DID NOT COVER. Structured → JSON is local: the draft is already in
// memory and the switch only reformats it. JSON → Structured is not. The text may be anything, so
// the webview sends `pipeline.validate` to the runtime and waits, and the structured form appears
// only when the answer comes back. Nothing exercised that round trip, which is why an editor that
// could not leave JSON mode shipped.
const editorJourney = () => {
  const harness = bootWebview();
  harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
  harness.document.root.querySelector('[data-action="editor-mode"][data-mode="json"]').click();
  return harness;
};

const typeEditorJson = (harness, text) => {
  const raw = harness.document.getElementById("pipeline-raw");
  assert.ok(raw, "the JSON editor was not rendered");
  raw.value = text;
  harness.document.root.dispatch("input", { target: raw });
};

const lastValidateRequest = (harness) => {
  const sent = harness.messages.filter(
    (message) =>
      message.type === "conversation.runtime" && message.message?.type === "pipeline.validate",
  );
  return sent.at(-1)?.message;
};

const editorModePressed = (harness, mode) =>
  harness.document.root
    .querySelector(`[data-action="editor-mode"][data-mode="${mode}"]`)
    .getAttribute("aria-pressed");

test("editing valid JSON and clicking Structured returns the form with the edited values", () => {
  const harness = editorJourney();
  try {
    const edited = { ...pipelineDefinition(), name: "Edited in JSON" };
    typeEditorJson(harness, JSON.stringify(edited, null, 2));
    harness.document.root.querySelector('[data-action="editor-mode"][data-mode="form"]').click();

    // The switch is a request, not a local toggle: the editor is still in JSON until the runtime
    // answers, so a webview that flipped the mode optimistically would show a form built from an
    // unvalidated draft.
    const request = lastValidateRequest(harness);
    assert.ok(request, "clicking Structured sent no pipeline.validate");
    assert.equal(request.pipeline.name, "Edited in JSON");
    assert.equal(editorModePressed(harness, "json"), "true");
    assert.equal(editorModePressed(harness, "form"), "false");

    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "operation.result",
        requestId: request.requestId,
        operation: "pipeline.validate",
        status: "completed",
        pipeline: request.pipeline,
      },
    });

    assert.equal(editorModePressed(harness, "form"), "true");
    assert.equal(editorModePressed(harness, "json"), "false");
    assert.equal(harness.document.getElementById("pipeline-raw"), null);
    // The edit survived the round trip and is in the field a person would edit next.
    const name = harness.document.root.querySelector('[data-editor-meta="name"]');
    assert.ok(name, "the structured form did not render the pipeline name field");
    assert.equal(name.getAttribute("value"), "Edited in JSON");
    assert.deepEqual(harness.document.root.querySelectorAll(".editor-errors"), []);
  } finally {
    harness.restore();
  }
});

test("JSON the runtime refuses shows the reasons and leaves the JSON in place to fix", () => {
  const harness = editorJourney();
  try {
    const broken = { ...pipelineDefinition(), steps: [] };
    typeEditorJson(harness, JSON.stringify(broken, null, 2));
    harness.document.root.querySelector('[data-action="editor-mode"][data-mode="form"]').click();
    const request = lastValidateRequest(harness);
    assert.ok(request);

    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "operation.result",
        requestId: request.requestId,
        operation: "pipeline.validate",
        status: "failed",
        message: "steps must not be empty\nAt least one step must be enabled",
      },
    });

    // Both reasons are shown, and the editor stays in JSON so the text that caused them is still
    // there to correct.
    assert.match(harness.document.root.innerHTML, /steps must not be empty/u);
    assert.match(harness.document.root.innerHTML, /At least one step must be enabled/u);
    assert.equal(editorModePressed(harness, "json"), "true");
    assert.ok(harness.document.getElementById("pipeline-raw"));

    // And correcting it recovers: the same click now succeeds and the form appears.
    typeEditorJson(harness, JSON.stringify({ ...pipelineDefinition(), name: "Repaired" }, null, 2));
    harness.document.root.querySelector('[data-action="editor-mode"][data-mode="form"]').click();
    const repaired = lastValidateRequest(harness);
    assert.notEqual(repaired.requestId, request.requestId);
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "operation.result",
        requestId: repaired.requestId,
        operation: "pipeline.validate",
        status: "completed",
        pipeline: repaired.pipeline,
      },
    });
    assert.equal(editorModePressed(harness, "form"), "true");
    assert.equal(
      harness.document.root.querySelector('[data-editor-meta="name"]').getAttribute("value"),
      "Repaired",
    );
    assert.doesNotMatch(harness.document.root.innerHTML, /steps must not be empty/u);
  } finally {
    harness.restore();
  }
});

test("JSON that is not JSON is refused in the webview without asking the runtime", () => {
  const harness = editorJourney();
  try {
    const before = harness.messages.length;
    typeEditorJson(harness, "{ not json");
    harness.document.root.querySelector('[data-action="editor-mode"][data-mode="form"]').click();
    assert.equal(lastValidateRequest(harness), undefined, "unparseable text was sent to the runtime");
    assert.equal(editorModePressed(harness, "json"), "true");
    assert.match(harness.document.root.innerHTML, /class="editor-errors"/u);
    assert.ok(harness.messages.length >= before);
  } finally {
    harness.restore();
  }
});

// EX-UI-01. A failure Bachata understands is drawn where the step is, says what happened and what
// to do next, offers the choices as controls, and keeps the provider's own words under a
// disclosure. Nothing here re-runs anything.
test("a provider failure states its recovery beside the step, as controls", () => {
  const harness = bootWebview(managerState(), panelState({
    transcript: [{
      id: "failure-1",
      kind: "error",
      agentId: "worker",
      step: "review",
      eventType: "provider.recovery",
      text: "Codex refused this run\nBachata will not run this somewhere else on its own.",
      createdAt: timestamp,
      data: {
        title: "Codex refused this run",
        statement: "The installed Codex app-server rejected the request Bachata sent.",
        provider: "codex",
        code: "protocolRejected",
        detail: "codex app-server: unknown method 'session/new'",
        choices: [
          { id: "runDoctor", label: "Run Doctor", detail: "Re-check the installed provider." },
          {
            id: "openProviderSettings",
            label: "Open provider settings",
            detail: "Point Bachata at another executable.",
            setting: "bachata.codexCommand",
          },
          { id: "stop", label: "Stop", detail: "Leave the run stopped and change nothing." },
        ],
      },
    }],
  }));
  try {
    const article = harness.document.root.querySelector('[data-entry="failure-1"]');
    assert.notEqual(article, null, "the failing step drew no entry");
    const rendered = harness.document.root.innerHTML;
    const start = rendered.indexOf('data-entry="failure-1"');
    assert.notEqual(start, -1);
    const html = rendered.slice(start);
    assert.match(html, /Codex refused this run/u);
    assert.match(html, /The installed Codex app-server rejected the request Bachata sent\./u);
    assert.match(html, /Bachata will not run this somewhere else on its own\./u);

    // The provider's own words are detail, not the headline.
    assert.match(html, /<details[^>]*failure-recovery-detail/u);
    const detailIndex = html.indexOf("failure-recovery-detail");
    assert.ok(
      detailIndex > html.indexOf("failure-recovery-choices"),
      "the technical detail came before the choices",
    );

    // A choice with somewhere to go is a control; one that is a decision to do nothing is not.
    const doctor = harness.document.root.querySelector('[data-action="recovery-doctor"]');
    const settings = harness.document.root.querySelector('[data-action="recovery-setting"]');
    assert.notEqual(doctor, null, "Run Doctor was not offered as a control");
    assert.notEqual(settings, null, "the provider setting was not offered as a control");
    assert.equal(harness.document.root.querySelector('[data-action="recovery-stop"]'), null);

    const before = harness.messages.length;
    doctor.click();
    assert.deepEqual(harness.messages.at(-1), { type: "recovery.doctor" });
    settings.click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "settings.open",
      setting: "bachata.codexCommand",
    });
    assert.equal(harness.messages.length, before + 2, "a recovery control sent more than it said");
    assert.deepEqual(
      harness.messages.slice(before).filter((message) => message.type === "conversation.runtime"),
      [],
      "a recovery control re-ran the work",
    );
  } finally {
    harness.restore();
  }
});

// EX-UI-02. The room a reader opens is the task, not the evidence about the task.
test("a room that has never run keeps its advanced evidence closed and says each thing once", () => {
  const harness = bootWebview();
  try {
    const html = harness.document.root.innerHTML;
    const contract = harness.document.root.querySelector(".run-contract");
    if (contract) {
      assert.equal(contract.getAttribute("open"), null, "the run contract opened before anything ran");
    }
    // One acknowledgement control in the composer, not one in the contract and one beside Send.
    assert.ok(
      harness.document.root.querySelectorAll('[data-action="contract-acknowledge"]').length <= 1,
      "the acknowledgement is asked for twice inside one composer",
    );
    assert.doesNotMatch(html, /Acknowledgement required/u);
    // Nothing that is drawn at zero width may be reached by a keyboard outside the composer.
    const composerHtml = html.slice(html.indexOf('class="composer"'));
    const quietOutsideComposer = html
      .slice(0, html.indexOf('class="composer"') === -1 ? html.length : html.indexOf('class="composer"'))
      .includes("quiet-control");
    assert.equal(quietOutsideComposer, false, "a zero-width control is focusable outside the composer");
    assert.ok(composerHtml.length > 0);
  } finally {
    harness.restore();
  }
});

// EX-UI-02. Two surfaces, one line. The bell lists the newest unread event; the bubble announces
// it. Both at once on the same screen is the same sentence twice, so the bubble stands down while
// the centre is open.
test("the newest notification is said once when the centre is open", () => {
  const harness = bootWebview(managerState({
    notifications: {
      mode: "material",
      unread: 1,
      events: [{
        id: "converged:Y1:3-1-0-1",
        kind: "findingsConverged",
        level: "material",
        text: "Review converged: 3 resolved, 1 new, 0 regressed, 1 needs you.",
        action: "inspect",
        recordedAt: "2026-01-01T00:00:00.000Z",
        read: false,
      }],
    },
  }));
  try {
    assert.ok(
      harness.document.root.innerHTML.includes("notification-bubble"),
      "the closed centre did not leave the bubble to speak",
    );
    const centre = harness.document.root.querySelector('[data-disclosure-key="run-1:notification-center"]');
    assert.ok(centre, "the notification centre has no disclosure key");
    assert.ok(!centre.open, "the notification centre opened by default");
    centre.open = true;
    harness.document.root.dispatch("toggle", { target: centre });
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "state.snapshot", state: panelState() },
    });
    const opened = harness.document.root.innerHTML;
    assert.ok(opened.includes("notification-center"));
    assert.equal(
      opened.includes("notification-bubble"),
      false,
      "the newest event is drawn twice while the centre is open",
    );
    assert.equal(
      opened.split("Review converged: 3 resolved, 1 new, 0 regressed, 1 needs you.").length - 1,
      1,
      "the newest event's text appears more than once",
    );
  } finally {
    harness.restore();
  }
});

// A floating menu that its siblings dismiss but it does not is a keyboard trap: Escape leaves the
// notification centre open with focus inside it, and a click elsewhere leaves it covering the page.
// Focus restoration and the keep-open exception need parent links this flat DOM does not have, so
// they are asserted against a real browser in scripts/run-webview-layout.mjs.
const notificationManager = () => managerState({
  notifications: {
    mode: "material",
    unread: 1,
    events: [{
      id: "converged:Y1:3-1-0-1",
      kind: "findingsConverged",
      level: "material",
      text: "Review converged: 3 resolved, 1 new, 0 regressed, 1 needs you.",
      action: "inspect",
      recordedAt: "2026-01-01T00:00:00.000Z",
      read: false,
    }],
  },
});

const openMenu = (harness, selector) => {
  const menu = harness.document.root.querySelector(selector);
  assert.ok(menu, `no menu matched ${selector}`);
  menu.open = true;
  harness.document.root.dispatch("toggle", { target: menu });
  return menu;
};

for (const [label, selector] of [
  ["the run menu", ".run-action-menu"],
  ["the room overflow menu", ".header-action-menu"],
  ["the notification centre", ".notification-center"],
]) {
  test(`Escape closes ${label}`, () => {
    const harness = bootWebview(notificationManager());
    try {
      const menu = openMenu(harness, selector);
      harness.document.root.dispatch("keydown", {
        key: "Escape",
        target: harness.document.root,
        preventDefault: () => undefined,
      });
      assert.equal(menu.open, false, `${label} stayed open under Escape`);
    } finally {
      harness.restore();
    }
  });

  test(`a click elsewhere dismisses ${label}`, () => {
    const harness = bootWebview(notificationManager());
    try {
      const menu = openMenu(harness, selector);
      harness.document.root.dispatch("click", { target: harness.document.root.querySelector(".run-tabs-brand") });
      assert.equal(menu.open, false, `${label} survived a click elsewhere`);
    } finally {
      harness.restore();
    }
  });
}

// Disabling the control the reader just activated drops focus to the document. Every other
// self-disabling control moves focus to the card it belongs to; the editor's heading is that card,
// and the status region is what says the save is in flight.
test("saving a pipeline keeps focus in the editor and announces the save", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    const save = harness.document.root.querySelector('[data-action="pipeline-save"]');
    assert.ok(save, "the editor did not open with a save control");
    harness.document.liveStatus.textContent = "";
    save.focus();
    save.click();
    assert.equal(
      harness.document.activeElement,
      harness.document.getElementById("pipeline-editor-title"),
      "the save left focus on the disabled button, which drops it to the document",
    );
    assert.match(harness.document.liveStatus.textContent, /Saving the pipeline/u);
  } finally {
    harness.restore();
  }
});

// The list filters as the reader types. Sight sees it shrink; without a status line nothing says so.
test("the run drawer states how many runs match", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="run-drawer-toggle"]').click();
    // The stub parses attributes but not text, so the rendered markup is what carries the count.
    assert.match(
      harness.document.root.innerHTML,
      /<p class="sr-only" role="status"[^>]*>\d+ runs?\.<\/p>/u,
      "the drawer has no visually hidden status region stating how many runs match",
    );
  } finally {
    harness.restore();
  }
});

test("the run drawer toggle only names its panel while the panel exists", () => {
  const harness = bootWebview();
  try {
    const closed = harness.document.root.querySelector('[data-action="run-drawer-toggle"]');
    assert.equal(closed.getAttribute("aria-expanded"), "false");
    assert.equal(closed.getAttribute("aria-controls"), null, "the closed toggle points at an absent id");
    assert.equal(harness.document.root.querySelector("#run-drawer"), null);
    closed.click();
    const opened = harness.document.root.querySelector('[data-action="run-drawer-toggle"]');
    assert.equal(opened.getAttribute("aria-expanded"), "true");
    assert.equal(opened.getAttribute("aria-controls"), "run-drawer");
    assert.ok(harness.document.root.querySelector("#run-drawer"), "aria-controls names an element that exists");
  } finally {
    harness.restore();
  }
});

test("a submit that cannot yet be sent says what it is waiting for", () => {
  const interaction = {
    interactionRef: "int-blocked",
    conversationId: "run-1",
    runRef: "run-1",
    kind: "question",
    prompt: "Which retry budget?",
    options: [{ id: "three", label: "Three retries" }],
    allowFreeText: true,
    secret: false,
    selected: [],
    freeText: "",
    status: "pending",
    createdAt: timestamp,
  };
  const harness = bootWebview(managerState({ interactions: [interaction] }), panelState());
  try {
    const submit = harness.document.root.querySelector('[data-action="interaction-submit"]');
    assert.ok(submit.hasAttribute("disabled"), "the submit was not disabled with nothing answered");
    assert.equal(submit.getAttribute("title"), "Choose an option, or write a reply, to submit.");
  } finally {
    harness.restore();
  }
});


// EX-UI-02. The no-run-selected room offered the whole Direction centre — five permanently
// visible secondary controls among them — for a workspace with no direction to show. It is
// offered on the same condition the room header and the Direction view already use.
test("the no-run room offers the Direction centre only where there is direction", () => {
  const harness = bootWebview(managerState({ conversations: [], activeConversationId: undefined }));
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /No run selected/u);
    assert.equal(
      html.includes("direction-center"),
      false,
      "a workspace with no direction drew the Direction centre",
    );
    assert.equal(
      html.includes(`data-action="review-fresh"`) || html.includes(`data-action="cycle-start"`),
      false,
      "the Direction centre's secondary controls are permanently visible in a room with no direction",
    );
  } finally {
    harness.restore();
  }
});

const MARKERS = {
  taskInput: 'id="composer-prompt"',
  primaryAction: 'data-action="submit-message"',
  blockers: "composer-blockers",
  bell: "notification-center",
  directionBanner: "direction-banner",
  // The tab, by its own label: the overflow menu keeps an "Open direction" route when the tab is
  // hidden, and that route is not the tab.
  directionTab: ">Direction<",
  executionTab: 'data-view="execution"',
  runResult: "result-center",
  blockingBanner: "blocking-workflow-banner",
  orchestration: "orchestration-card",
  sourceControl: 'data-action="result-source-control"',
  exportEvidence: 'aria-label="Run result actions"',
  inspector: 'class="inspector"',
  diagnostics: "bridge-details",
};

const assertMatrixRow = (label, html, expected) => {
  for (const [marker, pattern] of Object.entries(MARKERS)) {
    const shouldShow = expected.visible.includes(marker);
    assert.equal(
      html.includes(pattern),
      shouldShow,
      `${label}: ${marker} should be ${shouldShow ? "visible" : "hidden"}`,
    );
  }
};

const completedResult = (overrides = {}) => ({
  status: "completed",
  changedFiles: [],
  checks: [],
  providers: [],
  unresolvedRisks: [],
  recoveredErrors: [],
  evidenceGaps: [],
  ...overrides,
});

test("the room's DOM state matrix asserts what is shown and what stays hidden", () => {
  // THE RULE THIS PINS. Every surface that has nothing to say is absent, not empty. The row for
  // each state names what is visible; every other marker in MARKERS must be missing, so a surface
  // that reappears in a state it does not belong in fails here rather than in a screenshot.
  const idleVisible = ["taskInput", "primaryAction", "blockers"];

  // 1. Pristine: a room that has only been opened.
  let harness = bootWebview();
  try {
    const html = harness.document.root.innerHTML;
    // EX-UI-02. An empty input is not a blocker list. The field's placeholder and the intro card
    // already say it; the refusal travels on Send itself, where a reader who asks is told.
    assertMatrixRow("pristine", html, { visible: ["taskInput", "primaryAction"] });
    assert.equal(
      html.split("The run input is empty.").length - 1,
      1,
      "the empty input is stated more than once in an empty room",
    );
    const pristineSend = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(pristineSend.getAttribute("aria-disabled"), "true");
    assert.match(
      String(pristineSend.getAttribute("aria-description")),
      /The run input is empty\. Describe what this run must do\./u,
    );
  } finally {
    harness.restore();
  }

  // 2. Missing workspace: the blocker is stated and nothing else appears with it.
  harness = bootWebview(managerState(), panelState({ workspaceRoots: [] }));
  try {
    const html = harness.document.root.innerHTML;
    assertMatrixRow("missing workspace", html, { visible: idleVisible });
    assert.match(html, /No workspace folder is open\./u);
  } finally {
    harness.restore();
  }

  // 3. Missing pipeline: still just the input and its blocker.
  harness = bootWebview(managerState(), panelState({
    pipelines: [],
    selectedPipelineId: undefined,
    selectedPipelineDefinition: undefined,
  }));
  try {
    // A room with no pipeline has nothing else to say either: the input is empty, and that is the
    // field's own business rather than a list above it.
    assertMatrixRow("missing pipeline", harness.document.root.innerHTML, {
      visible: ["taskInput", "primaryAction"],
    });
  } finally {
    harness.restore();
  }

  // 4. Ready: a prompt has been entered, so the blocker is gone and one primary action remains.
  harness = bootWebview();
  try {
    const prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "Fix the cancellation path";
    harness.document.root.dispatch("input", { target: prompt });
    const html = harness.document.root.innerHTML;
    assertMatrixRow("ready", html, { visible: ["taskInput", "primaryAction"] });
    const submit = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(submit.getAttribute("aria-disabled"), null);
    const beforeSubmit = harness.messages.length;
    submit.click();
    assert.equal(harness.messages.length, beforeSubmit + 1);
    assert.equal(harness.messages.at(-1).message.type, "pipeline.run");
  } finally {
    harness.restore();
  }

  // 5. Running: the room reports progress and offers a stop, and still shows no result.
  harness = bootWebview(managerState(), panelState({
    running: true,
    workflowStatus: "running",
    activeStep: "Implement",
  }));
  try {
    const html = harness.document.root.innerHTML;
    assertMatrixRow("running", html, { visible: ["taskInput", "primaryAction", "blockers"] });
    assert.match(html, /status-running/u);
    assert.ok(harness.document.root.querySelector('[data-action="interrupt-run"]') !== null);
  } finally {
    harness.restore();
  }

  // 6. Blocking human input: the banner and the Execution route appear, and only then.
  harness = bootWebview(managerState(), panelState({
    running: true,
    workflowStatus: "running",
    pendingGate: {
      stepId: "implement",
      stepName: "Implement",
      reason: "afterStep",
      allowedActions: ["continue", "stop"],
      rollbackTargets: [],
    },
  }));
  try {
    const html = harness.document.root.innerHTML;
    assertMatrixRow("blocking human input", html, {
      visible: ["taskInput", "primaryAction", "blockers", "executionTab", "blockingBanner"],
    });
    assert.match(html, /Run needs your input/u);
  } finally {
    harness.restore();
  }

  // 7. Completed without changes: the Execution route appears; the result stays in it.
  harness = bootWebview(managerState({
    resultsByConversation: { "run-1": completedResult() },
  }), panelState({ workflowStatus: "completed" }));
  try {
    assertMatrixRow("completed without changes, chat view", harness.document.root.innerHTML, {
      visible: ["taskInput", "primaryAction", "executionTab"],
    });
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assertMatrixRow("completed without changes, execution view", html, {
      visible: ["executionTab", "runResult", "sourceControl", "exportEvidence"],
    });
    assert.match(html, /No changed files were recorded\./u);
  } finally {
    harness.restore();
  }

  // 8. Completed with verified changes.
  harness = bootWebview(managerState({
    resultsByConversation: {
      "run-1": completedResult({
        changedFiles: ["src/a.ts"],
        checks: [{ command: "bachata:project-checks", status: "passed" }],
        finalRuling: "Accepted",
      }),
    },
  }), panelState({ workflowStatus: "completed" }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assertMatrixRow("completed with verified changes", html, {
      visible: ["executionTab", "runResult", "sourceControl", "exportEvidence"],
    });
    assert.match(html, /src\/a\.ts/u);
    assert.match(html, /passed/u);
  } finally {
    harness.restore();
  }

  // 9. Failed with stale verification.
  harness = bootWebview(managerState({
    resultsByConversation: {
      "run-1": completedResult({
        status: "failed",
        changedFiles: ["src/a.ts"],
        checks: [{ command: "bachata:project-checks", status: "failed" }],
        applyBlockedReason: "the recorded verification predates the current changes",
      }),
    },
  }), panelState({ workflowStatus: "failed" }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assertMatrixRow("failed or stale verification", html, {
      visible: ["executionTab", "runResult", "sourceControl", "exportEvidence"],
    });
    assert.match(html, /the recorded verification predates the current changes/u);
  } finally {
    harness.restore();
  }

  // 10. A material direction decision, and a real notification.
  const base = directionState();
  harness = bootWebview(managerState({ direction: base }));
  try {
    assertMatrixRow("material direction decision", harness.document.root.innerHTML, {
      visible: ["taskInput", "primaryAction", "directionBanner", "directionTab"],
    });
  } finally {
    harness.restore();
  }

  harness = bootWebview(managerState({
    notifications: {
      mode: "material",
      unread: 1,
      events: [{
        id: "converged:Y1:1-0-0-1",
        kind: "findingsConverged",
        level: "material",
        text: "Review converged: 1 resolved, 0 new, 0 regressed, 1 needs you.",
        action: "inspect",
        recordedAt: "2026-01-01T00:00:00.000Z",
        read: false,
      }],
    },
  }));
  try {
    const html = harness.document.root.innerHTML;
    assertMatrixRow("real notification", html, {
      visible: ["taskInput", "primaryAction", "bell"],
    });
    assert.match(html, /Review converged: 1 resolved/u);
  } finally {
    harness.restore();
  }
});

test("the pipeline editor never traps the author in one mode", () => {
  // THE FAILURE THIS PINS. A step's output schema is edited as free text. An unparsable one made
  // the read of the draft fail, and the mode switch refused to run — so the JSON view, the one
  // place that text can be repaired, was locked behind the very text that needed repairing.
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    const raw = harness.document.getElementById("pipeline-raw");
    assert.equal(raw, null, "the editor did not open in Structured mode");
    const jsonTab = harness.document.root.querySelector('[data-action="editor-mode"][data-mode="json"]');
    assert.equal(jsonTab.disabled, false);
    jsonTab.click();
    assert.ok(harness.document.getElementById("pipeline-raw") !== null, "the JSON view did not open");
    // Both tabs stay operable from the keyboard: they are buttons, enabled, and carry their state.
    const structuredTab = harness.document.root.querySelector('[data-action="editor-mode"][data-mode="form"]');
    assert.equal(structuredTab.tagName, "BUTTON");
    assert.equal(structuredTab.disabled, false);
    assert.equal(
      harness.document.root
        .querySelector('[data-action="editor-mode"][data-mode="json"]')
        .getAttribute("aria-pressed"),
      "true",
    );
  } finally {
    harness.restore();
  }
});

// --- Audit regressions ---------------------------------------------------------------------

const gatedPipeline = () => {
  const pipeline = pipelineDefinition();
  pipeline.agents.push({ id: "worker", name: "Worker", adapter: "claude-code" });
  pipeline.steps[0].consensus = true;
  pipeline.steps[0].consensusConfig = { mode: "arbiter", maxRounds: 3, arbiter: "worker" };
  return pipeline;
};

const pendingGate = (over = {}) => ({
  stepId: "step-1",
  stepName: "Implement",
  reason: "afterStep",
  allowedActions: ["continue", "skip", "requestArbiterRuling", "rollback", "cancel"],
  rollbackTargets: [{ id: "step-1", name: "Implement" }],
  ...over,
});

test("the human gate is answerable from the chat view, names its default and its arbiter, and explains the stop", () => {
  const harness = bootWebview(
    managerState({ conversations: [{ ...conversationSummary(), running: true, workflowStatus: "paused" }] }),
    panelState({
      running: true,
      workflowStatus: "paused",
      selectedPipelineDefinition: gatedPipeline(),
      pendingGate: pendingGate(),
    }),
  );
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /class="decision-card" id="pending-gate" tabindex="-1"/u, "the gate is not in the chat view");
    assert.match(html, /This step has finished\. Decide what happens next\./u, "the reason enum is printed raw");
    assert.match(html, /class="primary" data-action="gate" data-gate-action="continue"/u, "no default action");
    assert.match(html, /Ask Worker to rule/u, "the arbiter button names a fixed agent");
    assert.match(html, /<label for="rollback-target">Return to step<\/label>/u, "the rollback target has no visible label");
    assert.match(html, /class="room-status status-paused">Waiting for you</u, "the header pill contradicts the gate");
    assert.doesNotMatch(html, /<small>int-/u);
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"][data-focus="pending-decision"]').click();
    assert.equal(harness.document.activeElement.id, "pending-gate", "Review and continue left focus on the body");
  } finally {
    harness.restore();
  }
});

test("agent markdown renders pipe tables and demotes its headings below the room's own", () => {
  const harness = bootWebview(managerState(), panelState({
    transcript: [{
      id: "answer-1",
      kind: "answer",
      agentId: "lead",
      text: "# Findings\n\n| File | Severity |\n| --- | --- |\n| `a.ts` | high |\n\nDone.",
      createdAt: timestamp,
    }],
    transcriptTotal: 1,
  }));
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /<h3>Findings<\/h3>/u, "an answer heading competes with the room's h1");
    assert.match(html, /<table><thead><tr><th scope="col">File<\/th><th scope="col">Severity<\/th><\/tr><\/thead><tbody><tr><td><code>a\.ts<\/code><\/td><td>high<\/td><\/tr><\/tbody><\/table>/u);
    assert.doesNotMatch(html, /<pre class="language-[^"]*" tabindex="0"/u, "every code block is a tab stop");
  } finally {
    harness.restore();
  }
});

const reviewContract = (over = {}) => ({
  pipelineId: "custom-a",
  pipelineName: "Custom A",
  safetyLevel: "review",
  providers: [],
  roles: [],
  scope: { writeScope: "readOnly", writablePaths: [], readablePaths: [], protectedPaths: [] },
  commitPolicy: "never",
  verification: [],
  verificationResources: [],
  humanGates: [],
  limits: { iterations: 1, maxIterations: 10, iterationMode: "fixed" },
  fallbacks: [],
  completion: [],
  blockers: [],
  ...over,
});

test("a refused policy blocks Send once and the contract lists it under one heading", () => {
  const contract = reviewContract({
    policyRefusals: ["Shell access is disabled by policy."],
    blockers: ["Shell access is disabled by policy.", "No git repository at /workspace"],
  });
  const harness = bootWebview(managerState(), panelState({ executionContract: contract }));
  try {
    const html = harness.document.root.innerHTML;
    assert.equal((html.match(/<li>Shell access is disabled by policy\.<\/li>/gu) ?? []).length, 1, "the contract states the refusal under two headings");
    assert.match(html, /<h3>Repository policy refuses this run<\/h3>/u);
    assert.match(html, /<h3>Unresolved before running<\/h3><ul class="contract-list"><li>No git repository at \/workspace<\/li><\/ul>/u);
    assert.doesNotMatch(html, /<h4>/u, "the contract skips a heading level");
    const send = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(send.getAttribute("aria-disabled"), "true", "a refused run still offers Send");
    assert.match(html, /class="room-status status-error">Blocked</u);
    const blockers = harness.document.getElementById("composer-blockers");
    assert.match(blockers.dataset.announcement, /^Send is disabled\. Shell access is disabled by policy\. This repository.{1,6}s policy file refuses this run/u);
    assert.doesNotMatch(blockers.dataset.announcement, /Fix|Discard|Stop/u, "button labels leak into the announcement");
  } finally {
    harness.restore();
  }
});

test("a submit the runtime never answers can be discarded from the composer", () => {
  const harness = bootWebview();
  try {
    const prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "Review the auth middleware";
    harness.document.root.dispatch("input", { target: prompt });
    harness.document.root.querySelector('[data-action="submit-message"]').click();
    assert.equal(harness.messages.at(-1).message.type, "pipeline.run");
    assert.equal(harness.document.root.querySelector('[data-action="submit-message"]').getAttribute("aria-disabled"), "true");
    const discard = harness.document.root.querySelector('[data-action="run-discard-pending"]');
    assert.ok(discard, "no way out of a pending submit");
    discard.click();
    assert.equal(harness.document.root.querySelector('[data-action="submit-message"]').getAttribute("aria-disabled"), null);
    assert.equal(harness.document.root.querySelector('[data-action="run-discard-pending"]'), null);
  } finally {
    harness.restore();
  }
});

test("a skip link is the first control and lands on the run input", () => {
  const harness = bootWebview();
  try {
    assert.match(harness.document.root.innerHTML, /^<div class="app-shell"><button class="skip-link" data-action="skip-to-composer">Skip to run input<\/button>/u);
    harness.document.root.querySelector('[data-action="skip-to-composer"]').click();
    assert.equal(harness.document.activeElement.id, "composer-prompt");
  } finally {
    harness.restore();
  }
});

test("run options open in flow with their toggle pointing at them", () => {
  const harness = bootWebview();
  try {
    const toggle = harness.document.root.querySelector('[data-action="composer-options-toggle"]');
    // Closed, the panel is not rendered, so the toggle names nothing. An aria-controls pointing at
    // an absent id is an ARIA error, and assistive technology drops the relationship outright.
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-controls"), null, "the closed toggle points at an element that does not exist");
    assert.equal(harness.document.getElementById("composer-advanced"), null);
    toggle.click();
    const opened = harness.document.root.querySelector('[data-action="composer-options-toggle"]');
    assert.equal(opened.getAttribute("aria-expanded"), "true");
    assert.equal(opened.getAttribute("aria-controls"), "composer-advanced");
    assert.ok(harness.document.getElementById("composer-advanced"), "aria-controls names an element that exists");
    assert.match(harness.document.root.innerHTML, /<\/div>\n    <div class="composer-advanced" id="composer-advanced">/u, "the options are still a popover inside the anchor");
    harness.document.root.dispatch("keydown", { key: "Escape", target: harness.document.getElementById("pipeline-iterations"), preventDefault: () => undefined });
    assert.equal(harness.document.activeElement.dataset.action, "composer-options-toggle", "Escape left focus on the body");
  } finally {
    harness.restore();
  }
});

test("answering an interaction keeps focus on its card and says so", () => {
  const interaction = {
    interactionRef: "int-9",
    conversationId: "run-1",
    runRef: "run-1",
    kind: "question",
    prompt: "Which?",
    options: [{ id: "a", label: "A" }],
    allowFreeText: false,
    secret: false,
    selected: ["a"],
    freeText: "",
    status: "pending",
    createdAt: timestamp,
  };
  const harness = bootWebview(managerState({ interactions: [interaction] }), panelState());
  try {
    harness.document.root.querySelector('[data-action="interaction-submit"]').click();
    assert.equal(harness.document.activeElement.id, "interaction-int-9");
  } finally {
    harness.restore();
  }
});

test("discarding the recovery checkpoint asks first", () => {
  const harness = bootWebview(managerState(), panelState({
    resumableWorkflow: { pipelineId: "custom-a", pipelineName: "Custom A", pipelineHash: customAHash, userPrompt: "x", attachmentIds: [], nextStepIndex: 0, totalSteps: 2, updatedAt: timestamp },
  }));
  try {
    harness.document.root.querySelector('[data-action="workflow-discard"]').click();
    assert.equal(harness.messages.filter((message) => message.message?.type === "workflow.discard").length, 0, "discard fired without confirmation");
    assert.match(harness.document.root.innerHTML, /Discard the recovery checkpoint\?/u);
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "conversation.runtime", conversationId: "run-1", message: { type: "workflow.discard" } });
  } finally {
    harness.restore();
  }
});

test("a dialog refusal survives the next background render", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="rename-conversation"]').click();
    const input = harness.document.getElementById("app-dialog-input");
    input.value = "";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(harness.document.getElementById("app-dialog-error").textContent, "Enter a title for this run.");
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
    assert.match(harness.document.root.innerHTML, /id="app-dialog-input" aria-invalid="true" aria-describedby="app-dialog-error"/u, "the render erased the refusal");
    assert.match(harness.document.root.innerHTML, /id="app-dialog-error" role="alert">Enter a title for this run\.</u);
  } finally {
    harness.restore();
  }
});

// EX transcript bound. Between full snapshots the host streams single transcript.append events and
// the webview only pushed them, so a run that emits more distinct entries than the window keeps
// growing the rendered list without bound (run.patch is its own message and does not reset it).
const appendEntry = (harness, id) => {
  harness.sendWindowMessage({
    type: "conversation.message",
    conversationId: "run-1",
    message: {
      type: "transcript.append",
      entry: { id, kind: "answer", agentId: "worker", text: `entry ${id}`, createdAt: timestamp },
    },
  });
};

const renderedEntryIds = (harness) => {
  const html = harness.document.root.innerHTML;
  const ids = [];
  const pattern = /data-entry="([^"]+)"/gu;
  let match;
  while ((match = pattern.exec(html)) !== null) ids.push(match[1]);
  return ids;
};

test("streaming more appends than the window keeps the rendered transcript bounded and offers older history", () => {
  const harness = bootWebview(managerState(), panelState({ transcriptWindowSize: 3 }));
  try {
    for (const id of ["m1", "m2", "m3", "m4", "m5"]) appendEntry(harness, id);
    assert.deepEqual(
      renderedEntryIds(harness),
      ["m3", "m4", "m5"],
      "the append stream grew the rendered transcript past its window",
    );
    assert.ok(
      harness.document.root.querySelector('[data-action="load-older"]'),
      "trimmed older entries are no longer offered for loading",
    );
  } finally {
    harness.restore();
  }
});

test("an append does not shrink history the reader explicitly loaded, but does not grow it either", () => {
  const harness = bootWebview(managerState(), panelState({ transcriptWindowSize: 3 }));
  try {
    for (const id of ["m1", "m2", "m3"]) appendEntry(harness, id);
    // The reader pages in two older entries, so the loaded capacity is now five, above the window.
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "transcript.prepend",
        entries: [
          { id: "old1", kind: "answer", agentId: "worker", text: "old one", createdAt: timestamp },
          { id: "old2", kind: "answer", agentId: "worker", text: "old two", createdAt: timestamp },
        ],
        total: 5,
        hasMore: false,
      },
    });
    assert.deepEqual(renderedEntryIds(harness), ["old1", "old2", "m1", "m2", "m3"]);
    // A new streamed entry holds that five-entry capacity: it drops the oldest rather than growing.
    appendEntry(harness, "m4");
    assert.deepEqual(renderedEntryIds(harness), ["old2", "m1", "m2", "m3", "m4"]);
    assert.ok(
      harness.document.root.querySelector('[data-action="load-older"]'),
      "dropping the oldest loaded entry did not re-offer older history",
    );
  } finally {
    harness.restore();
  }
});

test("a re-delivered append is deduplicated and does not advance the total", () => {
  const harness = bootWebview(managerState(), panelState({ transcriptWindowSize: 3 }));
  try {
    appendEntry(harness, "m1");
    appendEntry(harness, "m1");
    assert.deepEqual(renderedEntryIds(harness), ["m1"]);
    assert.ok(
      !harness.document.root.querySelector('[data-action="load-older"]'),
      "a duplicate append invented older history",
    );
  } finally {
    harness.restore();
  }
});

test("a later full snapshot still resets the transcript to the host window", () => {
  const harness = bootWebview(managerState(), panelState({ transcriptWindowSize: 3 }));
  try {
    for (const id of ["m1", "m2", "m3", "m4", "m5"]) appendEntry(harness, id);
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: {
        type: "state.snapshot",
        state: panelState({
          transcriptWindowSize: 3,
          transcript: [
            { id: "s1", kind: "answer", agentId: "worker", text: "snap one", createdAt: timestamp },
            { id: "s2", kind: "answer", agentId: "worker", text: "snap two", createdAt: timestamp },
          ],
          transcriptTotal: 7,
          transcriptHasMore: true,
        }),
      },
    });
    assert.deepEqual(renderedEntryIds(harness), ["s1", "s2"]);
  } finally {
    harness.restore();
  }
});

test("a toggle that only echoes the render is not recorded as the reader's choice", () => {
  const harness = bootWebview(managerState(), panelState({ executionContract: reviewContract() }));
  try {
    const contract = harness.document.root.querySelector('[data-disclosure-key="run-1:composer:contract"]');
    assert.equal(contract.open, true, "an empty room does not open the contract");
    harness.document.root.dispatch("toggle", { target: contract });
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "state.snapshot", state: panelState({ executionContract: reviewContract(), transcript: [{ id: "a", kind: "answer", agentId: "lead", text: "Hi", createdAt: timestamp }], transcriptTotal: 1 }) },
    });
    const started = harness.document.root.querySelector('[data-disclosure-key="run-1:composer:contract"]');
    assert.equal(started.open, false, "the parser's toggle pinned the contract open for the whole run");
    started.open = true;
    harness.document.root.dispatch("toggle", { target: started });
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
    assert.equal(harness.document.root.querySelector('[data-disclosure-key="run-1:composer:contract"]').open, true, "the reader's choice was lost");
  } finally {
    harness.restore();
  }
});

test("switching runs opens the next run on its chat", () => {
  const second = { ...conversationSummary(), id: "run-2", runRef: "run-2", title: "Second" };
  const harness = bootWebview(managerState({ conversations: [conversationSummary(), second] }), panelState());
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="direction"]').click();
    assert.match(harness.document.root.innerHTML, /data-view="direction" class="selected"/u);
    harness.document.root.querySelector('[data-action="select-conversation"][data-conversation="run-2"]').click();
    assert.match(harness.document.root.innerHTML, /data-view="chat" class="selected"/u, "the previous run's view followed the reader");
  } finally {
    harness.restore();
  }
});

test("a completed run says so at the end of the chat and routes to the result", () => {
  const result = {
    status: "completed",
    changedFiles: [],
    checks: [],
    unresolvedRisks: [],
    recoveredErrors: [],
    evidenceGaps: [],
    finalAssessment: { outcome: "completed", method: "singleProvider", summary: "Nothing to fix.", producedBy: [] },
  };
  const harness = bootWebview(managerState({ resultsByConversation: { "run-1": result } }), panelState({ workflowStatus: "completed" }));
  try {
    assert.match(harness.document.root.innerHTML, /<section class="result-summary">.*Nothing to fix\..*data-action="room-view" data-view="execution">Open the result<\/button><\/section>/u);
    assert.doesNotMatch(harness.document.root.innerHTML, /<h2>Start a run<\/h2>/u, "a room with a result shows the first-run intro");
  } finally {
    harness.restore();
  }
});

// EX-UI. A transient menu is dismissed by what happens behind it. Opening one, and marking
// notifications read, leave the room as it was; every other action changes it, so the menu that
// issued the action goes with the change rather than hanging over its own result.
//
// `<details>` does not toggle itself in this DOM, so the menu is opened the way the disclosure
// tests already do it: set `open` and dispatch the toggle the browser would have sent. The other
// half of the rule — that opening a menu is not an action that dismisses it — needs a native
// toggle and a recorded disclosure, so it is measured in `npm run test:webview-layout`, which
// presses the summary in a real browser and asserts the menu opens.
const openRunMenu = (harness) => {
  const menu = harness.document.root.querySelector(".run-action-menu");
  assert.ok(menu, "the run tab has no action menu to open");
  menu.open = true;
  harness.document.root.dispatch("toggle", { target: menu });
  return menu;
};

test("choosing an action from a run menu dismisses that menu", () => {
  const harness = bootWebview();
  try {
    const root = harness.document.root;
    openRunMenu(harness);
    root.querySelector('[data-action="run-duplicate"]').click();
    assert.equal(
      root.querySelector(".run-action-menu").open,
      false,
      "a chosen action left its own menu standing over the result",
    );
  } finally {
    harness.restore();
  }
});

test("a press outside a run menu dismisses it", () => {
  const harness = bootWebview();
  try {
    const root = harness.document.root;
    openRunMenu(harness);
    const outside = root.querySelector('[data-action="rename-conversation"]');
    assert.ok(outside, "the room has no control outside the menu to press");
    outside.click();
    assert.equal(
      root.querySelector(".run-action-menu").open,
      false,
      "the run menu survived a press outside it",
    );
  } finally {
    harness.restore();
  }
});

// EX-UI-02. Identical action buttons still have to be told apart, and the row's own sentence is
// what tells them apart — referenced, not repeated. A description that names an absent element is
// an ARIA error, so the target has to exist for every row.
test("each notification action is described by its own row, and that row exists", () => {
  const harness = bootWebview(managerState({
    notifications: {
      mode: "material",
      unread: 2,
      events: [
        {
          id: "converged:Y1:3-1-0-1",
          kind: "findingsConverged",
          level: "material",
          text: "Review converged: 3 resolved, 1 new, 0 regressed, 1 needs you.",
          action: "inspect",
          recordedAt: "2026-01-01T00:00:00.000Z",
          read: false,
        },
        {
          id: "blocked:Y1:2",
          kind: "runBlocked",
          level: "decision",
          text: "A run is waiting for a decision.",
          action: "inspect",
          recordedAt: "2026-01-01T00:01:00.000Z",
          read: false,
        },
      ],
    },
  }));
  try {
    const root = harness.document.root;
    const buttons = Array.from(root.querySelectorAll('[data-action="notification-open"]'))
      .filter((button) => button.getAttribute("aria-describedby"));
    assert.equal(buttons.length, 2, "the centre's actions are not described by their rows");
    const described = new Set();
    buttons.forEach((button) => {
      const target = button.getAttribute("aria-describedby");
      assert.ok(root.querySelector(`#${target.replace(/[:.]/gu, "\\$&")}`) ?? root.querySelector(`[id="${target}"]`), `aria-describedby names an absent element: ${target}`);
      described.add(target);
    });
    assert.equal(described.size, 2, "two rows share one description, so their actions read alike");
    buttons.forEach((button) => {
      assert.equal(
        (button.getAttribute("aria-label") ?? "").includes("Review converged"),
        false,
        "the action still repeats the row's sentence in its own name",
      );
    });
  } finally {
    harness.restore();
  }
});

/**
 * Copying the pairing token.
 *
 * The Bridge's Paste & Pair reads the clipboard and pairs with it, so what VS Code puts there is a
 * security boundary, not a convenience: the endpoint must never travel with it. A clipboard is
 * writable by any local process, and an endpoint carried in one would let that process choose the
 * port the Bridge connects to. These pin the token as the only thing that crosses, and pin the
 * three ways the control can be asked to do nothing.
 */
const bridgePanelWithToken = (token) => panelState({
  browserBridge: {
    enabled: true,
    connected: false,
    endpoint: "ws://127.0.0.1:43127/bachata-browser-bridge-v9",
    sessions: [],
    ...(token === undefined ? {} : { pairingToken: token }),
  },
});

const openBridgeInspector = (harness) => {
  harness.document.root.querySelector('[data-action="inspector-toggle"]').click();
  for (const details of harness.document.root.querySelectorAll("details")) {
    details.open = true;
    harness.document.root.dispatch("toggle", { target: details });
  }
};

test("copying the pairing token sends the token and nothing else to the clipboard", async () => {
  const token = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG0";
  const harness = bootWebview(managerState(), bridgePanelWithToken(token));
  try {
    openBridgeInspector(harness);
    const button = harness.document.root.querySelector('[data-action="bridge-copy-token"]');
    assert.ok(button, "the pairing token has no copy control");
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      harness.clipboard.writes,
      [token],
      "the clipboard carried something other than exactly the token",
    );
    const endpointCarried = harness.clipboard.writes.some((value) => value.includes("ws://"));
    assert.equal(endpointCarried, false, "an endpoint travelled with the token");
    assert.match(
      harness.document.liveStatus.textContent,
      /copied/iu,
      "the copy was not announced",
    );
  } finally {
    harness.restore();
  }
});

test("with no pairing token there is no copy control and nothing reaches the clipboard", () => {
  const harness = bootWebview(managerState(), bridgePanelWithToken(undefined));
  try {
    openBridgeInspector(harness);
    assert.equal(
      harness.document.root.querySelector('[data-action="bridge-copy-token"]'),
      null,
      "a copy control was offered with no token to copy",
    );
    assert.deepEqual(harness.clipboard.writes, [], "the clipboard was written without a token");
  } finally {
    harness.restore();
  }
});

test("a refused clipboard says so instead of reporting a copy that did not happen", async () => {
  const token = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG0";
  const harness = bootWebview(managerState(), bridgePanelWithToken(token));
  try {
    harness.clipboard.refuse = true;
    openBridgeInspector(harness);
    const button = harness.document.root.querySelector('[data-action="bridge-copy-token"]');
    button.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.clipboard.writes, [token], "the write was never attempted");
    assert.match(
      harness.document.liveStatus.textContent,
      /failed/iu,
      "a refused copy was not announced as a failure",
    );
    // The control is re-queried rather than held: a render between the click and the rejection
    // replaces the node, and a stale reference would report an empty label either way.
    const current = harness.document.root.querySelector('[data-action="bridge-copy-token"]');
    assert.notEqual(current?.textContent, "Copied", "a refused copy still claimed success");
  } finally {
    harness.restore();
  }
});

test("a read-only window offers the pairing token as readable, never as an action", () => {
  const token = "Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWprbG0";
  const harness = bootWebview(
    managerState({
      readOnly: {
        owned: false,
        reason: "Another Bachata Extension Host owns this workspace.",
        holderDescription: "pid 4242 on MacBook",
        holderLastSeenSecondsAgo: 12,
        retryCommand: "Bachata: Workspace Ownership",
      },
    }),
    bridgePanelWithToken(token),
  );
  try {
    openBridgeInspector(harness);
    // Discover and Reset change the workspace's pairing, so the read-only sweep must still refuse
    // them. Reading a token that is already on screen changes nothing and stays available.
    for (const action of ["bridge-discover", "bridge-reset"]) {
      const control = harness.document.root.querySelector(`[data-action="${action}"]`);
      assert.ok(control, `missing ${action}`);
      assert.equal(
        control.disabled === true || control.getAttribute("aria-disabled") === "true",
        true,
        `${action} stayed live in a read-only window`,
      );
    }
  } finally {
    harness.restore();
  }
});
