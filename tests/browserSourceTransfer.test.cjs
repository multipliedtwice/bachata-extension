const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { BrowserContextReferences } = require("../dist/browser/contextReferences.js");
const { isBrowserSourcePath, browserSourceDiff } = require("../dist/browser/sourceTransferPolicy.js");
const { extractBrowserControlEnvelope, extractBrowserControlEnvelopeFromCaptured, browserControlProtocolPrompt } = require("../dist/browser/controlProtocol.js");
const { executeManagedBrowserEnvelope, isSupportedManagedContextAttachmentPath } = require("../dist/browser/managedTurn.js");
const { isSupportedBrowserAttachmentPath, createBrowserProviderAdapter } = require("../dist/adapters/browserProvider.js");
const { isSupportedContextPath } = require("../dist/context/tsJsContext.js");
const digest = createHash("sha256").update("export const result = 1;\n").digest("hex");
const envelope = (actions, status = "applyPatch") => ({ protocol: "bachata-browser-turn-v1", status, actions, summary: "Review the change", objections: [], unresolved: [] });
const fence = (value) => `\`\`\`bachata-control\n${JSON.stringify(value)}\n\`\`\``;

for (const name of ["package-lock.json", "nested/npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "packages.lock.json", "dist/review.png", "node_modules/code.ts", "nested/dist/code.js", "BACHATA.VSIX", "C:\\repo\\node_modules\\source.png"]) {
  test(`browser source transfer excludes ${name}`, () => {
    assert.equal(isBrowserSourcePath(name), false);
    assert.equal(isSupportedManagedContextAttachmentPath(name, "C:\\repo"), false);
    assert.equal(isSupportedBrowserAttachmentPath(name, "C:\\repo"), false);
    assert.equal(isSupportedContextPath(name), false);
  });
}
test("source files, manifests and user screenshots remain eligible", () => {
  for (const name of ["src/index.ts", "package.json", "docs/review.md", "assets/review.png", "src/distribution.ts"]) assert.equal(isBrowserSourcePath(name), true);
  assert.equal(isSupportedManagedContextAttachmentPath("package.json"), true);
  assert.equal(isSupportedBrowserAttachmentPath("assets/review.png"), true);
});

test("diff transfer omits generated file bodies and index metadata but preserves source hunks", () => {
  const block = (name, body) => `diff --git a/${name} b/${name}\nindex abc123..def456 100644\n--- a/${name}\n+++ b/${name}\n@@ -1 +1 @@\n-${body}\n+updated ${body}\n`;
  const source = block("src/index.ts", "source body");
  const output = browserSourceDiff(source + block("package-lock.json", "LOCK_PAYLOAD") + block("dist/out.js", "DIST_PAYLOAD") + block("extension.vsix", "VSIX_PAYLOAD"));
  assert.equal(output, source.replace("index abc123..def456 100644\n", ""));
  assert.doesNotMatch(output, /LOCK_PAYLOAD|DIST_PAYLOAD|VSIX_PAYLOAD|abc123/);
  assert.equal(browserSourceDiff(output), output);
});

test("browser references hide controller digests, preserve source text and round-trip strict edit preconditions", () => {
  const references = new BrowserContextReferences();
  const input = { context: [{ path: "src/index.ts", sha256: digest, hashScope: "file", id: "abcd".repeat(4), fileVersion: 1, text: "source includes sha256 as a variable name" }], verification: [{ workspaceFingerprint: digest, status: "passed" }], omittedSnippetIds: ["1234".repeat(4)] };
  const output = references.render(input);
  assert.doesNotMatch(output, new RegExp(digest));
  assert.doesNotMatch(output, /"sha256"|"workspaceFingerprint"|"hashScope"|abcdabcdabcdabcd|1234123412341234/);
  const context = JSON.parse(output).context[0];
  assert.equal(context.text, input.context[0].text);
  assert.equal(references.render(input), output);
  for (const kind of ["workspace.write", "workspace.delete", "workspace.applyPatch"]) {
    const action = { kind, ...(kind === "workspace.applyPatch" ? { patch: "*** Begin Patch\n*** End Patch" } : { path: "src/index.ts", ...(kind === "workspace.write" ? { content: "updated source" } : {}) }), expectedFiles: [{ path: "src/index.ts", fileVersion: context.fileVersion }] };
    const result = extractBrowserControlEnvelope(fence(envelope([action])), references);
    assert.ok(result, kind);
    assert.deepEqual(result.actions[0].expectedFiles, [{ path: "src/index.ts", sha256: digest }]);
    const captured = extractBrowserControlEnvelopeFromCaptured({ text: "Captured code", segments: [{ type: "codeBlock", language: "bachata-control", text: JSON.stringify(envelope([action])) }] }, references);
    assert.deepEqual(captured, result);
    assert.equal(extractBrowserControlEnvelope(fence(envelope([action])), new BrowserContextReferences()), undefined, "references do not cross turns");
  }
  const read = extractBrowserControlEnvelope(fence(envelope([{ kind: "context.read", snippetIds: [context.id] }], "needContext")), references);
  assert.deepEqual(read.actions[0].snippetIds, [input.context[0].id]);
  assert.doesNotMatch(browserControlProtocolPrompt, /SHA-256|"sha256"/);
});

test("unknown, cross-file, range and malformed version preconditions fail closed", () => {
  const references = new BrowserContextReferences();
  const full = JSON.parse(references.render({ path: "src/a.ts", sha256: digest, hashScope: "file" }));
  const range = JSON.parse(references.render({ path: "src/a.ts", sha256: digest, hashScope: "range" }));
  for (const expected of [{ path: "src/b.ts", fileVersion: full.fileVersion }, { path: "src/a.ts", fileVersion: range.fileVersion }, { path: "src/a.ts", fileVersion: "file-version-999" }, { path: "src/a.ts", fileVersion: full.fileVersion, sha256: digest }]) {
    const action = { kind: "workspace.write", path: expected.path, content: "bad write", expectedFiles: [expected] };
    assert.equal(extractBrowserControlEnvelope(fence(envelope([action])), references), undefined);
  }
});

test("browser reference state has a literal bound and retains already issued versions", () => {
  const references = new BrowserContextReferences();
  for (let i = 0; i < BrowserContextReferences.maximumEntries; i++) references.render({ path: `src/${i}.ts`, sha256: digest });
  assert.throws(() => references.render({ path: "src/extra.ts", sha256: digest }), /limit reached/);
  assert.equal(references.fileDigest("src/0.ts", references.fileVersion("src/0.ts", digest)), digest);
});

test("managed file reads refuse excluded payloads, and source reads publish only version references", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-source-transfer-"));
  try {
    await fs.writeFile(path.join(root, "package-lock.json"), "LOCK_PRIVATE_PAYLOAD");
    await fs.writeFile(path.join(root, "source.ts"), "export const result = 1;\n");
    const turn = { snippets: new Map(), workspaceRevision: 0, changedFiles: [], verification: [] };
    const options = { workingDirectory: root, readPaths: [], commitMode: "never", signal: new AbortController().signal, executor: { timeoutMs: 1000, maxReadBytes: 65536 }, continuationMaxBytes: 65536 };
    const result = await executeManagedBrowserEnvelope(envelope([{ kind: "context.readFile", path: "package-lock.json" }, { kind: "context.fileVersion", path: "package-lock.json" }, { kind: "context.readFile", path: "source.ts" }], "needContext"), turn, options, async () => "approve");
    assert.match(result.nextPrompt, /excludes lockfiles and generated artifacts/);
    assert.match(result.nextPrompt, /export const result = 1/);
    assert.match(result.nextPrompt, /file-version-/);
    assert.doesNotMatch(result.nextPrompt, new RegExp(`LOCK_PRIVATE_PAYLOAD|${digest}|"sha256"`));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("browser image attachment refuses generated paths before submission", async () => {
  let submissions = 0;
  const ready = { id: "browser-session", provider: "chatgpt", status: "ready" };
  const adapter = createBrowserProviderAdapter({ id: "worker", provider: "chatgpt", turnTimeoutMs: 1000, bridge: { releaseBinding: () => undefined, getStatus: () => ({ sessions: [ready] }), resolveBoundSession: () => ready, async *sendConversation() { submissions++; } } });
  try {
    await assert.rejects(async () => { for await (const event of adapter.send({ prompt: "Review accessibility", workingDirectory: "/tmp", attachments: ["/tmp/dist/review.png"] }, new AbortController().signal)) void event; }, /excludes lockfiles and generated artifacts/);
    assert.equal(submissions, 0);
  } finally { await adapter.dispose(); }
});

test("fallback workspace reads use version references and its action parser preserves edit guards", async () => {
  const { executeBrowserAction } = require("../dist/browser/workspaceActions.js");
  const { createBrowserActionCandidate, extractBrowserActions } = require("../dist/browser/actions.js");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-fallback-context-"));
  const references = new BrowserContextReferences();
  try {
    await fs.writeFile(path.join(root, "source.ts"), "export const result = 1;\n");
    await fs.writeFile(path.join(root, "package-lock.json"), "LOCK_BODY");
    const options = { workingDirectory: root, signal: new AbortController().signal, timeoutMs: 1000, terminateGraceMs: 100, maxOutputBytes: 65536, maxReadBytes: 65536, maxSearchResults: 100, contextReferences: references };
    const action = (file) => createBrowserActionCandidate({ kind: "workspace.read", path: file, risk: "readOnly", origin: "structured", confidence: "explicit", source: { start: 0, end: 0, text: "" } });
    const read = await executeBrowserAction(action("source.ts"), options);
    assert.equal(read.status, "completed");
    assert.match(read.stdout, /fileVersion:file-version-[a-f0-9-]+-1/);
    assert.doesNotMatch(read.stdout, new RegExp(`${digest}|sha256:`));
    const locked = await executeBrowserAction(action("package-lock.json"), options);
    assert.notEqual(locked.status, "completed");
    assert.doesNotMatch(JSON.stringify(locked), /LOCK_BODY/);
    const text = JSON.stringify({ turnToken: "this-turn", kind: "workspace.write", path: "source.ts", content: "updated", expectedFiles: [{ path: "source.ts", fileVersion: references.fileVersion("source.ts", digest) }] });
    const segments = [{ type: "codeBlock", language: "bachata-action", text, start: 0, end: text.length }];
    const parsed = extractBrowserActions(text, segments, "this-turn", references);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0].expectedFiles, [{ path: "source.ts", sha256: digest }]);
    assert.equal(extractBrowserActions(text, segments, "this-turn", new BrowserContextReferences()).length, 0);
    await fs.writeFile(path.join(root, "source.ts"), "export const independentEdit = true;\n");
    const stale = await executeBrowserAction(parsed[0], { ...options, mutationContext: { workspaceRoot: root, allowedPaths: ["source.ts"], readOnly: false, commitMode: "never" } });
    assert.notEqual(stale.status, "completed");
    assert.match(stale.stderr ?? stale.summary, /stale|changed|match/i);
    assert.equal(await fs.readFile(path.join(root, "source.ts"), "utf8"), "export const independentEdit = true;\n");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("renaming stored attachments to internal IDs cannot bypass browser source exclusions", () => {
  const { assertBrowserAttachmentSource } = require("../dist/browser/sourceTransferPolicy.js");
  const snapshot = "/storage/attachment-snapshots/run-a/attachment-id.json";
  assert.throws(() => assertBrowserAttachmentSource(snapshot, [{ name: "package-lock.json", relativePath: "attachments/attachment-id.json" }]), /excludes lockfiles/);
  assert.doesNotThrow(() => assertBrowserAttachmentSource(snapshot, [{ name: "package.json", relativePath: "attachments/attachment-id.json" }]));
});

test("fallback edit preconditions are all-or-nothing, including mixed validity", () => {
  const { extractBrowserActions } = require("../dist/browser/actions.js");
  const valid = { path: "src/index.ts", sha256: digest };
  for (const expectedFiles of [[valid, null], [valid, { path: "src/index.ts", sha256: "invalid" }], Array(65).fill(valid), [{ ...valid, fileVersion: "unknown" }]]) {
    const text = JSON.stringify({ turnToken: "turn", kind: "workspace.applyPatch", patch: "*** Begin Patch\n*** End Patch", expectedFiles });
    assert.equal(extractBrowserActions(text, [{ type: "codeBlock", language: "bachata-action", text, start: 0, end: text.length }], "turn", new BrowserContextReferences()).length, 0);
  }
});
