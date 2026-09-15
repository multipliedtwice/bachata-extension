const themeColors = require("../../fixtures/webview-layout/theme-colors.json");

const interactionThemes = ["light", "dark", "high-contrast", "forced-colors"];
const interactionWidths = [320, 400, 792, 1280];
const protocol = (command, params) => Cypress.automation("remote:debugger:protocol", { command, params });

const applyInteractionTheme = (win, theme) => {
  const palette = themeColors[theme === "light" ? "light" : "dark"];
  for (const [key, value] of Object.entries(palette)) {
    win.document.documentElement.style.setProperty(`--vscode-${key.replaceAll(".", "-")}`, value);
  }
  win.document.documentElement.style.setProperty("--vscode-notificationsWarningIcon-foreground", theme === "light" ? "#895503" : "#cca700");
  win.document.body.className = theme === "high-contrast" ? "vscode-high-contrast" : theme === "light" ? "vscode-light" : "vscode-dark";
  if (theme === "high-contrast") {
    for (const [key, value] of Object.entries({
      foreground: "CanvasText", "editor-background": "Canvas", "editor-foreground": "CanvasText",
      "input-background": "Canvas", "input-foreground": "CanvasText", "input-border": "CanvasText",
      "button-secondaryBackground": "Canvas", "button-secondaryForeground": "CanvasText",
      descriptionForeground: "CanvasText", focusBorder: "Highlight", contrastBorder: "CanvasText",
    })) win.document.documentElement.style.setProperty(`--vscode-${key}`, value);
  }
};

const emulateInteractionTheme = (theme) => cy.then(() => protocol("Emulation.setEmulatedMedia", {
  features: [
    { name: "prefers-color-scheme", value: theme === "light" ? "light" : "dark" },
    { name: "forced-colors", value: theme === "forced-colors" ? "active" : "none" },
  ],
}));

const interactionKey = (key, code, keyCode, shift = false) => cy.then(async () => {
  const params = { key, code, windowsVirtualKeyCode: keyCode, modifiers: shift ? 8 : 0 };
  await protocol("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...(key === "Enter" ? { text: "\r" } : {}) });
  await protocol("Input.dispatchKeyEvent", { type: "keyUp", ...params });
});

const pointerAt = (selector, type = "mouseMoved") => cy.get(selector).should("be.visible").then(($control) => {
  $control[0].scrollIntoView({ block: "nearest", inline: "nearest" });
  const rect = $control[0].getBoundingClientRect();
  return protocol("Input.dispatchMouseEvent", {
    type, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2,
    ...(type === "mouseMoved" ? { buttons: 0 } : { button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }),
  });
});

const pointerClick = (selector) => {
  pointerAt(selector);
  pointerAt(selector, "mousePressed");
  return pointerAt(selector, "mouseReleased");
};

const releasePointerAway = (selector) => cy.get(selector).then(async ($control) => {
  const control = $control[0];
  const refuge = control.closest("details[open]")?.querySelector("summary") ?? control.closest('[role="dialog"]')?.querySelector("h1, h2, h3");
  const rect = refuge?.getBoundingClientRect();
  const point = rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : { x: 0, y: 0 };
  await protocol("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, buttons: 1 });
  await protocol("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", buttons: 0, clickCount: 1 });
});

const tabToControl = (selector, remaining = 100) => cy.document().then((doc) => {
  if (doc.activeElement?.matches(selector) && doc.querySelector("#root").dataset.focusInput === "keyboard") return;
  expect(remaining, `Tab reaches ${selector}`).to.be.greaterThan(0);
  interactionKey("Tab", "Tab", 9);
  return tabToControl(selector, remaining - 1);
});

const controlVisual = (element) => {
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    background: style.backgroundColor, color: style.color, outline: style.outlineStyle,
    outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, shadow: style.boxShadow,
    transform: style.transform, padding: style.padding, radius: style.borderRadius,
    borderWidths: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
  };
};

const resolvedCssColor = (doc, value, property = "backgroundColor") => {
  const probe = doc.createElement("span");
  probe.style.position = "fixed";
  probe.style.visibility = "hidden";
  probe.style.forcedColorAdjust = "none";
  probe.style[property] = value;
  doc.body.append(probe);
  const resolved = doc.defaultView.getComputedStyle(probe)[property];
  probe.remove();
  return resolved;
};

const resolvedControlColor = (doc, token, property = "backgroundColor") => resolvedCssColor(doc, `var(${token})`, property);

const expectControlFill = (selector, state) => cy.get(selector).should(($control) => {
  for (const control of $control) {
    expect(control.matches(".primary, .send-button, .danger, .caution, input, select, textarea"), `${selector}: neutral family only`).to.equal(false);
    expect(controlVisual(control).background, `${selector}: ${state}`).to.equal(resolvedControlColor(control.ownerDocument, `--bachata-control-${state}`));
  }
});

const expectPrimaryColors = (selector, state) => cy.get(selector).should(($control) => {
  for (const control of $control) {
    expect(control.matches("button.primary, button.send-button"), `${selector}: primary family`).to.equal(true);
    const doc = control.ownerDocument;
    const forced = doc.defaultView.matchMedia("(forced-colors: active)").matches;
    const backgrounds = forced ? {
      rest: "ButtonFace", hover: "Highlight", pressed: "color-mix(in srgb, Highlight 80%, ButtonFace)",
    } : {
      rest: "var(--vscode-button-background)",
      hover: "var(--vscode-button-hoverBackground, var(--vscode-button-background))",
      pressed: "color-mix(in srgb, var(--vscode-button-hoverBackground, var(--vscode-button-background)) 80%, var(--vscode-button-background))",
    };
    const foreground = forced ? state === "rest" ? "ButtonText" : "HighlightText" : "var(--vscode-button-foreground)";
    const visual = controlVisual(control);
    expect(visual.background, `${selector}: primary ${state}`).to.equal(resolvedCssColor(doc, backgrounds[state === "selected" ? "pressed" : state]));
    expect(visual.color, `${selector}: primary foreground`).to.equal(resolvedCssColor(doc, foreground, "color"));
    if (state !== "rest") expect(visual.background, `${selector}: distinct from neutral`).not.to.equal(resolvedControlColor(doc, `--bachata-control-${state}`));
  }
});

const expectSemanticColors = (selector, family, state) => cy.get(selector).should(($control) => {
  for (const control of $control) {
    expect(["danger", "caution"]).to.include(family);
    expect(control.matches(`button.${family}`), `${selector}: semantic family`).to.equal(true);
    const doc = control.ownerDocument;
    const forced = doc.defaultView.matchMedia("(forced-colors: active)").matches;
    const foreground = forced ? state === "selected" ? "HighlightText" : state === "rest" ? "ButtonText" : "CanvasText" : `var(${family === "danger" ? "--bachata-danger" : "--bachata-warn-text"})`;
    expect(controlVisual(control).color, `${selector}: ${family} foreground`).to.equal(resolvedCssColor(doc, foreground, "color"));
    if (!forced) expect(controlVisual(control).color).not.to.equal(resolvedControlColor(doc, "--vscode-foreground", "color"));
    if (state !== "rest") expect(controlVisual(control).background).to.equal(resolvedControlColor(doc, `--bachata-control-${state}`));
  }
});

const expectKeyboardRing = (selector) => cy.get(selector).should(($control) => {
  const control = $control[0];
  const visual = controlVisual(control);
  expect(control.ownerDocument.activeElement).to.equal(control);
  expect(control.matches(":focus-visible")).to.equal(true);
  expect(visual.outline).to.equal("solid");
  expect(visual.outlineWidth).to.equal("2px");
  expect(visual.outlineColor).to.equal(resolvedControlColor(control.ownerDocument, "--bachata-focus-ring", "color"));
  expect(visual.shadow).not.to.contain("inset");
});

const expectPointerFocus = (selector) => cy.get(selector).should(($control) => {
  const visual = controlVisual($control[0]);
  expect(visual.outline).to.equal("none");
  expect(visual.shadow).not.to.contain("inset");
});

const expectSquareIcon = (element) => {
  const visual = controlVisual(element);
  expect(element.classList.contains("icon-button")).to.equal(true);
  expect(element.getAttribute("aria-label")).to.be.a("string").and.not.to.equal("");
  expect(visual.width).to.equal(32);
  expect(visual.height).to.equal(32);
  expect(visual.radius).to.equal("6px");
  expect(visual.padding).to.equal("0px");
};

const expectStationary = (before, after) => {
  for (const key of ["x", "y", "width", "height"]) expect(after[key], key).to.be.closeTo(before[key], 0.1);
  expect(after.borderWidths).to.deep.equal(before.borderWidths);
  expect(after.transform).to.equal(before.transform);
};

const expectActionResponse = (selector, expectColors) => {
  let before;
  cy.get(selector).should("be.visible").then(($control) => {
    $control[0].scrollIntoView({ block: "nearest", inline: "nearest" });
    before = controlVisual($control[0]);
  });
  cy.then(() => protocol("Input.dispatchMouseEvent", { type: "mouseMoved", x: 0, y: 0, buttons: 0 }));
  expectColors("rest");
  pointerAt(selector);
  expectColors("hover");
  pointerAt(selector, "mousePressed");
  expectColors("pressed");
  cy.get(selector).should(($control) => expectStationary(before, controlVisual($control[0])));
  releasePointerAway(selector);
  expectPointerFocus(selector);
  interactionKey("Tab", "Tab", 9, true);
  tabToControl(selector);
  expectKeyboardRing(selector);
  expectColors("rest");
};

const expectPrimaryResponse = (selector) => expectActionResponse(selector, (state) => expectPrimaryColors(selector, state));
const expectSemanticResponse = (selector, family) => expectActionResponse(selector, (state) => expectSemanticColors(selector, family, state));

const expectFieldResponse = (selector, focusSurfaceSelector = selector) => {
  let before;
  let value;
  cy.get(selector).should("be.visible").then(($control) => {
    const control = $control[0];
    expect(control.matches('input:not([type="checkbox"]):not([type="radio"]), textarea, select')).to.equal(true);
    control.scrollIntoView({ block: "nearest", inline: "nearest" });
    before = controlVisual(control);
    value = control.value;
  });
  const expectSurface = (stationary = true) => cy.get(selector).should(($control) => {
    const after = controlVisual($control[0]);
    expect(after.background, `${selector}: field background`).to.equal(before.background);
    expect(after.color, `${selector}: field foreground`).to.equal(before.color);
    expect(after.shadow).to.equal(before.shadow);
    expect($control[0].value).to.equal(value);
    if (stationary) expectStationary(before, after);
    else {
      for (const key of ["width", "height", "borderWidths", "transform"]) expect(after[key], key).to.deep.equal(before[key]);
    }
  });
  pointerAt(selector);
  expectSurface();
  pointerAt(selector, "mousePressed");
  expectSurface();
  pointerAt(selector, "mouseReleased");
  expectPointerFocus(selector);
  cy.get(selector).then(($control) => { if ($control[0].matches("select")) interactionKey("Escape", "Escape", 27); });
  interactionKey("Tab", "Tab", 9, true);
  tabToControl(selector);
  if (focusSurfaceSelector === selector) expectKeyboardRing(selector);
  else {
    cy.get(selector).should(($control) => {
      const control = $control[0];
      expect(control.ownerDocument.activeElement).to.equal(control);
      expect(control.matches(":focus-visible")).to.equal(true);
      expect(controlVisual(control).outline).to.equal("none");
    });
    cy.get(focusSurfaceSelector).should(($surface) => {
      const surface = controlVisual($surface[0]);
      expect(surface.outline).to.equal("solid");
      expect(surface.outlineWidth).to.equal("2px");
      expect(surface.outlineColor).to.equal(resolvedControlColor($surface[0].ownerDocument, "--bachata-focus-ring", "color"));
      expect(surface.shadow).not.to.contain("inset");
    });
  }
  expectSurface(false);
};

module.exports = {
  interactionThemes, interactionWidths, applyInteractionTheme, emulateInteractionTheme,
  interactionKey, pointerAt, pointerClick, tabToControl, controlVisual,
  expectControlFill, expectKeyboardRing, expectPointerFocus, expectSquareIcon, expectStationary, resolvedControlColor,
  expectPrimaryColors, expectPrimaryResponse, expectSemanticColors, expectSemanticResponse, expectFieldResponse, releasePointerAway,
};
