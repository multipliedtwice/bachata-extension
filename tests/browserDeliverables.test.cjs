const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { crc32, deflateRawSync } = require("node:zlib");
const { readDeliverableZip, deliverablePath, deliverableLimits } = require("../dist/browser/deliverableArchive.js");
const { prepareBrowserDeliverable, fetchDeliverableBytes } = require("../dist/browser/deliverables.js");
const { BrowserContextReferences } = require("../dist/browser/contextReferences.js");
const { executeBrowserAction } = require("../dist/browser/workspaceActions.js");
const { prepareManagedBrowserTurn, executeManagedBrowserEnvelope } = require("../dist/browser/managedTurn.js");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const zip = (files) => {
  const local = [], central = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = Buffer.from(file.text ?? ""), compressed = deflateRawSync(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(file.flags ?? 0x800, 6); header.writeUInt16LE(8, 8);
    header.writeUInt32LE(file.crc ?? crc32(data), 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(file.size ?? data.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(file.flags ?? 0x800, 8); entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(file.crc ?? crc32(data), 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(file.size ?? data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(((file.mode ?? 0o100644) << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); central.push(entry, name); offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
};
const response = (assets = [], text = "Updated source files are attached.", segments = []) => ({ assets, text, segments });
const asset = (name, data) => ({ id: "returned-asset", name, size: data.length, provider: "chatgpt", kind: "generatedFile", sourceElement: "assistantMessage", downloadAvailable: true });
const transfer = (name, data) => async function* (assetId) {
  yield { type: "start", assetId, name, size: data.length };
  const middle = Math.floor(data.length / 2);
  yield { type: "chunk", assetId, sequence: 0, data: data.subarray(0, middle) };
  yield { type: "chunk", assetId, sequence: 1, data: data.subarray(middle) };
  yield { type: "complete", assetId, size: data.length, sha256: hash(data) };
};
const workspace = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-deliverable-"));
  await fs.mkdir(path.join(root, "src"));
  const original = "export const retryCount = 2;\n";
  await fs.writeFile(path.join(root, "src/retry.ts"), original);
  await fs.writeFile(path.join(root, "README.md"), "Keep the existing project instructions.\n");
  const references = new BrowserContextReferences(root);
  references.fileVersion("src/retry.ts", hash(original));
  return { root, original, references, options: { workingDirectory: root, references, hasControlActions: false, signal: new AbortController().signal, mutationContext: { scopeMode: "workspace", readOnly: false, commitMode: "never" } } };
};
const execute = (prepared, root, extra = {}) => executeBrowserAction(prepared.action, { workingDirectory: root, signal: new AbortController().signal, timeoutMs: 5000, terminateGraceMs: 100, maxOutputBytes: 65536, maxReadBytes: 65536, maxSearchResults: 100, ...extra });

for (const variant of ["partial", "full", "wrapped", "missing-final-newline", "empty-new-file"]) {
  test(`imports ${variant} source archive through the existing patch executor and preserves omitted files`, async () => {
    const state = await workspace();
    try {
      const updated = variant === "missing-final-newline" ? "export const retryCount = 3;" : "export const retryCount = 3;\n";
      const entries = [{ name: "src/retry.ts", text: updated }, { name: "src/backoff.ts", text: variant === "empty-new-file" ? "" : "export const backoffMs = 250;\n" }];
      if (variant === "full") entries.push({ name: "README.md", text: "Keep the existing project instructions.\n" }, { name: "dist/out.js", text: "ignored generated output" }, { name: "package-lock.json", text: "ignored lock" });
      if (variant === "wrapped") for (const entry of entries) entry.name = `returned-project/${entry.name}`;
      const data = zip(entries), name = "updated-source.zip";
      const prepared = await prepareBrowserDeliverable(response([asset(name, data)]), { ...state.options, mutationContext: { scopeMode: "bounded", allowedPaths: ["src"] }, fetchAsset: transfer(name, data) });
      assert.equal(prepared.kind, "changes", JSON.stringify(prepared));
      assert.equal(await fs.readFile(path.join(state.root, "src/retry.ts"), "utf8"), state.original, "inspection cannot mutate files");
      const result = await execute(prepared, state.root);
      assert.equal(result.status, "completed", JSON.stringify(result));
      assert.equal(await fs.readFile(path.join(state.root, "src/retry.ts"), "utf8"), updated);
      assert.equal(await fs.readFile(path.join(state.root, "README.md"), "utf8"), "Keep the existing project instructions.\n");
      assert.equal(await fs.stat(path.join(state.root, "dist")).then(() => true, () => false), false);
      const again = await prepareBrowserDeliverable(response([asset(name, data)]), { ...state.options, fetchAsset: transfer(name, data) });
      assert.equal(again.kind, "unchanged");
    } finally { await fs.rm(state.root, { recursive: true, force: true }); }
  });
}

for (const format of ["patch-asset", "inline-diff", "inline-file", "standalone-source"]) {
  test(`integrates ${format} without asking the user to copy files`, async () => {
    const state = await workspace();
    try {
      const text = "export const retryCount = 3;\n";
      const patch = "diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-export const retryCount = 2;\n+export const retryCount = 3;\n";
      let name = "change.patch", data = Buffer.from(patch), captured;
      if (format === "standalone-source") { name = "retry.ts"; data = Buffer.from(text); }
      captured = response([asset(name, data)]);
      if (format === "inline-diff") captured = response([], "Apply this patch", [{ type: "text", text: "Apply this patch:" }, { type: "codeBlock", language: "diff", text: patch }]);
      if (format === "inline-file") captured = response([], "Updated implementation", [{ type: "text", text: "### src/retry.ts" }, { type: "codeBlock", language: "typescript", text }]);
      const prepared = await prepareBrowserDeliverable(captured, { ...state.options, fetchAsset: transfer(name, data) });
      assert.equal(prepared.kind, "changes", JSON.stringify(prepared));
      assert.equal((await execute(prepared, state.root)).status, "completed");
      assert.equal(await fs.readFile(path.join(state.root, "src/retry.ts"), "utf8"), text);
    } finally { await fs.rm(state.root, { recursive: true, force: true }); }
  });
}

for (const malformed of [
  [{ name: "../escape.ts", text: "escape" }],
  [{ name: "/absolute.ts", text: "escape" }],
  [{ name: "C:\\escape.ts", text: "escape" }],
  [{ name: "src/link.ts", text: "elsewhere", mode: 0o120777 }],
  [{ name: "src/a.ts", text: "one" }, { name: "src/A.ts", text: "two" }],
  [{ name: "src/a.ts", text: "one" }, { name: "src/a.ts", text: "two" }],
  [{ name: "src/a.ts", text: "one", crc: 1 }],
  [{ name: "src/a.ts", text: "one", size: deliverableLimits.fileBytes + 1 }],
  [{ name: "src/a.ts", text: "one", flags: 1 }],
]) {
  test(`rejects invalid archive before writing: ${JSON.stringify(malformed)}`, async () => {
    await assert.rejects(readDeliverableZip(zip(malformed), new AbortController().signal));
  });
}
for (const name of ["../x", "a/../b", "./x", "a//b", "a/NUL.ts", "a/trailing.", "a/space ", "a\\b", "a:x", "a\u0000b", "x".repeat(513)]) {
  test(`portable path validation refuses ${JSON.stringify(name)}`, () => assert.throws(() => deliverablePath(name)));
}

for (const defect of ["missing-version", "stale-version", "late-edit", "symlink", "read-only", "scope", "mixed", "control-and-asset", "broken-zip", "unsupported-archive", "ambiguous-root", "binary"]) {
  test(`refuses ${defect} and preserves all workspace contents`, async () => {
    const state = await workspace();
    try {
      let name = "source.zip";
      let entries = [{ name: "src/retry.ts", text: "replacement" }, { name: "src/new.ts", text: "new" }];
      if (defect === "missing-version") state.options.references = new BrowserContextReferences();
      if (defect === "stale-version") await fs.writeFile(path.join(state.root, "src/retry.ts"), "independent user edit");
      if (defect === "symlink") { await fs.unlink(path.join(state.root, "src/retry.ts")); await fs.symlink(path.join(state.root, "README.md"), path.join(state.root, "src/retry.ts")); }
      if (defect === "read-only") state.options.mutationContext.readOnly = true;
      if (defect === "scope") state.options.mutationContext = { scopeMode: "bounded", allowedPaths: ["docs"] };
      if (defect === "control-and-asset") state.options.hasControlActions = true;
      if (defect === "ambiguous-root") { entries = entries.map((entry) => ({ ...entry, name: `export/${entry.name}` })); await fs.mkdir(path.join(state.root, "export")); }
      if (defect === "binary") entries[0].text = "binary\u0000payload";
      if (defect === "unsupported-archive") name = "source.tar.gz";
      const data = defect === "broken-zip" ? Buffer.from("not a zip") : zip(entries);
      const captured = response([asset(name, data)]);
      if (defect === "mixed") captured.segments = [{ type: "text", text: "### src/retry.ts" }, { type: "codeBlock", language: "typescript", text: "another representation" }];
      const before = await fs.readFile(path.join(state.root, "src/retry.ts"), "utf8");
      const prepared = await prepareBrowserDeliverable(captured, { ...state.options, fetchAsset: transfer(name, data) });
      if (defect === "late-edit") {
        assert.equal(prepared.kind, "changes");
        await fs.writeFile(path.join(state.root, "src/retry.ts"), "concurrent edit");
        assert.notEqual((await execute(prepared, state.root)).status, "completed");
        assert.equal(await fs.readFile(path.join(state.root, "src/retry.ts"), "utf8"), "concurrent edit");
      } else {
        assert.equal(prepared.kind, "correction", JSON.stringify(prepared));
        assert.equal(await fs.readFile(path.join(state.root, "src/retry.ts"), "utf8"), before);
      }
      assert.equal(await fs.stat(path.join(state.root, "src/new.ts")).then(() => true, () => false), false);
    } finally { await fs.rm(state.root, { recursive: true, force: true }); }
  });
}

test("missing captured downloads request correction; ordinary prose and examples remain inert", async () => {
  const state = await workspace();
  try {
    const options = { ...state.options, fetchAsset: async function* () { throw new Error("must not download"); } };
    assert.equal((await prepareBrowserDeliverable(response([], "[Updated sources](sandbox:/tmp/source.zip)"), options)).kind, "correction");
    assert.equal((await prepareBrowserDeliverable(response([], "The agents agree that the retry is correct."), options)).kind, "none");
    assert.equal((await prepareBrowserDeliverable(response([], "Example", [{ type: "text", text: "Example: do not apply this patch" }, { type: "codeBlock", language: "diff", text: "--- a/src/retry.ts" }]), options)).kind, "none");
  } finally { await fs.rm(state.root, { recursive: true, force: true }); }
});

for (const defect of ["wrong-id", "wrong-order", "wrong-size", "wrong-integrity", "incomplete", "after-complete", "oversized"]) {
  test(`refuses ${defect} asset transfer`, async () => {
    const data = Buffer.from("source"), metadata = asset("source.ts", data);
    const events = [];
    for await (const event of transfer(metadata.name, data)(metadata.id)) events.push(event);
    if (defect === "wrong-id") events[1].assetId = "another";
    if (defect === "wrong-order") events[1].sequence = 5;
    if (defect === "wrong-size") events[0].size = 5;
    if (defect === "wrong-integrity") events.at(-1).sha256 = "0".repeat(64);
    if (defect === "incomplete") events.pop();
    if (defect === "after-complete") events.push(events[1]);
    await assert.rejects(fetchDeliverableBytes(metadata, async function* () { yield* events; }, new AbortController().signal, defect === "oversized" ? 2 : 32));
  });
}

test("cancelled artifact inspection never produces an action", async () => {
  const state = await workspace();
  try {
    const controller = new AbortController(); controller.abort();
    const data = zip([{ name: "src/retry.ts", text: "update" }]);
    await assert.rejects(prepareBrowserDeliverable(response([asset("source.zip", data)]), { ...state.options, signal: controller.signal, fetchAsset: transfer("source.zip", data) }));
  } finally { await fs.rm(state.root, { recursive: true, force: true }); }
});

test("managed artifact execution retains the Bachata mutation lease and invalidates verification", async () => {
  const state = await workspace();
  try {
    let leases = 0;
    const options = { taskId: "retry-repair", originalTask: "Fix the retry limit in src/retry.ts", role: "worker", workingDirectory: state.root, writeScope: "workspace", allowedPaths: [], commitMode: "never", readOnly: false, verificationChecks: [], maxRevisionCycles: 2, deadlineAt: Date.now() + 30000, continuationMaxBytes: 65536, handoffTotalBudgetBytes: 262144, dependencyDepth: 1, promotionMaxBytes: 65536, signal: state.options.signal, executor: { timeoutMs: 5000, terminateGraceMs: 100, maxOutputBytes: 65536, maxReadBytes: 65536, maxSearchResults: 100 }, contextIndex: { maxInventoryFiles: 100, inventoryTimeoutMs: 5000, indexingTimeoutMs: 5000 }, contextSearch: { maxFiles: 100, maxBytes: 65536, maxFileBytes: 65536, timeoutMs: 5000 }, withWorkspaceMutation: async (operation) => { leases++; return await operation(); } };
    const turn = await prepareManagedBrowserTurn(options);
    turn.contextReferences.fileVersion("src/retry.ts", hash(state.original));
    const data = zip([{ name: "src/retry.ts", text: "export const retryCount = 3;\n" }]);
    const prepared = await prepareBrowserDeliverable(response([asset("source.zip", data)]), { ...state.options, references: turn.contextReferences, fetchAsset: transfer("source.zip", data) });
    assert.equal(prepared.kind, "changes");
    const revision = turn.workspaceRevision;
    const result = await executeManagedBrowserEnvelope(prepared.envelope, turn, options, async () => "approve");
    assert.equal(result.actionResults[0].status, "completed", JSON.stringify(result));
    assert.equal(leases, 1);
    assert.equal(turn.workspaceRevision, revision + 1);
    assert.deepEqual(turn.verification, []);
    assert.ok(turn.changedFiles.includes("src/retry.ts"));
    assert.match(result.nextPrompt, /completed/);
  } finally { await fs.rm(state.root, { recursive: true, force: true }); }
});

test("a missing baseline requests every affected existing file together and publishes nothing", async () => {
  const state = await workspace();
  try {
    await fs.writeFile(path.join(state.root, "src/backoff.ts"), "export const backoffMs = 100;\n");
    const data = zip([{ name: "src/retry.ts", text: "export const retryCount = 3;\n" }, { name: "src/backoff.ts", text: "export const backoffMs = 250;\n" }]);
    const result = await prepareBrowserDeliverable(response([asset("source.zip", data)]), { ...state.options, references: new BrowserContextReferences(), fetchAsset: transfer("source.zip", data) });
    assert.equal(result.kind, "correction");
    assert.match(result.message, /src\/retry.ts/); assert.match(result.message, /src\/backoff.ts/);
    assert.equal(await fs.readFile(path.join(state.root, "src/retry.ts"), "utf8"), state.original);
  } finally { await fs.rm(state.root, { recursive: true, force: true }); }
});

test("archives exceeding the entry ceiling are refused before entry processing", async () => {
  const data = zip(Array.from({ length: deliverableLimits.entries + 1 }, (_, i) => ({ name: `src/file-${i}.ts`, text: "" })));
  await assert.rejects(readDeliverableZip(data, new AbortController().signal), /too many archive entries/);
});

test("filesystem refusals do not expose absolute controller workspace paths", async () => {
  const state = await workspace();
  try {
    const data = zip([{ name: "src/retry.ts", text: "export const retries = 4;\n" }]);
    const missingRoot = path.join(state.root, "missing-workspace");
    const prepared = await prepareBrowserDeliverable(response([asset("source.zip", data)]), { ...state.options, workingDirectory: missingRoot, fetchAsset: transfer("source.zip", data) });
    assert.equal(prepared.kind, "correction");
    assert.ok(!prepared.message.includes(state.root));
    assert.match(prepared.message, /could not be inspected/);
  } finally { await fs.rm(state.root, { recursive: true, force: true }); }
});
