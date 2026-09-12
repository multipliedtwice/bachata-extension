const assert = require("node:assert/strict");
const test = require("node:test");
const { BrowserContextReferences } = require("../dist/browser/contextReferences.js");
const { extractBrowserControlEnvelope } = require("../dist/browser/controlProtocol.js");
const { extractBrowserActions } = require("../dist/browser/actions.js");
const { isBrowserSourcePath, browserAttachmentPath, assertBrowserAttachmentSource, browserSourceDiff } = require("../dist/browser/sourceTransferPolicy.js");
const { composeAgentPrompt, browserCandidateReference, browserControllerEvidence } = require("../dist/runtime/browserPromptContracts.js");
const { managedLeadDecision, managedLeadReviewPrompt, managedWorkerRevisionPrompt } = require("../dist/runtime/managedLeadReview.js");
const digest = "a".repeat(64);
const control = (action) => `\`\`\`bachata-control\n${JSON.stringify({ protocol: "bachata-browser-turn-v1", status: "applyPatch", summary: "Repair the retry boundary", actions: [action], objections: [], unresolved: [] })}\n\`\`\``;

for (const kind of ["workspace.write", "workspace.delete", "workspace.applyPatch"]) {
  test(`${kind} only accepts an issued full-file version in both browser protocols`, () => {
    const references = new BrowserContextReferences();
    const full = references.fileVersion("src/retry.ts", digest);
    const range = references.fileVersion("src/retry.ts", digest, "range");
    const otherTurn = new BrowserContextReferences();
    const foreign = otherTurn.fileVersion("src/retry.ts", digest);
    const base = { kind, ...(kind === "workspace.applyPatch" ? { patch: "--- a/src/retry.ts\n+++ b/src/retry.ts\n" } : { path: "src/retry.ts", ...(kind === "workspace.write" ? { content: "replacement" } : {}) }) };
    const entries = [
      { path: "src/retry.ts", sha256: digest },
      { path: "src/retry.ts", sha256: digest, fileVersion: full },
      { path: "src/retry.ts", fileVersion: "unissued-version" },
      { path: "src/other.ts", fileVersion: full },
      { path: "src/retry.ts", fileVersion: range },
      { path: "src/retry.ts", fileVersion: foreign },
    ];
    for (const [index, entry] of [...entries, { path: "src/retry.ts", fileVersion: full }].entries()) {
      const expected = index === entries.length;
      const action = { ...base, expectedFiles: [entry] };
      assert.equal(Boolean(extractBrowserControlEnvelope(control(action), references)), expected, JSON.stringify(entry));
      const text = JSON.stringify({ ...action, turnToken: "issued-turn" });
      const segments = [{ type: "codeBlock", language: "bachata-action", text, start: 0, end: text.length }];
      const parsed = extractBrowserActions(text, segments, "issued-turn", references);
      assert.equal(parsed.length, expected ? 1 : 0, JSON.stringify(entry));
      if (expected) assert.deepEqual(parsed[0].expectedFiles, [{ path: "src/retry.ts", sha256: digest }]);
    }
  });
}

test("snippet references are scoped to their issuing turn and raw snippet IDs are refused", () => {
  const first = new BrowserContextReferences(), second = new BrowserContextReferences();
  const entry = { id: "internal-snippet", path: "src/retry.ts", sha256: digest, text: digest };
  const a = JSON.parse(first.render(entry)), b = JSON.parse(second.render(entry));
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.fileVersion, b.fileVersion);
  assert.equal(second.snippetId(a.id), undefined);
  assert.equal(first.snippetId(entry.id), undefined);
  assert.equal(a.text, digest);
});

test("optional programmatic browser Lead receives both contracts and verdicts resolve locally", () => {
  const root = "/Users/example/build/project";
  const references = new BrowserContextReferences(root);
  const candidate = browserCandidateReference(references, digest);
  const evidence = browserControllerEvidence([{ id: "typecheck", command: `${root}/scripts/check`, status: "passed", output: `${root}/src/retry.ts passed`, exitCode: 0 }], root);
  const controllerContract = managedLeadReviewPrompt({ candidate, issues: [], evidence });
  const task = "Review the retry implementation and report actionable findings.";
  const workspaceProtocol = "Bachata browser fallback workspace protocol:\nRead: workspace.read\nWrite: workspace.write";
  const prompt = composeAgentPrompt({ task, controllerContract, workspaceProtocol });
  assert.ok(prompt.startsWith(task));
  assert.match(prompt, /Bachata managed review contract/);
  assert.match(prompt, /browser fallback workspace protocol/);
  assert.match(prompt, /typecheck/);
  assert.ok(prompt.includes(candidate));
  assert.ok(!prompt.includes(digest));
  assert.ok(!prompt.includes(root));
  const verdict = (reference, currentCandidate = digest) => managedLeadDecision({ answer: JSON.stringify({ candidate: reference, review: { verdict: "accept", summary: "Retry guard is correct", defects: [] } }), candidate: digest, currentCandidate, resolveCandidate: (ref) => references.objectValue("candidate", ref) });
  assert.equal(verdict(candidate).decision, "accept");
  assert.equal(verdict(digest).decision, "invalid");
  assert.equal(verdict("unissued").decision, "invalid");
  assert.equal(verdict(candidate, "b".repeat(64)).decision, "invalid");
  for (const rejected of [verdict(digest), verdict(candidate, "b".repeat(64))]) {
    assert.ok(!JSON.stringify(rejected).includes(digest));
    assert.ok(!JSON.stringify(rejected).includes("b".repeat(64)));
  }
  assert.equal(verdict(browserCandidateReference(new BrowserContextReferences(), digest)).decision, "invalid");
  const revision = managedWorkerRevisionPrompt({ candidate, summary: "Fix the boundary", defects: [], evidence });
  assert.ok(!revision.includes(digest)); assert.ok(!revision.includes(root));
  const userLiteral = `Keep this literal ${digest} and ${root} in the example source.`;
  assert.ok(composeAgentPrompt({ task: userLiteral, controllerContract, workspaceProtocol }).startsWith(userLiteral));
});

test("handoff metadata removes internal identities without changing user task or source literals", () => {
  const root = "/Users/example/project", references = new BrowserContextReferences(root);
  const literal = `${root} ${digest}`;
  const rendered = JSON.parse(references.render({ originalTask: literal, text: literal, workspaceRoot: root, worktreePath: root, repositoryBaseline: { head: digest }, taskHash: digest, workspaceFingerprint: digest, taskId: digest, results: [{ summary: `${root}/src/retry.ts`, error: `Cannot read ${root}/src/retry.ts` }] }));
  assert.equal(rendered.originalTask, literal); assert.equal(rendered.text, literal);
  assert.equal(rendered.worktreePath, "."); assert.equal(rendered.workspaceRoot, ".");
  assert.equal(rendered.repositoryBaseline, undefined); assert.equal(rendered.taskHash, undefined); assert.equal(rendered.workspaceFingerprint, undefined);
  assert.notEqual(rendered.taskId, digest); assert.equal(references.objectValue("taskId", rendered.taskId), digest);
  assert.equal(rendered.results[0].summary, "./src/retry.ts");
});

for (const name of ["node_modules/a.ts", "NODE_MODULES/a.ts", "x\\dist\\out.js", ".git/config", ".bachata/state.json", ".cache/result.ts", "target/release/out", "test-results/run.json", "cypress/videos/run.webm", "yarn.lock", "go.sum", "Podfile.lock", "Package.resolved", "app.VSIX", "source.ZIP", "installer.DMG", "installer.exe", "source.js.map", "screen.webm", ".YARN/cache/a.ts", ".gradle/cache/a.ts", "allure-results/result.json", "a.JAR", "a.whl", "a.nupkg", "a.CAB", "a.iso", "a.tbz2"]) {
  test(`source-transfer rejects ${name}`, () => assert.equal(isBrowserSourcePath(name), false));
}
for (const root of ["/Users/example/build/project", "/Users/example/dist/project", "C:\\build\\project", "C:\\dist\\project"]) {
  test(`absolute ancestor is not a logical exclusion: ${root}`, () => {
    const separator = root.startsWith("C:") ? "\\" : "/";
    assert.equal(isBrowserSourcePath(browserAttachmentPath(`${root}${separator}src${separator}retry.ts`, root)), true);
    assert.equal(isBrowserSourcePath(browserAttachmentPath(`${root}${separator}dist${separator}retry.ts`, root)), false);
    assert.doesNotThrow(() => assertBrowserAttachmentSource(`${root}${separator}snapshots${separator}internal.ts`, [{ name: "retry.ts", relativePath: "snapshots/internal.ts" }], root));
  });
}

test("stored original attachment names cannot hide generated artifacts behind snapshot IDs", () => {
  for (const name of ["source.zip", "trace.webm", "package-lock.json", "installer.exe", "out.js.map"]) {
    assert.throws(() => assertBrowserAttachmentSource("/tmp/snapshots/id.txt", [{ name, relativePath: "snapshots/id.txt" }]));
  }
});

test("unrecognized and quoted diff headers never transfer unchecked source", () => {
  for (const header of ['diff --git "a/dist/file.js" "b/dist/file.js"', "--- /outside/file", "diff --cc file"]) {
    assert.equal(browserSourceDiff(`${header}\nUNSAFE_PAYLOAD\n`), "");
  }
});
