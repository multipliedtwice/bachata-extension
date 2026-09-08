const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");

const readOne = (file) => readFile(path.resolve(__dirname, "..", file), "utf8");

// The webview is decomposed into modules concatenated by tsconfig.webview.json; these UX
// policies apply to the whole webview, so they read all of it rather than one file.
const load = async (file) => {
  if (file !== "src/webview-ui/main.ts") return readOne(file);
  const config = JSON.parse(await readOne("tsconfig.webview.json"));
  const parts = await Promise.all(config.include.map((entry) => readOne(entry)));
  return parts.join("\n");
};

test("webview destructive actions use the accessible app dialog", async () => {
  const source = await load("src/webview-ui/main.ts");
  assert.doesNotMatch(source, /window\.(?:confirm|prompt)\(/u);
  assert.match(source, /class="app-dialog" role="dialog" aria-modal="true"/u);
  assert.match(source, /data-action="dialog-confirm"/u);
  assert.match(source, /state\.dialog \? "\.app-dialog"/u);
});

test("pipeline cards are collapsed summaries and drag only from handles", async () => {
  const source = await load("src/webview-ui/main.ts");
  assert.match(source, /<details class="editor-card"/u);
  assert.match(source, /data-drag-handle=/u);
  assert.match(source, /closest<HTMLElement>\("\[data-drag-handle\]"\)/u);
  assert.match(source, /expandedEditorCards/u);
  assert.match(source, /data-editor-card-key/u);
  assert.doesNotMatch(source, /class="editor-card" draggable="true"/u);
});

test("stored attachment chips render webview-safe previews", async () => {
  const source = await load("src/webview-ui/main.ts");
  const manager = await load("src/conversations/createConversationManager.ts");
  assert.match(source, /attachment\.previewUri/u);
  assert.match(manager, /webview\.asWebviewUri/u);
  assert.match(manager, /path\.relative\(attachmentDirectory, resolved\)/u);
});

test("run action buttons use native button semantics", async () => {
  const source = await load("src/webview-ui/main.ts");
  assert.doesNotMatch(source, /role="menu(?:item)?"/u);
});


test("webview labels remaining controls and announces concise dynamic status", async () => {
  const source = await load("src/webview-ui/main.ts");
  const execution = await load("src/webview-ui/executionRender.ts");
  const html = await load("src/webview/html.ts");
  const style = await load("src/webview-ui/style.css");

  assert.match(html, /id="bachata-live-status"[^>]*role="status"[^>]*aria-live="polite"/u);
  assert.match(style, /\.sr-only\s*\{/u);
  // The rollback select is labelled in the words the gate's own action uses — "Return to step" —
  // so the visible label, the action button and the DOM test say the same thing.
  assert.match(execution, /for="rollback-target">Return to step<\/label>/u);
  assert.match(source, /rollback: "Return to step"/u);
  assert.match(source, /for="run-search">Search runs<\/label>/u);
  assert.match(source, />Secret response<\/label>/u);
  assert.match(source, />Additional instructions<\/label>/u);
  assert.match(source, /announceManagerTransition/u);
  assert.match(source, /Run is waiting for shared capacity\./u);
  assert.match(source, /Approval is required to continue the run\./u);
});

// S6. Enum members reach the reader as words, and the maps that do that say every member is
// present. Nothing checked it: the maps are typed `Record<string, string>` and `labelFor` falls
// back to the value itself, so a member added to the protocol would quietly print
// "notAuthenticated" at the reader again — the exact defect the maps exist to remove. The unions
// are the authority, so they are read from the protocol and compared against the keys.
const unionMembers = (source, name) => {
  const declaration = new RegExp(`export type ${name} =([\\s\\S]*?);`, "u").exec(source);
  assert.notEqual(declaration, null, `${name} is not declared where this test reads it`);
  return [...declaration[1].matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
};

const labelKeys = (source, name) => {
  const declaration = new RegExp(`const ${name}: Record<string, string> = \\{([\\s\\S]*?)\\n\\};`, "u")
    .exec(source);
  assert.notEqual(declaration, null, `${name} is not declared where this test reads it`);
  return [...declaration[1].matchAll(/^\s{2}([A-Za-z]+):/gmu)].map((match) => match[1]);
};

test("every protocol status and policy the inspector prints has a word for it", async () => {
  const render = await readOne("src/webview-ui/render.ts");
  const browserProtocol = await readOne("src/browser/protocol.ts");
  const webviewProtocol = await readOne("src/webview/protocol.ts");

  const statuses = unionMembers(browserProtocol, "BrowserSessionStatus");
  assert.ok(statuses.length >= 7, `only ${String(statuses.length)} session statuses were read`);
  assert.deepEqual(
    statuses.filter((member) => !labelKeys(render, "browserSessionStatusLabel").includes(member)),
    [],
    "a browser session status would be printed to the reader as its protocol name",
  );

  const policies = unionMembers(webviewProtocol, "BrowserActionPolicy");
  assert.ok(policies.length >= 3, `only ${String(policies.length)} action policies were read`);
  assert.deepEqual(
    policies.filter((member) => !labelKeys(render, "browserActionPolicyLabel").includes(member)),
    [],
    "a browser action policy would be printed to the reader as its protocol name",
  );
});
