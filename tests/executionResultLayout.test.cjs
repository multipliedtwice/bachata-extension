const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const css = readFileSync(path.join(__dirname, "../src/webview-ui/style.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//gu, "");

const splitSelectors = (text) => {
  const selectors = [];
  let depth = 0;
  let start = 0;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "(" || character === "[") depth += 1;
    else if (character === ")" || character === "]") depth -= 1;
    else if (character === "," && depth === 0) {
      selectors.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  selectors.push(text.slice(start).trim());
  return selectors;
};

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
  selectors: splitSelectors(match[1]),
  body: match[2],
}));

const declarationsFor = (selector, sourceRules = rules) => {
  const matching = sourceRules.filter((rule) => rule.selectors.includes(selector));
  assert.ok(matching.length > 0, `Missing selector: ${selector}`);
  return Object.fromEntries(matching.flatMap((rule) =>
    [...rule.body.matchAll(/([a-z-]+)\s*:\s*([^;]+);/gu)].map((match) =>
      [match[1], match[2].trim()])));
};

test("Execution result and Pipeline use document surfaces instead of nested cards", () => {
  for (const selector of [
    ".execution-content .result-center",
    ".execution-content .pipeline-summary",
    ".execution-content .final-ruling-card",
    ".execution-content .ruling-result",
    ".execution-content .ruling-list:not(.risks) > li",
    ".execution-content .result-finding-list > li",
    ".execution-content .compare-column",
    ".execution-content .pipeline-step",
  ]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations.border, "0", selector);
    assert.equal(declarations["border-radius"], "0", selector);
    assert.equal(declarations.background, "transparent", selector);
  }
  for (const selector of [
    ".execution-content .result-finding-list > li + li",
    ".execution-content .ruling-list:not(.risks) > li + li",
    ".execution-content .pipeline-step + .pipeline-step",
  ]) {
    assert.match(declarationsFor(selector)["border-top"], /^1px solid var\(/u, selector);
  }
});

test("Execution failure and unresolved groups retain semantic boundaries without repeating response rails", () => {
  for (const selector of [
    ".execution-content .result-failure",
    ".execution-content .pipeline-step-failed",
  ]) {
    assert.match(declarationsFor(selector)["border-inline-start"], /3px solid var\(--vscode-inputValidation-errorBorder/u, selector);
  }
  for (const selector of [
    ".execution-content .result-findings-unresolved",
    ".execution-content .final-ruling-unresolved",
    ".execution-content .pipeline-step-interrupted",
    ".execution-content .result-gaps:not(.evidence-ledger)",
    ".execution-content .result-gaps.result-evidence-missing",
  ]) {
    assert.match(declarationsFor(selector)["border-inline-start"], /3px solid var\(--vscode-inputValidation-warningBorder/u, selector);
  }
  assert.match(declarationsFor(".result-gaps").border, /warningBorder/u);
  assert.equal(declarationsFor(".execution-content .pipeline-step-message-error .pipeline-step-message-heading small").color, "var(--bachata-danger)");
  assert.equal(declarationsFor(".execution-content .pipeline-step-message-interrupted .pipeline-step-message-heading small").color, "var(--bachata-warn-text)");
});

test("Execution finding and response rows have no individual semantic rails or shifted gutters", () => {
  for (const selector of [
    ".execution-content .result-finding-list > .finding-accepted",
    ".execution-content .result-finding-list > .finding-unresolved",
    ".execution-content .pipeline-step-activity > .pipeline-step-message-error",
    ".execution-content .pipeline-step-activity > .pipeline-step-message-interrupted",
  ]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations["border-inline-start"], "0", selector);
    assert.equal(declarations["padding-inline-start"], "0", selector);
  }
  for (const selector of [
    ".execution-content .human-resolution",
    ".execution-content .ruling-disposition",
    ".execution-content .evidence-state",
    ".execution-content .result-gaps.evidence-ledger",
  ]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations.border, "0", selector);
    assert.equal(declarations.padding, "0", selector);
    assert.equal(declarations.background, "transparent", selector);
  }
});

test("Execution focus outlines survive document styling and code container clipping", () => {
  for (const selector of [
    ".execution-content .pipeline-step-message-body:focus-visible",
    ".execution-content summary:focus-visible",
    ".execution-content pre:focus-visible",
    ".execution-content button:focus-visible",
  ]) {
    const declarations = declarationsFor(":focus-visible");
    assert.equal(declarations.outline, "2px solid var(--bachata-focus-ring)", selector);
    assert.equal(declarations["outline-offset"], "var(--bachata-focus-offset, 2px)", selector);
    for (const rule of rules.filter((entry) => entry.selectors.includes(selector))) {
      assert.doesNotMatch(rule.body, /outline\s*:\s*(?:none|0)/u, selector);
    }
  }
  assert.equal(declarationsFor(".execution-content .code-block pre")["--bachata-focus-offset"], "-2px");
});

test("Execution result actions and visible refusal reasons wrap without width floors", () => {
  const actions = declarationsFor(".execution-content .result-primary-actions");
  assert.equal(actions["flex-wrap"], "wrap");
  assert.equal(actions["min-width"], "0");
  for (const selector of [
    ".execution-content .result-primary-actions > button",
    ".execution-content .result-continuation-action > button",
    ".execution-content .result-continuation-controls > button",
  ]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations["max-width"], "100%", selector);
    assert.equal(declarations["min-width"], "0", selector);
    assert.equal(declarations["white-space"], "normal", selector);
    assert.equal(declarations["overflow-wrap"], "anywhere", selector);
  }
  assert.equal(declarationsFor(".execution-content .result-continuation-reason")["overflow-wrap"], "anywhere");
});

test("workflow resume is a subdued inline timeline marker", () => {
  const marker = declarationsFor(".workflow-transition");
  assert.equal(marker.display, "flex");
  assert.equal(marker["align-items"], "center");
  assert.equal(marker.width, "min(100%, 80ch)");
  assert.equal(marker.margin, "8px auto");
  assert.equal(marker["font-size"], "var(--bachata-font-xs)");
  assert.equal(marker.opacity, "0.7");
  assert.equal(declarationsFor(".workflow-transition::before").height, "1px");
});

test("Execution narrow layout stacks pipeline metadata and implementation guidance", () => {
  const narrow = /@media \(max-width: 480px\) \{\s*\.execution-content \.pipeline-step-summary,[\s\S]*?\.execution-content \.result-continuation-action\s*\{\s*flex-basis: 100%;\s*\}\s*\}/u.exec(css)?.[0];
  assert.ok(narrow, "Missing narrow Execution layout");
  const narrowRules = [...narrow.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
    selectors: splitSelectors(match[1]),
    body: match[2],
  }));
  assert.equal(declarationsFor(".execution-content .pipeline-step > details > summary", narrowRules)["grid-template-columns"], "18px 20px minmax(0, 1fr)");
  for (const selector of [
    ".execution-content .pipeline-step-state",
    ".execution-content .pipeline-step-count",
    ".execution-content .pipeline-step-timing",
  ]) {
    assert.equal(declarationsFor(selector, narrowRules)["grid-column"], "3", selector);
  }
  assert.equal(declarationsFor(".execution-content .pipeline-step-state", narrowRules)["grid-row"], "3");
  assert.equal(declarationsFor(".execution-content .pipeline-step-state", narrowRules)["justify-self"], "start");
  assert.equal(declarationsFor(".execution-content .pipeline-step-timing", narrowRules)["grid-row"], "4");
  assert.equal(declarationsFor(".pipeline-step-message-heading", narrowRules)["flex-direction"], "column");
  assert.equal(declarationsFor(".execution-content .pipeline-step-body", narrowRules)["padding-inline-start"], "0");
  assert.equal(declarationsFor(".execution-content .result-continuation-action", narrowRules)["flex-basis"], "100%");
});

test("Execution pipeline titles and generated disclosure markers have explicit independent grid cells", () => {
  const desktop = rules.filter((rule) => !rule.body.includes("grid-template-columns: 18px 20px minmax(0, 1fr);"));
  assert.equal(declarationsFor(".execution-content .pipeline-step > details > summary", desktop)["grid-template-columns"], "18px 20px minmax(0, 1fr) auto");
  for (const [selector, column] of [
    [".execution-content .pipeline-step > details > summary::before", "1"],
    [".execution-content .pipeline-step-position", "2"],
    [".execution-content .pipeline-step-name", "3"],
  ]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations["grid-column"], column, selector);
    assert.equal(declarations["grid-row"], "1", selector);
  }
  assert.equal(declarationsFor(".execution-content .pipeline-step-count")["grid-row"], "2");
  assert.equal(declarationsFor(".execution-content .pipeline-step-name")["min-width"], "0");
  assert.equal(declarationsFor(".execution-content .pipeline-step-name")["overflow-wrap"], "anywhere");
});

test("Execution finding selection and pipeline choice wrap within one readable report", () => {
  const toggle = declarationsFor(".execution-content .result-finding-toggle");
  assert.equal(toggle["grid-template-columns"], "18px minmax(0, 1fr)");
  assert.equal(toggle["min-height"], "36px");
  assert.equal(toggle["min-width"], "0");
  const checkbox = declarationsFor(".execution-content .result-finding-toggle > input");
  assert.equal(checkbox.width, "18px");
  assert.equal(checkbox.height, "18px");
  const controls = declarationsFor(".execution-content .result-continuation-controls");
  assert.equal(controls["flex-wrap"], "wrap");
  assert.equal(controls["min-width"], "0");
  assert.equal(controls.width, "100%");
  assert.equal(declarationsFor(".execution-content .result-pipeline-select")["min-width"], "0");
  assert.equal(declarationsFor(".execution-content .result-pipeline-select > select").width, "100%");
  assert.equal(declarationsFor(".execution-content .compare-grid")["grid-template-columns"], "minmax(0, 1fr)");
});

test("Long participant output and nested code remain bounded and scrollable in both axes", () => {
  for (const selector of [
    ".pipeline-step-message-body",
    '.execution-content .code-block pre[class*="language-"]',
  ]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations.overflow, "auto", selector);
    assert.equal(declarations["min-width"], "0", selector);
    assert.equal(declarations["max-width"], "100%", selector);
    assert.match(declarations["max-height"], /^min\(\d+vh, \d+px\)$/u, selector);
    assert.equal(declarations["scrollbar-gutter"], "stable", selector);
  }
});

test("Execution continuation occupies its own bottom row without covering the report", () => {
  assert.equal(declarationsFor(".conversation-column")["grid-template-rows"], "minmax(0, 1fr) auto");
  assert.equal(declarationsFor(".conversation-viewport")["min-height"], "0");
  const footer = declarationsFor(".execution-result-footer");
  assert.equal(footer["grid-row"], "2");
  assert.equal(footer.position, undefined);
  assert.equal(footer["min-width"], "0");
  assert.equal(footer["min-height"], "0");
  assert.equal(footer["max-height"], "min(50cqh, 24rem)");
  assert.equal(footer["overflow-y"], "auto");
  assert.equal(footer["overflow-x"], "hidden");
  assert.equal(footer["scrollbar-width"], declarationsFor(".conversation-scroll")["scrollbar-width"]);
  assert.equal(footer["scrollbar-gutter"], "stable");
  assert.equal(declarationsFor(".execution-content")["scrollbar-gutter"], "stable");
  assert.equal(footer["overscroll-behavior"], "contain");
  assert.equal(footer.padding, "12px var(--bachata-gutter)");
  assert.equal(footer.border, "0");
  assert.equal(footer["border-top"], "1px solid var(--bachata-border)");
  assert.equal(footer["border-radius"], "0");
  assert.equal(footer.background, "var(--vscode-editor-background)");
  const content = declarationsFor(".execution-result-footer > .result-continuation-action");
  assert.equal(content["grid-template-columns"], "minmax(0, 1fr)");
  assert.equal(content["max-width"], "var(--bachata-content-max)");
  assert.equal(content["margin-inline"], "auto");
  assert.equal(content["min-width"], "0");
});

test("Review details fills the room below the tabs and keeps the report independently scrollable", () => {
  assert.equal(declarationsFor(".conversation-column").position, "relative");
  const overview = declarationsFor(".execution-result-footer .result-continuation-overview");
  assert.equal(overview.display, "grid");
  assert.equal(overview["grid-template-columns"], "minmax(0, 1fr)");
  assert.equal(overview["min-width"], "0");
  assert.equal(declarationsFor(".execution-result-footer .result-details-toggle")["min-height"], "40px");

  const expanded = declarationsFor(".execution-result-footer.result-details-open");
  assert.equal(expanded.position, "absolute");
  assert.equal(expanded.inset, "0");
  assert.equal(expanded["grid-row"], "1 / 3");
  assert.equal(expanded["grid-column"], "1");
  assert.equal(expanded.width, "100%");
  assert.equal(expanded.height, "100%");
  assert.equal(expanded["max-height"], "none");
  assert.equal(expanded.overflow, "hidden");
  const action = declarationsFor(".execution-result-footer.result-details-open > .result-continuation-action");
  assert.equal(action["grid-template-rows"], "auto minmax(0, 1fr) auto");
  assert.equal(action["align-items"], "stretch");
  assert.equal(action.height, "100%");
  assert.equal(action["max-height"], "none");
  assert.equal(action.overflow, "hidden");

  const panel = declarationsFor(".result-details-panel");
  assert.equal(panel.display, "grid");
  assert.equal(panel["grid-template-rows"], "minmax(0, 1fr)");
  assert.equal(panel["min-height"], "0");
  assert.equal(panel["max-height"], "none");
  assert.equal(panel.overflow, "hidden");
  const scroll = declarationsFor(".result-details-scroll");
  assert.equal(scroll.overflow, "auto");
  assert.equal(scroll["min-height"], "0");
  assert.equal(scroll["scrollbar-gutter"], "stable");
  assert.equal(scroll["overscroll-behavior"], "contain");
});

test("Execution bottom selection count, pipeline controls and help tooltip remain readable and focusable", () => {
  const count = declarationsFor(".execution-result-footer .result-selection-count");
  assert.equal(count["font-size"], "var(--bachata-font-heading)");
  assert.equal(count["font-weight"], "600");
  assert.equal(count["font-variant-numeric"], "tabular-nums");
  assert.equal(declarationsFor(".execution-result-footer .result-continuation-summary")["overflow-wrap"], "anywhere");
  const tooltip = declarationsFor(".result-continuation-tooltip");
  assert.equal(tooltip.position, "absolute");
  assert.equal(tooltip.visibility, "hidden");
  assert.equal(tooltip["pointer-events"], "none");
  assert.equal(declarationsFor(".result-continuation-help:focus-within > .result-continuation-tooltip").visibility, "visible");
  for (const selector of [
    ".execution-result-footer .result-continuation-controls > button",
    ".execution-result-footer .result-pipeline-select > select",
  ]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations["min-height"], "40px", selector);
    assert.equal(declarations["min-width"], "0", selector);
  }
  assert.equal(declarationsFor(".execution-result-footer .result-continuation-controls > button")["white-space"], "normal");
  assert.equal(declarationsFor(".execution-result-footer .result-continuation-controls > button")["overflow-wrap"], "anywhere");
  for (const selector of [
    ".execution-result-footer button:focus-visible",
    ".execution-result-footer select:focus-visible",
  ]) {
    const declarations = declarationsFor(":focus-visible");
    assert.equal(declarations.outline, "2px solid var(--bachata-focus-ring)", selector);
    assert.equal(declarations["outline-offset"], "var(--bachata-focus-offset, 2px)", selector);
    for (const rule of rules.filter((entry) => entry.selectors.includes(selector))) {
      assert.doesNotMatch(rule.body, /outline\s*:\s*(?:none|0)/u, selector);
    }
  }
});

test("Execution bottom actions respond to the actual pane width including a visible inspector", () => {
  const desktopCss = css.split("@container (max-width: 720px)")[0];
  const desktopRules = [...desktopCss.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
    selectors: splitSelectors(match[1]),
    body: match[2],
  }));
  assert.equal(declarationsFor(".execution-result-footer > .result-continuation-action", desktopRules)["grid-template-columns"], "minmax(0, 1fr)");
  assert.match(css, /@container \(max-width: 720px\) \{\s*\.execution-result-footer > \.result-continuation-action \{\s*grid-template-columns: minmax\(0, 1fr\);/u);
  assert.match(css, /@container \(max-width: 480px\) \{\s*\.execution-result-footer \.result-continuation-controls \{/u);
  const controls = declarationsFor(".execution-result-footer .result-continuation-controls");
  assert.equal(controls["flex-wrap"], "wrap");
  assert.equal(controls["flex-direction"], "column");
  assert.equal(controls["align-items"], "stretch");
  for (const selector of [
    ".execution-result-footer .result-pipeline-select",
    ".execution-result-footer .result-continuation-controls > button",
  ]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations.flex, "0 0 auto", selector);
    assert.equal(declarations.width, "100%", selector);
    assert.equal(declarations["max-width"], "100%", selector);
  }
});

const controlSelector = '#root :is(button, input, select, textarea, summary, a[href], [role="button"], [role="option"], [role="radio"], .drag-handle)';
const actionSelector = '#root :is(button, summary, a[href], [role="button"], [role="option"], [role="radio"], .drag-handle):not(input, select, textarea)';
const enabledControlSelector = `${actionSelector}:not(:disabled):not([aria-disabled="true"]):not([aria-busy="true"])`;
const unavailableState = ':is(:disabled, [aria-disabled="true"], [aria-busy="true"])';

const stateRules = rules.filter((rule) => rule.selectors.some((selector) =>
  /:(?:hover|active|focus(?:-visible|-within)?)\b|\[(?:aria-(?:pressed|selected|checked|current|expanded)|open)\b|\.(?:selected|active|open|has-overrides)\b/u.test(selector)));

test("all interaction chrome excludes brand green without stripping semantic status or brand styling", () => {
  for (const rule of stateRules) {
    assert.doesNotMatch(rule.body, /bachata-green|#2f9d62|rgb\(\s*47[, ]+157[, ]+98/iu, rule.selectors.join(", "));
  }
  for (const selector of [
    ".room-item.selected", ".editor-tabs button.selected", ".run-tab-tool.selected",
    ".run-drawer-item.selected", ".composer-settings-button.open",
    ".pipeline-picker-option.active", ".pipeline-picker-option.selected .pipeline-picker-option-name",
    ".agents-picker-button.has-overrides", ".agents-choice.selected", ".agents-session-option.selected",
    '.workspace-direction[aria-pressed="true"]', '.run-tab-all[aria-current="page"]',
  ]) {
    assert.equal(rules.some((rule) => rule.selectors.includes(selector)), false, selector);
  }
  for (const rule of rules.filter((entry) => entry.selectors.includes(".run-tab.selected"))) {
    assert.doesNotMatch(rule.body, /(?:background|border|outline|box-shadow)\s*:/u);
  }
  const selectedRunTab = declarationsFor('#root .run-tab-select[aria-current="page"]:not(:hover):not(:active)');
  assert.equal(selectedRunTab.background, "transparent");
  assert.equal(selectedRunTab.color, "inherit");
  for (const selector of [
    ".bachata-mark-solid", ".bachata-mark-outline", ".room-presence.status-running",
    ".run-tab-status.status-running", ".run-tab-status.status-completed", ".action-card.result",
    ".ruling-disposition.accepted", ".agents-local.is-ready", ".direction-saturated",
  ]) {
    assert.match(JSON.stringify(declarationsFor(selector)), /bachata-green/u, selector);
  }
});

test("hover, selection, and pressed controls share distinct neutral fills without selection borders", () => {
  const hover = declarationsFor(`${enabledControlSelector}:where(:hover)`);
  const pressed = declarationsFor(`${enabledControlSelector}:where(:active)`);
  assert.equal(hover.background, "var(--bachata-control-hover)");
  assert.equal(pressed.background, "var(--bachata-control-pressed)");
  const selected = rules.find((rule) => rule.body.includes("background: var(--bachata-control-selected);") &&
    rule.selectors.some((selector) => selector.startsWith(enabledControlSelector)));
  assert.ok(selected);
  const semanticStates = selected.selectors.join(", ");
  for (const attribute of ["aria-pressed", "aria-selected", "aria-checked", "aria-current", "aria-expanded", "data-active"]) {
    assert.ok(semanticStates.includes(attribute), attribute);
  }
  assert.ok(semanticStates.includes("details[open] > summary"));
  assert.doesNotMatch(selected.body, /(?:border|outline|box-shadow)\s*:/u);
  assert.equal(hover.color, "var(--bachata-control-foreground)");
  assert.equal(pressed.color, hover.color);
  const baseRoot = rules.find((rule) => rule.selectors.includes(":root"));
  assert.ok(baseRoot);
  const fills = ["hover", "selected", "pressed"].map((state) =>
    baseRoot.body.match(new RegExp(`--bachata-control-${state}: ([^;]+);`, "u"))[1]);
  assert.equal(new Set(fills).size, 3);
});

test("primary and Send actions retain the VS Code primary family through every enabled state", () => {
  const root = rules.find((rule) => rule.selectors.includes(":root"));
  const tokens = declarationsFor(":root", [root]);
  assert.equal(tokens["--bachata-primary-background"], "var(--vscode-button-background)");
  assert.equal(tokens["--bachata-primary-foreground"], "var(--vscode-button-foreground)");
  assert.equal(tokens["--bachata-primary-hover"], "var(--vscode-button-hoverBackground, var(--vscode-button-background))");
  assert.equal(tokens["--bachata-primary-pressed"], "color-mix(in srgb, var(--vscode-button-hoverBackground, var(--vscode-button-background)) 80%, var(--vscode-button-background))");
  assert.equal(tokens["--bachata-primary-interactive-foreground"], "var(--vscode-button-foreground)");
  for (const selector of ["button.primary", "button.send-button"]) {
    const primary = declarationsFor(selector);
    assert.equal(primary.background, "var(--bachata-primary-background)", selector);
    assert.equal(primary.color, "var(--bachata-primary-foreground)", selector);
    assert.equal(primary["--bachata-control-hover"], "var(--bachata-primary-hover)", selector);
    assert.equal(primary["--bachata-control-pressed"], "var(--bachata-primary-pressed)", selector);
    assert.equal(primary["--bachata-control-selected"], "var(--bachata-primary-pressed)", selector);
    assert.equal(primary["--bachata-control-foreground"], "var(--bachata-primary-interactive-foreground)", selector);
    assert.equal(primary["--bachata-control-selected-foreground"], "var(--bachata-primary-interactive-foreground)", selector);
  }
});

test("danger and caution keep semantic foregrounds across neutral action fills without colored borders", () => {
  for (const [selector, token] of [["button.danger", "--bachata-danger"], ["button.caution", "--bachata-warn-text"]]) {
    const semantic = declarationsFor(selector);
    for (const property of ["color", "--bachata-control-foreground", "--bachata-control-selected-foreground"]) {
      assert.equal(semantic[property], `var(${token})`, `${selector}: ${property}`);
    }
    for (const property of ["border", "border-color", "outline", "box-shadow"]) assert.equal(semantic[property], undefined, selector);
  }
  const forced = declarationsFor("button:is(.danger, .caution)");
  assert.equal(forced.color, "ButtonText");
  assert.equal(forced["--bachata-control-foreground"], "CanvasText");
  assert.equal(forced["--bachata-control-selected-foreground"], "HighlightText");
});

test("editable fields keep their field surfaces and never inherit action hover, press, or selection fills", () => {
  const painted = rules.filter((rule) => /background:\s*var\(--bachata-control-(?:hover|pressed|selected)\)/u.test(rule.body));
  assert.ok(painted.length >= 4);
  for (const rule of painted) {
    for (const selector of rule.selectors) {
      assert.ok(selector.startsWith(actionSelector) || /^#root select\[multiple\].* option:checked/u.test(selector), selector);
    }
  }
  for (const selector of ["input", "select", "textarea"]) {
    assert.equal(declarationsFor(selector).background, "var(--vscode-input-background)", selector);
  }
  assert.equal(declarationsFor(".composer-surface > textarea").background, "transparent");
  const unavailable = rules.find((rule) => rule.selectors.includes(`${controlSelector}${unavailableState}`));
  assert.doesNotMatch(unavailable.body, /background\s*:/u);
  const actionUnavailable = rules.find((rule) => rule.selectors.includes(`${actionSelector}${unavailableState}`));
  assert.match(actionUnavailable.body, /background: var\(--bachata-surface\);/u);
});

test("one keyboard focus outline covers every control and pointer focus never acquires it", () => {
  const outlines = rules.filter((rule) => /outline\s*:\s*2px solid/u.test(rule.body));
  assert.equal(outlines.length, 1);
  assert.deepEqual(outlines[0].selectors, [":focus-visible"]);
  assert.equal(declarationsFor(":focus:not(:focus-visible)").outline, "none");
  assert.equal(declarationsFor('#root[data-focus-input="pointer"] :focus-visible').outline, "none");
  assert.equal(rules.some((rule) => rule.selectors.includes(".composer-surface:focus-within")), false);
  for (const selector of [".composer-surface > textarea", ".chat-minimap button", ".execution-content .code-block pre"]) {
    assert.equal(declarationsFor(selector)["--bachata-focus-offset"], "-2px", selector);
  }
  assert.match(css, /--bachata-focus-ring: var\(--vscode-focusBorder, Highlight\);/u);
});

test("notification and icon controls have one stable square primitive with an independent unread badge", () => {
  const icon = declarationsFor(".icon-button");
  for (const property of ["width", "height", "min-width", "min-height"]) {
    assert.equal(icon[property], "var(--bachata-control-size)", property);
  }
  assert.equal(icon.padding, "0");
  assert.equal(icon["border-radius"], "var(--bachata-control-radius)");
  assert.equal(icon.background, "transparent");
  assert.equal(icon.border, "0");
  assert.equal(declarationsFor(".notification-unread").position, "absolute");
  assert.equal(declarationsFor(".notification-unread")["pointer-events"], "none");
  for (const rule of rules.filter((entry) => entry.selectors.some((selector) =>
    /notification-center\s*>\s*summary(?!:)/u.test(selector)))) {
    assert.doesNotMatch(rule.body, /(?:padding|width|height|border-radius)\s*:/u);
  }
  const notifications = readFileSync(path.join(__dirname, "../src/webview-ui/notificationsRender.ts"), "utf8");
  assert.match(notifications, /<summary class="icon-button" id="notification-button" aria-label=/u);
});

test("disabled and aria-disabled controls share a muted state and are excluded from hover and press", () => {
  const disabled = rules.find((rule) => rule.selectors.includes(`${controlSelector}${unavailableState}`));
  assert.ok(disabled);
  assert.match(disabled.body, /color: var\(--bachata-control-disabled\);/u);
  assert.match(disabled.body, /cursor: default;/u);
  assert.match(disabled.body, /opacity: 1;/u);
  for (const state of ["hover", "active"]) {
    const matching = rules.filter((rule) => rule.selectors.some((selector) => selector.includes(`:where(:${state})`)));
    assert.equal(matching.length, 1);
    assert.ok(matching[0].selectors[0].includes(':not(:disabled):not([aria-disabled="true"]):not([aria-busy="true"])'));
  }
  assert.equal(declarationsFor(`${controlSelector}[aria-busy="true"]`).cursor, "progress");
});

test("pressed state never changes control geometry, including under reduced motion", () => {
  const pressed = rules.filter((rule) => rule.selectors.some((selector) => /:active\b/u.test(selector)));
  assert.ok(pressed.length > 0);
  for (const rule of pressed) {
    assert.doesNotMatch(rule.body, /(?:^|[;\s])(?:transform|translate|scale|filter|inset|top|left|right|bottom|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?|(?:min-|max-)?(?:width|height)|border-width)\s*:/u, rule.selectors.join(", "));
  }
  assert.doesNotMatch(css, /translateY\(1px\)/u);
});

test("native selections and forced colors use the shared state contract", () => {
  const multiple = declarationsFor('#root select[multiple]:not(:disabled):not([aria-disabled="true"]):not([aria-busy="true"]) option:checked:not(:disabled)');
  assert.match(multiple.background, /var\(--bachata-control-selected\)/u);
  assert.equal(multiple.color, "var(--bachata-control-selected-foreground)");
  assert.match(css, /body:is\(\.vscode-high-contrast, \.vscode-high-contrast-light\)/u);
  assert.match(css, /@media \(forced-colors: active\) \{[\s\S]*?--bachata-control-selected: Highlight;/u);
  assert.match(css, /--bachata-control-selected-foreground: HighlightText;/u);
  assert.match(css, /--bachata-control-disabled: GrayText;/u);
  assert.match(css, /input:is\(\[type="checkbox"\], \[type="radio"\]\) \{\s*accent-color: var\(--vscode-foreground\);/u);
  assert.match(css, /input:is\(\[type="checkbox"\], \[type="radio"\]\) \{\s*accent-color: auto;/u);
});

test("forced colors preserve primary state contrast without opting editable fields out of platform colors", () => {
  const forcedRoots = rules.filter((rule) => rule.selectors.includes(":root") && rule.body.includes("--bachata-primary-hover: Highlight;"));
  assert.equal(forcedRoots.length, 1);
  const tokens = declarationsFor(":root", forcedRoots);
  assert.equal(tokens["--bachata-primary-background"], "ButtonFace");
  assert.equal(tokens["--bachata-primary-foreground"], "ButtonText");
  assert.equal(tokens["--bachata-primary-hover"], "Highlight");
  assert.equal(tokens["--bachata-primary-pressed"], "color-mix(in srgb, Highlight 80%, ButtonFace)");
  assert.equal(tokens["--bachata-primary-interactive-foreground"], "HighlightText");
  for (const rule of rules.filter((entry) => /forced-color-adjust:\s*none/u.test(entry.body))) {
    for (const selector of rule.selectors.filter((value) => value.includes('input, select, textarea'))) {
      assert.ok(selector.startsWith(actionSelector), selector);
    }
  }
});
