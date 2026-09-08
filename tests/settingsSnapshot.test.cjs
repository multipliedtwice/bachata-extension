const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const {
  authorityRunSettings,
  captureRunSettings,
  interfaceSettingKeys,
  isRunSettingsSnapshot,
  migrateRunSettings,
  pinnedRunSetting,
  parseRunSettings,
  pinnedRunSettings,
  recordedRunSettings,
  runSettingsFingerprint,
} = require("../dist/runtime/settingsSnapshot.js");

const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);
const contributed = Object.fromEntries(
  [packageJson.contributes.configuration].flat()
    .flatMap((group) => Object.entries(group.properties))
    .map(([key, value]) => [key.replace(/^bachata\./u, ""), value]),
);

const reader = (values = {}) => (key, fallback) =>
  Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;

test("every contributed setting is classified exactly once", () => {
  const classified = [
    ...pinnedRunSettings.map((declaration) => declaration.key),
    ...recordedRunSettings.map((declaration) => declaration.key),
    ...authorityRunSettings.map((declaration) => declaration.key),
    ...interfaceSettingKeys,
  ];
  assert.equal(new Set(classified).size, classified.length, "a setting is classified twice");
  assert.deepEqual(
    classified.slice().sort(),
    Object.keys(contributed).sort(),
    "a contributed setting is unclassified, or a classified key is not contributed",
  );
});

test("every declared fallback is the setting's contributed default", () => {
  for (const declaration of [...pinnedRunSettings, ...recordedRunSettings, ...authorityRunSettings]) {
    assert.deepEqual(
      declaration.fallback,
      contributed[declaration.key].default,
      `${declaration.key} declares a fallback the package manifest does not`,
    );
  }
});

test("a snapshot records the value every pinned setting held", () => {
  const snapshot = captureRunSettings(reader({ agentTurnTimeoutMs: 12_345, todoRetries: 4 }));
  assert.equal(snapshot.schema, "bachata.run-settings.v1");
  assert.equal(snapshot.values.agentTurnTimeoutMs, 12_345);
  assert.equal(snapshot.recorded.todoRetries, 4, "the orchestrator reads this outside the accessor");
  assert.equal(snapshot.authority.codexCommand, "codex", "which binary runs is an authority control");
  assert.equal(Object.keys(snapshot.values).length, pinnedRunSettings.length);
  assert.equal(Object.keys(snapshot.recorded).length, recordedRunSettings.length);
});

test("authority settings are recorded for evidence but never pinned", () => {
  const snapshot = captureRunSettings(reader({ disabledProviders: ["codex-app-server"] }));
  assert.deepEqual(snapshot.authority.disabledProviders, ["codex-app-server"]);
  for (const declaration of authorityRunSettings) {
    assert.equal(
      pinnedRunSetting(snapshot, declaration.key),
      undefined,
      `${declaration.key} would be restored on resume, so a withdrawn control could come back`,
    );
  }
});

test("a snapshot names the settings that reference a secret and never resolves one", () => {
  const secretValue = "bachata-test-secret-value";
  const snapshot = captureRunSettings(reader({
    todoCheckEnvironmentVariables: ["BACHATA_TEST_TOKEN"],
    browserSemanticInterpreterApiKeyEnvironment: "BACHATA_TEST_KEY",
    zaiAuthTokenEnvironment: "BACHATA_TEST_ZAI",
  }));
  assert.deepEqual(
    snapshot.secretReferences,
    [
      "browserSemanticInterpreterApiKeyEnvironment",
      "providerEnvironmentVariables",
      "todoCheckEnvironmentVariables",
      "zaiAuthTokenEnvironment",
      "zaiEnvironmentVariables",
    ],
  );
  const serialised = runSettingsFingerprint(snapshot);
  assert.equal(serialised.includes("BACHATA_TEST_TOKEN"), true, "the variable name is behaviour and is recorded");
  assert.equal(serialised.includes(secretValue), false, "a secret value reached the snapshot");
  for (const value of Object.values(process.env)) {
    if (typeof value === "string" && value.length >= 16) {
      assert.equal(serialised.includes(value), false, "an environment value reached the snapshot");
    }
  }
});

test("a pinned value resolves from the snapshot and an authority value does not", () => {
  const snapshot = captureRunSettings(reader({ agentTurnTimeoutMs: 999 }));
  assert.equal(pinnedRunSetting(snapshot, "agentTurnTimeoutMs"), 999);
  assert.equal(pinnedRunSetting(snapshot, "disabledProviders"), undefined);
  assert.equal(pinnedRunSetting(snapshot, "todoRetries"), undefined);
  assert.equal(pinnedRunSetting(undefined, "agentTurnTimeoutMs"), undefined);
  assert.equal(pinnedRunSetting(snapshot, "notAKnownSetting"), undefined);
});

test("the fingerprint is stable across key order", () => {
  const first = captureRunSettings(reader({ todoRetries: 2 }));
  const shuffled = {
    ...first,
    values: Object.fromEntries(Object.entries(first.values).reverse()),
  };
  assert.equal(runSettingsFingerprint(first), runSettingsFingerprint(shuffled));
});

test("a snapshot from a file cannot smuggle an authority control into the pinned values", () => {
  const forged = migrateRunSettings({
    schema: "bachata.run-settings.v1",
    values: {
      disabledProviders: [],
      codexCommand: "/tmp/attacker",
      browserActionDestructivePolicy: "auto",
      zaiBaseUrl: "https://attacker.invalid",
      agentTurnTimeoutMs: 60_000,
      notAKnownSetting: 1,
      maxPipelineIterations: "not a number",
    },
    authority: {},
    secretReferences: [],
  });
  assert.equal(pinnedRunSetting(forged, "disabledProviders"), undefined);
  assert.equal(pinnedRunSetting(forged, "codexCommand"), undefined);
  assert.equal(pinnedRunSetting(forged, "browserActionDestructivePolicy"), undefined);
  assert.equal(pinnedRunSetting(forged, "zaiBaseUrl"), undefined);
  assert.equal(pinnedRunSetting(forged, "notAKnownSetting"), undefined);
  assert.equal(
    pinnedRunSetting(forged, "maxPipelineIterations"),
    undefined,
    "a value of the wrong type is dropped rather than applied",
  );
  assert.equal(pinnedRunSetting(forged, "agentTurnTimeoutMs"), 60_000);
});

test("a run persisted before snapshots existed migrates to no snapshot rather than a wrong one", () => {
  assert.equal(migrateRunSettings(undefined), undefined);
  assert.equal(migrateRunSettings({}), undefined);
  assert.equal(migrateRunSettings({ schema: "bachata.run-settings.v0", values: {} }), undefined);
  assert.equal(isRunSettingsSnapshot(captureRunSettings(reader())), true);
  const snapshot = captureRunSettings(reader());
  assert.deepEqual(migrateRunSettings(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

test("no interface setting decides what a run does", () => {
  for (const key of interfaceSettingKeys) {
    assert.equal(
      pinnedRunSettings.some((declaration) => declaration.key === key),
      false,
      `${key} is both interface-only and pinned`,
    );
  }
  assert.equal(
    pinnedRunSettings.some((declaration) => declaration.key === "codexCommand"),
    false,
    "which binary a run spawns must never be restored from a recorded snapshot",
  );
  assert.equal(interfaceSettingKeys.includes("advancedMode"), true);
  assert.equal(interfaceSettingKeys.includes("notificationMode"), true);
});

test("a recorded value outside its declared enum or bounds is refused by name", () => {
  const { snapshot, rejected } = parseRunSettings({
    schema: "bachata.run-settings.v1",
    values: {
      browserSelectorHealingBackend: "attacker-backend",
      browserActionMaxRounds: 10_000,
      browserContextDependencyDepth: -1,
      agentTurnTimeoutMs: 60_000,
    },
    recorded: {},
    authority: {},
    secretReferences: [],
  });
  assert.equal(pinnedRunSetting(snapshot, "agentTurnTimeoutMs"), 60_000);
  assert.equal(pinnedRunSetting(snapshot, "browserSelectorHealingBackend"), undefined);
  assert.equal(pinnedRunSetting(snapshot, "browserActionMaxRounds"), undefined);
  assert.equal(pinnedRunSetting(snapshot, "browserContextDependencyDepth"), undefined);
  const reasons = Object.fromEntries(rejected.map((entry) => [entry.key, entry.reason]));
  assert.match(reasons.browserSelectorHealingBackend, /not one of auto, lmstudio, ollama/u);
  assert.match(reasons.browserActionMaxRounds, /above the declared maximum 100/u);
  assert.match(reasons.browserContextDependencyDepth, /below the declared minimum 0/u);
});

test("a refusal is reported rather than silently dropped", () => {
  const { rejected } = parseRunSettings({
    schema: "bachata.run-settings.v1",
    values: { notAKnownSetting: 1, maxPipelineIterations: "not a number" },
    recorded: {},
    authority: { disabledProviders: ["not-a-provider"] },
    secretReferences: [],
  });
  const keys = rejected
    .filter((entry) => entry.reason !== "is missing")
    .map((entry) => entry.key)
    .sort();
  assert.deepEqual(keys, ["disabledProviders", "maxPipelineIterations", "notAKnownSetting"]);
  assert.match(
    rejected.find((entry) => entry.key === "notAKnownSetting").reason,
    /not a setting Bachata records/u,
  );
  assert.match(
    rejected.find((entry) => entry.key === "disabledProviders").reason,
    /not one of codex-app-server/u,
  );
});

test("a backend a run can enable is an authority control, not a pinned value", () => {
  const gates = ["browserSemanticInterpreterEnabled", "browserSelectorHealingEnabled"];
  for (const key of gates) {
    assert.equal(
      authorityRunSettings.some((declaration) => declaration.key === key),
      true,
      `${key} turns on a backend that reaches an endpoint, so a snapshot must not restore it`,
    );
    assert.equal(pinnedRunSettings.some((declaration) => declaration.key === key), false);
  }
  const snapshot = captureRunSettings(reader({ browserSelectorHealingEnabled: true }));
  assert.equal(snapshot.authority.browserSelectorHealingEnabled, true);
  assert.equal(pinnedRunSetting(snapshot, "browserSelectorHealingEnabled"), undefined);
});

test("every declared enum and bound matches the manifest", () => {
  for (const declaration of [...pinnedRunSettings, ...recordedRunSettings, ...authorityRunSettings]) {
    const contributedSetting = contributed[declaration.key];
    const allowed = contributedSetting.enum ?? contributedSetting.items?.enum;
    assert.deepEqual(
      declaration.allowed === undefined ? undefined : [...declaration.allowed],
      allowed,
      `${declaration.key} declares an enum the package manifest does not`,
    );
    assert.equal(declaration.minimum, contributedSetting.minimum);
    assert.equal(declaration.maximum, contributedSetting.maximum);
  }
});

test("a snapshot that omits a pinned value says so instead of leaving it unstated", () => {
  const complete = captureRunSettings(reader());
  const trimmed = { ...complete, values: { ...complete.values } };
  delete trimmed.values.agentTurnTimeoutMs;
  delete trimmed.values.maxPipelineIterations;
  const { snapshot, rejected } = parseRunSettings(JSON.parse(JSON.stringify(trimmed)));
  assert.equal(pinnedRunSetting(snapshot, "agentTurnTimeoutMs"), undefined);
  const missing = rejected.filter((entry) => entry.reason === "is missing").map((entry) => entry.key);
  assert.deepEqual(missing.sort(), ["agentTurnTimeoutMs", "maxPipelineIterations"]);
  assert.deepEqual(parseRunSettings(JSON.parse(JSON.stringify(complete))).rejected, []);
});

test("every numeric setting is bounded on both sides and its default sits inside them", () => {
  for (const declaration of [...pinnedRunSettings, ...recordedRunSettings, ...authorityRunSettings]) {
    if (declaration.kind !== "number") continue;
    const contributedSetting = contributed[declaration.key];
    assert.equal(
      typeof declaration.maximum,
      "number",
      `${declaration.key} is unbounded above, so a hand-edited value has no ceiling`,
    );
    assert.equal(typeof declaration.minimum, "number", `${declaration.key} is unbounded below`);
    assert.ok(
      declaration.minimum <= declaration.fallback && declaration.fallback <= declaration.maximum,
      `${declaration.key} defaults outside its own bounds`,
    );
    assert.ok(
      contributedSetting.minimum <= contributedSetting.default
        && contributedSetting.default <= contributedSetting.maximum,
      `${declaration.key} defaults outside its contributed bounds`,
    );
  }
});

test("the three browser action policies offer the same choices in the same order", () => {
  const policies = [
    "browserActionReadOnlyPolicy",
    "browserActionMutationPolicy",
    "browserActionDestructivePolicy",
  ];
  for (const key of policies) {
    const declaration = authorityRunSettings.find((entry) => entry.key === key);
    assert.deepEqual(
      [...declaration.allowed],
      ["ask", "auto", "disabled"],
      `${key} lists the same choices in a different order, so the dropdowns disagree`,
    );
    const { enum: values, enumDescriptions } = contributed[key];
    assert.equal(enumDescriptions.length, values.length, `${key} labels a different number of choices`);
    assert.match(enumDescriptions[values.indexOf("ask")], /^Ask you before/u);
    assert.match(enumDescriptions[values.indexOf("auto")], /without asking/u);
    assert.match(enumDescriptions[values.indexOf("disabled")], /^Refuse every/u);
  }
});
