import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const themeColors = JSON.parse(readFileSync(new URL("../../tests/fixtures/webview-layout/theme-colors.json", import.meta.url), "utf8"));
const menu = ".header-action-menu > summary";
const bell = ".notification-center > summary";
const frame = (session) => session.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
const runtime = (type) => ({ type: "conversation.runtime", conversationId: "run-1", message: { type } });
const actions = ["inspector-toggle", "room-view", "pipeline-new", "pipeline-fork", "availability-check", "working-directory", "orchestration-start", "transcript-export", "task-reset"];

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
    for (const action of actions) {
      await reset();
      await activate(menu, mode);
      assert.equal(await isOpen(".header-action-menu"), true, `${mode}: menu opened`);
      await session.evaluate("window.__posted = []");
      await activate(`.header-action-menu [data-action="${action}"]`, mode, mode === "pointer");
      assert.equal(await isOpen(".header-action-menu"), false, `${mode} ${action}: menu dismissal`);
      const sent = await dispatched();
      assert.deepEqual(await session.evaluate("window.__activatedActions"), [action], `${mode}: one activation`);
      if (action === "pipeline-fork") {
        assert.equal(sent.length, 1); assert.equal(sent[0].type, "conversation.runtime");
        assert.equal(sent[0].conversationId, "run-1"); assert.equal(sent[0].message.type, "pipeline.fork");
        assert.equal(sent[0].message.pipelineId, "custom-a"); assert.ok(sent[0].message.requestId);
      } else if (["availability-check", "working-directory", "orchestration-start", "transcript-export"].includes(action)) {
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
      if (action === "room-view") assert.equal(await session.evaluate("document.querySelector('[data-view=\"direction\"]').classList.contains('selected')"), true);
      if (action === "pipeline-new" || action === "pipeline-fork") {
        assert.equal(await session.evaluate("document.querySelector('.pipeline-editor') !== null"), true);
        await key(session, "Escape", "Escape", 27);
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
      assert.equal(await session.evaluate("document.querySelector('.header-action-menu [data-action=\"pipeline-new\"]').disabled"), true);
      assert.match(await session.evaluate("document.querySelector('.header-action-menu [data-action=\"pipeline-new\"]').title"), /read-only/);
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
        assert.equal(await session.evaluate(`(() => {
          const el = document.querySelector('.header-action-menu [data-action="${action}"]'); el.scrollIntoView({block:'nearest'});
          const r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
          return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && r.height >= 24 && (hit === el || el.contains(hit));
        })()`), true, `${theme} ${width}: hit-test ${action}`);
      }
      await activate(bell, "keyboard");
      assert.equal(await isOpen(".header-action-menu"), false);
      assert.equal(await isOpen(".notification-center"), true);
      assert.equal(await session.evaluate("document.querySelector('#notification-mode').closest('.notification-center') !== null"), true);
      await session.evaluate("window.__posted = []; const mode = document.querySelector('#notification-mode'); mode.value = 'off'; mode.dispatchEvent(new Event('change', { bubbles: true }))");
      await frame(session);
      assert.deepEqual(await dispatched(), [{ type: "notifications.setMode", mode: "off" }]);
      await key(session, "Escape", "Escape", 27);
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
      const layout = await session.evaluate(`(() => {
        const area = document.querySelector('.execution-content'), result = area.querySelector('.result-center');
        const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
        const textNodes = [...area.querySelectorAll('p,li,dt,dd,button,summary,small,[class*="meta"],.pipeline-step-timing')];
        const nodes = textNodes.filter(visible);
        const cards = [...area.querySelectorAll('.result-center,.pipeline-summary')].filter(visible);
        const box = result.getBoundingClientRect();
        return { overflow: document.documentElement.scrollWidth > innerWidth,
          gutters: box.left >= 12 && box.right <= innerWidth - 12,
          disclosures: [...area.querySelectorAll('details.info-disclosure')].every(el => !el.open),
          smallCount: textNodes.filter(el => el.matches('small')).length,
          metadataCount: textNodes.filter(el => el.matches('[class*="meta"],.pipeline-step-timing')).length,
          undersized: textNodes.filter(el => parseFloat(getComputedStyle(el).fontSize) < 13).map(el => ({ tag: el.tagName, className: el.className, size: getComputedStyle(el).fontSize })),
          text: textNodes.every(el => parseFloat(getComputedStyle(el).fontSize) >= 13),
          controls: nodes.filter(el => el.matches('button,summary')).every(el => el.getBoundingClientRect().height >= 24),
          padding: cards.every(el => parseFloat(getComputedStyle(el).paddingLeft) >= 16 && parseFloat(getComputedStyle(el).paddingRight) >= 16)
        };
      })()`);
      assert.ok(layout.smallCount > 0, `${theme} ${width}: small text was not measured`);
      assert.ok(layout.metadataCount > 0, `${theme} ${width}: metadata text was not measured`);
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
        window.__executionPanelState.transcript = window.__executionPanelState.transcript.filter(entry => entry.kind !== 'error');
        window.__bootExecution();
      }`);
      await frame(session);
      assert.equal(await session.evaluate("document.querySelector('.result-failure') === null"), true);
      assert.equal(await session.evaluate("document.querySelector('.result-decision').classList.contains('outcome-interrupted')"), true);
      assert.match(await session.evaluate("document.querySelector('.execution-content').textContent"), /Stopped by you/);
      await press(session, '[data-action="room-view"][data-view="chat"]');
      assert.equal(await session.evaluate("document.querySelector('.recovery-card [data-action=\"workflow-resume\"]').textContent.trim()"), 'Resume stopped step');
      passed++;
    }
  }
  await session.evaluate(`window.__executionManagerState = ${JSON.stringify(baseline.executionManager)}; window.__executionPanelState = ${JSON.stringify(baseline.executionPanel)}`);
  console.log(`Product interaction/layout cases: ${passed} passed, 0 failed, 0 skipped`);
  return passed;
};
