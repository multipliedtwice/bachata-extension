const assert = require("node:assert/strict");
const test = require("node:test");
const { boundedUtf8Prefix, historyMatches, historyScan } = require("../dist/history/search.js");

test("history search includes nested evidence and stays byte bounded", () => {
  assert.equal(historyMatches("final risk", [{ output: { ruling: "Final risk remains" } }]), true);
  assert.equal(historyMatches("needle", ["x".repeat(20), "needle"], 10), false);
  assert.equal(historyMatches("needle", [undefined, "needle"]), true);
  assert.equal(historyMatches("", []), true);
});

test("history scan reports consumed bytes and truncation without full serialization", () => {
  assert.deepEqual(historyScan("needle", ["abc", "def"], 1_000), {
    matched: false,
    used: 6,
    truncated: false,
  });
  assert.deepEqual(historyScan("needle", ["needle"], 1_000), {
    matched: true,
    used: 6,
    truncated: false,
  });
  assert.deepEqual(historyScan("needle", ["x".repeat(20)], 10), {
    matched: false,
    used: 10,
    truncated: true,
  });
});

test("a hit has to sit inside one value, and huge values stay bounded", () => {
  // A query whose halves land in two unrelated fields is not a hit: the run does not contain it.
  assert.equal(historyMatches("needle", ["nee", "dle"]), false);
  assert.equal(historyMatches("foobar", [["foo", "bar"]]), false);
  assert.equal(historyMatches("authorization", [{ title: "Fix auth", input: "orization bug" }]), false);
  assert.equal(historyMatches("needledle", ["needledle"]), true);
  assert.equal(historyMatches("deep value", [{ a: { b: { c: ["deep value"] } } }]), true);

  const huge = { text: "z".repeat(4_000_000), tail: "needle" };
  const scan = historyScan("needle", [huge], 1_024);
  assert.equal(scan.matched, false);
  assert.equal(scan.truncated, true);
  assert.ok(scan.used <= 1_024);
});

test("history scan reports truncation for cyclic and deeply nested evidence", () => {
  const cyclic = { name: "run" };
  cyclic.self = cyclic;
  const scan = historyScan("absent", [cyclic], 1_000);
  assert.equal(scan.matched, false);
  assert.equal(scan.truncated, true);
});

test("oversized nested evidence is bounded per section and reported truncated", () => {
  const nested = {
    run: {
      iterations: Array.from({ length: 50 }, (_, index) => ({
        index,
        transcript: Array.from({ length: 50 }, () => ({ text: "y".repeat(20_000) })),
      })),
    },
    tail: "late-needle",
  };

  const scan = historyScan("late-needle", [nested], 4_096);
  assert.equal(scan.matched, false);
  assert.equal(scan.truncated, true);
  assert.ok(scan.used <= 4_096, `scan consumed ${String(scan.used)} bytes`);

  const shallow = historyScan("late-needle", [{ tail: "late-needle" }], 4_096);
  assert.equal(shallow.matched, true);
  assert.equal(shallow.truncated, false);
});

test("history scanning is byte bounded for multi-byte UTF-8", () => {
  const cases = [
    { text: "é", bytes: 2 },
    { text: "中", bytes: 3 },
    { text: "🙂", bytes: 4 },
  ];

  for (const { text, bytes } of cases) {
    for (let limit = 0; limit < bytes; limit += 1) {
      const prefix = boundedUtf8Prefix(text, limit);
      assert.equal(prefix.chunk, "", `${text} was split at ${String(limit)} bytes`);
      assert.equal(prefix.bytes, 0);
      assert.equal(prefix.truncated, true);

      const scan = historyScan(text, [text], limit);
      assert.equal(scan.matched, false);
      assert.equal(scan.truncated, true);
      assert.ok(scan.used <= limit, `used ${String(scan.used)} exceeded ${String(limit)}`);
    }

    const exact = boundedUtf8Prefix(text, bytes);
    assert.equal(exact.chunk, text);
    assert.equal(exact.bytes, bytes);
    assert.equal(exact.truncated, false);

    const scan = historyScan(text, [text], bytes);
    assert.deepEqual(scan, { matched: true, used: bytes, truncated: false });
  }
});

test("multi-byte characters are never split across the byte budget", () => {
  const text = "aé中🙂z";
  for (let limit = 0; limit <= Buffer.byteLength(text, "utf8") + 2; limit += 1) {
    const prefix = boundedUtf8Prefix(text, limit);
    assert.ok(prefix.bytes <= limit, `prefix used ${String(prefix.bytes)} of ${String(limit)}`);
    assert.equal(Buffer.byteLength(prefix.chunk, "utf8"), prefix.bytes);
    assert.equal(prefix.chunk, text.slice(0, prefix.chunk.length));
    assert.equal(/[\uD800-\uDFFF]$/u.test(prefix.chunk), false, "a surrogate Bachata was split");
  }
});

test("unicode needles match inside one value and never bridge two", () => {
  assert.equal(historyMatches("中🙂", ["prefix 中🙂 suffix"], 1_000), true);
  const scan = historyScan("中🙂", ["prefix 中", "🙂 suffix"], 1_000);
  assert.equal(scan.matched, false);
  assert.ok(scan.used <= 1_000);

  const crossChunk = historyScan("中🙂", ["prefix 中", "🙂 suffix"], 14);
  assert.equal(crossChunk.matched, false);
  assert.ok(crossChunk.used <= 14, `used ${String(crossChunk.used)} exceeded 14`);

  const exhausted = historyScan("中🙂", ["prefix 中", "🙂 suffix"], 10);
  assert.equal(exhausted.matched, false);
  assert.equal(exhausted.truncated, true);
  assert.ok(exhausted.used <= 10, `used ${String(exhausted.used)} exceeded 10`);
});

test("every scan stays inside its byte budget for mixed evidence", () => {
  const values = ["ascii", "é".repeat(100), "中".repeat(100), "🙂".repeat(100), { nested: "🙂中é" }];
  for (const limit of [0, 1, 2, 3, 5, 8, 13, 64, 4_096]) {
    const scan = historyScan("absent-needle", values, limit);
    assert.ok(scan.used <= limit, `used ${String(scan.used)} exceeded ${String(limit)}`);
    assert.equal(scan.matched, false);
  }
});
