import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const palettes = JSON.parse(readFileSync(new URL("../../tests/fixtures/webview-layout/theme-colors.json", import.meta.url), "utf8"));
const settle = (session) => session.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
const measure = (session) => session.evaluate("window.__measureTabStress()");

const assertLayout = (result, count, controls, label) => {
  assert.equal(result.count, count, `${label}: tab count`);
  assert.equal(result.renderFailure, false, `${label}: rendering`);
  assert.equal(result.horizontalPageOverflow, false, `${label}: page width`);
  if (count > 1) assert.ok(result.minimumInactiveWidth >= 39.99, `${label}: 40px minimum`);
  for (const key of ["allLabelsVisible", "labelsContained", "truncated", "fullTitles", "oneTabStop", "selectedContained", "selectedControlsReachable", "newRunReachable", "runsReachable"]) {
    assert.equal(result[key], true, `${label}: ${key}`);
  }
  assert.equal(result.inactiveDetails, false, `${label}: inactive details`);
  assert.equal(result.selectedControlCount, controls, `${label}: complete active controls`);
  assert.ok(result.selectedTitleWidth >= 32, `${label}: selected title has readable space (${JSON.stringify(result)})`);
  assert.deepEqual(result.order, Array.from({ length: count }, (_, index) => `stress-${index + 1}`), `${label}: stable order`);
};

export const runTabStressChecks = async (session, press, pressKey) => {
  const original = await session.evaluate("({ style: document.documentElement.getAttribute('style'), width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio })");
  let cases = 0;
  try {
    for (const theme of ["light", "dark"]) {
      for (const width of [320, 400, 480, 792, 900, 1280]) {
        await session.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await session.evaluate(`(() => {
          for (const [key, value] of Object.entries(${JSON.stringify(palettes[theme])})) document.documentElement.style.setProperty('--vscode-' + key.replaceAll('.', '-'), value);
          document.documentElement.style.setProperty('--vscode-font-size', '18px');
        })()`);
        for (const running of [false, true]) {
          for (const count of [1, 25, 250, 1000]) {
            const label = `${theme} ${width}px ${count} ${running ? "running" : "idle"} runs`;
            await session.evaluate(`window.__seedTabStress(${count}, ${count - 1}, { running: ${running} })`);
            await settle(session);
            if (running) await press(session, '.run-tab-tools [data-view="execution"]');
            else if (await session.evaluate("!!document.querySelector('.run-tab-tools [data-view=chat]')")) await press(session, '.run-tab-tools [data-view="chat"]');
            await settle(session);
            assertLayout(await measure(session), count, running ? 5 : 2, label);
            cases++;
          }
        }
        for (const [selector, trigger, action] of [
          [".run-tab.selected .run-action-menu", "#room-actions-button", '[data-action="run-rename"]'],
          [".run-tab.selected .notification-center", "#notification-button", '[data-action="notification-settings"]'],
        ]) {
          await press(session, trigger);
          await settle(session);
          const menuResult = await session.evaluate(`window.__measureTabStressMenu(${JSON.stringify(selector)})`);
          const menuDiagnostics = menuResult.controlsReachable ? undefined : await session.evaluate(`(() => {
            const panel = document.querySelector(${JSON.stringify(selector)})?.querySelector(':scope > div');
            return Array.from(panel?.querySelectorAll('button:not([disabled])') ?? []).map(control => {
              const box = control.getBoundingClientRect();
              const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
              return { action: control.dataset.action, rect: [box.left, box.top, box.right, box.bottom], hit: hit?.dataset?.action ?? hit?.className ?? hit?.tagName };
            });
          })()`);
          assert.deepEqual(menuResult, {
            open: true, contained: true, controlsReachable: true,
          }, `${theme} ${String(width)}px ${selector}: ${JSON.stringify(menuDiagnostics)}`);
          await press(session, `${selector} ${action}`);
          await settle(session);
          assert.equal(await session.evaluate("!!document.querySelector('.app-dialog')"), true, "menu action opens its dialog");
          await press(session, '.app-dialog [data-action="dialog-cancel"]');
          await settle(session);
          await pressKey(session, "Escape", "Escape", 27);
        }
        await session.evaluate("document.querySelector('.run-tab.selected .run-tab-select').focus()");
        await pressKey(session, "Home", "Home", 36);
        let result = await measure(session);
        assert.equal(result.focusedId, "stress-1");
        assert.equal(result.focusedReachable, true);
        assert.equal(result.selectedId, "stress-1000");
        await session.evaluate("window.__posted.length = 0");
        await pressKey(session, "Enter", "Enter", 13);
        await settle(session);
        assert.equal((await measure(session)).selectedId, "stress-1");
        assert.deepEqual(await session.evaluate("window.__posted.filter(message => message.type === 'conversation.select')"), [
          { type: "conversation.select", conversationId: "stress-1" },
        ]);
        await session.evaluate("window.__tabStressState.activeConversationId = 'stress-1'; window.__publishTabStress()");
        await settle(session);
        await press(session, ".run-tab.selected .run-tab-select");
        await pressKey(session, "End", "End", 35);
        result = await measure(session);
        assert.equal(result.focusedId, "stress-1000");
        assert.equal(result.focusedReachable, true);
        const left = result.scrollLeft;
        for (let update = 0; update < 20; update++) {
          await session.evaluate("window.__tabStressState.conversations[999].unread++; window.__publishTabStress()");
          await settle(session);
          assert.equal(await session.evaluate(`document.querySelector('.run-tab-select[data-conversation="stress-1000"]').textContent.includes(new Intl.NumberFormat().format(window.__tabStressState.conversations[999].unread) + ' unread messages')`), true, "the updated snapshot is rendered");
          assert.ok(Math.abs((await measure(session)).scrollLeft - left) <= 1, "snapshots preserve browsing scroll");
        }
        await session.evaluate("document.querySelector('.run-tabs-scroll').scrollLeft /= 2");
        await settle(session);
        const anchor = (await measure(session)).anchor;
        assert.ok(anchor, "a run is visible in the middle of the strip");
        for (const archived of [true, false]) {
          await session.evaluate(`(() => {
            const run = window.__tabStressState.conversations[9];
            Object.assign(run, { running: false, workflowStatus: 'completed', archived: ${archived} });
            window.__publishTabStress();
          })()`);
          await settle(session);
          const next = await measure(session);
          assert.equal(next.count, archived ? 999 : 1000);
          assert.equal(next.anchor?.id, anchor.id, "archiving keeps the same visible run");
          assert.ok(Math.abs(next.anchor.offset - anchor.offset) <= 1, "archiving preserves the visible offset");
        }
        await session.evaluate("window.__tabStressState.activeConversationId = 'stress-500'; window.__publishTabStress()");
        await settle(session);
        result = await measure(session);
        assert.equal(result.focusedId, "stress-500", "host selection keeps focus visible");
        assert.equal(result.focusedReachable, true);
        assert.equal(result.selectedContained, true);
        await pressKey(session, "End", "End", 35);
        await pressKey(session, "Enter", "Enter", 13);
        await settle(session);
        await press(session, ".run-tab.selected .run-action-menu > summary");
        await session.evaluate("document.querySelector('.run-tabs-scroll').scrollLeft = 0");
        await settle(session);
        assert.equal(await session.evaluate("document.querySelector('.run-tab.selected .run-action-menu').open"), false);
        await press(session, ".run-tab-all");
        await session.evaluate(`(() => {
          const search = document.querySelector('#run-search');
          search.value = 'Run 997 ';
          search.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        await settle(session);
        assert.deepEqual(await session.evaluate("Array.from(document.querySelectorAll('.run-drawer-select')).map(button => button.dataset.conversation)"), ["stress-997"]);
        await press(session, '.run-drawer-select[data-conversation="stress-997"]');
        await settle(session);
        assert.equal((await measure(session)).selectedId, "stress-997");
        assert.equal((await measure(session)).selectedContained, true);
        await press(session, ".run-tab.selected .run-action-menu > summary");
        await session.send("Emulation.setDeviceMetricsOverride", { width: width === 320 ? 1280 : 320, height: 900, deviceScaleFactor: 1, mobile: false });
        await settle(session);
        assert.equal(await session.evaluate("document.querySelector('.run-tab.selected .run-action-menu').open"), false, "resizing closes the moved menu");
        assert.equal((await measure(session)).selectedContained, true);
        await session.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
        await session.evaluate("window.__seedTabStress(25, 24, { archivedCount: 1000 })");
        await settle(session);
        assertLayout(await measure(session), 25, 2, `${theme} ${width}px with 1000 archived runs`);
        assert.equal(await session.evaluate("document.querySelector('.run-tab-all').getBoundingClientRect().width <= 104"), true);
        cases++;
        await session.evaluate("window.__posted.length = 0");
        await press(session, ".run-tab-new");
        assert.equal(await session.evaluate("window.__posted.filter(message => message.type === 'conversation.create').length"), 1);
      }
    }
  } finally {
    await session.evaluate(`(() => {
      const style = ${JSON.stringify(original.style)};
      if (style === null) document.documentElement.removeAttribute('style');
      else document.documentElement.setAttribute('style', style);
      window.__boot();
    })()`);
    await session.send("Emulation.setDeviceMetricsOverride", { width: original.width, height: original.height, deviceScaleFactor: original.deviceScaleFactor, mobile: false });
    await settle(session);
  }
  console.log(`Run tab stress: ${cases} layout cases passed, with keyboard, pointer, search, and snapshot checks.`);
};
