const assert = require("node:assert/strict");
const test = require("node:test");

const { boundedEventDetail } = require("../dist/conversations/eventDetail.js");

test("a small record travels as it was recorded", () => {
  assert.deepEqual(
    boundedEventDetail({ stepId: "review", exitCode: 0, ok: true, note: null }),
    { stepId: "review", exitCode: 0, ok: true, note: null },
  );
});

test("nothing worth a disclosure is nothing at all", () => {
  for (const payload of [undefined, null, {}, [], () => undefined, Symbol("x")]) {
    assert.equal(boundedEventDetail(payload), undefined, String(payload));
  }
});

test("a scalar payload is kept as the scalar it is", () => {
  assert.equal(boundedEventDetail("provider said no"), "provider said no");
  assert.equal(boundedEventDetail(7), 7);
  assert.equal(boundedEventDetail(false), false);
});

test("a number with no JSON form is dropped rather than reported as null", () => {
  assert.deepEqual(boundedEventDetail({ ratio: Number.NaN, seconds: 1.5 }), { seconds: 1.5 });
  assert.equal(boundedEventDetail(Number.POSITIVE_INFINITY), undefined);
});

test("a long string is cut, and says how much was cut", () => {
  const detail = boundedEventDetail({ stdout: "x".repeat(1_500) });
  // The marker counts against the 1,024-unit cap rather than being added on top of it, so what
  // travels is at most the cap and the arithmetic still closes on the source.
  assert.ok(detail.stdout.length <= 1_024, `${String(detail.stdout.length)} units travelled`);
  const kept = detail.stdout.indexOf("…");
  assert.equal(detail.stdout.slice(0, kept), "x".repeat(kept));
  assert.match(detail.stdout, /\[(\d+) more characters not shown\]$/u);
  assert.equal(kept + Number(/\[(\d+) more/u.exec(detail.stdout)[1]), 1_500);
});

test("bounding an already bounded string is a fixed point", () => {
  const once = boundedEventDetail({ stdout: "x".repeat(1_500) });
  assert.deepEqual(boundedEventDetail(once), once);
});

test("a long array is cut, and says how many entries were cut", () => {
  const detail = boundedEventDetail({ files: Array.from({ length: 20 }, (_, index) => `f${String(index)}`) });
  assert.equal(detail.files.length, 13);
  assert.equal(detail.files[12], "[8 more items not shown]");
});

test("a wide record is cut, and says how many fields were cut", () => {
  const wide = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${String(index)}`, index]));
  const detail = boundedEventDetail(wide);
  assert.equal(Object.keys(detail).length, 25);
  assert.equal(detail["…"], "[6 more fields not shown]");
});

test("a deeply nested payload stops at the bound instead of travelling whole", () => {
  const detail = boundedEventDetail({ a: { b: { c: { d: { e: { f: 1 } } } } } });
  assert.deepEqual(detail, { a: { b: { c: { d: "[1 fields not shown]" } } } });
  const arrays = boundedEventDetail([[[[["deep"]]]]]);
  assert.deepEqual(arrays, [[[["[1 items not shown]"]]]]);
});

test("credentials are redacted and provider session handles are withheld, at any depth", () => {
  const detail = boundedEventDetail({
    attempt: {
      authorization: "Bearer sk-live-abc",
      "session-id": "sess-1",
      conversationId: "conv-9",
      rolloutPath: "/tmp/rollout.jsonl",
      command: "codex exec",
    },
  });
  assert.deepEqual(detail.attempt, {
    authorization: "[REDACTED]",
    "session-id": "[WITHHELD]",
    conversationId: "[WITHHELD]",
    rolloutPath: "[WITHHELD]",
    command: "codex exec",
  });
  const serialised = JSON.stringify(detail);
  ["sk-live-abc", "sess-1", "conv-9", "rollout.jsonl"].forEach((secret) =>
    assert.equal(serialised.includes(secret), false, secret));
});

test("a withheld field still counts against the field bound", () => {
  const wide = Object.fromEntries([
    ["sessionId", "sess"],
    ...Array.from({ length: 30 }, (_, index) => [`k${String(index)}`, index]),
  ]);
  const detail = boundedEventDetail(wide);
  assert.equal(detail.sessionId, "[WITHHELD]");
  assert.equal(Object.keys(detail).length, 25);
});

test("entries that have no JSON form are dropped from an array without shifting the bound", () => {
  assert.deepEqual(boundedEventDetail([1, undefined, Number.NaN, "two"]), [1, "two"]);
});

// The bound that actually matters, and the one the per-container caps above never provided.
//
// 24 fields, 12 items, depth 4 and 1,024 characters are four limits that compose by multiplying:
// a payload that branches 24 ways at every level retains about 24^4 leaves, so a projection that
// satisfies every one of them can still be hundreds of megabytes. Each case below is stated in the
// unit the webview pays — the serialized size of what it receives.

const {
  MAX_EVENT_DETAIL_BYTES,
  boundedDecisionDetail,
  serializedJsonBytes,
} = require("../dist/conversations/eventDetail.js");

const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

test("the declared cap is the one the tests below hold it to", () => {
  assert.equal(MAX_EVENT_DETAIL_BYTES, 16 * 1_024);
});

test("the projection charges itself exactly what it costs to serialize", () => {
  const lone = `lone ${String.fromCharCode(0xd800)} surrogate`;
  const escapes = ['"', "\\", "\u0000", "\n", "\t"].join("");
  for (const payload of [
    { stepId: "review", exitCode: 0, ok: true, note: null, ratio: 1.5 },
    { note: "日本語のログ", quote: escapes },
    { astral: "🙂🙂🙂", lone },
    [1, "two", { three: [4, 5] }],
  ]) {
    const detail = boundedEventDetail(payload);
    assert.equal(
      serializedJsonBytes(detail),
      serializedBytes(detail),
      "byte accounting disagrees with JSON.stringify",
    );
  }
});

// Built by aliasing one subtree at each level, so the test itself costs nothing to construct while
// the projection still has 24^4 branches in front of it.
const branching = (depth, leaf) => {
  let level = leaf;
  for (let remaining = depth; remaining > 0; remaining -= 1) {
    const child = level;
    level = Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`k${String(index)}`, child]));
  }
  return level;
};

test("a payload that branches at every level is bounded in total, not per branch", () => {
  const detail = boundedEventDetail(branching(4, "x".repeat(4_000)));
  const bytes = serializedBytes(detail);
  assert.ok(bytes <= MAX_EVENT_DETAIL_BYTES, `${String(bytes)} bytes travelled`);
  // It is not empty either: the budget is spent on real content, and what it could not reach says
  // so rather than vanishing.
  assert.ok(JSON.stringify(detail).includes("more fields not shown"));
});

test("a deep array of deep arrays is bounded in total", () => {
  const detail = boundedEventDetail(
    Array.from({ length: 12 }, () => Array.from({ length: 12 }, () => ({
      big: "y".repeat(4_000),
      more: Array.from({ length: 12 }, () => "z".repeat(2_000)),
    }))),
  );
  assert.ok(serializedBytes(detail) <= MAX_EVENT_DETAIL_BYTES);
});

test("a very wide record is cut without walking the remainder to count it", () => {
  const wide = Object.fromEntries(
    Array.from({ length: 200_000 }, (_, index) => [`k${String(index)}`, index]),
  );
  const detail = boundedEventDetail(wide);
  assert.equal(Object.keys(detail).length, 25);
  // An exact count would mean enumerating 199,976 keys to print a number. The marker is honest
  // about what it does not know.
  assert.equal(detail["…"], "[more fields not shown]");
  assert.ok(serializedBytes(detail) <= MAX_EVENT_DETAIL_BYTES);
});

test("a very long array is cut, and its length is cheap enough to state exactly", () => {
  const detail = boundedEventDetail({ files: Array.from({ length: 100_000 }, (_, index) => index) });
  assert.equal(detail.files.length, 13);
  assert.equal(detail.files[12], "[99988 more items not shown]");
  assert.ok(serializedBytes(detail) <= MAX_EVENT_DETAIL_BYTES);
});

test("multibyte text is counted in the bytes it takes, not the code units it reads as", () => {
  // 24 fields of 1,024 ideographs is about 72 KiB of UTF-8 that satisfies every per-container cap.
  const detail = boundedEventDetail(Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`note${String(index)}`, "日".repeat(1_024)]),
  ));
  const bytes = serializedBytes(detail);
  assert.ok(bytes <= MAX_EVENT_DETAIL_BYTES, `${String(bytes)} bytes travelled`);
  assert.ok(JSON.stringify(detail).includes("not shown"), "nothing said what was cut");
});

test("an astral pair is never cut in half", () => {
  const detail = boundedEventDetail({ note: "🙂".repeat(2_000) });
  // A cut between the halves of a pair would leave a lone surrogate, whatever the cap works out to
  // once the marker is taken out of it.
  assert.ok(detail.note.length <= 1_024);
  assert.ok(detail.note.startsWith("🙂".repeat(400)));
  assert.equal(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(detail.note),
    false,
    "a lone surrogate travelled",
  );
  assert.ok(serializedBytes(detail) <= MAX_EVENT_DETAIL_BYTES);
});

test("escaped text is counted as the bytes the escaping writes", () => {
  const raw = ['"', "\\", "\u0000", "\n"].join("").repeat(256);
  const detail = boundedEventDetail(Object.fromEntries(
    Array.from({ length: 24 }, (_, index) => [`raw${String(index)}`, raw]),
  ));
  assert.ok(serializedBytes(detail) <= MAX_EVENT_DETAIL_BYTES);
  assert.equal(serializedJsonBytes(detail), serializedBytes(detail));
});

test("a caller may ask for a smaller cap, and gets it", () => {
  for (const cap of [64, 256, 1_024, 4_096]) {
    const detail = boundedEventDetail(branching(4, "x".repeat(4_000)), cap);
    const bytes = detail === undefined ? 0 : serializedBytes(detail);
    assert.ok(bytes <= cap, `${String(bytes)} bytes travelled under a ${String(cap)} byte cap`);
  }
});

test("a secret is withheld wherever the budget happens to run out", () => {
  const secrets = ["sk-live-abcdefghijklmnop", "sess-must-not-travel"];
  const near = boundedEventDetail({ apiKey: secrets[0], sessionId: secrets[1], note: "first" });
  assert.equal(near.apiKey, "[REDACTED]");
  assert.equal(near.sessionId, "[WITHHELD]");
  // The same two keys behind twenty fields of padding that spend the whole budget first: the
  // replacement is charged like any other value, so exhaustion drops the field rather than letting
  // an unmeasured original through.
  const far = boundedEventDetail({
    ...Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`pad${String(index)}`, "y".repeat(1_024)]),
    ),
    apiKey: secrets[0],
    sessionId: secrets[1],
  });
  const serialised = JSON.stringify(far);
  secrets.forEach((secret) => assert.equal(serialised.includes(secret), false, secret));
  assert.ok(serializedBytes(far) <= MAX_EVENT_DETAIL_BYTES);
});

// A published decision.
//
// It used to travel whole, on the grounds that the controller composed it. The controller composes
// the envelope: the candidate, the objections, the risks and the validation errors are whatever a
// model wrote, and none of them had a bound.

const hugeDecision = () => ({
  stepId: "decide",
  round: 2,
  policy: "arbiter",
  status: "ruled",
  candidateId: "DABC",
  candidateHash: "abc",
  candidate: {
    summary: "z".repeat(200_000),
    findings: branching(3, "w".repeat(4_000)),
    authorization: "Bearer sk-live-inside-the-candidate",
    sessionId: "sess-inside-the-candidate",
  },
  participants: [{
    agentId: "codex",
    valid: true,
    accepted: false,
    candidateHash: "def",
    validationErrors: ["the candidate was not valid JSON"],
  }],
  objections: [{ agentId: "codex", text: "Keep the fallback", accepted: false }],
  unresolvedRisks: ["Provider DOM drift"],
  ruledBy: "claude",
  rulingProvenance: { kind: "arbiter" },
});

test("a published decision is bounded, and the ruling card still gets every field it reads", () => {
  const detail = boundedDecisionDetail(hugeDecision());
  const bytes = serializedBytes(detail);
  assert.ok(bytes <= MAX_EVENT_DETAIL_BYTES, `${String(bytes)} bytes travelled`);
  // Everything `finalRulingHtml` and `rulingSummary` read.
  assert.equal(detail.status, "ruled");
  assert.equal(detail.ruledBy, "claude");
  assert.equal(detail.candidateId, "DABC");
  assert.equal(detail.candidateHash, "abc");
  assert.deepEqual(detail.unresolvedRisks, ["Provider DOM drift"]);
  assert.deepEqual(detail.objections, [{ agentId: "codex", text: "Keep the fallback", accepted: false }]);
  assert.deepEqual(detail.participants, [{
    agentId: "codex",
    valid: true,
    accepted: false,
    candidateHash: "def",
    validationErrors: ["the candidate was not valid JSON"],
  }]);
  assert.deepEqual(detail.rulingProvenance, { kind: "arbiter" });
  // The candidate is what the budget is spent on last, so it is cut rather than being what costs
  // the reader the ruling beside it.
  assert.equal(typeof detail.candidate, "object");
  assert.ok(detail.candidate.summary.length < 2_000);
});

test("a secret inside a decision's candidate is treated as a secret", () => {
  const serialised = JSON.stringify(boundedDecisionDetail(hugeDecision()));
  ["sk-live-inside-the-candidate", "sess-inside-the-candidate"].forEach((secret) =>
    assert.equal(serialised.includes(secret), false, secret));
});

test("a decision that recorded nothing opens no disclosure either", () => {
  assert.equal(boundedDecisionDetail(undefined), undefined);
  assert.equal(boundedDecisionDetail({}), undefined);
  assert.equal(boundedDecisionDetail({ unrelated: "field" }), undefined);
  // A payload that is not a record at all is bounded as any other payload is.
  assert.equal(boundedDecisionDetail("ruled by hand"), "ruled by hand");
});

// The bound on the output was never a bound on the work done to produce it.
//
// Every case below was a live unbounded path before this: a string was lowercased, scanned and
// rewritten in full and then truncated to a kilobyte; a property key was measured at full length
// and emitted verbatim; a decision's participants and objections were copied whole so that twelve
// of each could be kept. The assertions are about what the projection does *not* read, so each one
// hands it far more than it may look at and checks both the answer and the cost.

const { boundedDecisionDetail: bounded } = require("../dist/conversations/eventDetail.js");

const TOKEN = "sk-live-ABCDEFGHIJKLMNOPQRSTUV";
const MEGABYTES = 10_000_000;

test("a secret before the examination boundary is redacted", () => {
  const note = `${"s".repeat(100)} ${TOKEN} ${"s".repeat(MEGABYTES)}`;
  const started = Date.now();
  const detail = boundedEventDetail({ note });
  assert.equal(detail.note.includes("sk-live-ABCDEF"), false);
  assert.equal(detail.note.includes("[REDACTED]"), true);
  assert.ok(Date.now() - started < 1_000, "a ten-megabyte string was scanned rather than bounded");
});

test("a secret across the examination boundary is withheld whole, not shown in part", () => {
  // The token starts sixteen characters before the limit and ends past it. Nothing of it may
  // travel, and neither may the characters around it that could not be judged.
  const note = `${"s".repeat(4_080)}${TOKEN}${"s".repeat(MEGABYTES)}`;
  const detail = boundedEventDetail({ note });
  assert.equal(/[^s… \[\]0-9a-z]/u.test(detail.note.replace(/more characters not shown/u, "")), false);
  assert.equal(detail.note.includes("sk-live"), false);
  assert.match(detail.note, /\[\d+ more characters not shown\]$/u);
});

test("a secret past the examination boundary is never read at all", () => {
  const note = `${"s".repeat(1_000_000)}${TOKEN}`;
  const detail = boundedEventDetail({ note });
  assert.equal(detail.note.includes("sk-live"), false);
});

test("an unterminated quoted credential crossing the boundary takes its whole tail with it", () => {
  const note = `${"x".repeat(4_000)}password: "${"a".repeat(MEGABYTES)}`;
  const started = Date.now();
  const detail = boundedEventDetail({ note });
  assert.equal(detail.note.includes("aaaa"), false, "the secret body travelled");
  assert.equal(detail.note.includes("password"), false, "the assignment travelled half-judged");
  assert.ok(Date.now() - started < 1_000);
});

test("private-key armour whose end fence is past the boundary is redacted, not half shown", () => {
  const armour = `-----BEGIN RSA PRIVATE KEY-----\n${"QUJD".repeat(2_500_000)}`;
  const started = Date.now();
  const detail = boundedEventDetail({ note: armour });
  assert.match(detail.note, /^\[REDACTED PRIVATE KEY\]/u);
  assert.equal(detail.note.includes("QUJD"), false);
  assert.ok(Date.now() - started < 1_000);
});

test("a property key is bounded and redacted like any other provider string", () => {
  const long = "k".repeat(200_000);
  const started = Date.now();
  const detail = boundedEventDetail({
    [long]: 1,
    [`authorization: Bearer ${TOKEN}`]: 2,
  });
  const keys = Object.keys(detail);
  assert.equal(keys.some((key) => key.length > 200), false, "an unbounded key travelled");
  assert.equal(keys.some((key) => key.includes("sk-live")), false, "a token travelled in a key");
  assert.equal(keys.includes("authorization: [REDACTED]"), true);
  assert.ok(Date.now() - started < 1_000, "a two-hundred-thousand-character key was measured whole");
});

test("keys that bound to the same string are kept apart deterministically", () => {
  const base = "k".repeat(300);
  const detail = boundedEventDetail({ [`${base}a`]: 1, [`${base}b`]: 2, [`${base}c`]: 3 });
  const keys = Object.keys(detail);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(boundedEventDetail({ [`${base}a`]: 1, [`${base}b`]: 2, [`${base}c`]: 3 }), detail);
  assert.deepEqual(Object.values(detail), [1, 2, 3]);
});

test("a hundred thousand participants and objections cost twelve of each, not a hundred thousand", () => {
  const many = Array.from({ length: 100_000 }, (_, index) => ({
    agentId: `agent-${String(index)}`,
    valid: true,
    candidate: "c".repeat(200),
  }));
  const started = Date.now();
  const detail = bounded({ stepId: "decide", participants: many, objections: many });
  assert.equal(detail.participants.length, 13);
  assert.equal(detail.participants[12], "[99988 more items not shown]");
  assert.equal(detail.objections.length, 13);
  assert.ok(Date.now() - started < 1_000, "both arrays were walked before anything was bounded");
});

test("a decision array is read at no more indices than the declared lookahead", () => {
  const ARRAY_INDEX_LOOKAHEAD = 48;
  const backing = Array.from({ length: 100_000 }, (_, index) => ({ agentId: `agent-${String(index)}` }));
  let highest = -1;
  const guarded = new Proxy(backing, {
    get: (target, property, receiver) => {
      if (typeof property === "string" && /^\d+$/u.test(property)) {
        const index = Number(property);
        highest = Math.max(highest, index);
        if (index >= ARRAY_INDEX_LOOKAHEAD) {
          throw new Error(`read index ${property} beyond the declared lookahead`);
        }
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const detail = bounded({ stepId: "decide", participants: guarded });
  assert.equal(detail.participants.length, 13);
  assert.ok(highest < ARRAY_INDEX_LOOKAHEAD, `read index ${String(highest)}`);
});

test("a payload that exhausts retained nodes rather than bytes still says what was cut", () => {
  const level = (depth) => (depth === 0 ? "" : Array.from({ length: 12 }, () => level(depth - 1)));
  const detail = boundedEventDetail(level(4));
  const serialized = JSON.stringify(detail);
  assert.ok(
    Buffer.byteLength(serialized, "utf8") < MAX_EVENT_DETAIL_BYTES * 0.9,
    "the byte budget ran out, so this proves nothing about the node budget",
  );
  assert.match(serialized, /more items not shown/u);
});

// Cost is hard to assert on and easy to make flaky, so the examination limit is asserted on what it
// makes impossible instead: source past the limit cannot reach the output, and cannot change it.

test("content past the examination limit cannot change what travels", () => {
  const head = `${"x ".repeat(2_000)}password: "`;
  // Two tails of the same length that a redaction rule would treat differently — one unbroken run
  // it would swallow whole, one with spaces it would stop at. A projection that read them would
  // produce two different strings.
  // `stdout` selects the stricter, assignment-aware rules, which are the ones that would swallow
  // a tail this long.
  const solid = boundedEventDetail({ stdout: `${head}${"A".repeat(2_000_000)}` }).stdout;
  const spaced = boundedEventDetail({ stdout: `${head}${"B ".repeat(1_000_000)}` }).stdout;
  assert.equal(solid, spaced, "the tail past the examination limit changed the answer");
  assert.equal(solid.includes("password"), false);
  assert.equal(/[AB]/u.test(solid), false);
});

test("an armour block whose end fence is past the limit withholds everything after it", () => {
  const note = [
    "-----BEGIN RSA PRIVATE KEY-----\n",
    "QUJD".repeat(1_250_000),
    "\n-----END RSA PRIVATE KEY-----\nAFTER-THE-KEY",
  ].join("");
  const detail = boundedEventDetail({ note });
  assert.match(detail.note, /^\[REDACTED PRIVATE KEY\]/u);
  assert.equal(detail.note.includes("QUJD"), false, "the key body travelled");
  assert.equal(
    detail.note.includes("AFTER-THE-KEY"),
    false,
    "the projection read past the examination limit to find the end fence",
  );
});
