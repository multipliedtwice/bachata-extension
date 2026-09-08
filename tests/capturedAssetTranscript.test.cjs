const assert = require("node:assert/strict");
const test = require("node:test");

const {
  findCapturedAsset,
  parsedCapturedAssetKeys,
  parseCapturedAsset,
} = require("../dist/runtime/capturedAssetTranscript.js");
const {
  browserAssetMetadataLimits,
  validCapturedAssetFields,
} = require("../dist/browser/protocol.js");

// EX-AUD-12. Reading an asset back out of a persisted transcript decides what the save
// dialog is allowed to name and act on. It used to be reachable only through a whole
// runtime, and it now shares one field rule set with the wire parser.

const asset = (overrides = {}) => ({
  id: "asset-1",
  provider: "chatgpt",
  kind: "image",
  name: "diagram.png",
  sourceElement: "assistantMessage",
  downloadAvailable: true,
  ...overrides,
});

test("a minimal record parses and keeps only declared protocol fields", () => {
  assert.deepEqual(parseCapturedAsset(asset()), asset());
  const parsed = parseCapturedAsset({ ...asset(), unexpected: "dropped" });
  assert.deepEqual(parsed, asset());
  assert.equal(
    Object.keys(parsed).every((key) => parsedCapturedAssetKeys.includes(key)),
    true,
  );
});

// A message from the browser carrying an undeclared key is refused by the wire parser. A
// stored record carrying one was written by Bachata itself under another build, so it is read
// rather than refused — and the undeclared key still never reaches a caller.
test("an undeclared key is tolerated in stored state and dropped from the result", () => {
  const stored = { ...asset(), legacyThumbnailUrl: "https://cdn.example.invalid/x.png" };
  assert.equal(validCapturedAssetFields(stored), true);
  assert.equal(Object.hasOwn(parseCapturedAsset(stored), "legacyThumbnailUrl"), false);
});

test("every optional field survives a round trip when present", () => {
  const full = asset({
    mimeType: "image/png",
    size: 12,
    providerAssetId: "file-1",
    previewText: "preview",
    sourceOrigin: "https://cdn.example.invalid",
  });
  assert.deepEqual(parseCapturedAsset(full), full);
});

test("a record that is not an object is refused", () => {
  for (const value of [undefined, null, "asset", 7, [], [asset()]]) {
    assert.equal(parseCapturedAsset(value), undefined, JSON.stringify(value ?? null));
  }
});

test("a required string that is only whitespace is refused", () => {
  for (const blank of ["", " ", "   ", "\t", "\n"]) {
    assert.equal(parseCapturedAsset(asset({ id: blank })), undefined, `id ${JSON.stringify(blank)}`);
    assert.equal(
      parseCapturedAsset(asset({ name: blank })),
      undefined,
      `name ${JSON.stringify(blank)}`,
    );
  }
});

test("an optional bounded string that is present must carry something", () => {
  for (const blank of ["", "   "]) {
    assert.equal(
      parseCapturedAsset(asset({ mimeType: blank })),
      undefined,
      `mimeType ${JSON.stringify(blank)}`,
    );
    assert.equal(
      parseCapturedAsset(asset({ providerAssetId: blank })),
      undefined,
      `providerAssetId ${JSON.stringify(blank)}`,
    );
  }
  // Preview text is bounded but not required to be non-empty: an asset with no preview
  // still carries the field as an empty string in existing records.
  assert.equal(parseCapturedAsset(asset({ previewText: "" }))?.previewText, "");
});

test("a record is refused field by field", () => {
  const cases = [
    asset({ id: 7 }),
    asset({ id: "a".repeat(browserAssetMetadataLimits.id + 1) }),
    asset({ provider: "other" }),
    asset({ provider: 7 }),
    asset({ kind: "video" }),
    asset({ name: 7 }),
    asset({ name: "a".repeat(browserAssetMetadataLimits.name + 1) }),
    asset({ sourceElement: "sidebar" }),
    asset({ downloadAvailable: "yes" }),
    asset({ mimeType: 7 }),
    asset({ mimeType: "a".repeat(browserAssetMetadataLimits.mimeType + 1) }),
    asset({ size: 1.5 }),
    asset({ size: -1 }),
    asset({ providerAssetId: 7 }),
    asset({
      providerAssetId: "a".repeat(browserAssetMetadataLimits.providerAssetId + 1),
    }),
    asset({ previewText: 7 }),
    asset({ previewText: "a".repeat(browserAssetMetadataLimits.previewText + 1) }),
  ];
  for (const candidate of cases) {
    assert.equal(parseCapturedAsset(candidate), undefined, JSON.stringify(candidate));
  }
});

// The origin is shown to the user before they choose where to save the bytes, so a stored
// record may only carry a canonical HTTP(S) origin: nothing that could read as a path, a
// credential, or another scheme.
test("a source origin that is not a canonical HTTP origin is refused", () => {
  const rejected = [
    "ftp://cdn.example.invalid",
    "file:///etc/passwd",
    "data:text/plain,x",
    "blob:https://cdn.example.invalid/abc",
    "javascript:alert(1)",
    "HTTPS://cdn.example.invalid",
    "https://cdn.example.invalid/",
    "https://cdn.example.invalid/download/report.txt",
    "https://cdn.example.invalid?token=secret",
    "https://cdn.example.invalid#part",
    "https://user:pass@cdn.example.invalid",
    "https://cdn.example.invalid:443",
    "http://cdn.example.invalid:80",
    " https://cdn.example.invalid",
    "https://cdn.example.invalid ",
    "cdn.example.invalid",
    "not a url",
    "null",
    "",
    7,
    `https://${"a".repeat(browserAssetMetadataLimits.sourceOrigin)}.invalid`,
  ];
  for (const sourceOrigin of rejected) {
    assert.equal(
      parseCapturedAsset(asset({ sourceOrigin })),
      undefined,
      `${JSON.stringify(sourceOrigin)} was accepted as a source origin`,
    );
  }
});

test("a canonical source origin is kept exactly as stored", () => {
  for (const sourceOrigin of [
    "https://cdn.example.invalid",
    "https://cdn.example.invalid:8443",
    "http://localhost:3000",
    "https://xn--n3h.example.invalid",
  ]) {
    assert.equal(
      parseCapturedAsset(asset({ sourceOrigin }))?.sourceOrigin,
      sourceOrigin,
      `${sourceOrigin} did not survive`,
    );
  }
});

test("every provider, kind and source element the protocol declares is accepted", () => {
  for (const provider of ["chatgpt", "claude", "generic"]) {
    assert.equal(parseCapturedAsset(asset({ provider }))?.provider, provider);
  }
  for (const kind of ["generatedFile", "artifact", "canvas", "image", "codeArtifact"]) {
    assert.equal(parseCapturedAsset(asset({ kind }))?.kind, kind);
  }
  for (const sourceElement of ["assistantMessage", "artifactPane"]) {
    assert.equal(parseCapturedAsset(asset({ sourceElement }))?.sourceElement, sourceElement);
  }
});

const entry = (assets, overrides = {}) => ({
  id: "entry",
  role: "event",
  text: "",
  eventType: "browser.response",
  data: { assets },
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

test("the newest record of an asset id wins", () => {
  const found = findCapturedAsset(
    [entry([asset({ name: "old.png" })]), entry([asset({ name: "new.png" })])],
    "asset-1",
  );
  assert.equal(found?.name, "new.png");
});

test("entries that cannot hold an asset are skipped", () => {
  assert.equal(findCapturedAsset([], "asset-1"), undefined);
  assert.equal(
    findCapturedAsset([entry([asset()], { eventType: "browser.request" })], "asset-1"),
    undefined,
  );
  assert.equal(findCapturedAsset([entry([asset()], { data: undefined })], "asset-1"), undefined);
  assert.equal(findCapturedAsset([entry([asset()], { data: "text" })], "asset-1"), undefined);
  assert.equal(findCapturedAsset([{ ...entry([]), data: {} }], "asset-1"), undefined);
});

test("an unknown id and an invalid stored record both find nothing", () => {
  assert.equal(findCapturedAsset([entry([asset()])], "asset-2"), undefined);
  assert.equal(findCapturedAsset([entry([asset({ name: "" })])], "asset-1"), undefined);
  assert.equal(findCapturedAsset([entry(["not an object"])], "asset-1"), undefined);
});

test("an invalid newest record does not hide a valid older one", () => {
  const found = findCapturedAsset(
    [entry([asset({ name: "old.png" })]), entry([asset({ name: "" })])],
    "asset-1",
  );
  assert.equal(found?.name, "old.png");
});

test("a stored record whose origin is no longer acceptable is not returned at all", () => {
  assert.equal(
    findCapturedAsset(
      [entry([asset({ sourceOrigin: "https://cdn.example.invalid/report.txt?token=secret" })])],
      "asset-1",
    ),
    undefined,
  );
});
