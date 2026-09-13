const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");

const filename = path.join(__dirname, "webviewDom.test.cjs");
const fixture = new Module(filename, module);
fixture.filename = filename;
fixture.paths = Module._nodeModulePaths(__dirname);
fixture.require = (id) => id === "node:test" ? () => undefined : Module.prototype.require.call(fixture, id);
fixture._compile(`${fs.readFileSync(filename, "utf8")}\nmodule.exports = { bootWebview, managerState, panelState, conversationSummary };`, filename);
const { bootWebview, managerState, panelState, conversationSummary } = fixture.exports;

const pausedPanel = (overrides = {}) => panelState({
  workflowStatus: "paused",
  operationActive: true,
  pendingGate: {
    stepId: "review",
    stepName: "Review",
    reason: "maxConsensusRounds",
    round: 4,
    decisionRound: 4,
    allowedActions: ["retry", "acceptUnresolved", "cancel"],
    rollbackTargets: [],
  },
  ...overrides,
});
const updatePanel = (harness, conversationId, panel) => harness.sendWindowMessage({
  type: "conversation.message",
  conversationId,
  message: { type: "state.snapshot", state: panel },
});
const actionControl = (harness, action, conversationId = "run-1") =>
  harness.document.root.querySelector(`[data-action="${action}"][data-conversation="${conversationId}"]`);

test("saved human decisions disable run mutations and guard stale enabled controls", () => {
  const manager = managerState({ conversations: [{ ...conversationSummary(), workflowStatus: "paused" }] });
  const harness = bootWebview(manager, pausedPanel());
  try {
    for (const action of ["run-duplicate", "run-archive", "run-delete"]) {
      const control = actionControl(harness, action);
      assert.equal(control.getAttribute("aria-disabled"), "true");
      assert.match(control.getAttribute("title"), /Resolve or leave the decision/u);
      const before = harness.messages.length;
      control.click();
      assert.equal(harness.messages.length, before);
      assert.equal(harness.document.root.querySelector(".app-dialog"), null);
      control.removeAttribute("aria-disabled");
      control.click();
      assert.equal(harness.messages.length, before);
      assert.equal(harness.document.root.querySelector(".app-dialog"), null);
    }
    updatePanel(harness, "run-1", panelState({ workflowStatus: "completed", operationActive: false }));
    for (const action of ["run-duplicate", "run-archive", "run-delete"]) {
      assert.equal(actionControl(harness, action).getAttribute("aria-disabled"), null);
    }
    actionControl(harness, "run-duplicate").click();
    assert.deepEqual(harness.messages.at(-1), { type: "conversation.duplicate", conversationId: "run-1" });
  } finally { harness.restore(); }
});

test("paused descendants protect the run tree while idle root duplication remains available", () => {
  const summary = conversationSummary();
  const child = { ...summary, id: "child-run", parentConversationId: summary.id, title: "Review changes", workflowStatus: "paused" };
  const harness = bootWebview(managerState({ conversations: [summary, child] }));
  try {
    updatePanel(harness, "child-run", pausedPanel());
    for (const action of ["run-archive", "run-delete"]) {
      const control = actionControl(harness, action);
      assert.equal(control.getAttribute("aria-disabled"), "true");
      assert.match(control.getAttribute("title"), /Review changes/u);
    }
    assert.equal(actionControl(harness, "run-duplicate").getAttribute("aria-disabled"), null);
    updatePanel(harness, "child-run", panelState({ workflowStatus: "interrupted", operationActive: false }));
    for (const action of ["run-archive", "run-delete"]) {
      assert.equal(actionControl(harness, action).getAttribute("aria-disabled"), null);
    }
  } finally { harness.restore(); }
});

test("operation ownership locks mutation while participants are idle and before a gate snapshot", () => {
  const harness = bootWebview(managerState(), pausedPanel({ pendingGate: undefined }));
  try {
    for (const action of ["run-duplicate", "run-archive", "run-delete"]) {
      assert.equal(actionControl(harness, action).getAttribute("aria-disabled"), "true");
    }
    updatePanel(harness, "run-1", pausedPanel({ operationActive: false }));
    for (const action of ["run-duplicate", "run-archive", "run-delete"]) {
      assert.equal(actionControl(harness, action).getAttribute("aria-disabled"), "true");
    }
  } finally { harness.restore(); }
});
