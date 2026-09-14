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
  assert.equal(declarationsFor(".execution-content .pipeline-step > details > summary", narrowRules)["grid-template-columns"], "18px minmax(0, 1fr)");
  for (const selector of [
    ".execution-content .pipeline-step-state",
    ".execution-content .pipeline-step-count",
    ".execution-content .pipeline-step-timing",
  ]) {
    assert.equal(declarationsFor(selector, narrowRules)["grid-column"], "2", selector);
  }
  assert.equal(declarationsFor(".execution-content .pipeline-step-state", narrowRules)["grid-row"], "auto");
  assert.equal(declarationsFor(".pipeline-step-message-heading", narrowRules)["flex-direction"], "column");
  assert.equal(declarationsFor(".execution-content .pipeline-step-body", narrowRules)["padding-inline-start"], "0");
  assert.equal(declarationsFor(".execution-content .result-continuation-action", narrowRules)["flex-basis"], "100%");
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
