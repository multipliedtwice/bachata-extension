const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProviderRegistry,
  providerKey,
} = require("../dist/providers/providerRegistry.js");
const {
  DISCOVERABLE_PROVIDERS,
  configuredProviderIdentities,
} = require("../dist/providers/providerDiscovery.js");
const {
  bundledCodexExecutables,
  isDefaultCodexCommand,
  resetCodexExecutableCache,
  resolveCodexExecutable,
} = require("../dist/providers/codexExecutable.js");

// A file-system double, so the resolution rules are asserted against a described machine rather
// than against whichever OpenAI extension happens to be installed on the machine running these
// tests.
const codexProbe = (tree) => ({
  listDirectory: (directory) => tree[directory] ?? [],
  isExecutableFile: (candidate) => tree.executables.includes(candidate),
});

const identity = (adapterType, command = "cmd", workingDirectory = "/repo") => ({
  adapterType,
  command,
  workingDirectory,
});

const countingRegistry = (answer = () => ({ outcome: "version", command: "cmd", version: "1.0.0" })) => {
  const calls = [];
  const registry = createProviderRegistry({
    probe: async (target) => {
      calls.push(providerKey(target));
      return answer(target);
    },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { registry, calls };
};

test("a provider identity is its adapter, its executable and the directory it runs in", () => {
  assert.equal(
    providerKey(identity("claude-code", "claude", "/repo")),
    providerKey({ adapterType: "claude-code", command: "claude", workingDirectory: "/repo" }),
  );
  // A different executable for the same adapter is a different provider, and a different directory
  // is a different answer, because both change what actually runs.
  assert.notEqual(
    providerKey(identity("claude-code", "claude")),
    providerKey(identity("claude-code", "/opt/claude")),
  );
  assert.notEqual(
    providerKey(identity("claude-code", "claude", "/a")),
    providerKey(identity("claude-code", "claude", "/b")),
  );
});

test("startup discovers each configured provider exactly once", async () => {
  const { registry, calls } = countingRegistry();
  const identities = [identity("codex-app-server"), identity("claude-code"), identity("zai-glm")];
  await registry.discover(identities);
  assert.equal(registry.probeCount(), 3);
  // Every later pass — a second conversation, a pipeline switch, a reassignment — asks again and
  // costs nothing, because the question was already answered.
  await registry.discover(identities);
  await registry.discover(identities);
  assert.equal(registry.probeCount(), 3);
  assert.equal(calls.length, 3);
});

test("concurrent startup checks are deduplicated into one probe per provider", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { registry, calls } = countingRegistry(async () => {
    await gate;
    return { outcome: "version", command: "cmd", version: "1.0.0" };
  });
  const identities = [identity("codex-app-server"), identity("claude-code")];
  // Two windows, or two conversations, starting at the same moment.
  const first = registry.discover(identities);
  const second = registry.discover(identities);
  assert.equal(registry.discovering(), true);
  release();
  await Promise.all([first, second]);
  assert.equal(registry.probeCount(), 2, "one probe per provider, not one per caller");
  assert.equal(calls.length, 2);
  assert.equal(registry.discovering(), false);
});

test("an unfinished provider is discovering, never unavailable", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { registry } = countingRegistry(async () => {
    await gate;
    return { outcome: "version", command: "cmd", version: "9.9.9" };
  });
  const target = identity("claude-code");
  assert.equal(registry.record(target).state, "unknown");
  const pending = registry.discover([target]);
  assert.equal(registry.record(target).state, "discovering");
  // Neither state claims the provider is missing; only a settled answer may.
  assert.notEqual(registry.record(target).state, "unavailable");
  release();
  await pending;
  assert.equal(registry.record(target).state, "available");
  assert.equal(registry.record(target).version, "9.9.9");
});

test("a provider that does not answer is unavailable and says why", async () => {
  const { registry } = countingRegistry(() => ({
    outcome: "failed",
    command: "claude",
    error: new Error("spawn ENOENT"),
  }));
  const target = identity("claude-code", "claude");
  await registry.discover([target]);
  assert.equal(registry.record(target).state, "unavailable");
  assert.match(registry.record(target).detail, /spawn ENOENT/u);
  // A settled negative is not asked again either; only invalidation reopens the question.
  await registry.discover([target]);
  assert.equal(registry.probeCount(), 1);
});

test("a missing credential is reported as such rather than as a missing executable", async () => {
  const { registry } = countingRegistry(() => ({
    outcome: "missingToken",
    tokenVariable: "ZAI_API_KEY",
    endpoint: "https://api.z.ai/api/anthropic",
  }));
  const target = identity("zai-glm");
  await registry.discover([target]);
  assert.equal(registry.record(target).state, "unavailable");
  assert.match(registry.record(target).detail, /ZAI_API_KEY is not set/u);
  assert.equal(registry.record(target).version, undefined);
});

test("invalidation refreshes only the provider it names", async () => {
  const { registry, calls } = countingRegistry();
  const codex = identity("codex-app-server", "codex");
  const claude = identity("claude-code", "claude");
  await registry.discover([codex, claude]);
  assert.equal(registry.probeCount(), 2);

  const dropped = registry.invalidate((record) => record.adapterType === "claude-code");
  assert.deepEqual(dropped.map((entry) => entry.adapterType), ["claude-code"]);
  assert.equal(registry.record(claude).state, "unknown");
  assert.equal(registry.record(codex).state, "available", "the untouched provider keeps its answer");

  await registry.discover([codex, claude]);
  assert.equal(registry.probeCount(), 3, "only the invalidated provider was asked again");
  assert.deepEqual(calls.slice(2), [providerKey(claude)]);
});

test("an adopted answer replaces the shared one without running a probe", async () => {
  const { registry } = countingRegistry();
  const target = identity("claude-code", "claude");
  await registry.discover([target]);
  assert.equal(registry.record(target).version, "1.0.0");
  registry.adopt(target, { outcome: "version", command: "claude", version: "2.5.0" });
  assert.equal(registry.record(target).version, "2.5.0");
  assert.equal(registry.probeCount(), 1, "adopting an answer is not a probe");
});

test("refresh asks again even when the answer was already settled", async () => {
  let version = "1.0.0";
  const { registry } = countingRegistry(() => ({ outcome: "version", command: "cmd", version }));
  const target = identity("claude-code");
  await registry.discover([target]);
  version = "3.0.0";
  await registry.discover([target]);
  assert.equal(registry.record(target).version, "1.0.0", "discovery reuses the cached answer");
  await registry.refresh([target]);
  assert.equal(registry.record(target).version, "3.0.0", "manual refresh is what asks again");
  assert.equal(registry.probeCount(), 2);
});

test("a probe that throws is an unavailable provider, not an unhandled rejection", async () => {
  const { registry } = countingRegistry(() => {
    throw new Error("probe exploded");
  });
  const target = identity("codex-app-server");
  await registry.discover([target]);
  assert.equal(registry.record(target).state, "unavailable");
  assert.match(registry.record(target).detail, /probe exploded/u);
});

test("subscribers are told when discovery starts and settles", async () => {
  const { registry } = countingRegistry();
  let notifications = 0;
  const subscription = registry.subscribe(() => { notifications += 1; });
  await registry.discover([identity("claude-code")]);
  assert.ok(notifications >= 2, "at least the discovering and settled transitions");
  subscription.dispose();
  const settledCount = notifications;
  await registry.refresh([identity("claude-code")]);
  assert.equal(notifications, settledCount, "a disposed subscriber hears nothing further");
});

test("the configured identities are the documented providers at their configured executables", () => {
  const settings = {
    get: (key, fallback) => (key === "claudeCommand" ? "/opt/homebrew/bin/claude" : fallback),
  };
  const identities = configuredProviderIdentities(settings, "/repo");
  assert.deepEqual(
    identities.map((entry) => [entry.adapterType, entry.command, entry.workingDirectory]),
    [
      // Codex's default name is resolved here rather than left to the PATH, and discovery,
      // Doctor, readiness and the adapter all ask the same resolver.
      ["codex-app-server", resolveCodexExecutable("codex"), "/repo"],
      ["claude-code", "/opt/homebrew/bin/claude", "/repo"],
      ["zai-glm", "claude", "/repo"],
    ],
  );
  assert.equal(DISCOVERABLE_PROVIDERS.length, 3);
});

test("a default codex resolves to the newest Codex the installed OpenAI extension carries", () => {
  const tree = {
    "/home/.vscode/extensions": [
      "openai.chatgpt-26.903.61454-darwin-arm64",
      "openai.chatgpt-26.903.71938-darwin-arm64",
      "openai.chatgpt-26.903.9-darwin-arm64",
      "some.other-1.0.0",
    ],
    "/home/.vscode/extensions/openai.chatgpt-26.903.61454-darwin-arm64/bin": ["macos-aarch64"],
    "/home/.vscode/extensions/openai.chatgpt-26.903.71938-darwin-arm64/bin": ["macos-aarch64"],
    "/home/.vscode/extensions/openai.chatgpt-26.903.9-darwin-arm64/bin": ["macos-aarch64"],
    executables: [
      "/home/.vscode/extensions/openai.chatgpt-26.903.61454-darwin-arm64/bin/macos-aarch64/codex",
      "/home/.vscode/extensions/openai.chatgpt-26.903.71938-darwin-arm64/bin/macos-aarch64/codex",
      "/home/.vscode/extensions/openai.chatgpt-26.903.9-darwin-arm64/bin/macos-aarch64/codex",
    ],
  };
  const overrides = {
    extensionDirectories: ["/home/.vscode/extensions"],
    probe: codexProbe(tree),
    platform: "darwin",
    arch: "arm64",
  };
  assert.deepEqual(
    bundledCodexExecutables(overrides).map((entry) => entry.extensionVersion),
    ["26.903.71938", "26.903.61454", "26.903.9"],
    "versions are ordered numerically, so 71938 beats 9",
  );
  assert.equal(
    resolveCodexExecutable("codex", overrides),
    "/home/.vscode/extensions/openai.chatgpt-26.903.71938-darwin-arm64/bin/macos-aarch64/codex",
  );
});

test("an explicitly configured codex command is never replaced", () => {
  const overrides = {
    extensionDirectories: ["/home/.vscode/extensions"],
    probe: codexProbe({
      "/home/.vscode/extensions": ["openai.chatgpt-26.903.71938-darwin-arm64"],
      "/home/.vscode/extensions/openai.chatgpt-26.903.71938-darwin-arm64/bin": ["macos-aarch64"],
      executables: [
        "/home/.vscode/extensions/openai.chatgpt-26.903.71938-darwin-arm64/bin/macos-aarch64/codex",
      ],
    }),
    platform: "darwin",
    arch: "arm64",
  };
  assert.equal(isDefaultCodexCommand("codex"), true);
  assert.equal(isDefaultCodexCommand("  codex  "), true);
  assert.equal(isDefaultCodexCommand("/opt/custom/codex"), false);
  assert.equal(resolveCodexExecutable("/opt/custom/codex", overrides), "/opt/custom/codex");
  assert.equal(resolveCodexExecutable("codex-nightly", overrides), "codex-nightly");
});

test("a machine with no bundled Codex keeps the name the PATH answers", () => {
  const overrides = {
    extensionDirectories: ["/home/.vscode/extensions"],
    probe: codexProbe({ "/home/.vscode/extensions": ["some.other-1.0.0"], executables: [] }),
    platform: "darwin",
    arch: "arm64",
  };
  assert.deepEqual(bundledCodexExecutables(overrides), []);
  assert.equal(resolveCodexExecutable("codex", overrides), "codex");
  assert.equal(resolveCodexExecutable(undefined, overrides), "codex");
  assert.equal(resolveCodexExecutable("   ", overrides), "codex");
});

test("resolution is stable for the life of the process, so discovery and execution cannot disagree", () => {
  resetCodexExecutableCache();
  const first = resolveCodexExecutable("codex");
  assert.equal(resolveCodexExecutable("codex"), first);
  resetCodexExecutableCache();
  assert.equal(resolveCodexExecutable("codex"), first);
});

// Which Codex an extension host may run.
//
// On macOS and Linux every target's binary is called `codex`, and a machine can hold Stable,
// Insiders and one or more server trees at once. Picking whichever directory carried the highest
// version is therefore not a choice between Codex versions — it is a choice between operating
// systems, CPU architectures and extension hosts, made on a number that says nothing about any of
// them. These cover what the resolver now insists on instead.

const MIXED_HOST_TREE = {
  "/home/.vscode/extensions": [
    "bachata.bachata-0.7.1",
    "openai.chatgpt-26.903.10-darwin-arm64",
  ],
  "/home/.vscode/extensions/openai.chatgpt-26.903.10-darwin-arm64/bin": ["macos-aarch64"],
  "/home/.vscode-insiders/extensions": ["openai.chatgpt-26.910.50-darwin-x64"],
  "/home/.vscode-insiders/extensions/openai.chatgpt-26.910.50-darwin-x64/bin": ["macos-x86_64"],
  "/home/.vscode-server/extensions": ["openai.chatgpt-26.920.99-linux-x64"],
  "/home/.vscode-server/extensions/openai.chatgpt-26.920.99-linux-x64/bin": ["linux-x86_64"],
  executables: [
    "/home/.vscode/extensions/openai.chatgpt-26.903.10-darwin-arm64/bin/macos-aarch64/codex",
    "/home/.vscode-insiders/extensions/openai.chatgpt-26.910.50-darwin-x64/bin/macos-x86_64/codex",
    "/home/.vscode-server/extensions/openai.chatgpt-26.920.99-linux-x64/bin/linux-x86_64/codex",
  ],
};

const mixedHostSources = (overrides = {}) => ({
  extensionDirectories: [
    "/home/.vscode/extensions",
    "/home/.vscode-insiders/extensions",
    "/home/.vscode-server/extensions",
  ],
  probe: codexProbe(MIXED_HOST_TREE),
  platform: "darwin",
  arch: "arm64",
  ...overrides,
});

test("an ARM macOS host never resolves an x64 or Linux Codex, however new it is", () => {
  const sources = mixedHostSources();
  assert.deepEqual(
    bundledCodexExecutables(sources).map((entry) => entry.path),
    ["/home/.vscode/extensions/openai.chatgpt-26.903.10-darwin-arm64/bin/macos-aarch64/codex"],
    "a build for another OS or CPU was offered to this host",
  );
  assert.equal(
    resolveCodexExecutable("codex", sources),
    "/home/.vscode/extensions/openai.chatgpt-26.903.10-darwin-arm64/bin/macos-aarch64/codex",
    "the newest directory won over the only binary this machine can execute",
  );
});

test("a Linux host resolves the Linux build the same tree also carries", () => {
  assert.equal(
    resolveCodexExecutable("codex", mixedHostSources({ platform: "linux", arch: "x64" })),
    "/home/.vscode-server/extensions/openai.chatgpt-26.920.99-linux-x64/bin/linux-x86_64/codex",
  );
});

test("the tree a host loads from decides, not the highest version across trees", () => {
  const tree = {
    "/home/.vscode/extensions": ["openai.chatgpt-26.903.10-darwin-arm64"],
    "/home/.vscode/extensions/openai.chatgpt-26.903.10-darwin-arm64/bin": ["macos-aarch64"],
    "/home/.vscode-insiders/extensions": ["openai.chatgpt-26.999.1-darwin-arm64"],
    "/home/.vscode-insiders/extensions/openai.chatgpt-26.999.1-darwin-arm64/bin": ["macos-aarch64"],
    executables: [
      "/home/.vscode/extensions/openai.chatgpt-26.903.10-darwin-arm64/bin/macos-aarch64/codex",
      "/home/.vscode-insiders/extensions/openai.chatgpt-26.999.1-darwin-arm64/bin/macos-aarch64/codex",
    ],
  };
  const stable = "/home/.vscode/extensions/openai.chatgpt-26.903.10-darwin-arm64/bin/macos-aarch64/codex";
  const insiders =
    "/home/.vscode-insiders/extensions/openai.chatgpt-26.999.1-darwin-arm64/bin/macos-aarch64/codex";
  const sources = {
    extensionDirectories: ["/home/.vscode/extensions", "/home/.vscode-insiders/extensions"],
    probe: codexProbe(tree),
    platform: "darwin",
    arch: "arm64",
  };
  assert.equal(
    resolveCodexExecutable("codex", sources),
    stable,
    "a newer Insiders install outranked the Stable tree listed first",
  );
  assert.equal(
    resolveCodexExecutable("codex", { ...sources, extensionsDirectory: "/home/.vscode-insiders/extensions" }),
    insiders,
    "the tree this host loads from did not decide",
  );
  assert.equal(
    resolveCodexExecutable("codex", {
      ...sources,
      openAiExtensionPath: "/home/.vscode/extensions/openai.chatgpt-26.903.10-darwin-arm64",
      extensionsDirectory: "/home/.vscode-insiders/extensions",
    }),
    stable,
    "the extension the host actually loaded lost to a higher version elsewhere",
  );
});

test("the host's own extension is used even when nothing in its path states a target", () => {
  const tree = {
    "/host/extensions": ["openai.chatgpt-26.903.10"],
    "/host/extensions/openai.chatgpt-26.903.10/bin": [],
    executables: ["/host/extensions/openai.chatgpt-26.903.10/bin/codex"],
  };
  const sources = {
    extensionDirectories: ["/host/extensions"],
    probe: codexProbe(tree),
    platform: "darwin",
    arch: "arm64",
  };
  assert.equal(
    resolveCodexExecutable("codex", sources),
    "codex",
    "a scanned build that proves nothing about its target was treated as compatible",
  );
  assert.equal(
    resolveCodexExecutable("codex", {
      ...sources,
      openAiExtensionPath: "/host/extensions/openai.chatgpt-26.903.10",
    }),
    "/host/extensions/openai.chatgpt-26.903.10/bin/codex",
    "the extension this host loaded was refused for saying nothing Bachata already knows",
  );
});

test("an incompatible host extension falls back to the PATH rather than to a foreign build", () => {
  const sources = mixedHostSources({
    openAiExtensionPath: "/home/.vscode-server/extensions/openai.chatgpt-26.920.99-linux-x64",
    platform: "win32",
    arch: "x64",
  });
  assert.equal(
    resolveCodexExecutable("codex", sources),
    "codex",
    "a Windows host ran a Linux binary the host happened to point at",
  );
});

test("an explicit codex command survives every host and tree", () => {
  assert.equal(
    resolveCodexExecutable(
      "/opt/custom/codex",
      mixedHostSources({
        openAiExtensionPath: "/home/.vscode/extensions/openai.chatgpt-26.903.10-darwin-arm64",
      }),
    ),
    "/opt/custom/codex",
  );
});

// Probe lifecycle, on probes that have not answered yet.
//
// Every case above resolves its probe before the next line runs, which is the one arrangement in
// which a retired probe cannot be observed. The defect was exactly there: invalidating a key
// dropped its record and left its probe in the in-flight map, so the rediscovery that a
// configuration change exists to trigger found the retired probe, waited for it, and published the
// answer it had earned under the configuration that was just replaced.

const deferred = () => {
  let settle = () => undefined;
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
};

const deferredRegistry = () => {
  const probes = [];
  const registry = createProviderRegistry({
    probe: (target) => {
      const pending = deferred();
      probes.push({ key: providerKey(target), settle: pending.settle });
      return pending.promise;
    },
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { registry, probes };
};

const version = (value) => ({ outcome: "version", command: "cmd", version: value });

test("a retired probe does not stand in the way of asking again", async () => {
  const { registry, probes } = deferredRegistry();
  const target = identity("claude-code");
  const first = registry.discover([target]);
  assert.equal(probes.length, 1);
  registry.invalidate((record) => record.adapterType === "claude-code");
  assert.equal(registry.discovering(), false, "a retired probe is still counted as current work");
  const second = registry.discover([target]);
  assert.equal(probes.length, 2, "the retired probe was awaited instead of a new one starting");
  assert.equal(registry.discovering(), true);

  probes[0].settle(version("1.0.0"));
  await first;
  assert.equal(registry.record(target).state, "discovering", "a retired probe published its answer");
  assert.equal(registry.record(target).version, undefined);
  assert.equal(registry.discovering(), true, "the retired probe evicted the probe that replaced it");

  probes[1].settle(version("2.0.0"));
  await second;
  assert.equal(registry.record(target).version, "2.0.0");
  assert.equal(registry.discovering(), false);
});

test("the current probe stays authoritative when the retired one answers after it", async () => {
  const { registry, probes } = deferredRegistry();
  const target = identity("claude-code");
  const first = registry.discover([target]);
  registry.invalidate(() => true);
  const second = registry.discover([target]);

  probes[1].settle(version("2.0.0"));
  await second;
  assert.equal(registry.record(target).version, "2.0.0");

  probes[0].settle(version("1.0.0"));
  await first;
  assert.equal(registry.record(target).version, "2.0.0", "a late retired answer overwrote the current one");
  assert.equal(registry.record(target).state, "available");
});

test("invalidating a key a consumer no longer asks about keeps its answer gone", async () => {
  const { registry, probes } = deferredRegistry();
  const target = { ...identity("ollama-openai", "http://127.0.0.1:11434"), requestScope: "interpreter" };
  const pass = registry.discover([target]);
  registry.invalidate(() => true);
  probes[0].settle(version("0.5.0"));
  await pass;
  assert.deepEqual(registry.records(), [], "the retired probe repopulated a record nobody asked for");
  assert.equal(registry.record(target).state, "unknown");
});

test("a refresh during an unfinished probe keeps the refreshed answer", async () => {
  const { registry, probes } = deferredRegistry();
  const target = identity("codex-app-server");
  const first = registry.discover([target]);
  const refreshed = registry.refresh([target]);
  assert.equal(probes.length, 2, "the refresh awaited the probe it exists to replace");

  probes[1].settle(version("9.0.0"));
  await refreshed;
  assert.equal(registry.record(target).version, "9.0.0");

  probes[0].settle(version("1.0.0"));
  await first;
  assert.equal(registry.record(target).version, "9.0.0", "the refreshed answer was overwritten");
});

test("an adopted answer survives the retired probe it replaced", async () => {
  const { registry, probes } = deferredRegistry();
  const target = identity("claude-code");
  const pass = registry.discover([target]);
  registry.invalidate(() => true);
  registry.adopt(target, version("7.0.0"));
  assert.equal(registry.record(target).version, "7.0.0");

  probes[0].settle(version("1.0.0"));
  await pass;
  assert.equal(registry.record(target).version, "7.0.0", "a retired probe overwrote an adopted answer");
  assert.equal(registry.probeCount(), 1, "adopting an answer is not a probe");
});

test("a current probe still wins over an adopted answer, which is not a retired one", async () => {
  const { registry, probes } = deferredRegistry();
  const target = identity("claude-code");
  const pass = registry.discover([target]);
  registry.adopt(target, version("7.0.0"));
  assert.equal(registry.record(target).state, "discovering", "an adopted answer landed in front of a live probe");
  probes[0].settle(version("1.0.0"));
  await pass;
  assert.equal(registry.record(target).version, "1.0.0");
});

test("a retired probe announces nothing, so no subscriber sees it settle", async () => {
  const { registry, probes } = deferredRegistry();
  const target = identity("claude-code");
  const seen = [];
  const subscription = registry.subscribe(() => {
    seen.push(`${registry.record(target).state}:${String(registry.discovering())}`);
  });
  const pass = registry.discover([target]);
  assert.deepEqual(seen, ["discovering:true"]);
  registry.invalidate(() => true);
  const afterInvalidation = seen.length;

  probes[0].settle(version("1.0.0"));
  await pass;
  assert.equal(seen.length, afterInvalidation, "a retired probe announced a settled transition");
  assert.equal(
    seen.some((entry) => entry.startsWith("available")),
    false,
    "a subscriber was told a retired probe's answer was available",
  );
  subscription.dispose();
});

test("what a key answers for includes its request scope, so what was dropped can be refreshed", async () => {
  const { registry, calls } = countingRegistry();
  const healing = { ...identity("ollama-openai", "http://127.0.0.1:11434"), requestScope: "healing" };
  const interpreter = { ...identity("ollama-openai", "http://127.0.0.1:11434"), requestScope: "interpreter" };
  await registry.discover([healing, interpreter]);
  assert.equal(registry.probeCount(), 2, "two different questions shared one answer");
  assert.notEqual(providerKey(healing), providerKey(interpreter));

  const dropped = registry.invalidate((record) => record.requestScope === "healing");
  assert.deepEqual(dropped, [{
    adapterType: "ollama-openai",
    command: "http://127.0.0.1:11434",
    workingDirectory: "/repo",
    requestScope: "healing",
  }]);
  assert.equal(registry.record(healing).state, "unknown");
  assert.equal(registry.record(interpreter).state, "available", "the other scope lost its answer");

  // Refreshing exactly what was dropped is the whole point of the returned identities: an identity
  // rebuilt without its request scope is an identity for a question nobody asked.
  await registry.refresh(dropped);
  assert.equal(registry.record(healing).state, "available");
  assert.deepEqual(calls.slice(2), [providerKey(healing)]);
});
