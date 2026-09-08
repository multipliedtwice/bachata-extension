const assert = require("node:assert/strict");
const test = require("node:test");

const { extractBrowserControlEnvelope, extractBrowserControlEnvelopeFromCaptured } = require("../dist/browser/controlProtocol.js");

const envelope = JSON.stringify({
  protocol: "bachata-browser-turn-v1",
  status: "applyPatch",
  actions: [{ kind: "workspace.applyPatch", patch: "diff --git a/a b/a\n", expectedFiles: [] }],
  summary: "apply",
  objections: [],
  unresolved: [],
});

test("only a final explicit bachata-control fence is executable", () => {
  assert.equal(extractBrowserControlEnvelope(`Example only:\n\n\`\`\`json\n${envelope}\n\`\`\`\nDo not execute.`), undefined);
  assert.equal(extractBrowserControlEnvelope(`\`\`\`\n${envelope}\n\`\`\``), undefined);
  assert.equal(extractBrowserControlEnvelope(envelope), undefined);
  assert.equal(extractBrowserControlEnvelope(`\`\`\`bachata-control\n${envelope}\n\`\`\`\nTrailing prose`), undefined);
  assert.equal(extractBrowserControlEnvelope(`Explanation\n\`\`\`bachata-control\n${envelope}\n\`\`\`   \n`)?.status, "applyPatch");
  assert.equal(
    extractBrowserControlEnvelope(`Example:\n\`\`\`bachata-control\n${envelope}\n\`\`\`\nFinal:\n\`\`\`bachata-control\n${envelope}\n\`\`\``)?.status,
    "applyPatch",
  );
});


test("structured browser code-block segments preserve managed control envelopes", () => {
  const captured = {
    text: envelope,
    segments: [
      { type: "text", text: "Review complete." },
      { type: "codeBlock", text: envelope, language: "bachata-control" },
    ],
  };
  assert.equal(extractBrowserControlEnvelopeFromCaptured(captured)?.status, "applyPatch");
});

test("only the final meaningful bachata-control code block is executable from structured capture", () => {
  assert.equal(
    extractBrowserControlEnvelopeFromCaptured({
      text: envelope,
      segments: [
        { type: "codeBlock", text: envelope, language: "bachata-control" },
        { type: "text", text: "Trailing prose" },
      ],
    }),
    undefined,
  );
  assert.equal(
    extractBrowserControlEnvelopeFromCaptured({
      text: envelope,
      segments: [{ type: "codeBlock", text: envelope, language: "json" }],
    }),
    undefined,
  );
});

test("managed context actions accept bounded list pagination and ranged reads", () => {
  const rangedEnvelope = JSON.stringify({
    protocol: "bachata-browser-turn-v1",
    status: "needContext",
    actions: [
      { kind: "context.list", path: "src", cursor: "256", limit: 128 },
      { kind: "context.readFile", path: "src/large.ts", startLine: 500, endLine: 750 },
    ],
    summary: "more context",
    objections: [],
    unresolved: [],
  });
  const parsed = extractBrowserControlEnvelope(`\`\`\`bachata-control\n${rangedEnvelope}\n\`\`\``);
  assert.equal(parsed?.status, "needContext");
  assert.deepEqual(parsed?.actions[0], { kind: "context.list", path: "src", cursor: "256", limit: 128 });
  assert.deepEqual(parsed?.actions[1], { kind: "context.readFile", path: "src/large.ts", startLine: 500, endLine: 750 });
});

test("managed context search accepts continuation cursors and explicit full-file hashes", () => {
  const contextEnvelope = JSON.stringify({
    protocol: "bachata-browser-turn-v1",
    status: "needContext",
    actions: [
      { kind: "context.search", query: "createRuntime", pathPrefix: "src", cursor: "v1:abcdef123456:2000" },
      { kind: "context.hashFile", path: "src/runtime/createRuntime.ts" },
    ],
    summary: "continue search and authorize a later patch",
    objections: [],
    unresolved: [],
  });
  const parsed = extractBrowserControlEnvelope(`\`\`\`bachata-control\n${contextEnvelope}\n\`\`\``);
  assert.equal(parsed?.status, "needContext");
  assert.deepEqual(parsed?.actions[0], {
    kind: "context.search",
    query: "createRuntime",
    pathPrefix: "src",
    cursor: "v1:abcdef123456:2000",
  });
  assert.deepEqual(parsed?.actions[1], { kind: "context.hashFile", path: "src/runtime/createRuntime.ts" });
});

test("managed context search rejects oversized continuation cursors", () => {
  const contextEnvelope = JSON.stringify({
    protocol: "bachata-browser-turn-v1",
    status: "needContext",
    actions: [{ kind: "context.search", query: "needle", cursor: "x".repeat(257) }],
    summary: "invalid cursor",
    objections: [],
    unresolved: [],
  });
  assert.equal(extractBrowserControlEnvelope(`\`\`\`bachata-control\n${contextEnvelope}\n\`\`\``), undefined);
});

test("managed context paging accepts task bytes and handoff metadata offsets", () => {
  const contextEnvelope = JSON.stringify({
    protocol: "bachata-browser-turn-v1",
    status: "needContext",
    actions: [
      { kind: "context.readTask", offsetBytes: 16384, maxBytes: 8192 },
      { kind: "context.readMetadata", field: "preexistingChangedFiles", offset: 64, limit: 32 },
    ],
    summary: "continue bounded handoff state",
    objections: [],
    unresolved: [],
  });
  const parsed = extractBrowserControlEnvelope(`\`\`\`bachata-control\n${contextEnvelope}\n\`\`\``);
  assert.equal(parsed?.status, "needContext");
  assert.deepEqual(parsed?.actions[0], { kind: "context.readTask", offsetBytes: 16384, maxBytes: 8192 });
  assert.deepEqual(parsed?.actions[1], {
    kind: "context.readMetadata",
    field: "preexistingChangedFiles",
    offset: 64,
    limit: 32,
  });
});

test("managed context paging rejects invalid task and metadata ranges", () => {
  for (const action of [
    { kind: "context.readTask", offsetBytes: -1 },
    { kind: "context.readTask", maxBytes: 16385 },
    { kind: "context.readMetadata", field: "unknown", offset: 0, limit: 1 },
    { kind: "context.readMetadata", field: "changedFiles", offset: -1, limit: 1 },
    { kind: "context.readMetadata", field: "changedFiles", offset: 0, limit: 129 },
  ]) {
    const contextEnvelope = JSON.stringify({
      protocol: "bachata-browser-turn-v1",
      status: "needContext",
      actions: [action],
      summary: "invalid paging",
      objections: [],
      unresolved: [],
    });
    assert.equal(extractBrowserControlEnvelope(`\`\`\`bachata-control\n${contextEnvelope}\n\`\`\``), undefined);
  }
});

test("managed dependency graph actions are explicit bounded context operations", () => {
  const contextEnvelope = JSON.stringify({
    protocol: "bachata-browser-turn-v1",
    status: "needContext",
    actions: [
      { kind: "context.dependencies", path: "talents-backend/src/routes/jobs.ts" },
      { kind: "context.dependents", path: "talents-backend/src/services/jobService.ts", cursor: "v1:abcdef123456:12" },
    ],
    summary: "inspect dependency graph",
    objections: [],
    unresolved: [],
  });
  const parsed = extractBrowserControlEnvelope(`\`\`\`bachata-control\n${contextEnvelope}\n\`\`\``);
  assert.deepEqual(parsed?.actions, [
    { kind: "context.dependencies", path: "talents-backend/src/routes/jobs.ts" },
    { kind: "context.dependents", path: "talents-backend/src/services/jobService.ts", cursor: "v1:abcdef123456:12" },
  ]);
});

test("managed writes and deletes require explicit structured preconditions", () => {
  const hash = "a".repeat(64);
  const writeNew = JSON.stringify({
    protocol: "bachata-browser-turn-v1",
    status: "applyPatch",
    actions: [{ kind: "workspace.write", path: "src/new.ts", content: "export {};\n", expectedFiles: [] }],
    summary: "create file",
    objections: [],
    unresolved: [],
  });
  assert.equal(extractBrowserControlEnvelope(`\`\`\`bachata-control\n${writeNew}\n\`\`\``)?.actions[0].kind, "workspace.write");

  const writeExisting = JSON.stringify({
    protocol: "bachata-browser-turn-v1",
    status: "applyPatch",
    actions: [{ kind: "workspace.write", path: "src/existing.ts", content: "export {};\n", expectedFiles: [{ path: "src/existing.ts", sha256: hash }] }],
    summary: "replace file",
    objections: [],
    unresolved: [],
  });
  assert.equal(extractBrowserControlEnvelope(`\`\`\`bachata-control\n${writeExisting}\n\`\`\``)?.actions[0].kind, "workspace.write");

  const deleteExisting = JSON.stringify({
    protocol: "bachata-browser-turn-v1",
    status: "applyPatch",
    actions: [{ kind: "workspace.delete", path: "src/existing.ts", expectedFiles: [{ path: "src/existing.ts", sha256: hash }] }],
    summary: "delete file",
    objections: [],
    unresolved: [],
  });
  assert.equal(extractBrowserControlEnvelope(`\`\`\`bachata-control\n${deleteExisting}\n\`\`\``)?.actions[0].kind, "workspace.delete");

  const deleteWithoutHash = JSON.stringify({
    protocol: "bachata-browser-turn-v1",
    status: "applyPatch",
    actions: [{ kind: "workspace.delete", path: "src/existing.ts", expectedFiles: [] }],
    summary: "unsafe delete",
    objections: [],
    unresolved: [],
  });
  assert.equal(extractBrowserControlEnvelope(`\`\`\`bachata-control\n${deleteWithoutHash}\n\`\`\``), undefined);
});
