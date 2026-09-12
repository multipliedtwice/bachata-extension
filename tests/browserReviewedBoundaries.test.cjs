const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { BrowserContextReferences } = require("../dist/browser/contextReferences.js");
const { captureManagedRepositoryBaseline, prepareManagedBrowserTurn, executeManagedBrowserControl, executeManagedBrowserEnvelope, isSupportedManagedContextAttachmentPath } = require("../dist/browser/managedTurn.js");
const { assertBrowserAttachmentSource, browserAttachmentPath, isBrowserSourcePath } = require("../dist/browser/sourceTransferPolicy.js");
const { isSupportedBrowserAttachmentPath } = require("../dist/adapters/browserProvider.js");
const { MANAGED_WORKSPACE_INTEGRITY_COMMAND } = require("../dist/orchestrator/verificationPolicy.js");

const optionsFor = (root) => ({
  taskId: "review-browser-boundaries", originalTask: "Repair the retry count in src/retry.ts and preserve unrelated changes.",
  role: "worker", workingDirectory: root, writeScope: "configured", allowedPaths: ["src"], readPaths: ["src"], protectedPaths: [],
  commitMode: "never", readOnly: false, verificationChecks: [{ id: "integrity", command: MANAGED_WORKSPACE_INTEGRITY_COMMAND }],
  maxRevisionCycles: 1, deadlineAt: Date.now() + 60000, continuationMaxBytes: 65536, handoffTotalBudgetBytes: 262144,
  dependencyDepth: 1, promotionMaxBytes: 786432, signal: new AbortController().signal,
  executor: { timeoutMs: 10000, terminateGraceMs: 1000, maxOutputBytes: 1048576, maxReadBytes: 1048576, maxSearchResults: 100 },
  contextIndex: { maxInventoryFiles: 10000, inventoryTimeoutMs: 10000, indexingTimeoutMs: 10000 },
  contextSearch: { maxFiles: 100, maxBytes: 1048576, maxFileBytes: 1048576, timeoutMs: 10000 },
});
const envelope = (actions, status = "needContext") => ({ protocol: "bachata-browser-turn-v1", status, actions, summary: "Inspect retry recovery", objections: [], unresolved: [] });
const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const createWorkspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-reviewed-browser-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/retry.ts"), "export const attempts = 1;\n");
  return root;
};

test("patch completion and managed reinjection omit internal patch identity while stale checks still apply", async () => {
  const root = createWorkspace();
  try {
    const options = optionsFor(root);
    const turn = await prepareManagedBrowserTurn(options);
    await executeManagedBrowserEnvelope(envelope([{ kind: "context.fileVersion", path: "src/retry.ts" }]), turn, options, async () => "approve");
    const source = fs.readFileSync(path.join(root, "src/retry.ts"), "utf8");
    const sourceDigest = crypto.createHash("sha256").update(source).digest("hex");
    const version = turn.contextReferences.fileVersion("src/retry.ts", sourceDigest);
    const patch = "diff --git a/src/retry.ts b/src/retry.ts\n--- a/src/retry.ts\n+++ b/src/retry.ts\n@@ -1 +1 @@\n-export const attempts = 1;\n+export const attempts = 2;\n";
    const patchDigest = crypto.createHash("sha256").update(patch).digest("hex");
    const control = "```bachata-control\n" + JSON.stringify(envelope([{ kind: "workspace.applyPatch", patch, expectedFiles: [{ path: "src/retry.ts", fileVersion: version }] }], "applyPatch")) + "\n```";
    const result = await executeManagedBrowserControl(control, turn, options, async () => "approve");
    assert.equal(result.recognized, true);
    assert.equal(result.actionResults[0].status, "completed");
    assert.equal(result.actionResults[0].summary, "Apply workspace patch");
    assert.equal(fs.readFileSync(path.join(root, "src/retry.ts"), "utf8"), "export const attempts = 2;\n");
    for (const message of [result.nextPrompt, new BrowserContextReferences(root).render({ results: result.actionResults })]) {
      assert.ok(message.includes("Apply workspace patch"));
      for (const internal of [patchDigest, patchDigest.slice(0, 12), sourceDigest]) assert.ok(!message.includes(internal));
    }
    const stale = await executeManagedBrowserControl(control, turn, options, async () => "approve");
    assert.notEqual(stale.actionResults[0].status, "completed");
    assert.equal(fs.readFileSync(path.join(root, "src/retry.ts"), "utf8"), "export const attempts = 2;\n");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("repository history policy retains failure and recovery meaning without identities in handoff, results or metadata", async () => {
  const root = createWorkspace();
  try {
    git(root, "init", "--quiet");
    git(root, "config", "user.name", "Boundary fixture");
    git(root, "config", "user.email", "fixture@example.invalid");
    git(root, "add", "src/retry.ts");
    git(root, "commit", "--quiet", "-m", "initial retry");
    const options = optionsFor(root);
    options.repositoryBaseline = await captureManagedRepositoryBaseline(root, options.signal);
    git(root, "commit", "--quiet", "--allow-empty", "-m", "independent repository change");
    const current = git(root, "rev-parse", "HEAD");
    assert.notEqual(current, options.repositoryBaseline.head);
    const turn = await prepareManagedBrowserTurn(options);
    const metadata = await executeManagedBrowserEnvelope(envelope([{ kind: "context.readMetadata", field: "policyViolations" }]), turn, options, async () => "approve");
    const verification = await executeManagedBrowserEnvelope(envelope([{ kind: "verification.run", checkIds: ["integrity"] }], "verify"), turn, options, async () => "approve");
    assert.equal(verification.verification[0].status, "failed");
    const verificationMetadata = await executeManagedBrowserEnvelope(envelope([{ kind: "context.readMetadata", field: "verification" }]), turn, options, async () => "approve");
    for (const message of [turn.prompt, metadata.nextPrompt, verification.nextPrompt, verificationMetadata.nextPrompt]) {
      assert.match(message, /Repository history changed after the managed task started/);
      assert.match(message, /Restart the task against the current workspace/);
      assert.ok(!message.includes(options.repositoryBaseline.head));
      assert.ok(!message.includes(current));
    }
    assert.equal(options.repositoryBaseline.head.length > 0, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const relative of ["node_modules/pkg/reference", "NODE_MODULES/pkg/reference", "nested/dist/reference", "build/reference", ".cache/reference", "cypress/screenshots/reference"]) {
  test(`outside-workspace attachment excludes ${relative} in both providers and stored metadata`, () => {
    for (const windows of [false, true]) {
      const root = windows ? "C:\\work\\project" : "/work/project";
      const base = windows ? "D:\\external\\" + relative.replaceAll("/", "\\") : "/external/" + relative;
      assert.equal(isSupportedBrowserAttachmentPath(base + ".png", root), false);
      assert.equal(isSupportedManagedContextAttachmentPath(base + ".ts", root), false);
      assert.throws(() => assertBrowserAttachmentSource(base + ".png", [{ name: "reference.png", relativePath: "reference.png" }], root), /excludes/);
      assert.equal(isBrowserSourcePath(browserAttachmentPath(base + ".ts")), false);
    }
  });
}

for (const ancestor of ["build", "dist"]) {
  test(`workspace under ${ancestor} accepts source attachments but rejects excluded children and redirected files`, async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-attachment-policy-"));
    const root = path.join(parent, ancestor, "project");
    const excluded = path.join(parent, "outside", "node_modules", "pkg");
    try {
      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      fs.mkdirSync(excluded, { recursive: true });
      fs.writeFileSync(path.join(root, "src/retry.ts"), "export const attempts = 2;\n");
      fs.writeFileSync(path.join(excluded, "reference.ts"), "EXCLUDED_REFERENCE\n");
      const accepted = path.join(root, "src/retry.ts");
      assert.equal(isSupportedManagedContextAttachmentPath(accepted, root), true);
      assert.equal(isSupportedBrowserAttachmentPath(path.join(root, "src/reference.png"), root), true);
      assert.doesNotThrow(() => assertBrowserAttachmentSource(accepted, [], root));
      assert.equal(isSupportedManagedContextAttachmentPath(path.join(root, "dist/retry.ts"), root), false);
      const options = { ...optionsFor(root), contextAttachments: [accepted] };
      const turn = await prepareManagedBrowserTurn(options);
      assert.ok(turn.prompt.includes("export const attempts = 2;"));
      await assert.rejects(prepareManagedBrowserTurn({ ...options, contextAttachments: [path.join(excluded, "reference.ts")] }), /excludes/);
      fs.symlinkSync(excluded, path.join(root, "linked"), "dir");
      await assert.rejects(prepareManagedBrowserTurn({ ...options, contextAttachments: [path.join(root, "linked/reference.ts")] }), /excludes/);
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });
}


test("external UNC shares and original Windows attachment names retain directory exclusions", () => {
  const external = String.raw`\\server\node_modules\package\reference.png`;
  assert.equal(isSupportedBrowserAttachmentPath(external, String.raw`C:\work\project`), false);
  assert.equal(isSupportedBrowserAttachmentPath(String.raw`\\server\build\project\src\reference.png`, String.raw`\\server\build\project`), true);
  assert.throws(() => assertBrowserAttachmentSource(String.raw`C:\snapshots\internal.png`, [{ name: "dist/reference.png", relativePath: "attachments/internal.png" }], String.raw`C:\work\project`), /excludes/);
});
