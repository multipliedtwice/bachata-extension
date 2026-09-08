const assert = require("node:assert/strict");
const test = require("node:test");

const { createRunBundle } = require("../dist/export/runBundle.js");
const {
  parseRunBundle,
  replayDriftSummary,
  replayPlan,
} = require("../dist/export/runBundleImport.js");
const { captureRunSettings } = require("../dist/runtime/settingsSnapshot.js");

// A snapshot Bachata wrote carries every pinned key, so the fixtures start from a real capture and
// override only what a case is about.
const settings = (overrides = {}) => {
  const complete = captureRunSettings((key, fallback) => fallback);
  return { ...complete, values: { ...complete.values, ...overrides } };
};

const bundle = (overrides = {}) => createRunBundle({
  schema: "bachata.run-bundle.v1",
  toolVersion: "0.6.12",
  run: {
    runRef: "R1234",
    title: "Fix cancellation",
    input: "Fix the cancellation path",
    selectedPipelineId: "codex-fix",
    selectedPipelineHash: "hash-1",
    workingDirectory: "/work/repo",
    ...(overrides.run ?? {}),
  },
  pipelineSnapshot: { definition: { id: "codex-fix" }, hash: "hash-1" },
  runSettings: settings(),
  result: { providers: [{ name: "Codex", adapter: "codex-app-server" }] },
  ...overrides.bundle,
}, "2026-08-24T00:00:00.000Z");

const current = (overrides = {}) => ({
  pipelineHashesById: { "codex-fix": "hash-1" },
  availableAdapters: ["codex-app-server"],
  toolVersion: "0.6.12",
  workingDirectory: "/work/repo",
  runSettings: settings(),
  ...overrides,
});

test("a run bundle exported by Bachata parses back into a replay source", () => {
  const parsed = parseRunBundle(bundle());
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.replay.runRef, "R1234");
  assert.equal(parsed.replay.prompt, "Fix the cancellation path");
  assert.equal(parsed.replay.pipelineId, "codex-fix");
  assert.equal(parsed.replay.pipelineHash, "hash-1");
  assert.deepEqual(parsed.replay.providers, [{ name: "Codex", adapter: "codex-app-server" }]);
});

test("anything that is not a Bachata run bundle is refused with a reason", () => {
  assert.match(parseRunBundle("{ broken").errors[0], /not valid JSON/u);
  assert.match(parseRunBundle(JSON.stringify({ version: 2 })).errors[0], /"version": 1/u);
  assert.match(
    parseRunBundle(JSON.stringify({ version: 1, run: { schema: "other" } })).errors[0],
    /bachata\.run-bundle\.v1/u,
  );
  assert.match(
    parseRunBundle(JSON.stringify({ version: 1, run: { schema: "bachata.run-bundle.v1", run: {} } })).errors[0],
    /no run input to replay/u,
  );
});

test("an identical environment replays with no drift", () => {
  const plan = replayPlan(parseRunBundle(bundle()).replay, current());
  assert.deepEqual(plan.drift, []);
  assert.equal(plan.replayable, true);
  assert.match(replayDriftSummary(plan), /^No drift/u);
});

test("a missing pipeline blocks replay; every other change is reported drift", () => {
  const source = parseRunBundle(bundle()).replay;
  const missing = replayPlan(source, current({ pipelineHashesById: {} }));
  assert.equal(missing.replayable, false);
  assert.equal(missing.drift[0].blocking, true);

  const drifted = replayPlan(source, current({
    pipelineHashesById: { "codex-fix": "hash-2" },
    availableAdapters: [],
    toolVersion: "0.7.0",
    workingDirectory: "/work/other",
  }));
  assert.equal(drifted.replayable, true);
  assert.deepEqual(
    drifted.drift.map((entry) => entry.label),
    ["Pipeline definition", "Providers", "Extension version", "Working directory"],
  );
  assert.match(replayDriftSummary(drifted), /Drift · Providers: recorded codex-app-server, now codex-app-server not available now/u);
});

test("a replay states which recorded settings differ from the live ones", () => {
  const source = parseRunBundle(bundle()).replay;
  assert.equal(source.runSettings.recorded.todoRetries, 1);
  const plan = replayPlan(source, current({ runSettings: settings({ agentTurnTimeoutMs: 60_000 }) }));
  const settingsDrift = plan.drift.find((entry) => entry.label === "Run settings");
  assert.match(settingsDrift.recorded, /1 recorded value differs: agentTurnTimeoutMs/u);
  assert.equal(settingsDrift.blocking, false);
  assert.equal(plan.replayable, true);
});

test("a run recorded before settings were snapshotted replays on live settings and says so", () => {
  const legacy = parseRunBundle(bundle({ bundle: { runSettings: undefined } })).replay;
  assert.equal(legacy.runSettings, undefined);
  const plan = replayPlan(legacy, current());
  const legacyDrift = plan.drift.find((entry) => entry.label === "Run settings");
  assert.equal(legacyDrift.recorded, "not recorded");
  assert.equal(legacyDrift.blocking, false);
});

test("a bundle carrying values Bachata refuses says so instead of dropping them in silence", () => {
  const source = parseRunBundle(bundle({
    bundle: {
      runSettings: settings({
        browserSelectorHealingBackend: "attacker-backend",
        codexCommand: "/tmp/attacker",
      }),
    },
  })).replay;
  assert.equal(source.runSettings.values.agentTurnTimeoutMs, 1_800_000);
  assert.equal(source.runSettings.values.browserSelectorHealingBackend, undefined);
  assert.equal(source.runSettings.values.codexCommand, undefined);
  const plan = replayPlan(source, current());
  const refused = plan.drift.find((entry) => entry.label === "Rejected run settings");
  assert.match(refused.recorded, /browserSelectorHealingBackend .*not one of auto/u);
  assert.match(refused.recorded, /codexCommand is not a setting Bachata records/u);
  assert.match(refused.current, /Bachata refused these recorded values/u);
  assert.equal(refused.blocking, false);
  assert.equal(plan.replayable, true);
});

test("a bundle that drops a pinned value is reported, not quietly run on live settings", () => {
  const trimmed = bundle({
    bundle: {
      runSettings: { ...settings(), values: { maxPipelineIterations: 10 } },
    },
  });
  const source = parseRunBundle(trimmed).replay;
  const plan = replayPlan(source, current());
  const refused = plan.drift.find((entry) => entry.label === "Rejected run settings");
  assert.match(refused.recorded, /agentTurnTimeoutMs is missing/u);
  const droppedDrift = plan.drift.find((entry) => entry.label === "Run settings");
  assert.match(
    droppedDrift.recorded,
    /agentTurnTimeoutMs/u,
    "a value the source omits is a difference and must be named",
  );
});
