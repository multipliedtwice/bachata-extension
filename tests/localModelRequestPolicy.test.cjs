const assert = require("node:assert/strict");
const test = require("node:test");

const { createLocalBackendFetch } = require("../dist/providers/localBackendFetch.js");
const {
  contractCheckKey,
  createLocalModelService,
  localBackendIdentities,
  localBackendRequests,
  localRequestScope,
} = require("../dist/providers/localModelService.js");
const { createProviderRegistry, providerKey } = require("../dist/providers/providerRegistry.js");

const CONTRACT_PASS = JSON.stringify({
  execute: ["probe-read", "probe-list"],
  reject: ["probe-decoy", "probe-source"],
  ambiguous: ["probe-unclear"],
});

const SECRET = "sk-remote-0987654321";

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

const configuration = (semantic, healing) => ({
  consumers: {
    semanticInterpreter: consumer(semantic),
    selectorHealing: consumer(healing),
  },
});

// A stub for the one HTTP call discovery makes. Nothing here reaches a real endpoint.
const stubFetch = () => {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      redirected: false,
      json: async () => ({ models: [{ name: "stub-model" }] }),
    };
  };
  return { calls, impl };
};

test("a remote endpoint is contacted only where the consumer opted in", async () => {
  const loopbackOnly = stubFetch();
  await assert.rejects(
    createLocalBackendFetch({ timeoutMs: 1_000, allowRemote: false }, loopbackOnly.impl)(
      "https://models.example.com/api/tags",
    ),
    /loopback/u,
  );
  assert.deepEqual(loopbackOnly.calls, [], "a refused endpoint was still contacted");

  const optedIn = stubFetch();
  await createLocalBackendFetch({ timeoutMs: 1_000, allowRemote: true }, optedIn.impl)(
    "https://models.example.com/api/tags",
  );
  assert.equal(optedIn.calls.length, 1);

  // The opt-in is about reach, not about protocol. A non-HTTP scheme is refused either way.
  for (const allowRemote of [false, true]) {
    const scheme = stubFetch();
    await assert.rejects(
      createLocalBackendFetch({ timeoutMs: 1_000, allowRemote }, scheme.impl)("file:///etc/passwd"),
      /HTTP\(S\)/u,
    );
    assert.deepEqual(scheme.calls, []);
  }
});

test("discovery carries the configured authorization header, and nothing carries it by default", async () => {
  const authenticated = stubFetch();
  await createLocalBackendFetch(
    { timeoutMs: 1_000, allowRemote: true, apiKey: SECRET },
    authenticated.impl,
  )("https://models.example.com/api/tags", { headers: { accept: "application/json" } });
  assert.deepEqual(authenticated.calls[0].init.headers, {
    accept: "application/json",
    authorization: `Bearer ${SECRET}`,
  });

  const anonymous = stubFetch();
  await createLocalBackendFetch({ timeoutMs: 1_000, allowRemote: false }, anonymous.impl)(
    "http://127.0.0.1:11434/api/tags",
  );
  assert.equal("authorization" in (anonymous.calls[0].init.headers ?? {}), false);
});

test("each consumer's own deadline bounds its own request", async () => {
  const deadlines = [];
  const never = async (_url, init) => {
    deadlines.push(init.signal);
    return await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
  await assert.rejects(
    createLocalBackendFetch({ timeoutMs: 20, allowRemote: false }, never)("http://127.0.0.1:11434/api/tags"),
    /aborted/u,
  );
  assert.equal(deadlines[0].aborted, true);
});

test("a redirect off the endpoint is refused rather than followed", async () => {
  const redirected = async () => ({ ok: true, status: 200, redirected: true, json: async () => ({}) });
  await assert.rejects(
    createLocalBackendFetch({ timeoutMs: 1_000, allowRemote: true }, redirected)(
      "https://models.example.com/api/tags",
    ),
    /off-host redirect/u,
  );
});

test("an identical request configuration is one question; a different one is not", () => {
  const shared = { backend: "ollama", endpoint: "http://127.0.0.1:11434" };
  assert.equal(localBackendIdentities(configuration(shared, shared)).length, 1);

  const differentTimeout = localBackendIdentities(
    configuration({ ...shared, timeoutMs: 5_000 }, shared),
  );
  assert.equal(differentTimeout.length, 2, "a different deadline borrowed the other's record");

  const differentReach = localBackendIdentities(
    configuration({ ...shared, allowRemote: true }, shared),
  );
  assert.equal(differentReach.length, 2, "a different reach borrowed the other's record");

  const differentAuthentication = localBackendIdentities(
    configuration({ ...shared, apiKeyEnvironment: "MODEL_KEY", apiKey: SECRET }, shared),
  );
  assert.equal(differentAuthentication.length, 2, "a credential borrowed the anonymous record");

  const differentEndpoint = localBackendIdentities(
    configuration({ ...shared, endpoint: "http://127.0.0.1:1234" }, shared),
  );
  assert.equal(differentEndpoint.length, 2);
});

test("no secret appears in an identity, a scope, or a verdict key", () => {
  const scope = localRequestScope({
    timeoutMs: 30_000,
    allowRemote: true,
    apiKeyEnvironment: "MODEL_KEY",
    apiKey: SECRET,
  });
  assert.equal(scope.includes(SECRET), false);
  assert.match(scope, /authenticated/u);
  assert.notEqual(
    scope,
    localRequestScope({ timeoutMs: 30_000, allowRemote: true, apiKeyEnvironment: "MODEL_KEY" }),
    "an absent credential and a present one are the same question",
  );

  const requests = localBackendRequests(
    configuration(
      { backend: "ollama", allowRemote: true, apiKeyEnvironment: "MODEL_KEY", apiKey: SECRET },
      { enabled: false },
    ),
  );
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(requests[0].identity).includes(SECRET), false);
  assert.equal(requests[0].policy.apiKey, SECRET, "the request itself still carries the credential");
  assert.equal(
    contractCheckKey("ollama", "http://127.0.0.1:11434", "m", requests[0].identity.requestScope)
      .includes(SECRET),
    false,
  );
});

const registryOver = (fetchImpl) => {
  const asked = [];
  return {
    asked,
    registry: createProviderRegistry({
      probe: async (identity) => {
        asked.push(identity.command);
        try {
          await fetchImpl(`${identity.command}/api/tags`);
          return { outcome: "version", command: identity.command, version: "reachable" };
        } catch (error) {
          return { outcome: "failed", command: identity.command, error };
        }
      },
      probeModels: async () => [{ id: "stub-model", availability: "loaded" }],
    }),
  };
};

test("both consumers off make no request at all", async () => {
  const stub = stubFetch();
  const settings = configuration({ enabled: false }, { enabled: false });
  const { asked, registry } = registryOver(createLocalBackendFetch({ timeoutMs: 1_000, allowRemote: false }, stub.impl));
  const prompts = [];
  const service = createLocalModelService({
    registry,
    settings: () => settings,
    runPrompt: async (target) => {
      prompts.push(target);
      return CONTRACT_PASS;
    },
  });
  await service.discover();
  await service.verifySelection();
  assert.deepEqual(asked, []);
  assert.deepEqual(prompts, []);
  assert.deepEqual(stub.calls, []);
});

test("the semantic consumer's remote endpoint, credential and deadline reach its own check only", async () => {
  const settings = configuration(
    {
      backend: "ollama",
      endpoint: "https://models.example.com",
      allowRemote: true,
      apiKeyEnvironment: "MODEL_KEY",
      apiKey: SECRET,
      timeoutMs: 12_000,
    },
    { backend: "ollama", endpoint: "http://127.0.0.1:11434", timeoutMs: 4_000 },
  );
  const policies = new Map(
    localBackendRequests(settings).map((request) => [providerKey(request.identity), request.policy]),
  );
  const stub = stubFetch();
  const asked = [];
  const registry = createProviderRegistry({
    probe: async (identity) => {
      asked.push(identity.command);
      const policy = policies.get(providerKey(identity));
      try {
        await createLocalBackendFetch(policy, stub.impl)(`${identity.command}/api/tags`);
        return { outcome: "version", command: identity.command, version: "reachable" };
      } catch (error) {
        return { outcome: "failed", command: identity.command, error };
      }
    },
    probeModels: async () => [{ id: "stub-model", availability: "loaded" }],
  });
  const prompts = [];
  const service = createLocalModelService({
    registry,
    settings: () => settings,
    runPrompt: async (target) => {
      prompts.push(target);
      return CONTRACT_PASS;
    },
  });
  await service.discover();
  await service.verifySelection();

  assert.deepEqual(asked.sort(), ["http://127.0.0.1:11434", "https://models.example.com"]);
  // The remote endpoint was reached, and reached with the credential.
  const remote = stub.calls.find((call) => call.url.startsWith("https://models.example.com"));
  assert.equal(remote.init.headers.authorization, `Bearer ${SECRET}`);
  // The loopback one was not given either.
  const loopback = stub.calls.find((call) => call.url.startsWith("http://127.0.0.1:11434"));
  assert.equal("authorization" in (loopback.init.headers ?? {}), false);

  const semantic = prompts.find((target) => target.endpoint === "https://models.example.com");
  assert.deepEqual(
    { timeoutMs: semantic.timeoutMs, allowRemote: semantic.allowRemote, apiKey: semantic.apiKey },
    { timeoutMs: 12_000, allowRemote: true, apiKey: SECRET },
  );
  const healing = prompts.find((target) => target.endpoint === "http://127.0.0.1:11434");
  assert.deepEqual(
    { timeoutMs: healing.timeoutMs, allowRemote: healing.allowRemote, apiKey: healing.apiKey },
    { timeoutMs: 4_000, allowRemote: false, apiKey: undefined },
    "the healer borrowed the interpreter's reach, deadline or credential",
  );
  assert.deepEqual(
    service.resolvedConfig("selectorHealing"),
    { backend: "ollama", endpoint: "http://127.0.0.1:11434", model: "stub-model" },
  );
  assert.equal(
    JSON.stringify(service.resolvedConfig("selectorHealing")).includes("models.example.com"),
    false,
    "a remote endpoint reached the Browser Bridge's configuration",
  );
});

test("a verdict earned under one request configuration does not vouch for another", async () => {
  let allowRemote = false;
  const settings = () =>
    configuration(
      { backend: "ollama", endpoint: "http://127.0.0.1:11434", allowRemote },
      { enabled: false },
    );
  const { registry } = registryOver(async () => undefined);
  const prompts = [];
  const service = createLocalModelService({
    registry,
    settings,
    runPrompt: async (target) => {
      prompts.push(target);
      return CONTRACT_PASS;
    },
  });
  await service.discover();
  await service.verifySelection();
  assert.equal(prompts.length, 1);
  assert.equal(service.readiness("semanticInterpreter").selection.status, "ready");

  // The reader opts the interpreter out onto the network. That is a different question, and the
  // answer to the previous one is not reused for it.
  allowRemote = true;
  service.invalidate();
  await service.discover();
  await service.verifySelection();
  assert.equal(prompts.length, 2, "the previous configuration's verdict was reused");
  assert.equal(prompts[1].allowRemote, true);
});
