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
fixture._compile(`${fs.readFileSync(filename, "utf8")}\nmodule.exports = { bootWebview, managerState, panelState, recoverableWorkflow, conversationSummary };`, filename);
const { bootWebview, managerState, panelState, recoverableWorkflow, conversationSummary } = fixture.exports;

const stoppedPanel = () => panelState({
  workflowStatus: "interrupted",
  pipelineMutable: false,
  pipelineMutationReason: "Reset this run before changing pipelines",
  resumableWorkflow: recoverableWorkflow({ outcome: "stoppedByUser" }),
});

test("stopped pipeline requirements belong to run status and offer resume", () => {
  const harness = bootWebview(managerState(), stoppedPanel());
  try {
    const composer = harness.document.root.querySelector(".composer");
    assert.equal(composer.querySelector(".composer-blockers, .composer-note"), null);
    const composerHtml = harness.document.root.innerHTML.split('<footer class="composer">')[1].split('</footer>')[0];
    assert.doesNotMatch(composerHtml, /Send is disabled|composer-note|composer-blockers/u);
    const trigger = harness.document.root.querySelector('[data-action="run-requirements"]');
    assert.ok(trigger);
    assert.match(trigger.getAttribute("aria-label"), /Stopped by you/u);
    trigger.click();
    const dialog = harness.document.root.querySelector(".app-dialog");
    assert.match(harness.document.root.innerHTML, /Resume from the saved step/u);
    assert.equal(dialog.querySelector("details"), null);
    const before = harness.messages.length;
    dialog.querySelector('[data-action="workflow-resume"]').click();
    assert.equal(harness.document.root.querySelector(".app-dialog"), null);
    assert.equal(harness.messages.length, before + 1);
    assert.equal(harness.messages.at(-1).message.type, "workflow.resume");
  } finally { harness.restore(); }
});

test("empty input refusal keeps focus in the composer without a dialog", () => {
  const harness = bootWebview();
  try {
    const before = harness.messages.length;
    harness.document.root.querySelector('[data-action="submit-message"]').click();
    assert.equal(harness.document.root.querySelector(".app-dialog"), null);
    assert.equal(harness.document.activeElement.id, "composer-prompt");
    assert.match(harness.document.liveStatus.textContent, /Describe what this run must do/u);
    assert.equal(harness.messages.length, before);
  } finally { harness.restore(); }
});

test("requirements dialog refreshes after setup is resolved", () => {
  const harness = bootWebview(managerState(), panelState({ workspaceRoots: [] }));
  try {
    const input = harness.document.getElementById("composer-prompt");
    input.value = "Review the change";
    harness.document.root.dispatch("input", { target: input });
    harness.document.root.querySelector('[data-action="run-requirements"]').click();
    assert.ok(harness.document.root.querySelector('.app-dialog [data-action="working-directory"]'));
    harness.sendWindowMessage({ type: "conversation.message", conversationId: "run-1", message: { type: "state.snapshot", state: panelState() } });
    const dialog = harness.document.root.querySelector(".app-dialog");
    assert.match(harness.document.root.innerHTML, /class="run-requirements-ready" role="status">Ready to send/u);
    assert.equal(dialog.querySelector('[data-action="working-directory"]'), null);
    assert.equal(harness.document.root.querySelector('[data-action="run-requirements"]'), null);
  } finally { harness.restore(); }
});

test("closing requirements returns keyboard focus to run status", () => {
  const harness = bootWebview(managerState(), stoppedPanel());
  try {
    const trigger = harness.document.root.querySelector('[data-action="run-requirements"]');
    trigger.focus();
    trigger.click();
    harness.document.root.querySelector('.app-dialog [data-action="dialog-cancel"]').click();
    assert.equal(harness.document.activeElement.dataset.action, "run-requirements");
  } finally { harness.restore(); }
});

test("editing a blocked prompt retains its current accessible reason", () => {
  const harness = bootWebview(managerState(), panelState({ workspaceRoots: [] }));
  try {
    const input = harness.document.getElementById("composer-prompt");
    input.value = "Review the change";
    harness.document.root.dispatch("input", { target: input });
    const send = harness.document.root.querySelector('[data-action="submit-message"]');
    assert.equal(send.getAttribute("aria-disabled"), "true");
    assert.equal(send.getAttribute("aria-describedby"), null);
    assert.match(send.getAttribute("aria-description"), /No workspace folder/u);
    assert.match(send.getAttribute("title"), /Send unavailable.*No workspace folder/u);
    send.click();
    assert.ok(harness.document.root.querySelector('.app-dialog [data-action="working-directory"]'));
  } finally { harness.restore(); }
});

test("requirements cannot resume a different run after active selection changes", () => {
  const first = conversationSummary();
  const second = { ...first, id: "run-2", title: "Another run" };
  const manager = managerState({ conversations: [first, second] });
  const harness = bootWebview(manager, stoppedPanel());
  try {
    harness.document.root.querySelector('[data-action="run-requirements"]').click();
    const before = harness.messages.length;
    harness.sendWindowMessage({ type: "manager.snapshot", state: { ...manager, activeConversationId: "run-2" } });
    harness.document.root.querySelector('.app-dialog [data-action="workflow-resume"]')?.click();
    assert.equal(harness.messages.slice(before).some((message) => message.type === "conversation.runtime" && message.message.type === "workflow.resume"), false);
  } finally { harness.restore(); }
});
