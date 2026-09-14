const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const css = readFileSync(path.join(__dirname, "../src/webview-ui/style.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//gu, "");

const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
  selectors: match[1].trim().split(/,\s*/u),
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
    const declarations = declarationsFor(selector);
    assert.equal(declarations.outline, "2px solid var(--bachata-focus-ring)", selector);
    assert.equal(declarations["outline-offset"], "2px", selector);
  }
  assert.equal(declarationsFor(".execution-content .code-block pre:focus-visible")["outline-offset"], "-2px");
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

test("Execution narrow layout stacks pipeline metadata and implementation guidance", () => {
  const narrow = /@media \(max-width: 480px\) \{\s*\.execution-content \.pipeline-step-summary,[\s\S]*?\.execution-content \.result-continuation-action\s*\{\s*flex-basis: 100%;\s*\}\s*\}/u.exec(css)?.[0];
  assert.ok(narrow, "Missing narrow Execution layout");
  const narrowRules = [...narrow.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
    selectors: match[1].trim().split(/,\s*/u),
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
  assert.equal(content["max-width"], "var(--bachata-content-max)");
  assert.equal(content["margin-inline"], "auto");
  assert.equal(content["min-width"], "0");
});

test("Execution bottom selection count, pipeline controls and refusal remain readable and focusable", () => {
  const count = declarationsFor(".execution-result-footer .result-selection-count");
  assert.equal(count["font-size"], "var(--bachata-font-heading)");
  assert.equal(count["font-weight"], "600");
  assert.equal(count["font-variant-numeric"], "tabular-nums");
  assert.equal(declarationsFor(".execution-result-footer .result-continuation-summary")["overflow-wrap"], "anywhere");
  for (const selector of [
    ".execution-result-footer .result-continuation-guidance",
    ".execution-result-footer .result-continuation-reason",
  ]) {
    const declarations = declarationsFor(selector);
    assert.equal(declarations["grid-column"], "1 / -1", selector);
    assert.equal(declarations["overflow-wrap"], "anywhere", selector);
    assert.equal(declarations.margin, "0", selector);
  }
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
    const declarations = declarationsFor(selector);
    assert.equal(declarations.outline, "2px solid var(--bachata-focus-ring)", selector);
    assert.equal(declarations["outline-offset"], "2px", selector);
  }
});

test("Execution bottom actions respond to the actual pane width including a visible inspector", () => {
  const desktopCss = css.split("@container (max-width: 720px)")[0];
  const desktopRules = [...desktopCss.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].map((match) => ({
    selectors: match[1].trim().split(/,\s*/u),
    body: match[2],
  }));
  assert.equal(declarationsFor(".execution-result-footer > .result-continuation-action", desktopRules)["grid-template-columns"], "minmax(0, 1fr) minmax(0, 2fr)");
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
