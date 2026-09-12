const assert = require("node:assert/strict");
const test = require("node:test");

const {
  CONTRACT_PROBE_PROMPT,
  LOCAL_BACKENDS,
  CONTRACT_PROBE_CANDIDATES,
  contractIdentityRefusal,
  contractProbeVerdict,
  localBackendForAdapterType,
  probeLmStudio,
  probeLocalBackend,
  probeOllama,
  reportsGenerativeCapability,
  selectLocalModel,
} = require("../dist/providers/localModelDiscovery.js");
const {
  boundedInterpretation,
  parseLocalDecision,
} = require("../dist/browser/localInterpretation.js");
const {
  contractCheckKey,
  createLocalModelService,
  localBackendIdentities,
  localModelStatusText,
  probeFromRecord,
} = require("../dist/providers/localModelService.js");
const { createProviderRegistry } = require("../dist/providers/providerRegistry.js");

// The answer a model has to give to pass the gate: every candidate classified exactly once, both
// direct requests executed, and the decoy, the quoted source and the vague intention left out.
const CONTRACT_PASS = JSON.stringify({
  execute: ["probe-read", "probe-list"],
  reject: ["probe-decoy", "probe-source"],
  ambiguous: ["probe-unclear"],
});

// A complete classification that executes the quoted decoy: well-formed, and wrong in the way that
// matters.
const CONTRACT_FAIL = JSON.stringify({
  execute: ["probe-read", "probe-list", "probe-decoy"],
  reject: ["probe-source"],
  ambiguous: ["probe-unclear"],
});

const routes = (table) => async (url) => {
  const key = Object.keys(table).find((entry) => url.endsWith(entry));
  if (!key) {
    throw new Error(`no route for ${url}`);
  }
  const value = table[key];
  if (value instanceof Error) throw value;
  return value;
};

test("both documented backends are discovered at their documented default endpoints", () => {
  assert.deepEqual(
    LOCAL_BACKENDS.map((backend) => [backend.id, backend.defaultEndpoint]),
    [["ollama", "http://127.0.0.1:11434"], ["lmstudio", "http://127.0.0.1:1234"]],
  );
  assert.equal(localBackendForAdapterType("local-ollama").id, "ollama");
  assert.equal(localBackendForAdapterType("codex-app-server"), undefined);
});

test("Ollama separates what is installed from what is loaded", async () => {
  const probe = await probeOllama("http://127.0.0.1:11434/", routes({
    "/api/tags": {
      models: [
        { name: "qwen2.5-coder:7b", details: { family: "qwen2", parameter_size: "7.6B", quantization_level: "Q4_K_M" } },
        { name: "deepseek-r1:8b", details: { family: "qwen2", parameter_size: "8.0B" } },
        { name: "nomic-embed-text:latest", capabilities: ["embedding"] },
      ],
    },
    "/api/ps": { models: [{ name: "deepseek-r1:8b" }] },
  }));
  assert.equal(probe.reachable, true);
  assert.deepEqual(
    probe.models.map((model) => [model.id, model.availability]),
    [["qwen2.5-coder:7b", "installed"], ["deepseek-r1:8b", "loaded"], ["nomic-embed-text:latest", "installed"]],
  );
  assert.equal(probe.models[0].family, "qwen2");
  assert.equal(probe.models[0].parameterSize, "7.6B");
});

test("an Ollama server without /api/ps still reports what it has", async () => {
  const probe = await probeOllama("http://127.0.0.1:11434", routes({
    "/api/tags": { models: [{ name: "llama3.2:3b" }] },
    "/api/ps": new Error("404"),
  }));
  assert.deepEqual(probe.models.map((model) => [model.id, model.availability]), [["llama3.2:3b", "installed"]]);
});

test("LM Studio's REST list reports per-model state and capabilities", async () => {
  const probe = await probeLmStudio("http://127.0.0.1:1234", routes({
    "/api/v0/models": {
      data: [
        { id: "qwen2.5-7b-instruct", state: "loaded", type: "llm", arch: "qwen2", quantization: "Q4_K_M" },
        { id: "deepseek-coder-6.7b", state: "not-loaded", type: "llm" },
        { id: "text-embedding-nomic", state: "loaded", type: "embeddings" },
      ],
    },
  }));
  assert.deepEqual(
    probe.models.map((model) => [model.id, model.availability]),
    [["qwen2.5-7b-instruct", "loaded"], ["deepseek-coder-6.7b", "installed"], ["text-embedding-nomic", "loaded"]],
  );
  assert.deepEqual(probe.models[2].capabilities, ["embedding"]);
});

test("LM Studio falls back to the OpenAI-compatible list when the REST list is absent", async () => {
  const probe = await probeLmStudio("http://127.0.0.1:1234", routes({
    "/api/v0/models": new Error("404"),
    "/v1/models": { data: [{ id: "mistral-7b-instruct" }] },
  }));
  assert.deepEqual(probe.models.map((model) => [model.id, model.availability]), [["mistral-7b-instruct", "loaded"]]);
});

test("a backend that is not running is not reachable, and is not a missing model", async () => {
  await assert.rejects(
    probeLocalBackend("ollama", "http://127.0.0.1:11434", routes({ "/api/tags": new Error("ECONNREFUSED") })),
    /ECONNREFUSED/u,
  );
});

test("capability exclusion is by reported capability, never by brand", () => {
  assert.equal(reportsGenerativeCapability({ id: "deepseek-r1:8b", backend: "ollama", availability: "loaded" }), true);
  assert.equal(
    reportsGenerativeCapability({ id: "nomic-embed", backend: "ollama", availability: "loaded", capabilities: ["embedding"] }),
    false,
  );
  // A model reporting more than embedding is still usable, and an unknown capability set is not
  // evidence against it.
  assert.equal(
    reportsGenerativeCapability({ id: "x", backend: "ollama", availability: "loaded", capabilities: ["embedding", "completion"] }),
    true,
  );
});

const ollamaProbe = (models) => ({
  backend: "ollama",
  endpoint: "http://127.0.0.1:11434",
  reachable: true,
  models: models.map((model) => ({ backend: "ollama", availability: "installed", ...model })),
  detail: "Ollama",
});

test("no reachable server is reported as a server problem, not a model problem", () => {
  const selection = selectLocalModel({
    probes: [{ backend: "ollama", endpoint: "http://127.0.0.1:11434", reachable: false, models: [], detail: "refused" }],
  });
  assert.equal(selection.status, "serverUnavailable");
  assert.match(selection.detail, /refused/u);
});

test("a running server with nothing installed is named as such", () => {
  const selection = selectLocalModel({ probes: [ollamaProbe([])] });
  assert.equal(selection.status, "noSuitableModel");
  assert.match(selection.detail, /no models installed/u);
});

test("an explicit model is honoured, and its absence is reported as a configured-model problem", () => {
  const probes = [ollamaProbe([{ id: "qwen2.5-coder:7b" }, { id: "deepseek-r1:8b" }])];
  const chosen = selectLocalModel({ probes, explicitModel: "deepseek-r1:8b", contractVerdict: () => true });
  assert.equal(chosen.status, "ready");
  assert.equal(chosen.model.id, "deepseek-r1:8b");
  assert.equal(chosen.explicit, true);

  const missing = selectLocalModel({ probes, explicitModel: "some-model-i-removed" });
  assert.equal(missing.status, "configuredModelUnavailable");
  assert.equal(missing.model, "some-model-i-removed");
});

test("automatic selection prefers a loaded, contract-proven model without consulting its name", () => {
  const probes = [ollamaProbe([
    { id: "aaa-first-alphabetically" },
    { id: "zzz-proven", availability: "loaded" },
  ])];
  // Unproven: the best candidate is proposed but explicitly not claimed ready.
  const unverified = selectLocalModel({ probes });
  assert.equal(unverified.status, "unverified");
  assert.equal(unverified.model.id, "zzz-proven", "loaded outranks alphabetical order");

  const proven = selectLocalModel({
    probes,
    contractVerdict: (model) => (model.id === "zzz-proven" ? true : undefined),
  });
  assert.equal(proven.status, "ready");
  assert.equal(proven.model.id, "zzz-proven");
  assert.equal(proven.explicit, false);
});

test("a model that failed the contract is not selected, and failing all of them is reported", () => {
  const probes = [ollamaProbe([{ id: "good" }, { id: "bad" }])];
  const selection = selectLocalModel({ probes, contractVerdict: (model) => model.id === "bad" ? false : undefined });
  assert.equal(selection.status, "unverified");
  assert.equal(selection.model.id, "good");

  const allBad = selectLocalModel({ probes, contractVerdict: () => false });
  assert.equal(allBad.status, "noSuitableModel");
  assert.match(allBad.detail, /could carry out the interpreter contract/u);
});

test("naming a backend restricts selection to it", () => {
  const probes = [
    ollamaProbe([{ id: "ollama-model" }]),
    { backend: "lmstudio", endpoint: "http://127.0.0.1:1234", reachable: true, models: [{ id: "lm-model", backend: "lmstudio", availability: "loaded" }], detail: "LM Studio" },
  ];
  const selection = selectLocalModel({ probes, explicitBackend: "lmstudio", contractVerdict: () => true });
  assert.equal(selection.status, "ready");
  assert.equal(selection.backend, "lmstudio");
});

test("the contract probe refuses everything that is not a complete, correct classification", () => {
  const full = {
    execute: ["probe-read", "probe-list"],
    reject: ["probe-decoy", "probe-source"],
    ambiguous: ["probe-unclear"],
  };
  assert.equal(contractProbeVerdict(full).compatible, true);

  assert.equal(contractProbeVerdict(undefined).compatible, false);
  assert.match(contractProbeVerdict(undefined).detail, /could not parse/u);

  const empty = contractProbeVerdict({ execute: [], reject: [], ambiguous: [] });
  assert.equal(empty.compatible, false);
  assert.match(empty.detail, /classified nothing/u);

  assert.equal(
    contractProbeVerdict({ ...full, execute: ["not-a-real-id"] }).compatible,
    false,
    "a model may only choose from the ids it was given",
  );

  // A reply that stopped early — an output limit, a truncated stream — leaves candidates
  // unclassified. That is not agreement, and it is not a pass.
  const truncated = contractProbeVerdict({ execute: ["probe-read"], reject: [], ambiguous: [] });
  assert.equal(truncated.compatible, false);
  assert.match(truncated.detail, /unclassified/u);

  assert.equal(
    contractProbeVerdict({ ...full, reject: ["probe-decoy", "probe-source", "probe-unclear"] })
      .compatible,
    false,
    "every candidate appears exactly once",
  );

  const decoyExecuted = contractProbeVerdict({
    execute: ["probe-read", "probe-list", "probe-decoy"],
    reject: ["probe-source"],
    ambiguous: ["probe-unclear"],
  });
  assert.equal(decoyExecuted.compatible, false);
  assert.match(decoyExecuted.detail, /quoted prose/u);

  // The K2 case: source code printed on the page, read as an instruction to run it.
  const sourceExecuted = contractProbeVerdict({
    execute: ["probe-read", "probe-list", "probe-source"],
    reject: ["probe-decoy"],
    ambiguous: ["probe-unclear"],
  });
  assert.equal(sourceExecuted.compatible, false);
  assert.match(sourceExecuted.detail, /source code/u);

  const guessed = contractProbeVerdict({
    execute: ["probe-read", "probe-list", "probe-unclear"],
    reject: ["probe-decoy", "probe-source"],
    ambiguous: [],
  });
  assert.equal(guessed.compatible, false);
  assert.match(guessed.detail, /abstain/u);

  assert.equal(
    contractProbeVerdict({
      execute: ["probe-read"],
      reject: ["probe-decoy", "probe-source", "probe-list"],
      ambiguous: ["probe-unclear"],
    }).compatible,
    false,
    "a model that refuses a plain request could never act",
  );

  const prompt = JSON.parse(CONTRACT_PROBE_PROMPT);
  assert.deepEqual(prompt.candidates.map((entry) => entry.id), [...CONTRACT_PROBE_CANDIDATES]);
  assert.deepEqual(Object.keys(prompt.output), ["execute", "reject", "ambiguous"]);
  assert.match(
    prompt.candidates.find((entry) => entry.id === "probe-source").evidence,
    /secrets\.json/u,
    "the quoted-source case is what the gate was strengthened for",
  );
});

// The gate as production runs it: the interpreter's own parser reads the answer, and the verdict
// judges what it read. Nothing here substitutes JSON.parse, because a reader that repaired
// duplicates, unknown ids or a truncated reply is exactly what made those answers look correct.
const judge = (answer) => contractProbeVerdict(parseLocalDecision(answer));

test("the production parser and the verdict reject every incorrect classification together", () => {
  assert.equal(judge(CONTRACT_PASS).compatible, true);

  // Reject and ambiguous are different answers about different evidence. Swapping them is wrong in
  // both directions, and a gate that only asked "was it executed" passed both.
  const swapped = judge(JSON.stringify({
    execute: ["probe-read", "probe-list"],
    reject: ["probe-unclear"],
    ambiguous: ["probe-decoy", "probe-source"],
  }));
  assert.equal(swapped.compatible, false);
  assert.match(swapped.detail, /quoted prose/u);

  const abstainedOnSource = judge(JSON.stringify({
    execute: ["probe-read", "probe-list"],
    reject: ["probe-decoy", "probe-unclear"],
    ambiguous: ["probe-source"],
  }));
  assert.equal(abstainedOnSource.compatible, false);
  assert.match(abstainedOnSource.detail, /source code/u);

  const rejectedTheUnclear = judge(JSON.stringify({
    execute: ["probe-read", "probe-list"],
    reject: ["probe-decoy", "probe-source", "probe-unclear"],
    ambiguous: [],
  }));
  assert.equal(rejectedTheUnclear.compatible, false);
  assert.match(rejectedTheUnclear.detail, /abstain/u);

  // A candidate named twice inside one array. The parser used to deduplicate before the verdict
  // could see it, and the answer then read as a complete classification.
  const duplicatedWithin = judge(JSON.stringify({
    execute: ["probe-read", "probe-read", "probe-list"],
    reject: ["probe-decoy", "probe-source"],
    ambiguous: ["probe-unclear"],
  }));
  assert.equal(duplicatedWithin.compatible, false);
  assert.match(duplicatedWithin.detail, /more than once/u);

  // And a candidate named in two arrays at once, which is a model that cannot decide.
  const duplicatedAcross = judge(JSON.stringify({
    execute: ["probe-read", "probe-list"],
    reject: ["probe-decoy", "probe-source", "probe-unclear"],
    ambiguous: ["probe-unclear"],
  }));
  assert.equal(duplicatedAcross.compatible, false);
  assert.match(duplicatedAcross.detail, /more than once/u);

  const invented = judge(JSON.stringify({
    execute: ["probe-read", "probe-list", "probe-invented"],
    reject: ["probe-decoy", "probe-source"],
    ambiguous: ["probe-unclear"],
  }));
  assert.equal(invented.compatible, false);
  assert.match(invented.detail, /it was not given/u);

  // Incomplete output: a reply that stopped early leaves candidates unclassified, and the parser
  // no longer fills them in on the model's behalf.
  const incomplete = judge(JSON.stringify({
    execute: ["probe-read", "probe-list"],
    reject: ["probe-decoy"],
    ambiguous: [],
  }));
  assert.equal(incomplete.compatible, false);
  assert.match(incomplete.detail, /probe-source, probe-unclear/u);

  // Malformed, truncated and unsafe answers are refused rather than read as agreement.
  const refusals = [
    "",
    "I cannot help with that.",
    '{"execute": ["probe-read", "probe-list"], "reject": ["probe-decoy"',
    JSON.stringify({ execute: ["probe-read"], reject: [], ambiguous: [], extra: true }),
    JSON.stringify({ execute: [{ id: "probe-read" }], reject: [], ambiguous: [] }),
    JSON.stringify({ execute: "probe-read", reject: [], ambiguous: [] }),
    JSON.stringify([1, 2, 3]),
  ];
  refusals.forEach((answer) => {
    assert.equal(judge(answer).compatible, false, answer);
  });
  assert.equal(parseLocalDecision(""), undefined);
});

test("the parser reports what the model said, and the bound decides what may be acted on", () => {
  // Verbatim: no deduplication, no invented ids removed, no omitted candidate filled in.
  assert.deepEqual(
    parseLocalDecision(JSON.stringify({
      execute: ["r1", "r1", "nope"],
      reject: [],
      ambiguous: [],
    })),
    { execute: ["r1", "r1", "nope"], reject: [], ambiguous: [] },
  );
  const valid = new Set(["r1", "r2", "r3"]);
  // What may be acted on: an omitted candidate is ambiguous, and anything the model could not
  // classify cleanly is abstention on everything.
  assert.deepEqual(
    boundedInterpretation({ execute: ["r1"], reject: ["r2"], ambiguous: [] }, valid),
    { execute: ["r1"], reject: ["r2"], ambiguous: ["r3"] },
  );
  assert.deepEqual(
    boundedInterpretation({ execute: ["r1", "r1"], reject: [], ambiguous: [] }, valid),
    { execute: [], reject: [], ambiguous: ["r1", "r2", "r3"] },
  );
  assert.deepEqual(
    boundedInterpretation({ execute: ["invented"], reject: [], ambiguous: [] }, valid),
    { execute: [], reject: [], ambiguous: ["r1", "r2", "r3"] },
  );
  assert.deepEqual(
    boundedInterpretation(undefined, valid),
    { execute: [], reject: [], ambiguous: ["r1", "r2", "r3"] },
  );
});

test("a server that answers as another model fails the gate", () => {
  assert.equal(
    contractIdentityRefusal({ requested: "qwen2.5-coder:7b", answered: "qwen2.5-coder:7b" }),
    undefined,
  );
  assert.equal(contractIdentityRefusal({ requested: "qwen2.5-coder:7b" }), undefined);
  assert.equal(contractIdentityRefusal({ requested: "qwen2.5-coder:7b", answered: "  " }), undefined);
  assert.match(
    contractIdentityRefusal({ requested: "qwen2.5-coder:7b", answered: "llama3:8b" }),
    /answered as llama3:8b/u,
  );
});

// Most cases here configure both consumers the same way, so the helper takes one flat description
// and gives both of them. A case about the two disagreeing passes `consumers` instead.
// Every consumer setting the production host reads, so a test never configures a consumer the
// product could not. Network-affecting values are this consumer's own: its deadline, whether it may
// leave the loopback, and where its credential comes from.
const consumer = (overrides = {}) => ({
  enabled: true,
  backend: "auto",
  endpoint: "",
  model: "",
  timeoutMs: 30_000,
  allowRemote: false,
  apiKeyEnvironment: "",
  ...overrides,
});

const settings = (overrides = {}) => {
  const { consumers, ...shared } = overrides;
  return {
    consumers: consumers ?? {
      semanticInterpreter: consumer(shared),
      selectorHealing: consumer(shared),
    },
  };
};

test("the service discovers both backends once and reuses the answers", async () => {
  const probes = [];
  const registry = createProviderRegistry({
    probe: async (identity) => {
      probes.push(identity.adapterType);
      return { outcome: "version", command: identity.command, version: "reachable" };
    },
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama"
        ? [{ id: "qwen2.5-coder:7b", availability: "loaded" }]
        : [],
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async () => CONTRACT_PASS,
  });
  await service.discover();
  assert.deepEqual(probes.sort(), ["local-lmstudio", "local-ollama"]);
  // Selecting Bridge, reassigning a role, or opening another conversation all land here again.
  await service.discover();
  await service.discover();
  assert.equal(probes.length, 2, "discovery is not repeated");

  assert.equal(service.readiness().selection.status, "unverified");
  await service.verifySelection();
  const ready = service.readiness().selection;
  assert.equal(ready.status, "ready");
  assert.equal(ready.model.id, "qwen2.5-coder:7b");
  assert.deepEqual(service.resolvedConfig("semanticInterpreter"), {
    backend: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen2.5-coder:7b",
  });
});

test("the contract check runs once per model and is not repeated", async () => {
  let checks = 0;
  const registry = createProviderRegistry({
    probe: async (identity) => ({ outcome: "version", command: identity.command, version: "reachable" }),
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama" ? [{ id: "deepseek-r1:8b", availability: "loaded" }] : [],
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async () => {
      checks += 1;
      return CONTRACT_PASS;
    },
  });
  await service.discover();
  await service.verifySelection();
  await service.verifySelection();
  await service.verifySelection();
  assert.equal(checks, 1, "a model already judged is not judged again");
  assert.equal(service.readiness().selection.status, "ready");
});

test("a model whose answer the interpreter cannot parse is refused, not used", async () => {
  const registry = createProviderRegistry({
    probe: async (identity) => ({ outcome: "version", command: identity.command, version: "reachable" }),
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama" ? [{ id: "chatty:latest", availability: "loaded" }] : [],
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async () => "Sure! Here is what I think you should run: read src/index.ts",
  });
  await service.discover();
  await service.verifySelection();
  const selection = service.readiness().selection;
  assert.equal(selection.status, "noSuitableModel");
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined, "nothing is resolved from a model that failed");
});

test("no resolved configuration is shared while no backend is reachable", async () => {
  const registry = createProviderRegistry({
    probe: async (identity) => ({ outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") }),
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async () => "{}",
  });
  await service.discover();
  assert.equal(service.readiness().selection.status, "serverUnavailable");
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined);
  assert.match(localModelStatusText(service.readiness()), /No local inference server answered/u);
});

test("invalidation forgets readiness so the next discovery asks again", async () => {
  let passes = 0;
  const registry = createProviderRegistry({
    probe: async (identity) => {
      passes += 1;
      return { outcome: "version", command: identity.command, version: "reachable" };
    },
    probeModels: async () => [{ id: "m", availability: "loaded" }],
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async () => CONTRACT_PASS,
  });
  await service.discover();
  const afterFirst = passes;
  await service.discover();
  assert.equal(passes, afterFirst, "cached");
  service.invalidate();
  await service.discover();
  assert.equal(passes, afterFirst * 2, "both configured backends were asked again");
});

test("a named endpoint is the only one asked, and a named backend narrows it further", () => {
  assert.deepEqual(
    localBackendIdentities(settings({ endpoint: "http://127.0.0.1:9999" })).map((entry) => [entry.adapterType, entry.command]),
    [["local-ollama", "http://127.0.0.1:9999"], ["local-lmstudio", "http://127.0.0.1:9999"]],
  );
  assert.deepEqual(
    localBackendIdentities(settings({ backend: "ollama" })).map((entry) => entry.adapterType),
    ["local-ollama"],
  );
});

test("an unfinished backend record is not a backend that answered no", () => {
  assert.equal(probeFromRecord({ adapterType: "local-ollama", command: "x", workingDirectory: "", state: "discovering" }), undefined);
  assert.equal(probeFromRecord({ adapterType: "local-ollama", command: "x", workingDirectory: "", state: "unknown" }), undefined);
  assert.equal(probeFromRecord({ adapterType: "codex-app-server", command: "codex", workingDirectory: "", state: "available" }), undefined);
  const probe = probeFromRecord({
    adapterType: "local-ollama",
    command: "http://127.0.0.1:11434",
    workingDirectory: "",
    state: "available",
    models: [{ id: "m", availability: "installed", capabilities: ["completion"] }],
    detail: "Ollama",
  });
  assert.equal(probe.reachable, true);
  assert.equal(probe.models[0].availability, "installed");
  assert.deepEqual(probe.models[0].capabilities, ["completion"]);
});

test("the status text names the remedy for each distinct failure", () => {
  const base = { enabled: true, probes: [], discovering: false };
  assert.match(localModelStatusText({ ...base, enabled: false, selection: { status: "serverUnavailable", detail: "" } }), /Local interpretation is off/u);
  assert.match(localModelStatusText({ ...base, discovering: true, selection: { status: "serverUnavailable", detail: "" } }), /Looking for a local inference server/u);
  assert.match(localModelStatusText({ ...base, selection: { status: "noSuitableModel", detail: "nothing installed" } }), /No suitable model is available/u);
  assert.match(localModelStatusText({ ...base, selection: { status: "configuredModelUnavailable", model: "m", detail: "m is gone" } }), /model you selected is not available/u);
  assert.match(
    localModelStatusText({ ...base, selection: { status: "ready", backend: "ollama", endpoint: "http://127.0.0.1:11434", model: { id: "m", backend: "ollama", availability: "loaded" }, explicit: true } }),
    /m on http:\/\/127\.0\.0\.1:11434 \(your choice\)/u,
  );
});

test("the contract cache key separates backend, endpoint and model", () => {
  assert.notEqual(contractCheckKey("ollama", "http://a", "m"), contractCheckKey("lmstudio", "http://a", "m"));
  assert.notEqual(contractCheckKey("ollama", "http://a", "m"), contractCheckKey("ollama", "http://b", "m"));
  assert.equal(contractCheckKey("ollama", "http://a/", "m"), contractCheckKey("ollama", "http://a", "m"));
});

test("an explicit model earns the same verdict as an automatic one", () => {
  const probes = [ollamaProbe([{ id: "pinned-model" }])];
  // Pinned but never asked: honoured over ranking, but not claimed ready.
  const unchecked = selectLocalModel({ probes, explicitModel: "pinned-model" });
  assert.equal(unchecked.status, "unverified");
  assert.equal(unchecked.model.id, "pinned-model");

  const proven = selectLocalModel({
    probes,
    explicitModel: "pinned-model",
    contractVerdict: () => true,
  });
  assert.equal(proven.status, "ready");
  assert.equal(proven.explicit, true, "the reader's choice is still honoured over ranking");

  // A pinned model that failed the contract is not silently used, and not silently replaced.
  const failed = selectLocalModel({
    probes,
    explicitModel: "pinned-model",
    contractVerdict: () => false,
  });
  assert.equal(failed.status, "noSuitableModel");
  assert.match(failed.detail, /pinned-model is installed on .* but could not carry out/u);
});

test("startup alone reaches ready for both consumers, with no manual selection", async () => {
  // The whole sequence a reader never touches: discover, check the contract, resolve one
  // configuration, and hand the same one to interpretation and to selector healing.
  const probed = [];
  let checks = 0;
  const registry = createProviderRegistry({
    probe: async (identity) => {
      probed.push(identity.adapterType);
      return identity.adapterType === "local-ollama"
        ? { outcome: "version", command: identity.command, version: "reachable" }
        : { outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") };
    },
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama"
        ? [{ id: "qwen2.5-coder:7b", availability: "loaded" }]
        : undefined,
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async (target, prompt) => {
      checks += 1;
      // The check is asked of the model that was selected, at the endpoint it was found on.
      assert.equal(target.backend, "ollama");
      assert.equal(target.endpoint, "http://127.0.0.1:11434");
      assert.equal(target.model, "qwen2.5-coder:7b");
      assert.match(prompt, /probe-decoy/u);
      return CONTRACT_PASS;
    },
  });

  // This is exactly what activation does: discover, then verify. Nothing else.
  await service.discover();
  await service.verifySelection();

  assert.deepEqual(probed.sort(), ["local-lmstudio", "local-ollama"]);
  assert.equal(checks, 1, "one bounded check, unprompted");
  const readinessValue = service.readiness();
  assert.equal(readinessValue.selection.status, "ready");
  assert.equal(readinessValue.selection.explicit, false, "chosen automatically");
  // Both consumers read this one answer: the interpreter and the bridge cannot disagree.
  assert.deepEqual(service.resolvedConfig("semanticInterpreter"), {
    backend: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen2.5-coder:7b",
  });
  assert.match(localModelStatusText(readinessValue), /qwen2\.5-coder:7b on http:\/\/127\.0\.0\.1:11434/u);
});

test("a startup check that fails leaves nothing resolved for either consumer", async () => {
  // One reachable backend, so the failed verdict is the last word rather than sending selection
  // to an identical model id on a second endpoint nobody has checked.
  const registry = createProviderRegistry({
    probe: async (identity) =>
      identity.adapterType === "local-ollama"
        ? { outcome: "version", command: identity.command, version: "reachable" }
        : { outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") },
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama" ? [{ id: "only-model", availability: "loaded" }] : undefined,
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    // Answers, but not in the interpreter's shape.
    runPrompt: async () => "I think you should read the file.",
  });
  await service.discover();
  await service.verifySelection();
  assert.equal(service.readiness().selection.status, "noSuitableModel");
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined, "neither consumer is handed a model");
});

test("startup keeps checking past a failing model until one is proven", async () => {
  // The top-ranked model cannot do the job. Stopping there left startup permanently "unverified"
  // even though a perfectly capable model was sitting behind it.
  const asked = [];
  const registry = createProviderRegistry({
    probe: async (identity) =>
      identity.adapterType === "local-ollama"
        ? { outcome: "version", command: identity.command, version: "reachable" }
        : { outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") },
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama"
        ? [
            { id: "aaa-cannot", availability: "loaded" },
            { id: "bbb-can", availability: "loaded" },
          ]
        : undefined,
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async (target) => {
      asked.push(target.model);
      return target.model === "bbb-can"
        ? CONTRACT_PASS
        : "not json at all";
    },
  });
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked, ["aaa-cannot", "bbb-can"], "the search moved on after the first failure");
  const selection = service.readiness().selection;
  assert.equal(selection.status, "ready");
  assert.equal(selection.model.id, "bbb-can");
  assert.equal(service.resolvedConfig("semanticInterpreter").model, "bbb-can");
});

test("every model failing the check is reported, and each is asked only once", async () => {
  let asked = 0;
  const registry = createProviderRegistry({
    probe: async (identity) =>
      identity.adapterType === "local-ollama"
        ? { outcome: "version", command: identity.command, version: "reachable" }
        : { outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") },
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama"
        ? [{ id: "one", availability: "loaded" }, { id: "two", availability: "loaded" }]
        : undefined,
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async () => { asked += 1; return "nope"; },
  });
  await service.discover();
  await service.verifySelection();
  assert.equal(asked, 2, "each candidate judged once, none repeated");
  assert.equal(service.readiness().selection.status, "noSuitableModel");
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined);
  // A second pass asks nothing further: the verdicts are cached.
  await service.verifySelection();
  assert.equal(asked, 2);
});

test("a backend that stops answering is tried once per candidate, then left alone", async () => {
  // Bounded, not abandoned. Every candidate gets one attempt — a failure on one model is not proof
  // about the next — and the attempted set stops the loop rather than retrying forever.
  let asked = 0;
  const registry = createProviderRegistry({
    probe: async (identity) =>
      identity.adapterType === "local-ollama"
        ? { outcome: "version", command: identity.command, version: "reachable" }
        : { outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") },
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama"
        ? [{ id: "one", availability: "loaded" }, { id: "two", availability: "loaded" }]
        : undefined,
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async () => { asked += 1; throw new Error("ECONNRESET"); },
  });
  await service.discover();
  await service.verifySelection();
  assert.equal(asked, 2, "each candidate attempted once, and the loop terminated");
  // No verdicts were recorded, so nothing is condemned and nothing may execute.
  assert.equal(service.readiness().selection.status, "unverified");
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined);
});

test("one candidate's request failure does not end the search", async () => {
  // The first model's request blows up. That says nothing certain about the second, and treating
  // every exception as "the backend is gone" abandoned models that would have worked.
  const asked = [];
  const registry = createProviderRegistry({
    probe: async (identity) =>
      identity.adapterType === "local-ollama"
        ? { outcome: "version", command: identity.command, version: "reachable" }
        : { outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") },
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama"
        ? [{ id: "aaa-explodes", availability: "loaded" }, { id: "bbb-works", availability: "loaded" }]
        : undefined,
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async (target) => {
      asked.push(target.model);
      if (target.model === "aaa-explodes") {
        throw new Error("model failed to load into memory");
      }
      return CONTRACT_PASS;
    },
  });
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked, ["aaa-explodes", "bbb-works"], "the search moved past the failure");
  assert.equal(service.readiness().selection.status, "ready");
  assert.equal(service.resolvedConfig("semanticInterpreter").model, "bbb-works");
});

test("a request failure condemns nothing: the model is still unverified, not unusable", async () => {
  const registry = createProviderRegistry({
    probe: async (identity) =>
      identity.adapterType === "local-ollama"
        ? { outcome: "version", command: identity.command, version: "reachable" }
        : { outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") },
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama" ? [{ id: "only", availability: "loaded" }] : undefined,
  });
  let fail = true;
  const service = createLocalModelService({
    registry,
    settings: () => settings(),
    runPrompt: async () => {
      if (fail) throw new Error("transient");
      return CONTRACT_PASS;
    },
  });
  await service.discover();
  await service.verifySelection();
  // No verdict recorded, so nothing is resolved and nothing may execute — but the model is not
  // written off either, and a later pass can still prove it.
  assert.equal(service.readiness().selection.status, "unverified");
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined);
  fail = false;
  await service.verifySelection();
  assert.equal(service.readiness().selection.status, "ready");
});

test("a pinned model that failed the contract resolves nothing, so nothing may execute", async () => {
  const registry = createProviderRegistry({
    probe: async (identity) =>
      identity.adapterType === "local-ollama"
        ? { outcome: "version", command: identity.command, version: "reachable" }
        : { outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") },
    probeModels: async (identity) =>
      identity.adapterType === "local-ollama"
        ? [{ id: "pinned-bad", availability: "loaded" }, { id: "other-good", availability: "loaded" }]
        : undefined,
  });
  const service = createLocalModelService({
    registry,
    settings: () => settings({ model: "pinned-bad" }),
    runPrompt: async () => "not the interpreter's shape at all",
  });
  await service.discover();
  await service.verifySelection();
  // The reader's choice is not silently replaced by another model, and it is not silently used.
  assert.equal(service.readiness().selection.status, "noSuitableModel");
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined, "no configuration reaches either consumer");
});

test("the three ways a running server offers nothing usable are reported differently", () => {
  const endpoint = "http://127.0.0.1:11434";
  // Nothing installed at all.
  assert.match(selectLocalModel({ probes: [ollamaProbe([])] }).detail, /has no models installed/u);

  // Installed, but the only models cannot generate text. Observed live: a machine whose LM Studio
  // holds only embedding models was told its models "could not carry out the contract", when in
  // fact nothing had been asked to.
  const embeddingsOnly = selectLocalModel({
    probes: [ollamaProbe([
      { id: "text-embedding-bge-m3", capabilities: ["embedding"] },
      { id: "text-embedding-nomic", capabilities: ["embedding"] },
    ])],
  });
  assert.equal(embeddingsOnly.status, "noSuitableModel");
  assert.match(embeddingsOnly.detail, /are not text-generation models/u);
  assert.match(embeddingsOnly.detail, /text-embedding-bge-m3, text-embedding-nomic/u);
  assert.match(embeddingsOnly.detail, /install a chat or instruct model/u);
  assert.doesNotMatch(embeddingsOnly.detail, /could carry out the interpreter contract/u);

  // Generative models that were actually judged and failed.
  const judged = selectLocalModel({
    probes: [ollamaProbe([{ id: "tried-and-failed" }])],
    contractVerdict: () => false,
  });
  assert.match(judged.detail, /could carry out the interpreter contract/u);
  assert.equal(judged.detail.includes(endpoint), true);
});

/**
 * The lifecycle of an optional feature. Both consumers off means no reader asked for a local model,
 * and the host must behave as though the machine had none: no knock on a loopback port, no model
 * loaded, nothing handed to the interpreter or the bridge. Deterministic browser extraction is what
 * runs instead, and it needs none of this.
 */
const disabled = () => settings({ enabled: false });

/** One backend holds the models so a candidate is one (backend, endpoint, model), not two. */
const recordingRegistry = (models, holder = "local-ollama") => {
  const asked = [];
  return {
    asked,
    registry: createProviderRegistry({
      probe: async (identity) => {
        asked.push(identity.adapterType);
        return { outcome: "version", command: identity.command, version: "reachable" };
      },
      probeModels: async (identity) => (identity.adapterType === holder ? models : []),
    }),
  };
};

test("with both local consumers disabled, activation asks no backend anything", async () => {
  assert.deepEqual(localBackendIdentities(disabled()), []);
  const { asked, registry } = recordingRegistry([{ id: "qwen2.5-coder:7b", availability: "loaded" }]);
  const prompts = [];
  const service = createLocalModelService({
    registry,
    settings: disabled,
    runPrompt: async (target, prompt) => {
      prompts.push({ target, prompt });
      return CONTRACT_PASS;
    },
  });
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked, [], "no discovery request was made");
  assert.deepEqual(prompts, [], "no inference request was made");
  assert.equal(service.readiness().enabled, false);
  assert.equal(service.readiness().discovering, false);
  assert.deepEqual(service.readiness().probes, []);
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined, "nothing is handed to either consumer");
  assert.equal(
    localModelStatusText(service.readiness()),
    "Local interpretation is off. Deterministic extraction runs on its own.",
  );
});

test("a reachable server holding a usable model is still not touched while both consumers are off", async () => {
  // The defect this covers was only visible on a machine that happened to be running LM Studio or
  // Ollama: discovery answered, ranking proposed a model, and the readiness check then loaded it.
  const { asked, registry } = recordingRegistry([
    { id: "k2-horizon-3.7b", availability: "installed", capabilities: ["llm"] },
  ]);
  let enabled = false;
  const prompts = [];
  const service = createLocalModelService({
    registry,
    settings: () => settings({ enabled }),
    runPrompt: async (target, prompt) => {
      prompts.push({ target, prompt });
      return CONTRACT_PASS;
    },
  });
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked, []);
  assert.deepEqual(prompts, []);

  // Turning either consumer on is what starts the work, and it completes on its own from there.
  enabled = true;
  service.invalidate();
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked.sort(), ["local-lmstudio", "local-ollama"]);
  assert.equal(prompts.length, 1, "the bounded contract check ran exactly once");
  assert.equal(prompts[0].prompt, CONTRACT_PROBE_PROMPT);
  assert.deepEqual(service.resolvedConfig("semanticInterpreter"), {
    backend: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "k2-horizon-3.7b",
  });
  assert.equal(service.readiness().selection.status, "ready");

  // And the verdict is cached: neither a second pass nor a reopened view re-runs it.
  await service.discover();
  await service.verifySelection();
  assert.equal(prompts.length, 1, "a judged model is not judged again");
});

test("turning both consumers off drops what was discovered while they were on", async () => {
  const { asked, registry } = recordingRegistry([{ id: "qwen2.5-coder:7b", availability: "loaded" }]);
  let enabled = true;
  const service = createLocalModelService({
    registry,
    settings: () => settings({ enabled }),
    runPrompt: async () => CONTRACT_PASS,
  });
  await service.discover();
  await service.verifySelection();
  assert.equal(service.readiness().selection.status, "ready");

  enabled = false;
  service.invalidate();
  const askedBefore = asked.length;
  await service.discover();
  await service.verifySelection();
  assert.equal(asked.length, askedBefore, "disabling asks nothing further");
  assert.deepEqual(service.readiness().probes, [], "the stale answers are gone");
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined);
  assert.deepEqual(
    registry.records().filter((record) => localBackendForAdapterType(record.adapterType)),
    [],
    "no local backend record survives",
  );
});

test("one enabled consumer is enough, and the backend the reader named is the only one asked", async () => {
  // The host folds browserSelectorHealingEnabled and browserSemanticInterpreterEnabled into this
  // one flag, so either alone must produce the whole lifecycle.
  assert.deepEqual(
    localBackendIdentities(settings({ enabled: true, backend: "lmstudio" })).map((entry) => entry.adapterType),
    ["local-lmstudio"],
  );
  const { asked, registry } = recordingRegistry(
    [{ id: "k2-horizon-3.7b", availability: "loaded" }],
    "local-lmstudio",
  );
  const service = createLocalModelService({
    registry,
    settings: () => settings({ enabled: true, backend: "lmstudio", endpoint: "http://127.0.0.1:1234" }),
    runPrompt: async () => CONTRACT_PASS,
  });
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked, ["local-lmstudio"]);
  assert.deepEqual(service.resolvedConfig("semanticInterpreter"), {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "k2-horizon-3.7b",
  });
});

// Who owns which local model.
//
// Selector healing and semantic interpretation are configured separately. A shared reading that
// took the backend and endpoint from one and the model name from the other produced a tuple nobody
// configured, verified it once, and handed it to both — so a model proven on one server could be
// sent to another that had never been asked about it.

const oneConsumer = (only, values) => ({
  consumers: {
    semanticInterpreter: consumer({ enabled: false }),
    selectorHealing: consumer({ enabled: false }),
    [only]: consumer(values),
  },
});

const endpointRegistry = (modelsByEndpoint) => {
  const asked = [];
  const prompts = [];
  return {
    asked,
    prompts,
    registry: createProviderRegistry({
      probe: async (identity) => {
        asked.push(identity.command);
        return modelsByEndpoint[identity.command]
          ? { outcome: "version", command: identity.command, version: "reachable" }
          : { outcome: "failed", command: identity.command, error: new Error("ECONNREFUSED") };
      },
      probeModels: async (identity) =>
        (modelsByEndpoint[identity.command] ?? []).map((id) => ({ id, availability: "loaded" })),
    }),
  };
};

const passingService = (registry, settingsValue, prompts) =>
  createLocalModelService({
    registry,
    settings: () => settingsValue,
    runPrompt: async (target) => {
      prompts.push(target);
      return CONTRACT_PASS;
    },
  });

test("a semantic-only host asks only its own endpoint, whatever selector healing is configured for", async () => {
  const { asked, registry } = endpointRegistry({
    "http://127.0.0.1:11434": ["semantic-model"],
    "http://127.0.0.1:4444": ["healing-model"],
  });
  const prompts = [];
  const configuration = {
    consumers: {
      semanticInterpreter: consumer({ backend: "ollama" }),
      // Off, and pointing somewhere else entirely. None of it may reach the interpreter.
      selectorHealing: consumer({
        enabled: false,
        backend: "lmstudio",
        endpoint: "http://127.0.0.1:4444",
        model: "healing-model",
      }),
    },
  };
  const service = passingService(registry, configuration, prompts);
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked, ["http://127.0.0.1:11434"], "a disabled consumer's endpoint was asked");
  assert.deepEqual(
    service.resolvedConfig("semanticInterpreter"),
    { backend: "ollama", endpoint: "http://127.0.0.1:11434", model: "semantic-model" },
  );
  assert.equal(
    service.resolvedConfig("selectorHealing"),
    undefined,
    "a disabled consumer was handed a configuration to run on",
  );
  assert.deepEqual(
    prompts.map((target) => [target.endpoint, target.model]),
    [["http://127.0.0.1:11434", "semantic-model"]],
  );
});

test("a healing-only host resolves its own model and leaves the interpreter with nothing", async () => {
  const { asked, registry } = endpointRegistry({ "http://127.0.0.1:1234": ["healing-model"] });
  const prompts = [];
  const configuration = oneConsumer("selectorHealing", {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
  });
  const service = passingService(registry, configuration, prompts);
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked, ["http://127.0.0.1:1234"]);
  assert.deepEqual(
    service.resolvedConfig("selectorHealing"),
    { backend: "lmstudio", endpoint: "http://127.0.0.1:1234", model: "healing-model" },
  );
  assert.equal(service.resolvedConfig("semanticInterpreter"), undefined);
});

test("two consumers on the same tuple share one probe and one verdict", async () => {
  const { asked, registry } = endpointRegistry({ "http://127.0.0.1:11434": ["shared-model"] });
  const prompts = [];
  const shared = { backend: "ollama", endpoint: "http://127.0.0.1:11434" };
  const service = passingService(
    registry,
    { consumers: { semanticInterpreter: consumer(shared), selectorHealing: consumer(shared) } },
    prompts,
  );
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked, ["http://127.0.0.1:11434"], "the same server was discovered twice");
  assert.equal(prompts.length, 1, "the same tuple was checked twice");
  assert.deepEqual(
    service.resolvedConfig("semanticInterpreter"),
    service.resolvedConfig("selectorHealing"),
  );
});

test("two consumers on different tuples are discovered and verified independently", async () => {
  const { asked, registry } = endpointRegistry({
    "http://127.0.0.1:11434": ["ollama-model"],
    "http://127.0.0.1:1234": ["lmstudio-model"],
  });
  const prompts = [];
  const service = passingService(
    registry,
    {
      consumers: {
        semanticInterpreter: consumer({ backend: "ollama", endpoint: "http://127.0.0.1:11434" }),
        selectorHealing: consumer({ backend: "lmstudio", endpoint: "http://127.0.0.1:1234" }),
      },
    },
    prompts,
  );
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked.sort(), ["http://127.0.0.1:11434", "http://127.0.0.1:1234"]);
  assert.deepEqual(
    prompts.map((target) => [target.endpoint, target.model]).sort(),
    [
      ["http://127.0.0.1:11434", "ollama-model"],
      ["http://127.0.0.1:1234", "lmstudio-model"],
    ],
  );
  assert.deepEqual(
    service.resolvedConfig("semanticInterpreter"),
    { backend: "ollama", endpoint: "http://127.0.0.1:11434", model: "ollama-model" },
  );
  assert.deepEqual(
    service.resolvedConfig("selectorHealing"),
    { backend: "lmstudio", endpoint: "http://127.0.0.1:1234", model: "lmstudio-model" },
  );
});

test("a model proven on one endpoint is not proven on another that happens to serve its name", async () => {
  const { registry } = endpointRegistry({
    "http://127.0.0.1:11434": ["same-name"],
    "http://127.0.0.1:1234": ["same-name"],
  });
  const prompts = [];
  const service = createLocalModelService({
    registry,
    settings: () => ({
      consumers: {
        semanticInterpreter: consumer({
          backend: "ollama",
          endpoint: "http://127.0.0.1:11434",
          model: "same-name",
        }),
        selectorHealing: consumer({
          backend: "lmstudio",
          endpoint: "http://127.0.0.1:1234",
          model: "same-name",
        }),
      },
    }),
    runPrompt: async (target) => {
      prompts.push(target);
      // Only the Ollama server can carry out the contract. The LM Studio one serves a model with
      // the same name and cannot.
      return target.backend === "ollama"
        ? CONTRACT_PASS
        : CONTRACT_FAIL;
    },
  });
  await service.discover();
  await service.verifySelection();
  assert.equal(prompts.length, 2, "the name alone was taken as proof for the second endpoint");
  assert.deepEqual(
    service.resolvedConfig("semanticInterpreter"),
    { backend: "ollama", endpoint: "http://127.0.0.1:11434", model: "same-name" },
  );
  assert.equal(
    service.resolvedConfig("selectorHealing"),
    undefined,
    "a model that failed its own endpoint's check was still handed out",
  );
});

// Invalidation while a check is in flight.
//
// Settings change mid-check. The answer that was already on its way is about the previous
// configuration, and publishing it would mark the new one ready — or the old one — on evidence that
// belongs to neither.

const deferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const racingService = (modelsByEndpoint, settingsRef, gate) => {
  const { registry } = endpointRegistry(modelsByEndpoint);
  const prompts = [];
  const service = createLocalModelService({
    registry,
    settings: () => settingsRef.value,
    runPrompt: async (target) => {
      prompts.push(target);
      await gate.promise;
      return CONTRACT_PASS;
    },
  });
  return { service, prompts };
};

test("a check that completes after the feature was disabled publishes nothing", async () => {
  const gate = deferred();
  const settingsRef = {
    value: oneConsumer("semanticInterpreter", { backend: "ollama", model: "semantic-model" }),
  };
  const { service, prompts } = racingService(
    { "http://127.0.0.1:11434": ["semantic-model"] },
    settingsRef,
    gate,
  );
  await service.discover();
  const running = service.verifySelection();
  assert.equal(prompts.length, 1, "the check did not start");
  settingsRef.value = settings({ enabled: false });
  service.invalidate();
  gate.resolve();
  await running;
  assert.equal(service.readiness().enabled, false);
  assert.equal(
    service.resolvedConfig("semanticInterpreter"),
    undefined,
    "a verdict from the previous configuration made a disabled feature ready",
  );
});

test("a check that completes after the endpoint changed does not vouch for the new one", async () => {
  const gate = deferred();
  const settingsRef = {
    value: oneConsumer("semanticInterpreter", {
      backend: "ollama",
      endpoint: "http://127.0.0.1:11434",
    }),
  };
  const { service, prompts } = racingService(
    { "http://127.0.0.1:11434": ["shared-name"], "http://127.0.0.1:9999": ["shared-name"] },
    settingsRef,
    gate,
  );
  await service.discover();
  const running = service.verifySelection();
  assert.deepEqual(prompts.map((target) => target.endpoint), ["http://127.0.0.1:11434"]);

  settingsRef.value = oneConsumer("semanticInterpreter", {
    backend: "ollama",
    endpoint: "http://127.0.0.1:9999",
  });
  service.invalidate();
  gate.resolve();
  await running;
  assert.equal(
    service.resolvedConfig("semanticInterpreter"),
    undefined,
    "the stale answer marked the new endpoint's model verified",
  );

  // And the new configuration is checked without waiting on, or reusing, the obsolete pass.
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(
    prompts.map((target) => target.endpoint),
    ["http://127.0.0.1:11434", "http://127.0.0.1:9999"],
    "the new tuple was never checked",
  );
  assert.deepEqual(
    service.resolvedConfig("semanticInterpreter"),
    { backend: "ollama", endpoint: "http://127.0.0.1:9999", model: "shared-name" },
  );
});

test("verification after an invalidation does not await the superseded pass", async () => {
  const gate = deferred();
  const settingsRef = {
    value: oneConsumer("semanticInterpreter", { backend: "ollama" }),
  };
  const { service } = racingService({ "http://127.0.0.1:11434": ["semantic-model"] }, settingsRef, gate);
  await service.discover();
  const stalled = service.verifySelection();
  service.invalidate();
  // The superseded request is still hanging. A second verification that awaited it could not
  // return, so reaching this assertion at all is the behaviour under test.
  const second = service.verifySelection();
  await Promise.race([
    second,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error("verification waited on the obsolete pass")), 1_000)),
  ]);
  gate.resolve();
  await stalled;
});

// Which model actually answered.
//
// An OpenAI-compatible server asked for one model may answer with whichever model it has loaded.
// A verdict recorded against the requested name would then vouch for a model nobody checked, so the
// gate reads the identity the answer carries when there is one.

test("a server that answers under a different model name verifies nothing", async () => {
  const { registry } = endpointRegistry({ "http://127.0.0.1:1234": ["pinned-model"] });
  const service = createLocalModelService({
    registry,
    settings: () => oneConsumer("semanticInterpreter", {
      backend: "lmstudio",
      endpoint: "http://127.0.0.1:1234",
      model: "pinned-model",
    }),
    // A perfect contract answer — from the wrong model.
    runPrompt: async () => ({ text: CONTRACT_PASS, model: "whatever-was-loaded" }),
  });
  await service.discover();
  await service.verifySelection();
  assert.equal(
    service.resolvedConfig("semanticInterpreter"),
    undefined,
    "a model the server never ran was recorded as verified",
  );
  assert.match(service.readiness().selection.detail, /could not carry out the interpreter contract/u);
});

test("a matching identity verifies, and a transport that reports none still can", async () => {
  const echoing = endpointRegistry({ "http://127.0.0.1:1234": ["pinned-model"] });
  const withIdentity = createLocalModelService({
    registry: echoing.registry,
    settings: () => oneConsumer("semanticInterpreter", {
      backend: "lmstudio",
      endpoint: "http://127.0.0.1:1234",
      model: "pinned-model",
    }),
    runPrompt: async (target) => ({ text: CONTRACT_PASS, model: target.model }),
  });
  await withIdentity.discover();
  await withIdentity.verifySelection();
  assert.deepEqual(withIdentity.resolvedConfig("semanticInterpreter"), {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "pinned-model",
  });

  const silent = endpointRegistry({ "http://127.0.0.1:1234": ["pinned-model"] });
  const withoutIdentity = createLocalModelService({
    registry: silent.registry,
    settings: () => oneConsumer("semanticInterpreter", {
      backend: "lmstudio",
      endpoint: "http://127.0.0.1:1234",
      model: "pinned-model",
    }),
    runPrompt: async () => CONTRACT_PASS,
  });
  await withoutIdentity.discover();
  await withoutIdentity.verifySelection();
  assert.deepEqual(withoutIdentity.resolvedConfig("semanticInterpreter"), {
    backend: "lmstudio",
    endpoint: "http://127.0.0.1:1234",
    model: "pinned-model",
  });
});
