const assert = require("node:assert/strict");
const test = require("node:test");

const {
  redactFreeFormText,
  redactJsonValue,
  redactText,
} = require("../dist/security/redact.js");

test("text redaction removes common credential formats", () => {
  const value = redactText([
    "Authorization: Bearer abc.def.ghi",
    "API_KEY=secret-value",
    "--client-secret another-secret",
    "https://example.test/?access_token=query-secret",
    "ghp_123456789012345678901234567890",
  ].join(" "));
  assert.equal(value.includes("abc.def.ghi"), false);
  assert.equal(value.includes("secret-value"), false);
  assert.equal(value.includes("another-secret"), false);
  assert.equal(value.includes("query-secret"), false);
  assert.equal(value.includes("ghp_123456789012345678901234567890"), false);
});

test("structured redaction handles camel, snake, and hyphenated secret keys", () => {
  assert.deepEqual(
    redactJsonValue({
      apiKey: "one",
      api_key: "two",
      "connection-token": "three",
      token: "four",
      credential: "five",
      nested: { command: "tool --token six" },
    }),
    {
      apiKey: "[REDACTED]",
      api_key: "[REDACTED]",
      "connection-token": "[REDACTED]",
      token: "[REDACTED]",
      credential: "[REDACTED]",
      nested: { command: "tool --token [REDACTED]" },
    },
  );
});


test("text redaction removes quoted JSON, CLI authorization, and URI passwords", () => {
  const value = redactText(
    '{"apiKey":"json-secret"} --authorization Bearer cli-secret https://user:uri-secret@example.com',
  );
  assert.doesNotMatch(value, /json-secret|cli-secret|uri-secret/);
  assert.match(value, /\[REDACTED\]/);
});


test("free-form transcript redaction preserves ordinary source assignments", () => {
  const source = [
    "const apiKey = getApiKey();",
    "let password = form.password;",
  ].join("\n");
  assert.equal(redactFreeFormText(source), source);
});

test("free-form transcript redaction still removes high-confidence secrets", () => {
  const value = redactFreeFormText(
    "Authorization: Bearer abcdefghijklmnop https://user:secret@example.test ghp_123456789012345678901234567890",
  );
  assert.doesNotMatch(value, /abcdefghijklmnop|:secret@|ghp_/);
});

test("redaction stays linear on long adversarial input", () => {
  const { redactText } = require("../dist/security/redact.js");
  const sizes = [40_000, 160_000];
  const best = (size) => {
    const input = "z".repeat(size);
    redactText(input);
    let fastest = Infinity;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = process.hrtime.bigint();
      redactText(input);
      fastest = Math.min(fastest, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return fastest;
  };
  const timings = sizes.map(best);
  timings.forEach((elapsed, index) => {
    assert.ok(
      elapsed < 2_000,
      `redaction of ${String(sizes[index])} characters took ${elapsed.toFixed(1)} ms`,
    );
  });
  assert.ok(
    timings[1] < timings[0] * 16 + 250,
    `redaction cost must not grow quadratically: ${timings[0].toFixed(1)} ms then ${timings[1].toFixed(1)} ms`,
  );
});

test("redaction skips rules whose literal marker is absent", () => {
  const { redactText } = require("../dist/security/redact.js");
  const noise = "z".repeat(2_000_000);
  const started = process.hrtime.bigint();
  const result = redactText(noise);
  const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(result, noise);
  assert.ok(elapsed < 2_000, `marker-free redaction took ${elapsed.toFixed(1)} ms`);
});

test("bounded scheme matching still redacts credentials embedded in URLs", () => {
  const { redactText } = require("../dist/security/redact.js");
  [
    ["https://user:secret@host/path", "https://user:[REDACTED]@host/path"],
    ["postgres://u:p@db:5432/x", "postgres://u:[REDACTED]@db:5432/x"],
    ["git+ssh://user:tok@github.com/x", "git+ssh://user:[REDACTED]@github.com/x"],
    ["svn+ssh://me:pw@srv/repo", "svn+ssh://me:[REDACTED]@srv/repo"],
  ].forEach(([input, expected]) => {
    assert.equal(redactText(input), expected);
  });
  assert.equal(redactText("no credentials https://host/path"), "no credentials https://host/path");
});

// EX-7. The private-key rule used `[\s\S]*?`, which rescans to end of input from every
// unterminated BEGIN. This runs over agent stdout and stderr, so the cost must not grow with
// the square of the input.
test("unterminated private-key armour does not scale quadratically", () => {
  // Minimum of several runs: a single cold measurement is dominated by JIT warm-up and would
  // make this gate flaky rather than meaningful.
  const measure = (count) => {
    const input = "-----BEGIN PRIVATE KEY-----\n".repeat(count);
    let best = Infinity;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = process.hrtime.bigint();
      redactFreeFormText(input);
      best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return best;
  };
  measure(200);
  const small = Math.max(measure(1_000), 0.05);
  const large = measure(10_000);
  assert.ok(
    large / small < 25,
    `a 10x input cost ${(large / small).toFixed(1)}x, which indicates quadratic rescanning`,
  );
});

test("every private-key armour variant is still redacted", () => {
  const bodies = ["QUJD", "QUJD\nRUZH\n".repeat(40)];
  for (const label of ["", "RSA ", "EC ", "OPENSSH "]) {
    for (const body of bodies) {
      const key = `-----BEGIN ${label}PRIVATE KEY-----\n${body}\n-----END ${label}PRIVATE KEY-----`;
      const redacted = redactFreeFormText(`before ${key} after`);
      assert.equal(redacted.includes("[REDACTED PRIVATE KEY]"), true, `${label || "plain"} key survived`);
      assert.equal(redacted.includes(body.split("\n")[0]), false, `${label || "plain"} key body survived`);
      assert.equal(redacted.startsWith("before "), true);
      assert.equal(redacted.endsWith(" after"), true);
    }
  }
});

// EX-6. Secret comparison is length-checked, then constant-time. The behaviour that matters is
// that a wrong token is still refused and a right one still accepted; the timing property is
// structural and asserted at the source.
// EX-AUD-01. The rule this replaces listed four labels and allowed a body of base64 and
// whitespace only. Every label it did not list, and every encrypted PEM of any label — whose
// `Proc-Type:`/`DEK-Info:` headers carry `:` and `,` — matched nothing and survived in full.
test("every private-key label is redacted, including encrypted and unlisted ones", () => {
  const labels = [
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "DSA PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
    "PGP PRIVATE KEY BLOCK",
  ];
  for (const label of labels) {
    const key = `-----BEGIN ${label}-----\nUNIQUEBODYMARKER\nQUJD\n-----END ${label}-----`;
    const redacted = redactFreeFormText(`before ${key} after`);
    assert.equal(redacted.includes("[REDACTED PRIVATE KEY]"), true, `${label} was not redacted`);
    assert.equal(redacted.includes("UNIQUEBODYMARKER"), false, `${label} body survived`);
    assert.equal(redacted.startsWith("before "), true);
    assert.equal(redacted.endsWith(" after"), true);
  }
});

test("an encrypted PEM header does not let its body escape redaction", () => {
  for (const label of ["RSA PRIVATE KEY", "EC PRIVATE KEY", "PRIVATE KEY"]) {
    const key = [
      `-----BEGIN ${label}-----`,
      "Proc-Type: 4,ENCRYPTED",
      "DEK-Info: AES-128-CBC,0123456789ABCDEF0123456789ABCDEF",
      "",
      "UNIQUEBODYMARKER",
      `-----END ${label}-----`,
    ].join("\n");
    const redacted = redactFreeFormText(`before ${key} after`);
    assert.equal(redacted.includes("UNIQUEBODYMARKER"), false, `${label} encrypted body survived`);
    assert.equal(redacted.includes("DEK-Info"), false, `${label} key headers survived`);
    assert.equal(redacted.includes("[REDACTED PRIVATE KEY]"), true);
  }
});

test("armour labels must match at both ends and a mismatch never leaks a body", () => {
  const mismatched = "-----BEGIN RSA PRIVATE KEY-----\nUNIQUEBODYMARKER\n-----END EC PRIVATE KEY-----";
  const redacted = redactFreeFormText(`before ${mismatched} after`);
  assert.equal(redacted.includes("UNIQUEBODYMARKER"), false, "an unpaired armour body survived");
});

test("an unterminated private-key header lets no following body survive", () => {
  const redacted = redactFreeFormText("before -----BEGIN OPENSSH PRIVATE KEY-----\nUNIQUEBODYMARKER");
  assert.equal(redacted.includes("UNIQUEBODYMARKER"), false, "an unterminated armour body survived");
  assert.equal(redacted.startsWith("before "), true);
});

test("armour-like text that is not a private key is left alone", () => {
  const certificate = "-----BEGIN CERTIFICATE-----\nPUBLICBODY\n-----END CERTIFICATE-----";
  assert.equal(redactFreeFormText(certificate), certificate);
  const publicKey = "-----BEGIN PUBLIC KEY-----\nPUBLICBODY\n-----END PUBLIC KEY-----";
  assert.equal(redactFreeFormText(publicKey), publicKey);
});

test("adversarial armour headers stay linear", () => {
  const measure = (count) => {
    const input = "-----BEGIN A".repeat(count);
    let best = Infinity;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const started = process.hrtime.bigint();
      redactFreeFormText(input);
      best = Math.min(best, Number(process.hrtime.bigint() - started) / 1e6);
    }
    return best;
  };
  measure(200);
  const small = Math.max(measure(1_000), 0.05);
  const large = measure(10_000);
  assert.ok(large / small < 25, `a 10x input cost ${(large / small).toFixed(1)}x`);
});

test("secret comparison refuses mismatches of every shape", async () => {
  const { readFile } = require("node:fs/promises");
  const path = require("node:path");
  const source = await readFile(
    path.join(__dirname, "..", "src", "browser", "bridgeServer.ts"),
    "utf8",
  );
  assert.match(source, /timingSafeEqual/u, "token comparison is not constant-time");
  assert.equal(
    /message\.token !== pairingToken|message\.connectionToken !== storedToken/u.test(source),
    false,
    "a token is still compared with a short-circuiting !==",
  );
  // Length is checked before the constant-time compare, because timingSafeEqual throws on
  // unequal lengths and a thrown comparison would be a denial of service, not a refusal.
  assert.match(source, /left\.length === right\.length && timingSafeEqual/u);
});
