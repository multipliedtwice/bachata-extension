const assert = require("node:assert/strict");
const test = require("node:test");

const camel = (value) => value.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.localName = tagName.toLowerCase();
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
    // Custom properties only: this DOM does no layout, and code that places a floating menu writes
    // its measurements here. Reading one back says what was written, never what was rendered.
    this.style = {
      values: new Map(),
      setProperty(name, value) { this.values.set(name, String(value)); },
      getPropertyValue(name) { return this.values.get(name) ?? ""; },
      removeProperty(name) { this.values.delete(name); },
    };
  }

  focus() {
    if (document.activeElement === this) {
      return;
    }
    document.activeElement = this;
    // Focus moving is what dismisses a popover, so the fake document delivers focusin the way the
    // webview receives it. Without it a test cannot see a popover close behind restored focus.
    document.root.dispatch("focusin", { target: this });
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
    const parts = selector.split(",");
    let current = this;
    while (current) {
      if (parts.some((part) => matchesSelector(current, part))) {
        return current;
      }
      current = current.parentElement;
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

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector) {
    return document.root.elements.filter((element) => {
      let parent = element.parentElement;
      while (parent && parent !== this) parent = parent.parentElement;
      return parent === this && selector.split(",").some((part) => {
        if (part.trim().startsWith(":scope > ")) {
          return element.parentElement === this && matchesSelector(element, part.trim().slice(9));
        }
        return matchesSelector(element, part);
      });
    });
  }

  scrollIntoView() {}

  // Enough of a box for code that positions a floating menu against the viewport. This DOM does no
  // layout, so every rect is empty: what a test may assert here is that the positioning ran, never
  // where it landed. Widths are proven in `npm run test:webview-layout`, in a real browser.
  getBoundingClientRect() {
    return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
  }
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
  if (trimmed === "details:not([open])") return element.tagName === "DETAILS" && !element.open;
  const child = trimmed.lastIndexOf(" > ");
  if (child >= 0) return matchesSelector(element, trimmed.slice(child + 3)) && element.parentElement !== null && matchesSelector(element.parentElement, trimmed.slice(0, child));
  const descendant = trimmed.lastIndexOf(" ");
  if (descendant >= 0 && !trimmed.slice(0, descendant).includes('[title="')) {
    return matchesSelector(element, trimmed.slice(descendant + 1)) && Boolean(element.parentElement?.closest(trimmed.slice(0, descendant)));
  }
  if (trimmed.endsWith("[open]") && !element.open) return false;
  const prefix = trimmed.match(/^([a-z]+)?((?:\.[A-Za-z0-9_-]+)*)/u);
  if (prefix?.[1] && element.tagName !== prefix[1].toUpperCase()) return false;
  if (prefix?.[2] && !prefix[2].slice(1).split(".").every((name) => element.className.split(/\s+/u).includes(name))) return false;

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
  if (attributes.length === 0) return /^([a-z]+)?(?:\.[A-Za-z0-9_-]+)+$/u.test(trimmed);
  return attributes.every((match) => {
    const name = match[1];
    const expected = match[2];
    const actual = name === "open" ? (element.open ? "" : null) : name.startsWith("data-")
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
    // Open and close tags both, so an element knows what contains it. `closest` walks that chain,
    // and a popover is identified by the container it sits in rather than by its own class.
    const expression = /<(button|input|textarea|select|details|summary|section|article|footer|div|main|aside|p|pre|h1|h2|h3|ul|ol|li|small|span|strong)\b([^>]*)>|<\/(button|input|textarea|select|details|summary|section|article|footer|div|main|aside|p|pre|h1|h2|h3|ul|ol|li|small|span|strong)>/g;
    const open = [];
    for (const match of value.matchAll(expression)) {
      if (match[3] !== undefined) {
        const closing = open.at(-1);
        if (closing?.tagName === match[3].toUpperCase()) {
          closing.contentEnd = match.index;
          closing.textContent = value.slice(closing.contentStart, closing.contentEnd).replace(/<[^>]*>/gu, "").replace(/&amp;/gu, "&").replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">");
          open.pop();
        }
        continue;
      }
      const element = elementForTag(match[1]);
      element.contentStart = match.index + match[0].length;
      element.parentElement = open.at(-1) ?? this;
      // `input` closes itself, so it never becomes the parent of what follows it.
      if (match[1] !== "input") open.push(element);
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
    this.externalElements = new Map();
    this.documentElement = { scrollTop: 0 };
    this.root = new FakeRoot();
    this.liveStatus = new FakeHTMLElement("div");
    this.liveStatus.id = "bachata-live-status";
    this.elements.set("root", this.root);
    this.elements.set("bachata-live-status", this.liveStatus);
  }

  getElementById(id) {
    return this.externalElements.get(id) ?? this.elements.get(id) ?? null;
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

const installGlobals = (initialWebviewState) => {
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
  const webviewState = { value: initialWebviewState };
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

test("run tabs omit a pristine New run draft until it becomes meaningful", () => {
  const pristine = {
    ...conversationSummary(),
    id: "draft-1",
    runRef: "RNEW00001",
    title: "[RNEW00001] New run",
    selectedPipelineId: "custom-a",
    input: undefined,
    preparedDraft: undefined,
  };
  const harness = bootWebview(managerState({ conversations: [pristine], activeConversationId: pristine.id }), panelState());
  try {
    const root = harness.document.root;
    assert.equal(root.querySelector(".run-tab"), null);
    assert.ok(root.querySelector("#composer-prompt"));
    assert.ok(root.querySelector('[data-action="create-conversation"]'));
    root.querySelector('[data-action="run-drawer-toggle"]').click();
    assert.equal(root.querySelector(".run-drawer-item"), null);
    assert.ok(root.querySelector(".run-drawer-list .empty-list"));

    const prepared = { ...pristine, preparedDraft: "Fix the selected findings" };
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ conversations: [prepared], activeConversationId: prepared.id }) });
    assert.equal(root.querySelectorAll(".run-tab").length, 1);
    assert.equal(root.querySelectorAll(".run-drawer-item").length, 1);
    assert.equal(root.querySelector('.run-tab-tools [data-view="chat"]'), null);
    assert.equal(root.querySelector('.run-tab-tools [data-view="execution"]'), null);
  } finally { harness.restore(); }
});

test("run tabs omit their own reference while preserving readable bracketed titles", () => {
  const runs = [
    { ...conversationSummary(), id: "first", runRef: "R8HYQPMZ6", title: "[R8HYQPMZ6] Fix the tab order" },
    { ...conversationSummary(), id: "second", runRef: "RKJ2GFVKD", title: "[UI] Review accessibility" },
    { ...conversationSummary(), id: "third", runRef: "R23456789", title: "[R23456789] [UI] Review accessibility" },
  ];
  const harness = bootWebview(managerState({ conversations: runs, activeConversationId: "first" }), panelState());
  try {
    const tabs = harness.document.root.innerHTML.match(/<button class="run-tab-select"[\s\S]*?<\/button>/gu).join("\n");
    assert.match(tabs, /<span>Fix the tab order<\/span>/u);
    assert.match(tabs, /<span>\[UI\] Review accessibility<\/span>/u);
    assert.doesNotMatch(tabs, /\[(?:R8HYQPMZ6|RKJ2GFVKD|R23456789)\]/u);
    assert.equal(runs[0].title, "[R8HYQPMZ6] Fix the tab order");
  } finally { harness.restore(); }
});

test("run tabs keep creation order across selection activity snapshots and reload", () => {
  const runs = [
    { ...conversationSummary(), id: "first", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-12T00:00:00Z" },
    { ...conversationSummary(), id: "second", createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-11T00:00:00Z" },
    { ...conversationSummary(), id: "third", createdAt: "2026-09-02T00:00:00Z", updatedAt: "2026-09-10T00:00:00Z" },
  ];
  const order = (harness) => harness.document.root.querySelectorAll(".run-tab-select").map((tab) => tab.getAttribute("data-conversation"));
  const manager = managerState({ conversations: runs, activeConversationId: "first" });
  const harness = bootWebview(manager, panelState());
  try {
    assert.deepEqual(order(harness), ["first", "second", "third"]);
    for (const id of ["third", "second", "first", "third"]) {
      harness.document.root.querySelectorAll(".run-tab-select").find((tab) => tab.getAttribute("data-conversation") === id).click();
      assert.equal(harness.messages.at(-1).type, "conversation.select");
      manager.activeConversationId = id;
      manager.conversations = [...manager.conversations].reverse().map((run) => ({ ...run, updatedAt: run.id === id ? "2026-09-30T00:00:00Z" : run.updatedAt, unread: 2 }));
      harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
      assert.deepEqual(order(harness), ["first", "second", "third"]);
    }
    manager.conversations.push({ ...conversationSummary(), id: "fourth", createdAt: "2026-09-03T00:00:00Z" });
    harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
    assert.deepEqual(order(harness), ["first", "second", "third", "fourth"]);
  } finally { harness.restore(); }
  const restored = bootWebview(manager, panelState());
  try { assert.deepEqual(order(restored), ["first", "second", "third", "fourth"]); }
  finally { restored.restore(); }
});

test("the selected run tab owns view controls, notifications, and one grouped action menu", () => {
  const event = { id: 1, type: "run.started", status: "running", title: "Started", createdAt: timestamp };
  const harness = bootWebview(managerState({ eventsByConversation: { "run-1": [event] } }), panelState());
  try {
    const root = harness.document.root;
    const selected = root.querySelector(".run-tab.selected");
    assert.ok(selected);
    assert.equal(root.querySelector(".room-header"), null);
    assert.equal(root.querySelector(".view-switch"), null);
    assert.equal(selected.querySelectorAll(".run-tab-tools").length, 1);
    assert.equal(selected.querySelector('[data-view="chat"]').getAttribute("aria-label"), "Chat");
    assert.equal(selected.querySelector('[data-view="execution"]').getAttribute("aria-label"), "Execution");
    assert.equal(selected.querySelector('[data-view="chat"]').textContent, "");
    assert.equal(selected.querySelector('[data-view="execution"]').textContent, "");
    assert.equal(selected.querySelectorAll(".header-action-menu").length, 1);
    assert.equal(selected.querySelector(".header-action-menu > summary").id, "room-actions-button");
    assert.equal(selected.querySelectorAll(".run-action-menu-group").length, 3);
    assert.deepEqual(
      selected.querySelectorAll(".run-action-menu-label").map((label) => label.textContent),
      ["Run", "Workspace", "Danger zone"],
    );
    const notificationSettings = selected.querySelector('.notification-center [data-action="notification-settings"]');
    assert.ok(notificationSettings);
    assert.equal(selected.querySelector('.header-action-menu [data-action="notification-settings"]'), null);
  } finally {
    harness.restore();
  }
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

// The host resolves the assignment slots, so a panel fixture carries them the way a real snapshot
// does: one slot per participant the selected pipeline declares, each on its own default provider.
const assignmentStateFor = (definition, adapterTypes) => ({
  slots: (definition?.agents ?? []).map((agent) => ({
    agentId: agent.id,
    responsibility: agent.name,
    defaultAdapter: agent.adapter,
    assignedAdapter: agent.adapter,
    overridden: false,
  })),
  assignableAdapters: adapterTypes,
  // The host reports what it finished discovering; a fixture stands for a settled discovery pass.
  availableAdapters: adapterTypes,
  discovering: false,
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
  localInterpreter: {
    enabled: false,
    discovering: false,
    status: "disabled",
    detail: "Local interpretation is off. Deterministic extraction runs on its own.",
    explicit: false,
    availableModels: [],
  },
  agentAssignments: assignmentStateFor(
    overrides.selectedPipelineDefinition ?? pipelineDefinition(),
    overrides.adapterTypes ?? ["codex-app-server"],
  ),
  ...overrides,
});

const bootWebview = (manager = managerState(), panel = panelState(), localization, initialWebviewState) => {
  const harness = installGlobals(initialWebviewState);
  if (localization !== undefined) {
    const configuration = new FakeHTMLElement("script");
    configuration.id = "bachata-localization";
    configuration.setAttribute("type", "application/json");
    configuration.textContent = JSON.stringify(localization);
    harness.document.externalElements.set(configuration.id, configuration);
  }
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

// Pipeline editing lives inside the composer's settings panel. A person opens that panel before
// reaching Edit/New/Fork, so the tests do too; the toggle is idempotent, so this is safe to call
// even when the panel is already open.
const openComposerSettings = (harness) => {
  if (harness.document.getElementById("composer-settings")) return;
  harness.document.root.querySelector('[data-action="composer-settings-toggle"]').click();
};

test("composer controls have accessible names", () => {
  const harness = bootWebview();
  try {
    assert.equal(harness.document.getElementById("composer-prompt").getAttribute("aria-label"), "Run input");
    assert.equal(
      harness.document.root.querySelector('[data-action="attachment-pick"]').getAttribute("aria-label"),
      "Attach image, text, log, or specification",
    );
    assert.equal(harness.document.getElementById("pipeline-picker-button").getAttribute("aria-label"), "Pipeline");
  } finally {
    harness.restore();
  }
});

test("orchestration disclosure preserves user state across rerenders", () => {
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
    const states = [
      ["run-1:orchestration", false],
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
    openComposerSettings(harness);
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

test("a disabled Send opens actionable requirements outside the composer", () => {
  const harness = bootWebview(
    managerState(),
    panelState({
      workspaceRoots: ["/workspace", "/other"],
      workingDirectory: undefined,
      readiness: {
        status: "needsSetup",
        findings: [
          { id: "workspace", label: "Workspace", status: "ready", detail: "/workspace" },
          { id: "adapter.codex", label: "Codex", status: "needsSetup", detail: "codex unavailable: spawn codex ENOENT", remediationId: "provider.install.codex" },
        ],
      },
    }),
  );
  try {
    const html = harness.document.root.innerHTML;
    assert.equal(harness.document.root.querySelector(".composer-blockers"), null);
    assert.equal(harness.document.root.querySelector(".composer-note"), null);
    assert.doesNotMatch(html, /The run input is empty\./u);
    const send = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(send.getAttribute("aria-disabled"), "true");
    assert.match(send.getAttribute("aria-description"), /No working root is selected/u);
    assert.match(send.getAttribute("aria-description"), /codex unavailable/u);
    const beforeSend = harness.messages.length;
    send.click();
    const dialog = harness.document.root.querySelector(".app-dialog");
    assert.ok(dialog);
    assert.match(harness.document.root.innerHTML, /<strong>No working root is selected in this multi-root window\.<\/strong>/u);
    assert.match(harness.document.root.innerHTML, /<p>Resolve this before the run can start\.<\/p>/u);
    assert.equal(harness.messages.length, beforeSend, "opening requirements must not start a run");
    harness.document.root.querySelector('[data-action="readiness-remediate"]').click();
    assert.equal(harness.document.root.querySelector(".app-dialog"), null);
    assert.deepEqual(harness.messages.at(-1), {
      type: "readiness.remediate",
      remediationId: "provider.install.codex",
      detail: "codex unavailable: spawn codex ENOENT",
    });
  } finally { harness.restore(); }
});

test("advanced pipeline settings stay hidden until advanced mode is on", () => {
  const harness = bootWebview(managerState(), panelState());
  try {
    openComposerSettings(harness);
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
    openComposerSettings(harness);
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
    openComposerSettings(harness);
    harness.document.root.querySelector('[data-action="pipeline-new"]').click();
    assert.match(harness.document.root.innerHTML, /Pipeline editor/);
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-delete"]'), null);

    harness.document.root.querySelector('[data-action="pipeline-editor-close"]').click();
    openComposerSettings(harness);
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

test("Edit is reachable again through Settings after a save closed the panel behind the editor", () => {
  const harness = bootWebview();
  try {
    openComposerSettings(harness);
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    assert.match(harness.document.root.innerHTML, /Pipeline editor/);
    // Saving is a click inside the editor, which is a click outside the settings panel, so the
    // panel that offered Edit is dismissed behind the modal.
    harness.document.root.querySelector('[data-action="pipeline-save"]').click();
    assert.equal(harness.document.getElementById("composer-settings"), null, "the settings panel survived the editor");
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-edit"]'), null, "Edit was offered with the panel closed");
    // The visible route back: open Settings again, and Edit reopens the same saved pipeline.
    openComposerSettings(harness);
    const edit = harness.document.root.querySelector('[data-action="pipeline-edit"]');
    assert.ok(edit, "Settings did not offer Edit again");
    assert.equal(edit.disabled, false, "Edit came back disabled");
    edit.click();
    assert.match(harness.document.root.innerHTML, /Pipeline editor/);
    assert.equal(harness.document.root.querySelector('[data-editor-meta="id"]').value, "custom-a");
  } finally {
    harness.restore();
  }
});

test("pipeline editor sends revision-aware create and update mutations", () => {
  const updateHarness = bootWebview();
  try {
    openComposerSettings(updateHarness);
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
    openComposerSettings(createHarness);
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
    openComposerSettings(harness);
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

for (const changed of [false, true]) {
  test(`choosing the selected pipeline switches only when its definition changed: ${String(changed)}`, () => {
    const panel = panelState();
    if (changed) panel.pipelines.find((pipeline) => pipeline.id === panel.selectedPipelineId).hash = "c".repeat(64);
    const harness = bootWebview(managerState(), panel);
    try {
      harness.document.root.querySelector('[data-action="pipeline-picker-toggle"]').click();
      const before = harness.messages.length;
      harness.document.root.querySelector('[data-action="pipeline-picker-select"][data-pipeline-id="custom-a"]').click();
      assert.equal(harness.messages.length, before + (changed ? 1 : 0));
      if (changed) {
        assert.equal(harness.messages.at(-1).message.type, "pipeline.select");
        assert.equal(harness.messages.at(-1).message.pipelineId, "custom-a");
      }
    } finally {
      harness.restore();
    }
  });
}

test("pipeline selection locks editing until the selected definition is confirmed", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="pipeline-picker-toggle"]').click();
    harness.document.root.querySelector('[data-action="pipeline-picker-select"][data-pipeline-id="custom-b"]').click();
    const request = harness.messages.at(-1);
    assert.equal(request.message.type, "pipeline.select");
    assert.equal(request.message.pipelineId, "custom-b");
    // The picker button is locked while the switch is pending, and so is the editing behind the
    // settings panel.
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-picker-toggle"]').disabled, true);
    openComposerSettings(harness);
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-edit"]').disabled, true);
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-new"]').disabled, true);
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-picker-toggle"]').getAttribute("aria-busy"), "true");
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-picker-toggle"]').getAttribute("title"), "Switching to Custom B…");

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
    openComposerSettings(harness);
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
    openComposerSettings(harness);
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

    assert.match(harness.document.root.innerHTML, /2 decisions pending/u);
    assert.match(harness.document.root.innerHTML, /Execution \(2\)/u);
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
    assert.match(harness.document.root.innerHTML, /Lead’s final ruling/);
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

test("the latest ruling compares participants without duplicate round history or identities", () => {
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
    assert.doesNotMatch(html, /Iteration comparison|first ruling/u);
    assert.equal(harness.document.root.querySelectorAll(".final-ruling-card").length, 1);
    assert.match(html, /Compare participant conclusions/u);
    assert.match(html, /Lead proposal/u);
    assert.match(html, /Worker proposal/u);
    assert.match(html, /Validation errors/u);
    assert.match(html, /missing field: summary/u);
    assert.doesNotMatch(html, /Raised no objection\.|aaaaaaaaaaaa/u);
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

test("browser conversation binding lives inside the Agents popover", () => {
  const harness = bootWebview(
    managerState(),
    panelState({
      adapterTypes: ["chatgpt-browser", "codex-app-server", "claude-code"],
      selectedPipelineId: "browser-pipeline",
      selectedPipelineDefinition: {
        version: 1,
        id: "browser-pipeline",
        name: "Browser pipeline",
        agents: [{ id: "browser", name: "Browser Lead", adapter: "chatgpt-browser" }],
        roles: [{ id: "lead", name: "Lead", instructions: "Lead." }],
        steps: [
          {
            id: "assign",
            name: "Assign",
            enabled: true,
            humanGate: "none",
            type: "assignRoles",
            roleAssignments: [{ agentId: "browser", role: "lead" }],
          },
        ],
      },
      agents: {
        browser: {
          id: "browser",
          name: "Browser Lead",
          adapterType: "chatgpt-browser",
          status: "idle",
          output: "",
        },
      },
      // The host resolved this slot to the Lead role, so the row is named by the responsibility
      // rather than by the participant's provider-flavoured name.
      agentAssignments: {
        slots: [{
          agentId: "browser",
          responsibility: "Lead",
          roleId: "lead",
          defaultAdapter: "chatgpt-browser",
          assignedAdapter: "chatgpt-browser",
          overridden: false,
        }],
        assignableAdapters: ["chatgpt-browser", "codex-app-server", "claude-code"],
        availableAdapters: ["chatgpt-browser", "codex-app-server", "claude-code"],
        discovering: false,
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
    // The duplicate top-of-conversation binding panel is gone.
    assert.doesNotMatch(harness.document.root.innerHTML, /browser-binding-bar/u);
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    // The slot reads by its responsibility, not the participant's provider-flavoured name. The
    // fixture's participant is called "Browser Lead", so the exact markup is what separates them.
    assert.match(harness.document.root.innerHTML, /<strong>Lead<\/strong>/u);
    assert.doesNotMatch(harness.document.root.innerHTML, /<strong>Browser Lead<\/strong>/u);
    const option = harness.document.root.querySelector(
      '[data-action="agents-session"][data-agent="browser"][data-session="session-1"]',
    );
    assert.ok(option);
    option.click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime",
      conversationId: "run-1",
      message: {
        type: "agents.assign",
        agentId: "browser",
        adapter: "chatgpt-browser",
        browserSessionId: "session-1",
      },
    });
  } finally {
    harness.restore();
  }
});

test("Agents popover reassigns a browser slot to a local CLI", () => {
  const harness = bootWebview(
    managerState(),
    panelState({
      adapterTypes: ["chatgpt-browser", "codex-app-server", "claude-code"],
      selectedPipelineId: "browser-pipeline",
      selectedPipelineDefinition: {
        version: 1,
        id: "browser-pipeline",
        name: "Browser pipeline",
        agents: [{ id: "builder", name: "Builder participant", adapter: "chatgpt-browser" }],
        roles: [{ id: "builder", name: "Builder", instructions: "Build." }],
        steps: [
          {
            id: "assign",
            name: "Assign",
            enabled: true,
            humanGate: "none",
            type: "assignRoles",
            roleAssignments: [{ agentId: "builder", role: "builder" }],
          },
        ],
      },
      agents: {
        builder: {
          id: "builder",
          name: "Builder participant",
          adapterType: "chatgpt-browser",
          status: "idle",
          output: "",
        },
      },
    }),
  );
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    const provider = harness.document.getElementById("agents-provider-builder");
    assert.ok(provider);
    provider.value = "claude-code";
    harness.document.root.dispatch("change", { target: provider });
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime",
      conversationId: "run-1",
      message: {
        type: "agents.assign",
        agentId: "builder",
        adapter: "claude-code",
      },
    });
  } finally {
    harness.restore();
  }
});

const assignmentPanel = (overrides = {}, panelOverrides = {}) =>
  panelState({
    ...panelOverrides,
    adapterTypes: ["chatgpt-browser", "codex-app-server", "claude-code"],
    selectedPipelineId: "browser-pipeline",
    selectedPipelineDefinition: {
      version: 1,
      id: "browser-pipeline",
      name: "Browser pipeline",
      agents: [{ id: "builder", name: "Builder participant", adapter: "chatgpt-browser" }],
      roles: [{ id: "builder", name: "Builder", instructions: "Build." }],
      steps: [],
    },
    agents: {
      builder: {
        id: "builder",
        name: "Builder participant",
        adapterType: "chatgpt-browser",
        status: "idle",
        output: "",
      },
    },
    agentAssignments: {
      slots: [{
        agentId: "builder",
        responsibility: "Builder",
        roleId: "builder",
        defaultAdapter: "chatgpt-browser",
        assignedAdapter: "chatgpt-browser",
        overridden: false,
      }],
      assignableAdapters: ["chatgpt-browser", "codex-app-server", "claude-code"],
      availableAdapters: ["chatgpt-browser", "codex-app-server", "claude-code"],
      discovering: false,
      adapterModels: {},
      ...overrides,
    },
  });

// The same popover with the Builder slot moved to a CLI, which is where a model can be chosen.
const cliAssignmentPanel = (assignmentOverrides = {}, slotOverrides = {}) => {
  const panel = assignmentPanel(assignmentOverrides);
  panel.agents.builder.adapterType = "codex-app-server";
  panel.agentAssignments.slots = [{
    agentId: "builder",
    responsibility: "Builder",
    roleId: "builder",
    defaultAdapter: "chatgpt-browser",
    assignedAdapter: "codex-app-server",
    overridden: true,
    ...slotOverrides,
  }];
  return panel;
};

const chooseAgentOption = (harness, id, value) => {
  const select = harness.document.getElementById(id);
  assert.ok(select);
  select.value = value;
  harness.document.root.dispatch("change", { target: select });
};

test("a CLI slot offers every provider-reported model through a labeled selector", () => {
  const harness = bootWebview(managerState(), cliAssignmentPanel({
    adapterModels: {
      "codex-app-server": { status: "listed", models: [
        { id: "provider-model-one", label: "Model one", isDefault: true },
        { id: "provider-model-two", label: "Model two" },
      ] },
    },
  }));
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    const select = harness.document.getElementById("agents-model-select-builder");
    assert.equal(select.getAttribute("aria-label"), "Model for Builder");
    const options = harness.document.root.innerHTML.match(/<select id="agents-model-select-builder"[^>]*>([\s\S]*?)<\/select>/u)?.[1] ?? "";
    assert.equal(options.match(/<option /gu)?.length, 4);
    assert.match(options, /Provider default · Model one/u);
    assert.equal(harness.document.root.querySelector("details.agents-slot-settings"), null);
    assert.equal(harness.document.root.querySelector(".agents-model-explicit"), null);
    assert.equal(harness.messages.some((entry) => entry.message?.type === "agents.model.discover"), false);
    chooseAgentOption(harness, "agents-model-select-builder", "provider-model-two");
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime", conversationId: "run-1",
      message: { type: "agents.model.select", agentId: "builder", model: "provider-model-two" },
    });
  } finally { harness.restore(); }
});

test("choosing the provider default clears the selected model", () => {
  const harness = bootWebview(managerState(), cliAssignmentPanel({
    adapterModels: { "codex-app-server": { status: "listed", models: [{ id: "provider-model", label: "Model" }] } },
  }, { assignedModel: "provider-model" }));
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    chooseAgentOption(harness, "agents-model-select-builder", "");
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime", conversationId: "run-1",
      message: { type: "agents.model.select", agentId: "builder" },
    });
  } finally { harness.restore(); }
});

test("opening Agents loads unknown catalogs once per provider without starting a run", () => {
  const panel = cliAssignmentPanel();
  panel.agentAssignments.slots.push({ ...panel.agentAssignments.slots[0], agentId: "reviewer", responsibility: "Reviewer" });
  const harness = bootWebview(managerState(), panel);
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    harness.document.getElementById("agents-picker-button").click();
    harness.document.getElementById("agents-picker-button").click();
    const requests = harness.messages.filter((entry) => entry.message?.type === "agents.model.discover");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].message.agentId, "builder");
    assert.equal(harness.messages.some((entry) => ["pipeline.run", "message.send"].includes(entry.message?.type)), false);
    assert.ok(harness.document.root.querySelector('[data-action="agents-model-discover"]'));
  } finally { harness.restore(); }
});

test("a provider without a catalog exposes exact model entry without a disclosure", () => {
  const harness = bootWebview(managerState(), cliAssignmentPanel({
    adapterModels: { "codex-app-server": { status: "unsupported", models: [], detail: "No listing method" } },
  }));
  try {
    harness.document.getElementById("agents-picker-button").click();
    assert.match(harness.document.root.innerHTML, /Model list unavailable/u);
    const input = harness.document.getElementById("agents-model-input-builder");
    assert.ok(input);
    assert.equal(input.closest("details"), null);
    input.value = "provider-exact-alias";
    harness.document.root.dispatch("input", { target: input });
    harness.document.root.querySelector('[data-action="agents-model-apply"][data-agent="builder"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime", conversationId: "run-1",
      message: { type: "agents.model.select", agentId: "builder", model: "provider-exact-alias" },
    });
  } finally { harness.restore(); }
});

test("entering a custom model from a known catalog opens a field without changing the assignment", () => {
  const harness = bootWebview(managerState(), cliAssignmentPanel({
    adapterModels: { "codex-app-server": { status: "listed", models: [{ id: "reported-model", label: "Reported model" }] } },
  }));
  try {
    harness.document.getElementById("agents-picker-button").click();
    const before = harness.messages.length;
    chooseAgentOption(harness, "agents-model-select-builder", "__bachata_custom_model__");
    assert.equal(harness.messages.length, before);
    const input = harness.document.getElementById("agents-model-input-builder");
    assert.ok(input);
    assert.equal(harness.document.activeElement, input);
    input.value = "provider-exact-alias";
    harness.document.root.dispatch("input", { target: input });
    harness.document.root.querySelector('[data-action="agents-model-apply"]').click();
    assert.deepEqual(harness.messages.at(-1).message, { type: "agents.model.select", agentId: "builder", model: "provider-exact-alias" });
  } finally { harness.restore(); }
});

test("a model no longer listed stays selected and is identified as unlisted", () => {
  const harness = bootWebview(managerState(), cliAssignmentPanel({
    adapterModels: { "codex-app-server": { status: "listed", models: [{ id: "provider-current", label: "Current" }] } },
  }, { assignedModel: "provider-previous" }));
  try {
    harness.document.getElementById("agents-picker-button").click();
    assert.ok(harness.document.getElementById("agents-model-select-builder"));
    const options = harness.document.root.innerHTML.match(/<select id="agents-model-select-builder"[^>]*>([\s\S]*?)<\/select>/u)?.[1] ?? "";
    assert.match(options, /<option value="provider-previous" selected>provider-previous · not listed<\/option>/u);
  } finally { harness.restore(); }
});

test("a browser slot leaves model selection in the connected website", () => {
  const harness = bootWebview(managerState(), assignmentPanel());
  try {
    harness.document.getElementById("agents-picker-button").click();
    assert.match(harness.document.root.innerHTML, /Choose the model in the connected browser conversation/u);
    assert.equal(harness.document.root.querySelector(".agents-model-select"), null);
    assert.equal(harness.messages.some((entry) => entry.message?.type === "agents.model.discover"), false);
  } finally { harness.restore(); }
});

test("a provider selector is labeled and exposes the current provider", () => {
  const harness = bootWebview(managerState(), assignmentPanel());
  try {
    harness.document.getElementById("agents-picker-button").click();
    const select = harness.document.getElementById("agents-provider-builder");
    assert.equal(select.getAttribute("aria-label"), "Provider for Builder");
    const options = harness.document.root.innerHTML.match(/<select id="agents-provider-builder"[^>]*>([\s\S]*?)<\/select>/u)?.[1] ?? "";
    assert.match(options, /<option value="" selected>/u);
    assert.match(options, /<option value="codex-app-server"/u);
    assert.match(options, /<option value="claude-code"/u);
  } finally { harness.restore(); }
});

test("model catalogs remain discoverable while an interrupted run keeps its assignments", () => {
  const panel = cliAssignmentPanel({ lockReason: "Reset this run before reassigning agents" });
  const harness = bootWebview(managerState(), panel);
  try {
    harness.document.getElementById("agents-picker-button").click();
    assert.equal(harness.messages.filter((entry) => entry.message?.type === "agents.model.discover").length, 1);
    assert.equal(harness.document.getElementById("agents-provider-builder").disabled, true);
    assert.equal(harness.document.getElementById("agents-model-select-builder").disabled, true);
    const refresh = harness.document.root.querySelector('[data-action="agents-model-discover"]');
    assert.equal(refresh.disabled, false);
    refresh.click();
    assert.equal(harness.messages.filter((entry) => entry.message?.type === "agents.model.discover").length, 2);
    assert.ok(harness.document.root.querySelector(".agents-locked"));
    assert.match(harness.document.root.innerHTML, /<span>This run keeps its original providers and models\.<\/span>/u);
    assert.ok(harness.document.root.querySelector('.agents-locked [data-action="create-conversation"]'));
    const before = harness.messages.length;
    chooseAgentOption(harness, "agents-model-select-builder", "wrong-model");
    assert.equal(harness.messages.length, before);
  } finally { harness.restore(); }
});

test("archived runs expose no provider or model mutation controls", () => {
  const harness = bootWebview(managerState({ conversations: [{ ...conversationSummary(), archived: true }] }), cliAssignmentPanel());
  try {
    assert.equal(harness.document.getElementById("agents-picker-button"), null);
    assert.equal(harness.document.getElementById("agents-provider-builder"), null);
    assert.equal(harness.document.getElementById("agents-model-select-builder"), null);
    assert.equal(harness.document.root.querySelector('[data-action="agents-model-discover"]'), null);
    assert.equal(harness.document.root.querySelector(".agents-model-explicit"), null);
    assert.equal(harness.messages.some((entry) => entry.message?.type === "agents.model.discover"), false);
  } finally { harness.restore(); }
});

test("Escape closes the Agents popover", () => {
  const harness = bootWebview(managerState(), assignmentPanel());
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.ok(harness.document.getElementById("agents-popover"));
    harness.document.root.dispatch("keydown", {
      key: "Escape",
      target: harness.document.getElementById("agents-picker-button"),
      preventDefault: () => undefined,
    });
    assert.equal(harness.document.getElementById("agents-popover"), null);
  } finally {
    harness.restore();
  }
});

test("a locked assignment states why and offers no control", () => {
  const harness = bootWebview(
    managerState(),
    assignmentPanel({ lockReason: "Clear the queue before reassigning agents" }),
  );
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /Clear the queue before reassigning agents/u);
    const selectors = Array.from(harness.document.root.querySelectorAll('.agents-provider-select, .agents-model-select'));
    assert.ok(selectors.length > 0);
    assert.equal(selectors.every((select) => select.disabled === true), true);
    assert.equal(harness.document.root.querySelector('[data-action="agents-reset-all"]'), null);
  } finally {
    harness.restore();
  }
});

test("a responsibility that changes hands is explained rather than offered as one control", () => {
  const harness = bootWebview(
    managerState(),
    assignmentPanel({ constraint: "Builder changes hands between steps, so it is assigned per participant below." }),
  );
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /changes hands between steps/u);
  } finally {
    harness.restore();
  }
});

test("a provider still being discovered is pending, never missing", () => {
  const harness = bootWebview(
    managerState(),
    assignmentPanel({ availableAdapters: [], discovering: true }),
  );
  try {
    // The trigger says a pass is running rather than implying nothing is installed.
    const trigger = harness.document.getElementById("agents-picker-button");
    assert.match(trigger.getAttribute("aria-label"), /Discovering agents/u);
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /Discovering agents on this machine…/u);
    // A CLI nobody has finished checking is offered and marked pending, not struck out as absent.
    assert.match(harness.document.root.innerHTML, /Codex CLI · checking…/u);
    assert.doesNotMatch(harness.document.root.innerHTML, /was not found on this machine/u);
  } finally {
    harness.restore();
  }
});

test("a provider discovery finished and did not find is named as not found", () => {
  const harness = bootWebview(
    managerState(),
    assignmentPanel({ availableAdapters: ["chatgpt-browser"], discovering: false }),
  );
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.doesNotMatch(harness.document.root.innerHTML, /checking…/u);
    assert.match(harness.document.root.innerHTML, /Codex CLI was not found on this machine/u);
  } finally {
    harness.restore();
  }
});

const localInterpreterPanel = (local) =>
  assignmentPanel({}, {
    localInterpreter: {
      enabled: true,
      discovering: false,
      explicit: false,
      availableModels: [],
      ...local,
    },
  });

test("a ready local interpreter names its backend, model and who chose it", () => {
  const harness = bootWebview(managerState(), localInterpreterPanel({
    status: "ready",
    detail: "qwen2.5-coder:7b on http://127.0.0.1:11434",
    backend: "ollama",
    backendLabel: "Ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen2.5-coder:7b",
    availableModels: [
      { id: "qwen2.5-coder:7b", backend: "ollama", availability: "loaded" },
      { id: "deepseek-r1:8b", backend: "ollama", availability: "installed" },
    ],
  }));
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /Local interpreter/u);
    assert.match(harness.document.root.innerHTML, /Ollama/u);
    assert.match(harness.document.root.innerHTML, /qwen2\.5-coder:7b/u);
    // Both a model list and an explicit automatic choice are offered.
    assert.match(harness.document.root.innerHTML, /Choose automatically/u);
    const override = harness.document.root.querySelector('[data-action="local-model-select"][data-model="deepseek-r1:8b"]');
    assert.ok(override);
    override.click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime",
      conversationId: "run-1",
      message: { type: "localModel.select", model: "deepseek-r1:8b" },
    });
  } finally {
    harness.restore();
  }
});

test("choosing automatic selection clears the pinned model", () => {
  const harness = bootWebview(managerState(), localInterpreterPanel({
    status: "ready",
    detail: "deepseek-r1:8b on http://127.0.0.1:11434",
    backend: "ollama",
    backendLabel: "Ollama",
    model: "deepseek-r1:8b",
    explicit: true,
    availableModels: [{ id: "deepseek-r1:8b", backend: "ollama", availability: "loaded" }],
  }));
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /your choice/u);
    const automatic = harness.document.root.querySelectorAll('[data-action="local-model-select"]')[0];
    automatic.click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime",
      conversationId: "run-1",
      message: { type: "localModel.select" },
    });
  } finally {
    harness.restore();
  }
});

test("each local interpreter failure is reported as its own distinct problem", () => {
  const cases = [
    ["serverUnavailable", "No local inference server answered. Start Ollama or LM Studio", /No local inference server answered/u],
    ["noSuitableModel", "No suitable model is available. A local server is running but has no models installed", /No suitable model is available/u],
    ["configuredModelUnavailable", "The model you selected is not available: gone-model", /model you selected is not available/u],
  ];
  for (const [status, detail, pattern] of cases) {
    const harness = bootWebview(managerState(), localInterpreterPanel({ status, detail }));
    try {
      harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
      assert.match(harness.document.root.innerHTML, pattern);
      // A blocked interpreter never reads as "ready" and never names a model it does not have.
      assert.doesNotMatch(harness.document.root.innerHTML, /Local interpreter<\/strong><small>your choice/u);
    } finally {
      harness.restore();
    }
  }
});

test("an unverified model is offered as pending, not claimed ready", () => {
  const harness = bootWebview(managerState(), localInterpreterPanel({
    status: "unverified",
    detail: "llama3.2:3b on http://127.0.0.1:11434 — not yet checked against the interpreter contract",
    backend: "ollama",
    backendLabel: "Ollama",
    model: "llama3.2:3b",
  }));
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /not yet checked against the interpreter contract/u);
  } finally {
    harness.restore();
  }
});

test("a locked run cannot change the model the bridge is already healing with", () => {
  const harness = bootWebview(managerState(), assignmentPanel(
    { lockReason: "Assignments are locked while this run is in flight." },
    {
      running: true,
      localInterpreter: {
        enabled: true,
        discovering: false,
        status: "ready",
        detail: "qwen2.5-coder:7b on http://127.0.0.1:11434",
        backend: "ollama",
        backendLabel: "Ollama",
        model: "qwen2.5-coder:7b",
        explicit: false,
        availableModels: [{ id: "qwen2.5-coder:7b", backend: "ollama", availability: "loaded" }],
      },
    },
  ));
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    const choices = Array.from(harness.document.root.querySelectorAll('[data-action="local-model-select"]'));
    assert.ok(choices.length > 0);
    assert.equal(choices.every((choice) => choice.disabled === true), true);
  } finally {
    harness.restore();
  }
});

test("a blocked interpreter is labelled unavailable rather than automatic", () => {
  const harness = bootWebview(managerState(), localInterpreterPanel({
    status: "serverUnavailable",
    detail: "No local inference server answered.",
  }));
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /<strong>Local interpreter<\/strong><small>unavailable<\/small>/u);
  } finally {
    harness.restore();
  }
});

test("local interpretation that is off is not drawn at all", () => {
  const harness = bootWebview(managerState(), assignmentPanel());
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    assert.doesNotMatch(harness.document.root.innerHTML, /Local interpreter/u);
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
    assert.match(harness.document.root.innerHTML, /Waiting for capacity/);
    const cancel = harness.document.root.querySelector('[data-action="interrupt-run"]');
    assert.ok(cancel);
    assert.match(harness.document.root.innerHTML, /Cancel wait/);
    assert.equal(harness.document.root.querySelector('[data-action="submit-message"]'), null);
    assert.equal(cancel.getAttribute("aria-label"), "Cancel wait");
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

    openComposerSettings(harness);
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
    openComposerSettings(harness);
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

test("composer hides run options behind the settings control and flags active options", () => {
  const harness = bootWebview(managerState(), panelState({ selectedPipelineDefinition: pipelineDefinition() }));
  try {
    assert.doesNotMatch(harness.document.root.innerHTML, /id="pipeline-iterations"/u);
    // The settings control is a fixed-size icon button, not a labelled Options control that grows
    // with its chip text.
    const settings = harness.document.root.querySelector('[data-action="composer-settings-toggle"]');
    assert.ok(settings, "the composer settings control was not rendered");
    assert.doesNotMatch(settings.className, /has-chips/u);
    harness.document.root.querySelector('[data-action="composer-settings-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /class="composer-advanced"/u);
    assert.match(harness.document.root.innerHTML, /id="pipeline-iterations"/u);
    // The run options are stated as run-local, not as edits to the saved pipeline.
    assert.match(harness.document.root.innerHTML, /do not change the saved pipeline/u);
    const delivery = harness.document.root.querySelector("#message-delivery");
    delivery.value = "queue";
    harness.document.root.dispatch("change", { target: delivery });
    // An active option is marked on the settings control without changing its size.
    assert.match(harness.document.root.querySelector('[data-action="composer-settings-toggle"]').className, /has-chips/u);
    assert.match(harness.document.root.innerHTML, /data-action="submit-message" data-delivery="queue"/u);
  } finally {
    harness.restore();
  }
});

test("the composer is one rounded surface with a compact icon-send toolbar", () => {
  const harness = bootWebview();
  try {
    const html = harness.document.root.innerHTML;
    // The native pipeline select is gone from the composer entirely.
    assert.equal(harness.document.getElementById("pipeline-select"), null, "the native pipeline select is still in the composer");
    // A single surface encloses the prompt and the toolbar: attach, picker, settings, then the send
    // group, all on one row. The send group is inside the same toolbar rather than a row of its own.
    assert.match(html, /class="composer-surface">[\s\S]*id="composer-prompt"[\s\S]*class="composer-toolbar">[\s\S]*data-action="attachment-pick"[\s\S]*class="pipeline-picker"[\s\S]*data-action="composer-settings-toggle"[\s\S]*class="composer-send"[\s\S]*data-action="submit-message"/u);
    // Send is an icon carrying its accessible label, with no permanent shortcut text eating a row.
    const send = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(send.getAttribute("aria-label"), "Send");
    assert.match(send.getAttribute("class"), /icon-send/u);
    assert.doesNotMatch(html, /class="composer-hint"/u, "a permanent shortcut hint consumes toolbar width");
    // No standalone contract row above the prompt.
    const beforePrompt = html.slice(0, html.indexOf('id="composer-prompt"'));
    assert.doesNotMatch(beforePrompt, /class="run-contract"/u, "a standalone contract row sits above the prompt");
  } finally {
    harness.restore();
  }
});

test("the pipeline picker is a keyboard combobox that selects a pipeline", () => {
  const harness = bootWebview();
  try {
    const button = harness.document.getElementById("pipeline-picker-button");
    assert.equal(button.getAttribute("role"), "combobox");
    assert.equal(button.getAttribute("aria-expanded"), "false");
    assert.equal(harness.document.getElementById("pipeline-picker-list"), null, "the listbox is drawn while the picker is closed");
    button.click();
    const opened = harness.document.getElementById("pipeline-picker-button");
    assert.equal(opened.getAttribute("aria-expanded"), "true");
    assert.equal(opened.getAttribute("aria-controls"), "pipeline-picker-list");
    const list = harness.document.getElementById("pipeline-picker-list");
    assert.equal(list.getAttribute("role"), "listbox");
    const search = harness.document.getElementById("pipeline-picker-search");
    assert.equal(harness.document.activeElement.id, "pipeline-picker-search");
    assert.equal(search.getAttribute("aria-controls"), "pipeline-picker-list");
    const selectedOption = harness.document.root.querySelector('[data-action="pipeline-picker-select"][data-pipeline-id="custom-a"]');
    assert.equal(selectedOption.getAttribute("role"), "option");
    assert.equal(selectedOption.getAttribute("aria-selected"), "true");
    // ArrowDown moves the active option, Enter commits it, and the runtime is asked to switch.
    harness.document.root.dispatch("keydown", { key: "ArrowDown", target: search, preventDefault: () => undefined });
    harness.document.root.dispatch("keydown", { key: "Enter", target: harness.document.getElementById("pipeline-picker-search"), preventDefault: () => undefined });
    const request = harness.messages.at(-1);
    assert.equal(request.message.type, "pipeline.select");
    assert.equal(request.message.pipelineId, "custom-b");
    assert.equal(harness.document.getElementById("pipeline-picker-list"), null, "committing left the picker open");
  } finally {
    harness.restore();
  }
});

for (
  const popover of [
    {
      name: "pipeline",
      toggle: '[data-action="pipeline-picker-toggle"]',
      button: "pipeline-picker-button",
      drawn: '[data-action="pipeline-picker-select"]',
    },
    {
      name: "agents",
      toggle: '[data-action="agents-picker-toggle"]',
      button: "agents-picker-button",
      drawn: '[data-agents-provider-for]',
    },
  ]
) {
  test(`the ${popover.name} popover survives the render that opens it, with focus elsewhere`, () => {
    const harness = bootWebview();
    try {
      // Focus is on another control when the popover is opened — the run drawer's own trigger,
      // where closing the drawer leaves it. The render that draws the popover replaces the tree,
      // and restoring focus to that control is focus leaving the popover, which dismisses it in
      // the frame it opened.
      const elsewhere = harness.document.root.querySelector('[data-action="run-drawer-toggle"]');
      elsewhere.focus();
      const toggle = harness.document.root.querySelector(popover.toggle);
      harness.document.root.dispatch("click", {
        target: toggle,
        preventDefault: () => undefined,
        stopPropagation: () => undefined,
      });
      assert.ok(
        harness.document.root.querySelector(popover.drawn),
        `the ${popover.name} popover closed behind the focus the render restored`,
      );
      assert.equal(
        harness.document.activeElement.id,
        popover.button,
        `the ${popover.name} popover left focus outside itself`,
      );
    } finally {
      harness.restore();
    }
  });
}

test("Escape closes the pipeline picker and restores focus to its button", () => {
  const harness = bootWebview();
  try {
    harness.document.getElementById("pipeline-picker-button").click();
    assert.ok(harness.document.getElementById("pipeline-picker-list"), "the picker did not open");
    harness.document.root.dispatch("keydown", { key: "Escape", target: harness.document.getElementById("pipeline-picker-button"), preventDefault: () => undefined });
    assert.equal(harness.document.getElementById("pipeline-picker-list"), null, "Escape left the picker open");
    assert.equal(harness.document.activeElement.id, "pipeline-picker-button", "Escape did not return focus to the picker button");
  } finally {
    harness.restore();
  }
});

test("Enter in the prompt never selects a pipeline when a picker popover was left open", () => {
  const harness = bootWebview();
  try {
    // Open the picker, then move focus into the prompt without closing it explicitly.
    harness.document.getElementById("pipeline-picker-button").click();
    assert.ok(harness.document.getElementById("pipeline-picker-list"), "the picker did not open");
    const prompt = harness.document.getElementById("composer-prompt");
    prompt.focus();
    const before = harness.messages.length;
    // Enter is the prompt's key now — the combobox keyboard is scoped to the picker's own focus, so
    // a stale popover cannot hijack it into selecting a pipeline.
    harness.document.root.dispatch("keydown", { key: "Enter", target: prompt, preventDefault: () => undefined });
    assert.equal(
      harness.messages.slice(before).filter((message) => message.message?.type === "pipeline.select").length,
      0,
      "Enter in the prompt selected a pipeline through a left-open popover",
    );
  } finally {
    harness.restore();
  }
});

test("the pipeline trigger hands keyboard focus to search", () => {
  const harness = bootWebview();
  try {
    harness.document.getElementById("pipeline-picker-button").click();
    assert.ok(harness.document.getElementById("pipeline-picker-list"), "the picker did not open");
    assert.equal(harness.document.activeElement.id, "pipeline-picker-search");
    harness.document.getElementById("pipeline-picker-button").focus();
    harness.document.root.dispatch("keydown", { key: "Tab", target: harness.document.getElementById("pipeline-picker-button"), preventDefault: () => undefined });
    assert.equal(harness.document.activeElement.id, "pipeline-picker-search");
    assert.ok(harness.document.getElementById("pipeline-picker-list"));
  } finally {
    harness.restore();
  }
});

test("keyboard users can filter and select a specialized pipeline", () => {
  const specialized = { id: "specialized-z", name: "Zebra specialized review", editable: false, hash: "c".repeat(64), scopeKey: "builtin" };
  const base = panelState();
  const harness = bootWebview(managerState(), { ...base, pipelines: [...base.pipelines, specialized] });
  const key = (value, shiftKey = false) => {
    let prevented = false;
    harness.document.root.dispatch("keydown", {
      key: value, shiftKey, target: harness.document.activeElement, preventDefault() { prevented = true; },
    });
    if (!prevented && value === "Enter") harness.document.activeElement.click();
  };
  try {
    harness.document.getElementById("pipeline-picker-button").focus();
    key("ArrowDown");
    assert.ok(harness.document.getElementById("pipeline-picker-list"));
    harness.document.root.querySelector('[data-action="pipeline-picker-filter"][data-pipeline-filter="specialized"]').click();
    assert.ok(harness.document.root.querySelector('[data-pipeline-id="specialized-z"]'));
    harness.document.getElementById("pipeline-picker-search").focus();
    key("End");
    key("Enter");
    assert.equal(harness.messages.filter((entry) => entry.message?.type === "pipeline.select").at(-1).message.pipelineId, specialized.id);
    assert.equal(harness.document.getElementById("pipeline-picker-list"), null);
  } finally { harness.restore(); }
});

test("category selection is remembered and Escape returns to the picker trigger", () => {
  const base = panelState();
  const harness = bootWebview(managerState(), { ...base, pipelines: [...base.pipelines, { id: "specialized", name: "Specialized", editable: false, hash: "c".repeat(64), scopeKey: "builtin" }] });
  try {
    harness.document.getElementById("pipeline-picker-button").click();
    harness.document.root.querySelector('[data-action="pipeline-picker-filter"][data-pipeline-filter="specialized"]').click();
    assert.equal(harness.webviewState.value.pipelinePickerFilter, "specialized");
    const search = harness.document.getElementById("pipeline-picker-search");
    harness.document.root.dispatch("keydown", { key: "Escape", target: search, preventDefault: () => undefined });
    assert.equal(harness.document.getElementById("pipeline-picker-list"), null);
    assert.equal(harness.document.activeElement.id, "pipeline-picker-button");
    harness.document.getElementById("pipeline-picker-button").click();
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-picker-filter"][aria-pressed="true"]').getAttribute("data-pipeline-filter"), "specialized");
  } finally { harness.restore(); }
});

test("the picker describes the workflow shape while Agents owns participant names", () => {
  const harness = bootWebview(managerState(), panelState({
    pipelines: [
      { id: "custom-a", name: "Custom A", editable: true, hash: customAHash, scopeKey: "workspace:/workspace", scopeRoot: "/workspace" },
      { id: "custom-b", name: "Custom B", editable: true, hash: customBHash, scopeKey: "workspace:/workspace", scopeRoot: "/workspace", participantCount: 3, participantNames: ["Alpha", "Beta", "Gamma"], stepCount: 5 },
    ],
  }));
  try {
    // At rest the trigger is name + chevron only — no metadata crowding the closed composer.
    assert.doesNotMatch(harness.document.root.innerHTML, /pipeline-picker-meta/u);
    harness.document.getElementById("pipeline-picker-button").click();
    const html = harness.document.root.innerHTML;
    // The selected pipeline derives its shape from the definition on hand.
    assert.match(html, /Custom A<\/span>[\s\S]*?class="pipeline-picker-option-meta">1 step · 1 participant</u);
    assert.doesNotMatch(html, /class="pipeline-picker-option-participants"/u);
    // A non-selected pipeline shows the names and counts the host supplied on its summary — the
    // metadata does not disappear for pipelines other than the selected one.
    assert.match(html, /Custom B<\/span>[\s\S]*?5 steps · 3 participants/u);
    assert.doesNotMatch(html, /Alpha, Beta, Gamma/u);
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
    // Run details live inside the composer's settings panel now, so it is opened the way a person
    // would before the contract is on screen.
    openComposerSettings(harness);
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
    assert.match(html, /Each requested review adds 1 round, including at the round limit/u);
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
    assert.match(html, /Ruled by Claude/u);
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
    assert.match(html, /No ruling provenance was recorded/u);
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
    assert.match(html, /This contract grants no write authority, so changed files are not expected/u);
    assert.doesNotMatch(html, /<h3>Changed files<\/h3>|<h3>Verification<\/h3>/u);

    harness.document.root.querySelector('[data-action="result-publish-findings"]').click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.publishFindings",
      conversationId: "run-1",
    });
  } finally {
    harness.restore();
  }
});

test("a run that died before a ruling names the failure and is never drawn as inconclusive", () => {
  const harness = bootWebview();
  try {
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        resultsByConversation: {
          "run-1": {
            status: "error",
            changedFiles: [],
            checks: [],
            // The providers this run was reassigned to, not the browser defaults it shipped with.
            providers: [
              { agentId: "builder", name: "Builder", adapter: "claude-code" },
              { agentId: "lead", name: "Lead", adapter: "codex-app-server", model: "gpt-6-astra" },
            ],
            findings: [],
            unresolvedRisks: [],
            recoveredErrors: [],
            expectations: { changedFiles: false, verification: false, finalRuling: true },
            evidence: [],
            evidenceGaps: [],
            failure: {
              error: 'Codex at /Users/reader/.local/bin/codex (0.146.0) does not offer the selected model "gpt-6-astra".',
              agentId: "lead",
              participant: "Lead",
              adapter: "codex-app-server",
              model: "gpt-6-astra",
              step: "Cross-check",
            },
            finalAssessment: {
              outcome: "failedBeforeRuling",
              method: "none",
              summary: "Failed before final ruling: Lead (codex-app-server · gpt-6-astra) at step Cross-check — Codex rejected the model",
              producedBy: [
                { agentId: "builder", name: "Builder", adapter: "claude-code" },
                { agentId: "lead", name: "Lead", adapter: "codex-app-server", model: "gpt-6-astra" },
              ],
              failure: {
                error: 'Codex at /Users/reader/.local/bin/codex (0.146.0) does not offer the selected model "gpt-6-astra".',
                agentId: "lead",
                participant: "Lead",
                adapter: "codex-app-server",
                model: "gpt-6-astra",
                step: "Cross-check",
              },
            },
          },
        },
      }),
    });

    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Failed before final ruling/u);
    assert.doesNotMatch(html, /Inconclusive/u, "a failed run is never dressed as an assessment");
    // The exact participant, provider, model, step and provider error.
    assert.match(html, /data-run-failure="true"/u);
    assert.match(html, /Lead/u);
    assert.match(html, /codex-app-server/u);
    assert.match(html, /gpt-6-astra/u);
    assert.match(html, /Cross-check/u);
    assert.match(html, /does not offer the selected model/u);
    // The providers that actually ran, never the browser defaults the pipeline shipped with.
    assert.match(html, /claude-code/u);
    assert.doesNotMatch(html, /chatgpt-browser|claude-browser/u);
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

test("typed findings use one concise count and show actionable evidence", () => {
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
    assert.match(html, /<ul class="result-finding-list">/u);
    assert.doesNotMatch(html, /<details[^>]*result-finding-details/u);
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
    assert.ok(harness.document.root.querySelector(".app-dialog"));
    assert.match(harness.document.root.innerHTML, /<strong>Codex: codex unavailable: spawn codex ENOENT<\/strong>/u);
  } finally {
    harness.restore();
  }
});

test("a keyboard submit starts a run with no contract to acknowledge", () => {
  // The composer used to refuse Ctrl/Cmd+Enter until the execution contract was acknowledged.
  // Reading the run details is evidence, never a gate, so the ordinary path is: type, then send.
  const harness = bootWebview(managerState(), panelState());
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
      true,
      "a keyboard submit did not start the run",
    );
    // And no acknowledgement control is drawn anywhere.
    assert.equal(harness.document.root.querySelector('[data-action="contract-acknowledge"]'), null);
    assert.doesNotMatch(harness.document.root.innerHTML, /Acknowledge contract/u);
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

const openWorkspaceDirection = (harness) => {
  if (!harness.document.getElementById("run-drawer")) {
    harness.document.root.querySelector('[data-action="run-drawer-toggle"]').click();
  }
  harness.document.root.querySelector('.run-drawer-direction').click();
};

const directionState = (overrides = {}) => ({
  ...structuredClone(require("./fixtures/webview-layout/direction.json")),
  ...overrides,
});

test("Direction replaces record identities with labeled selectors and keeps merge choices across refresh", () => {
  const direction = directionState();
  const source = { ...direction.direction.outstandingAcceptedFindings[0], identity: "finding-source-secret" };
  const target = { ...source, identity: "finding-target-secret", subject: "Guard the cancellation cleanup", location: { file: "src/cleanup.ts", startLine: 20 } };
  direction.findings = [source, target];
  direction.direction.outstandingAcceptedFindings = [source];
  const harness = bootWebview(managerState({ direction }));
  try {
    openWorkspaceDirection(harness);
    harness.document.root.querySelector('[data-action="finding-merge"][data-record="finding-source-secret"]').click();
    let select = harness.document.getElementById("app-dialog-input");
    assert.equal(select.tagName, "SELECT");
    assert.match(harness.document.root.innerHTML, /Guard the cancellation cleanup · src\/cleanup\.ts:20/u);
    assert.doesNotMatch(harness.document.root.innerHTML.replace(/<[^>]*>/gu, " "), /finding-(?:source|target)-secret/u);
    select.value = target.identity;
    harness.document.root.dispatch("change", { target: select });
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ direction }) });
    select = harness.document.getElementById("app-dialog-input");
    assert.match(harness.document.root.innerHTML, /<option value="finding-target-secret" selected>/u);
    select.value = target.identity;
    harness.document.getElementById("app-dialog-delta").value = "Both describe the same skipped cleanup.";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "finding.merge", absorbedIdentity: source.identity, canonicalIdentity: target.identity, reason: "Both describe the same skipped cleanup." });
  } finally { harness.restore(); }
});

test("Direction supersede choices are existing records and reject missing replacements", () => {
  const direction = directionState();
  const source = { ...direction.direction.decisionsNeedingHuman[0], id: "decision-source-secret" };
  const replacement = { ...source, id: "decision-replacement-secret", subject: "Resume only after user input", state: "accepted", revision: 2 };
  direction.decisions = [source, replacement];
  direction.direction.decisionsNeedingHuman = [source];
  const harness = bootWebview(managerState({ direction }));
  try {
    openWorkspaceDirection(harness);
    harness.document.root.querySelector('[data-action="resolve-record"][data-record="decision-source-secret"][data-resolution="supersede"]').click();
    const select = harness.document.getElementById("app-dialog-input");
    assert.equal(select.tagName, "SELECT");
    assert.match(harness.document.root.innerHTML, /Resume only after user input · revision 2 · Accepted/u);
    select.value = "missing-record";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(harness.messages.some((message) => message.type === "resolution.apply"), false);
    assert.match(harness.document.getElementById("app-dialog-error").textContent, /Choose an available replacement record/u);
    harness.document.getElementById("app-dialog-input").value = replacement.id;
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.deepEqual(harness.messages.at(-1), { type: "resolution.apply", target: "decision", id: source.id, action: "supersede", supersededById: replacement.id });
  } finally { harness.restore(); }
});

test("Direction uses accessible secondary panels and keeps internal references out of labels", () => {
  const direction = directionState();
  const harness = bootWebview(managerState({ direction }));
  try {
    openWorkspaceDirection(harness);
    const center = harness.document.root.querySelector(".direction-center");
    assert.equal(center.querySelectorAll("details").length, 0);
    const text = harness.document.root.innerHTML.replace(/<[^>]*>/gu, " ");
    assert.doesNotMatch(text, /main@111111|Finding identity|Supporting decisions: D|first seen in cycle|last seen in cycle/u);
    let toggle = harness.document.root.querySelector('[data-action="direction-section-toggle"][data-section="direction-initiative"]');
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    const contentId = toggle.getAttribute("aria-controls");
    assert.equal(harness.document.getElementById(contentId).hasAttribute("hidden"), true);
    toggle.click();
    toggle = harness.document.root.querySelector('[data-action="direction-section-toggle"][data-section="direction-initiative"]');
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(harness.document.getElementById(contentId).hasAttribute("hidden"), false);
  } finally { harness.restore(); }
});

test("the direction surface answers the top-level questions without a transcript", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    openWorkspaceDirection(harness);
    const html = harness.document.root.innerHTML;
    for (const marker of [
      "Project direction",
      "Accepted direction",
      "Review progress",
      "Artifacts",
      "Decisions to resolve",
      "Findings to resolve",
      "Accepted findings to fix",
      "Cancellation never leaks a worktree",
      "Guard the cleanup path in the controller",
      "Resolve decisions",
      "Regressions",
      "Decision changes",
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

test("run notices link pending project decisions without repeating the project goal", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("direction-banner"));
    assert.equal(html.includes("Cancellation never leaks a worktree"), false);
    assert.ok(html.includes("2 project decisions to resolve"));
    assert.ok(html.includes("Review direction"));
  } finally {
    harness.restore();
  }
});

test("the direction surface sends initiative, cycle, fresh review, and resolution intents", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    openWorkspaceDirection(harness);
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
    openWorkspaceDirection(harness);
    const html = harness.document.root.innerHTML;
    for (const marker of [
      "Repository and checks",
      ">main<",
      "Repository changed.",
      "npm test",
      "Manage initiatives",
      "Merged findings",
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
    openWorkspaceDirection(harness);
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
    openWorkspaceDirection(harness);
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
    openWorkspaceDirection(harness);
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
    openWorkspaceDirection(harness);
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
    openWorkspaceDirection(harness);
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("Some changes could not be saved"), html.slice(0, 400));
    assert.ok(html.includes("Decision 2 has no evidence"));
    assert.ok(html.includes("The review round for R1 was not recorded"));
  } finally {
    harness.restore();
  }
});

test("superseding a record requires an explicit replacement that is not itself", () => {
  const direction = directionState();
  direction.decisions = [{ ...direction.direction.decisionsNeedingHuman[0], id: "D9", subject: "Manual resumption", state: "accepted" }];
  const harness = bootWebview(managerState({ direction }));
  try {
    openWorkspaceDirection(harness);
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

test("empty project direction remains reachable without adding an empty run notice", () => {
  const harness = bootWebview();
  try {
    const html = harness.document.root.innerHTML;
    assert.equal(harness.document.root.querySelector('.run-tabs [data-view="direction"]'), null);
    assert.equal(html.includes("direction-banner"), false);
    assert.equal(html.includes("No goal is recorded"), false);
    openWorkspaceDirection(harness);
    assert.ok(harness.document.root.querySelector(".direction-center"));
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
    openWorkspaceDirection(harness);
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("Define the goal"));
    assert.ok(html.includes("Decisions to resolve"));
    assert.ok(harness.document.getElementById("initiative-goal"));
  } finally {
    harness.restore();
  }
});

test("the notification bell shows an unread count and keeps each notification in its panel", () => {
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
    assert.equal(html.includes("notification-bubble"), false);
    assert.ok(html.includes(">Discard<"), "Bachata owns that retained worktree");
    assert.equal(html.includes("never enter a reviewer prompt"), false);

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

    harness.document.root.querySelector('.notification-center [data-action="notification-settings"]').click();
    const mode = harness.document.getElementById("notification-mode");
    mode.value = "off";
    harness.document.root.dispatch("change", { target: mode });
    assert.deepEqual(harness.messages.at(-1), { type: "notifications.setMode", mode: "off" });
  } finally {
    harness.restore();
  }
});

test("notifications turned off keep settings behind the bell without a badge or inline bubble", () => {
  const harness = bootWebview(managerState({
    notifications: { mode: "off", unread: 0, events: [] },
  }));
  try {
    const html = harness.document.root.innerHTML;
    assert.equal(html.includes("notification-unread"), false);
    assert.equal(html.includes("notification-bubble"), false);
    assert.equal(html.includes("notification-center"), true);
    assert.match(html, /Notifications are off\./u);
    harness.document.root.querySelector('.notification-center [data-action="notification-settings"]').click();
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
    openWorkspaceDirection(harness);
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
  direction.findings = [
    { ...direction.direction.latestChange.newMaterial[0], identity: "FH77", subject: "Unbounded retry loop in the worker" },
    { ...direction.direction.latestChange.newMaterial[0], identity: "FH11", subject: "Unbounded retry loop in the worker queue" },
    { ...direction.direction.latestChange.newMaterial[0], identity: "FH12", subject: "Unbounded retry loop in the worker poller" },
  ];
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
    openWorkspaceDirection(harness);
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("Possible duplicate findings"));
    assert.ok(html.includes("Ambiguous match"));
    assert.ok(html.includes("Unbounded retry loop in the worker queue"));
    assert.ok(html.includes("strong match, 100%"));
    assert.equal(html.includes("10000%"), false);

    harness.messages.length = 0;
    harness.document.root
      .querySelector('[data-action="finding-merge"][data-candidate="FH11"]')
      .click();
    assert.match(harness.document.root.innerHTML, /<option value="FH11" selected>/u);
  } finally {
    harness.restore();
  }
});

test("provider history metadata does not create an empty Execution view", () => {
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
    const html = harness.document.root.innerHTML;
    assert.equal(harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]'), null);
    assert.doesNotMatch(html, /provider-history|Where this run's provider history lives|history reconstructable|history unavailable|It never stores a full provider transcript/u);
  } finally {
    harness.restore();
  }
});

test("the project notice links to Direction and its primary action uses a concrete verb", () => {
  const harness = bootWebview(managerState({ direction: directionState() }));
  try {
    assert.ok(
      harness.document.root.innerHTML.includes('data-view="direction">Review direction</button>'),
      "the project notice has no route to Direction",
    );
    openWorkspaceDirection(harness);
    const centre = harness.document.root.innerHTML;
    assert.ok(
      /data-action="direction-next-action"[^>]*>Resolve decisions<\/button>/u.test(centre),
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
    openWorkspaceDirection(harness);
    const html = harness.document.root.innerHTML;
    for (const marker of [
      "History",
      "Retry ownership",
      "Vendor the parser",
      "Cancellation guard",
      "Replaced by: Earlier decision",
      "Replaces: Earlier decision",
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
    openWorkspaceDirection(harness);
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

for (const readOnly of [undefined, {
  owned: false,
  reason: "Another window owns this workspace",
  retryCommand: "Take ownership",
}]) test(`history filtering remains available ${readOnly ? "without ownership" : "with ownership"}`, () => {
  const harness = bootWebview(managerState({
    ...(readOnly ? { readOnly } : {}),
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
    openWorkspaceDirection(harness);
    assert.ok(harness.document.root.innerHTML.includes("Retry budget"));
    const filter = harness.document.root.querySelector("#history-filter");
    assert.notEqual(filter.readOnly, true);
    assert.notEqual(filter.getAttribute("aria-disabled"), "true");
    const beforeFiltering = harness.messages.length;
    filter.value = "cancellation";
    harness.document.root.dispatch("input", { target: filter });
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("Cancellation guard"), "the filter hid the record it matched");
    assert.ok(!html.includes("Retry budget"), "the filter kept a record it did not match");
    assert.equal(harness.messages.length, beforeFiltering);
    if (readOnly) {
      harness.document.root.querySelector('[data-action="room-view"][data-view="chat"]').click();
      const prompt = harness.document.getElementById("composer-prompt");
      assert.equal(prompt.readOnly, true);
      assert.equal(prompt.getAttribute("aria-disabled"), "true");
    }
  } finally {
    harness.restore();
  }
});

test("a surfaced judgment keeps options readable and groups supporting evidence", () => {
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
    openWorkspaceDirection(harness);
    const html = harness.document.root.innerHTML;
    for (const marker of [
      ">Options<",
      "Caller owns it",
      ">Evidence<",
      "Both traced the unbounded loop",
      ">Challenges<",
      "Traced to src/retry.ts:23",
      "Open the run that produced this",
    ]) {
      assert.ok(html.includes(marker), `a judgment card is missing: ${marker}`);
    }
  } finally {
    harness.restore();
  }
});

test("a bare judgment retains its question without empty metadata panels", () => {
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
    openWorkspaceDirection(harness);
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("What should happen?"));
    assert.equal(html.includes("No recommendation was supplied."), false);
    assert.equal(html.includes("No options were supplied."), false);
    assert.equal(html.includes("No evidence was supplied."), false);
    assert.equal(harness.document.root.querySelector('[data-section="decision-evidence-D1"]'), null);
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
    assert.doesNotMatch(first, /class="notification-bubble"/u);
    assert.equal(first.split("Review converged: 1 needs you.").length - 1, 1);

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
    assert.doesNotMatch(second, /class="notification-bubble"/u);
    assert.equal(second.split("Review converged: 1 needs you.").length - 1, 1);
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

    const ownership = harness.document.root.querySelector('[data-action="workspace-ownership"]');
    assert.ok(ownership, "the banner offers no direct ownership action");
    assert.match(html, /data-action="workspace-ownership"[^>]*>Take ownership<\/button>/u);
    assert.equal(ownership.getAttribute("aria-disabled"), null, "the ownership action was disabled by the read-only sweep");
    const beforeOwnership = harness.messages.length;
    ownership.click();
    assert.deepEqual(harness.messages.slice(beforeOwnership), [{ type: "workspace.ownership" }]);

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

test("a read-only manager snapshot without panel state never claims pipelines are still loading", () => {
  const harness = installGlobals();
  try {
    delete require.cache[require.resolve("../dist/webview-behavior.js")];
    delete require.cache[require.resolve("../dist/webview.js")];
    require("../dist/webview-behavior.js");
    require("../dist/webview.js");
    harness.sendWindowMessage({
      type: "manager.snapshot",
      state: managerState({
        readOnly: {
          owned: false,
          reason: "Another Bachata Extension Host owns this workspace.",
          retryCommand: "Bachata: Workspace Ownership",
        },
      }),
    });
    assert.doesNotMatch(harness.document.root.innerHTML, /Loading pipelines/u);
    assert.match(harness.document.root.innerHTML, /Pipeline unavailable/u);
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
    openComposerSettings(harness);
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    harness.document.root.querySelector('[data-action="pipeline-save"]').click();
    const update = harness.messages.at(-1);
    assert.equal(update.message.mode, "update");
    assert.equal(Object.hasOwn(update.message, "expectedHash"), true);

    harness.document.root.querySelector('[data-action="pipeline-editor-close"]').click();
    openComposerSettings(harness);
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
    assert.doesNotMatch(html, /Candidate tree|tree-9f13c2/u);
    assert.doesNotMatch(html, /Output reference|runs\/run-1\/checks\/check-types\.log/u);
    // A check that recorded only an exit status still shows it, and invents no other field.
    assert.match(html, /npm test/u);
    assert.match(html, /Exit status<\/dt><dd>1<\/dd>/u);
    assert.equal((html.match(/Candidate tree/gu) ?? []).length, 0);
    assert.equal((html.match(/Output reference/gu) ?? []).length, 0);
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
  openComposerSettings(harness);
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
    // Acknowledgement is gone entirely: run details are evidence a reader may open, never a gate.
    assert.equal(
      harness.document.root.querySelectorAll('[data-action="contract-acknowledge"]').length,
      0,
      "an acknowledgement control is still drawn",
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
    assert.equal(
      harness.document.root.innerHTML.includes("notification-bubble"),
      false,
      "the closed centre duplicated the notification outside its panel",
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
    openComposerSettings(harness);
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
  primaryAction: 'class="composer-send"',
  blockers: 'data-action="run-requirements"',
  bell: "notification-center",
  directionBanner: "direction-banner",
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
    const shouldShow = marker === "bell" || expected.visible.includes(marker);
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
    assert.doesNotMatch(html, /<(?:p|strong|li)[^>]*>The run input is empty\./u);
    assert.equal(harness.document.root.querySelector(".run-requirements-list"), null);
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
    assertMatrixRow("running", html, { visible: ["taskInput", "primaryAction"] });
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
      allowedActions: ["continue", "cancel"],
      rollbackTargets: [],
    },
  }));
  try {
    const html = harness.document.root.innerHTML;
    assertMatrixRow("blocking human input", html, {
      visible: ["taskInput", "primaryAction", "executionTab", "blockingBanner"],
    });
    assert.match(html, /1 decision pending/u);
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
    assert.doesNotMatch(html, /<h3>Changed files<\/h3>/u);
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
      visible: ["taskInput", "primaryAction", "directionBanner"],
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
    openComposerSettings(harness);
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
    assert.match(html, /class="room-status status-paused sr-only"><span[^>]*>Waiting for you<\/span>/u, "the selected tab contradicts the gate");
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
    // The contract's own listing lives in the settings panel's run details; the blockers list is
    // always in the composer. Opening the panel is what puts both on screen at once.
    openComposerSettings(harness);
    const html = harness.document.root.innerHTML;
    assert.equal((html.match(/<li>Shell access is disabled by policy\.<\/li>/gu) ?? []).length, 1, "the contract states the refusal under two headings");
    assert.match(html, /<h3>Repository policy refuses this run<\/h3>/u);
    assert.match(html, /<h3>Unresolved before running<\/h3><ul class="contract-list"><li>No git repository at \/workspace<\/li><\/ul>/u);
    assert.doesNotMatch(html, /<h4>/u, "the contract skips a heading level");
    const send = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(send.getAttribute("aria-disabled"), "true", "a refused run still offers Send");
    const status = harness.document.root.querySelector('[data-action="run-requirements"]');
    assert.match(status.getAttribute("aria-label"), /^Blocked\./u);
    assert.match(send.getAttribute("aria-description"), /^Shell access is disabled by policy\. This repository.{1,6}s policy file refuses this run/u);
    assert.doesNotMatch(send.getAttribute("aria-description"), /Fix|Discard|Stop/u, "button labels leak into the description");
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
    harness.document.root.querySelector('[data-action="run-requirements"]').click();
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

test("the settings panel opens in flow with its control pointing at it", () => {
  const harness = bootWebview();
  try {
    const toggle = harness.document.root.querySelector('[data-action="composer-settings-toggle"]');
    // Closed, the panel is not rendered, so the control names nothing. An aria-controls pointing at
    // an absent id is an ARIA error, and assistive technology drops the relationship outright.
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-controls"), null, "the closed control points at an element that does not exist");
    assert.equal(harness.document.getElementById("composer-settings"), null);
    toggle.click();
    const opened = harness.document.root.querySelector('[data-action="composer-settings-toggle"]');
    assert.equal(opened.getAttribute("aria-expanded"), "true");
    assert.equal(opened.getAttribute("aria-controls"), "composer-settings");
    assert.ok(harness.document.getElementById("composer-settings"), "aria-controls names an element that exists");
    assert.ok(harness.document.getElementById("composer-advanced"), "the run options live inside the settings panel");
    harness.document.root.dispatch("keydown", { key: "Escape", target: harness.document.getElementById("pipeline-iterations"), preventDefault: () => undefined });
    assert.equal(harness.document.activeElement.dataset.action, "composer-settings-toggle", "Escape left focus on the body");
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
    workflowStatus: "error",
    resumableWorkflow: recoverableWorkflow({ userPrompt: "x", nextStepIndex: 0, totalSteps: 2 }),
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
    // Rename lives in the run tab's action menu now, not on a room title.
    harness.document.root.querySelector('[data-action="run-rename"]').click();
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

test("run details stay closed until requested and the reader's choice survives re-renders", () => {
  const harness = bootWebview(managerState(), panelState({ executionContract: reviewContract() }));
  try {
    openComposerSettings(harness);
    const details = harness.document.root.querySelector('[data-disclosure-key="run-1:composer:contract"]');
    assert.ok(details, "the run details disclosure was not rendered inside the settings panel");
    assert.equal(details.open, false, "run details opened before the reader asked for them");
    // The reader opens it; a genuine toggle differs from what was drawn, so it is recorded.
    details.open = true;
    harness.document.root.dispatch("toggle", { target: details });
    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "state.snapshot", state: panelState({ executionContract: reviewContract(), transcript: [{ id: "a", kind: "answer", agentId: "lead", text: "Hi", createdAt: timestamp }], transcriptTotal: 1 }) },
    });
    const reopened = harness.document.root.querySelector('[data-disclosure-key="run-1:composer:contract"]');
    assert.equal(reopened.open, true, "the reader's choice to open run details was lost");
    // A toggle that only echoes the rendered-open state is not a fresh choice and must not clear it.
    reopened.open = true;
    harness.document.root.dispatch("toggle", { target: reopened });
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
    assert.equal(harness.document.root.querySelector('[data-disclosure-key="run-1:composer:contract"]').open, true, "an echo overwrote the reader's choice");
  } finally {
    harness.restore();
  }
});

test("switching runs opens the next run on its chat", () => {
  const second = { ...conversationSummary(), id: "run-2", runRef: "run-2", title: "Second" };
  const harness = bootWebview(managerState({ conversations: [conversationSummary(), second] }), panelState());
  try {
    openWorkspaceDirection(harness);
    assert.ok(harness.document.root.querySelector('.direction-center'));
    harness.document.root.querySelector('[data-action="select-conversation"][data-conversation="run-2"]').click();
    // The next run opens on its chat — the composer only renders in the chat view — and the
    // previous run's Direction view does not follow the reader.
    assert.ok(harness.document.getElementById("composer-prompt"), "the next run did not open on its chat");
    assert.equal(harness.document.root.querySelector('.direction-center'), null);
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
    assert.match(harness.document.root.innerHTML, /<section class="run-outcome status-completed" aria-label="Run result">.*Nothing to fix\..*data-action="room-view" data-view="execution">Open the result<\/button><\/div><\/section>/u);
    assert.equal(harness.document.root.querySelector('[data-action="workflow-restart"]'), null, "a completed run offers recovery");
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

test("a render landing between the press and the browser's toggle keeps the menu open", () => {
  // `toggle` is dispatched asynchronously, so a render scheduled in the same frame rebuilds the
  // panel from the recorded disclosure state. Recording only on `toggle` meant that state still
  // said closed, and the menu the reader had just opened was drawn shut — intermittently, because
  // it only happens when a render lands in that window.
  const harness = bootWebview();
  try {
    const root = harness.document.root;
    const menu = root.querySelector(".run-action-menu");
    assert.ok(menu, "the run tab has no action menu to press");
    const summary = root.querySelectorAll("summary").find((candidate) => candidate.parentElement === menu);
    assert.ok(summary, "the action menu has no summary to press");
    summary.click();
    // The render the reader never asked for: a snapshot arriving from the host.
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
    assert.equal(
      root.querySelector(".run-action-menu").open,
      true,
      "a redraw between the press and the toggle closed the menu the reader had just opened",
    );
  } finally {
    harness.restore();
  }
});

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
    const outside = root.querySelector('[data-action="composer-settings-toggle"]');
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

test("a read-only window disables pairing mutations", () => {
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

test("run details still describe permissions and human decisions, and gate nothing", () => {
  // Removing the acknowledgement must not remove the evidence. The contract is still published and
  // still readable from the composer's settings; it simply no longer holds the run.
  const harness = bootWebview(managerState(), panelState({
    executionContract: {
      pipelineName: "Builder + lead + QA + UX",
      safetyLevel: "guarded",
      commitPolicy: "never",
      scope: {
        workingDirectory: "/workspace",
        writeScope: "task",
        writablePaths: ["src"],
        readablePaths: ["."],
        protectedPaths: [".git"],
      },
      providers: [{ agentId: "codex", name: "Codex", adapter: "codex-app-server", status: "ready", roles: ["Builder"] }],
      humanGates: [{ stepName: "Final specialist consensus", gate: "after" }],
      roles: [],
      verification: [],
      verificationResources: [],
      limits: { maxIterations: 1 },
      fallbacks: [],
      completion: [],
      blockers: [],
    },
  }));
  try {
    // A task is entered, because an empty prompt is a real blocker and would mask the point.
    const prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "perform UI/UX review of extension";
    harness.document.root.dispatch("input", { target: prompt });
    harness.document.root.querySelector('[data-action="composer-settings-toggle"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Run details/u);
    assert.match(html, /Scope and commits/u);
    assert.match(html, /Human decisions/u);
    assert.match(html, /Protected paths: \.git/u, "real filesystem restrictions are still stated");
    assert.match(html, /Final specialist consensus/u, "configured human gates are still stated");
    // And none of it is a precondition for sending.
    assert.equal(harness.document.root.querySelector('[data-action="contract-acknowledge"]'), null);
    const send = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.notEqual(send.getAttribute("aria-disabled"), "true", "Send is held by the contract");
  } finally {
    harness.restore();
  }
});

const threeStepPipelineDefinition = () => ({
  ...pipelineDefinition(),
  steps: [
    { id: "plan", name: "Plan", enabled: true, humanGate: "none", type: "agent", participants: ["lead"], promptTemplate: "{{userPrompt}}", parallel: false, consensus: false, attachments: "selected" },
    { id: "implement", name: "Implement", enabled: true, humanGate: "none", type: "agent", participants: ["lead"], promptTemplate: "{{userPrompt}}", parallel: false, consensus: false, attachments: "selected" },
    { id: "review", name: "Review", enabled: true, humanGate: "none", type: "agent", participants: ["lead"], promptTemplate: "{{userPrompt}}", parallel: false, consensus: false, attachments: "selected" },
    { id: "sign-off", name: "Sign off", enabled: false, humanGate: "none", type: "agent", participants: ["lead"], promptTemplate: "{{userPrompt}}", parallel: false, consensus: false, attachments: "selected" },
  ],
});

const stepEvent = (id, stepId, name, createdAt) => ({
  id,
  type: "step.started",
  status: "running",
  title: name,
  payload: { stepId, index: id },
  createdAt,
});

test("the pipeline summary states one row per enabled step, with the state the events prove", () => {
  const harness = bootWebview(
    managerState({
      eventsByConversation: {
        "run-1": [
          { id: 1, type: "run.started", status: "running", title: "Test run", createdAt: timestamp },
          stepEvent(2, "plan", "Plan", timestamp),
          stepEvent(3, "implement", "Implement", timestamp),
          { id: 4, type: "run.failed", status: "failed", title: "Test run", payload: { message: "provider refused" }, createdAt: timestamp },
        ],
      },
    }),
    panelState({ selectedPipelineDefinition: threeStepPipelineDefinition() }),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("pipeline-summary"), "no compact pipeline summary was drawn");
    // A disabled step is not part of this run, so it is not a row that could be "waiting".
    assert.ok(!html.includes("Sign off"), "a disabled step must not appear as a pipeline row");
    const rowState = (name) => {
      const marker = html.indexOf(`>${name}<`);
      assert.notEqual(marker, -1, `no pipeline row for ${name}`);
      const start = html.lastIndexOf('class="pipeline-step pipeline-step-', marker);
      return html.slice(start + 'class="pipeline-step pipeline-step-'.length, html.indexOf('"', start + 'class="pipeline-step pipeline-step-'.length));
    };
    assert.equal(rowState("Plan"), "completed", "a step the run moved past is completed");
    assert.equal(rowState("Implement"), "failed", "the step the run stopped in is the failed one");
    assert.equal(rowState("Review"), "waiting", "a step that never started is waiting, not skipped");
    assert.equal((html.match(/<li class="pipeline-step pipeline-step-/gu) ?? []).length, 3);
    assert.doesNotMatch(html, /Raw event history|workflow-timeline/);
  } finally {
    harness.restore();
  }
});

test("step rows keep empty bookkeeping out and place participant work under its step", () => {
  const harness = bootWebview(
    managerState({
      eventsByConversation: {
        "run-1": [
          stepEvent(1, "plan", "Plan", timestamp),
          { id: 2, type: "output.validated", status: "completed", title: "plan-output", payload: { agentId: "lead" }, createdAt: timestamp },
        ],
      },
    }),
    panelState({
      selectedPipelineDefinition: threeStepPipelineDefinition(),
      transcript: [{
        id: "plan-answer",
        kind: "answer",
        agentId: "lead",
        step: "Plan",
        text: "The implementation should preserve the existing state boundary.",
        createdAt: timestamp,
      }],
      transcriptTotal: 1,
    }),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.doesNotMatch(html, /plan-output|No activity was recorded|Technical detail/u);
    assert.match(html, /1 participant result/u);
    assert.match(html, /The implementation should preserve the existing state boundary\./u);
    assert.match(html, /data-action="focus-agent-output"[^>]*data-message-id="plan-answer"/u);
    assert.equal(rowStateIn(html, "Plan"), "running");
    assert.equal(rowStateIn(html, "Review"), "waiting");
    assert.ok(!/Elapsed|Duration/u.test(html), "no duration is stated where none was recorded");
  } finally {
    harness.restore();
  }
});

test("a completed result can be copied or continued in a prepared implementation run", async () => {
  const result = completedResult({
    readableMarkdown: "# Run result: Completed\n\nOne defect confirmed.\n\n## Final ruling\n\nFix the confirmed layout regression.\n\n## Findings\n\n- [accepted] Result actions are missing: The completed run cannot feed an implementation run.",
    continuation: { available: true, resultVersion: "result-version-1" },
    finalRuling: "Fix the confirmed layout regression.",
    finalAssessment: { outcome: "completed", method: "singleProvider", summary: "One defect confirmed.", producedBy: [] },
    findings: [{
      id: "finding-1",
      subject: "Result actions are missing",
      message: "The completed run cannot feed an implementation run.",
      disposition: "accepted",
      evidence: ["The result header exposes exports only."],
      challenges: [],
      provenance: { source: "stepOutput", stepId: "review", participantIds: ["lead"] },
    }],
  });
  const harness = bootWebview(
    managerState({ resultsByConversation: { "run-1": result } }),
    panelState({ workflowStatus: "completed" }),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    harness.document.root.querySelector('[data-action="result-details-toggle"]').click();
    const copy = harness.document.root.querySelector('[data-action="result-copy"]');
    const start = harness.document.root.querySelector('[data-action="result-continue"]');
    assert.ok(copy, "the completed result has no copy action");
    assert.ok(start, "the completed result has no implementation action");
    copy.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(harness.clipboard.writes.at(-1), /^# Run result:/u);
    assert.match(harness.clipboard.writes.at(-1), /Result actions are missing/u);
    harness.messages.length = 0;
    start.click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.continueFromResult",
      conversationId: "run-1",
      resultVersion: "result-version-1",
      findingIds: ["finding-1"],
    });
  } finally {
    harness.restore();
  }
});

// The compact summary answers "where is this run", and a restart is a new answer to that question.
// Folding every attempt in conversation history into one set of rows showed a restarted run the
// state of the attempt it replaced — completed steps it has not reached yet, and a failure that
// already happened.

const attemptStart = (id, type, createdAt, steps) => ({
  id,
  type,
  status: "running",
  title: "Test run",
  createdAt,
  attempt: {
    pipelineHash: "a".repeat(64),
    steps: steps ?? [
      { id: "plan", name: "Plan" },
      { id: "implement", name: "Implement" },
      { id: "review", name: "Review" },
    ],
  },
});

// The real projection sends the step identifier as its own field; the panel never receives payloads.
const projectedStepEvent = (id, stepId, name, createdAt) => ({
  id,
  type: "step.started",
  status: "running",
  title: name,
  stepId,
  createdAt,
});

const summaryHarness = (events) =>
  bootWebview(
    managerState({ eventsByConversation: { "run-1": events } }),
    panelState({ selectedPipelineDefinition: threeStepPipelineDefinition() }),
  );

const rowStateIn = (html, name) => {
  const marker = html.indexOf(`>${name}<`);
  assert.notEqual(marker, -1, `no pipeline row for ${name}`);
  const start = html.lastIndexOf('class="pipeline-step pipeline-step-', marker);
  return html.slice(
    start + 'class="pipeline-step pipeline-step-'.length,
    html.indexOf('"', start + 'class="pipeline-step pipeline-step-'.length),
  );
};

test("the step identifier the panel actually receives is what keys the summary", () => {
  const harness = summaryHarness([
    attemptStart(1, "run.started", timestamp),
    projectedStepEvent(2, "plan", "Plan", timestamp),
    projectedStepEvent(3, "implement", "Implement", timestamp),
  ]);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.equal(rowStateIn(html, "Plan"), "completed");
    assert.equal(rowStateIn(html, "Implement"), "running");
    assert.equal(rowStateIn(html, "Review"), "waiting");
  } finally {
    harness.restore();
  }
});

test("a restarted attempt starts from waiting and inherits nothing from the attempt before it", () => {
  const harness = summaryHarness([
    attemptStart(1, "run.started", timestamp),
    projectedStepEvent(2, "plan", "Plan", timestamp),
    projectedStepEvent(3, "implement", "Implement", timestamp),
    { id: 4, type: "run.failed", status: "failed", title: "Test run", createdAt: timestamp },
    attemptStart(5, "run.restarted", timestamp),
    projectedStepEvent(6, "plan", "Plan", timestamp),
  ]);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.equal(rowStateIn(html, "Plan"), "running", "the restarted attempt is in its first step");
    assert.equal(
      rowStateIn(html, "Implement"),
      "waiting",
      "the previous attempt's failure was shown as this attempt's state",
    );
    assert.equal(rowStateIn(html, "Review"), "waiting");
    assert.doesNotMatch(html, /Raw event history|workflow-timeline/);
  } finally {
    harness.restore();
  }
});

test("a resume keeps the steps its own attempt already completed", () => {
  const harness = summaryHarness([
    attemptStart(1, "run.started", timestamp),
    projectedStepEvent(2, "plan", "Plan", timestamp),
    projectedStepEvent(3, "implement", "Implement", timestamp),
    { id: 4, type: "run.interrupted", status: "interrupted", title: "Test run", createdAt: timestamp },
    { id: 5, type: "run.resumed", status: "running", title: "Test run", createdAt: timestamp },
    projectedStepEvent(6, "review", "Review", timestamp),
  ]);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.equal(rowStateIn(html, "Plan"), "completed", "a resume is not a new attempt");
    assert.equal(rowStateIn(html, "Implement"), "completed");
    assert.equal(rowStateIn(html, "Review"), "running");
  } finally {
    harness.restore();
  }
});

test("a run-level event is not filed under whichever step happened to be open", () => {
  const harness = summaryHarness([
    attemptStart(1, "run.started", timestamp),
    projectedStepEvent(2, "plan", "Plan", timestamp),
    {
      id: 3,
      type: "resourceDependencies.observed",
      status: "completed",
      title: "Declared resource dependencies",
      createdAt: timestamp,
    },
  ]);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    const planBody = html.slice(html.indexOf(">Plan<"), html.indexOf(">Implement<"));
    assert.ok(
      !planBody.includes("Declared resource dependencies"),
      "a run-level event was attached to a step that did not record it",
    );
    assert.doesNotMatch(html, /Declared resource dependencies|Raw event history/);
  } finally {
    harness.restore();
  }
});

test("the rows are the revision the attempt executed, not whatever the catalog holds now", () => {
  const harness = summaryHarness([
    attemptStart(1, "run.started", timestamp, [
      { id: "plan", name: "Plan" },
      { id: "ship", name: "Ship it" },
    ]),
    projectedStepEvent(2, "plan", "Plan", timestamp),
  ]);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.ok(html.includes("Ship it"), "the attempt's own recorded step is missing");
    assert.ok(
      !html.includes(">Implement<"),
      "a step from the current catalog appeared in an attempt that never ran it",
    );
  } finally {
    harness.restore();
  }
});

test("a step row does not repeat its own name as the first thing inside it", () => {
  const harness = summaryHarness([
    attemptStart(1, "run.started", timestamp),
    projectedStepEvent(2, "plan", "Plan", timestamp),
  ]);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    const planRow = html.slice(html.indexOf(">Plan<"), html.indexOf(">Implement<"));
    assert.equal(
      (planRow.match(/>Plan</gu) ?? []).length,
      1,
      "the step name is printed twice: once as the row, once as its own activity",
    );
  } finally {
    harness.restore();
  }
});

test("primary chat keeps messages and errors visible with prompts available from participant names", () => {
  const promptCards = [1, 2, 3].map((index) => ({
    id: `prompt-${String(index)}`,
    kind: "prompt",
    agentId: "lead",
    step: "Independent specialist analysis",
    eventType: "agent.prompt",
    text: `Exact prompt ${String(index)}`,
    createdAt: timestamp,
  }));
  const harness = bootWebview(
    managerState(),
    panelState({
      transcript: [
        { id: "user-1", kind: "prompt", eventType: "user.message", text: "Review the change", createdAt: timestamp },
        ...promptCards,
        { id: "step-1", kind: "event", eventType: "step.started", text: "Implement started", createdAt: timestamp },
        { id: "answer-1", kind: "answer", agentId: "lead", text: "Here is the review", createdAt: timestamp },
        { id: "error-1", kind: "error", eventType: "provider.failure", text: "The 'gpt-6-astra' model requires a newer version of Codex.", data: { code: "protocolError", evidence: '{"type":"error","status":400}' }, createdAt: timestamp },
      ],
      transcriptTotal: 6,
    }),
  );
  try {
    const html = harness.document.root.innerHTML;
    assert.doesNotMatch(html, /run-information|info-entry/u);
    const primary = html;
    assert.ok(primary.includes("Review the change"), "the reader's request is primary");
    assert.ok(primary.includes("Here is the review"), "a participant's answer is primary");
    assert.ok(primary.includes("requires a newer version of Codex"), "the failure is primary");
    assert.equal(
      primary.includes("Exact prompt 1"),
      false,
      "an exact agent prompt is bookkeeping, not conversation",
    );
    assert.equal(primary.includes("Implement started"), false, "a step transition is bookkeeping");
    // The wire envelope travels with the failure as technical detail, never in the sentence.
    assert.ok(primary.includes("Technical detail"), "the failure detail is not offered");
    assert.match(primary, /protocolError/u, "the classified code is not available as detail");
    harness.document.root.querySelector('[data-action="message-details"][data-message-id="answer-1"]').click();
    assert.match(harness.document.root.innerHTML, /Exact prompt 3/u);
  } finally {
    harness.restore();
  }
});

test("a resumed workflow is a quiet chronological transition without a data card", () => {
  const harness = bootWebview(
    managerState(),
    panelState({
      transcript: [
        { id: "before-resume", kind: "answer", agentId: "lead", text: "Work before the interruption", createdAt: timestamp },
        { id: "resume-marker", kind: "event", eventType: "workflow.resumed", text: "Legacy resume wording", data: { pipelineId: "custom-a", nextStepIndex: 1 }, createdAt: timestamp },
        { id: "after-resume", kind: "answer", agentId: "worker", text: "Work after the interruption", createdAt: timestamp },
      ],
      transcriptTotal: 3,
    }),
  );
  try {
    const root = harness.document.root;
    const marker = root.querySelector('[data-entry="resume-marker"]');
    assert.ok(marker);
    assert.match(marker.getAttribute("class"), /workflow-transition/u);
    assert.equal(marker.getAttribute("role"), "separator");
    assert.equal(marker.getAttribute("aria-label"), "Continued after interruption · from step 2");
    assert.equal(marker.textContent, "Continued after interruption · from step 2");
    assert.equal(marker.querySelector("details"), null);
    assert.equal(marker.querySelector("time"), null);
    assert.doesNotMatch(marker.textContent, /Structured data|workflow resumed|Legacy resume wording/iu);
    const html = root.innerHTML;
    assert.ok(html.indexOf("Work before the interruption") < html.indexOf('data-entry="resume-marker"'));
    assert.ok(html.indexOf('data-entry="resume-marker"') < html.indexOf("Work after the interruption"));
  } finally {
    harness.restore();
  }
});

const failedResultState = () => ({
  status: "error",
  changedFiles: [],
  checks: [],
  providers: [{ agentId: "lead", name: "Lead", adapter: "codex-app-server", model: "gpt-6-astra" }],
  findings: [],
  unresolvedRisks: ["The 'gpt-6-astra' model requires a newer version of Codex."],
  recoveredErrors: [],
  evidence: [],
  evidenceGaps: [],
  finalAssessment: {
    outcome: "failedBeforeRuling",
    method: "none",
    summary: "Failed before final ruling: Lead (codex-app-server · gpt-6-astra) — The 'gpt-6-astra' model requires a newer version of Codex.",
    producedBy: [],
    failure: {
      error: "The 'gpt-6-astra' model requires a newer version of Codex.",
      agentId: "lead",
      participant: "Lead",
      adapter: "codex-app-server",
      provider: "codex-app-server",
      model: "gpt-6-astra",
      step: "Implement",
    },
  },
});

const recoverableWorkflow = (overrides = {}) => ({
  attemptId: "attempt-1",
  outcome: "failed",
  failureScope: "step",
  pipelineId: "custom-a",
  pipelineName: "Custom A",
  pipelineHash: customAHash,
  userPrompt: "Review the change",
  attachmentIds: [],
  nextStepIndex: 1,
  totalSteps: 3,
  stepName: "Implement",
  updatedAt: timestamp,
  ...overrides,
});

for (const [status, outcome, label] of [["interrupted", "stoppedByUser", "Resume stopped step"], ["error", "failed", "Retry failed step"]]) {
  test(`Chat recovery uses ${label} for ${status} and dispatches resume once`, () => {
    const harness = bootWebview(managerState(), panelState({ workflowStatus: status, resumableWorkflow: recoverableWorkflow({ outcome }) }));
    try {
      const card = harness.document.root.querySelector(".run-outcome");
      assert.ok(card);
      assert.match(harness.document.root.innerHTML, new RegExp(`>${label}</button>`));
      assert.doesNotMatch(harness.document.root.innerHTML, new RegExp(`>${status === "interrupted" ? "Retry failed step" : "Resume stopped step"}</button>`));
      const html = harness.document.root.innerHTML;
      assert.match(html.slice(html.indexOf('class="run-outcome')), status === "interrupted" ? /^[^]*?<strong><i [^>]*><\/i> Stopped by you<\/strong><p>Stopped at step 2 of 3 · Implement<\/p>/u : /^[^]*?<strong><i [^>]*><\/i> Failed<\/strong><p>Failed at step 2 of 3 · Implement<\/p>/u);
      const before = harness.messages.length;
      card.querySelector('[data-action="workflow-resume"]').click();
      assert.deepEqual(harness.messages.slice(before), [{ type: "conversation.runtime", conversationId: "run-1", message: { type: "workflow.resume" } }]);
    } finally { harness.restore(); }
  });
}

for (const [action, runtimeType, surface] of [
  ["inspector-toggle", null, ".inspector"],
  ["pipeline-new", null, ".pipeline-editor"],
  ["pipeline-fork", "pipeline.fork", null],
  ["availability-check", "availability.check", ".agents-popover"],
  ["working-directory", "workingDirectory.pick", null],
  ["orchestration-start", "orchestration.start", null],
  ["transcript-export", "transcript.export", null],
  ["task-reset", null, '[role="dialog"]'],
]) {
  test(`room action ${action} activates its flow and dismisses the menu`, () => {
    const harness = bootWebview();
    try {
      openMenu(harness, ".header-action-menu");
      const menu = harness.document.root.querySelector(".header-action-menu");
      assert.equal(menu.open, true);
      if (["pipeline-new", "pipeline-fork"].includes(action)) openComposerSettings(harness);
      const control = ["pipeline-new", "pipeline-fork"].includes(action)
        ? harness.document.root.querySelector(`.composer-settings [data-action="${action}"]`)
        : menu.querySelector(`[data-action="${action}"]`);
      assert.ok(control); assert.equal(control.disabled, false);
      const before = harness.messages.length;
      control.focus(); control.click();
      assert.equal(harness.document.root.querySelector(".header-action-menu").open, false);
      const sent = harness.messages.slice(before);
      if (runtimeType) {
        const expected = runtimeType === "orchestration.start" ? { type: runtimeType } : { type: "conversation.runtime", conversationId: "run-1", message: runtimeType === "pipeline.fork" ? { type: runtimeType, pipelineId: "custom-a" } : { type: runtimeType } };
        if (runtimeType === "pipeline.fork") {
          assert.equal(sent.length, 1);
          assert.equal(sent[0].type, expected.type);
          assert.equal(sent[0].conversationId, expected.conversationId);
          assert.equal(sent[0].message.type, runtimeType);
          assert.equal(typeof sent[0].message.requestId, "string");
          assert.equal(sent[0].message.pipelineId, "custom-a");
        } else if (runtimeType === "availability.check") {
          assert.deepEqual(sent, [expected, { type: "conversation.runtime", conversationId: "run-1", message: { type: "agents.model.discover", agentId: "lead" } }]);
        } else assert.deepEqual(sent, [expected]);
      }
      if (["working-directory", "transcript-export", "orchestration-start"].includes(action)) {
        assert.equal(harness.document.activeElement, harness.document.getElementById("room-actions-button"));
      }
      if (surface) assert.ok(harness.document.root.querySelector(surface));
      if (action === "task-reset") {
        assert.equal(sent.length, 0);
        assert.equal(harness.document.activeElement.dataset.dialogDefault, "cancel");
      }
      if (action === "inspector-toggle") {
        assert.equal(harness.document.activeElement, harness.document.getElementById("inspector-title"));
        openMenu(harness, ".header-action-menu");
        harness.document.root.querySelector('.header-action-menu [data-action="inspector-toggle"]').click();
        assert.equal(harness.document.root.querySelector(".inspector"), null);
        assert.equal(harness.document.activeElement, harness.document.root.querySelector(".header-action-menu > summary"));
      }
    } finally { harness.restore(); }
  });
}

test("archived room unarchive and export actions dispatch once and editing stays disabled", () => {
  const harness = bootWebview(managerState({ conversations: [{ ...conversationSummary(), archived: true }] }), panelState());
  try {
    for (const [action, expected] of [["run-unarchive", { type: "conversation.archive", conversationId: "run-1", archived: false }], ["transcript-export", { type: "conversation.runtime", conversationId: "run-1", message: { type: "transcript.export" } }]]) {
      openMenu(harness, ".header-action-menu");
      const before = harness.messages.length;
      harness.document.root.querySelector(`.header-action-menu [data-action="${action}"]`).click();
      assert.deepEqual(harness.messages.slice(before), [expected]);
      assert.equal(harness.document.root.querySelector(".header-action-menu").open, false);
    }
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-new"]'), null);
    harness.document.root.querySelector('[data-action="inspector-toggle"]').click();
    harness.document.root.querySelector('[data-action="pipeline-view"]').click();
    assert.ok(harness.document.root.querySelector('.app-dialog'));
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-save"]'), null);
  } finally { harness.restore(); }
});

test("uploading an attachment restores Send instead of Stop", async () => {
  const harness = bootWebview(managerState(), panelState({ running: true, workflowStatus: "running" }));
  try {
    assert.ok(harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]'));
    const input = harness.document.getElementById("attachment-input");
    input.files = [{ name: "review.md", type: "text/markdown", size: 20, contents: "Review accessibility" }];
    harness.document.root.dispatch("change", { target: input });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(harness.document.root.querySelector('.composer-send [data-action="submit-message"]'));
    assert.equal(harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]'), null);
  } finally { harness.restore(); }
});

test("a failed result states the error once and offers retry as the primary way back", () => {
  const harness = bootWebview(
    managerState({ resultsByConversation: { "run-1": failedResultState() } }),
    panelState({ workflowStatus: "error", resumableWorkflow: recoverableWorkflow() }),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    const sentence = "requires a newer version of Codex";
    const visible = html.slice(html.indexOf("result-center"));
    const occurrences = visible.split(sentence).length - 1;
    // Once in the failure block. The assessment summary repeating it lives inside the collapsed
    // assessment details, and the risk list no longer prints it a third time.
    assert.equal(occurrences, 2, `the failure sentence appears ${String(occurrences)} times`);
    assert.doesNotMatch(visible, /<h3>Unresolved risks<\/h3>/u);
    const restart = harness.document.root.querySelector('[data-action="workflow-restart"]');
    const retry = harness.document.root.querySelector('[data-action="workflow-resume"]');
    assert.ok(restart, "a failed run offers no way to start over");
    assert.ok(retry, "a failed run offers no way to retry the stopped step");
    assert.ok(retry.className.includes("primary"), "retry is not the primary action");
    assert.equal(restart.className.includes("primary"), false);
    assert.ok(html.includes(">Restart pipeline</button>"));
    assert.ok(html.includes(">Retry failed step</button>"));
    assert.equal(restart.disabled, false);
    restart.click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime",
      conversationId: "run-1",
      message: { type: "workflow.restart" },
    });
  } finally {
    harness.restore();
  }
});

test("a working room draws no result and no recovery, even beside a stale result and checkpoint", () => {
  const harness = bootWebview(
    managerState({ resultsByConversation: { "run-1": failedResultState() } }),
    panelState({ resumableWorkflow: recoverableWorkflow(), running: true, workflowStatus: "running" }),
  );
  try {
    for (const view of ["chat", "execution"]) {
      harness.document.root.querySelector(`[data-action="room-view"][data-view="${view}"]`).click();
      const html = harness.document.root.innerHTML;
      for (const action of ["workflow-restart", "workflow-resume", "workflow-discard"]) {
        assert.equal(harness.document.root.querySelector(`[data-action="${action}"]`), null, `${view}: ${action}`);
      }
      assert.equal(harness.document.root.querySelector(".run-outcome, .result-center"), null, `${view}: result drawn`);
      assert.doesNotMatch(html, /Open the result|ended as|stopped at step|Run result/u, view);
    }
    harness.document.root.querySelector('[data-action="room-view"][data-view="chat"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /class="room-status status-running sr-only"><i class="codicon codicon-loading codicon-modifier-spin room-status-activity" aria-hidden="true"><\/i><span[^>]*>Working<\/span>/u);
    assert.doesNotMatch(html, /codicon-sync/u, "a refresh icon stands for progress");
    assert.ok(harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]'), "Stop is not offered");
  } finally {
    harness.restore();
  }
});

const completedResultState = () => ({
  status: "completed",
  changedFiles: [],
  checks: [],
  providers: [],
  findings: [],
  unresolvedRisks: [],
  recoveredErrors: [],
  evidence: [],
  evidenceGaps: [],
  finalAssessment: { outcome: "completed", method: "singleProvider", summary: "Nothing to fix.", producedBy: [] },
});

const recoveryActions = ["workflow-restart", "workflow-resume", "workflow-discard"];

for (const row of [
  {
    name: "running beside a stale failed checkpoint and result",
    panel: { running: true, workflowStatus: "running", resumableWorkflow: recoverableWorkflow() },
    result: failedResultState(),
    header: "Working",
    tabIcon: "loading codicon-modifier-spin",
    outcome: undefined,
    offered: [],
  },
  {
    name: "stopped by the user",
    panel: { workflowStatus: "interrupted", resumableWorkflow: recoverableWorkflow({ outcome: "stoppedByUser" }) },
    header: "Stopped by you",
    tabIcon: "debug-stop",
    outcome: "Stopped by you",
    offered: recoveryActions,
    step: "Resume stopped step",
  },
  {
    name: "failed in a step that started",
    panel: { workflowStatus: "error", resumableWorkflow: recoverableWorkflow() },
    result: failedResultState(),
    header: "Failed",
    tabIcon: "error",
    outcome: "Failed",
    offered: recoveryActions,
    step: "Retry failed step",
  },
  {
    name: "failed before any participant started",
    panel: { workflowStatus: "error", resumableWorkflow: recoverableWorkflow({ failureScope: "run", nextStepIndex: 0 }) },
    header: "Failed",
    tabIcon: "error",
    outcome: "Failed",
    offered: ["workflow-restart", "workflow-discard"],
  },
  {
    name: "completed",
    panel: { workflowStatus: "completed" },
    result: completedResultState(),
    header: "Completed",
    tabIcon: "pass",
    outcome: "Completed",
    offered: [],
  },
  {
    name: "completed beside a checkpoint that ended differently",
    panel: { workflowStatus: "completed", resumableWorkflow: recoverableWorkflow() },
    result: completedResultState(),
    header: "Completed",
    tabIcon: "pass",
    outcome: "Completed",
    offered: [],
  },
  {
    name: "stopped beside a checkpoint that failed",
    panel: { workflowStatus: "interrupted", resumableWorkflow: recoverableWorkflow() },
    header: "Interrupted",
    tabIcon: "debug-pause",
    outcome: undefined,
    offered: [],
  },
]) {
  test(`state matrix: ${row.name}`, () => {
    const conversation = { ...conversationSummary(), running: row.panel.running === true, workflowStatus: row.panel.workflowStatus };
    const harness = bootWebview(
      managerState({
        conversations: [conversation],
        ...(row.result === undefined ? {} : { resultsByConversation: { "run-1": row.result } }),
      }),
      panelState(row.panel),
    );
    try {
      const html = harness.document.root.innerHTML;
      assert.match(html, new RegExp(`class="room-status status-[a-z]+[^\"]*"[^>]*>(?:<i [^>]*></i>)?<span[^>]*>${row.header}</span>`, "u"), "header status");
      assert.match(html, new RegExp(`codicon-${row.tabIcon} run-tab-status`, "u"), "tab icon");
      assert.doesNotMatch(html, /ended as|Recoverable pipeline|codicon-sync|Needs attention/u);
      if (row.outcome === undefined) {
        assert.equal(harness.document.root.querySelector(".run-outcome"), null, "an outcome row was drawn");
      } else {
        assert.match(html, new RegExp(`<section class="run-outcome [^"]*" aria-label="Run result"><div class="run-outcome-text"><strong><i [^>]*><\\/i> ${row.outcome}<\\/strong>`, "u"));
      }
      for (const action of recoveryActions) {
        const control = harness.document.root.querySelector(`.run-outcome [data-action="${action}"]`);
        assert.equal(control !== null, row.offered.includes(action), `${action} offered`);
        if (control) assert.equal(control.disabled, false, `${action} is drawn disabled`);
      }
      if (row.step === undefined) {
        assert.doesNotMatch(html, />Resume stopped step<|>Retry failed step</u);
      } else {
        assert.match(html, new RegExp(`>${row.step}</button>`, "u"));
        assert.doesNotMatch(html, new RegExp(`>${row.step === "Resume stopped step" ? "Retry failed step" : "Resume stopped step"}<`, "u"));
      }
      if (row.panel.running) {
        assert.doesNotMatch(html, /Open the result|run-outcome|result-center/u);
        assert.ok(harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]'));
      }
    } finally {
      harness.restore();
    }
  });
}

test("a room that never ran has no result card, Open result action or Execution route", () => {
  const harness = bootWebview(managerState(), panelState({ workflowStatus: "idle" }));
  try {
    const html = harness.document.root.innerHTML;
    assert.equal(harness.document.root.querySelector(".run-outcome"), null);
    assert.equal(
      harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]'),
      null,
      "an Execution route exists with nothing to execute",
    );
    assert.doesNotMatch(html, /Open the result|No run has finished|result-center/u);
  } finally {
    harness.restore();
  }
});

for (const [name, panel, label] of [
  ["a restored interruption with no user provenance", { workflowStatus: "interrupted", resumableWorkflow: recoverableWorkflow({ outcome: "interrupted" }) }, "Interrupted"],
  ["an interruption whose checkpoint is missing", { workflowStatus: "interrupted" }, "Interrupted"],
  ["an explicit stop by the user", { workflowStatus: "interrupted", resumableWorkflow: recoverableWorkflow({ outcome: "stoppedByUser" }) }, "Stopped by you"],
]) {
  test(`stop provenance: ${name} reads ${label}`, () => {
    const harness = bootWebview(
      managerState({ conversations: [{ ...conversationSummary(), workflowStatus: "interrupted" }] }),
      panelState(panel),
    );
    try {
      const html = harness.document.root.innerHTML;
      assert.match(html, new RegExp(`class="room-status status-interrupted[^\"]*"[^>]*><span[^>]*>${label}</span>`, "u"));
      if (label === "Interrupted") assert.doesNotMatch(html, /Stopped by you/u);
    } finally {
      harness.restore();
    }
  });
}

for (const [running, workflowStatus, header, stop] of [
  [true, "error", "Failed", false],
  [true, "interrupted", "Interrupted", false],
  [true, "completed", "Completed", false],
  [true, "paused", "Waiting for you", false],
  [false, "paused", "Waiting for you", false],
  [false, "running", "Working", true],
  [true, "idle", "Working", true],
]) {
  test(`one phase decides header, Stop, result and recovery: running=${String(running)} status=${workflowStatus}`, () => {
    const result = workflowStatus === "error"
      ? failedResultState()
      : workflowStatus === "completed" ? completedResultState() : undefined;
    const harness = bootWebview(
      managerState({
        conversations: [{ ...conversationSummary(), running, workflowStatus }],
        ...(result === undefined ? {} : { resultsByConversation: { "run-1": result } }),
      }),
      panelState({ running, workflowStatus, ...(workflowStatus === "error" ? { resumableWorkflow: recoverableWorkflow() } : {}) }),
    );
    try {
      const html = harness.document.root.innerHTML;
      assert.match(html, new RegExp(`class="room-status status-[a-z]+[^\"]*"[^>]*>(?:<i [^>]*></i>)?<span[^>]*>${header}</span>`, "u"), "header status");
      assert.equal(harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]') !== null, stop, "Stop control");
      const live = header === "Working" || header === "Waiting for you";
      assert.equal(harness.document.root.querySelector(".run-outcome") === null, live || result === undefined, "result visibility");
      assert.equal(harness.document.root.querySelector('.run-outcome [data-action="workflow-restart"]') !== null, workflowStatus === "error", "recovery");
    } finally {
      harness.restore();
    }
  });
}

test("participant names open the exact prompt for the selected turn", () => {
  const prompt = "Review the supplied interface.\n\nreview extension/";
  const promptEntry = (id, agentId) => ({ id, kind: "prompt", agentId, step: "Inspect", eventType: "agent.prompt", text: prompt, createdAt: timestamp });
  const harness = bootWebview(
    managerState(),
    panelState({
      transcript: [
        { id: "user-1", kind: "prompt", eventType: "user.message", text: "review extension/", createdAt: timestamp },
        promptEntry("prompt-lead-1", "lead"),
        { id: "answer-lead-1", kind: "answer", agentId: "lead", step: "Inspect", text: "First conclusion", createdAt: timestamp },
        promptEntry("prompt-worker-1", "worker"),
        { ...promptEntry("prompt-lead-2", "lead"), text: "Focus on the keyboard controls." },
        { id: "answer-lead-2", kind: "answer", agentId: "lead", step: "Inspect", text: "Second conclusion", createdAt: timestamp },
        { id: "step-1", kind: "event", eventType: "step.started", text: "Inspect started", createdAt: timestamp },
      ],
      transcriptTotal: 7,
    }),
  );
  try {
    const html = harness.document.root.innerHTML;
    assert.doesNotMatch(html, /run-information|info-entry|Review the supplied interface|Focus on the keyboard controls/u);
    assert.match(html, /First conclusion/u);
    assert.match(html, /Second conclusion/u);
    harness.document.root.querySelector('[data-action="message-details"][data-message-id="answer-lead-1"]').click();
    assert.match(harness.document.root.innerHTML, /Review the supplied interface/u);
    assert.doesNotMatch(harness.document.root.innerHTML, /Focus on the keyboard controls/u);
    harness.document.root.querySelector('[data-action="dialog-cancel"]').click();
    harness.document.root.querySelector('[data-action="message-details"][data-message-id="answer-lead-2"]').click();
    assert.match(harness.document.root.innerHTML, /Focus on the keyboard controls/u);
    assert.doesNotMatch(harness.document.root.innerHTML, /Review the supplied interface/u);
  } finally {
    harness.restore();
  }
});

test("recovery actions are native, named controls, and focus returns to Discard when its confirmation is cancelled", () => {
  const harness = bootWebview(
    managerState({ resultsByConversation: { "run-1": failedResultState() } }),
    panelState({
      workflowStatus: "error",
      resumableWorkflow: recoverableWorkflow(),
      transcript: [
        { id: "prompt-lead-1", kind: "prompt", agentId: "lead", step: "Implement", eventType: "agent.prompt", text: "Implement it", createdAt: timestamp },
      ],
      transcriptTotal: 1,
    }),
  );
  try {
    for (const action of recoveryActions) {
      const control = harness.document.root.querySelector(`.run-outcome [data-action="${action}"]`);
      assert.equal(control.tagName, "BUTTON", action);
      assert.equal(control.getAttribute("tabindex"), null, `${action} was taken out of the tab order`);
      assert.equal(control.disabled, false, action);
    }
    assert.equal(
      harness.document.root.querySelector('.run-outcome [data-action="workflow-resume"]').getAttribute("aria-label"),
      "Retry failed step: Failed at step 2 of 3 · Implement",
    );

    let discard = harness.document.root.querySelector('.run-outcome [data-action="workflow-discard"]');
    discard.click();
    assert.equal(harness.document.activeElement.dataset.dialogDefault, "cancel");
    harness.document.root.querySelector('[data-dialog-default="cancel"]').click();
    discard = harness.document.root.querySelector('.run-outcome [data-action="workflow-discard"]');
    assert.equal(harness.document.activeElement, discard, "focus did not return to Discard");
    assert.equal(harness.messages.filter((message) => message.message?.type === "workflow.discard").length, 0);

    const before = harness.messages.length;
    harness.document.root.querySelector('.run-outcome [data-action="workflow-restart"]').click();
    assert.deepEqual(harness.messages.slice(before), [{ type: "conversation.runtime", conversationId: "run-1", message: { type: "workflow.restart" } }]);

    harness.sendWindowMessage({
      type: "conversation.message",
      conversationId: "run-1",
      message: { type: "state.snapshot", state: panelState({ workflowStatus: "error", resumableWorkflow: recoverableWorkflow(), transcript: [{ id: "prompt-lead-1", kind: "prompt", agentId: "lead", step: "Implement", eventType: "agent.prompt", text: "Implement it", createdAt: timestamp }], transcriptTotal: 1 }) },
    });
    assert.equal(harness.document.root.querySelector(".run-information"), null);
    assert.ok(harness.document.root.querySelector('.run-outcome [data-action="workflow-resume"]'));
  } finally {
    harness.restore();
  }
});

test("an entry with nothing recorded draws no technical-detail block", () => {
  const harness = bootWebview(
    managerState(),
    panelState({
      workflowStatus: "error",
      transcript: [
        { id: "error-null", kind: "error", agentId: "lead", step: "Inspect", text: "Lead stopped", data: null, createdAt: timestamp },
        { id: "error-empty", kind: "error", agentId: "worker", step: "Inspect", text: "Worker stopped", data: {}, createdAt: timestamp },
        { id: "status-empty", kind: "status", text: "Pipeline interrupted.", data: [], createdAt: timestamp },
        { id: "error-detail", kind: "error", eventType: "provider.failure", text: "Provider refused", data: { code: "protocolError" }, createdAt: timestamp },
      ],
      transcriptTotal: 4,
    }),
  );
  try {
    const html = harness.document.root.innerHTML;
    assert.equal(harness.document.root.querySelectorAll(".activity-details").length, 1);
    assert.doesNotMatch(html, /Activity · Inspect|Structured data/u);
    assert.match(html, /Technical detail/u);
  } finally {
    harness.restore();
  }
});

test("a refusal made before any participant started is stated once, offers the folder, and keeps diagnostics behind a disclosure", () => {
  const message = "Choose a Git project folder. /Users/danilt/pair is not inside a Git worktree, and Usability reviewer in “Inspect” and Accessibility reviewer in “Inspect” may change files, so Bachata needs Git to validate those changes. No participant was started.";
  const result = {
    ...failedResultState(),
    providers: [],
    unresolvedRisks: [message],
    finalAssessment: { outcome: "failedBeforeRuling", method: "none", summary: `Failed before final ruling: ${message}`, producedBy: [], failure: { error: message } },
  };
  const harness = bootWebview(
    managerState({ resultsByConversation: { "run-1": result } }),
    panelState({
      workflowStatus: "error",
      resumableWorkflow: recoverableWorkflow({ failureScope: "run", nextStepIndex: 0 }),
      transcript: [
        { id: "user-1", kind: "prompt", eventType: "user.message", text: "review extension/", createdAt: timestamp },
        {
          id: "preflight-1",
          kind: "error",
          eventType: "workflow.preflightFailed",
          text: message,
          createdAt: timestamp,
          data: {
            reason: "notGitWorktree",
            folder: "/Users/danilt/pair",
            detail: "fatal: not a git repository",
            participants: [
              { participant: "Usability reviewer", step: "Inspect" },
              { participant: "Accessibility reviewer", step: "Inspect" },
            ],
          },
        },
      ],
      transcriptTotal: 2,
    }),
  );
  try {
    let html = harness.document.root.innerHTML;
    assert.equal(html.split("is not inside a Git worktree").length - 1, 1, "the refusal is stated more than once in the chat");
    assert.equal(harness.document.root.querySelectorAll(".agent-row").length, 0, "a participant that never started is drawn as having answered");
    const details = harness.document.root.querySelector(".run-preflight-failure .preflight-details");
    assert.equal(details.open, false);
    for (const detail of ["/Users/danilt/pair", "fatal: not a git repository", "Usability reviewer</dt><dd>Not started · Inspect", "Accessibility reviewer</dt><dd>Not started · Inspect"]) {
      assert.ok(html.includes(detail), detail);
    }
    assert.ok(harness.document.root.querySelector('.run-preflight-failure [data-action="working-directory"]'), "no folder action beside the refusal");
    assert.doesNotMatch(html, />null<|activity-details/u);
    assert.match(html, /<strong><i [^>]*><\/i> Failed<\/strong><p>Could not start step 1 of 3 · Implement<\/p>/u);
    assert.equal(harness.document.root.querySelector('[data-action="workflow-resume"]'), null, "a step that never started was offered for retry");
    const refusedSend = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.match(refusedSend.getAttribute("aria-description"), /Choose a Git project folder before restarting\./u);
    assert.doesNotMatch(html, /Send is disabled[^<]*reset/iu);

    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    html = harness.document.root.innerHTML;
    const center = html.slice(html.indexOf('class="result-center"'));
    assert.equal(harness.document.root.querySelectorAll(".result-failure-cause").length, 1);
    assert.match(center, /<h3>Why no participant started<\/h3>/u);
    assert.ok(harness.document.root.querySelector('.result-failure [data-action="working-directory"]'));
    assert.ok(harness.document.root.querySelector(".result-failure .preflight-details"));
    assert.doesNotMatch(center, /Provider and step details/u);
  } finally {
    harness.restore();
  }
});

test("a failed-before-ruling run omits empty sections", () => {
  const result = failedResultState();
  const harness = bootWebview(
    managerState({ resultsByConversation: { "run-1": { ...result, unresolvedRisks: [] } } }),
    panelState({ workflowStatus: "error", resumableWorkflow: recoverableWorkflow() }),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.doesNotMatch(html, /<h3>Changed files<\/h3>|<h3>Unresolved risks<\/h3>|Evidence details · nothing recorded/u);
  } finally {
    harness.restore();
  }
});

test("the chat's run-result card routes to the result instead of reprinting the failure", () => {
  const harness = bootWebview(
    managerState({ resultsByConversation: { "run-1": failedResultState() } }),
    panelState({
      workflowStatus: "error",
      transcript: [
        { id: "user-1", kind: "prompt", eventType: "user.message", text: "Review the change", createdAt: timestamp },
        { id: "error-1", kind: "error", eventType: "provider.failure", text: "The 'gpt-6-astra' model requires a newer version of Codex.", createdAt: timestamp },
      ],
      transcriptTotal: 2,
    }),
  );
  try {
    const html = harness.document.root.innerHTML;
    const sentence = "requires a newer version of Codex";
    // Once, where it happened. The card underneath says where the run stopped and offers the route.
    assert.equal(
      html.split(sentence).length - 1,
      1,
      "the chat states the provider's sentence more than once",
    );
    assert.ok(html.includes("run-outcome"));
    assert.ok(html.includes("Lead at Implement"), "the card does not say where the run stopped");
  } finally {
    harness.restore();
  }
});

// The disclosures, from the manager's own projection to the rendered page.
//
// The panel is handed what `catalogEventView` produced, not a payload written by hand: the defect
// this covers was the projection stripping every payload, which left "Technical detail" and the
// raw event history with nothing to render however the page was written. A test that fabricated
// payloads would have passed throughout.
const { catalogEventView } = require("../dist/conversations/catalogViews.js");

const projectedAttempt = (id, type, createdAt, payload) =>
  catalogEventView({
    id,
    type,
    status: type.endsWith("failed") ? "failed" : "running",
    title: "Test run",
    createdAt,
    payload: {
      ...payload,
      pipeline: {
        hash: "a".repeat(64),
        steps: [
          { id: "plan", name: "Plan" },
          { id: "implement", name: "Implement" },
          { id: "review", name: "Review" },
        ],
      },
    },
  });

const projectedStep = (id, stepId, name, createdAt, payload, status = "running") =>
  catalogEventView({ id, type: "step.started", status, title: name, createdAt, payload: { stepId, ...payload } });

test("projected pipeline details stay recorded without a duplicate technical history surface", () => {
  const events = [
    projectedAttempt(1, "run.started", timestamp, { iterationMode: "fixed", iterations: 1 }),
    projectedStep(2, "plan", "Plan", timestamp, { attempt: 1 }),
    // A step's own start event repeats the row's heading and is not restated inside it. This is the
    // activity that is: an attempt the reader can only understand from what it recorded.
    catalogEventView({
      id: 3,
      type: "provider.failure",
      status: "failed",
      title: "Codex could not start",
      createdAt: timestamp,
      payload: {
        stepId: "plan",
        adapter: "codex-app-server",
        exitCode: 0,
        apiKey: "sk-live-must-not-travel",
        sessionId: "sess-must-not-travel",
      },
    }),
    projectedStep(4, "implement", "Implement", timestamp, { attempt: 1 }),
  ];
  const harness = summaryHarness(events);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;

    assert.equal(rowStateIn(html, "Plan"), "completed");
    assert.equal(rowStateIn(html, "Implement"), "running");
    assert.doesNotMatch(html, /Technical detail|Raw event history|workflow-timeline/);
    assert.equal(events[2].payload.adapter, "codex-app-server");
    assert.equal(events[2].payload.apiKey, "[REDACTED]");
    assert.equal(events[2].payload.sessionId, "[WITHHELD]");
    assert.equal(html.includes("sk-live-must-not-travel"), false, "a credential reached the panel");
    assert.equal(html.includes("sess-must-not-travel"), false, "a session handle reached the panel");
  } finally {
    harness.restore();
  }
});

test("a restart keeps only the newest attempt in the execution summary", () => {
  const events = [
    projectedAttempt(1, "run.started", timestamp, { iterationMode: "fixed", iterations: 1 }),
    projectedStep(2, "plan", "Plan", timestamp, { attempt: 1, adapter: "codex-app-server" }),
    projectedStep(3, "implement", "Implement", timestamp, { attempt: 1, adapter: "codex-app-server" }),
    catalogEventView({
      id: 4,
      type: "run.failed",
      status: "failed",
      title: "Test run",
      createdAt: timestamp,
      payload: { error: "the first attempt stopped at Implement" },
    }),
    projectedAttempt(5, "run.restarted", timestamp, { iterationMode: "fixed", iterations: 1 }),
    projectedStep(6, "plan", "Plan", timestamp, { attempt: 2, adapter: "codex-app-server" }),
  ];
  const harness = summaryHarness(events);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.equal(rowStateIn(html, "Plan"), "running", "the summary is not scoped to the newest attempt");
    assert.equal(rowStateIn(html, "Implement"), "waiting");
    assert.equal(rowStateIn(html, "Review"), "waiting");

    assert.doesNotMatch(html, /Raw event history|the first attempt stopped at Implement/);
    assert.equal(events[3].payload.error, "the first attempt stopped at Implement");
  } finally {
    harness.restore();
  }
});

// The ruling, through the projection that now bounds it.
//
// A published decision used to travel whole on the grounds that the panel renders it as the run's
// conclusion. It is bounded now, so the conclusion has to survive being cut — and the newest
// ruling has to survive a history long enough to exhaust the snapshot's whole budget.

const { catalogEventViews: projectedHistory } = require("../dist/conversations/catalogViews.js");

const hugeRulingPayload = () => ({
  stepId: "step-1",
  round: 2,
  policy: "arbiter",
  status: "ruled",
  candidateId: "DABC123",
  candidate: `Use the selected implementation. ${"padding ".repeat(40_000)}`,
  participants: [
    { agentId: "lead", valid: true, accepted: true, candidateHash: "a", validationErrors: [] },
    { agentId: "worker", valid: true, accepted: false, candidateHash: "b", validationErrors: [] },
  ],
  objections: [{ agentId: "worker", text: "Needs another check", accepted: false }],
  unresolvedRisks: ["Provider DOM may change"],
  ruledBy: "lead",
  apiKey: "sk-live-must-not-travel-abcdef",
  sessionId: "sess-must-not-travel",
});

test("a ruling the projection had to cut still renders as the run's conclusion", () => {
  const harness = bootWebview(
    managerState({
      eventsByConversation: {
        "run-1": [catalogEventView({
          id: 1,
          type: "decision.published",
          status: "ruled",
          title: "DABC123",
          createdAt: timestamp,
          payload: hugeRulingPayload(),
        })],
      },
    }),
    panelState(),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Lead’s final ruling/u);
    assert.match(html, /Use the selected implementation/u);
    assert.match(html, /Overruled/u);
    assert.match(html, /Provider DOM may change/u);
    assert.doesNotMatch(html, /DABC123/u);
    // The candidate was cut, and says so rather than being silently shortened.
    assert.match(html, /more characters not shown/u);
    // Nothing the projection withholds reached the page, decision or not.
    assert.equal(html.includes("sk-live-must-not-travel"), false, "a credential reached the panel");
    assert.equal(html.includes("sess-must-not-travel"), false, "a session handle reached the panel");
  } finally {
    harness.restore();
  }
});

test("the newest ruling still renders after a history long enough to spend the whole budget", () => {
  const noisy = (id) => ({
    id,
    type: "step.started",
    status: "running",
    title: `step ${String(id)}`,
    createdAt: timestamp,
    payload: {
      stepId: "plan",
      stdout: "x".repeat(8_000),
      extra: Object.fromEntries(
        Array.from({ length: 24 }, (_, field) => [`k${String(field)}`, "y".repeat(1_024)]),
      ),
    },
  });
  const events = projectedHistory([
    { id: 1, type: "decision.published", status: "ruled", title: "DABC123", createdAt: timestamp, payload: hugeRulingPayload() },
    ...Array.from({ length: 499 }, (_, index) => noisy(index + 2)),
  ]);
  const harness = bootWebview(
    managerState({ eventsByConversation: { "run-1": events } }),
    panelState(),
  );
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Lead’s final ruling/u, "the oldest row in the window took the ruling with it");
    assert.match(html, /Provider DOM may change/u);
    assert.doesNotMatch(html, /Raw event history|workflow-timeline/);
    assert.equal(html.includes("sk-live-must-not-travel"), false);
  } finally {
    harness.restore();
  }
});

test("composer replaces Send with Stop and rejects repeated stop activation", () => {
  const running = panelState({ running: true, workflowStatus: "running" });
  const harness = bootWebview(managerState(), running);
  try {
    let stop = harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]');
    assert.ok(stop);
    assert.equal(stop.getAttribute("aria-label"), "Stop");
    assert.equal(harness.document.root.querySelector('[data-action="submit-message"]'), null);
    let prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "Keep the existing lease ownership checks";
    harness.document.root.dispatch("input", { target: prompt });
    assert.ok(harness.document.root.querySelector('.composer-send [data-action="submit-message"]'));
    assert.equal(harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]'), null);
    prompt = harness.document.getElementById("composer-prompt");
    prompt.value = "";
    harness.document.root.dispatch("input", { target: prompt });
    stop = harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]');
    assert.ok(stop);
    const before = harness.messages.filter((message) => message.message?.type === "run.interrupt").length;
    stop.click();
    stop.click();
    assert.equal(harness.messages.filter((message) => message.message?.type === "run.interrupt").length, before + 1);
    assert.ok(harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]').hasAttribute("disabled"));
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panelState({ workflowStatus: "interrupted" }) } });
    assert.ok(harness.document.root.querySelector('.composer-send [data-action="submit-message"]'));
    assert.equal(harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]'), null);
  } finally {
    harness.restore();
  }
});

test("notification preferences remain available from the bell without notifications", () => {
  const harness = bootWebview();
  try {
    assert.ok(harness.document.root.querySelector(".notification-center"));
    harness.document.root.querySelector('.notification-center [data-action="notification-settings"]').click();
    const setting = harness.document.getElementById("notification-mode");
    assert.ok(setting.closest(".app-dialog"));
    assert.equal(setting.closest(".header-action-menu"), null);
    for (const action of ["inspector-toggle", "availability-check", "working-directory", "transcript-export", "task-reset"]) {
      assert.ok(harness.document.root.querySelector(`.header-action-menu [data-action="${action}"]`), action);
    }
    assert.equal(harness.document.root.querySelector('.header-action-menu [data-action="notification-settings"]'), null);
    assert.ok(harness.document.root.querySelector('.header-action-menu [data-action="task-reset"]').className.includes("danger"));
  } finally {
    harness.restore();
  }
});

test("pipeline categories separate common, internal and compatibility workflows", () => {
  const { pipelinePickerMetadata } = require("../dist/pipeline/pipelineCatalog.js");
  const presets = ["codex-fix", "codex-review", "codex-plan", "ui-ux-review", "code-review-refine", "todo-master", "claude-review"].map((id) => ({ id, name: id, editable: false, hash: "a".repeat(64), scopeKey: "builtin", ...pipelinePickerMetadata(id, false) }));
  const harness = bootWebview(managerState(), panelState({ pipelines: presets, selectedPipelineId: "codex-review" }));
  try {
    harness.document.getElementById("pipeline-picker-button").click();
    assert.deepEqual([...harness.document.root.querySelectorAll('[data-action="pipeline-picker-select"]')].map((node) => node.getAttribute("data-pipeline-id")), ["codex-fix", "codex-review", "codex-plan", "ui-ux-review", "code-review-refine"]);
    assert.ok(harness.document.root.querySelector('[data-pipeline-id="ui-ux-review"]'));
    assert.ok(harness.document.root.querySelector('[data-pipeline-id="code-review-refine"]'));
    assert.equal(harness.document.root.querySelector('[data-pipeline-id="todo-master"]'), null);
    assert.equal(harness.document.root.querySelector('[data-pipeline-id="claude-review"]'), null);
    harness.document.root.querySelector('[data-action="pipeline-picker-filter"][data-pipeline-filter="internal"]').click();
    assert.ok(harness.document.root.querySelector('[data-pipeline-id="todo-master"]'));
    assert.equal(harness.document.root.querySelector('[data-pipeline-id="claude-review"]'), null);
    harness.document.root.querySelector('[data-action="pipeline-picker-filter"][data-pipeline-filter="compatibility"]').click();
    assert.ok(harness.document.root.querySelector('[data-pipeline-id="claude-review"]'));
    assert.equal(harness.document.root.querySelector('[data-pipeline-id="todo-master"]'), null);
  } finally { harness.restore(); }
});

test("Browser Bridge activation starts discovery and keeps pairing steps beside the role", () => {
  const panel = cliAssignmentPanel();
  panel.browserBridge = { enabled: true, connected: false, sessions: [], endpoint: "ws://127.0.0.1:43127", pairingToken: "PAIRING_FIXTURE" };
  const harness = bootWebview(managerState(), panel);
  try {
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    chooseAgentOption(harness, "agents-provider-builder", "browser");
    assert.equal(harness.messages.at(-1).message.type, "bridge.discover");
    assert.match(harness.document.root.innerHTML, /Connect Browser Bridge/u);
    assert.ok(harness.document.root.querySelector('[data-action="bridge-copy-token"]'));
    assert.equal(harness.document.root.querySelector('[data-action="agents-model-apply"]'), null);
  } finally { harness.restore(); }
});

test("manual model selection is visible beside provider choices", () => {
  const harness = bootWebview(managerState(), cliAssignmentPanel());
  try {
    harness.document.getElementById("agents-picker-button").click();
    assert.equal(harness.document.root.querySelector('.agents-model-advanced'), null);
    assert.ok(harness.document.root.querySelector('.agents-model-explicit'));
    assert.match(harness.document.root.innerHTML, /Provider model ID or alias/u);
    assert.match(harness.document.root.innerHTML, /Use model/u);
  } finally { harness.restore(); }
});

test("an interrupted result has stopped recovery labels and no failure styling", () => {
  const result = { ...failedResultState(), status: "interrupted", unresolvedRisks: [], finalAssessment: { outcome: "failedBeforeRuling", method: "none", summary: "Stopped by you", producedBy: [] } };
  const harness = bootWebview(managerState({ resultsByConversation: { "run-1": result } }), panelState({ workflowStatus: "interrupted", resumableWorkflow: recoverableWorkflow({ outcome: "stoppedByUser" }) }));
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const html = harness.document.root.innerHTML;
    assert.match(html, /Stopped by you/u);
    assert.match(html, /Resume stopped step/u);
    assert.equal(harness.document.root.querySelector('.result-failure'), null);
    const assessment = harness.document.root.querySelector('.result-decision');
    assert.doesNotMatch(assessment.className, /outcome-failedBeforeRuling/u);
    assert.match(assessment.className, /outcome-interrupted/u);
    assert.doesNotMatch(html, />Retry failed step<|Failed before final ruling/u);
  } finally { harness.restore(); }
});

test("header action matrix keeps navigation and export available and explains mutation locks", () => {
  const cases = [
    { name: "idle", panel: {}, archived: false, hidden: [], disabled: [] },
    { name: "active", panel: { running: true, workflowStatus: "running", pipelineMutable: false, pipelineMutationReason: "Stop the active run before editing its pipeline" }, archived: false, hidden: [], disabled: ["availability-check", "working-directory", "task-reset"] },
    { name: "waiting for capacity", panel: {}, waitingForResources: true, archived: false, hidden: [], disabled: ["availability-check", "working-directory", "task-reset"] },
    { name: "no participants", panel: { agentAssignments: { ...assignmentStateFor(pipelineDefinition(), []), slots: [] } }, archived: false, hidden: [], disabled: ["availability-check"] },
    { name: "catalog conflict", panel: { pipelineMutable: false, pipelineMutationReason: "Resolve the catalog conflict" }, archived: false, hidden: [], disabled: [] },
    { name: "archived", panel: {}, archived: true, hidden: ["availability-check", "working-directory", "orchestration-start", "task-reset"], disabled: [] },
  ];
  const actions = ["inspector-toggle", "availability-check", "working-directory", "orchestration-start", "transcript-export", "task-reset"];
  for (const row of cases) {
    const manager = managerState();
    manager.conversations[0].archived = row.archived;
    manager.conversations[0].waitingForResources = row.waitingForResources ?? false;
    const harness = bootWebview(manager, panelState(row.panel));
    try {
      for (const action of actions) {
        const button = harness.document.root.querySelector(`.header-action-menu [data-action="${action}"]`);
        assert.equal(button !== null, !row.hidden.includes(action), `${row.name}: ${action} visibility`);
        if (!button) continue;
        assert.equal(button.hasAttribute("disabled"), row.disabled.includes(action), `${row.name}: ${action} enabled`);
        if (row.disabled.includes(action)) assert.ok(button.getAttribute("title"), `${row.name}: ${action} needs a reason`);
      }
      if (row.archived) assert.ok(harness.document.root.querySelector('.header-action-menu [data-action="run-unarchive"]'));
    } finally { harness.restore(); }
  }
});

test("late step metadata preserves the first terminal state until an explicit step restart", () => {
  for (const [terminal, status, later] of [["run.interrupted", "interrupted", "run.failed"], ["run.failed", "failed", "run.interrupted"], ["run.completed", "completed", "run.interrupted"]]) {
    const events = [stepEvent(1, "implement", "Implement", timestamp), { id: 2, type: terminal, status, title: "Terminal status", createdAt: timestamp }, { id: 3, type: "provider.failure", status: "failed", title: "Late provider detail", stepId: "implement", createdAt: timestamp }, { id: 4, type: later, title: "Late terminal notification", createdAt: timestamp }];
    const manager = managerState({ eventsByConversation: { "run-1": events } });
    const panel = panelState({ selectedPipelineDefinition: threeStepPipelineDefinition() });
    const harness = bootWebview(manager, panel);
    try {
      harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
      const states = () => [...harness.document.root.innerHTML.matchAll(/class="pipeline-step pipeline-step-([^"]+)"/gu)].map((match) => match[1]);
      assert.equal(states().length, 3);
      assert.equal(states()[1], status);
      manager.eventsByConversation['run-1'].push(stepEvent(5, "implement", "Implement", timestamp));
      harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
      assert.equal(states()[1], 'running');
    } finally { harness.restore(); }
  }
});

test("bell and action menu exclude each other and preferences dispatch once", () => {
  const harness = bootWebview(notificationManager());
  try {
    let actions = openMenu(harness, ".header-action-menu");
    const notifications = openMenu(harness, ".notification-center");
    assert.equal(actions.open, false);
    assert.equal(notifications.open, true);
    actions = openMenu(harness, ".header-action-menu");
    assert.equal(actions.open, true);
    assert.equal(notifications.open, false);
    openMenu(harness, ".notification-center");
    harness.document.root.querySelector('.notification-center [data-action="notification-settings"]').click();
    const setting = harness.document.getElementById("notification-mode");
    setting.value = "off";
    const before = harness.messages.length;
    harness.document.root.dispatch("change", { target: setting });
    assert.deepEqual(harness.messages.slice(before), [{ type: "notifications.setMode", mode: "off" }]);
    assert.equal(harness.document.root.querySelector(".header-action-menu").open, false);
  } finally { harness.restore(); }
});

for (const status of ["running", "waiting"]) {
  test(`composer ${status} transitions through draft, stop pending, completion and idle`, () => {
    const harness = bootWebview(managerState({ conversations: [{ ...conversationSummary(), waitingForResources: status === "waiting" }] }), panelState({ running: status === "running", workflowStatus: status === "running" ? "running" : "idle" }));
    try {
      const input = harness.document.getElementById("composer-prompt");
      input.value = "Review the next refinement";
      harness.document.root.dispatch("input", { target: input });
      assert.ok(harness.document.root.querySelector('.composer-send [data-action="submit-message"]'));
      const current = harness.document.getElementById("composer-prompt");
      current.value = "";
      harness.document.root.dispatch("input", { target: current });
      const stop = harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]');
      assert.ok(stop);
      const before = harness.messages.length;
      stop.click(); stop.click();
      assert.deepEqual(harness.messages.slice(before), [{ type: "conversation.runtime", conversationId: "run-1", message: { type: "run.interrupt" } }]);
      harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panelState({ running: false, workflowStatus: "interrupted" }) } });
      assert.equal(harness.document.root.querySelector('.composer-send [data-action="interrupt-run"]'), null);
      assert.ok(harness.document.root.querySelector('.composer-send [data-action="submit-message"]'));
    } finally { harness.restore(); }
  });
}

test("unfamiliar built-in workflows remain discoverable in Specialized", () => {
  const unfamiliar = { id: "new-built-in-audit", name: "Concurrency audit", editable: false, hash: "c".repeat(64), scopeKey: "builtin", participantCount: 2, participantNames: ["Reviewer", "Implementer"], stepCount: 3 };
  const panel = panelState();
  panel.pipelines.push(unfamiliar);
  const harness = bootWebview(managerState(), panel);
  try {
    harness.document.getElementById("pipeline-picker-button").click();
    assert.equal(harness.document.root.querySelector(`[data-pipeline-id="${unfamiliar.id}"]`), null);
    const specialized = harness.document.root.querySelector('[data-action="pipeline-picker-filter"][data-pipeline-filter="specialized"]');
    assert.ok(specialized);
    specialized.click();
    assert.ok(harness.document.root.innerHTML.includes("Concurrency audit"));
  } finally { harness.restore(); }
});

test("candidate-bound evidence retains acceptance context and groups provenance in a secondary panel", () => {
  const direction = directionState();
  direction.externalEvidence = [{
    id: "X1", claim: "The retry count now matches the request", relation: "supports", authority: "firstPartyMeasurement", state: "proposed", disposition: "unresolved", revision: 1,
    source: { uri: "https://evidence.invalid/retry", title: "Retry verification", retrievedAt: "2026-09-12T00:00:00.000Z", contentDigest: "a".repeat(64) },
    target: { kind: "finding", identity: "FH1" }, challenges: [],
    verification: { requirement: "Exactly two calls for two requested attempts", kind: "externalEvidence", outcome: "passed", verifier: "human", environment: "Node.js" },
  }];
  direction.resolutionMatrix = { ...(direction.resolutionMatrix ?? {}), externalEvidence: { proposed: ["accept", "reject", "defer", "supersede"] } };
  const harness = bootWebview(managerState({ direction }));
  try {
    openWorkspaceDirection(harness);
    assert.match(harness.document.root.innerHTML, /supports Cancellation guard/u);
    assert.match(harness.document.root.innerHTML, /Verification: passed/u);
    const disclosure = harness.document.root.querySelector('[data-action="direction-section-toggle"][data-section="verification-X1"]');
    assert.ok(disclosure);
    assert.equal(disclosure.getAttribute("aria-expanded"), "false");
    const panel = harness.document.getElementById(disclosure.getAttribute("aria-controls"));
    assert.equal(panel.hasAttribute("hidden"), true);
    assert.match(harness.document.root.innerHTML, /Exactly two calls for two requested attempts/u);
    assert.match(harness.document.root.innerHTML, /human · Node.js/u);
    const accept = harness.document.root.querySelector('[data-action="resolve-record"][data-target="externalEvidence"][data-resolution="accept"]');
    assert.match(accept.getAttribute("title"), /Resolve the linked finding only when repository state and scope still match/u);
    harness.messages.length = 0;
    accept.click();
    assert.deepEqual(harness.messages, [{ type: "resolution.apply", target: "externalEvidence", id: "X1", action: "accept" }]);
  } finally { harness.restore(); }
});

test("pipeline picker searches within categories and restores the remembered filter", () => {
  const pipelines = [
    { id: "specialized-selected", name: "Specialized review", editable: false, pickerCategory: "specialized" },
    { id: "custom-visible", name: "Custom review", editable: true, pickerCategory: "custom", description: "Checks keyboard behavior", participantNames: ["Accessibility reviewer"] },
    { id: "compatibility-copy", name: "Compatibility review", editable: false, pickerCategory: "compatibility" },
    { id: "new-catalog-common", name: "Zebra review", editable: false, pickerCategory: "common", prominentOrder: 0 },
    { id: "another-catalog-common", name: "Alpha review", editable: false, pickerCategory: "common", prominentOrder: 1 },
  ].map((pipeline) => ({ hash: "a".repeat(64), scopeKey: pipeline.editable ? "workspace:/workspace" : "builtin", ...pipeline }));
  const harness = bootWebview(managerState(), panelState({ pipelines, selectedPipelineId: "specialized-selected" }));
  const visibleIds = () => [...harness.document.root.querySelectorAll('[data-action="pipeline-picker-select"]')].map((node) => node.getAttribute("data-pipeline-id"));
  const keyboard = (key) => harness.document.root.dispatch("keydown", { key, target: harness.document.getElementById("pipeline-picker-search"), preventDefault: () => undefined });
  try {
    harness.document.getElementById("pipeline-picker-button").click();
    assert.deepEqual(visibleIds(), ["new-catalog-common", "another-catalog-common"]);
    assert.ok(harness.document.root.querySelector('[data-pipeline-filter="all"]'));
    assert.ok(harness.document.root.querySelector('[data-pipeline-filter="custom"]'));
    harness.document.root.querySelector('[data-pipeline-filter="custom"]').click();
    assert.deepEqual(visibleIds(), ["custom-visible"]);
    const search = harness.document.getElementById("pipeline-picker-search");
    search.value = "accessibility";
    harness.document.root.dispatch("input", { target: search });
    assert.deepEqual(visibleIds(), ["custom-visible"]);
    const rerenderedSearch = harness.document.getElementById("pipeline-picker-search");
    rerenderedSearch.value = "missing";
    harness.document.root.dispatch("input", { target: rerenderedSearch });
    assert.deepEqual(visibleIds(), []);
    assert.match(harness.document.root.innerHTML, /No pipelines found/u);
    const clearedSearch = harness.document.getElementById("pipeline-picker-search");
    clearedSearch.value = "";
    harness.document.root.dispatch("input", { target: clearedSearch });
    harness.document.root.querySelector('[data-pipeline-filter="common"]').click();
    keyboard("Home");
    assert.equal(harness.document.getElementById("pipeline-picker-search").getAttribute("aria-activedescendant"), harness.document.root.querySelector('[data-pipeline-id="new-catalog-common"]').id);
    keyboard("ArrowDown");
    keyboard("Enter");
    assert.equal(harness.messages.filter((entry) => entry.message?.type === "pipeline.select").length, 1);
    assert.equal(harness.messages.at(-1).message.pipelineId, "another-catalog-common");
    assert.equal(harness.document.getElementById("pipeline-picker-list"), null);
  } finally { harness.restore(); }
});

test("pipeline picker restores its last category and omits Custom and All without custom definitions", () => {
  const pipelines = [
    { id: "common", name: "Common", editable: false, pickerCategory: "common", prominentOrder: 0 },
    { id: "specialized", name: "Specialized", editable: false, pickerCategory: "specialized" },
  ].map((pipeline) => ({ hash: "a".repeat(64), scopeKey: "builtin", ...pipeline }));
  const harness = bootWebview(managerState(), panelState({ pipelines, selectedPipelineId: "common" }), undefined, { pipelinePickerFilter: "specialized" });
  try {
    harness.document.getElementById("pipeline-picker-button").click();
    assert.deepEqual([...harness.document.root.querySelectorAll('[data-action="pipeline-picker-select"]')].map((node) => node.getAttribute("data-pipeline-id")), ["specialized"]);
    assert.equal(harness.document.root.querySelector('[data-pipeline-filter="specialized"]').getAttribute("aria-pressed"), "true");
    assert.equal(harness.document.root.querySelector('[data-pipeline-filter="custom"]'), null);
    assert.equal(harness.document.root.querySelector('[data-pipeline-filter="all"]'), null);
  } finally { harness.restore(); }
});

for (const [running, workflowStatus, label] of [
  [true, "error", "Failed"],
  [true, "interrupted", "Interrupted"],
  [true, "completed", "Completed"],
  [true, "paused", "Waiting for you"],
  [false, "paused", "Waiting for you"],
  [false, "running", "Working"],
]) {
  test(`child run status uses the normalized phase: ${String(running)} / ${workflowStatus}`, () => {
    const child = { ...conversationSummary(), id: "child-1", parentConversationId: "run-1", title: "Child task", running, workflowStatus };
    const harness = bootWebview(managerState({ conversations: [conversationSummary(), child] }));
    try {
      harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
      const row = harness.document.root.querySelector('.child-run[data-conversation="child-1"]');
      assert.ok(row);
      assert.equal(row.className.includes("status-running"), label === "Working");
      const status = label === "Working" ? "running" : workflowStatus;
      assert.match(harness.document.root.innerHTML, new RegExp(`class="child-run status-${status}"[^>]*data-conversation="child-1"><span class="room-presence status-${status}"></span>[\\s\\S]*?<small>${label}</small></button>`, "u"));
    } finally {
      harness.restore();
    }
  });
}

for (const [running, workflowStatus, announcement] of [
  [true, "error", "Run failed."],
  [true, "interrupted", "Run interrupted."],
  [true, "completed", "Run completed."],
  [true, "paused", "Run paused."],
  [false, "paused", "Run paused."],
  [false, "running", "Run started."],
]) {
  test(`run announcement uses the normalized phase: ${String(running)} / ${workflowStatus}`, () => {
    const harness = bootWebview();
    try {
      harness.sendWindowMessage({
        type: "conversation.message",
        conversationId: "run-1",
        message: { type: "run.patch", running, workflowStatus },
      });
      assert.equal(harness.document.liveStatus.textContent, announcement);
    } finally {
      harness.restore();
    }
  });
}

for (const action of ["rename", "duplicate", "archive", "delete"]) {
  test(`run ${action} dispatches once for an inactive run after a snapshot`, () => {
    const other = { ...conversationSummary(), id: "run-other", title: "Other run" };
    const manager = managerState({ conversations: [conversationSummary(), other] });
    const harness = bootWebview(manager, panelState());
    try {
      let control = harness.document.root.querySelector(`[data-action="run-${action}"][data-conversation="run-other"]`);
      const menu = control.closest("details");
      menu.open = true;
      harness.document.root.dispatch("toggle", { target: menu });
      harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
      control = harness.document.root.querySelector(`[data-action="run-${action}"][data-conversation="run-other"]`);
      control.click();
      if (action !== "duplicate") {
        if (action === "rename") harness.document.getElementById("app-dialog-input").value = "Renamed run";
        harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
      }
      const expected = action === "rename"
        ? { type: "conversation.rename", conversationId: "run-other", title: "Renamed run" }
        : action === "archive"
          ? { type: "conversation.archive", conversationId: "run-other", archived: true }
          : { type: action === "delete" ? "conversation.close" : "conversation.duplicate", conversationId: "run-other" };
      assert.deepEqual(harness.messages.filter((message) => message.type === expected.type), [expected]);
    } finally {
      harness.restore();
    }
  });
}

test("tab and drawer menus have independent disclosure state", () => {
  const harness = bootWebview();
  try {
    openRunMenu(harness);
    harness.document.root.querySelector('[data-action="run-drawer-toggle"]').click();
    const menus = harness.document.root.querySelectorAll(".run-action-menu");
    const keys = menus.map((menu) => menu.dataset.disclosureKey);
    assert.equal(new Set(keys).size, keys.length);
  } finally {
    harness.restore();
  }
});

test("Escape closes pipeline tools before closing the editor", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="composer-settings-toggle"]').click();
    harness.document.root.querySelector('[data-action="pipeline-edit"]').click();
    const menu = harness.document.root.querySelector('.pipeline-editor .header-action-menu');
    menu.open = true;
    harness.document.root.dispatch("toggle", { target: menu });
    harness.document.root.dispatch("keydown", { key: "Escape", target: menu.querySelector("summary"), preventDefault: () => undefined });
    assert.ok(harness.document.root.querySelector('.pipeline-editor'));
    assert.equal(menu.open, false);
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
    assert.equal(harness.document.root.querySelector('.pipeline-editor .header-action-menu').open, false);
  } finally {
    harness.restore();
  }
});

test("workspace shell uses the existing logo and keeps Direction inside Runs", () => {
  const harness = bootWebview();
  try {
    const before = harness.messages.length;
    const logo = harness.document.root.querySelector(".run-tabs-brand");
    assert.equal(logo.tagName, "SPAN");
    assert.equal(logo.getAttribute("aria-hidden"), "true");
    assert.equal(logo.getAttribute("aria-label"), null);
    assert.equal(logo.getAttribute("data-action"), null);
    const path = harness.document.root.innerHTML.match(/<svg class="workspace-logo"[^>]*><path d="([^"]+)"/u)?.[1];
    assert.ok(path);
    assert.ok(require("node:fs").readFileSync(require("node:path").join(__dirname, "../media/icon.svg"), "utf8").includes(`d="${path}"`));
    assert.equal(harness.document.root.querySelector('.run-tabs [data-view="direction"]'), null);
    harness.document.root.querySelector('[data-action="run-drawer-toggle"]').click();
    const direction = harness.document.root.querySelector(".run-drawer-direction");
    assert.ok(direction);
    assert.equal(harness.document.root.querySelectorAll(".run-drawer-direction").length, 1);
    assert.equal(harness.document.root.querySelector(".run-drawer-footer .run-drawer-direction"), direction);
    assert.equal(direction.getAttribute("aria-pressed"), null);
    assert.equal(direction.getAttribute("aria-current"), null);
    assert.equal(direction.className.split(/\s+/u).includes("workspace-direction"), false);
    assert.equal(direction.getAttribute("title"), "Project goals and decisions");
    direction.focus();
    direction.click();
    assert.equal(harness.document.getElementById("run-drawer"), null);
    assert.ok(harness.document.root.querySelector(".direction-center"));
    assert.equal(harness.document.activeElement, harness.document.getElementById("conversation-scroll"));
    assert.equal(harness.document.root.querySelector(".run-tab-select").getAttribute("aria-current"), null);
    assert.equal(harness.document.root.querySelector(".run-tab-all").getAttribute("aria-current"), "page");
    harness.document.root.querySelector('[data-action="run-drawer-toggle"]').click();
    assert.equal(harness.document.root.querySelector(".run-drawer-direction").getAttribute("aria-pressed"), null);
    assert.equal(harness.document.root.querySelector(".run-drawer-footer .run-drawer-direction").getAttribute("aria-current"), "page");
    assert.deepEqual(harness.messages.slice(before), []);
  } finally { harness.restore(); }
});

test("user messages keep a local avatar and visible author through snapshots", () => {
  const panel = panelState({
    transcript: [{ id: "user-avatar-message", kind: "prompt", eventType: "user.message", text: "Review the interface", createdAt: timestamp }],
  });
  const harness = bootWebview(managerState(), panel);
  try {
    const root = harness.document.root;
    const avatar = () => root.innerHTML.match(/<article class="message-row user-row" data-entry="user-avatar-message">\s*(<svg class="agent-avatar user-avatar"[^]*?<\/svg>)/u)?.[1];
    const original = avatar();
    assert.ok(original);
    assert.match(original, /aria-hidden="true" focusable="false"/u);
    assert.match(original, />Y<\/text>/u);
    assert.doesNotMatch(original, /(?:src|href)=/u);
    assert.equal(root.querySelectorAll(".user-row").length, 1);
    assert.equal(root.querySelector(".user-row .message-author").textContent, "You");
    assert.equal(root.querySelector(".user-row .message-text").textContent, "Review the interface");
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panel } });
    assert.equal(avatar(), original);
    assert.equal(root.querySelectorAll(".user-row").length, 1);
    assert.equal(root.querySelector(".user-row .message-author").textContent, "You");
  } finally { harness.restore(); }
});

test("Home returns to the active chat without changing run selection or order", () => {
  const first = conversationSummary();
  const second = { ...first, id: "run-2", runRef: "run-2", title: "Second run" };
  const harness = bootWebview(managerState({ conversations: [first, second] }));
  try {
    const before = harness.messages.length;
    const order = () => harness.document.root.querySelectorAll(".run-tab-select").map((control) => control.dataset.conversation);
    const initialOrder = order();
    openWorkspaceDirection(harness);
    const logo = harness.document.root.querySelector(".run-tabs-brand");
    assert.equal(logo.tagName, "BUTTON");
    assert.equal(logo.getAttribute("aria-label"), "Home");
    logo.focus();
    logo.click();
    assert.ok(harness.document.getElementById("composer-prompt"));
    assert.equal(harness.document.root.querySelector(".direction-center"), null);
    assert.equal(harness.document.root.querySelector('.run-tab-select[data-conversation="run-1"]').getAttribute("aria-current"), "page");
    assert.deepEqual(order(), initialOrder);
    assert.equal(harness.document.root.querySelector(".run-tab-all").getAttribute("aria-current"), null);
    assert.deepEqual(harness.messages.slice(before), []);
  } finally { harness.restore(); }
});

test("Runs opens Direction before the workspace has any runs", () => {
  const harness = bootWebview(managerState({ conversations: [], activeConversationId: undefined }));
  try {
    const before = harness.messages.length;
    openWorkspaceDirection(harness);
    assert.equal(harness.document.getElementById("run-drawer"), null);
    assert.ok(harness.document.root.querySelector(".direction-center"));
    assert.ok(harness.document.getElementById("initiative-goal"));
    assert.deepEqual(harness.messages.slice(before), []);
  } finally { harness.restore(); }
});

test("clicking the active run restores Chat from workspace Direction", () => {
  const harness = bootWebview();
  try {
    openWorkspaceDirection(harness);
    assert.equal(harness.document.getElementById("composer-prompt"), null);
    harness.document.root.querySelector('.run-tab-select[data-conversation="run-1"]').click();
    assert.ok(harness.document.getElementById("composer-prompt"));
    assert.equal(harness.document.root.querySelector('.direction-center'), null);
  } finally { harness.restore(); }
});

test("run labels strip internal prefixes in drawer and destructive dialogs", () => {
  const summary = { ...conversationSummary(), title: "[run-1] Review interface" };
  const harness = bootWebview(managerState({ conversations: [summary] }));
  try {
    harness.document.root.querySelector('[data-action="run-drawer-toggle"]').click();
    assert.match(harness.document.root.innerHTML, /class="run-drawer-select"[^]*?<strong>Review interface<\/strong>/u);
    assert.doesNotMatch(harness.document.root.querySelector('.run-action-menu summary').getAttribute("aria-label"), /\[run-1\]/u);
    harness.document.root.querySelector('.run-drawer [data-action="run-archive"]').click();
    assert.doesNotMatch(harness.document.root.innerHTML.slice(harness.document.root.innerHTML.indexOf('class="app-dialog"')), /\[run-1\]/u);
  } finally { harness.restore(); }
});

test("busy run commands explain refusal and send no mutation", () => {
  const summary = { ...conversationSummary(), running: true, workflowStatus: "running" };
  const harness = bootWebview(managerState({ conversations: [summary] }), panelState({ running: true, workflowStatus: "running" }));
  try {
    for (const action of ["run-duplicate", "run-archive", "run-delete"]) {
      const control = harness.document.root.querySelector(`[data-action="${action}"]`);
      assert.equal(control.getAttribute("aria-disabled"), "true");
      assert.match(control.getAttribute("title"), /Stop/u);
      const before = harness.messages.length;
      control.click();
      assert.equal(harness.messages.length, before);
      assert.equal(harness.document.root.querySelector('.app-dialog'), null);
    }
  } finally { harness.restore(); }
});

test("busy descendants block archive and delete while root duplication stays available", () => {
  const summary = conversationSummary();
  const child = { ...summary, id: "child-run", parentConversationId: summary.id, title: "Check changes", running: true };
  const harness = bootWebview(managerState({ conversations: [summary, child] }));
  try {
    for (const action of ["run-archive", "run-delete"]) {
      const control = harness.document.root.querySelector(`[data-action="${action}"][data-conversation="run-1"]`);
      assert.equal(control.getAttribute("aria-disabled"), "true");
      assert.match(control.getAttribute("title"), /Check changes/u);
    }
    assert.equal(harness.document.root.querySelector('[data-action="run-duplicate"][data-conversation="run-1"]').getAttribute("aria-disabled"), null);
  } finally { harness.restore(); }
});

test("notifications can be enabled again from the bell after Off", () => {
  const harness = bootWebview(managerState({ notifications: { mode: "off", events: [], unread: 0 } }));
  try {
    assert.ok(harness.document.root.querySelector('.notification-center'));
    harness.document.root.querySelector('.notification-center [data-action="notification-settings"]').click();
    const select = harness.document.getElementById("notification-mode");
    assert.ok(select);
    select.value = "decisions";
    const before = harness.messages.length;
    harness.document.root.dispatch("change", { target: select });
    assert.deepEqual(harness.messages.slice(before), [{ type: "notifications.setMode", mode: "decisions" }]);
  } finally { harness.restore(); }
});

test("checking providers closes Run details and focuses the accessible picker", () => {
  const harness = bootWebview();
  try {
    harness.document.root.querySelector('[data-action="inspector-toggle"]').click();
    assert.ok(harness.document.root.querySelector('.inspector'));
    harness.document.root.querySelector('.inspector [data-action="availability-check"]').click();
    assert.equal(harness.document.root.querySelector('.inspector'), null);
    assert.ok(harness.document.root.querySelector('.agents-popover'));
    assert.equal(harness.document.activeElement.id, "agents-picker-button");
    assert.equal(harness.document.activeElement.closest('[inert]'), null);
  } finally { harness.restore(); }
});

test("read-only viewers can inspect participant prompts and pipeline steps", () => {
  const readOnly = { owned: false, reason: "Another window owns the workspace", retryCommand: "Bachata: Workspace Ownership" };
  const panel = panelState({ transcript: [
    { id: "prompt-1", kind: "prompt", agentId: "lead", eventType: "agent.prompt", text: "Read the current interface", step: "Implement", createdAt: timestamp },
    { id: "answer-1", kind: "answer", agentId: "lead", text: "Review complete", step: "Implement", createdAt: timestamp },
  ] });
  const harness = bootWebview(managerState({ readOnly }), panel);
  try {
    const author = harness.document.root.querySelector('[data-action="message-details"]');
    assert.equal(author.getAttribute("aria-disabled"), null);
    author.click();
    assert.match(harness.document.root.innerHTML, /class="turn-details"[^]*?Read the current interface/u);
    harness.document.root.querySelector('[data-action="dialog-cancel"]').click();
    harness.document.root.querySelector('[data-action="inspector-toggle"]').click();
    const pipeline = harness.document.root.querySelector('[data-action="pipeline-view"]');
    assert.equal(pipeline.getAttribute("aria-disabled"), null);
    pipeline.click();
    assert.match(harness.document.root.innerHTML, /class="turn-details"[^]*?Implement/u);
    assert.equal(harness.document.root.querySelector('[data-action="pipeline-save"]'), null);
    assert.equal(harness.messages.some((message) => message.message?.type === "pipeline.save"), false);
  } finally { harness.restore(); }
});

test("Latest reaches the live edge before streaming continues and transfers focus", () => {
  const panel = panelState({
    running: true,
    agents: { lead: { id: "lead", name: "Reviewer", adapterType: "codex-app-server", status: "running", output: "Reading" } },
    transcript: [{ id: "user-request", kind: "prompt", eventType: "user.message", text: "Inspect the UI", createdAt: timestamp }],
  });
  const harness = bootWebview(managerState(), panel);
  try {
    const content = harness.document.getElementById("conversation-scroll");
    content.scrollHeight = 1000;
    content.clientHeight = 400;
    harness.document.root.dispatch("scroll", { target: content });
    content.scrollTop = 100;
    harness.document.root.dispatch("scroll", { target: content });
    const latest = harness.document.root.querySelector('[data-action="jump-latest"]');
    assert.equal(latest.hidden, false);
    latest.click();
    assert.equal(content.scrollTop, content.scrollHeight);
    assert.equal(harness.document.activeElement, content);
    assert.equal(latest.hidden, true);
    content.scrollHeight = 1100;
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "agent.delta", agentId: "lead", text: " the controls" } });
    assert.equal(content.scrollTop, content.scrollHeight);
  } finally { harness.restore(); }
});

test("live participant prompt inspection uses the current step", () => {
  const panel = panelState({
    activeStep: "Reconcile",
    agents: { lead: { id: "lead", name: "Reviewer", adapterType: "codex-app-server", status: "running", output: "Reading…" } },
    transcript: [
      { id: "prompt-old", kind: "prompt", agentId: "lead", eventType: "agent.prompt", text: "Old instructions", step: "Inspect", createdAt: timestamp },
      { id: "prompt-current", kind: "prompt", agentId: "lead", eventType: "verification.controller.revision", text: "Resolve the remaining finding", step: "Reconcile", createdAt: timestamp },
    ],
  });
  const harness = bootWebview(managerState(), panel);
  try {
    harness.document.root.querySelector('.live-message [data-action="message-details"]').click();
    const dialog = harness.document.root.innerHTML.slice(harness.document.root.innerHTML.indexOf('class="app-dialog"'));
    assert.match(dialog, /Resolve the remaining finding/u);
    assert.doesNotMatch(dialog, /Old instructions/u);
  } finally { harness.restore(); }
});

const simulateConversationGeometry = (harness, initialHeight) => {
  const root = harness.document.root;
  const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(root), "innerHTML");
  let height = initialHeight;
  const apply = () => {
    const content = harness.document.getElementById("conversation-scroll");
    if (!content) return;
    content.scrollHeight = height;
    content.clientHeight = 400;
    let top = 0;
    Object.defineProperty(content, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value) => { top = Math.max(0, Math.min(Number(value), content.scrollHeight - content.clientHeight)); },
    });
  };
  Object.defineProperty(root, "innerHTML", {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) { descriptor.set.call(this, value); apply(); },
  });
  apply();
  return (nextHeight) => { height = nextHeight; };
};

test("Latest keeps following when a complete snapshot replaces the focused conversation", () => {
  const request = { id: "request", kind: "prompt", eventType: "user.message", text: "Review", createdAt: timestamp };
  const panel = panelState({ transcript: [request] });
  const harness = bootWebview(managerState(), panel);
  try {
    const resize = simulateConversationGeometry(harness, 1000);
    const content = harness.document.getElementById("conversation-scroll");
    content.scrollTop = 100;
    harness.document.root.dispatch("scroll", { target: content });
    harness.document.root.querySelector('[data-action="jump-latest"]').click();
    assert.equal(content.scrollTop, 600);
    assert.equal(harness.document.activeElement, content);
    resize(1300);
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: {
      type: "state.snapshot", state: { ...panel, transcript: [request, { id: "answer", kind: "answer", agentId: "lead", text: "The completed review", createdAt: timestamp }] },
    } });
    const replaced = harness.document.getElementById("conversation-scroll");
    assert.equal(replaced.scrollTop, 900);
    assert.equal(harness.document.activeElement, replaced);
    assert.equal(harness.document.root.querySelector('[data-action="jump-latest"]').hidden, true);
  } finally { harness.restore(); }
});

test("nested code panes retain their scroll positions across live redraws", () => {
  const panel = panelState({
    running: true,
    agents: { lead: { id: "lead", name: "Reviewer", adapterType: "codex-app-server", status: "running", output: JSON.stringify({ live: true }) } },
    transcript: [{ id: "answer", kind: "answer", agentId: "lead", text: JSON.stringify({ candidate: { findings: [1, 2, 3] } }), createdAt: timestamp }],
  });
  const harness = bootWebview(managerState(), panel);
  try {
    const before = harness.document.root.querySelectorAll("pre[data-code-region]");
    assert.equal(before.length, 2);
    before[0].scrollTop = 320;
    before[0].scrollLeft = 24;
    before[1].scrollTop = 180;
    before[1].scrollLeft = 12;
    harness.document.activeElement = harness.document.getElementById("conversation-scroll");

    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: {
      type: "state.snapshot",
      state: { ...panel, agents: { ...panel.agents, lead: { ...panel.agents.lead, output: `${panel.agents.lead.output} ` } } },
    } });

    const after = harness.document.root.querySelectorAll("pre[data-code-region]");
    assert.equal(after.length, 2);
    assert.notEqual(after[0], before[0]);
    assert.equal(after[0].scrollTop, 320);
    assert.equal(after[0].scrollLeft, 24);
    assert.equal(after[1].scrollTop, 180);
    assert.equal(after[1].scrollLeft, 12);
  } finally { harness.restore(); }
});

test("All runs retains its position on updates and separates search positions", () => {
  const manager = managerState();
  const harness = bootWebview(manager, panelState());
  try {
    const root = harness.document.root;
    root.querySelector('[data-action="run-drawer-toggle"]').click();
    root.querySelector(".run-drawer-list").scrollTop = 650;
    harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
    assert.equal(root.querySelector(".run-drawer-list").scrollTop, 650);
    const search = harness.document.getElementById("run-search");
    search.value = "new query";
    root.dispatch("input", { target: search });
    assert.equal(root.querySelector(".run-drawer-list").scrollTop, 0);
    const cleared = harness.document.getElementById("run-search");
    cleared.value = "";
    root.dispatch("input", { target: cleared });
    assert.equal(root.querySelector(".run-drawer-list").scrollTop, 650);
  } finally { harness.restore(); }
});

test("Agents and the pipeline editor retain their independent scroll positions on updates", () => {
  const manager = managerState();
  const harness = bootWebview(manager, panelState());
  try {
    const root = harness.document.root;
    root.querySelector('[data-action="agents-picker-toggle"]').click();
    root.querySelector(".agents-popover").scrollTop = 350;
    harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
    assert.equal(root.querySelector(".agents-popover").scrollTop, 350);
    root.querySelector('[data-action="agents-picker-toggle"]').click();
    openComposerSettings(harness);
    root.querySelector('[data-action="pipeline-edit"]').click();
    root.querySelector(".editor-scroll").scrollTop = 450;
    harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
    assert.equal(root.querySelector(".editor-scroll").scrollTop, 450);
  } finally { harness.restore(); }
});

test("Pipeline browsing preserves its scroll on snapshots and reveals the active option only on keyboard navigation", () => {
  const manager = managerState();
  const base = panelState();
  const panel = { ...base, pipelines: [...base.pipelines, { id: "specialized-z", name: "Zebra specialized", editable: false, hash: "c".repeat(64), scopeKey: "builtin" }] };
  const harness = bootWebview(manager, panel);
  const originalScrollIntoView = FakeElement.prototype.scrollIntoView;
  const revealed = [];
  FakeElement.prototype.scrollIntoView = function () {
    if (this.getAttribute("role") !== "option") return;
    revealed.push(this.id);
    this.closest(".pipeline-picker-list").scrollTop = 80;
  };
  try {
    const root = harness.document.root;
    harness.document.getElementById("pipeline-picker-button").click();
    assert.equal(revealed.length, 1);
    root.querySelector(".pipeline-picker-list").scrollTop = 160;
    revealed.length = 0;
    harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
    assert.equal(root.querySelector(".pipeline-picker-list").scrollTop, 160);
    assert.equal(revealed.length, 0);
    root.querySelector('[data-action="pipeline-picker-filter"][data-pipeline-filter="specialized"]').click();
    root.querySelector(".pipeline-picker-list").scrollTop = 450;
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panel } });
    assert.equal(root.querySelector(".pipeline-picker-list").scrollTop, 450);
    assert.equal(revealed.length, 0);
    const search = harness.document.getElementById("pipeline-picker-search");
    search.focus();
    root.dispatch("keydown", { key: "End", target: search, preventDefault() {} });
    assert.deepEqual(revealed, ["pipeline-option-specialized-z"]);
    assert.equal(root.querySelector(".pipeline-picker-list").scrollTop, 80);
  } finally {
    FakeElement.prototype.scrollIntoView = originalScrollIntoView;
    harness.restore();
  }
});

test("minimap targets and Latest retain valid focus after redraw and remove temporary tabindex when focus leaves", () => {
  const transcript = [
    { id: "request", kind: "prompt", eventType: "user.message", text: "Review", createdAt: timestamp },
    { id: "answer-one", kind: "answer", agentId: "lead", text: "First review", createdAt: timestamp },
    { id: "answer-two", kind: "answer", agentId: "worker", text: "Second review", createdAt: timestamp },
  ];
  const harness = bootWebview(managerState(), panelState({ transcript }));
  const originalFocus = FakeElement.prototype.focus;
  FakeElement.prototype.focus = function () {
    if ((this.dataset.entry !== undefined || this.id === "conversation-scroll") && !this.hasAttribute("tabindex")) return;
    originalFocus.call(this);
  };
  try {
    const root = harness.document.root;
    root.querySelector('[data-action="jump-message"][data-message-id="answer-one"]').click();
    const first = root.querySelector('[data-entry="answer-one"]');
    assert.equal(harness.document.activeElement, first);
    assert.equal(first.getAttribute("tabindex"), "-1");
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
    const restored = root.querySelector('[data-entry="answer-one"]');
    assert.notEqual(first, restored);
    assert.equal(harness.document.activeElement, restored);
    assert.equal(restored.getAttribute("tabindex"), "-1");
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
    const secondRestore = root.querySelector('[data-entry="answer-one"]');
    assert.equal(harness.document.activeElement, secondRestore);
    root.querySelector('[data-action="jump-latest"]').click();
    assert.equal(secondRestore.hasAttribute("tabindex"), false);
    assert.equal(harness.document.activeElement.id, "conversation-scroll");
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
    const content = harness.document.getElementById("conversation-scroll");
    assert.equal(harness.document.activeElement, content);
    assert.equal(content.getAttribute("tabindex"), "-1");
    harness.document.getElementById("composer-prompt").focus();
    assert.equal(content.hasAttribute("tabindex"), false);
    assert.equal(content.dataset.transientFocus, undefined);
  } finally {
    FakeElement.prototype.focus = originalFocus;
    harness.restore();
  }
});

for (const operationActive of [undefined, true]) {
  test(`pending decisions lock unavailable configuration controls with operation state ${String(operationActive)}`, () => {
    const panel = panelState({
      running: false,
      workflowStatus: "paused",
      ...(operationActive === undefined ? {} : { operationActive }),
      pendingGate: { stepId: "review", stepName: "Review", reason: "maxConsensusRounds", round: 4, decisionRound: 4, allowedActions: ["retry", "acceptUnresolved", "cancel"], rollbackTargets: [] },
      agents: { ...panelState().agents, lead: { ...panelState().agents.lead, sessionId: "session-1" } },
    });
    const harness = bootWebview(managerState(), panel);
    try {
      const root = harness.document.root;
      for (const action of ["availability-check", "working-directory", "task-reset"]) {
        assert.equal(root.querySelector(`.header-action-menu [data-action="${action}"]`).disabled, true);
      }
      root.querySelector('[data-action="inspector-toggle"]').click();
      for (const action of ["availability-check", "working-directory", "bridge-reset", "session-reset"]) {
        assert.equal(root.querySelector(`.inspector [data-action="${action}"]`).disabled, true);
      }
      const discovery = root.querySelector('.inspector [data-action="bridge-discover"]');
      assert.equal(discovery.disabled, false);
      discovery.click();
      assert.equal(harness.messages.at(-1).message.type, "bridge.discover");
      const messages = harness.messages.length;
      root.dispatch("click", { target: root.querySelector('[data-action="availability-check"]') });
      assert.equal(harness.messages.length, messages);
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "run.patch", running: false, operationActive: false, workflowStatus: "interrupted" } });
      for (const action of ["availability-check", "working-directory", "task-reset"]) {
        assert.equal(root.querySelector(`.header-action-menu [data-action="${action}"]`).disabled, false);
      }
    } finally { harness.restore(); }
  });
}

test("configuration controls unlock after terminal operation bookkeeping", () => {
  const harness = bootWebview(managerState(), panelState());
  try {
    const checkProviders = () => harness.document.root.querySelector('.header-action-menu [data-action="availability-check"]');
    for (const workflowStatus of ["completed", "interrupted", "error"]) {
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "run.patch", running: false, operationActive: true, workflowStatus } });
      assert.equal(checkProviders().disabled, true);
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "run.patch", running: false, operationActive: false, workflowStatus } });
      assert.equal(checkProviders().disabled, false);
    }
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "run.patch", running: false, operationActive: true, workflowStatus: "paused" } });
    assert.equal(checkProviders().disabled, true);
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "run.patch", running: false, workflowStatus: "idle" } });
    assert.equal(checkProviders().disabled, false);
  } finally { harness.restore(); }
});


test("localization fixtures translate controls and dialogs while rename dispatch stays stable", () => {
  const localization = {
    locale: "fr-FR",
    messages: {
      Runs: "Fixture runs",
      Ready: "Fixture ready",
      "Run input": "Fixture input",
      "Describe the job for the selected pipeline…": "Fixture prompt",
      "Attach image, text, log, or specification": "Fixture attachment",
      "Rename run": "Fixture rename dialog",
      "Run title": "Fixture title",
      Rename: "Fixture rename",
      Cancel: "Fixture cancel",
      "Close dialog": "Fixture close",
      "Enter a title for this run.": "Fixture title required",
    },
  };
  const harness = bootWebview(managerState(), panelState(), localization);
  try {
    assert.match(harness.document.root.innerHTML, />Fixture runs<\/button>/u);
    assert.equal(harness.document.root.querySelector(".room-status"), null);
    assert.equal(harness.document.getElementById("composer-prompt").getAttribute("aria-label"), "Fixture input");
    assert.equal(harness.document.getElementById("composer-prompt").getAttribute("placeholder"), "Fixture prompt");
    assert.equal(harness.document.root.querySelector('[data-action="attachment-pick"]').getAttribute("aria-label"), "Fixture attachment");
    harness.document.root.querySelector('[data-action="run-rename"]').click();
    assert.match(harness.document.root.innerHTML, /id="app-dialog-title">Fixture rename dialog<\/h2>/u);
    assert.match(harness.document.root.innerHTML, />Fixture title<\/span>/u);
    assert.match(harness.document.root.innerHTML, />Fixture cancel<\/button>/u);
    assert.equal(harness.document.root.querySelector('[data-action="dialog-cancel"]').getAttribute("aria-label"), "Fixture close");
    const input = harness.document.getElementById("app-dialog-input");
    input.value = "";
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(harness.document.getElementById("app-dialog-error").textContent, "Fixture title required");
    input.value = "Runs";
    const before = harness.messages.length;
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.deepEqual(harness.messages.slice(before), [{ type: "conversation.rename", conversationId: "run-1", title: "Runs" }]);
    assert.ok(harness.document.getElementById("bachata-localization"));
    assert.equal(harness.document.getElementById("composer-prompt").getAttribute("aria-label"), "Fixture input");
  } finally {
    harness.restore();
  }
});

test("localization fixtures translate stopped recovery and Chat without changing resume dispatch", () => {
  const result = { ...failedResultState(), status: "interrupted" };
  const manager = managerState({ resultsByConversation: { "run-1": result } });
  const panel = panelState({ workflowStatus: "interrupted", resumableWorkflow: recoverableWorkflow({ outcome: "stoppedByUser" }) });
  const harness = bootWebview(manager, panel, {
    locale: "fr-FR",
    messages: {
      Chat: "Fixture chat",
      "Stopped by you": "Fixture stopped",
      "Resume stopped step": "Fixture resume",
      "Retry failed step": "Fixture retry",
      "Stopped at step {0} of {1}": "Fixture step {0}/{1}",
    },
  });
  try {
    assert.match(harness.document.root.innerHTML, /data-view="chat"[^>]*aria-label="Fixture chat"/u);
    assert.match(harness.document.root.innerHTML, />Fixture resume<\/button>/u);
    assert.match(harness.document.root.innerHTML, /Fixture stopped/u);
    assert.match(harness.document.root.innerHTML, /Fixture step 2\/3 · Implement/u);
    assert.doesNotMatch(harness.document.root.innerHTML, />Fixture retry<\/button>/u);
    const card = harness.document.root.querySelector(".run-outcome");
    const before = harness.messages.length;
    card.querySelector('[data-action="workflow-resume"]').click();
    assert.deepEqual(harness.messages.slice(before), [{ type: "conversation.runtime", conversationId: "run-1", message: { type: "workflow.resume" } }]);
  } finally {
    harness.restore();
  }
});

test("localization fixtures escape translated markup and placeholder data without translating participant content", () => {
  const definition = pipelineDefinition();
  definition.agents[0].name = 'Role"><button data-action="placeholder-injection">x</button>';
  const panel = panelState({
    selectedPipelineDefinition: definition,
    transcript: [
      { id: "localized-user", kind: "prompt", eventType: "user.message", text: "Runs", createdAt: timestamp },
      { id: "localized-answer", kind: "answer", agentId: "lead", text: "Run title", createdAt: timestamp },
    ],
  });
  const harness = bootWebview(managerState(), panel, {
    locale: "fr-FR",
    messages: {
      Runs: "Fixture runs",
      "Run title": '<button data-action="translated-injection">Fixture title</button> & "quoted"',
      "Provider for {0}": 'Fixture "{0}" <&>',
    },
  });
  try {
    const html = harness.document.root.innerHTML;
    assert.match(html, /data-entry="localized-user"[^]*?class="message-text markdown"><p>Runs<\/p>/u);
    assert.match(html, /data-entry="localized-answer"[^]*?class="message-text markdown"><p>Run title<\/p>/u);
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    const provider = harness.document.getElementById("agents-provider-lead");
    assert.equal(provider.getAttribute("aria-label"), "Fixture &quot;Role&quot;&gt;&lt;button data-action=&quot;placeholder-injection&quot;&gt;x&lt;/button&gt;&quot; &lt;&amp;&gt;");
    assert.equal(harness.document.root.querySelector('[data-action="placeholder-injection"]'), null);
    harness.document.root.querySelector('[data-action="agents-picker-toggle"]').click();
    harness.document.root.querySelector('[data-action="run-rename"]').click();
    assert.ok(harness.document.root.innerHTML.includes('&lt;button data-action=&quot;translated-injection&quot;&gt;Fixture title&lt;/button&gt; &amp; &quot;quoted&quot;'));
    assert.equal(harness.document.root.querySelector('[data-action="translated-injection"]'), null);
  } finally {
    harness.restore();
  }
});

test("localization configuration controls displayed dates and attachment number formatting", () => {
  const locale = "de-DE";
  const panel = panelState({
    transcript: [{ id: "dated-message", kind: "prompt", eventType: "user.message", text: "Message", createdAt: timestamp }],
    attachments: [{ id: "locale-attachment", name: "sample.txt", mimeType: "text/plain", size: 1536 }],
  });
  const harness = bootWebview(managerState(), panel, { locale, messages: {} });
  try {
    const message = harness.document.root.querySelector(".user-message");
    assert.equal(message.getAttribute("title"), new Date(timestamp).toLocaleString(locale));
    const expectedTime = new Date(timestamp).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    assert.ok(harness.document.root.innerHTML.includes(`datetime="${timestamp}">${expectedTime}</time>`));
    const expectedSize = new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(1.5);
    assert.ok(harness.document.root.innerHTML.includes(`<small>${expectedSize} KB</small>`));
  } finally {
    harness.restore();
  }
});

test("Browser Bridge connection states update without recovery controls or error banners", () => {
  const bridge = { enabled: true, connected: false, sessions: [], connectionState: "connecting" };
  const harness = bootWebview(managerState(), panelState({ browserBridge: bridge }));
  try {
    openBridgeInspector(harness);
    const before = harness.messages.length;
    for (const [connectionState, connected, label] of [
      ["connecting", false, "Connecting…"],
      ["retrying", false, "Browser unavailable — retrying"],
      ["connected", true, "Connected"],
      ["disconnected", false, "Disconnected"],
    ]) {
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "bridge.patch", status: { ...bridge, connectionState, connected } } });
      const status = harness.document.root.innerHTML.match(new RegExp(`<span data-bridge-state="${connectionState}"([^>]*)>([^<]*)</span>`, "u"));
      assert.ok(status, connectionState);
      assert.equal(status[2], label);
      assert.match(status[1], /role="status"/u);
      if (connectionState === "connecting") assert.match(status[1], /aria-live="off"/u);
      else assert.doesNotMatch(status[1], /aria-live="off"/u);
      assert.equal(harness.document.root.querySelector("[data-bridge-reason]"), null);
      assert.equal(harness.document.root.querySelector(".error-banner"), null);
      assert.doesNotMatch(harness.document.root.innerHTML, /Verify and reconnect|clear quarantine|verify recovery/iu);
    }
    assert.equal(harness.messages.length, before);
  } finally { harness.restore(); }
});

test("Browser Bridge blocked states show only known user-facing reasons", () => {
  const reasons = [
    ["portUnavailable", "Another application is using the browser connection."],
    ["localWindowRequired", "Open this workspace in a local VS Code window"],
    ["browserUpdateRequired", "Update the Bachata Browser Bridge extension"],
    ["pairingExpired", "Pairing has expired. Reset pairing"],
    ["accessDenied", "Your computer denied permission"],
  ];
  const bridge = { enabled: true, connected: false, sessions: [], connectionState: "blocked", error: "Shared resource is quarantined: browser-bridge:profile owner-secret database.sqlite" };
  const harness = bootWebview(managerState(), panelState({ browserBridge: bridge }));
  try {
    openBridgeInspector(harness);
    for (const [blockedReason, message] of reasons) {
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "bridge.patch", status: { ...bridge, blockedReason } } });
      assert.match(harness.document.root.innerHTML, /data-bridge-state="blocked"[^>]*>Browser unavailable</u);
      const reason = harness.document.root.querySelector(`[data-bridge-reason="${blockedReason}"]`);
      assert.ok(reason);
      assert.ok(harness.document.root.innerHTML.includes(`>${message}`));
      assert.doesNotMatch(harness.document.root.innerHTML, /quarantin|browser-bridge:profile|owner-secret|database\.sqlite/iu);
    }
    for (const blockedReason of [undefined, "owner-secret"]) {
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "bridge.patch", status: { ...bridge, blockedReason } } });
      assert.match(harness.document.root.innerHTML, /data-bridge-state="retrying"[^>]*>Browser unavailable — retrying</u);
      assert.equal(harness.document.root.querySelector("[data-bridge-reason]"), null);
      assert.doesNotMatch(harness.document.root.innerHTML, /quarantin|browser-bridge:profile|owner-secret|database\.sqlite/iu);
    }
  } finally { harness.restore(); }
});

test("Browser Bridge announces changed states and reasons without repeating unchanged snapshots", () => {
  const bridge = { enabled: true, connected: false, sessions: [], connectionState: "connecting" };
  const harness = bootWebview(managerState(), panelState({ browserBridge: bridge }));
  try {
    openBridgeInspector(harness);
    const patch = (status) => harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "bridge.patch", status } });
    const current = () => harness.document.root.innerHTML.match(/<span data-bridge-state="[^"]+"([^>]*)>/u)?.[1] ?? "";
    assert.match(current(), /role="status"/u);
    patch(bridge);
    assert.match(current(), /aria-live="off"/u);
    patch({ ...bridge, connectionState: "retrying" });
    assert.doesNotMatch(current(), /aria-live="off"/u);
    const blocked = { ...bridge, connectionState: "blocked", blockedReason: "portUnavailable" };
    patch(blocked);
    const reason = () => harness.document.root.querySelector("[data-bridge-reason]");
    assert.equal(reason().getAttribute("role"), "status");
    assert.notEqual(reason().getAttribute("aria-live"), "off");
    patch(blocked);
    assert.match(current(), /aria-live="off"/u);
    assert.equal(reason().getAttribute("aria-live"), "off");
    patch({ ...blocked, blockedReason: "accessDenied" });
    assert.match(current(), /aria-live="off"/u);
    assert.notEqual(reason().getAttribute("aria-live"), "off");
    patch({ ...bridge, connectionState: "connected", connected: true });
    assert.equal(reason(), null);
    assert.doesNotMatch(current(), /aria-live="off"/u);
  } finally { harness.restore(); }
});

test("Browser Bridge unknown snapshot states remain ordinary retry states", () => {
  const harness = bootWebview();
  try {
    openBridgeInspector(harness);
    for (const connectionState of ["reconnecting", "browser-bridge:profile", "constructor", "__proto__"]) {
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panelState({
        browserBridge: { enabled: true, connected: false, sessions: [], connectionState },
      }) } });
      const status = harness.document.root.innerHTML.match(/<span data-bridge-state="([^"]+)"/u)?.[1];
      assert.equal(status, "retrying");
      assert.match(harness.document.root.innerHTML, /data-bridge-state="retrying"[^>]*>Browser unavailable — retrying</u);
      assert.doesNotMatch(harness.document.root.innerHTML, /browser-bridge:profile|\[object Object\]|function Object/u);
      assert.equal(harness.document.root.querySelector(".render-failure"), null);
    }
  } finally { harness.restore(); }
});

test("Browser Bridge legacy errors stay out of both normal setup surfaces", () => {
  for (const surface of ["inspector", "agents"]) {
    const panel = cliAssignmentPanel();
    panel.browserBridge = { enabled: true, connected: false, sessions: [], error: "Shared resource is quarantined: browser-bridge:profile owner-secret database.sqlite" };
    const harness = bootWebview(managerState(), panel);
    try {
      if (surface === "inspector") {
        openBridgeInspector(harness);
      } else {
        harness.document.getElementById("agents-picker-button").click();
        chooseAgentOption(harness, "agents-provider-builder", "browser");
      }
      assert.match(harness.document.root.innerHTML, /data-bridge-state="retrying"[^>]*>Browser unavailable — retrying</u);
      assert.equal(harness.document.root.querySelector("[data-bridge-reason]"), null);
      assert.doesNotMatch(harness.document.root.innerHTML, /quarantin|browser-bridge:profile|owner-secret|database\.sqlite|Verify and reconnect/iu);
    } finally { harness.restore(); }
  }
});

test("Find browser only discovers and Reset pairing only requests new credentials", () => {
  const harness = bootWebview(managerState(), bridgePanelWithToken("PAIRING_FIXTURE"));
  try {
    openBridgeInspector(harness);
    const before = harness.messages.length;
    harness.document.root.querySelector('[data-action="bridge-discover"]').click();
    assert.equal(harness.messages.length, before + 1);
    assert.deepEqual(harness.messages.at(-1).message, { type: "bridge.discover" });
    harness.document.root.querySelector('[data-action="bridge-reset"]').click();
    assert.equal(harness.messages.length, before + 1);
    const dialog = harness.document.root.querySelector(".app-dialog");
    assert.ok(dialog);
    const message = harness.document.root.innerHTML.match(/<p id="app-dialog-message">([^<]*)<\/p>/u)?.[1];
    assert.match(message, /Replace the pairing token and disconnect the paired browser/u);
    assert.doesNotMatch(message, /repair|recover|quarantin|owner/iu);
    assert.match(harness.document.root.innerHTML, /data-action="dialog-confirm"[^>]*>Reset pairing<\/button>/u);
    harness.document.root.querySelector('[data-action="dialog-confirm"]').click();
    assert.equal(harness.messages.length, before + 2);
    assert.deepEqual(harness.messages.at(-1).message, { type: "bridge.reset" });
  } finally { harness.restore(); }
});

test("Browser Bridge product states retain localized escaped copy and stable actions", () => {
  const label = "Connexion <locale>…";
  const bridge = { enabled: true, connected: false, sessions: [], connectionState: "connecting" };
  const harness = bootWebview(managerState(), panelState({ browserBridge: bridge }), { locale: "fr", messages: { "Connecting…": label, "Find browser": "Trouver le navigateur" } });
  try {
    openBridgeInspector(harness);
    assert.match(harness.document.root.innerHTML, /data-bridge-state="connecting"[^>]*>Connexion &lt;locale&gt;…</u);
    assert.equal(harness.document.root.innerHTML.includes("<locale>"), false);
    assert.ok(harness.document.root.querySelector('[data-action="bridge-discover"]'));
    assert.match(harness.document.root.innerHTML, /data-action="bridge-discover"[^>]*>Trouver le navigateur</u);
  } finally { harness.restore(); }
});

test("legacy Browser Bridge quarantine errors never become global alerts or hidden attributes", () => {
  const raw = "Shared resource is quarantined: browser-bridge:profile; ownerId=private-owner; database=private.sqlite";
  const harness = bootWebview(managerState(), panelState({ browserBridge: { enabled: true, connected: false, sessions: [], connectionState: "retrying" } }));
  try {
    harness.sendWindowMessage({ type: "manager.error", message: raw });
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "error", message: `Error: ${raw}` } });
    assert.equal(harness.document.root.querySelectorAll(".global-error").length, 0);
    assert.doesNotMatch(harness.document.root.innerHTML, /quarantin|browser-bridge:profile|private-owner|private\.sqlite/iu);
    openBridgeInspector(harness);
    assert.match(harness.document.root.innerHTML, /data-bridge-state="retrying"[^>]*>Browser unavailable — retrying</u);
    for (const browserBridge of [
      { enabled: true, connected: false, sessions: [], connectionState: "connecting" },
      { enabled: true, connected: true, sessions: [], connectionState: "connected" },
    ]) {
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panelState({ browserBridge }) } });
      assert.equal(harness.document.root.querySelectorAll(".global-error").length, 0);
      assert.doesNotMatch(harness.document.root.innerHTML, /quarantin|browser-bridge:profile|private-owner|private\.sqlite/iu);
    }
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "error", message: "Permission denied when saving review.md" } });
    assert.equal(harness.document.root.querySelectorAll(".global-error").length, 1);
    assert.match(harness.document.root.innerHTML, /Permission denied when saving review\.md/u);
  } finally { harness.restore(); }
});

test("non-Bridge quarantine failures remain visible and dismissible without cleanup internals", () => {
  const unrelated = "Invalid pipeline quarantine-review.pipeline.json";
  const cases = [
    ["Shared resource is quarantined: local-agents:global, working-directory:private-workspace", "Local agents are unavailable"],
    ["Shared resource is quarantined: browser-bridge:profile, local-agents:global", "Local agents are unavailable"],
    ["Previous provider cleanup is unconfirmed. Once the previous agents are stopped, run Bachata: Clear Resource Quarantine, then try again.", "Local agents are unavailable"],
    ["Shared resource is quarantined: repository-execution:private-repository", "This operation is unavailable"],
  ];
  for (const [raw, visible] of cases) {
    const harness = bootWebview();
    try {
      harness.sendWindowMessage({ type: "manager.error", message: raw });
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "error", message: unrelated } });
      assert.equal(harness.document.root.querySelectorAll(".global-error").length, 2);
      assert.ok(harness.document.root.innerHTML.includes(visible));
      assert.ok(harness.document.root.innerHTML.includes(unrelated));
      assert.doesNotMatch(harness.document.root.innerHTML, /Shared resource is quarantined|Clear Resource Quarantine|local-agents:global|working-directory:|private-workspace|private-repository|browser-bridge:profile/iu);
      const dismiss = [...harness.document.root.querySelectorAll('[data-action="error-dismiss"]')].find((button) => button.dataset.errorMessage.startsWith(visible));
      assert.ok(dismiss);
      dismiss.click();
      assert.equal(harness.document.root.querySelectorAll(".global-error").length, 1);
      assert.ok(harness.document.root.innerHTML.includes(unrelated));
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panelState() } });
      assert.equal(harness.document.root.querySelectorAll(".global-error").length, 1);
      assert.equal(harness.document.root.innerHTML.includes(visible), false);
    } finally { harness.restore(); }
  }
});

const readableContinuationResult = (overrides = {}) => completedResult({
  finalAssessment: { outcome: "completed", method: "singleProvider", summary: "The result needs an implementation follow-up.", producedBy: [] },
  finalRuling: JSON.stringify({ summary: "Confirm the remaining finding before changing code.", internalId: "hidden-ruling-id", providerSessionId: "hidden-provider-session" }),
  finalDecisionEventId: 991234,
  executionRef: "hidden-execution-id",
  retainedRunId: "hidden-retained-run",
  changedFiles: ["src/view.ts"],
  checks: [{ command: "npm run check-types", status: "passed", candidateTree: "f".repeat(64), outputReference: "hidden-output-reference" }],
  findings: [{
    id: "hidden-finding-id",
    subject: "The action is missing",
    message: "Readers cannot continue the result.",
    disposition: "unresolved",
    location: { file: "src/view.ts", startLine: 42 },
    evidence: ["The result header has no implementation action."],
    challenges: ["Ownership behavior still needs confirmation."],
    provenance: { source: "stepOutput", stepId: "hidden-step-id", participantIds: ["hidden-participant-id"] },
  }],
  unresolvedRisks: ["The source may be read-only."],
  evidenceGaps: ["Runtime behavior has not been checked."],
  readableMarkdown: [
    "# Run result: Completed",
    "",
    "## Final assessment",
    "The result needs an implementation follow-up.",
    "",
    "## Final ruling",
    "Confirm the remaining finding before changing code.",
    "",
    "## Findings",
    "- [unresolved] The action is missing — src/view.ts:42",
    "  Readers cannot continue the result.",
    "  Evidence: The result header has no implementation action.",
    "  Challenge: Ownership behavior still needs confirmation.",
    "",
    "## Changed files",
    "- src/view.ts",
    "",
    "## Verification",
    "- npm run check-types: passed",
    "",
    "## Unresolved risks",
    "- The source may be read-only.",
    "",
    "## Evidence gaps",
    "- Runtime behavior has not been checked.",
  ].join("\n"),
  continuation: { available: true, resultVersion: "result-version-1" },
  ...overrides,
});

const openResultActions = (managerOverrides = {}, panelOverrides = {}, result = readableContinuationResult(), detailsOpen = true) => {
  const harness = bootWebview(
    managerState({ resultsByConversation: { "run-1": result }, ...managerOverrides }),
    panelState({ workflowStatus: "completed", ...panelOverrides }),
  );
  harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
  const detailsToggle = harness.document.root.querySelector('[data-action="result-details-toggle"]');
  if (detailsOpen && detailsToggle?.getAttribute("aria-expanded") !== "true") detailsToggle?.click();
  return harness;
};

const dispatchResultAction = (harness, action, conversationId = "run-1", resultVersion = "result-version-1") => {
  const button = new FakeHTMLButtonElement("button");
  button.setAttribute("data-action", action);
  button.setAttribute("data-conversation", conversationId);
  if (resultVersion) button.setAttribute("data-result-version", resultVersion);
  harness.document.root.dispatch("click", { target: button, preventDefault() {}, stopPropagation() {} });
};

test("result copy uses the complete readable projection and excludes internal fields", async () => {
  const result = readableContinuationResult();
  const harness = openResultActions({}, {}, result);
  try {
    harness.document.root.querySelector('[data-action="result-copy"]').click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.clipboard.writes, [result.readableMarkdown]);
    const copied = harness.clipboard.writes[0];
    for (const section of ["Final assessment", "Final ruling", "Findings", "Changed files", "Verification", "Unresolved risks", "Evidence gaps"]) {
      assert.ok(copied.includes(section), section);
    }
    assert.match(copied, /\[unresolved\][^]*src\/view\.ts:42[^]*Evidence:[^]*Challenge:/u);
    assert.doesNotMatch(copied, /hidden-|991234|f{64}|providerSessionId|provenance|candidateTree|outputReference/u);
    assert.match(harness.document.liveStatus.textContent, /copied to the clipboard/u);
  } finally { harness.restore(); }
});

for (const failure of ["rejected", "unavailable", "synchronous"]) {
  test(`result copy announces ${failure} clipboard failure without claiming success`, async () => {
    const harness = openResultActions();
    try {
      if (failure === "rejected") harness.clipboard.refuse = true;
      if (failure === "unavailable") navigator.clipboard = undefined;
      if (failure === "synchronous") navigator.clipboard.writeText = () => { throw new Error("Clipboard refused synchronously"); };
      harness.document.root.querySelector('[data-action="result-copy"]').click();
      await new Promise((resolve) => setImmediate(resolve));
      assert.match(harness.document.liveStatus.textContent, /Copying the run result failed\./u);
      assert.notEqual(harness.document.root.querySelector('[data-action="result-copy"]').textContent, "Copied");
      assert.equal(harness.messages.some((message) => message.type === "conversation.continueFromResult"), false);
    } finally { harness.restore(); }
  });
}

for (const [label, status, outcome] of [
  ["completed", "completed", "completed"],
  ["inconclusive", "completed", "inconclusive"],
  ["interrupted", "interrupted", "inconclusive"],
  ["failed", "error", "failedBeforeRuling"],
]) {
  test(`${label} results expose readable copy and a host-approved continuation without executing`, () => {
    const result = readableContinuationResult({ status, finalAssessment: { outcome, method: "none", summary: `${label} assessment`, producedBy: [] } });
    const harness = openResultActions({}, { workflowStatus: status }, result);
    try {
      const copy = harness.document.root.querySelector('[data-action="result-copy"]');
      const continuation = harness.document.root.querySelector('[data-action="result-continue"]');
      assert.ok(copy);
      assert.equal(copy.getAttribute("aria-disabled"), null);
      assert.equal(continuation.getAttribute("aria-disabled"), null);
      assert.equal(continuation.disabled, false);
      assert.equal(harness.document.root.querySelectorAll(".execution-result-footer").length, 1);
      assert.equal(continuation.closest(".execution-result-footer").tagName, "FOOTER");
      continuation.focus();
      assert.equal(harness.document.activeElement, continuation);
      harness.messages.length = 0;
      continuation.click();
      assert.deepEqual(harness.messages, [{ type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "result-version-1", findingIds: ["hidden-finding-id"] }]);
      assert.equal(harness.messages.some((message) => message.message?.type === "user.message" || message.message?.type === "workflow.restart" || message.message?.type === "workflow.resume"), false);
    } finally { harness.restore(); }
  });
}

for (const [label, managerOverrides, panelOverrides, resultOverrides, reason] of [
  ["read-only pipeline", {}, {}, { continuation: { available: false, reason: "No available pipeline can write changes; the available pipelines have read-only write scope." } }, /read-only write scope/u],
  ["missing pipeline", {}, {}, { continuation: { available: false, reason: "No write-capable pipeline is available." } }, /No write-capable pipeline/u],
  ["capacity", {}, {}, { continuation: { available: false, reason: "The open-run limit has been reached. Close a run before starting implementation." } }, /open-run limit/u],
  ["stale result", {}, {}, { continuation: { available: false, reason: "The recorded result belongs to an earlier attempt." } }, /earlier attempt/u],
  ["archived", { conversations: [{ ...conversationSummary(), archived: true }] }, {}, {}, /Unarchive this run/u],
  ["restarting", {}, { operationActive: true }, {}, /active run operation/u],
  ["resuming", {}, { operationActive: true, workflowStatus: "interrupted" }, {}, /active run operation/u],
  ["manager running before panel update", { conversations: [{ ...conversationSummary(), running: true, workflowStatus: "running" }] }, {}, {}, /Finish or stop this run/u],
  ["waiting for resources", { conversations: [{ ...conversationSummary(), waitingForResources: true }] }, {}, {}, /waiting for resources/u],
  ["queued messages", {}, { queuedMessages: [{ id: "queued", kind: "pipeline", prompt: "Another request", mode: "implementation", recipients: [], attachmentIds: [], createdAt: timestamp }] }, {}, /queued messages/u],
  ["unconfirmed availability", {}, {}, { continuation: undefined }, /availability has not been confirmed/u],
  ["unissued result version", {}, {}, { continuation: { available: true } }, /result is not ready to continue/u],
  ["empty readable result", {}, {}, { readableMarkdown: " \n " }, /no result content/u],
]) {
  test(`${label} makes result continuation unavailable with an accessible exact reason`, () => {
    const harness = openResultActions(managerOverrides, panelOverrides, readableContinuationResult(resultOverrides));
    try {
      const continuation = harness.document.root.querySelector('[data-action="result-continue"]');
      if (label === "empty readable result") {
        assert.equal(continuation, null);
        assert.equal(harness.document.root.querySelector(".execution-result-footer"), null);
        harness.messages.length = 0;
        dispatchResultAction(harness, "result-continue");
        assert.match(harness.document.liveStatus.textContent, reason);
        assert.deepEqual(harness.messages, []);
        return;
      }
      assert.ok(continuation);
      assert.equal(continuation.closest(".execution-result-footer").tagName, "FOOTER");
      assert.equal(continuation.getAttribute("aria-disabled"), "true");
      assert.equal(continuation.disabled, false);
      const explanation = harness.document.getElementById(continuation.getAttribute("aria-describedby").split(/\s+/u)[0]);
      assert.ok(explanation);
      assert.match(explanation.textContent, reason);
      assert.match(continuation.getAttribute("title"), reason);
      continuation.focus();
      assert.equal(harness.document.activeElement, continuation);
      harness.messages.length = 0;
      continuation.click();
      assert.match(harness.document.liveStatus.textContent, reason);
      dispatchResultAction(harness, "result-continue");
      assert.equal(harness.messages.some((message) => message.type === "conversation.continueFromResult"), false);
    } finally { harness.restore(); }
  });
}

test("read-only ownership permits result copy and refuses continuation even from stale controls", async () => {
  const harness = openResultActions({ readOnly: { owned: false, reason: "Another window owns the workspace", retryCommand: "Bachata: Workspace Ownership" } });
  try {
    const copy = harness.document.root.querySelector('[data-action="result-copy"]');
    assert.equal(copy.getAttribute("aria-disabled"), null);
    copy.click();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.clipboard.writes.length, 1);
    const continuation = harness.document.root.querySelector('[data-action="result-continue"]');
    assert.equal(continuation.getAttribute("aria-disabled"), "true");
    assert.match(harness.document.root.querySelector(".result-continuation-tooltip").textContent, /can only read/u);
    harness.messages.length = 0;
    continuation.click();
    dispatchResultAction(harness, "result-continue");
    assert.equal(harness.messages.length, 0);
    assert.match(harness.document.liveStatus.textContent, /can only read/u);
  } finally { harness.restore(); }
});

test("an active newer attempt hides stale result actions and rejects delayed continuation dispatch", () => {
  const harness = openResultActions({}, { running: true, workflowStatus: "running" });
  try {
    assert.equal(harness.document.root.querySelector('[data-action="result-copy"]'), null);
    assert.equal(harness.document.root.querySelector('[data-action="result-continue"]'), null);
    harness.messages.length = 0;
    dispatchResultAction(harness, "result-continue");
    assert.equal(harness.messages.length, 0);
    assert.match(harness.document.liveStatus.textContent, /Finish or stop this run/u);
  } finally { harness.restore(); }
});

test("missing result content never falls back to raw objects for copying or continuation", async () => {
  for (const result of [readableContinuationResult({ readableMarkdown: undefined }), readableContinuationResult({ readableMarkdown: " \n " })]) {
    const harness = openResultActions({}, {}, result);
    try {
      assert.equal(harness.document.root.querySelector('[data-action="result-copy"]'), null);
      harness.messages.length = 0;
      dispatchResultAction(harness, "result-copy");
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(harness.clipboard.writes, []);
      assert.match(harness.document.liveStatus.textContent, /no readable result/u);
      dispatchResultAction(harness, "result-continue");
      assert.equal(harness.messages.length, 0);
      assert.match(harness.document.liveStatus.textContent, /no result content/u);
    } finally { harness.restore(); }
  }
});

test("missing and stale source selections refuse delayed result actions", async () => {
  const harness = openResultActions();
  try {
    harness.messages.length = 0;
    for (const action of ["result-copy", "result-continue"]) {
      dispatchResultAction(harness, action, "different-run");
      assert.match(harness.document.liveStatus.textContent, /no longer selected/u);
    }
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState() });
    assert.equal(harness.document.root.querySelector('[data-action="result-copy"]'), null);
    assert.equal(harness.document.root.querySelector('[data-action="result-continue"]'), null);
    dispatchResultAction(harness, "result-continue");
    assert.match(harness.document.liveStatus.textContent, /no result content/u);
    dispatchResultAction(harness, "result-copy");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(harness.clipboard.writes, []);
    assert.equal(harness.messages.some((message) => message.type === "conversation.continueFromResult"), false);
  } finally { harness.restore(); }
});

test("pipeline participant output uses step IDs before unique recorded names and excludes unrelated entries", () => {
  const entry = (id, overrides = {}) => ({ id, kind: "answer", agentId: "lead", text: id, createdAt: timestamp, ...overrides });
  const panel = panelState({
    selectedPipelineDefinition: threeStepPipelineDefinition(),
    activeStep: "Review",
    transcript: [
      entry("id-wins", { stepId: "plan", step: "Review" }),
      entry("legacy-id", { step: "implement" }),
      entry("legacy-name", { step: "Review" }),
      entry("unknown-authoritative-id", { stepId: "removed-step", step: "Plan" }),
      entry("unrelated-output"),
      entry("unknown-step", { step: "Other pipeline" }),
      entry("internal-prompt", { kind: "prompt", stepId: "plan", eventType: "agent.prompt" }),
      entry("bookkeeping", { kind: "event", stepId: "plan", eventType: "output.validated" }),
    ],
  });
  const harness = bootWebview(managerState({ eventsByConversation: { "run-1": [stepEvent(1, "plan", "Plan", timestamp)] } }), panel);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const row = (id) => harness.document.root.querySelector(`[data-disclosure-key="run-1:pipeline-step:${id}"]`);
    assert.match(row("plan").textContent, /id-wins/u);
    assert.doesNotMatch(row("plan").textContent, /unknown-authoritative-id|legacy-name/u);
    assert.match(row("implement").textContent, /legacy-id/u);
    assert.match(row("review").textContent, /legacy-name/u);
    assert.doesNotMatch(row("review").textContent, /id-wins/u);
    assert.doesNotMatch(harness.document.root.querySelector(".pipeline-summary").textContent, /unrelated-output|unknown-step|internal-prompt|bookkeeping|unknown-authoritative-id/u);
    row("plan").open = true;
    harness.document.root.querySelector('[data-message-id="id-wins"]').click();
    const sameMessage = harness.document.root.querySelector('[data-entry="id-wins"]');
    assert.ok(sameMessage);
    assert.equal(harness.document.activeElement, sameMessage);
  } finally { harness.restore(); }
});

test("pipeline name fallback rejects ambiguous names while recorded IDs still identify output", () => {
  const definition = threeStepPipelineDefinition();
  definition.steps[0].name = "Shared name";
  definition.steps[1].name = "Shared name";
  const panel = panelState({ selectedPipelineDefinition: definition, transcript: [
    { id: "ambiguous-name", kind: "answer", agentId: "lead", step: "Shared name", text: "Ambiguous output", createdAt: timestamp },
    { id: "exact-step", kind: "answer", agentId: "lead", stepId: "implement", step: "Shared name", text: "Exact output", createdAt: timestamp },
  ] });
  const harness = bootWebview(managerState({ eventsByConversation: { "run-1": [stepEvent(1, "implement", "Shared name", timestamp)] } }), panel);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const summary = harness.document.root.querySelector(".pipeline-summary");
    assert.doesNotMatch(summary.textContent, /Ambiguous output/u);
    assert.match(summary.textContent, /Exact output/u);
    assert.equal(summary.querySelectorAll(".pipeline-step-message").length, 1);
  } finally { harness.restore(); }
});

test("pipeline output belongs to the recorded attempt revision and excludes earlier attempt responses", () => {
  const newTime = "2026-09-14T10:00:00Z";
  const recordedSteps = [{ id: "recorded-step", name: "Recorded step" }];
  const panel = panelState({ selectedPipelineDefinition: undefined, transcript: [
    { id: "previous-output", kind: "answer", agentId: "lead", stepId: "recorded-step", text: "Earlier attempt output", createdAt: "2026-09-14T09:00:00Z" },
    { id: "new-output", kind: "answer", agentId: "lead", step: "Recorded step", text: "Current attempt output", createdAt: "2026-09-14T10:01:00Z" },
  ] });
  const harness = bootWebview(managerState({ eventsByConversation: { "run-1": [attemptStart(2, "run.restarted", newTime, recordedSteps)] } }), panel);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const summary = harness.document.root.querySelector(".pipeline-summary");
    assert.ok(summary);
    assert.match(summary.textContent, /Recorded step|Current attempt output/u);
    assert.doesNotMatch(summary.textContent, /Earlier attempt output/u);
  } finally { harness.restore(); }
});

test("pipeline steps render answers, interruptions and errors with exact Chat navigation", () => {
  const transcript = [
    { id: "step-answer", kind: "answer", text: "The participant answer" },
    { id: "step-interruption", kind: "interrupted", text: "" },
    { id: "step-error", kind: "error", text: "The provider refused the request" },
  ].map((entry) => ({ ...entry, agentId: "lead", stepId: "plan", createdAt: timestamp }));
  const panel = panelState({ selectedPipelineDefinition: threeStepPipelineDefinition(), transcript });
  const manager = managerState({ eventsByConversation: { "run-1": [stepEvent(1, "plan", "Plan", timestamp)] } });
  const harness = bootWebview(manager, panel);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const messages = harness.document.root.querySelectorAll(".pipeline-step-message");
    assert.equal(messages.length, 3);
    assert.match(messages[0].textContent, /Response[^]*The participant answer/u);
    assert.match(messages[1].textContent, /Interrupted/u);
    assert.match(messages[2].textContent, /Error[^]*The provider refused the request/u);
    for (const entry of transcript) {
      const button = harness.document.root.querySelector(`[data-message-id="${entry.id}"]`);
      assert.ok(button);
      const body = button.closest(".pipeline-step-message").querySelector(".pipeline-step-message-body");
      assert.equal(body.getAttribute("tabindex"), "0");
      assert.equal(body.getAttribute("role"), "region");
      assert.match(body.getAttribute("aria-label"), /Lead:/u);
    }
    harness.document.root.querySelector('[data-message-id="step-error"]').click();
    assert.equal(harness.document.activeElement.dataset.entry, "step-error");
  } finally { harness.restore(); }
});

test("pipeline disclosure choices survive live redraws when default step states change", () => {
  const panel = panelState({ selectedPipelineDefinition: threeStepPipelineDefinition(), transcript: [
    { id: "plan-work", kind: "answer", agentId: "lead", stepId: "plan", text: "Plan output", createdAt: timestamp },
    { id: "implementation-work", kind: "answer", agentId: "worker", stepId: "implement", text: "Implementation output", createdAt: timestamp },
  ] });
  const manager = managerState({ eventsByConversation: { "run-1": [stepEvent(1, "plan", "Plan", timestamp)] } });
  const harness = bootWebview(manager, panel);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const setOpen = (step, open) => {
      const details = harness.document.root.querySelector(`[data-disclosure-key="run-1:pipeline-step:${step}"]`);
      details.open = open;
      harness.document.root.dispatch("toggle", { target: details });
    };
    setOpen("plan", false);
    setOpen("implement", true);
    harness.sendWindowMessage({ type: "manager.snapshot", state: { ...manager, eventsByConversation: { "run-1": [...manager.eventsByConversation["run-1"], stepEvent(2, "implement", "Implement", timestamp)] } } });
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panel } });
    assert.equal(harness.document.root.querySelector('[data-disclosure-key="run-1:pipeline-step:plan"]').open, false);
    assert.equal(harness.document.root.querySelector('[data-disclosure-key="run-1:pipeline-step:implement"]').open, true);
  } finally { harness.restore(); }
});

test("pipeline output and nested result code retain both scroll axes after snapshot replacement", () => {
  const panel = panelState({ workflowStatus: "completed", selectedPipelineDefinition: threeStepPipelineDefinition(), transcript: [
    { id: "scroll-answer", kind: "answer", agentId: "lead", stepId: "plan", text: '```json\n{"first":[1,2,3]}\n```\n\n```typescript\nconst second = 2;\n```', createdAt: timestamp },
  ] });
  const result = readableContinuationResult({ finalRuling: 'Ruling details:\n\n```json\n{"ruling":"confirm first"}\n```' });
  const manager = managerState({ resultsByConversation: { "run-1": result }, eventsByConversation: { "run-1": [stepEvent(1, "plan", "Plan", timestamp)] } });
  const harness = bootWebview(manager, panel);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    harness.document.root.querySelector('[data-action="result-details-toggle"]').click();
    const outputSelector = '[data-code-scroll-surface="pipeline:plan:scroll-answer"]';
    const body = harness.document.root.querySelector(`${outputSelector} [data-output-scroll]`);
    const code = harness.document.root.querySelectorAll(`${outputSelector} pre[data-code-region]`);
    const ruling = harness.document.root.querySelector('[data-code-scroll-surface="result:run-1"] pre[data-code-region]');
    assert.equal(code.length, 2);
    assert.ok(ruling);
    body.scrollTop = 480;
    body.scrollLeft = 32;
    code[0].scrollTop = 360;
    code[0].scrollLeft = 72;
    code[1].scrollTop = 180;
    code[1].scrollLeft = 24;
    ruling.scrollTop = 240;
    ruling.scrollLeft = 48;
    body.focus();
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: { ...panel, transcript: [
      { id: "new-before", kind: "answer", agentId: "worker", stepId: "plan", text: '```json\n{"inserted":true}\n```', createdAt: timestamp },
      ...panel.transcript,
    ] } } });
    const nextBody = harness.document.root.querySelector(`${outputSelector} [data-output-scroll]`);
    const nextCode = harness.document.root.querySelectorAll(`${outputSelector} pre[data-code-region]`);
    const nextRuling = harness.document.root.querySelector('[data-code-scroll-surface="result:run-1"] pre[data-code-region]');
    assert.notEqual(nextBody, body);
    assert.deepEqual([nextBody.scrollTop, nextBody.scrollLeft], [480, 32]);
    assert.deepEqual(nextCode.map((item) => [item.scrollTop, item.scrollLeft]), [[360, 72], [180, 24]]);
    assert.deepEqual([nextRuling.scrollTop, nextRuling.scrollLeft], [240, 48]);
    assert.equal(harness.document.activeElement, nextBody);
  } finally { harness.restore(); }
});

test("live participant code keeps its inner scroll during incremental output replacement", () => {
  const panel = panelState({ running: true, workflowStatus: "running", agents: { lead: { id: "lead", name: "Lead", adapterType: "codex-app-server", status: "running", output: '```json\n{"stream":"first"}\n```' } } });
  const harness = bootWebview(managerState(), panel);
  try {
    const before = harness.document.root.querySelector('[data-live-agent-output="lead"] pre[data-code-region]');
    assert.ok(before);
    before.scrollTop = 275;
    before.scrollLeft = 55;
    const output = harness.document.root.querySelector('[data-live-agent-output="lead"]');
    Object.defineProperty(output, "innerHTML", {
      configurable: true,
      set(value) {
        const root = harness.document.root;
        root.innerHTML = root.innerHTML.slice(0, output.contentStart) + value + root.innerHTML.slice(output.contentEnd);
      },
    });
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "agent.delta", agentId: "lead", text: "\nMore output" } });
    const after = harness.document.root.querySelector('[data-live-agent-output="lead"] pre[data-code-region]');
    assert.ok(after);
    assert.notEqual(after, before);
    assert.deepEqual([after.scrollTop, after.scrollLeft], [275, 55]);
  } finally { harness.restore(); }
});

test("Pipeline exposes missing participant history and loads it without leaving Execution", () => {
  const panel = panelState({
    workflowStatus: "completed",
    selectedPipelineDefinition: threeStepPipelineDefinition(),
    transcript: [{ id: "last-loaded", kind: "answer", agentId: "lead", stepId: "review", text: "Latest review response", createdAt: timestamp }],
    transcriptHasMore: true,
    transcriptTotal: 401,
    transcriptError: "Earlier participant messages could not be loaded.",
  });
  const harness = bootWebview(managerState({ eventsByConversation: { "run-1": [stepEvent(1, "review", "Review", timestamp)] } }), panel);
  try {
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    const pipeline = harness.document.root.querySelector(".pipeline-summary");
    assert.match(pipeline.textContent, /Earlier participant work is not loaded yet/u);
    assert.match(harness.document.root.innerHTML, /class="error-banner">Earlier participant messages could not be loaded\./u);
    const load = pipeline.querySelector('[data-action="load-older"]');
    assert.ok(load);
    harness.messages.length = 0;
    load.click();
    assert.deepEqual(harness.messages.at(-1), {
      type: "conversation.runtime",
      conversationId: "run-1",
      message: { type: "transcript.loadOlder", beforeId: "last-loaded" },
    });
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: {
      type: "transcript.prepend",
      entries: [{ id: "early-plan", kind: "answer", agentId: "lead", stepId: "plan", text: "Earlier planning response", createdAt: timestamp }],
      total: 2,
      hasMore: false,
    } });
    assert.match(harness.document.root.querySelector(".pipeline-summary").textContent, /Earlier planning response/u);
    assert.equal(harness.document.root.querySelector('.pipeline-summary [data-action="load-older"]'), null);
  } finally { harness.restore(); }
});

test("continuation rejects a delayed result button after a newer result replaces the same run", () => {
  const harness = openResultActions();
  try {
    const olderButton = harness.document.root.querySelector('[data-action="result-continue"]');
    assert.equal(olderButton.dataset.resultVersion, "result-version-1");
    const newer = readableContinuationResult({ readableMarkdown: "# Run result: Completed\n\nA newer assessment.", continuation: { available: true, resultVersion: "result-version-2" } });
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ resultsByConversation: { "run-1": newer } }) });
    harness.messages.length = 0;
    harness.document.root.dispatch("click", { target: olderButton, preventDefault() {}, stopPropagation() {} });
    assert.equal(harness.messages.length, 0);
    assert.match(harness.document.liveStatus.textContent, /result has changed since the action was displayed/u);
    dispatchResultAction(harness, "result-continue", "run-1", "");
    assert.equal(harness.messages.length, 0);
    harness.document.root.querySelector('[data-action="result-continue"]').click();
    assert.equal(harness.messages.length, 0);
    assert.match(harness.document.liveStatus.textContent, /Review and select the findings again/u);
    const finding = harness.document.root.querySelector('[data-action="result-finding-select"]');
    assert.equal(finding.checked, false);
    finding.checked = true;
    harness.document.root.dispatch("change", { target: finding });
    harness.document.root.querySelector('[data-action="result-continue"]').click();
    assert.deepEqual(harness.messages, [{ type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "result-version-2", findingIds: ["hidden-finding-id"] }]);
  } finally { harness.restore(); }
});

test("Execution groups accepted findings with one unresolved section and preserves every visible disposition", () => {
  for (const hasUnresolved of [false, true]) {
    const findings = ["accepted", "accepted", hasUnresolved ? "unresolved" : "rejected"].map((disposition, index) => ({
      ...readableContinuationResult().findings[0],
      id: `finding-${index}`,
      subject: `Finding ${index + 1}`,
      disposition,
      message: `Assessment ${index + 1}`,
    }));
    const harness = openResultActions({}, {}, readableContinuationResult({ findings }));
    try {
      const group = harness.document.root.querySelector(".result-findings");
      assert.ok(group);
      assert.equal(group.getAttribute("aria-label"), "Findings");
      assert.equal(harness.document.root.querySelectorAll(".result-findings-unresolved").length, hasUnresolved ? 1 : 0);
      assert.equal(group.querySelectorAll(".result-finding-list > li").length, 3);
      assert.equal(group.querySelectorAll(".finding-accepted").length, 2);
      assert.equal(group.querySelectorAll(".finding-unresolved").length, hasUnresolved ? 1 : 0);
      assert.equal(group.querySelectorAll(".finding-rejected").length, hasUnresolved ? 0 : 1);
      for (const finding of findings) {
        assert.ok(group.textContent.includes(finding.subject));
        assert.ok(group.textContent.includes(finding.message));
      }
      for (const [index, row] of group.querySelectorAll(".result-finding-list > li").entries()) {
        assert.match(row.querySelector("small").textContent, /src\/view\.ts:42/u);
        assert.equal(row.querySelector("small").textContent, `${{ accepted: "Accepted", unresolved: "Unresolved", rejected: "Rejected" }[findings[index].disposition]} · src/view.ts:42`);
        assert.equal(row.className.includes("result-findings-unresolved"), false);
        assert.match(row.textContent, /Evidence[^]*Challenges/u);
      }
      assert.match(group.textContent, hasUnresolved ? /2 actionable · 1 need human/u : /2 actionable · 0 need human/u);
    } finally { harness.restore(); }
  }
});

for (const evidenceState of ["recorded", "notApplicable", "missing"]) {
  test(`Execution ${evidenceState} evidence keeps status text and only missing evidence marks the group unresolved`, () => {
    const evidence = [{ kind: "verification", label: "Verification", state: evidenceState, detail: "The controller recorded this verification state." }];
    const harness = openResultActions({}, {}, readableContinuationResult({ evidence }));
    try {
      const ledger = harness.document.root.querySelector(".evidence-ledger");
      assert.ok(ledger);
      assert.equal(ledger.className.includes("result-evidence-missing"), evidenceState === "missing");
      assert.equal(harness.document.root.querySelectorAll(".result-evidence-missing").length, evidenceState === "missing" ? 1 : 0);
      assert.equal(ledger.querySelectorAll("ul > li").length, 1);
      assert.equal(ledger.querySelectorAll(".evidence-state").length, 1);
      assert.equal(ledger.querySelector(".evidence-state").textContent.trim(), { recorded: "Recorded", notApplicable: "Not applicable", missing: "Expected but missing" }[evidenceState]);
      assert.match(ledger.textContent, /Verification[^]*The controller recorded this verification state/u);
      assert.ok(ledger.textContent.includes({ recorded: "Recorded", notApplicable: "Not applicable", missing: "Expected but missing" }[evidenceState]));
    } finally { harness.restore(); }
  });
}

test("Execution mixed evidence retains every row and marks only its containing ledger unresolved", () => {
  const evidence = ["recorded", "notApplicable", "missing"].map((state) => ({
    kind: "verification",
    label: `Verification ${state}`,
    state,
    detail: `The controller recorded the ${state} detail.`,
  }));
  const harness = openResultActions({}, {}, readableContinuationResult({ evidence }));
  try {
    const ledger = harness.document.root.querySelector(".evidence-ledger");
    assert.ok(ledger);
    assert.equal(harness.document.root.querySelectorAll(".result-evidence-missing").length, 1);
    assert.equal(ledger.className.includes("result-evidence-missing"), true);
    const rows = ledger.querySelectorAll("ul > li");
    assert.equal(rows.length, 3);
    assert.equal(ledger.querySelectorAll(".evidence-state").length, 3);
    for (const [index, row] of rows.entries()) {
      const entry = evidence[index];
      assert.equal(row.className, `evidence-${entry.state}`);
      assert.equal(row.querySelector(".evidence-state").textContent.trim(), { recorded: "Recorded", notApplicable: "Not applicable", missing: "Expected but missing" }[entry.state]);
      assert.ok(row.textContent.includes(entry.label));
      assert.ok(row.textContent.includes(entry.detail));
    }
  } finally { harness.restore(); }
});

test("Execution response labels and exact Chat targets survive moving between all response kinds", () => {
  const transcript = ["answer", "interrupted", "error"].map((kind) => ({
    id: `same-agent-${kind}`,
    kind,
    agentId: "lead",
    stepId: "plan",
    text: `Recorded ${kind}`,
    createdAt: timestamp,
  }));
  const panel = panelState({ selectedPipelineDefinition: threeStepPipelineDefinition(), transcript });
  const manager = managerState({ eventsByConversation: { "run-1": [stepEvent(1, "plan", "Plan", timestamp)] } });
  const harness = bootWebview(manager, panel);
  try {
    for (const entry of transcript) {
      harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
      const link = harness.document.root.querySelector(`[data-message-id="${entry.id}"]`);
      const response = link.closest(".pipeline-step-message");
      const label = { answer: "Response", interrupted: "Interrupted", error: "Error" }[entry.kind];
      assert.ok(response.className.includes(`pipeline-step-message-${entry.kind}`));
      assert.ok(response.querySelector(".pipeline-step-message-heading").textContent.includes(label));
      assert.equal(response.querySelector('[data-output-scroll]').getAttribute("aria-label"), `Lead: ${label}`);
      link.focus();
      assert.equal(harness.document.activeElement, link);
      link.click();
      assert.equal(harness.document.activeElement.dataset.entry, entry.id);
      assert.ok(harness.document.activeElement.textContent.includes(entry.text));
    }
  } finally { harness.restore(); }
});

test("Execution marks only unresolved final rulings as an unresolved group", () => {
  for (const status of ["accepted", "resolved"]) {
    const finalDecision = {
      status,
      stepId: "plan",
      candidate: { summary: "The visible review conclusion." },
      participants: [],
      objections: [],
      unresolvedRisks: [],
    };
    const harness = openResultActions({}, {}, readableContinuationResult({ finalDecision }));
    try {
      const ruling = harness.document.root.querySelector(".final-ruling-card");
      assert.ok(ruling);
      assert.equal(ruling.className.includes("final-ruling-unresolved"), status === "resolved");
      assert.ok(ruling.textContent.includes(status === "resolved" ? "Finished with unresolved findings" : "Final decision"));
    } finally { harness.restore(); }
  }
});

for (const refusal of [false, true]) {
  test(`Copy result preserves ordinary review prose and local file details when clipboard refusal is ${refusal}`, async () => {
    const { readableResultMarkdown } = require("../dist/results/readableResult.js");
    const { resultHandoffFixture } = require("./fixtures/resultHandoff.cjs");
    const source = resultHandoffFixture();
    source.changedFiles.push("package-lock.json", "dist/output.js");
    source.finalRuling = JSON.stringify({
      summary: "The lead must review the current source before changing the build.",
      agentId: "lead",
      stepId: "review",
      sessionId: "a497c55b-8695-4f70-a2cc-4a0fb736b917",
      digest: "b7".repeat(32),
      provenance: { text: "HIDDEN_METADATA" },
    });
    const readableMarkdown = readableResultMarkdown(source);
    const harness = openResultActions({}, {}, readableContinuationResult({ ...source, readableMarkdown }));
    try {
      harness.clipboard.refuse = refusal;
      harness.document.root.querySelector('[data-action="result-copy"]').focus();
      harness.document.root.querySelector('[data-action="result-copy"]').click();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(harness.clipboard.writes, [readableMarkdown]);
      assert.match(readableMarkdown, /The lead must review the current source before changing the build/u);
      assert.match(readableMarkdown, /package-lock\.json/u);
      assert.match(readableMarkdown, /dist\/output\.js/u);
      assert.doesNotMatch(readableMarkdown, /HIDDEN_METADATA|sessionId|agentId|stepId|a497c55b|b7{32}|internal value omitted/u);
      assert.ok(!readableMarkdown.includes("b7".repeat(32)));
      assert.match(harness.document.liveStatus.textContent, refusal ? /Copying the run result failed/u : /copied to the clipboard/u);
      assert.equal(harness.messages.some((message) => message.type === "conversation.continueFromResult"), false);
    } finally { harness.restore(); }
  });
}

test("a generated bounded implementation draft opens from Execution and survives webview persistence and restoration exactly", () => {
  const { implementationDraftFromResult } = require("../dist/results/implementationHandoff.js");
  const { RESULT_TEXT_LIMITS } = require("../dist/results/textLimits.js");
  const { largeResultHandoffFixture } = require("./fixtures/resultHandoff.cjs");
  const preparedDraft = implementationDraftFromResult(largeResultHandoffFixture());
  assert.ok(preparedDraft.length <= RESULT_TEXT_LIMITS.preparedDraftUnits);
  assert.doesNotMatch(preparedDraft, /[\r\0]/u);
  assert.ok(preparedDraft.includes("Review the current source.\nKeep the evidence readable.\uFFFD"));
  const harness = openResultActions();
  let persisted;
  const draftConversation = { ...managerState().conversations[0], id: "implementation-draft", runRef: "implementation-draft", preparedDraft, workflowStatus: "idle", running: false };
  const manager = managerState({ activeConversationId: draftConversation.id, conversations: [draftConversation] });
  try {
    harness.document.root.querySelector('[data-action="result-continue"]').click();
    harness.sendWindowMessage({ type: "manager.snapshot", state: JSON.parse(JSON.stringify(manager)) });
    harness.sendWindowMessage({ type: "conversation.message", conversationId: draftConversation.id, message: { type: "state.snapshot", state: panelState({ workflowStatus: "idle", running: false }) } });
    const composer = harness.document.getElementById("composer-prompt");
    assert.ok(composer);
    assert.equal(composer.textContent, preparedDraft);
    assert.equal(composer.getAttribute("maxlength"), String(RESULT_TEXT_LIMITS.preparedDraftUnits));
    composer.value = preparedDraft;
    harness.document.root.dispatch("input", { target: composer });
    assert.equal(harness.webviewState.value.drafts[draftConversation.id], preparedDraft);
    harness.sendWindowEvent("beforeunload", {});
    const saved = harness.messages.findLast((message) => message.type === "conversation.saveDraft");
    assert.equal(saved.text, preparedDraft);
    assert.equal(harness.messages.some((message) => message.message?.type === "pipeline.run"), false);
    persisted = JSON.parse(JSON.stringify(harness.webviewState.value));
  } finally { harness.restore(); }
  const reloaded = installGlobals();
  reloaded.webviewState.value = persisted;
  try {
    delete require.cache[require.resolve("../dist/webview-behavior.js")];
    delete require.cache[require.resolve("../dist/webview.js")];
    require("../dist/webview-behavior.js");
    require("../dist/webview.js");
    reloaded.sendWindowMessage({ type: "manager.snapshot", state: JSON.parse(JSON.stringify(manager)) });
    reloaded.sendWindowMessage({ type: "conversation.message", conversationId: draftConversation.id, message: { type: "state.snapshot", state: panelState({ workflowStatus: "idle", running: false }) } });
    assert.equal(reloaded.document.getElementById("composer-prompt").textContent, preparedDraft);
    assert.equal(reloaded.webviewState.value.drafts[draftConversation.id], preparedDraft);
    assert.equal(reloaded.messages.some((message) => message.message?.type === "pipeline.run"), false);
  } finally { reloaded.restore(); }
});

test("webview draft persistence never silently slices an oversized value or splits the final surrogate pair", () => {
  const { RESULT_TEXT_LIMITS } = require("../dist/results/textLimits.js");
  const boundary = `${"x".repeat(RESULT_TEXT_LIMITS.preparedDraftUnits - 2)}😀`;
  const harness = bootWebview();
  try {
    const composer = harness.document.getElementById("composer-prompt");
    composer.value = boundary;
    harness.document.root.dispatch("input", { target: composer });
    assert.equal(harness.webviewState.value.drafts["run-1"], boundary);
    harness.sendWindowEvent("beforeunload", {});
    assert.equal(harness.messages.findLast((message) => message.type === "conversation.saveDraft").text, boundary);
    harness.messages.length = 0;
    const current = harness.document.getElementById("composer-prompt");
    current.value = `${boundary}x`;
    harness.document.root.dispatch("input", { target: current });
    harness.sendWindowEvent("beforeunload", {});
    assert.match(harness.document.liveStatus.textContent, /draft exceeds.*character limit/u);
    assert.equal(harness.webviewState.value.drafts["run-1"], boundary);
    assert.equal(harness.messages.some((message) => message.type === "conversation.saveDraft"), false);
  } finally { harness.restore(); }
});

const selectableReviewResult = (overrides = {}) => readableContinuationResult({
  findings: ["accepted", "unresolved", "proposed", "rejected"].map((disposition, index) => ({
    ...readableContinuationResult().findings[0],
    id: `select-finding-${index}`,
    subject: `Review issue ${index + 1}`,
    message: `Recorded review detail ${index + 1}.`,
    disposition,
  })),
  continuation: {
    available: true,
    resultVersion: "selection-version",
    pipelineId: "fix-source",
    pipelines: [{ id: "fix-source", name: "Fix source" }, { id: "implement-ui", name: "Implement UI" }],
  },
  ...overrides,
});

const setReviewFinding = (harness, id, checked) => {
  const input = harness.document.root.querySelector(`[data-action="result-finding-select"][data-finding-id="${id}"]`);
  assert.ok(input);
  input.checked = checked;
  harness.document.root.dispatch("change", { target: input });
};

test("review report shows converged and unconfirmed findings with participant reports collapsed", () => {
  const result = selectableReviewResult();
  result.finalDecision = {
    stepId: "review", status: "ruled", ruledBy: "lead",
    candidate: { summary: "The lead reconciled the review and kept uncertainty explicit.", findings: result.findings },
    participants: [{ agentId: "lead", valid: true, accepted: true, candidate: { summary: "The participant reasoning is retained." }, objections: [], unresolvedRisks: [] }],
    objections: [], unresolvedRisks: [],
  };
  const harness = openResultActions({}, {}, result);
  try {
    const root = harness.document.root;
    assert.equal(root.querySelectorAll(".result-findings-converged .result-finding-list > li").length, 1);
    assert.equal(root.querySelectorAll(".result-findings-unresolved .result-finding-list > li").length, 2);
    assert.equal(root.querySelectorAll(".result-findings .finding-rejected").length, 1);
    assert.equal(root.querySelectorAll('[data-action="result-finding-select"]').length, 3);
    assert.equal(root.querySelectorAll(".result-findings-unresolved").length, 1);
    assert.equal(root.querySelector(".result-findings-converged").className.includes("result-findings-unresolved"), false);
    const comparison = root.querySelector(".ruling-compare");
    assert.equal(comparison.open, false);
    assert.ok(comparison.textContent.includes("The participant reasoning is retained."));
    assert.ok(root.innerHTML.indexOf("The lead reconciled the review") < root.innerHTML.indexOf('class="result-findings"'));
    assert.equal(root.querySelectorAll(".result-finding-list > li").length, 4);
    assert.equal(root.querySelectorAll(".result-finding").length, 0);
    assert.ok(root.querySelector(".result-finding-selection-summary").textContent.includes("Selection does not confirm unresolved findings"));
    assert.equal(root.querySelector('[data-action="result-continue"]').textContent, "Start new pipeline");
  } finally { harness.restore(); }
});

test("finding exclusions and chosen pipeline survive a snapshot and dispatch only selected work", () => {
  const result = selectableReviewResult();
  const harness = openResultActions({}, {}, result);
  try {
    setReviewFinding(harness, "select-finding-1", false);
    const pipeline = harness.document.root.querySelector('[data-action="result-pipeline-select"]');
    pipeline.value = "implement-ui";
    harness.document.root.dispatch("change", { target: pipeline });
    const focused = harness.document.root.querySelector('[data-finding-id="select-finding-2"]');
    focused.focus();
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ resultsByConversation: { "run-1": structuredClone(result) } }) });
    assert.equal(harness.document.activeElement.dataset.findingId, "select-finding-2");
    assert.equal(harness.document.root.querySelector('[data-finding-id="select-finding-1"]').checked, false);
    assert.equal(harness.document.root.querySelector('[data-finding-id="select-finding-0"]').checked, true);
    assert.equal(harness.document.root.querySelector('[data-finding-id="select-finding-2"]').checked, true);
    assert.equal(harness.document.root.querySelector(".result-selection-count").textContent, "2 of 3 issues selected");
    assert.equal(harness.document.root.querySelector(".result-selection-detail"), null);
    assert.match(harness.document.root.innerHTML, /value="implement-ui" selected/u);
    harness.messages.length = 0;
    harness.document.root.querySelector('[data-action="result-continue"]').click();
    assert.deepEqual(harness.messages, [{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "selection-version",
      findingIds: ["select-finding-0", "select-finding-2"], pipelineId: "implement-ui",
    }]);
    assert.equal(harness.messages.some((message) => ["user.message", "pipeline.run", "workflow.restart", "workflow.resume"].includes(message.message?.type ?? message.type)), false);
  } finally { harness.restore(); }
});

test("excluding every finding refuses a new pipeline until a finding is selected", () => {
  const harness = openResultActions({}, {}, selectableReviewResult());
  try {
    for (const id of ["select-finding-0", "select-finding-1", "select-finding-2"]) setReviewFinding(harness, id, false);
    const action = harness.document.root.querySelector('[data-action="result-continue"]');
    assert.equal(harness.document.root.querySelector(".result-selection-count").textContent, "0 of 3 issues selected");
    assert.equal(harness.document.root.querySelector(".result-selection-detail"), null);
    assert.equal(action.closest(".execution-result-footer").tagName, "FOOTER");
    assert.equal(action.getAttribute("aria-disabled"), "true");
    assert.match(harness.document.root.querySelector(".result-continuation-tooltip").textContent, /Select at least one finding/u);
    harness.messages.length = 0;
    action.click();
    assert.deepEqual(harness.messages, []);
    setReviewFinding(harness, "select-finding-1", true);
    harness.document.root.querySelector('[data-action="result-continue"]').click();
    assert.deepEqual(harness.messages, [{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "selection-version",
      findingIds: ["select-finding-1"], pipelineId: "fix-source",
    }]);
  } finally { harness.restore(); }
});

test("a removed destination pipeline requires another explicit choice", () => {
  const result = selectableReviewResult();
  const harness = openResultActions({}, {}, result);
  try {
    const next = structuredClone(result);
    next.continuation.pipelines = [{ id: "implement-ui", name: "Implement UI" }];
    next.continuation.pipelineId = "implement-ui";
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ resultsByConversation: { "run-1": next } }) });
    const action = harness.document.root.querySelector('[data-action="result-continue"]');
    assert.equal(action.getAttribute("aria-disabled"), "true");
    harness.messages.length = 0;
    action.click();
    assert.deepEqual(harness.messages, []);
    assert.match(harness.document.liveStatus.textContent, /Choose an available write-capable pipeline/u);
    const pipeline = harness.document.root.querySelector('[data-action="result-pipeline-select"]');
    pipeline.value = "implement-ui";
    harness.document.root.dispatch("change", { target: pipeline });
    harness.document.root.querySelector('[data-action="result-continue"]').click();
    assert.equal(harness.messages.length, 1);
    assert.equal(harness.messages[0].pipelineId, "implement-ui");
    assert.deepEqual(harness.messages[0].findingIds, ["select-finding-0", "select-finding-1", "select-finding-2"]);
  } finally { harness.restore(); }
});

test("read-only review windows keep findings readable and disable finding and pipeline controls", () => {
  const readOnly = { owned: false, reason: "Another window owns the workspace", retryCommand: "Bachata: Workspace Ownership" };
  const harness = openResultActions({ readOnly }, {}, selectableReviewResult());
  try {
    const inputs = harness.document.root.querySelectorAll('[data-action="result-finding-select"]');
    assert.equal(inputs.length, 3);
    assert.equal(inputs.every((input) => input.disabled), true);
    assert.equal(harness.document.root.querySelector('[data-action="result-pipeline-select"]').disabled, true);
    assert.equal(harness.document.root.querySelectorAll(".result-finding-list > li").length, 4);
    harness.messages.length = 0;
    dispatchResultAction(harness, "result-continue", "run-1", "selection-version");
    assert.deepEqual(harness.messages, []);
    assert.match(harness.document.liveStatus.textContent, /can only read/u);
  } finally { harness.restore(); }
});

for (const [label, reason, pipelines] of [
  ["capacity", "The open-run limit has been reached. Close a run before starting implementation.", [{ id: "fix-source", name: "Fix source" }]],
  ["missing write pipeline", "No write-capable pipeline is available.", []],
  ["checking pipelines", "Checking available write-capable pipelines.", undefined],
]) {
  test(`current report finding selections remain editable during ${label} refusal`, () => {
    const result = selectableReviewResult({ continuation: {
      available: false, reason, resultVersion: "selection-version", pipelines,
    } });
    const original = JSON.stringify(result);
    const harness = openResultActions({}, {}, result);
    try {
      const inputs = harness.document.root.querySelectorAll('[data-action="result-finding-select"]');
      assert.equal(inputs.length, 3);
      assert.equal(inputs.every((input) => !input.disabled), true);
      const blockedPipeline = harness.document.root.querySelector('[data-action="result-pipeline-select"]');
      if (pipelines === undefined) assert.equal(blockedPipeline, null);
      else {
        assert.equal(blockedPipeline.disabled, pipelines.length === 0);
        if (pipelines.length === 0) assert.equal(blockedPipeline.getAttribute("title"), reason);
      }
      setReviewFinding(harness, "select-finding-1", false);
      assert.equal(harness.document.root.querySelector('[data-finding-id="select-finding-1"]').checked, false);
      assert.equal(harness.document.root.querySelector('[data-finding-id="select-finding-0"]').checked, true);
      assert.equal(harness.document.root.querySelector('[data-finding-id="select-finding-2"]').checked, true);
      assert.equal(harness.document.root.querySelector(".result-continuation-tooltip").textContent, `Opens an editable draft. Execution starts only after you submit it. ${reason}`);
      harness.messages.length = 0;
      harness.document.root.querySelector('[data-action="result-continue"]').click();
      assert.equal(harness.document.liveStatus.textContent, reason);
      assert.deepEqual(harness.messages, []);
      harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ resultsByConversation: { "run-1": structuredClone(result) } }) });
      assert.equal(harness.document.root.querySelector('[data-finding-id="select-finding-1"]').checked, false);
      const available = structuredClone(result);
      available.continuation = { available: true, resultVersion: "selection-version", pipelineId: "fix-source", pipelines: [{ id: "fix-source", name: "Fix source" }] };
      harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ resultsByConversation: { "run-1": available } }) });
      const pipeline = harness.document.root.querySelector('[data-action="result-pipeline-select"]');
      assert.equal(pipeline.disabled, false);
      pipeline.value = "fix-source";
      harness.document.root.dispatch("change", { target: pipeline });
      assert.deepEqual(harness.messages, []);
      harness.document.root.querySelector('[data-action="result-continue"]').click();
      assert.deepEqual(harness.messages, [{
        type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "selection-version",
        findingIds: ["select-finding-0", "select-finding-2"], pipelineId: "fix-source",
      }]);
      assert.equal(JSON.stringify(result), original);
    } finally { harness.restore(); }
  });
}

for (const [label, managerOverrides, panelOverrides, continuation, reason] of [
  ["archived", { conversations: [{ ...conversationSummary(), archived: true }] }, {}, undefined, /Unarchive this run/u],
  ["running", { conversations: [{ ...conversationSummary(), running: true, workflowStatus: "running" }] }, {}, undefined, /Finish or stop this run/u],
  ["restarting", {}, { operationActive: true }, undefined, /active run operation/u],
  ["queued", {}, { queuedMessages: [{ id: "queued", kind: "pipeline", prompt: "New attempt", mode: "implementation", recipients: [], attachmentIds: [], createdAt: timestamp }] }, undefined, /queued messages/u],
  ["unverified earlier attempt", {}, {}, { available: false, reason: "The recorded result belongs to an earlier attempt." }, /earlier attempt/u],
]) {
  test(`${label} report refuses local finding changes without altering selected findings`, () => {
    const result = selectableReviewResult(continuation ? { continuation } : {});
    const original = JSON.stringify(result);
    const harness = openResultActions(managerOverrides, panelOverrides, result);
    try {
      const inputs = harness.document.root.querySelectorAll('[data-action="result-finding-select"]');
      assert.equal(inputs.length, 3);
      assert.equal(inputs.every((input) => input.disabled && input.checked), true);
      harness.messages.length = 0;
      setReviewFinding(harness, "select-finding-1", false);
      assert.match(harness.document.liveStatus.textContent, reason);
      assert.equal(harness.document.root.querySelector('[data-finding-id="select-finding-1"]').checked, true);
      assert.deepEqual(harness.messages, []);
      assert.equal(JSON.stringify(result), original);
    } finally { harness.restore(); }
  });
}

test("a delayed finding change cannot select a replacement report while pipeline availability is blocked", () => {
  const result = selectableReviewResult();
  const harness = openResultActions({}, {}, result);
  try {
    const previous = harness.document.root.querySelector('[data-finding-id="select-finding-1"]');
    const next = structuredClone(result);
    next.continuation = { available: false, reason: "Checking available write-capable pipelines.", resultVersion: "new-selection-version" };
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ resultsByConversation: { "run-1": next } }) });
    const inputs = harness.document.root.querySelectorAll('[data-action="result-finding-select"]');
    assert.equal(inputs.length, 3);
    assert.equal(inputs.every((input) => !input.disabled && !input.checked), true);
    previous.checked = true;
    harness.messages.length = 0;
    harness.document.root.dispatch("change", { target: previous });
    assert.match(harness.document.liveStatus.textContent, /result has changed since the action was displayed/u);
    assert.equal(harness.document.root.querySelectorAll('[data-action="result-finding-select"]').every((input) => !input.checked), true);
    assert.deepEqual(harness.messages, []);
  } finally { harness.restore(); }
});

test("a current terminal review remains selectable after its runtime restores idle", () => {
  const result = selectableReviewResult({ finalAssessment: { outcome: "inconclusive", method: "none", summary: "Review completed without an agreed ruling.", producedBy: [] } });
  const harness = openResultActions({ conversations: [{ ...conversationSummary(), workflowStatus: "idle", running: false }] }, { workflowStatus: "idle", running: false }, result);
  try {
    const inputs = harness.document.root.querySelectorAll('[data-action="result-finding-select"]');
    assert.equal(inputs.length, 3);
    assert.equal(inputs.every((input) => !input.disabled), true);
    setReviewFinding(harness, "select-finding-1", false);
    assert.equal(harness.document.root.querySelector('[data-action="result-continue"]').getAttribute("aria-disabled"), null);
    harness.messages.length = 0;
    harness.document.root.querySelector('[data-action="result-continue"]').click();
    assert.deepEqual(harness.messages, [{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "selection-version",
      findingIds: ["select-finding-0", "select-finding-2"], pipelineId: "fix-source",
    }]);
  } finally { harness.restore(); }
});


test("Execution keeps the continuation footer outside the main scroll and hides the report until requested", () => {
  const harness = openResultActions({}, {}, selectableReviewResult(), false);
  try {
    const root = harness.document.root;
    const column = root.querySelector(".conversation-column");
    const viewport = column.querySelector(":scope > .conversation-viewport");
    const footer = column.querySelector(":scope > .execution-result-footer");
    const scroll = root.querySelector("#conversation-scroll");
    assert.ok(viewport);
    assert.ok(footer);
    assert.equal(footer.tagName, "FOOTER");
    assert.equal(footer.parentElement, viewport.parentElement);
    assert.equal(scroll.closest(".conversation-viewport"), viewport);
    assert.equal(footer.closest("#conversation-scroll"), null);
    assert.equal(root.querySelectorAll(".execution-result-footer").length, 1);
    assert.equal(root.querySelectorAll('[data-action="result-continue"]').length, 1);
    assert.equal(footer.querySelectorAll('[data-action="result-continue"]').length, 1);
    assert.equal(scroll.querySelectorAll('[data-action="result-continue"]').length, 0);
    assert.equal(scroll.querySelectorAll('[data-action="result-copy"]').length, 0);
    assert.equal(footer.querySelectorAll('[data-action="result-copy"]').length, 0);
    assert.equal(root.querySelectorAll(".result-center").length, 0);
    assert.equal(footer.querySelectorAll('[data-action="result-pipeline-select"]').length, 1);
    const help = footer.querySelector(".result-continuation-tooltip");
    assert.equal(help.getAttribute("role"), "tooltip");
    assert.equal(help.textContent, "Opens an editable draft. Execution starts only after you submit it.");
    assert.equal(footer.querySelector('.result-continuation-help [data-action="noop"]').getAttribute("aria-describedby"), help.id);
    const viewportIndex = root.innerHTML.indexOf('class="conversation-viewport');
    const footerIndex = root.innerHTML.indexOf('class="execution-result-footer"');
    assert.ok(viewportIndex >= 0);
    assert.ok(footerIndex > viewportIndex);
  } finally { harness.restore(); }
});

test("Review details inserts the scrollable report between the selection summary and next pipeline", () => {
  const result = selectableReviewResult({ unresolvedRisks: ["Confirm the remaining review risk before implementation."] });
  const harness = openResultActions({}, {}, result, false);
  try {
    const root = harness.document.root;
    const toggle = root.querySelector('[data-action="result-details-toggle"]');
    assert.equal(toggle.textContent, "Review details");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggle.getAttribute("aria-controls"), null);
    assert.ok(root.querySelector(".conversation-viewport"));
    assert.equal(root.querySelector(".result-details-panel"), null);
    assert.equal(root.querySelector(".result-center"), null);

    toggle.click();
    const footer = root.querySelector(".execution-result-footer");
    const panel = root.querySelector(".result-details-panel");
    assert.match(footer.getAttribute("class"), /result-details-open/u);
    assert.ok(panel);
    assert.equal(panel.getAttribute("role"), "region");
    assert.equal(panel.getAttribute("aria-label"), "Review report");
    assert.equal(root.querySelector(".conversation-viewport").getAttribute("inert"), "");
    assert.equal(root.querySelector(".conversation-viewport").getAttribute("aria-hidden"), "true");
    assert.equal(root.querySelectorAll(".result-center").length, 1);
    assert.equal(panel.querySelectorAll(".result-center").length, 1);
    assert.equal(root.querySelector('[data-action="result-copy"]').closest(".result-details-panel"), panel);
    assert.match(panel.textContent, /Confirm the remaining review risk before implementation\./u);
    assert.equal(root.querySelector('[data-action="result-details-toggle"]').textContent, "Hide details");
    assert.equal(root.querySelector('[data-action="result-details-toggle"]').getAttribute("aria-expanded"), "true");
    assert.equal(root.querySelector('[data-action="result-details-toggle"]').getAttribute("aria-controls"), "result-details-run-1");
    assert.equal(harness.document.activeElement.dataset.action, "result-details-toggle");
    const actionHtml = root.innerHTML;
    assert.ok(actionHtml.indexOf("result-continuation-overview") < actionHtml.indexOf("result-details-panel"));
    assert.ok(actionHtml.indexOf("result-details-panel") < actionHtml.indexOf("result-continuation-controls"));

    const detailsScroll = root.querySelector(".result-details-scroll");
    assert.match(detailsScroll.getAttribute("class"), /execution-content/u);
    detailsScroll.scrollTop = 275;
    detailsScroll.scrollLeft = 18;
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ resultsByConversation: { "run-1": structuredClone(result) } }) });
    assert.equal(root.querySelector(".result-details-panel") !== null, true);
    assert.deepEqual([root.querySelector(".result-details-scroll").scrollTop, root.querySelector(".result-details-scroll").scrollLeft], [275, 18]);

    root.querySelector('[data-action="result-details-toggle"]').click();
    assert.equal(root.querySelector(".result-details-panel"), null);
    assert.ok(root.querySelector(".conversation-viewport"));
    assert.equal(root.querySelector(".conversation-viewport").getAttribute("inert"), null);
    assert.equal(root.querySelector(".conversation-viewport").getAttribute("aria-hidden"), null);
    assert.equal(harness.document.activeElement.dataset.action, "result-details-toggle");
    assert.equal(harness.document.activeElement.textContent, "Review details");

    harness.document.activeElement.click();
    root.dispatch("keydown", { key: "Escape", target: root.querySelector('[data-action="result-details-toggle"]'), preventDefault: () => undefined });
    assert.equal(root.querySelector(".result-details-panel"), null);
    assert.ok(root.querySelector(".conversation-viewport"));
    assert.equal(harness.document.activeElement.dataset.action, "result-details-toggle");
  } finally { harness.restore(); }
});

test("the continuation footer counts exactly the selected canonical issues without a redundant disposition subtitle", () => {
  const result = selectableReviewResult();
  const original = JSON.stringify(result);
  const harness = openResultActions({}, {}, result);
  try {
    const root = harness.document.root;
    const count = () => root.querySelector(".result-selection-count").textContent;
    assert.equal(count(), "3 of 3 issues selected");
    assert.equal(root.querySelector(".result-selection-detail"), null);
    assert.equal(root.querySelectorAll(".execution-result-footer .result-continuation-summary").length, 1);
    const summary = root.querySelector(".result-continuation-summary");
    assert.equal(summary.getAttribute("role"), "status");
    assert.equal(summary.getAttribute("aria-atomic"), "true");
    assert.equal(root.querySelector(".result-selection-count").tagName, "STRONG");
    setReviewFinding(harness, "select-finding-1", false);
    assert.equal(count(), "2 of 3 issues selected");
    assert.equal(root.querySelector(".result-continuation-summary").getAttribute("aria-live"), null);
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ resultsByConversation: { "run-1": structuredClone(result) } }) });
    assert.equal(root.querySelector(".result-continuation-summary").getAttribute("aria-live"), "off");
    setReviewFinding(harness, "select-finding-2", false);
    assert.equal(count(), "1 of 3 issues selected");
    assert.equal(root.querySelector('[data-finding-id="select-finding-3"]'), null);
    harness.messages.length = 0;
    root.querySelector('.execution-result-footer [data-action="result-continue"]').click();
    assert.deepEqual(harness.messages, [{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "selection-version",
      findingIds: ["select-finding-0"], pipelineId: "fix-source",
    }]);
    assert.equal(JSON.stringify(result), original);
  } finally { harness.restore(); }
});

test("one eligible issue uses singular footer grammar and excludes rejected findings from the total", () => {
  const result = selectableReviewResult();
  result.findings = [result.findings[0], result.findings[3]];
  const harness = openResultActions({}, {}, result);
  try {
    assert.equal(harness.document.root.querySelector(".result-selection-count").textContent, "1 of 1 issue selected");
    assert.equal(harness.document.root.querySelector(".result-selection-detail"), null);
    assert.equal(harness.document.root.querySelectorAll('[data-action="result-finding-select"]').length, 1);
  } finally { harness.restore(); }
});

test("a report without findings offers its assessment in an editable draft without inventing selected issues", () => {
  const harness = openResultActions({}, {}, selectableReviewResult({ findings: [] }));
  try {
    const footer = harness.document.root.querySelector(".execution-result-footer");
    assert.equal(footer.querySelector(".result-selection-count").textContent, "0 issues selected");
    assert.match(footer.textContent, /Assessment details/u);
    assert.equal(harness.document.root.querySelectorAll('[data-action="result-finding-select"]').length, 0);
    const action = footer.querySelector('[data-action="result-continue"]');
    assert.equal(action.getAttribute("aria-disabled"), null);
    harness.messages.length = 0;
    action.click();
    assert.deepEqual(harness.messages, [{
      type: "conversation.continueFromResult", conversationId: "run-1", resultVersion: "selection-version",
      pipelineId: "fix-source",
    }]);
  } finally { harness.restore(); }
});

for (const [label, panelOverrides, result] of [
  ["empty result", { workflowStatus: "completed" }, undefined],
  ["running attempt", { workflowStatus: "running", running: true }, selectableReviewResult()],
  ["waiting attempt", { workflowStatus: "paused", pendingGate: pendingGate({ stepId: "review", stepName: "Review" }) }, selectableReviewResult()],
]) {
  test(`${label} never adds a continuation footer to Execution`, () => {
    const harness = bootWebview(managerState({ resultsByConversation: result ? { "run-1": result } : {} }), panelState(panelOverrides));
    try {
      const execution = harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]');
      if (result === undefined) assert.equal(execution, null);
      else {
        assert.ok(execution);
        execution.click();
      }
      assert.equal(harness.document.root.querySelectorAll(".execution-result-footer").length, 0);
      assert.equal(harness.document.root.querySelectorAll('[data-action="result-continue"]').length, 0);
    } finally { harness.restore(); }
  });
}

test("the continuation footer disappears in Chat and Direction and restores the same selection in Execution", () => {
  const harness = openResultActions({}, {}, selectableReviewResult());
  try {
    setReviewFinding(harness, "select-finding-1", false);
    harness.document.root.querySelector('[data-action="room-view"][data-view="chat"]').click();
    assert.equal(harness.document.root.querySelectorAll(".execution-result-footer").length, 0);
    harness.document.root.querySelector('[data-action="room-view"][data-view="execution"]').click();
    assert.equal(harness.document.root.querySelector(".result-selection-count").textContent, "2 of 3 issues selected");
    openWorkspaceDirection(harness);
    assert.ok(harness.document.root.querySelector(".direction-center"));
    assert.equal(harness.document.root.querySelectorAll(".execution-result-footer").length, 0);
  } finally { harness.restore(); }
});

test("footer pipeline focus and selected issue count survive snapshots without resetting nested code scroll", () => {
  const result = selectableReviewResult();
  const panel = {
    workflowStatus: "completed", selectedPipelineDefinition: threeStepPipelineDefinition(),
    transcript: [{ id: "footer-scroll-answer", kind: "answer", agentId: "lead", stepId: "plan", text: '```json\n{"evidence":[1,2,3]}\n```', createdAt: timestamp }],
  };
  const eventsByConversation = { "run-1": [stepEvent(1, "plan", "Plan", timestamp)] };
  const harness = openResultActions({ eventsByConversation }, panel, result);
  try {
    const root = harness.document.root;
    const disclosure = root.querySelector('[data-disclosure-key="run-1:pipeline-step:plan"]');
    disclosure.open = true;
    root.dispatch("toggle", { target: disclosure });
    setReviewFinding(harness, "select-finding-1", false);
    const surface = '[data-code-scroll-surface="pipeline:plan:footer-scroll-answer"]';
    const body = root.querySelector(`${surface} [data-output-scroll]`);
    const code = root.querySelector(`${surface} pre[data-code-region]`);
    body.scrollTop = 240;
    body.scrollLeft = 35;
    code.scrollTop = 180;
    code.scrollLeft = 90;
    const pipeline = root.querySelector('.execution-result-footer [data-action="result-pipeline-select"]');
    pipeline.value = "implement-ui";
    root.dispatch("change", { target: pipeline });
    root.querySelector('.execution-result-footer [data-action="result-pipeline-select"]').focus();
    const footer = root.querySelector(".execution-result-footer");
    footer.scrollTop = 85;
    footer.scrollLeft = 12;
    harness.sendWindowMessage({ type: "manager.snapshot", state: managerState({ eventsByConversation, resultsByConversation: { "run-1": structuredClone(result) } }) });
    assert.equal(harness.document.activeElement.dataset.action, "result-pipeline-select");
    assert.equal(harness.document.activeElement.closest(".execution-result-footer").tagName, "FOOTER");
    assert.deepEqual([root.querySelector(".execution-result-footer").scrollTop, root.querySelector(".execution-result-footer").scrollLeft], [0, 0]);
    assert.match(root.innerHTML, /value="implement-ui" selected/u);
    assert.equal(root.querySelector(".result-selection-count").textContent, "2 of 3 issues selected");
    assert.equal(root.querySelector(".result-selection-detail"), null);
    assert.equal(root.querySelector('[data-disclosure-key="run-1:pipeline-step:plan"]').open, true);
    assert.deepEqual([root.querySelector(`${surface} [data-output-scroll]`).scrollTop, root.querySelector(`${surface} [data-output-scroll]`).scrollLeft], [240, 35]);
    assert.deepEqual([root.querySelector(`${surface} pre[data-code-region]`).scrollTop, root.querySelector(`${surface} pre[data-code-region]`).scrollLeft], [180, 90]);
  } finally { harness.restore(); }
});

const assertIconControl = (control) => {
  assert.ok(control);
  assert.ok(control.className.split(/\s+/u).includes("icon-button"), control.dataset.action ?? control.id);
  assert.ok(control.getAttribute("aria-label"), control.dataset.action ?? control.id);
  assert.doesNotMatch(control.className, /(?:^|\s)(?:selected|open|focused|focus)(?:\s|$)/u);
};

test("navigation uses semantic current and pressed states after view changes, focus changes, and snapshots", () => {
  const manager = managerState({ eventsByConversation: { "run-1": [{ id: 1, type: "run.started", status: "running", title: "Started", createdAt: timestamp }] } });
  const panel = panelState();
  const harness = bootWebview(manager, panel);
  try {
    const root = harness.document.root;
    for (const view of ["execution", "chat"]) {
      root.querySelector(`.run-tab-tools [data-view="${view}"]`).click();
      root.querySelector(".run-tab.selected .run-tab-select").focus();
      harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
      harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panel } });
      for (const candidate of ["chat", "execution"]) {
        const control = root.querySelector(`.run-tab-tools [data-view="${candidate}"]`);
        assertIconControl(control);
        assert.equal(control.getAttribute("aria-pressed"), String(candidate === view));
      }
      assert.equal(root.querySelector(".run-tab.selected .run-tab-select").getAttribute("aria-current"), "page");
    }
    assert.equal(root.querySelector(".run-tabs-brand").tagName, "SPAN");
    for (const selector of [".run-tab-new", "#notification-button", "#room-actions-button", '[data-action="attachment-pick"]', '[data-action="composer-settings-toggle"]', '[data-action="submit-message"]', "#agents-picker-button"]) {
      assertIconControl(root.querySelector(selector));
    }
  } finally { harness.restore(); }
});

test("the notification icon retains its native open state and badge after a rerender without focus classes", () => {
  const manager = notificationManager();
  const harness = bootWebview(manager);
  try {
    openMenu(harness, ".notification-center");
    harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
    const root = harness.document.root;
    const trigger = harness.document.getElementById("notification-button");
    assertIconControl(trigger);
    assert.equal(trigger.getAttribute("title"), "Notifications");
    assert.equal(root.querySelector(".notification-center").open, true);
    assert.equal(root.querySelector(".notification-unread").textContent, "1");
    assert.equal(root.querySelector(".notification-unread").getAttribute("aria-hidden"), "true");
    harness.document.root.dispatch("keydown", { key: "Escape", target: trigger, preventDefault: () => undefined });
    assert.equal(root.querySelector(".notification-center").open, false);
    assert.equal(harness.document.activeElement, trigger);
  } finally { harness.restore(); }
});

test("combobox active descendant and selected option stay independent and survive snapshots", () => {
  const panel = panelState();
  const harness = bootWebview(managerState(), panel);
  try {
    harness.document.getElementById("pipeline-picker-button").click();
    const root = harness.document.root;
    const picker = () => harness.document.getElementById("pipeline-picker-button");
    const search = () => harness.document.getElementById("pipeline-picker-search");
    harness.document.root.dispatch("keydown", { key: "ArrowDown", target: search(), preventDefault: () => undefined });
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panel } });
    const selected = root.querySelector('[data-pipeline-id="custom-a"]');
    const active = root.querySelector('[data-pipeline-id="custom-b"]');
    assert.equal(selected.getAttribute("aria-selected"), "true");
    assert.equal(selected.getAttribute("data-active"), "false");
    assert.equal(active.getAttribute("aria-selected"), "false");
    assert.equal(active.getAttribute("data-active"), "true");
    assert.equal(picker().getAttribute("aria-activedescendant"), active.id);
    assert.equal(search().getAttribute("aria-activedescendant"), active.id);
    assert.equal(picker().getAttribute("aria-expanded"), "true");
    assert.equal(selected.className, "pipeline-picker-option");
    assert.equal(active.className, "pipeline-picker-option");
    assert.equal(harness.document.activeElement, search());
  } finally { harness.restore(); }
});

test("composer settings and editor mode use semantic states without selected or open styling classes", () => {
  const harness = bootWebview();
  try {
    const root = harness.document.root;
    openComposerSettings(harness);
    const settings = root.querySelector('[data-action="composer-settings-toggle"]');
    assert.equal(settings.getAttribute("aria-expanded"), "true");
    assertIconControl(settings);
    root.querySelector('[data-action="pipeline-edit"]').click();
    assertIconControl(root.querySelector('.pipeline-editor [data-action="pipeline-editor-close"]'));
    const assertMode = (mode) => {
      for (const candidate of ["form", "json"]) {
        const button = root.querySelector(`[data-action="editor-mode"][data-mode="${candidate}"]`);
        assert.equal(button.getAttribute("aria-pressed"), String(candidate === mode));
        assert.doesNotMatch(button.className, /selected|focus/u);
      }
    };
    assertMode("form");
    root.querySelector('[data-action="editor-mode"][data-mode="json"]').click();
    assertMode("json");
    root.querySelector('[data-action="editor-mode"][data-mode="form"]').click();
    const request = lastValidateRequest(harness);
    assert.ok(request);
    assertMode("json");
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
    assertMode("form");
    for (const control of root.querySelectorAll('[data-action="editor-agent-up"], [data-action="editor-agent-down"], [data-action="editor-step-up"], [data-action="editor-step-down"]')) {
      assertIconControl(control);
    }
  } finally { harness.restore(); }
});

test("model listbox selection uses only aria-selected across a host rerender", () => {
  const panel = localInterpreterPanel({ status: "ready", detail: "Ready", explicit: true, model: "model-one", availableModels: [{ id: "model-one", backend: "ollama", availability: "loaded" }, { id: "model-two", backend: "ollama", availability: "installed" }] });
  const harness = bootWebview(managerState(), panel);
  try {
    harness.document.getElementById("agents-picker-button").click();
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panel } });
    const root = harness.document.root;
    for (const model of ["model-one", "model-two"]) {
      const option = root.querySelector(`[data-action="local-model-select"][data-model="${model}"]`);
      assert.equal(option.getAttribute("role"), "option");
      assert.equal(option.getAttribute("aria-selected"), String(model === "model-one"));
      assert.equal(option.className, "agents-session-option");
    }
    assert.equal(harness.document.getElementById("agents-picker-button").getAttribute("aria-expanded"), "true");
    assert.doesNotMatch(harness.document.getElementById("agents-picker-button").className, /has-overrides|selected|open/u);
  } finally { harness.restore(); }
});

test("native disabled controls refuse activation while aria-disabled Send retains its explanation action", () => {
  const harness = bootWebview(managerState(), panelState({ pipelineMutable: false, workspaceRoots: ["/workspace", "/other"], workingDirectory: undefined }));
  try {
    const root = harness.document.root;
    const picker = harness.document.getElementById("pipeline-picker-button");
    assert.equal(picker.disabled, true);
    const before = harness.messages.length;
    picker.click();
    assert.equal(harness.document.getElementById("pipeline-picker-list"), null);
    assert.equal(harness.messages.length, before);
    const send = root.querySelector('[data-action="submit-message"]');
    assert.equal(send.disabled, false);
    assert.equal(send.getAttribute("aria-disabled"), "true");
    send.focus();
    assert.equal(harness.document.activeElement, send);
    send.click();
    assert.ok(root.querySelector(".app-dialog"));
    assert.equal(harness.messages.length, before);
    assertIconControl(root.querySelector('.app-dialog [data-action="dialog-cancel"]'));
  } finally { harness.restore(); }
});

test("busy Stop retains the icon contract and cannot dispatch twice", () => {
  const harness = bootWebview(managerState(), panelState({ running: true, operationActive: true, workflowStatus: "running" }));
  try {
    const root = harness.document.root;
    const stop = () => root.querySelector('.composer-send [data-action="interrupt-run"]');
    assertIconControl(stop());
    stop().click();
    const afterFirst = harness.messages.length;
    assertIconControl(stop());
    assert.equal(stop().disabled, true);
    assert.equal(stop().getAttribute("aria-busy"), "true");
    stop().click();
    assert.equal(harness.messages.length, afterFirst);
  } finally { harness.restore(); }
});


test("focus presentation follows pointer and keyboard input without changing action or selection state", () => {
  const manager = managerState({ eventsByConversation: { "run-1": [{ id: 1, type: "run.started", status: "running", title: "Started", createdAt: timestamp }] } });
  const harness = bootWebview(manager);
  try {
    const root = harness.document.root;
    const prompt = harness.document.getElementById("composer-prompt");
    const before = harness.messages.length;
    root.dispatch("pointerdown", { target: prompt });
    assert.equal(root.dataset.focusInput, "pointer");
    prompt.focus();
    assert.equal(harness.document.activeElement, prompt);
    root.dispatch("keydown", { target: prompt, key: "Shift", preventDefault: () => undefined });
    assert.equal(root.dataset.focusInput, "keyboard");
    assert.equal(harness.messages.length, before);
    harness.sendWindowMessage({ type: "manager.snapshot", state: manager });
    assert.equal(root.dataset.focusInput, "keyboard");
    assert.equal(root.querySelector('.run-tab-tools [data-view="chat"]').getAttribute("aria-pressed"), "true");
    root.dispatch("pointerdown", { target: root.querySelector(".run-tabs-brand") });
    assert.equal(root.dataset.focusInput, "pointer");
    assert.equal(root.querySelector('.run-tab-tools [data-view="chat"]').getAttribute("aria-pressed"), "true");
  } finally { harness.restore(); }
});
