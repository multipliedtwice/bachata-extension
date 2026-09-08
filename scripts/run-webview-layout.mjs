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
const WIDTHS = [320, 360, 400, 480, 1280];

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
const press = async (session, selector) => {
  const first = await session.evaluate(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  );
  if (!first) throw new Error(`No element for ${selector}`);
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
    await session.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode });
  }
  await delay(160);
};

const waitForState = async (session, expression) => {
  const deadline = Date.now() + 5_000;
  while (!await session.evaluate(expression)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
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

/**
 * EX-UI-02's invariant, measured rather than read: a control that is drawn must be reachable by
 * keyboard, and a control that is not drawn must not be. Every run keeps its action menu
 * visible and keyboard reachable, including on devices without hover support.
 *
 * The fixture carries two runs so this branch actually renders; with one run there is no
 * unselected tab and the assertion would pass by never being exercised.
 */
const reachability = `(() => {
  const tabs = Array.from(document.querySelectorAll(".run-tab"));
  return {
    tabs: tabs.length,
    renderFailure: document.querySelector(".render-failure") !== null,
    mismatched: tabs.map((tab) => {
      const summary = tab.querySelector(".run-action-menu > summary");
      if (!summary) return "a run tab has no action menu";
      const box = summary.getBoundingClientRect();
      const drawn = Number(getComputedStyle(summary).opacity) > 0 && box.width > 0 && box.height > 0;
      const reachable = summary.tabIndex >= 0;
      if (drawn === reachable) return null;
      // Concatenated, not interpolated: this whole function is itself a template literal handed to
      // the browser, and a nested backtick would end it here rather than inside the page.
      return (tab.classList.contains("selected") ? "the selected" : "an unselected") +
        " run's action menu is " +
        (drawn ? "drawn but not keyboard reachable" : "keyboard reachable but not drawn");
    }).filter((entry) => entry !== null),
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
      await press(session, '[data-action="composer-options-toggle"]');
      const advancedOptionsOpen = await waitForState(session, 'document.querySelector("#pipeline-iterations") !== null');
      if (!advancedOptionsOpen) failures.push(`${String(width)}px: advanced options did not open before the menu interaction`);
      await session.evaluate("window.__posted.length = 0");
      await press(session, MENU);
      const opened = await session.evaluate(menuState);
      const advancedOptionsClosed = await waitForState(session, 'document.querySelector("#pipeline-iterations") === null');
      if (!advancedOptionsClosed) failures.push(`${String(width)}px: pressing the action menu left advanced options open`);
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
  if (rows.length !== WIDTHS.length) {
    failures.push(`only ${String(rows.length)} of ${String(WIDTHS.length)} widths were measured`);
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`Run tab strip hit regions verified at ${WIDTHS.map((width) => `${String(width)}px`).join(", ")}.`);
};

await run();
