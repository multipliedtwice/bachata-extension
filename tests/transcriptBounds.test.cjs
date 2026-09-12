const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  TRANSCRIPT_DATA_BYTES,
  TRANSCRIPT_TEXT_BYTES,
  TRANSCRIPT_WINDOW_BYTES,
  boundedTranscriptEntry,
  boundedTranscriptWindow,
  transcriptEntryBytes,
} = require("../dist/state/transcriptBounds.js");
const { createTranscriptStore } = require("../dist/state/transcriptStore.js");

// A transcript entry's text and data are whatever a provider wrote.
//
// They were redacted and never bounded: the redactor lowercased and rewrote a string of any length,
// `redactJsonValue` rebuilt a structure of any depth and width, and only the file on disk was ever
// trimmed. The window held in memory and the entry posted to the panel carried the whole of it.

const TOKEN = "sk-live-ABCDEFGHIJKLMNOPQRSTUV";
const MEGABYTES = 10_000_000;

const entry = (overrides = {}) => ({
  id: "1",
  kind: "answer",
  agentId: "codex",
  step: "review",
  text: "ok",
  createdAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const temporaryDirectory = () => fs.mkdtempSync(path.join(os.tmpdir(), "bachata-transcript-"));

test("a ten-megabyte answer is bounded, marked, and cheap to bound", () => {
  const started = Date.now();
  const bounded = boundedTranscriptEntry(entry({ text: "a".repeat(MEGABYTES) }));
  assert.ok(
    Buffer.byteLength(bounded.text, "utf8") <= TRANSCRIPT_TEXT_BYTES,
    `${String(Buffer.byteLength(bounded.text, "utf8"))} bytes of text travelled`,
  );
  assert.match(bounded.text, /\[\d+ more characters not shown\]$/u);
  assert.ok(Date.now() - started < 1_000, "the whole string was scanned before it was bounded");
});

test("a prompt and an actionable error survive intact", () => {
  const prompt = "Fix the failing test in src/state/transcriptStore.ts and explain the cause.";
  assert.equal(boundedTranscriptEntry(entry({ kind: "prompt", text: prompt })).text, prompt);
  const failure = "Error: ENOENT: no such file or directory, open '/tmp/bachata/run.json'";
  assert.equal(boundedTranscriptEntry(entry({ kind: "error", text: failure })).text, failure);
});

test("a secret at the truncation boundary is withheld rather than half shown", () => {
  const text = `${"s ".repeat(4_050)}${TOKEN} ${"s ".repeat(MEGABYTES / 2)}`;
  const bounded = boundedTranscriptEntry(entry({ text }));
  assert.equal(bounded.text.includes("sk-live"), false);
  const early = boundedTranscriptEntry(entry({ text: `secret: ${TOKEN} and more` }));
  assert.equal(early.text.includes("sk-live"), false);
  assert.match(early.text, /secret: \[REDACTED\]/u);
});

test("an unterminated quoted credential in transcript text takes its tail with it", () => {
  const text = `${"x ".repeat(4_000)}password: "${"p".repeat(MEGABYTES)}`;
  const bounded = boundedTranscriptEntry(entry({ kind: "error", text }));
  assert.equal(bounded.text.includes("pppp"), false, "the secret body travelled");
  assert.match(bounded.text, /password: \[REDACTED\]/u);
});

test("huge nested data is bounded, and its credentials are removed on the way", () => {
  const wide = Object.fromEntries(
    Array.from({ length: 5_000 }, (_unused, index) => [`k${String(index)}`, "v".repeat(20_000)]),
  );
  const deep = Array.from({ length: 40 }).reduce((inner) => ({ inner }), {
    authorization: `Bearer ${TOKEN}`,
    note: "z".repeat(MEGABYTES),
  });
  const started = Date.now();
  const bounded = boundedTranscriptEntry(entry({ kind: "event", eventType: "x", text: "e", data: { wide, deep } }));
  const serialized = JSON.stringify(bounded.data);
  assert.ok(
    Buffer.byteLength(serialized, "utf8") <= TRANSCRIPT_DATA_BYTES,
    `${String(Buffer.byteLength(serialized, "utf8"))} bytes of data travelled`,
  );
  assert.equal(serialized.includes("sk-live"), false);
  assert.ok(Date.now() - started < 2_000, "the whole structure was walked before it was bounded");
});

test("an entry that recorded an empty record still records one", () => {
  assert.deepEqual(boundedTranscriptEntry(entry({ data: {} })).data, {});
  assert.equal("data" in boundedTranscriptEntry(entry()), false);
});

test("the retained window has a ceiling of its own, and the oldest entries leave first", () => {
  const entries = Array.from({ length: 2_000 }, (_unused, index) =>
    boundedTranscriptEntry(entry({ id: String(index), text: "t".repeat(6_000) })));
  const window = boundedTranscriptWindow(entries);
  const bytes = window.reduce((total, item) => total + transcriptEntryBytes(item), 0);
  assert.ok(bytes <= TRANSCRIPT_WINDOW_BYTES, `${String(bytes)} bytes retained`);
  assert.ok(window.length > 0);
  assert.ok(window.length < entries.length, "nothing was dropped, so nothing was bounded");
  assert.equal(window[window.length - 1].id, "1999", "the newest entry was dropped");
});

test("a window under the ceiling is not rationed at all", () => {
  const entries = [entry({ id: "a" }), entry({ id: "b" })];
  assert.deepEqual(boundedTranscriptWindow(entries), entries);
});

test("one entry larger than the ceiling is omitted", () => {
  const single = [boundedTranscriptEntry(entry({ text: "t".repeat(MEGABYTES) }))];
  assert.deepEqual(boundedTranscriptWindow(single, 16), []);
});

const writeRawTranscript = (directory, value) => {
  fs.writeFileSync(path.join(directory, "transcript.jsonl"), `${JSON.stringify(value)}\n`, "utf8");
};

test("an unbounded entry written by something else is bounded again when it is read back", async () => {
  const directory = temporaryDirectory();
  const store = createTranscriptStore(directory, () => undefined);
  try {
    // Written past the store, the way a tampered or older file reaches a reload.
    writeRawTranscript(directory, entry({
      text: `${"q ".repeat(50_000)} ${TOKEN} tail`,
      data: { note: "n".repeat(100_000) },
    }));
    const loaded = await store.load();
    assert.equal(loaded.length, 1);
    assert.ok(Buffer.byteLength(loaded[0].text, "utf8") <= TRANSCRIPT_TEXT_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(loaded[0].data), "utf8") <= TRANSCRIPT_DATA_BYTES);
    assert.equal(loaded[0].text.includes("sk-live"), false);
  } finally {
    await store.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a line no bounded entry could have produced is refused rather than parsed", async () => {
  const directory = temporaryDirectory();
  const logs = [];
  const store = createTranscriptStore(directory, (message) => logs.push(message));
  try {
    writeRawTranscript(directory, entry({ text: "z".repeat(MEGABYTES) }));
    assert.deepEqual(await store.load(), []);
    assert.equal(logs.some((message) => message.includes("oversized")), true, logs.join("\n"));
  } finally {
    await store.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("what is persisted is what the panel holds, round trip", async () => {
  const directory = temporaryDirectory();
  const store = createTranscriptStore(directory, () => undefined);
  try {
    const written = boundedTranscriptEntry(entry({
      text: `authorization: Bearer ${TOKEN} ${"w".repeat(MEGABYTES)}`,
      data: { deep: { deeper: { deepest: "d".repeat(MEGABYTES) } } },
    }));
    await store.append(written);
    const reloaded = await store.load();
    // The store bounds what it writes and bounds again what it reads, so the entry on disk and the
    // entry back in memory are the bound's fixed point rather than the first pass at it.
    assert.deepEqual(reloaded, [boundedTranscriptEntry(written)]);
    assert.ok(Buffer.byteLength(reloaded[0].text, "utf8") <= TRANSCRIPT_TEXT_BYTES);
    assert.equal(reloaded[0].text.includes("sk-live"), false);
    assert.match(reloaded[0].text, /authorization: \[REDACTED\]/u);
  } finally {
    await store.flush();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the whole retained transcript serializes under a ceiling the panel can pay", () => {
  const huge = "t".repeat(MEGABYTES);
  const entries = Array.from({ length: 1_000 }, (_unused, index) =>
    boundedTranscriptEntry(entry({
      id: String(index),
      kind: "event",
      eventType: "step.finished",
      text: huge,
      data: { note: huge },
    })));
  const window = boundedTranscriptWindow(entries);
  const bytes = Buffer.byteLength(JSON.stringify(window), "utf8");
  assert.ok(bytes <= TRANSCRIPT_WINDOW_BYTES, `${String(bytes)} bytes reached the panel`);
});

test("bounding converges, so a write and a reload do not trim a little more each time", () => {
  const raw = entry({
    text: "t".repeat(MEGABYTES),
    data: {
      wide: Object.fromEntries(
        Array.from({ length: 100 }, (_unused, index) => [`k${String(index)}`, index]),
      ),
      long: Array.from({ length: 100 }, (_unused, index) => index),
      text: "d".repeat(MEGABYTES),
    },
  });
  const once = boundedTranscriptEntry(raw);
  const twice = boundedTranscriptEntry(once);
  const thrice = boundedTranscriptEntry(twice);
  assert.deepEqual(thrice, twice, "the bound never reached a fixed point");
  assert.deepEqual(once.text, twice.text, "text was trimmed a second time");
});
