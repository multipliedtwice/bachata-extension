const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DEFAULT_MAX_RECORD_BYTES,
  RecordTooLargeError,
  appendBoundedText,
  createBoundedLineDecoder,
  createIncrementalTextDecoder,
} = require("../dist/adapters/streamDecoding.js");

// EX-AUD-07. Both adapters read newline-delimited JSON with `readline`, which has no
// line-length limit, and decoded stderr with `chunk.toString("utf8")`, which corrupts any
// multi-byte character landing on a chunk boundary.

test("a multibyte character split across chunks decodes once, correctly", () => {
  const decoder = createIncrementalTextDecoder();
  const snowman = Buffer.from("☃", "utf8");
  assert.equal(snowman.length, 3);
  let out = "";
  out += decoder.push(snowman.subarray(0, 1));
  out += decoder.push(snowman.subarray(1, 2));
  out += decoder.push(snowman.subarray(2, 3));
  out += decoder.end();
  assert.equal(out, "☃");
  assert.equal(out.includes("�"), false);
});

test("a four-byte character split across chunks survives", () => {
  const decoder = createIncrementalTextDecoder();
  const emoji = Buffer.from("😀", "utf8");
  assert.equal(emoji.length, 4);
  let out = "";
  for (const byte of emoji) out += decoder.push(Buffer.from([byte]));
  out += decoder.end();
  assert.equal(out, "😀");
});

test("lines are split on newlines and a split character between them is preserved", () => {
  const decoder = createBoundedLineDecoder();
  const payload = Buffer.from('{"a":"☃"}\n{"b":2}\n', "utf8");
  const produced = [];
  for (let offset = 0; offset < payload.length; offset += 1) {
    produced.push(...decoder.push(payload.subarray(offset, offset + 1)));
  }
  produced.push(...decoder.end());
  assert.deepEqual(produced, ['{"a":"☃"}', '{"b":2}']);
  assert.deepEqual(JSON.parse(produced[0]), { a: "☃" });
});

test("a final record without a trailing newline is still delivered", () => {
  const decoder = createBoundedLineDecoder();
  assert.deepEqual(decoder.push(Buffer.from("one\ntwo", "utf8")), ["one"]);
  assert.deepEqual(decoder.end(), ["two"]);
});

test("carriage returns are trimmed from record ends", () => {
  const decoder = createBoundedLineDecoder();
  assert.deepEqual(decoder.push(Buffer.from("one\r\ntwo\r\n", "utf8")), ["one", "two"]);
});

test("an oversized record with no newline fails instead of buffering without limit", () => {
  const decoder = createBoundedLineDecoder(1024);
  assert.throws(
    () => {
      for (let index = 0; index < 100; index += 1) {
        decoder.push(Buffer.alloc(64, 0x61));
      }
    },
    (error) => error instanceof RecordTooLargeError && error.limit === 1024,
    "a record with no newline grew past the limit without failing",
  );
});

test("a huge record that does terminate is still delivered", () => {
  const decoder = createBoundedLineDecoder(1024 * 1024);
  const record = "x".repeat(500_000);
  const produced = [
    ...decoder.push(Buffer.from(`${record}\n`, "utf8")),
    ...decoder.end(),
  ];
  assert.deepEqual(produced, [record]);
});

test("the decoder recovers to a usable state after the limit is exceeded", () => {
  const decoder = createBoundedLineDecoder(64);
  assert.throws(() => decoder.push(Buffer.alloc(256, 0x61)), RecordTooLargeError);
  assert.deepEqual(decoder.push(Buffer.from("after\n", "utf8")), ["after"]);
});

test("the default record bound is stated and generous enough for real records", () => {
  assert.equal(Number.isSafeInteger(DEFAULT_MAX_RECORD_BYTES), true);
  assert.ok(DEFAULT_MAX_RECORD_BYTES >= 1024 * 1024);
});

test("the retained diagnostic keeps its tail within the bound", () => {
  assert.equal(appendBoundedText("", "abc", 10), "abc");
  assert.equal(appendBoundedText("abcdefghij", "kl", 10), "cdefghijkl");
  assert.equal(appendBoundedText("", "x".repeat(50), 10), "x".repeat(10));
  assert.equal(appendBoundedText("abc", "", 10), "abc");
});
