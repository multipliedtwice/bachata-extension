import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const direction = JSON.parse(readFileSync(new URL("../../tests/fixtures/webview-layout/direction.json", import.meta.url), "utf8"));
const themes = JSON.parse(readFileSync(new URL("../../tests/fixtures/webview-layout/theme-colors.json", import.meta.url), "utf8"));
const frame = (session) => session.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");

export const runMinimalLayoutChecks = async (session, press, key) => {
  let checks = 0;
  const reload = async () => {
    await session.evaluate("window.__minimalReload = true");
    await session.send("Page.reload");
    let loaded = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        loaded = await session.evaluate("!window.__minimalReload && document.readyState === 'complete' && typeof window.__boot === 'function'");
      } catch {}
      if (loaded) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(loaded, true, "minimal layout fixture loaded");
  };
  await reload();
  const baseline = await session.evaluate("({manager:window.__managerState,panel:window.__panelState,executionManager:window.__executionManagerState,executionPanel:window.__executionPanelState})");
  const reset = async (width, font, theme, height = 900) => {
    await reload();
    await session.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "forced-colors", value: "none" }] });
    await session.evaluate(`{
      const baseline = ${JSON.stringify(baseline)};
      window.__managerState = baseline.manager;
      window.__panelState = baseline.panel;
      window.__executionManagerState = baseline.executionManager;
      window.__executionPanelState = baseline.executionPanel;
      for (const [key, value] of Object.entries(${JSON.stringify(themes[theme])})) document.documentElement.style.setProperty('--vscode-' + key.replaceAll('.', '-'), value);
      document.documentElement.style.setProperty('--vscode-font-size', '${font}px');
      window.__boot();
    }`);
    await frame(session);
    await key(session, "Escape", "Escape", 27);
  };
  const readable = async (label) => {
    const issues = await session.evaluate(`(() => {
      const visible = el => el.checkVisibility() && !el.closest('.sr-only') && getComputedStyle(el).visibility !== 'hidden';
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        small: [...document.querySelectorAll('p,small,time,label>span,h2,h3,h4,button,select,summary,.message-author')].filter(visible).filter(el => el.textContent.trim() && parseFloat(getComputedStyle(el).fontSize) < 12).map(el => el.className || el.tagName),
      };
    })()`);
    assert.equal(issues.overflow, false, `${label}: horizontal overflow`);
    assert.deepEqual(issues.small, [], `${label}: undersized text`);
    checks++;
  };
  for (const theme of ["light", "dark"]) {
    for (const width of [320, 400, 792, 1280]) {
      for (const font of [13, 18]) {
        const label = `${theme} ${width}px ${font}px`;
        await reset(width, font, theme);
        await session.evaluate("window.__bootExecution()");
        await frame(session);
        await readable(`${label} Chat`);
        const rail = await session.evaluate(`(() => {
          const composer = document.querySelector('.composer-surface').getBoundingClientRect();
          const result = document.querySelector('.run-outcome').getBoundingClientRect();
          return {left:Math.abs(composer.left-result.left),right:Math.abs(composer.right-result.right)};
        })()`);
        assert.ok(rail.left <= 1 && rail.right <= 1, `${label}: shared content alignment`);
        await press(session, '[data-action="room-view"][data-view="execution"]');
        await frame(session);
        await readable(`${label} Execution`);
        assert.ok(await session.evaluate("parseFloat(getComputedStyle(document.querySelector('.result-failure-cause')).fontSize)") >= Math.max(13, font), `${label}: Execution respects text size`);
        await press(session, '[data-action="room-view"][data-view="chat"]');
        await frame(session);
        await press(session, '.composer-settings-button');
        await frame(session);
        await readable(`${label} settings`);
        const stable = await session.evaluate(`(() => {const box = document.querySelector('.composer-surface').getBoundingClientRect(); return {y:box.y,h:box.height};})()`);
        await press(session, '.composer-settings-button');
        await frame(session);
        assert.deepEqual(await session.evaluate(`(() => {const box = document.querySelector('.composer-surface').getBoundingClientRect(); return {y:box.y,h:box.height};})()`), stable, `${label}: settings do not move input`);
        await press(session, '#agents-picker-button');
        await frame(session);
        await readable(`${label} Agents`);
        assert.equal(await session.evaluate(`(() => {
          const slots = [...document.querySelectorAll('.agents-slot')];
          return slots.length > 0 && slots.every(slot =>
            slot.querySelector('.agents-provider-select')?.checkVisibility() &&
            slot.querySelector('.agents-model-chip')?.checkVisibility()
          );
        })()`), true, `${label}: provider and model settings are visible`);
        await press(session, '.agents-model-chip');
        await frame(session);
        await readable(`${label} Agents model menu`);
        assert.equal(await session.evaluate("Boolean(document.querySelector('.agents-model-menu')?.checkVisibility())"), true, `${label}: model menu opens`);
        await key(session, "Escape", "Escape", 27);
        await frame(session);
        await key(session, "Escape", "Escape", 27);
        await frame(session);
        await session.evaluate(`window.__managerState.direction = ${JSON.stringify(direction)}; window.__boot()`);
        await frame(session);
        await press(session, '[data-action="run-drawer-toggle"]');
        await frame(session);
        await press(session, ".run-drawer-direction");
        await frame(session);
        await readable(`${label} Direction`);
        assert.equal(await session.evaluate("document.querySelector('[data-action=\"direction-section-toggle\"][data-section=\"direction-edit\"]').getAttribute('aria-expanded')"), "false");
        await press(session, '[data-action="direction-section-toggle"][data-section="direction-edit"]');
        await frame(session);
        await readable(`${label} direction editor`);
        await press(session, '[data-action="direction-section-toggle"][data-section="direction-initiative"]');
        await frame(session);
        await readable(`${label} initiative management`);
      }
    }
  }
  for (const [width, height, font] of [[320, 500, 13], [400, 500, 18], [792, 900, 13], [1280, 900, 18]]) {
    await reset(width, font, "dark", height);
    await press(session, '#pipeline-picker-button');
    await frame(session);
    await press(session, '.pipeline-picker-row[data-selected="true"] [data-action="pipeline-row-menu"]');
    await frame(session);
    await press(session, '.pipeline-picker-row[data-selected="true"] [data-action="pipeline-row-edit"]');
    await frame(session);
    await readable(`editor ${width} ${height} ${font}`);
    const dialog = await session.evaluate(`(() => {const r = document.querySelector('.pipeline-editor').getBoundingClientRect();return {left:r.left,right:innerWidth-r.right,top:r.top,bottom:innerHeight-r.bottom};})()`);
    assert.ok(Math.abs(dialog.left-dialog.right) <= 1 && dialog.left >= 15 && dialog.top >= 15 && dialog.bottom >= 15, `editor ${width}: symmetric gutters and viewport containment`);
    await press(session, '[data-action="pipeline-editor-close"]');
    await frame(session);
  }
  console.log(`Minimal layout checks passed for ${checks} rendered surfaces.`);
};
