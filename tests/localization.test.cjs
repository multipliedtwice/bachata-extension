const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const transpile = (file) => ts.transpileModule(fs.readFileSync(path.join(root, file), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

const webviewLocalization = (configuration) => {
  const context = vm.createContext({
    Intl,
    document: { getElementById: () => configuration === undefined ? null : { textContent: typeof configuration === "string" ? configuration : JSON.stringify(configuration) } },
  });
  vm.runInContext(`${transpile("src/webview-ui/localization.ts")}\nglobalThis.api = { localize, formatNumber, webviewLocale };`, context);
  return context.api;
};

const htmlFor = (language, bundle) => {
  const moduleValue = { exports: {} };
  const vscode = {
    env: { language },
    l10n: { bundle },
    Uri: { joinPath: (...segments) => segments.join("/") },
  };
  const context = vm.createContext({
    module: moduleValue,
    exports: moduleValue.exports,
    require: (name) => name === "vscode" ? vscode : name === "./assets" ? { prismComponents: [] } : require(name),
  });
  vm.runInContext(transpile("src/webview/html.ts"), context);
  return moduleValue.exports.getWebviewHtml({ cspSource: "vscode-webview:", asWebviewUri: (value) => value }, "extension");
};

test("localization falls back safely for missing, malformed, and invalid catalogs", () => {
  for (const configuration of [undefined, "broken json", [], { locale: "invalid language", messages: [] }]) {
    const api = webviewLocalization(configuration);
    assert.equal(api.localize("Hello {0}", "reader"), "Hello reader");
    assert.equal(api.webviewLocale, "en");
  }
  const api = webviewLocalization({ locale: "pt_BR", messages: { "Hello {0}": "", "Open {0}": "Abrir {1}", Close: " \n\t " } });
  assert.equal(api.webviewLocale, "pt-BR");
  assert.equal(api.localize("Hello {0}", "reader"), "Hello reader");
  assert.equal(api.localize("Open {0}", "file"), "Open file");
  assert.equal(api.localize("Close"), "Close");
});

test("translations reorder placeholders without treating inserted values as templates", () => {
  const api = webviewLocalization({ locale: "de", messages: { "{0} opens {1}": "{1} von {0}" } });
  assert.equal(api.localize("{0} opens {1}", "<reader>", "{0}"), "{0} von <reader>");
  assert.equal(api.localize("Missing translation {0}", "value"), "Missing translation value");
  assert.equal(api.localize("constructor"), "constructor");
  assert.equal(api.formatNumber(1234.5), new Intl.NumberFormat("de").format(1234.5));
  assert.equal(api.localize("Count: {0}", 1234.5), "Count: 1.234,5");
});

test("webview bootstrap preserves translations without allowing script or attribute injection", () => {
  const payload = '</script><img src=x onerror="bad()"> & \u2028\u2029';
  const html = htmlFor("de-DE", { Open: payload });
  assert.match(html, /<html lang="de-DE">/u);
  assert.doesNotMatch(html, /<img src=x/u);
  const config = /<script id="bachata-localization"[^>]*>([\s\S]*?)<\/script>/u.exec(html);
  assert.ok(config);
  assert.deepEqual(JSON.parse(config[1]), { locale: "de-DE", messages: { Open: payload } });
  assert.ok(html.indexOf('id="bachata-localization"') < html.indexOf('src="extension/dist/webview.js"'));
  assert.match(htmlFor('en" onload="bad()', undefined), /<html lang="en">/u);
  assert.match(htmlFor("fr", undefined), /<html lang="en">/u);
});

test("catalog validation catches removed placeholders and unknown keys", async () => {
  const { validateCatalog } = await import("../scripts/localization.mjs");
  const english = { "Open {0}": "Open {0}", Close: "Close" };
  assert.deepEqual(validateCatalog({ "Open {0}": "{0} öffnen" }, english, "fixture"), []);
  assert.equal(validateCatalog({ "Open {0}": "Öffnen" }, english, "fixture").length, 1);
  assert.equal(validateCatalog({ Missing: "Unbekannt" }, english, "fixture").length, 1);
  assert.equal(validateCatalog({ Close: "" }, english, "fixture").length, 1);
});
