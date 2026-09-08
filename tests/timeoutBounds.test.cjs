const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAXIMUM_TIMEOUT_MS,
  MINIMUM_TIMEOUT_MS,
  clampTimeoutMs,
  isSupportedTimeoutMs,
} = require("../dist/state/timeoutBounds.js");

// EX-AUD-06. A timeout becomes `new Date(now + timeoutMs).toISOString()`. Past the Date
// range that throws `RangeError: Invalid time value`, and `Math.max(0, …)` never guarded
// against it, so a large-but-safe integer crashed instead of being reported.
test("the shared ceiling stays inside the Date range with room to spare", () => {
  assert.equal(Number.isSafeInteger(MAXIMUM_TIMEOUT_MS), true);
  assert.ok(MAXIMUM_TIMEOUT_MS < 8_640_000_000_000_000);
  const latest = new Date(Date.now() + MAXIMUM_TIMEOUT_MS);
  assert.equal(Number.isNaN(latest.getTime()), false);
  assert.match(latest.toISOString(), /^\d{4}-\d{2}-\d{2}T/u);
});

// The first ceiling was chosen against the Date range alone, at thirty days. `setTimeout`
// takes a 32-bit signed delay: a larger value does not throw, it silently becomes a **1 ms**
// timer with a TimeoutOverflowWarning. A ceiling that overflows the timer turns every long
// wait into an immediate one, which is worse than the crash it was meant to prevent.
test("the shared ceiling does not overflow a Node timer", () => {
  const NODE_TIMER_LIMIT = 2_147_483_647;
  assert.ok(
    MAXIMUM_TIMEOUT_MS <= NODE_TIMER_LIMIT,
    `${String(MAXIMUM_TIMEOUT_MS)} exceeds the 32-bit timer limit and would fire after 1 ms`,
  );
});

test("no timeout that passes validation can overflow a Node timer", async () => {
  const warnings = [];
  const record = (warning) => warnings.push(warning.name);
  process.on("warning", record);
  try {
    for (const value of [MAXIMUM_TIMEOUT_MS, MINIMUM_TIMEOUT_MS, 30_000]) {
      assert.equal(isSupportedTimeoutMs(value), true);
      clearTimeout(setTimeout(() => undefined, value));
    }
    clearTimeout(setTimeout(() => undefined, clampTimeoutMs(Number.MAX_SAFE_INTEGER, 1_000)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      warnings.filter((name) => name === "TimeoutOverflowWarning"),
      [],
      "a value that passed validation still overflowed the timer",
    );
  } finally {
    process.off("warning", record);
  }
});

test("every contributed timeout maximum is a usable timer delay", () => {
  const manifest = require("../package.json");
  const declared = manifest.contributes.configuration;
  const properties = Array.isArray(declared)
    ? Object.assign({}, ...declared.map((section) => section.properties))
    : declared.properties;
  for (const [name, schema] of Object.entries(properties)) {
    if (!/TimeoutMs$|GraceMs$/u.test(name)) continue;
    assert.equal(typeof schema.maximum, "number", `${name} declares no maximum`);
    assert.ok(
      schema.maximum <= 2_147_483_647,
      `${name} allows ${String(schema.maximum)}, which overflows a Node timer`,
    );
  }
});

test("each timeout setting declares exactly one maximum", () => {
  // JSON keeps only the last duplicate key, so a second `maximum` is invisible to a parsed
  // manifest while still being wrong in the file VS Code reads.
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "package.json"),
    "utf8",
  );
  const blocks = source.match(/"bachata\.[A-Za-z]*(?:TimeoutMs|GraceMs)": \{[^}]*\}/gu) ?? [];
  assert.ok(blocks.length > 0);
  for (const block of blocks) {
    const name = block.slice(1, block.indexOf('"', 1));
    assert.equal(
      (block.match(/"maximum":/gu) ?? []).length,
      1,
      `${name} declares its maximum more than once`,
    );
  }
});

test("the last valid and first invalid timeout values are classified exactly", () => {
  assert.equal(isSupportedTimeoutMs(MAXIMUM_TIMEOUT_MS), true, "the ceiling itself is valid");
  assert.equal(isSupportedTimeoutMs(MAXIMUM_TIMEOUT_MS + 1), false, "one past the ceiling is not");
  assert.equal(isSupportedTimeoutMs(MINIMUM_TIMEOUT_MS), true);
  assert.equal(isSupportedTimeoutMs(MINIMUM_TIMEOUT_MS - 1), false);
});

test("Number.MAX_SAFE_INTEGER and other unusable values are refused", () => {
  for (const value of [
    Number.MAX_SAFE_INTEGER,
    Number.MAX_VALUE,
    Number.POSITIVE_INFINITY,
    Number.NaN,
    8_640_000_000_000_000,
    -1,
    1.5,
    "3000",
    null,
    undefined,
  ]) {
    assert.equal(isSupportedTimeoutMs(value), false, `${String(value)} was accepted`);
  }
});

test("clamping keeps a hand-edited setting inside the range", () => {
  assert.equal(clampTimeoutMs(Number.MAX_SAFE_INTEGER, 1_000), MAXIMUM_TIMEOUT_MS);
  assert.equal(clampTimeoutMs(-5, 1_000), MINIMUM_TIMEOUT_MS);
  assert.equal(clampTimeoutMs(Number.NaN, 1_000), 1_000);
  assert.equal(clampTimeoutMs(Number.POSITIVE_INFINITY, 1_000), 1_000);
  assert.equal(clampTimeoutMs(30_000, 1_000), 30_000);
  assert.equal(clampTimeoutMs(30_000.7, 1_000), 30_000);
});

test("every contributed timeout setting declares a bound its default satisfies", () => {
  const manifest = require("../package.json");
  const declared = manifest.contributes.configuration;
  const properties = Array.isArray(declared)
    ? Object.assign({}, ...declared.map((section) => section.properties))
    : declared.properties;
  const timeouts = Object.entries(properties).filter(([name]) => /TimeoutMs$/u.test(name));
  assert.ok(timeouts.length > 0);
  for (const [name, schema] of timeouts) {
    assert.equal(typeof schema.maximum, "number", `${name} declares no maximum`);
    assert.ok(schema.maximum <= MAXIMUM_TIMEOUT_MS, `${name} exceeds the shared ceiling`);
    if (typeof schema.default === "number") {
      assert.ok(schema.default <= schema.maximum, `${name} default exceeds its own maximum`);
      if (typeof schema.minimum === "number") {
        assert.ok(schema.default >= schema.minimum, `${name} default is under its own minimum`);
      }
    }
  }
});

// EX-AUD-06 follow-up. The earlier check was a regex over four named files matching
// `.get<number>(`, and it missed `src/commands/doctor.ts`, where the read had no type
// argument. This walks the AST of every file under src/, so a new read cannot escape by
// being written differently or by living somewhere the list did not name.
test("no timeout setting is read without the shared clamp", async () => {
  const { findUnguardedTimeoutReads } = await import(
    `file://${require("node:path").join(__dirname, "..", "scripts", "check-timeout-reads.mjs")}`
  );
  const findings = await findUnguardedTimeoutReads();
  assert.deepEqual(
    findings,
    [],
    `these reads bypass the clamp:\n${findings
      .map((finding) => `  ${finding.file}:${String(finding.line)}: ${finding.key}`)
      .join("\n")}`,
  );
});

test("the scanner detects a read written without a type argument", async () => {
  const { findUnguardedTimeoutReads } = await import(
    `file://${require("node:path").join(__dirname, "..", "scripts", "check-timeout-reads.mjs")}`
  );
  const os = require("node:os");
  const fsp = require("node:fs/promises");
  const staged = await fsp.mkdtemp(require("node:path").join(os.tmpdir(), "bachata-timeout-scan-"));
  try {
    // The exact shape that slipped past the regex: `.get(...)`, no `<number>`.
    await fsp.writeFile(
      require("node:path").join(staged, "bare.ts"),
      'const x = Number(configuration.get("commandCheckTimeoutMs", 15_000));\n',
    );
    // And a grace setting, which the first bound also missed entirely.
    await fsp.writeFile(
      require("node:path").join(staged, "grace.ts"),
      'const y = config.get<number>("interruptGraceMs", 5_000);\n',
    );
    const findings = await findUnguardedTimeoutReads(staged);
    assert.equal(findings.length, 2, `expected both shapes to be caught: ${JSON.stringify(findings)}`);
    assert.deepEqual(findings.map((finding) => finding.key).sort(), [
      "commandCheckTimeoutMs",
      "interruptGraceMs",
    ]);
  } finally {
    await fsp.rm(staged, { recursive: true, force: true });
  }
});

test("a read wrapped in the shared reader is not reported", async () => {
  const { findUnguardedTimeoutReads, findGuardedTimeoutReads } = await import(
    `file://${require("node:path").join(__dirname, "..", "scripts", "check-timeout-reads.mjs")}`
  );
  const os = require("node:os");
  const fsp = require("node:fs/promises");
  const staged = await fsp.mkdtemp(require("node:path").join(os.tmpdir(), "bachata-timeout-ok-"));
  try {
    await fsp.writeFile(
      require("node:path").join(staged, "wrapped.ts"),
      'const x = readTimeoutSetting(\n'
        + '  (key, fallback) => configuration.get(key, fallback),\n'
        + '  "agentTurnTimeoutMs",\n'
        + '  1_800_000,\n'
        + ');\n',
    );
    assert.deepEqual(await findUnguardedTimeoutReads(staged), []);
    assert.equal((await findGuardedTimeoutReads(staged)).length, 1);
  } finally {
    await fsp.rm(staged, { recursive: true, force: true });
  }
});

test("every timeout setting read in this repository is accounted for", async () => {
  const { findGuardedTimeoutReads } = await import(
    `file://${require("node:path").join(__dirname, "..", "scripts", "check-timeout-reads.mjs")}`
  );
  const guarded = await findGuardedTimeoutReads();
  // Not pinned to an exact number: a new guarded read is correct and must not fail this.
  assert.ok(guarded.length >= 40, `only ${String(guarded.length)} guarded reads were found`);
  assert.ok(
    guarded.some((finding) => finding.file === require("node:path").join("src", "commands", "doctor.ts")),
    "the doctor command's read is not routed through the shared reader",
  );
});
