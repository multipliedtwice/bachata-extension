const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/webview-ui/conversationNavigation.ts"), "utf8");
const script = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

const navigationHarness = () => {
  const document = { activeElement: null };
  class Element {
    constructor() {
      this.dataset = {};
      this.attributes = new Map();
      this.clientWidth = 600;
      this.clientHeight = 400;
      this.scrollHeight = 1000;
      this.position = 0;
      this.tabIndex = -1;
      this.offsetTop = 0;
      this.offsetHeight = 26;
      this.parent = null;
      this.rows = [];
      this.buttons = [];
    }
    get scrollTop() { return this.position; }
    set scrollTop(value) { this.position = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    closest(selector) { return selector === ".chat-minimap" ? this.parent : null; }
    matches(selector) { return selector === ".conversation-scroll" && this === content; }
    focus() { document.activeElement = this; }
    getBoundingClientRect() { return this.rect ?? { top: 0, height: this.clientHeight, bottom: this.clientHeight }; }
    querySelectorAll(selector) { return selector === "button" ? this.buttons : this.rows; }
  }
  const content = new Element();
  content.dataset.scrollKey = "run-1:chat";
  const latest = new Element();
  const rail = new Element();
  const listeners = new Map();
  const root = {
    content,
    querySelector: (selector) => selector === ".conversation-scroll" ? root.content : selector === ".jump-latest" ? latest : selector === ".chat-minimap" ? rail : null,
    querySelectorAll: () => rail.buttons,
    addEventListener: (type, listener) => listeners.set(type, listener),
  };
  const state = { roomView: "chat", scrollPositions: new Map() };
  let resize;
  let observed;
  let disconnected = 0;
  class Observer {
    constructor(callback) { resize = callback; }
    observe(value) { observed = value; }
    disconnect() { observed = undefined; disconnected += 1; }
  }
  const window = { matchMedia: () => ({ matches: false }) };
  const api = vm.runInNewContext(`${script}\n;({ rememberConversationScroll, refreshConversationNavigation, conversationScrollBehavior });`, {
    root, state, document, window, ResizeObserver: Observer, HTMLElement: Element, HTMLButtonElement: Element,
  });
  const addTurn = (id, top, bottom) => {
    const row = new Element();
    row.dataset.entry = id;
    row.rect = { top, bottom, height: bottom - top };
    content.rows.push(row);
    const button = new Element();
    button.dataset.messageId = id;
    button.parent = rail;
    button.offsetTop = rail.buttons.length * 28;
    rail.buttons.push(button);
    return button;
  };
  return { ...api, content, latest, rail, root, state, document, window, addTurn, resize: () => resize(), observed: () => observed, disconnected: () => disconnected, dispatch: (type, event) => listeners.get(type)?.(event) };
};

test("following survives viewport height and width changes", () => {
  const nav = navigationHarness();
  nav.content.scrollTop = 600;
  nav.refreshConversationNavigation();
  nav.rememberConversationScroll(nav.content);
  assert.equal(nav.observed(), nav.content);
  nav.content.clientHeight = 200;
  nav.resize();
  assert.equal(nav.content.scrollTop, 800);
  assert.equal(nav.latest.hidden, true);
  nav.content.clientWidth = 300;
  nav.content.scrollHeight = 1400;
  nav.resize();
  assert.equal(nav.content.scrollTop, 1200);
  assert.equal(nav.state.scrollPositions.get("run-1:chat").following, true);
});

test("reading older messages survives resize without being pulled to the bottom", () => {
  const nav = navigationHarness();
  nav.content.scrollTop = 120;
  nav.refreshConversationNavigation();
  nav.rememberConversationScroll(nav.content);
  nav.content.clientHeight = 200;
  nav.resize();
  assert.equal(nav.content.scrollTop, 120);
  assert.equal(nav.latest.hidden, false);
  nav.content.scrollTop = 200;
  nav.dispatch("scroll", { target: nav.content });
  assert.equal(nav.content.scrollTop, 200);
  assert.equal(nav.state.scrollPositions.get("run-1:chat").following, false);
});

test("the minimap keeps focused navigation after a render and marks the visible turn", () => {
  const nav = navigationHarness();
  const first = nav.addTurn("first", -500, -100);
  const second = nav.addTurn("second", -50, 700);
  const third = nav.addTurn("third", 730, 900);
  nav.document.activeElement = second;
  third.tabIndex = 0;
  nav.refreshConversationNavigation();
  assert.deepEqual([first.tabIndex, second.tabIndex, third.tabIndex], [-1, 0, -1]);
  assert.equal(second.attributes.get("aria-current"), "true");
  assert.equal(first.attributes.has("aria-current"), false);
  let prevented = false;
  nav.dispatch("keydown", { target: second, key: "End", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(nav.document.activeElement, third);
  assert.deepEqual([first.tabIndex, second.tabIndex, third.tabIndex], [-1, -1, 0]);
});

test("leaving the conversation releases its resize observer", () => {
  const nav = navigationHarness();
  nav.refreshConversationNavigation();
  const before = nav.disconnected();
  nav.root.content = null;
  nav.refreshConversationNavigation();
  assert.equal(nav.observed(), undefined);
  assert.equal(nav.disconnected(), before + 1);
});

test("message jumps honor the reduced motion preference", () => {
  const nav = navigationHarness();
  assert.equal(nav.conversationScrollBehavior(), "smooth");
  nav.window.matchMedia = () => ({ matches: true });
  assert.equal(nav.conversationScrollBehavior(), "auto");
});
