const assert = require("node:assert/strict");
const test = require("node:test");

const {
  sanitizedBrowserAction,
  sanitizedBrowserActionResult,
  sanitizedCapturedAsset,
  toJsonValue,
} = require("../dist/runtime/browserActionRedaction.js");

// EX-AUD-12. Everything below decides what leaves the runtime for an approval prompt or the
// run ledger. The inputs are model output, so each text field must be redacted, and a field
// that was absent must not appear as an empty redacted string.

const secret = "API_KEY=secret-value";

const action = (overrides = {}) => ({
  id: "action-1",
  fingerprint: "fp",
  kind: "workspace.write",
  risk: "mutating",
  origin: "structured",
  confidence: "explicit",
  source: { start: 0, end: 4, text: secret },
  ...overrides,
});

test("a minimal action redacts its source text and adds nothing", () => {
  const value = sanitizedBrowserAction(action());
  assert.equal(value.source.text.includes("secret-value"), false);
  assert.equal(Object.hasOwn(value, "command"), false);
  assert.equal(Object.hasOwn(value, "query"), false);
  assert.equal(Object.hasOwn(value, "content"), false);
  assert.equal(Object.hasOwn(value, "patch"), false);
});

test("every text-bearing field is redacted when present", () => {
  const value = sanitizedBrowserAction(
    action({ command: secret, query: secret, content: secret, patch: secret }),
  );
  for (const field of ["command", "query", "patch"]) {
    assert.equal(value[field].includes("secret-value"), false, field);
  }
  assert.equal(value.content.includes("secret-value"), false);
});

test("an empty field is carried as it was, with nothing to redact", () => {
  // `content` is guarded on `!== undefined` and the others on truthiness, so an empty string
  // takes a different path through each. Both paths keep the field the action already had.
  assert.equal(sanitizedBrowserAction(action({ content: "" })).content, "");
  const blank = sanitizedBrowserAction(action({ command: "", query: "", patch: "" }));
  assert.equal(blank.command, "");
  assert.equal(blank.query, "");
  assert.equal(blank.patch, "");
});

test("an execution result redacts its summary and only the streams it has", () => {
  const bare = sanitizedBrowserActionResult({
    actionId: "action-1",
    status: "completed",
    summary: secret,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(bare.summary.includes("secret-value"), false);
  assert.equal(Object.hasOwn(bare, "stdout"), false);
  assert.equal(Object.hasOwn(bare, "stderr"), false);

  const full = sanitizedBrowserActionResult({
    actionId: "action-1",
    status: "failed",
    summary: "ok",
    stdout: secret,
    stderr: secret,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(full.stdout.includes("secret-value"), false);
  assert.equal(full.stderr.includes("secret-value"), false);
});

test("a sanitized asset carries no provider identifier and no source origin", () => {
  const value = sanitizedCapturedAsset({
    id: "asset-1",
    provider: "chatgpt",
    kind: "image",
    name: "diagram.png",
    mimeType: "image/png",
    size: 12,
    sourceElement: "assistantMessage",
    providerAssetId: "file-1",
    downloadAvailable: true,
    previewText: "preview",
    sourceOrigin: "https://cdn.example.invalid",
  });
  assert.equal(Object.hasOwn(value, "providerAssetId"), false);
  assert.equal(Object.hasOwn(value, "sourceOrigin"), false);
  assert.deepEqual(Object.keys(value).sort(), [
    "downloadAvailable",
    "id",
    "kind",
    "mimeType",
    "name",
    "previewText",
    "provider",
    "size",
    "sourceElement",
  ]);
});

test("an asset without optional fields produces no placeholder keys", () => {
  // A file name is free-form text, so it is redacted with the free-form rules rather than
  // the assignment rules a command line needs.
  const value = sanitizedCapturedAsset({
    id: "asset-1",
    provider: "claude",
    kind: "generatedFile",
    name: "ghp_123456789012345678901234567890.txt",
    sourceElement: "artifactPane",
    downloadAvailable: false,
  });
  assert.equal(Object.hasOwn(value, "mimeType"), false);
  assert.equal(Object.hasOwn(value, "size"), false);
  assert.equal(Object.hasOwn(value, "previewText"), false);
  assert.equal(value.name.includes("ghp_123456789012345678901234567890"), false);
});

test("conversion to a JSON value drops what JSON cannot carry", () => {
  assert.deepEqual(toJsonValue({ kept: 1, dropped: undefined }), { kept: 1 });
  assert.deepEqual(toJsonValue([1, "two", null]), [1, "two", null]);
});
