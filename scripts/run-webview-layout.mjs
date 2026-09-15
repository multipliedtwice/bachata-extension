import { runMinimalLayoutChecks } from "./lib/webviewMinimalLayoutChecks.mjs";
import { runWebviewProductChecks } from "./lib/webviewProductChecks.mjs";
import { runTabStressChecks } from "./lib/runTabStressChecks.mjs";
/**
 * EX-UI-04. The run tab strip's hit regions at the widths a side panel actually has.
 *
 * The strip's narrow rules are viewport media queries, and a webview cannot resize its own
 * viewport — so the activation smoke can only assert these invariants at whatever width the host
 * gave it. This drives the same built bundle in a browser whose viewport it can set, and asserts
 * at every width that matters: the selected run's action menu and the New-run button never share
 * a pixel, each is what a pointer meets at its own centre, a real press opens the menu and creates
 * no run, Escape closes it and returns focus, and the menu still takes keyboard focus.
 *
 * Chrome is driven over the DevTools protocol with the platform WebSocket — no dependency is
 * installed for this, and nothing here reaches the network. A missing browser is a failure, not a
 * skip: this is the only check that measures the shipped layout, and a silent skip would report a
 * gap as a pass.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { closeCdpSession, delay, openCdpSession } from "./lib/chromeSession.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "tests", "fixtures", "webview-layout", "index.html");
const bundle = path.join(root, "dist", "webview.js");
const WIDTHS = [320, 360, 400, 480, 700, 792, 900, 1280];

const resolveChrome = () => {
  const configured = process.env.BACHATA_CHROME_BINARY?.trim();
  if (configured) {
    if (!existsSync(configured)) throw new Error(`BACHATA_CHROME_BINARY does not exist: ${configured}`);
    return configured;
  }
  const candidates = process.platform === "darwin"
    ? [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ]
    : process.platform === "win32"
      ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]
      : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["google-chrome"], { encoding: "utf8" });
  const fromPath = probe.status === 0 ? probe.stdout.trim().split("\n")[0] : "";
  if (fromPath && existsSync(fromPath)) return fromPath;
  throw new Error(
    "No Chrome or Chromium binary was found. Set BACHATA_CHROME_BINARY to one. This gate measures a real layout and is never skipped: without a browser the run tab strip is unverified.",
  );
};

/**
 * Chrome is asked for port 0 and reports the port it actually took in `DevToolsActivePort` inside
 * the profile this run owns. A fixed port would collide with whatever else on the machine listens
 * on that number — a VS Code helper, another checkout's run — and the collision would look like a
 * layout failure.
 */
const readDebugPort = async (profile, child) => {
  const portFile = path.join(profile, "DevToolsActivePort");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Chrome exited with ${String(child.signalCode ?? child.exitCode)} before it reported a debugging port`);
    }
    if (existsSync(portFile)) {
      const [port] = readFileSync(portFile, "utf8").split("\n");
      if (port && Number.isInteger(Number(port))) return Number(port);
    }
    await delay(100);
  }
  throw new Error("Chrome never wrote DevToolsActivePort");
};

/**
 * The browser this gate measures in. `openCdpSession` owns the child from the launch onwards, so a
 * failure anywhere between the spawn and the first command stops the browser before it rethrows —
 * there is no window in which a started Chrome has no owner.
 *
 * The fixture is addressed through `pathToFileURL`, not by pasting the path after `file://`: a
 * checkout under a directory with a space, a `#` or a `%` in its name produced a URL that named a
 * different file or no file at all, and the gate reported the resulting empty page as a layout
 * failure.
 */
const connect = (profile) =>
  openCdpSession({
    launch: () => spawn(resolveChrome(), [
      "--headless=new",
      ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--allow-file-access-from-files",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--window-size=1280,900",
      "--hide-scrollbars",
      pathToFileURL(fixture).href,
    ], { stdio: "ignore" }),
    readPort: (child) => readDebugPort(profile, child),
  });

// A pointer user arrives at a control by moving onto it, and the move can change what is drawn
// before the press lands. The rect is read again after the move, so the press goes where the
// control actually is rather than where it was at rest.
//
// The control is waited for rather than assumed present after a fixed delay. A snapshot this
// fixture sends is rendered asynchronously, and a fixed 200 ms was enough on an idle machine and
// not enough under load — which made this gate report a render that had not happened yet as a
// missing control. Absence is still a failure: the wait is bounded and then throws.
const press = async (session, selector) => {
  const locate = () => session.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  let first = await locate();
  for (let attempt = 0; attempt < 50 && !first; attempt += 1) {
    await delay(100);
    first = await locate();
  }
  if (!first) throw new Error(`No element for ${selector} after 5s`);
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: first.x, y: first.y });
  await delay(120);
  const point = await session.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await delay(40);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await session.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
  }
  await delay(160);
};

const pressKey = async (session, key, code, keyCode) => {
  for (const type of ["keyDown", "keyUp"]) {
    await session.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, ...(type === "keyDown" && key === "Enter" ? { text: "\r" } : {}) });
  }
  await delay(160);
};

const MENU = ".run-tab.selected .run-action-menu > summary";
const CREATE = ".run-tab-new";

const measure = `(() => {
  const menu = document.querySelector(${JSON.stringify(MENU)});
  const create = document.querySelector(${JSON.stringify(CREATE)});
  if (!menu || !create) return { present: false };
  const hits = (el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || el.contains(hit);
  };
  const a = menu.getBoundingClientRect();
  const b = create.getBoundingClientRect();
  return {
    present: true,
    width: document.documentElement.clientWidth,
    menuBox: [Math.round(a.left), Math.round(a.right)],
    createBox: [Math.round(b.left), Math.round(b.right)],
    overlap: Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 &&
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0,
    menuHit: hits(menu),
    createHit: hits(create),
    menuVisible: a.width > 0 && a.height > 0,
    createVisible: b.width > 0 && b.height > 0,
    horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
})()`;

const reachability = `(() => {
  const tabs = Array.from(document.querySelectorAll(".run-tab"));
  return {
    tabs: tabs.length,
    renderFailure: document.querySelector(".render-failure") !== null,
    mismatched: tabs.map((tab) => {
      const summary = tab.querySelector(".run-action-menu > summary");
      if (!tab.classList.contains("selected")) {
        const select = tab.querySelector(".run-tab-select");
        if (summary || tab.querySelector(".run-tab-tools")) return "an inactive tab exposes details";
        if (!select || select.getBoundingClientRect().width < 39) return "an inactive tab is hidden or smaller than 40px";
        const previous = document.activeElement;
        select.focus({ preventScroll: true });
        const reachable = document.activeElement === select;
        previous?.focus({ preventScroll: true });
        return reachable ? null : "an inactive tab cannot receive keyboard focus";
      }
      if (!summary) return "a run tab has no action menu";
      const box = summary.getBoundingClientRect();
      const drawn = Number(getComputedStyle(summary).opacity) > 0 && box.width > 0 && box.height > 0;
      const previous = document.activeElement;
      summary.focus({ preventScroll: true });
      const reachable = document.activeElement === summary;
      previous?.focus({ preventScroll: true });
      if (drawn === reachable) return null;
      // Concatenated, not interpolated: this whole function is itself a template literal handed to
      // the browser, and a nested backtick would end it here rather than inside the page.
      return (tab.classList.contains("selected") ? "the selected" : "an unselected") +
        " run's action menu is " +
        (drawn ? "drawn but not keyboard reachable" : "keyboard reachable but not drawn");
    }).filter((entry) => entry !== null),
  };
})()`;

// Check the shared input surface and toolbar at every supported pane width.
const composerMeasure = `(() => {
  const toolbar = document.querySelector(".composer-toolbar");
  const send = document.querySelector(".composer-send .send-button");
  const picker = document.querySelector(".pipeline-picker-button");
  const settings = document.querySelector('[data-action="composer-settings-toggle"]');
  const attach = document.querySelector('[data-action="attachment-pick"]');
  const agents = document.querySelector("#agents-picker-button");
  const surface = document.querySelector(".composer-surface");
  const prompt = document.querySelector("#composer-prompt");
  const nativeSelect = document.querySelector("#pipeline-select");
  if (!toolbar || !send || !picker || !settings || !attach || !surface || !prompt) return { present: false };
  const t = toolbar.getBoundingClientRect();
  const s = send.getBoundingClientRect();
  const p = picker.getBoundingClientRect();
  const card = surface.getBoundingClientRect();
  const gear = settings.getBoundingClientRect();
  return {
    present: true,
    width: document.documentElement.clientWidth,
    nativeSelect: nativeSelect !== null,
    sendVisible: s.width > 0 && s.height > 0,
    sendRightOfPicker: Math.round(s.left) >= Math.round(p.right),
    agentsPresent: agents !== null,
    agentsBox: agents ? [agents.getBoundingClientRect().left, agents.getBoundingClientRect().top, agents.getBoundingClientRect().width, agents.getBoundingClientRect().height] : null,
    sendOnFirstRow: [attach, picker, settings, send, ...(agents ? [agents] : [])].every((control) => {
      const r = control.getBoundingClientRect();
      return Math.abs(r.top + r.height / 2 - t.top - t.height / 2) <= 1;
    }),
    surfaceContainsInput: [prompt, toolbar].every((element) => {
      const r = element.getBoundingClientRect();
      return r.left >= card.left && r.right <= card.right + 1 && r.top >= card.top && r.bottom <= card.bottom + 1;
    }),
    settingsBox: [gear.left, gear.top, gear.width, gear.height],
    sendSquare: Math.abs(s.width - s.height) <= 1,
    horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
})()`;

// The rich pipeline picker opens as a floating listbox above the toolbar; it must not be clipped by
// the composer surface or a scroll container, so its box sits above the toolbar and inside the
// viewport at every width.
const pickerMeasure = `(() => {
  const pop = document.querySelector(".pipeline-picker-popover");
  const toolbar = document.querySelector(".composer-toolbar");
  if (!pop || !toolbar) return { present: false };
  const p = pop.getBoundingClientRect();
  const t = toolbar.getBoundingClientRect();
  return {
    present: true,
    aboveToolbar: p.bottom <= t.top + 1,
    topVisible: p.top >= -1,
    withinViewport: p.left >= -1 && p.right <= document.documentElement.clientWidth + 1 && p.bottom <= document.documentElement.clientHeight + 1,
    visibleAtTop: pop.contains(document.elementFromPoint(p.left + p.width / 2, p.top + 8)),
  };
})()`;

// The Agents popover opens above the same toolbar. It carries more content than the pipeline
// listbox — several responsibilities, their provider choices and a browser conversation list — so
// at a narrow width it must scroll inside itself rather than escape the pane or clip a row away.
const agentsMeasure = `(() => {
  const pop = document.querySelector(".agents-popover");
  const toolbar = document.querySelector(".composer-toolbar");
  if (!pop || !toolbar) return { present: false };
  const p = pop.getBoundingClientRect();
  const t = toolbar.getBoundingClientRect();
  const slots = Array.from(document.querySelectorAll(".agents-slot"));
  const choices = Array.from(document.querySelectorAll('.agents-choices [role="radio"]'));
  const groups = Array.from(document.querySelectorAll(".agents-choices"));
  return {
    present: true,
    aboveToolbar: p.bottom <= t.top + 1,
    topVisible: p.top >= -1,
    withinViewport: p.left >= -1 && p.right <= document.documentElement.clientWidth + 1 && p.bottom <= document.documentElement.clientHeight + 1,
    visibleAtTop: pop.contains(document.elementFromPoint(p.left + p.width / 2, p.top + 8)),
    scrollsInside: pop.scrollHeight <= pop.clientHeight + 1 || getComputedStyle(pop).overflowY === "auto",
    slotCount: slots.length,
    // Every slot's controls stay inside the popover's own box at every width.
    slotsContained: slots.every((slot) => {
      const r = slot.getBoundingClientRect();
      return r.left >= p.left - 1 && r.right <= p.right + 1;
    }),
    choicesContained: choices.every((choice) => {
      const r = choice.getBoundingClientRect();
      return r.left >= p.left - 1 && r.right <= p.right + 1;
    }),
    // One tab stop per responsibility, with the assigned choice carrying it.
    rovingTabStops: groups.every((group) => {
      const radios = Array.from(group.querySelectorAll('[role="radio"]'));
      return radios.filter((radio) => radio.getAttribute("tabindex") === "0").length === 1;
    }),
    sessionsListed: document.querySelectorAll('[data-action="agents-session"]').length,
    horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
})()`;

const agentsDismissed = `(() => ({
  open: document.querySelector(".agents-popover") !== null,
  focusReturned: document.activeElement === document.querySelector("#agents-picker-button"),
}))()`;

/*
 * The execution view a reader stands in when a run has stopped: the compact pipeline summary, the
 * failure, and the two ways back into the run. Measured at every width because these are the
 * widest strings the product draws — a step name, a provider sentence and two action labels on
 * one row — and a 320px pane is where they escape their card.
 */
const executionMeasure = `(() => {
  const summary = document.querySelector(".pipeline-summary");
  const rows = Array.from(document.querySelectorAll(".pipeline-step"));
  const restart = document.querySelector('[data-action="workflow-restart"]');
  const retry = document.querySelector('[data-action="workflow-resume"]');
  const disclosures = Array.from(document.querySelectorAll(".info-disclosure"));
  if (!summary || rows.length === 0 || !restart || !retry) {
    return {
      present: false,
      summary: summary !== null,
      rows: rows.length,
      restart: restart !== null,
      retry: retry !== null,
    };
  }
  const viewport = document.documentElement.clientWidth;
  const box = summary.getBoundingClientRect();
  const inside = (element, container) => {
    const r = element.getBoundingClientRect();
    return r.left >= container.left - 1 && r.right <= container.right + 1;
  };
  const hits = (el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return hit === el || el.contains(hit);
  };
  const more = restart.closest("details").querySelector("summary");
  const moreBox = more.getBoundingClientRect();
  const retryBox = retry.getBoundingClientRect();
  return {
    present: true,
    width: viewport,
    rows: rows.length,
    rowsContained: rows.every((row) => inside(row, box)),
    summaryWithinViewport: box.left >= -1 && box.right <= viewport + 1,
    // Every information disclosure starts closed, which is the whole point of moving background
    // and provenance behind one.
    disclosureCount: disclosures.length,
    disclosuresClosed: disclosures.every((entry) => entry.open === false),
    moreHit: hits(more),
    retryHit: hits(retry),
    actionsSized: [moreBox, retryBox].every((r) => r.width > 0 && r.height >= 22),
    actionsWithinViewport: [moreBox, retryBox].every((r) => r.left >= -1 && r.right <= viewport + 1),
    moreFocusable: more.tabIndex >= 0,
    retryFocusable: retry.tabIndex >= 0,
    failureStated: document.body.innerText.includes("requires a newer version of Codex"),
    horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  };
})()`;

const menuState = `(() => {
  const menu = document.querySelector(${JSON.stringify(MENU)});
  const details = menu ? menu.closest("details") : null;
  return {
    open: details ? details.open === true : false,
    focusOnMenu: document.activeElement === menu,
    created: window.__posted.some((message) => message && message.type === "conversation.create"),
  };
})()`;

const run = async () => {
  if (!existsSync(bundle)) {
    throw new Error(`${bundle} does not exist; run npm run build before the layout gate`);
  }
  const profile = mkdtempSync(path.join(tmpdir(), "bachata-layout-"));
  let session;
  const failures = [];
  const rows = [];
  const executionRows = [];
  try {
    session = await connect(profile);
    const readyUntil = Date.now() + 20_000;
    while (!await session.evaluate('document.readyState === "complete" && document.querySelectorAll(".run-tab").length >= 2')) {
      if (Date.now() >= readyUntil) throw new Error("The run tab fixture did not become ready within 20 seconds");
      await delay(100);
    }
    await session.evaluate("document.fonts.ready.then(() => true)");
    for (const width of WIDTHS) {
      await session.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await delay(300);
      const layout = await session.evaluate(measure);
      if (!layout.present) {
        failures.push(`${String(width)}px: the run tab strip did not render`);
        continue;
      }
      const reach = await session.evaluate(reachability);
      // A fixture that trips the webview's render-failure boundary would satisfy every hit-region
      // check by drawing a banner instead of a room, so the run is refused rather than reported.
      if (reach.renderFailure) failures.push(`${String(width)}px: the fixture rendered the failure banner, not a room`);
      if (reach.tabs < 2) failures.push(`${String(width)}px: the fixture drew ${String(reach.tabs)} run tabs, so no unselected tab was measured`);
      reach.mismatched.forEach((problem) => { failures.push(`${String(width)}px: ${problem}`); });
      const composer = await session.evaluate(composerMeasure);
      if (!composer.present) {
        failures.push(`${String(width)}px: the composer toolbar did not render`);
      } else {
        if (composer.nativeSelect) failures.push(`${String(width)}px: the native pipeline select is still in the composer`);
        if (!composer.sendVisible) failures.push(`${String(width)}px: Send was drawn at zero size`);
        if (!composer.sendRightOfPicker) failures.push(`${String(width)}px: Send is not aligned to the end of the toolbar`);
        if (composer.horizontalScroll) failures.push(`${String(width)}px: the composer forced the page to scroll horizontally`);
        if (!composer.sendOnFirstRow) failures.push(`${String(width)}px: the composer controls do not share one row`);
        if (!composer.surfaceContainsInput) failures.push(`${String(width)}px: input and toolbar escape their shared surface`);
        if (!composer.sendSquare) failures.push(`${String(width)}px: the Send control is not circular`);
        const [left, top, gearWidth, gearHeight] = composer.settingsBox;
        await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: left + gearWidth / 2, y: top + gearHeight / 2 });
        await delay(160);
        const hovered = await session.evaluate(composerMeasure);
        if (!hovered.present || hovered.settingsBox.some((value, index) => Math.abs(value - composer.settingsBox[index]) > 0.5)) {
          failures.push(`${String(width)}px: the settings control moves on hover`);
        }
      }
      // The pipeline picker opens above the toolbar and must clear it without being clipped.
      await press(session, "#pipeline-picker-button");
      await delay(160);
      const picker = await session.evaluate(pickerMeasure);
      if (!picker.present) {
        failures.push(`${String(width)}px: the pipeline picker did not open above the toolbar`);
      } else {
        if (!picker.aboveToolbar) failures.push(`${String(width)}px: the pipeline listbox overlapped the toolbar instead of opening above it`);
        if (!picker.topVisible || !picker.withinViewport || !picker.visibleAtTop) failures.push(`${String(width)}px: the pipeline listbox was clipped by the viewport or a scroll container`);
      }
      if (picker.present) await pressKey(session, "Escape", "Escape", 27);
      await delay(120);
      // The Agents popover: same toolbar, same anchoring rules, more content.
      if (!composer.present || !composer.agentsPresent) {
        failures.push(`${String(width)}px: the Agents control is not on the composer toolbar`);
      } else {
        const [agentsLeft, agentsTop, agentsWidth, agentsHeight] = composer.agentsBox;
        await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: agentsLeft + agentsWidth / 2, y: agentsTop + agentsHeight / 2 });
        await delay(160);
        const hoveredAgents = await session.evaluate(composerMeasure);
        if (!hoveredAgents.present || hoveredAgents.agentsBox === null || hoveredAgents.agentsBox.some((value, index) => Math.abs(value - composer.agentsBox[index]) > 0.5)) {
          failures.push(`${String(width)}px: the Agents control moves on hover`);
        }
        await press(session, "#agents-picker-button");
        await delay(200);
        const agents = await session.evaluate(agentsMeasure);
        if (!agents.present) {
          failures.push(`${String(width)}px: the Agents popover did not open above the toolbar`);
        } else {
          if (!agents.aboveToolbar) failures.push(`${String(width)}px: the Agents popover overlapped the toolbar instead of opening above it`);
          if (!agents.topVisible || !agents.withinViewport || !agents.visibleAtTop) failures.push(`${String(width)}px: the Agents popover was clipped by the viewport or a scroll container`);
          if (!agents.scrollsInside) failures.push(`${String(width)}px: the Agents popover overflows without scrolling inside itself`);
          if (agents.horizontalScroll) failures.push(`${String(width)}px: the Agents popover forced the page to scroll horizontally`);
          if (agents.slotCount < 3) failures.push(`${String(width)}px: the Agents popover drew ${String(agents.slotCount)} responsibilities, so a multi-role pipeline was not measured`);
          if (!agents.slotsContained || !agents.choicesContained) failures.push(`${String(width)}px: an assignment row escaped the Agents popover`);
          if (!agents.rovingTabStops) failures.push(`${String(width)}px: a provider radiogroup is not a single tab stop`);
          if (agents.sessionsListed < 2) failures.push(`${String(width)}px: the browser conversations were not offered inside the Agents popover`);
          // Escape closes it and hands focus back to the control that opened it.
          await pressKey(session, "Escape", "Escape", 27);
          await delay(160);
          const dismissedAgents = await session.evaluate(agentsDismissed);
          if (dismissedAgents.open) failures.push(`${String(width)}px: Escape did not close the Agents popover`);
          if (!dismissedAgents.focusReturned) failures.push(`${String(width)}px: Escape did not return focus to the Agents control`);
        }
      }
      await delay(120);
      await session.evaluate("window.__posted.length = 0");
      await press(session, MENU);
      const opened = await session.evaluate(menuState);
      // Escape closes the menu and gives focus back to the control that opened it, so a keyboard
      // reader is never left inside a panel that is no longer there.
      let dismissed = { open: true, focusOnMenu: false };
      if (opened.open) {
        await pressKey(session, "Escape", "Escape", 27);
        dismissed = await session.evaluate(menuState);
        if (dismissed.open) {
          await press(session, MENU);
          dismissed = await session.evaluate(menuState);
        }
      }
      const focusable = await session.evaluate(`(() => {
        const menu = document.querySelector(${JSON.stringify(MENU)});
        menu.focus();
        return document.activeElement === menu;
      })()`);
      const row = { ...layout, opened: opened.open, created: opened.created, dismissed: !dismissed.open, focusRestored: dismissed.focusOnMenu, focusable };
      rows.push(row);
      if (row.overlap) failures.push(`${String(width)}px: New run ${JSON.stringify(row.createBox)} overlaps the action menu ${JSON.stringify(row.menuBox)}`);
      if (!row.menuHit) failures.push(`${String(width)}px: the action menu is not what a pointer meets at its own centre`);
      if (!row.createHit) failures.push(`${String(width)}px: New run is not what a pointer meets at its own centre`);
      if (!row.menuVisible || !row.createVisible) failures.push(`${String(width)}px: a control was drawn at zero size`);
      if (row.horizontalScroll) failures.push(`${String(width)}px: the strip forced the page to scroll horizontally`);
      if (!row.opened) failures.push(`${String(width)}px: pressing the action menu did not open it`);
      if (row.created) failures.push(`${String(width)}px: pressing the action menu created a run`);
      if (!row.dismissed) failures.push(`${String(width)}px: the action menu did not close`);
      if (!row.focusRestored) failures.push(`${String(width)}px: closing the action menu did not return focus to it`);
      if (!row.focusable) failures.push(`${String(width)}px: the action menu does not take keyboard focus`);
    }
    await runWebviewProductChecks(session, press, pressKey, WIDTHS);
    await runMinimalLayoutChecks(session, press, pressKey);
    await runTabStressChecks(session, press, pressKey);
    // The execution view: booted once, then measured at every width. It replaces the fixture's
    // idle state, so it runs after every idle-state measurement is done.
    await session.evaluate("window.__bootExecution()");
    await delay(200);
    await press(session, '[data-action="room-view"][data-view="execution"]');
    await delay(200);
    for (const width of WIDTHS) {
      await session.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await delay(250);
      const execution = await session.evaluate(executionMeasure);
      if (!execution.present) {
        failures.push(
          `${String(width)}px: the stopped run's execution view did not render ` +
          `(summary=${String(execution.summary)} rows=${String(execution.rows)} restart=${String(execution.restart)} retry=${String(execution.retry)})`,
        );
        continue;
      }
      if (execution.rows !== 4) failures.push(`${String(width)}px: the pipeline summary drew ${String(execution.rows)} step rows, not one per enabled step`);
      if (!execution.rowsContained) failures.push(`${String(width)}px: a pipeline step row escaped the summary card`);
      if (!execution.summaryWithinViewport) failures.push(`${String(width)}px: the pipeline summary escaped the viewport`);
      if (execution.disclosureCount < 2) failures.push(`${String(width)}px: background and provenance are not behind information disclosures`);
      if (!execution.disclosuresClosed) failures.push(`${String(width)}px: an information disclosure is drawn open`);
      if (!execution.moreHit || !execution.retryHit) failures.push(`${String(width)}px: a recovery action is not what a pointer meets at its own centre`);
      if (!execution.actionsSized) failures.push(`${String(width)}px: a recovery action was drawn too small to press`);
      if (!execution.actionsWithinViewport) failures.push(`${String(width)}px: a recovery action escaped the viewport`);
      if (!execution.moreFocusable || !execution.retryFocusable) failures.push(`${String(width)}px: a recovery action does not take keyboard focus`);
      if (!execution.failureStated) failures.push(`${String(width)}px: the failure that stopped the run is not stated in the result`);
      if (execution.horizontalScroll) failures.push(`${String(width)}px: the execution view forced the page to scroll horizontally`);
      await press(session, '.result-center > header .header-action-menu > summary');
      await session.evaluate("window.__posted = []");
      await press(session, '.result-center [data-action="workflow-restart"]');
      await delay(100);
      const restarts = await session.evaluate("window.__posted.filter(message => message.message?.type === 'workflow.restart').length");
      if (restarts !== 1) failures.push(`${String(width)}px: Restart from More did not dispatch exactly once`);

      executionRows.push(execution);
    }
  } finally {
    // Cleanup runs whether the browser started, attached, measured or threw. A gate that leaves a
    // browser or a profile behind is a gate that degrades the next run.
    //
    // The two halves are independent on purpose. Stopping the browser can itself fail, and when it
    // did the profile directory was never removed — one unstoppable Chrome left a profile behind on
    // every subsequent run. So the profile is removed either way, and a browser that would not stop
    // is reported as a failure of this gate rather than thrown from here, where it would replace
    // whatever the measurement had already found.
    let stranded;
    try {
      await closeCdpSession(session);
    } catch (error) {
      stranded = error instanceof Error ? error.message : String(error);
    }
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      console.warn(`Left the temporary Chrome profile behind: ${profile}`);
    }
    if (stranded) {
      console.error(stranded);
      failures.push(stranded);
      process.exitCode = 1;
    }
  }
  rows.forEach((row) => {
    console.log(
      `${String(row.width).padStart(4)}px menu=${JSON.stringify(row.menuBox)} new=${JSON.stringify(row.createBox)} overlap=${String(row.overlap)} hits=${String(row.menuHit && row.createHit)} opens=${String(row.opened)} createdRun=${String(row.created)} closes=${String(row.dismissed)} focusBack=${String(row.focusRestored)} focusable=${String(row.focusable)}`,
    );
  });
  executionRows.forEach((row) => {
    console.log(
      `${String(row.width).padStart(4)}px execution steps=${String(row.rows)} contained=${String(row.rowsContained)} disclosures=${String(row.disclosureCount)} closed=${String(row.disclosuresClosed)} more=${String(row.moreHit)} retry=${String(row.retryHit)} failureStated=${String(row.failureStated)} hScroll=${String(row.horizontalScroll)}`,
    );
  });
  if (executionRows.length !== WIDTHS.length) {
    failures.push(`only ${String(executionRows.length)} of ${String(WIDTHS.length)} widths were measured in the execution view`);
  }
  if (rows.length !== WIDTHS.length) {
    failures.push(`only ${String(rows.length)} of ${String(WIDTHS.length)} widths were measured`);
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Run tab strip and stopped-run execution view verified at ${WIDTHS.map((width) => `${String(width)}px`).join(", ")}.`);
};

await run();
