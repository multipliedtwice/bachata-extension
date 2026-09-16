import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const themeColors = JSON.parse(readFileSync(new URL("../../tests/fixtures/webview-layout/theme-colors.json", import.meta.url), "utf8"));
const menu = ".header-action-menu > summary";
const bell = ".notification-center > summary";
const frame = (session) => session.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
const runtime = (type) => ({ type: "conversation.runtime", conversationId: "run-1", message: { type } });
const actions = ["inspector-toggle", "availability-check", "working-directory", "orchestration-start", "transcript-export", "task-reset"];

const participantStep = "Inspect the interface independently";
const reviewPrompt = "Review the supplied interface for usability, accessibility, navigation, reading hierarchy, spacing, responsiveness, focus and action feedback.\n\nreview extension/";

const expectAll = (measured, label) => {
  for (const [property, value] of Object.entries(measured)) assert.equal(value, true, `${label}: ${property}`);
};

const bootState = async (session, mutation) => {
  await session.evaluate(`{
    const panel = window.__executionPanelState;
    const manager = window.__executionManagerState;
    const conversation = manager.conversations[0];
    panel.agents = {
      codex: { id: "codex", name: "Usability reviewer", adapterType: "codex-app-server", status: "idle", output: "" },
      claude: { id: "claude", name: "Accessibility reviewer", adapterType: "claude-code", status: "idle", output: "" },
    };
    (${mutation})(panel, manager, conversation);
    window.__bootExecution();
  }`);
  await frame(session);
};

const recoveryRowMeasure = `(() => {
  const scroll = document.querySelector(".conversation-scroll");
  const card = document.querySelector(".run-outcome");
  if (!card) return { present: false };
  scroll.dataset.restoring = "";
  const controls = [...card.querySelectorAll("button")].filter(control => control.getBoundingClientRect().height > 0);
  const hits = controls.every((control) => {
    control.scrollIntoView({ block: "nearest" });
    const r = control.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return hit === control || control.contains(hit);
  });
  const rects = controls.map((control) => control.getBoundingClientRect());
  const box = card.getBoundingClientRect();
  const overlapping = rects.some((a, i) => rects.some((b, j) => j > i
    && Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5));
  const focusable = controls.every((control) => { control.focus(); return document.activeElement === control; });
  delete scroll.dataset.restoring;
  return {
    present: true,
    actions: controls.map((control) => control.dataset.action).join("|"),
    hits,
    sized: rects.every((r) => r.width > 0 && r.height >= 24),
    inside: rects.every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5),
    separate: !overlapping,
    gutter: innerWidth > 850 || (box.left >= 15.5 && box.right <= innerWidth - 15.5),
    focusable,
    noPageScroll: document.documentElement.scrollWidth <= innerWidth + 1 && scroll.scrollWidth <= scroll.clientWidth + 1,
    textSize: [...card.querySelectorAll("strong, p, button")].every((el) => parseFloat(getComputedStyle(el).fontSize) >= 13),
  };
})()`;

/*
 * The run state matrix, measured in the shipped bundle at the caller's width and theme: a working
 * run draws no result or recovery and says Working beside a progress indicator; a run that failed in
 * a step offers Restart, Retry and Discard in one row that wraps without clipping; its run
 * participant prompt stays out of the feed and opens from the participant name with the keyboard;
 * and a refusal made before any participant started offers the folder, not a retry.
 */
const runStateMatrixChecks = async (session, key, label) => {
  await bootState(session, `(panel, manager, conversation) => {
    panel.running = true;
    panel.workflowStatus = "running";
    panel.resumableWorkflow = { ...panel.resumableWorkflow, outcome: "failed", failureScope: "step" };
    conversation.running = true;
    conversation.workflowStatus = "running";
  }`);
  expectAll(await session.evaluate(`(() => {
    const status = document.querySelector(".room-status");
    return {
      noOutcome: document.querySelector(".run-outcome") === null,
      noResultCopy: !/Open the result|ended as|stopped at step|Run result/.test(document.querySelector(".conversation-scroll").innerText),
      working: status !== null && status.textContent.trim() === "Working"
        && status.querySelector('.codicon-loading.codicon-modifier-spin[aria-hidden="true"]') !== null,
      noRefreshIcon: document.querySelector(".codicon-sync") === null,
      noRecovery: document.querySelector('[data-action="workflow-restart"], [data-action="workflow-resume"], [data-action="workflow-discard"]') === null,
      stop: document.querySelector('.composer-send [data-action="interrupt-run"]') !== null,
    };
  })()`), `${label} running`);

  const failure = "The provider refused this request.";
  await bootState(session, `(panel, manager, conversation) => {
    panel.running = false;
    panel.workflowStatus = "error";
    panel.resumableWorkflow = { ...panel.resumableWorkflow, outcome: "failed", failureScope: "step", nextStepIndex: 0, stepName: ${JSON.stringify(participantStep)} };
    panel.transcript = [
      { id: "user-review", kind: "prompt", eventType: "user.message", text: "review extension/", createdAt: "2026-09-12T20:31:47.000Z" },
      { id: "prompt-codex", kind: "prompt", agentId: "codex", step: ${JSON.stringify(participantStep)}, eventType: "agent.prompt", text: ${JSON.stringify(reviewPrompt)}, createdAt: "2026-09-12T20:31:47.100Z" },
      { id: "prompt-claude", kind: "prompt", agentId: "claude", step: ${JSON.stringify(participantStep)}, eventType: "agent.prompt", text: ${JSON.stringify(reviewPrompt)}, createdAt: "2026-09-12T20:31:47.200Z" },
      { id: "error-codex", kind: "error", agentId: "codex", step: ${JSON.stringify(participantStep)}, text: ${JSON.stringify(failure)}, createdAt: "2026-09-12T20:37:17.000Z" },
    ];
    panel.transcriptTotal = 4;
    conversation.running = false;
    conversation.workflowStatus = "error";
    manager.resultsByConversation["run-1"] = {
      ...manager.resultsByConversation["run-1"],
      unresolvedRisks: [${JSON.stringify(failure)}],
      finalAssessment: {
        outcome: "failedBeforeRuling",
        method: "none",
        summary: "Failed before final ruling: " + ${JSON.stringify(failure)},
        producedBy: [],
        failure: { error: ${JSON.stringify(failure)}, agentId: "codex", participant: "Usability reviewer", step: ${JSON.stringify(participantStep)} },
      },
    };
  }`);
  expectAll(await session.evaluate(`(() => {
    const scroll = document.querySelector(".conversation-scroll");
    const button = document.querySelector('[data-action="message-details"][data-message-id="error-codex"]');
    const box = button.getBoundingClientRect();
    return {
      noLegacyInformation: !document.querySelector(".run-information, .info-entry"),
      promptHidden: !scroll.innerText.includes(${JSON.stringify(reviewPrompt)}),
      target: box.height >= 24,
      textSize: parseFloat(getComputedStyle(button).fontSize) >= 13,
      gutter: innerWidth > 850 || (box.left >= 15.5 && box.right <= innerWidth - 15.5),
      noNull: !/\\bnull\\b/.test(scroll.innerText),
    };
  })()`), `${label} participant prompt hidden`);
  await session.evaluate(`document.querySelector('[data-action="message-details"][data-message-id="error-codex"]').focus()`);
  await key(session, "Enter", "Enter", 13);
  await frame(session);
  expectAll(await session.evaluate(`(() => {
    const dialog = document.querySelector('.app-dialog[role="dialog"]');
    const paragraphs = [...document.querySelectorAll(".turn-details .markdown > p")];
    return {
      open: Boolean(dialog),
      title: document.querySelector("#app-dialog-title")?.textContent === "Usability reviewer · prompt",
      prompt: paragraphs.map((paragraph) => paragraph.textContent).join("\\n\\n") === ${JSON.stringify(reviewPrompt)},
      defaultFocus: document.activeElement?.dataset.dialogDefault === "cancel",
      noPageScroll: document.documentElement.scrollWidth <= innerWidth + 1,
      textSize: [...dialog.querySelectorAll("p")].every((el) => parseFloat(getComputedStyle(el).fontSize) >= 13),
    };
  })()`), `${label} participant prompt open`);
  await session.evaluate(`document.querySelector('[data-dialog-default="cancel"]').click()`);
  await frame(session);
  assert.equal(await session.evaluate(`document.activeElement?.dataset.messageId`), "error-codex", `${label}: participant prompt did not restore focus`);
  const failedRow = await session.evaluate(recoveryRowMeasure);
  assert.equal(failedRow.present, true, `${label}: failed run has no outcome row`);
  assert.equal(
    failedRow.actions,
    "recovery-change-model|workflow-resume|room-view",
    `${label}: failed run actions`,
  );
  expectAll(Object.fromEntries(Object.entries(failedRow).filter(([name]) => name !== "actions")), `${label} failed recovery row`);
  assert.equal(await session.evaluate(`document.querySelector('.run-outcome [data-action="workflow-resume"]').textContent.trim()`), "Retry failed step", `${label}: failure maps to Retry`);

  const refusal = "Choose a Git project folder. /Users/reviewer/workspace is not inside a Git worktree, and Builder in “Implement” may change files, so Bachata needs Git to validate those changes. No participant was started.";
  await bootState(session, `(panel, manager, conversation) => {
    panel.running = false;
    panel.workflowStatus = "error";
    panel.resumableWorkflow = { ...panel.resumableWorkflow, outcome: "failed", failureScope: "run", nextStepIndex: 0 };
    panel.transcript = [
      { id: "user-fix", kind: "prompt", eventType: "user.message", text: "Fix the retry guard", createdAt: "2026-09-12T20:31:47.000Z" },
      { id: "preflight", kind: "error", eventType: "workflow.preflightFailed", text: ${JSON.stringify(refusal)}, createdAt: "2026-09-12T20:31:47.500Z",
        data: { reason: "notGitWorktree", folder: "/Users/reviewer/workspace", detail: "fatal: not a git repository (or any of the parent directories): .git", participants: [{ participant: "Builder", step: "Implement" }] } },
    ];
    panel.transcriptTotal = 2;
    conversation.running = false;
    conversation.workflowStatus = "error";
    delete manager.resultsByConversation["run-1"];
  }`);
  expectAll(await session.evaluate(`(() => {
    const notice = document.querySelector(".run-preflight-failure");
    const box = notice.getBoundingClientRect();
    const folder = notice.querySelector('[data-action="working-directory"]');
    const details = notice.querySelector(".preflight-details");
    return {
      once: document.querySelector(".conversation-scroll").innerText.split("is not inside a Git worktree").length === 2,
      noParticipantCards: document.querySelector(".agent-row") === null,
      folderAction: folder !== null && folder.getBoundingClientRect().height >= 24,
      detailsClosed: details !== null && details.open === false,
      gutter: innerWidth > 850 || (box.left >= 15.5 && box.right <= innerWidth - 15.5),
      noRetry: document.querySelector('[data-action="workflow-resume"]') === null,
      textSize: [...notice.querySelectorAll("p, summary, time, dt, dd")].every((el) => parseFloat(getComputedStyle(el).fontSize) >= 13),
    };
  })()`), `${label} preflight`);
  const refusedRow = await session.evaluate(recoveryRowMeasure);
  assert.equal(refusedRow.actions, "recovery-change-model|workflow-restart", `${label}: refused run actions`);
  expectAll(Object.fromEntries(Object.entries(refusedRow).filter(([name]) => name !== "actions")), `${label} refused recovery row`);
};

export const runWebviewProductChecks = async (session, press, key, widths) => {
  let passed = 0;
  const baseline = await session.evaluate("({ manager: window.__managerState, panel: window.__panelState, executionManager: window.__executionManagerState, executionPanel: window.__executionPanelState })");
  const reset = async (panel = {}, archived = false, waiting = false) => {
    await session.evaluate("window.__oldProductDocument = true");
    await session.send("Page.reload");
    let loaded = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        loaded = await session.evaluate("!window.__oldProductDocument && document.readyState === 'complete' && typeof window.__boot === 'function'");
      } catch { loaded = false; }
      if (loaded) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(loaded, true, "fixture did not reload");
    await session.evaluate(`(() => {
      const baseline = ${JSON.stringify(baseline)};
      window.__managerState = baseline.manager;
      window.__panelState = Object.assign(baseline.panel, ${JSON.stringify(panel)});
      window.__managerState.conversations[0].archived = ${archived};
      window.__managerState.conversations[0].waitingForResources = ${waiting};
      window.__boot();
    })()`);
    await frame(session);
    await session.evaluate("document.querySelector('[data-action=\"room-view\"][data-view=\"chat\"]')?.click()");
    await key(session, "Escape", "Escape", 27);
    await session.evaluate(`window.__posted = []; window.__activatedActions = []; window.__focusEvents = []; document.addEventListener("click", event => { const action = event.target.closest?.("[data-action]")?.dataset.action; if (action) window.__activatedActions.push(action); }, true); document.addEventListener("focusin", event => window.__focusEvents.push(event.target.id), true)`);
  };
  const activate = async (selector, mode, backgroundRender = false) => {
    let present = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      present = await session.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`);
      if (present) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(present, true, `activation target rendered: ${selector}`);
    if (mode === "keyboard") {
      assert.equal(await session.evaluate(`{ const target = document.querySelector(${JSON.stringify(selector)}); target.focus(); document.activeElement === target; }`), true, `keyboard target is focusable: ${selector}`);
      await key(session, "Enter", "Enter", 13);
    } else if (backgroundRender) {
      const point = await session.evaluate(`(() => {
        const target = document.querySelector(${JSON.stringify(selector)});
        target.scrollIntoView({ block: "nearest" });
        const box = target.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        if (hit !== target && !target.contains(hit)) throw new Error("Menu action is covered");
        window.__activationTarget = target;
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`);
      await session.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
      await session.evaluate("window.__boot()");
      await frame(session);
      assert.equal(await session.evaluate("window.__activationTarget.isConnected"), true, "background render removed the pressed target");
      await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
    } else await press(session, selector);
    await frame(session);
  };
  const dispatched = () => session.evaluate("window.__posted");
  const isOpen = (selector) => session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.open === true`);
  await session.send("Emulation.setDeviceMetricsOverride", { width: 792, height: 1000, deviceScaleFactor: 1, mobile: false });
  for (const mode of ["pointer", "keyboard"]) {
    for (const surface of [".run-tab.selected", ".run-drawer-item.selected"]) {
      for (const action of ["rename", "duplicate", "archive", "delete"]) {
        await reset();
        if (surface.includes("drawer")) await activate('[data-action="run-drawer-toggle"]', mode);
        const trigger = `${surface} .run-action-menu > summary`;
        await activate(trigger, mode);
        const before = await session.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(surface + " .run-action-menu-items")}).getBoundingClientRect(); return {x:r.x,y:r.y}; })()`);
        await session.evaluate("window.__boot()");
        await frame(session);
        const after = await session.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(surface + " .run-action-menu-items")}).getBoundingClientRect(); return {x:r.x,y:r.y}; })()`);
        assert.ok(Math.abs(before.x - after.x) <= 1 && Math.abs(before.y - after.y) <= 1, `${surface}: menu moved after snapshot`);
        await session.evaluate("window.__posted = []");
        await activate(`${surface} [data-action="run-${action}"]`, mode, mode === "pointer");
        if (action !== "duplicate") {
          assert.equal(await session.evaluate("document.querySelector('.app-dialog') !== null"), true, `${action}: dialog opened`);
          assert.deepEqual(await dispatched(), []);
          if (action === "rename") await session.evaluate("document.querySelector('#app-dialog-input').value = 'Renamed run'");
          await activate('[data-action="dialog-confirm"]', mode);
        }
        const expected = action === "rename"
          ? { type: "conversation.rename", conversationId: "run-1", title: "Renamed run" }
          : action === "archive"
            ? { type: "conversation.archive", conversationId: "run-1", archived: true }
            : { type: action === "delete" ? "conversation.close" : "conversation.duplicate", conversationId: "run-1" };
        assert.deepEqual(await dispatched(), [expected], `${surface} ${mode} ${action}: one command for the selected run`);
        passed++;
      }
    }
  }
  for (const mode of ["pointer", "keyboard"]) {
    for (const action of actions) {
      await reset();
      await activate(menu, mode);
      assert.equal(await isOpen(".header-action-menu"), true, `${mode}: menu opened`);
      await session.evaluate("window.__posted = []; window.__activatedActions = []");
      await activate(`.header-action-menu [data-action="${action}"]`, mode, mode === "pointer");
      assert.equal(await isOpen(".header-action-menu"), false, `${mode} ${action}: menu dismissal`);
      const sent = await dispatched();
      assert.deepEqual(await session.evaluate("window.__activatedActions"), [action], `${mode}: one activation`);
      if (["availability-check", "working-directory", "orchestration-start", "transcript-export"].includes(action)) {
        const expected = action === "orchestration-start" ? { type: "orchestration.start" }
          : runtime({ "availability-check": "availability.check", "working-directory": "workingDirectory.pick", "transcript-export": "transcript.export" }[action]);
        assert.deepEqual(sent, [expected]);
      } else assert.deepEqual(sent, []);
      if (action === "inspector-toggle") {
        assert.equal(await session.evaluate("document.activeElement.id"), "inspector-title", `${mode}: inspector must own focus after opening ${JSON.stringify(await session.evaluate("({present:!!document.querySelector('.inspector'),focus:window.__focusEvents})"))}`);
        await activate(menu, mode); await activate('.header-action-menu [data-action="inspector-toggle"]', mode);
        assert.equal(await session.evaluate("document.querySelector('.inspector') === null"), true);
        assert.equal(await session.evaluate("document.activeElement.id"), "room-actions-button");
      }
      if (action === "availability-check") {
        assert.equal(await session.evaluate("document.querySelector('.agents-popover') !== null"), true);
        await frame(session);
        assert.equal(await session.evaluate("document.querySelector('.agents-popover') !== null"), true);
      }
      if (action === "task-reset") {
        assert.equal(await session.evaluate("document.activeElement.dataset.dialogDefault"), "cancel");
        assert.equal(await session.evaluate("document.querySelector('[data-action=\"dialog-confirm\"]').classList.contains('danger')"), true);
        await activate('[data-action="dialog-confirm"]', mode);
        assert.deepEqual(await dispatched(), [runtime("task.reset")]);
      }
      if (["working-directory", "orchestration-start", "transcript-export"].includes(action)) assert.equal(await session.evaluate("document.activeElement.id"), "room-actions-button");
      passed++;
    }
    for (const action of ["run-unarchive", "transcript-export", "inspector-toggle"]) {
      await reset({}, true); await activate(menu, mode);
      assert.equal(await session.evaluate(`[
        "pipeline-new", "pipeline-fork", "availability-check", "working-directory", "orchestration-start", "task-reset"
      ].every(action => document.querySelector('.header-action-menu [data-action="' + action + '"]') === null)`), true);
      await session.evaluate("window.__posted = []");
      await activate(`.header-action-menu [data-action="${action}"]`, mode);
      assert.deepEqual(await dispatched(), action === "inspector-toggle" ? [] : [action === "run-unarchive" ? { type: "conversation.archive", conversationId: "run-1", archived: false } : runtime("transcript.export")]);
      assert.equal(await isOpen(".header-action-menu"), false); passed++;
    }
    for (const waiting of [false, true]) {
      await reset({ running: !waiting, workflowStatus: waiting ? "idle" : "running" }, false, waiting);
      const stop = '.composer-send [data-action="interrupt-run"]';
      assert.equal(await session.evaluate(`document.querySelector(${JSON.stringify(stop)}).getAttribute("aria-label")`), waiting ? "Cancel wait" : "Stop");
      assert.equal(await session.evaluate("document.querySelectorAll('[data-action=\"interrupt-run\"]').length"), 1);
      await session.evaluate("{ const draft = document.querySelector('#composer-prompt'); draft.value = 'Review retry handling and preserve unrelated edits'; draft.dispatchEvent(new Event('input', { bubbles: true })); }");
      await frame(session);
      assert.equal(await session.evaluate("document.querySelector('.composer-send [data-action=\"submit-message\"]') !== null"), true);
      await session.evaluate("{ const draft = document.querySelector('#composer-prompt'); draft.value = ''; draft.dispatchEvent(new Event('input', { bubbles: true })); }");
      await frame(session); await session.evaluate("window.__posted = []");
      await activate(stop, mode);
      if (mode === "keyboard") await key(session, "Enter", "Enter", 13); else await activate(stop, mode);
      assert.deepEqual(await dispatched(), [runtime("run.interrupt")]);
      assert.equal(await session.evaluate(`document.querySelector(${JSON.stringify(stop)}).disabled`), true);
      await reset({ running: false, workflowStatus: "interrupted" });
      assert.equal(await session.evaluate(`document.querySelector(${JSON.stringify(stop)}) === null`), true);
      await reset({ running: false, workflowStatus: "idle" });
      assert.equal(await session.evaluate("document.querySelector('.composer-send [data-action=\"submit-message\"]') !== null"), true); passed++;
    }
  }
  await reset({ running: true, workflowStatus: "running" });
  await session.evaluate(`{
    const input = document.querySelector('#attachment-input');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['Review retry handling and preserve unrelated edits'], 'review.md', { type: 'text/markdown' }));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }`);
  await frame(session);
  assert.equal(await session.evaluate("document.querySelector('.composer-send [data-action=\"submit-message\"]') !== null"), true);
  assert.equal(await session.evaluate("document.querySelector('.composer-send [data-action=\"interrupt-run\"]') === null"), true);
  assert.equal((await dispatched()).filter(message => message.message?.type === 'attachment.add').length, 1);
  passed++;
  for (const theme of ["light", "dark", "high-contrast"]) {
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme === "light" ? "light" : "dark" }, { name: "forced-colors", value: theme === "high-contrast" ? "active" : "none" }] });
    for (const width of widths) {
      await reset();
      await session.send("Emulation.setDeviceMetricsOverride", { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await session.evaluate(`document.body.className = ${JSON.stringify(`vscode-${theme}`)}`);
      await session.evaluate(`for (const [key,value] of Object.entries(${JSON.stringify(themeColors[theme === "light" ? "light" : "dark"])})) document.documentElement.style.setProperty('--vscode-' + key.replaceAll('.', '-'), value)`);
      await activate(menu, "keyboard");
      const controls = await session.evaluate(`Array.from(document.querySelectorAll('.header-action-menu button:enabled')).map(el => el.dataset.action)`);
      for (const action of controls) {
        const hitResult = await session.evaluate(`(() => {
          const el = document.querySelector('.header-action-menu [data-action="${action}"]');
          const inspect = () => {
            const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
            return { rect: [r.left, r.top, r.right, r.bottom], hit: hit?.dataset?.action ?? hit?.className ?? hit?.tagName, open: el.closest('details')?.open === true, scrollY };
          };
          const before = inspect();
          el.scrollIntoView({block:'nearest'});
          const after = inspect(), r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return { ok: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && r.height >= 24 && (hit === el || el.contains(hit)), before, after };
        })()`);
        assert.equal(hitResult.ok, true, `${theme} ${width}: hit-test ${action}: ${JSON.stringify(hitResult)}`);
      }
      await activate(bell, "keyboard");
      assert.equal(await isOpen(".header-action-menu"), false);
      assert.equal(await isOpen(".notification-center"), true);
      assert.equal(await session.evaluate("document.querySelector('#notification-mode') === null"), true);
      await activate('.notification-center [data-action="notification-settings"]', "keyboard");
      assert.equal(await session.evaluate("document.querySelector('#notification-mode')?.closest('.app-dialog') !== null"), true);
      await session.evaluate("window.__posted = []; const mode = document.querySelector('#notification-mode'); mode.value = 'off'; mode.dispatchEvent(new Event('change', { bubbles: true }))");
      await frame(session);
      assert.deepEqual(await dispatched(), [{ type: "notifications.setMode", mode: "off" }]);
      await key(session, "Escape", "Escape", 27);
      await frame(session);
      assert.equal(await session.evaluate("document.querySelector('.app-dialog') === null"), true);
      await key(session, "Escape", "Escape", 27);
      await frame(session);
      assert.equal(await isOpen(".notification-center"), false);
      assert.equal(await session.evaluate("document.activeElement === document.querySelector('.notification-center > summary')"), true);
      await activate(bell, "pointer"); await activate(menu, "pointer");
      assert.equal(await isOpen(".notification-center"), false);
      await press(session, "#composer-prompt");
      assert.equal(await isOpen(".header-action-menu"), false);
      await session.evaluate(`{
        const texts = ${JSON.stringify(["Please review the retry guard.", "# Review interrupted recovery\n\nTrace the accepted user stop through the adapter, pipeline checkpoint, restored catalogue and both views. Preserve unrelated edits and report independent provider failures.\n\n- Check keyboard focus and responsive wrapping.\n- Keep the recovery action reachable.\n\n`run.interrupt` and [review notes](https://example.com/review) should read left to right.\n\n```ts\nconst stopPending = true;\n```"])};
        window.__panelState.transcript = texts.map((text, index) => ({id:"source-review-"+index,kind:"prompt",eventType:"user.message",createdAt:"2026-09-12T10:00:00Z",text}));
        window.__panelState.transcriptTotal = texts.length; window.__boot();
      }`);
      await frame(session);
      assert.equal(await session.evaluate("document.querySelectorAll('.user-message').length"), 2);
      assert.equal(await session.evaluate("[...document.querySelectorAll('.user-message .markdown, .user-message .markdown p, .user-message .markdown h1, .user-message .markdown li, .user-message .markdown code, .user-message .markdown a')].every(el => getComputedStyle(el).textAlign === 'left')"), true, `${theme} ${width}: user message alignment`);
      await session.evaluate("window.__bootExecution()"); await frame(session);
      await press(session, '[data-action="room-view"][data-view="execution"]');
      let executionRendered = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        executionRendered = await session.evaluate("document.querySelector('.execution-content') !== null");
        if (executionRendered) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(executionRendered, true, `${theme} ${width}: execution view did not render`);
      const layout = await session.evaluate(`(() => {
        const area = document.querySelector('.execution-content'), result = area.querySelector('.result-center');
        const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        const textNodes = [...area.querySelectorAll('p,li,dt,dd,button,summary,small,[class*="meta"],.pipeline-step-timing')];
        const nodes = textNodes.filter(visible);
        const box = result.getBoundingClientRect();
        const areaStyle = getComputedStyle(area);
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          gutters: box.left >= 12 && box.right <= innerWidth - 12,
          disclosures: [...area.querySelectorAll('details.info-disclosure')].every(el => !el.open),
          undersized: textNodes.filter(el => parseFloat(getComputedStyle(el).fontSize) < 13).map(el => ({ tag: el.tagName, className: el.className, size: getComputedStyle(el).fontSize })),
          text: textNodes.every(el => parseFloat(getComputedStyle(el).fontSize) >= 13),
          controls: nodes.filter(el => el.matches('button,summary')).every(el => el.getBoundingClientRect().height >= 24),
          padding: parseFloat(areaStyle.paddingLeft) >= (innerWidth <= 600 ? 12 : 16) && parseFloat(areaStyle.paddingRight) >= (innerWidth <= 600 ? 12 : 16)
        };
      })()`);
      assert.deepEqual(layout.undersized, [], `${theme} ${width}: secondary text below 13px`);
      assert.equal(layout.overflow, false, `${theme} ${width}: overflow`);
      for (const property of ["gutters", "disclosures", "text", "controls", "padding"]) assert.equal(layout[property], true, `${theme} ${width}: ${property}`);
      assert.equal(await session.evaluate("document.querySelector('.result-failure') !== null"), true, `${theme} ${width}: genuine provider failure remains visible`);
      await session.evaluate(`{
        const result = window.__executionManagerState.resultsByConversation['run-1'];
        result.status = 'interrupted'; result.unresolvedRisks = [];
        result.finalAssessment = { outcome: 'failedBeforeRuling', method: 'none', summary: 'Stopped by you', producedBy: [] };
        window.__executionManagerState.eventsByConversation['run-1'] = window.__executionManagerState.eventsByConversation['run-1'].filter(event => event.type !== 'provider.failure').map(event => event.type === 'run.failed' ? {...event, type:'run.interrupted',status:'interrupted',title:'Stopped by you',payload:undefined} : event);
        window.__executionPanelState.workflowStatus = 'interrupted';
        window.__executionPanelState.resumableWorkflow = { ...window.__executionPanelState.resumableWorkflow, outcome: 'stoppedByUser' };
        window.__executionPanelState.transcript = window.__executionPanelState.transcript.filter(entry => entry.kind !== 'error');
        window.__bootExecution();
      }`);
      await frame(session);
      assert.equal(await session.evaluate("document.querySelector('.result-failure') === null"), true);
      assert.equal(await session.evaluate("document.querySelector('.result-decision').classList.contains('outcome-interrupted')"), true);
      assert.match(await session.evaluate("document.querySelector('.execution-content').textContent"), /Stopped by you/);
      await press(session, '[data-action="room-view"][data-view="chat"]');
      assert.equal(await session.evaluate("document.querySelector('.run-outcome [data-action=\"workflow-resume\"]').textContent.trim()"), 'Resume stopped step');
      await runStateMatrixChecks(session, key, `${theme} ${width}`);
      passed++;
    }
  }
  await session.evaluate(`window.__executionManagerState = ${JSON.stringify(baseline.executionManager)}; window.__executionPanelState = ${JSON.stringify(baseline.executionPanel)}`);
  console.log(`Product interaction/layout cases: ${passed} passed, 0 failed, 0 skipped`);
  return passed;
};
