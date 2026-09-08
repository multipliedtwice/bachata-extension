const assert = require("node:assert/strict");
const test = require("node:test");

const {
  providerOwnsVariable,
  providerScopedEnvironment,
} = require("../dist/process/safeEnvironment.js");
const {
  ZAI_ANTHROPIC_ENDPOINT,
  ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE,
  ZAI_TOKEN_TARGET_VARIABLE,
  zaiProfileFindings,
} = require("../dist/adapters/zaiProfile.js");
const { providerDisplayName } = require("../dist/pipeline/providerNames.js");
const { runDoctorChecks } = require("../dist/process/doctorChecks.js");
const { createAdapterRegistry } = require("../dist/adapters/registry.js");
const { remediationPlan } = require("../dist/readiness/remediation.js");

const TOKEN = "zai-secret-token-value";
const WORKING_DIRECTORY = process.cwd();

const withEnvironment = (values, body) => {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.entries(values).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  try {
    return body();
  } finally {
    previous.forEach((value, key) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
};

const zaiProfile = (overrides = {}) => ({
  adapterType: "zai-glm",
  variables: [],
  credential: {
    sourceVariable: ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE,
    targetVariable: ZAI_TOKEN_TARGET_VARIABLE,
  },
  values: { ANTHROPIC_BASE_URL: ZAI_ANTHROPIC_ENDPOINT },
  ...overrides,
});

test("provider credential variables belong to exactly one provider", () => {
  assert.equal(providerOwnsVariable("claude-code", "ANTHROPIC_API_KEY"), true);
  assert.equal(providerOwnsVariable("codex-app-server", "ANTHROPIC_API_KEY"), false);
  assert.equal(providerOwnsVariable("zai-glm", "ANTHROPIC_AUTH_TOKEN"), false);
  assert.equal(providerOwnsVariable("codex-app-server", "OPENAI_API_KEY"), true);
  assert.equal(providerOwnsVariable("claude-code", "OPENAI_API_KEY"), false);
  assert.equal(providerOwnsVariable("zai-glm", "ZAI_API_KEY"), true);
  assert.equal(providerOwnsVariable("claude-code", "ZAI_API_KEY"), false);
  assert.equal(providerOwnsVariable("codex-app-server", "HTTPS_PROXY"), true);
  assert.equal(providerOwnsVariable("zai-glm", "HTTPS_PROXY"), true);
});

test("a Z.AI token never reaches Codex or Claude Code", () => {
  withEnvironment({
    ZAI_API_KEY: TOKEN,
    ANTHROPIC_API_KEY: "anthropic-key",
    OPENAI_API_KEY: "openai-key",
  }, () => {
    const shared = ["ZAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];
    const codex = providerScopedEnvironment({
      adapterType: "codex-app-server",
      workingDirectory: WORKING_DIRECTORY,
      sharedVariables: shared,
    });
    const claude = providerScopedEnvironment({
      adapterType: "claude-code",
      workingDirectory: WORKING_DIRECTORY,
      sharedVariables: shared,
    });
    const zai = providerScopedEnvironment({
      adapterType: "zai-glm",
      workingDirectory: WORKING_DIRECTORY,
      sharedVariables: shared,
      profile: zaiProfile(),
    });

    assert.equal(codex.ZAI_API_KEY, undefined);
    assert.equal(codex.ANTHROPIC_API_KEY, undefined);
    assert.equal(codex.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(codex.OPENAI_API_KEY, "openai-key");

    assert.equal(claude.ZAI_API_KEY, undefined);
    assert.equal(claude.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(claude.ANTHROPIC_BASE_URL, undefined);
    assert.equal(claude.ANTHROPIC_API_KEY, "anthropic-key");
    assert.equal(claude.OPENAI_API_KEY, undefined);

    assert.equal(zai.ANTHROPIC_AUTH_TOKEN, TOKEN);
    assert.equal(zai.ANTHROPIC_BASE_URL, ZAI_ANTHROPIC_ENDPOINT);
    assert.equal(zai.ANTHROPIC_API_KEY, undefined, "a Claude key is not a Z.AI key");
    assert.equal(zai.OPENAI_API_KEY, undefined);
    assert.equal(zai.ZAI_API_KEY, TOKEN, "the source variable stays scoped to Z.AI");

    Object.values(codex).forEach((value) => assert.notEqual(value, TOKEN));
    Object.values(claude).forEach((value) => assert.notEqual(value, TOKEN));
  });
});

test("an absent Z.AI credential leaves the process with no token at all", () => {
  withEnvironment({ ZAI_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: "leftover" }, () => {
    const zai = providerScopedEnvironment({
      adapterType: "zai-glm",
      workingDirectory: WORKING_DIRECTORY,
      sharedVariables: ["ANTHROPIC_AUTH_TOKEN"],
      profile: zaiProfile(),
    });
    assert.equal(
      zai.ANTHROPIC_AUTH_TOKEN,
      undefined,
      "an unrelated ANTHROPIC_AUTH_TOKEN must never be reused as a Z.AI credential",
    );
  });
});

test("the Z.AI provider keeps its own identity and reuses the Claude Code transport", () => {
  const registry = createAdapterRegistry();
  assert.ok(registry.types().includes("zai-glm"));
  assert.equal(providerDisplayName("zai-glm"), "Z.AI GLM");
  assert.notEqual(providerDisplayName("zai-glm"), providerDisplayName("claude-code"));

  const seen = [];
  const adapter = registry.create(
    { id: "glm", name: "GLM", adapter: "zai-glm", command: "claude" },
    {
      bridge: {},
      browserOwnerId: "owner",
      log: () => undefined,
      commandCheckTimeoutMs: 1_000,
      requestTimeoutMs: 1_000,
      turnTimeoutMs: 1_000,
      interruptGraceMs: 1_000,
      environment: { SHARED: "1" },
      providerEnvironment: (adapterType) => {
        seen.push(adapterType);
        return { SCOPED: adapterType };
      },
      zaiModel: "glm-test-model",
      requestCodexApproval: async () => "",
      requestCodexUserInput: async () => ({}),
      requestCodexMcpElicitation: async () => ({}),
      requestClaudeUserInput: async () => ({}),
      requestClaudePermission: async () => ({}),
    },
  );
  assert.equal(adapter.adapterType, "zai-glm");
  assert.deepEqual(seen, ["zai-glm"], "the adapter asks only for its own scoped environment");
  assert.equal(adapter.capabilities.resume, true);

  assert.deepEqual(
    registry.validateDefinition({ id: "glm", adapter: "zai-glm", approvalPolicy: "onRequest" }),
    ["Agent glm adapter zai-glm does not support approvalPolicy"],
  );
});

test("the Z.AI preflight reports configuration without printing the credential", () => {
  const findings = zaiProfileFindings({
    profile: {
      command: "claude",
      baseUrl: ZAI_ANTHROPIC_ENDPOINT,
      tokenSourceVariable: ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE,
      model: "glm-test-model",
    },
    tokenPresent: true,
    commandAvailable: true,
    commandDetail: "claude: 1.0.0",
  });
  assert.deepEqual(findings.map((finding) => finding.ok), [true, true, true, true]);
  findings.forEach((finding) => {
    assert.doesNotMatch(finding.detail, new RegExp(TOKEN, "u"));
  });

  const broken = zaiProfileFindings({
    profile: {
      command: "claude",
      baseUrl: "http://api.z.ai/api/anthropic",
      tokenSourceVariable: ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE,
      model: "",
    },
    tokenPresent: false,
    commandAvailable: true,
  });
  assert.deepEqual(broken.map((finding) => finding.id), [
    "zai.command",
    "zai.endpoint",
    "zai.credential",
    "zai.model",
  ]);
  assert.equal(broken[1].ok, false, "a non-https endpoint is refused");
  assert.equal(broken[2].ok, false);
  assert.equal(broken[3].ok, false);
});

test("Doctor names the Z.AI configuration and never runs a model request", async () => {
  const commands = [];
  const checks = await withEnvironment({ ZAI_API_KEY: TOKEN }, () => runDoctorChecks({
    workspaceLabel: "repo",
    gitVersion: async () => "git version 2.45.0",
    providerVersion: async (command, adapterType) => {
      commands.push([command, adapterType]);
      return "1.0.0";
    },
    codexCommand: "codex",
    claudeCommand: "claude",
    zai: {
      profile: {
        command: "claude",
        baseUrl: ZAI_ANTHROPIC_ENDPOINT,
        tokenSourceVariable: ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE,
        model: "glm-test-model",
      },
      tokenPresent: true,
    },
  }));

  assert.deepEqual(
    commands.map(([command, adapterType]) => `${command}:${String(adapterType)}`),
    ["codex:undefined", "claude:undefined", "claude:zai-glm"],
    "Doctor only asks each provider for its version",
  );
  const zaiChecks = checks.filter((check) => check.name.startsWith("Z.AI GLM"));
  assert.equal(zaiChecks.length, 4);
  assert.ok(zaiChecks.every((check) => check.ok));
  checks.forEach((check) => {
    assert.doesNotMatch(check.detail, new RegExp(TOKEN, "u"));
    assert.equal(check.blocking, check.name === "Workspace" ? false : check.blocking);
  });
  assert.ok(
    zaiChecks.some((check) => check.detail.includes(ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE)),
    "the preflight names the variable, never its value",
  );
});

test("the Z.AI remediation explains the scoped credential and never asks Bachata to store it", () => {
  const plan = remediationPlan("provider.install.zai", {
    codexCommand: "codex",
    claudeCommand: "claude",
    zaiCommand: "claude",
    zaiTokenVariable: "ZAI_API_KEY",
  });
  assert.equal(plan.id, "provider.install.zai");
  assert.match(plan.steps.join(" "), /never stores it/u);
  assert.match(plan.steps.join(" "), /ZAI_API_KEY/u);
  assert.ok(plan.actions.some((action) => action.setting === "bachata.zaiModel"));
  assert.equal(plan.recheck.provider, "zai");
});
