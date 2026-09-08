const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// The webview is emitted as one concatenated script (module: none, outFile), so the extracted
// modules are exercised by evaluating that script and reading the declarations it defines.
const bundle = fs.readFileSync(path.join(__dirname, "..", "dist", "webview.js"), "utf8");

// The bootstrap at the end of the bundle needs a live DOM; the declarations above it do not.
const bootstrapAt = bundle.indexOf("const vscode = acquireVsCodeApi");
const declarations = bootstrapAt === -1 ? bundle : bundle.slice(0, bootstrapAt);

const evaluate = (names) => {
  // Only the pure declarations above the state store are evaluated; they need no DOM.
  const context = vm.createContext({ navigator: { userAgent: "test" } });
  return vm.runInContext(`${declarations}\n;({ ${names.join(", ")} });`, context);
};

test("render primitives are one shared implementation, not copies", () => {
  const main = fs.readFileSync(path.join(__dirname, "..", "src", "webview-ui", "main.ts"), "utf8");
  const render = fs.readFileSync(path.join(__dirname, "..", "src", "webview-ui", "render.ts"), "utf8");
  ["const escapeHtml =", "const formatBytes =", "const durationLabel =", "const listText ="].forEach((declaration) => {
    assert.ok(render.includes(declaration), `render.ts lost ${declaration}`);
    assert.equal(
      main.includes(declaration),
      false,
      `main.ts still declares its own ${declaration}`,
    );
  });
});

test("each subsystem owns its module, and main.ts keeps none of them", () => {
  const read = (name) =>
    fs.readFileSync(path.join(__dirname, "..", "src", "webview-ui", name), "utf8");
  const main = read("main.ts");
  const owners = {
    "directionRender.ts": ["historyFindingHtml", "historyDecisionHtml", "directionHtml", "semanticHistoryHtml"],
    "executionRender.ts": ["workflowHtml", "resultCenterHtml", "participantColumnHtml", "finalRulingHtml"],
    "pipelineEditor.ts": ["pipelineEditorHtml", "editorStepHtml", "updateEditorInput"],
    "dialogs.ts": ["appDialogHtml", "confirmDialog"],
    "protocolReducer.ts": ["applyRuntimeMessage"],
    "actions.ts": ["installActionListeners"],
    "roomRender.ts": ["roomHeaderHtml", "mainRoomHtml"],
    "notificationsRender.ts": ["notificationBellHtml", "notificationBubbleHtml"],
    "state.ts": ["activeId", "activePanel", "longitudinalState"],
    "markdownRender.ts": ["renderMarkdown", "renderInline", "highlightedCode", "codeBlockHtml", "normalizeLanguage", "markdownTableHtml"],
  };
  Object.entries(owners).forEach(([module, names]) => {
    const source = read(module);
    names.forEach((name) => {
      assert.ok(source.includes(`const ${name}`), `${module} does not own ${name}`);
      assert.equal(
        main.includes(`const ${name} =`),
        false,
        `main.ts still implements ${name}, which ${module} owns`,
      );
    });
  });
});

test("main.ts is bootstrap and composition, not an implementation container", () => {
  const main = fs.readFileSync(
    path.join(__dirname, "..", "src", "webview-ui", "main.ts"),
    "utf8",
  );
  const lines = main.split("\n").length;
  assert.ok(lines <= 2500, `main.ts is ${String(lines)} lines, above the 2500 acceptance bound`);
  assert.match(main, /installActionListeners\(\);/u, "the bootstrap never installs listeners");
  assert.match(main, /vscode\.postMessage\(\{ type: "manager\.ready" \}\)/u);
});

test("the extracted renderers escape everything they emit", () => {
  const { escapeHtml, judgementEvidenceHtml, producingRunHtml } = evaluate([
    "escapeHtml", "judgementEvidenceHtml", "producingRunHtml",
  ]);
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  const hostile = judgementEvidenceHtml("Evidence", ['</ul><script>alert(1)</script>']);
  assert.doesNotMatch(hostile, /<script>/u, "hostile evidence text reached the DOM unescaped");
  assert.match(hostile, /&lt;script&gt;/u);
  const run = producingRunHtml('" onmouseover="alert(1)');
  assert.doesNotMatch(run, /onmouseover="alert/u, "a hostile run reference escaped its attribute");
});

test("judgement rendering states absence rather than implying completeness", () => {
  const { judgementEvidenceHtml, producingRunHtml } = evaluate([
    "judgementEvidenceHtml", "producingRunHtml",
  ]);
  assert.match(judgementEvidenceHtml("Options", []), /No options were supplied/u);
  assert.match(judgementEvidenceHtml("Evidence", ["a", "b"]), /Evidence \(2\)/u);
  assert.equal(producingRunHtml(undefined), "", "a missing run produced a dead control");
});

test("shared formatting behaves the same everywhere it is used", () => {
  const { formatBytes, durationLabel, formatDuration, listText, countLabel } = evaluate([
    "formatBytes", "durationLabel", "formatDuration", "listText", "countLabel",
  ]);
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(durationLabel(30_000), "30s");
  assert.equal(durationLabel(120_000), "2 min");
  assert.equal(formatDuration(65_000), "01:05");
  assert.equal(listText(["a", "b"], ", "), "a, b");
  assert.equal(listText(undefined, ", "), "");
  assert.equal(countLabel(1, "decision"), "1 decision");
  assert.equal(countLabel(2, "decision"), "2 decisions");
});

test("the webview build concatenates the extracted modules ahead of main", () => {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "tsconfig.webview.json"),
    "utf8",
  ));
  assert.equal(config.include.at(0), "src/webview-ui/types.ts", "types must be declared first");
  assert.equal(config.include.at(-1), "src/webview-ui/main.ts", "main must be concatenated last");
  assert.ok(
    config.include.indexOf("src/webview-ui/state.ts") <
      config.include.indexOf("src/webview-ui/directionRender.ts"),
    "state must be declared before the renderers that read it",
  );
  assert.ok(config.include.length >= 10, "the webview was not decomposed into modules");
  assert.equal(config.compilerOptions.module, "None");
});

// EX-3 / main.ts size bound. Markdown rendering left the bootstrap for markdownRender.ts; these are
// its rules, evaluated from the emitted bundle with a stub highlighter so the cache and the
// grammar lookup are exercised without Prism's own output in the assertion.
// markdownRender.ts sits after the state store in the bundle, so this slice runs through the
// store's own top-level statements with a stub host: an element that accepts everything and a
// vscode API that remembers nothing. Everything past markdownRender.ts is left out.
const markdownSliceEnd = bundle.indexOf("const notificationModeControlHtml");
const markdownDeclarations = markdownSliceEnd === -1 ? bundle : bundle.slice(0, markdownSliceEnd);

const stubElement = () => {
  const element = {
    textContent: "",
    innerHTML: "",
    hidden: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    blur() {},
  };
  return element;
};

const markdown = (prismOverrides = {}) => {
  const highlighted = [];
  const context = vm.createContext({
    navigator: { userAgent: "test" },
    acquireVsCodeApi: () => ({ postMessage() {}, getState: () => undefined, setState: (value) => value }),
    document: {
      getElementById: () => stubElement(),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      body: stubElement(),
      documentElement: stubElement(),
    },
    window: { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: () => 0,
    Prism: {
      languages: { javascript: { token: true }, bash: { token: true } },
      highlight: (code, _grammar, language) => {
        highlighted.push([code, language]);
        return `<span class="hl-${language}">${code}</span>`;
      },
      ...prismOverrides,
    },
  });
  const api = vm.runInContext(
    `${markdownDeclarations}\n;({ renderMarkdown, renderInline, highlightedCode, normalizeLanguage, codeBlockHtml, markdownTableHtml, codeBlocks });`,
    context,
  );
  return { ...api, highlighted };
};

test("fence languages normalise through their aliases and never reach Object.prototype", () => {
  const { normalizeLanguage } = markdown();
  assert.equal(normalizeLanguage("JS"), "javascript");
  assert.equal(normalizeLanguage("  sh extra"), "bash");
  assert.equal(normalizeLanguage("txt"), "plain");
  assert.equal(normalizeLanguage(""), "plain");
  assert.equal(normalizeLanguage("constructor"), "constructor");
  assert.equal(normalizeLanguage("__proto__"), "__proto__");
  assert.equal(normalizeLanguage("rust"), "rust");
});

test("code is highlighted once per language and text, escaped when there is no grammar", () => {
  const { highlightedCode, highlighted } = markdown();
  assert.equal(highlightedCode("let a = 1;", "js"), '<span class="hl-javascript">let a = 1;</span>');
  assert.equal(highlightedCode("let a = 1;", "javascript"), '<span class="hl-javascript">let a = 1;</span>');
  assert.equal(highlighted.length, 1, "the second identical block came from the cache");
  assert.equal(highlightedCode("<b>", "nope"), "&lt;b&gt;");
});

test("a highlighter that throws falls back to escaped text", () => {
  const { highlightedCode } = markdown({ highlight: () => { throw new Error("grammar broke"); } });
  assert.equal(highlightedCode("<x>", "bash"), "&lt;x&gt;");
});

test("inline markdown: bold, emphasis, code, and only http(s) links become markup", () => {
  const { renderInline } = markdown();
  assert.equal(renderInline("a **b** c"), "a <strong>b</strong> c");
  assert.equal(renderInline("a *b* _c_"), "a <em>b</em> <em>c</em>");
  assert.equal(renderInline("say `x<y`"), "say <code>x&lt;y</code>");
  assert.equal(renderInline("[site](https://example.test/a?b=1)"), '<a href="https://example.test/a?b=1">site</a>');
  assert.equal(renderInline("[bad](javascript:alert(1))"), "[bad](javascript:alert(1))");
  assert.equal(renderInline("<img>"), "&lt;img&gt;");
});

test("block markdown: headings sit under the room's own, lists, quotes, rules and tables render", () => {
  const { renderMarkdown } = markdown();
  assert.equal(renderMarkdown("# Title\n\ntext"), "<h3>Title</h3><p>text</p>");
  assert.equal(renderMarkdown("###### deep"), "<h6>deep</h6>");
  assert.equal(renderMarkdown("- a\n- b\n\n1. c\n2) d"), "<ul><li>a</li><li>b</li></ul><ol><li>c</li><li>d</li></ol>");
  assert.equal(renderMarkdown("> q1\n> q2"), "<blockquote><p>q1<br>q2</p></blockquote>");
  assert.equal(renderMarkdown("---"), "<hr>");
  assert.equal(
    renderMarkdown("| h1 | h2 |\n| --- | --- |\n| a | **b** |"),
    '<div class="markdown-table"><table><thead><tr><th scope="col">h1</th><th scope="col">h2</th></tr></thead><tbody><tr><td>a</td><td><strong>b</strong></td></tr></tbody></table></div>',
    "a header cell has to say which cells it heads, and only a header cell carries scope",
  );
  assert.equal(renderMarkdown("line one\nline two\n\npara"), "<p>line one<br>line two</p><p>para</p>");
  assert.equal(renderMarkdown("\r\n\r\n"), "");
});

test("a runaway quote depth stops recursing and renders the rest inline", () => {
  const { renderMarkdown } = markdown();
  const deep = `${">".repeat(40)} x`;
  const html = renderMarkdown(deep);
  assert.equal((html.match(/<blockquote>/gu) ?? []).length, 17);
  assert.doesNotMatch(html, /<blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote><blockquote>/u);
});

test("a fenced block registers its code for the copy control and names its language", () => {
  const { renderMarkdown, codeBlocks } = markdown();
  const html = renderMarkdown("```js\nconst a = 1;\n```\nafter");
  assert.match(html, /<section class="code-block">/u);
  assert.match(html, /data-code-region="javascript code block"/u);
  assert.match(html, /<span class="hl-javascript">const a = 1;<\/span>/u);
  const id = /data-code-id="(code-\d+)"/u.exec(html)[1];
  assert.equal(codeBlocks.get(id), "const a = 1;");
  assert.match(html, /<p>after<\/p>$/u);
  assert.match(renderMarkdown("~~~\nplain text\n~~~"), /data-code-region="text code block"/u);
});
