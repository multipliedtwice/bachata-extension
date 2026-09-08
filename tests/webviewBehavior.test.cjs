const assert = require("node:assert/strict");
const test = require("node:test");

const loadBehavior = () => {
  const previousCss = globalThis.CSS;
  const previousBehavior = globalThis.bachataWebviewBehavior;
  globalThis.CSS = { escape: (value) => String(value).replaceAll('"', '\\"') };
  delete require.cache[require.resolve("../dist/webview-behavior.js")];
  require("../dist/webview-behavior.js");
  const behavior = globalThis.bachataWebviewBehavior;
  return {
    behavior,
    restore: () => {
      if (previousCss === undefined) delete globalThis.CSS;
      else globalThis.CSS = previousCss;
      if (previousBehavior === undefined) delete globalThis.bachataWebviewBehavior;
      else globalThis.bachataWebviewBehavior = previousBehavior;
    },
  };
};

test("webview dialog focus policy defaults destructive actions to cancel", () => {
  const { behavior, restore } = loadBehavior();
  try {
    assert.equal(behavior.dialogInitialFocus(true, true), "input");
    assert.equal(behavior.dialogInitialFocus(false, true), "cancel");
    assert.equal(behavior.dialogInitialFocus(false, false), "confirm");
  } finally {
    restore();
  }
});

test("webview focus selectors retain the actionable identity", () => {
  const { behavior, restore } = loadBehavior();
  try {
    assert.equal(behavior.focusReturnSelector(null), undefined);
    assert.equal(behavior.focusReturnSelector({ id: "composer-prompt", dataset: {} }), "#composer-prompt");
    assert.equal(
      behavior.focusReturnSelector({
        id: "",
        dataset: { action: "run-delete", conversation: "run-7", agent: undefined, mode: undefined },
      }),
      '[data-action="run-delete"][data-conversation="run-7"]',
    );
    assert.equal(behavior.focusReturnSelector({ id: "", dataset: {} }), undefined);
  } finally {
    restore();
  }
});

test("webview keyboard behavior wraps modal focus and submits only explicit composer shortcuts", () => {
  const { behavior, restore } = loadBehavior();
  try {
    assert.equal(behavior.wrappedFocusIndex(0, 3, true), 2);
    assert.equal(behavior.wrappedFocusIndex(2, 3, false), 0);
    assert.equal(behavior.wrappedFocusIndex(1, 3, false), undefined);
    assert.equal(behavior.wrappedFocusIndex(0, 0, false), undefined);
    assert.equal(behavior.shouldSubmitComposer("composer-prompt", "Enter", true, false), true);
    assert.equal(behavior.shouldSubmitComposer("composer-prompt", "Enter", false, true), true);
    assert.equal(behavior.shouldSubmitComposer("composer-prompt", "Enter", false, false), false);
    assert.equal(behavior.shouldSubmitComposer("other", "Enter", true, false), false);
  } finally {
    restore();
  }
});

test("webview focus selectors keep the index and view that tell repeated controls apart", () => {
  const { behavior, restore } = loadBehavior();
  try {
    assert.equal(
      behavior.focusReturnSelector({ id: "", dataset: { action: "editor-agent-down", index: "2" } }),
      '[data-action="editor-agent-down"][data-index="2"]',
    );
    assert.equal(
      behavior.focusReturnSelector({ id: "", dataset: { action: "room-view", view: "execution" } }),
      '[data-action="room-view"][data-view="execution"]',
    );
  } finally {
    restore();
  }
});
