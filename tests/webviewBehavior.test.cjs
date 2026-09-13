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

test("the workflow status decides the phase, and a stale running flag cannot hide how a run ended", () => {
  const { behavior, restore } = loadBehavior();
  try {
    for (const [running, status, phase] of [
      [true, "error", "failed"],
      [true, "interrupted", "stopped"],
      [true, "completed", "completed"],
      [true, "paused", "waiting"],
      [true, "running", "running"],
      [true, "idle", "running"],
      [false, "running", "running"],
      [false, "paused", "waiting"],
      [false, "interrupted", "stopped"],
      [false, "error", "failed"],
      [false, "completed", "completed"],
      [false, "idle", "idle"],
      [false, "unknown", "idle"],
    ]) {
      assert.equal(behavior.runPhase(running, status), phase, `${String(running)} / ${status}`);
    }
  } finally {
    restore();
  }
});

test("recovery is offered only for an ended run whose checkpoint ended the same way", () => {
  const { behavior, restore } = loadBehavior();
  try {
    const resume = { step: "resume", label: "Resume stopped step" };
    const retry = { step: "retry", label: "Retry failed step" };
    const cases = [
      ["running", { outcome: "failed", failureScope: "step" }, undefined],
      ["running", { outcome: "stoppedByUser" }, undefined],
      ["waiting", { outcome: "failed", failureScope: "step" }, undefined],
      ["completed", { outcome: "failed", failureScope: "step" }, undefined],
      ["idle", { outcome: "stoppedByUser" }, undefined],
      ["stopped", undefined, undefined],
      ["stopped", { outcome: "stoppedByUser" }, resume],
      ["stopped", { outcome: "interrupted" }, resume],
      ["stopped", { outcome: "failed", failureScope: "step" }, undefined],
      ["failed", { outcome: "failed", failureScope: "step" }, retry],
      ["failed", { outcome: "failed", failureScope: "run" }, { step: "none" }],
      ["failed", { outcome: "failed" }, { step: "none" }],
      ["failed", { outcome: "stoppedByUser" }, undefined],
      ["failed", undefined, undefined],
    ];
    for (const [phase, checkpoint, expected] of cases) {
      assert.deepEqual(behavior.runRecovery(phase, checkpoint), expected, `${phase} ${JSON.stringify(checkpoint)}`);
    }
  } finally {
    restore();
  }
});

test("each phase has one label and icon, and only work in progress spins", () => {
  const { behavior, restore } = loadBehavior();
  try {
    assert.deepEqual(behavior.runStatusPresentation("running"), { label: "Working", icon: "loading", spinning: true });
    assert.deepEqual(behavior.runStatusPresentation("waiting"), { label: "Waiting for you", icon: "clock", spinning: false });
    assert.deepEqual(behavior.runStatusPresentation("failed", "failed"), { label: "Failed", icon: "error", spinning: false });
    assert.deepEqual(behavior.runStatusPresentation("completed"), { label: "Completed", icon: "pass", spinning: false });
    assert.deepEqual(behavior.runStatusPresentation("idle"), { label: "Ready", icon: "circle-outline", spinning: false });
    assert.deepEqual(behavior.runStatusPresentation("stopped"), { label: "Interrupted", icon: "debug-pause", spinning: false }, "a stop with no provenance was attributed to the user");
    assert.deepEqual(behavior.runStatusPresentation("stopped", "stoppedByUser"), { label: "Stopped by you", icon: "debug-stop", spinning: false });
    assert.deepEqual(behavior.runStatusPresentation("stopped", "interrupted"), { label: "Interrupted", icon: "debug-pause", spinning: false });
  } finally {
    restore();
  }
});

test("a detail with nothing in it is not a detail", () => {
  const { behavior, restore } = loadBehavior();
  try {
    for (const empty of [null, undefined, "", "   ", [], {}]) {
      assert.equal(behavior.hasDetail(empty), false, JSON.stringify(empty));
    }
    for (const present of ["x", [null], { code: "protocolError" }, 0, false]) {
      assert.equal(behavior.hasDetail(present), true, JSON.stringify(present));
    }
  } finally {
    restore();
  }
});

test("prompts with the same text stay separate entries, numbered only within one participant and step", () => {
  const { behavior, restore } = loadBehavior();
  try {
    assert.deepEqual(
      behavior.promptTurns([
        { id: "p1", agentId: "codex", step: "Review", eventType: "agent.prompt" },
        { id: "p2", agentId: "claude", step: "Review", eventType: "agent.prompt" },
        { id: "s1", step: "Review", eventType: "step.started" },
        { id: "p3", agentId: "codex", step: "Review", eventType: "agent.prompt" },
        { id: "p4", eventType: "agent.prompt" },
      ]),
      {
        p1: { turn: 1, of: 2 },
        p3: { turn: 2, of: 2 },
        p2: { turn: 1, of: 1 },
        p4: { turn: 1, of: 1 },
      },
    );
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
