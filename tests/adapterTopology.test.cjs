const assert = require("node:assert/strict");
const test = require("node:test");

const {
  agentStateForDefinition,
  bindBrowserAgents,
  buildAdapterTopology,
  disposeTopology,
  effectiveAgentDefinition,
  freshAgentsFrom,
  persistedAgentsFrom,
  providerEnvironmentRequest,
  releaseBrowserBindings,
  resetAgentsFrom,
} = require("../dist/runtime/adapterTopology.js");

// EX-3. Building, binding, disposing and projecting one pipeline's adapters. Each of these was a
// closure inside `createRuntime`, so a half-built topology, a browser binding that no longer
// resolves, or a dispose that throws could only be reached by standing up the whole runtime
// against a bridge and an extension context.

const definition = (id, adapter, extra = {}) => ({ id, name: id, adapter, ...extra });

const adapter = (onDispose = async () => {}) => ({ dispose: onDispose });

const bindingHost = (overrides = {}) => ({
  ownerIdFor: (agentId) => `owner:${agentId}`,
  bindConversation: () => {},
  bindSession: (_ownerId, sessionId) => ({ conversationId: `bound:${sessionId}` }),
  releaseBinding: () => {},
  resolveBoundSession: () => ({ id: "live", status: "ready" }),
  ...overrides,
});

test("only adapters with a configured command take one, and the pipeline's own is the fallback", () => {
  const read = (settingKey, fallback) =>
    settingKey === "codexCommand" ? "/opt/codex" : fallback;
  assert.equal(
    effectiveAgentDefinition(definition("a", "codex-app-server"), read).command,
    "/opt/codex",
  );
  assert.equal(
    effectiveAgentDefinition(definition("a", "claude-code", { command: "/usr/bin/claude" }), read)
      .command,
    "/usr/bin/claude",
  );
  assert.equal(effectiveAgentDefinition(definition("a", "zai-glm"), read).command, "claude");
  const browser = definition("a", "chatgpt-browser");
  assert.equal(effectiveAgentDefinition(browser, read), browser);
});

test("only ZAI carries an environment profile, so one provider's key cannot reach another", () => {
  // WHY. The profile names the variable a credential is read from and the variable it is handed
  // over as. Giving every provider one would put an Anthropic auth token into a Codex process.
  const zai = { variables: ["ZAI_X"], credentialSourceVariable: "ZAI_API_KEY", baseUrl: "https://z" };
  const forZai = providerEnvironmentRequest({
    adapterType: "zai-glm",
    workingDirectory: "/w",
    sharedVariables: ["SHARED"],
    zai,
  });
  assert.deepEqual(forZai.profile, {
    adapterType: "zai-glm",
    variables: ["ZAI_X"],
    credential: { sourceVariable: "ZAI_API_KEY", targetVariable: "ANTHROPIC_AUTH_TOKEN" },
    values: { ANTHROPIC_BASE_URL: "https://z" },
  });
  const forCodex = providerEnvironmentRequest({
    adapterType: "codex-app-server",
    workingDirectory: "/w",
    sharedVariables: ["SHARED"],
    zai,
  });
  assert.equal(forCodex.profile, undefined);
  assert.deepEqual(forCodex.sharedVariables, ["SHARED"]);
});

test("agent status follows what was actually persisted about it", () => {
  assert.equal(agentStateForDefinition(definition("a", "claude-code")).status, "unknown");
  assert.equal(
    agentStateForDefinition(definition("a", "claude-code"), { version: "1" }).status,
    "available",
  );
  assert.equal(
    agentStateForDefinition(definition("a", "claude-code"), { sessionId: "s" }).status,
    "idle",
  );
  assert.equal(
    agentStateForDefinition(definition("a", "chatgpt-browser"), {
      browserBinding: { conversationId: "c" },
    }).status,
    "idle",
  );
  assert.equal(agentStateForDefinition(definition("a", "claude-code")).output, "");
});

test("a provider that fails to start leaves the previous topology installed", async () => {
  // WHY A CANDIDATE. Building into the live topology meant a failure halfway left the runtime
  // holding a mixture of old and new adapters that nothing could name.
  const disposed = [];
  let rebound = false;
  await assert.rejects(
    buildAdapterTopology(
      [definition("first", "claude-code"), definition("second", "codex-app-server")],
      {},
      {
        effectiveDefinition: (value) => value,
        createAdapter: (value) => {
          if (value.id === "second") throw new Error("codex will not start");
          return adapter(async () => {
            disposed.push(value.id);
          });
        },
        onCandidateFailure: async (candidate) => {
          rebound = true;
          return await disposeTopology(candidate);
        },
      },
    ),
    /codex will not start/,
  );
  assert.deepEqual(disposed, ["first"]);
  assert.equal(rebound, true);
});

test("a candidate cleanup that also fails reports both causes, never just the cleanup", async () => {
  // WHY AGGREGATE. Losing the reason the build failed to the reason the cleanup failed leaves the
  // user with the second-order fault and no way back to the first.
  await assert.rejects(
    buildAdapterTopology([definition("only", "claude-code")], {}, {
      effectiveDefinition: (value) => value,
      createAdapter: () => {
        throw new Error("original cause");
      },
      onCandidateFailure: async () => ["cleanup also failed"],
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /candidate cleanup was incomplete/);
      assert.equal(error.errors[0].message, "original cause");
      assert.equal(error.errors[1], "cleanup also failed");
      return true;
    },
  );
});

test("a built topology carries its definitions, adapters and persisted agent state together", async () => {
  const topology = await buildAdapterTopology(
    [definition("browser", "chatgpt-browser"), definition("local", "claude-code")],
    { local: { version: "2" } },
    {
      effectiveDefinition: (value) => ({ ...value, command: "resolved" }),
      createAdapter: () => adapter(),
      onCandidateFailure: async () => [],
    },
  );
  assert.deepEqual(Object.keys(topology.adapters).sort(), ["browser", "local"]);
  assert.equal(topology.definitions.local.command, "resolved");
  assert.equal(topology.agents.local.status, "available");
  assert.equal(topology.agents.browser.status, "unknown");
});

test("one adapter refusing to dispose does not stop the others being asked", async () => {
  const disposed = [];
  const failures = await disposeTopology({
    definitions: {},
    agents: {},
    adapters: {
      good: adapter(async () => {
        disposed.push("good");
      }),
      bad: adapter(async () => {
        throw new Error("stuck");
      }),
      alsoGood: adapter(async () => {
        disposed.push("alsoGood");
      }),
    },
  });
  assert.deepEqual(disposed.sort(), ["alsoGood", "good"]);
  assert.equal(failures.length, 1);
  assert.match(String(failures[0]), /stuck/);
});

test("only browser agents are bound, and a session id alone mints a binding", () => {
  const bound = [];
  const topology = {
    adapters: {},
    definitions: {
      browser: definition("browser", "chatgpt-browser"),
      local: definition("local", "claude-code"),
    },
    agents: {
      browser: { id: "browser", adapterType: "chatgpt-browser", sessionId: "s1", output: "" },
      local: { id: "local", adapterType: "claude-code", sessionId: "s2", output: "" },
    },
  };
  bindBrowserAgents(
    topology,
    bindingHost({ bindSession: (ownerId, sessionId) => bound.push([ownerId, sessionId]) || { conversationId: sessionId } }),
  );
  assert.deepEqual(bound, [["owner:browser", "s1"]]);
  assert.equal(topology.agents.local.browserBinding, undefined);
});

test("a binding whose conversation is gone stays visible and explained, never silently ready", () => {
  const topology = {
    adapters: {},
    definitions: { browser: definition("browser", "claude-browser") },
    agents: {
      browser: {
        id: "browser",
        adapterType: "claude-browser",
        browserBinding: { conversationId: "c" },
        sessionId: "old",
        output: "",
      },
    },
  };
  bindBrowserAgents(topology, bindingHost({ resolveBoundSession: () => undefined }));
  assert.equal(topology.agents.browser.status, "unknown");
  assert.equal(
    topology.agents.browser.error,
    "The bound browser conversation is not currently available",
  );
  assert.equal(topology.agents.browser.sessionId, undefined);
});

test("a binding that throws clears the stale session id and reports the failure", () => {
  const topology = {
    adapters: {},
    definitions: { browser: definition("browser", "claude-browser") },
    agents: {
      browser: {
        id: "browser",
        adapterType: "claude-browser",
        browserBinding: { conversationId: "c" },
        sessionId: "stale",
        output: "",
      },
    },
  };
  bindBrowserAgents(
    topology,
    bindingHost({
      bindConversation: () => {
        throw new Error("bridge is down");
      },
    }),
  );
  assert.equal(topology.agents.browser.status, "error");
  assert.equal(topology.agents.browser.error, "bridge is down");
  assert.equal(topology.agents.browser.sessionId, undefined);
});

test("a definition with no agent state left is skipped rather than binding nothing", () => {
  let called = false;
  bindBrowserAgents(
    { adapters: {}, definitions: { gone: definition("gone", "chatgpt-browser") }, agents: {} },
    bindingHost({ bindSession: () => { called = true; return {}; } }),
  );
  assert.equal(called, false);
});

test("only browser owners are released", () => {
  const released = [];
  releaseBrowserBindings(
    {
      adapters: {},
      agents: {},
      definitions: {
        browser: definition("browser", "chatgpt-browser"),
        local: definition("local", "codex-app-server"),
      },
    },
    { ownerIdFor: (agentId) => `owner:${agentId}`, releaseBinding: (id) => released.push(id) },
  );
  assert.deepEqual(released, ["owner:browser"]);
});

test("a reset keeps browser conversations and drops local sessions; fresh keeps neither", () => {
  // WHY THE DIFFERENCE. A browser conversation lives in a tab the user still has open and is not
  // this extension's to end. A local session is a child process a reset may replace.
  const agents = {
    browser: {
      id: "browser",
      adapterType: "claude-browser",
      version: "1",
      sessionId: "s",
      browserBinding: { conversationId: "c" },
      output: "",
    },
    local: {
      id: "local",
      adapterType: "codex-app-server",
      version: "2",
      sessionId: "local-session",
      output: "",
    },
  };
  assert.deepEqual(resetAgentsFrom(agents), {
    browser: { version: "1", sessionId: "s", browserBinding: { conversationId: "c" } },
    local: { version: "2" },
  });
  assert.deepEqual(freshAgentsFrom(agents), {
    browser: { version: "1" },
    local: { version: "2" },
  });
  assert.deepEqual(persistedAgentsFrom(agents), {
    browser: { version: "1", sessionId: "s", browserBinding: { conversationId: "c" } },
    local: { version: "2", sessionId: "local-session" },
  });
});

// EX-3. What a bridge status means for one browser agent, apart from binding it.
const { bindingFromSession, browserAgentBridgeStatus } = require("../dist/runtime/adapterTopology.js");

const bridgeStatus = (overrides = {}) =>
  browserAgentBridgeStatus({
    connected: true,
    hasBinding: false,
    readySessionCount: 0,
    providerName: "ChatGPT",
    ...overrides,
  });

test("a connected bridge with a ready bound session is an idle agent", () => {
  assert.deepEqual(bridgeStatus({ hasBinding: true, boundSessionStatus: "ready" }), { status: "idle", error: undefined });
});

test("a connected bridge with unbound ready sessions is an agent that can pick one", () => {
  assert.equal(bridgeStatus({ readySessionCount: 2 }).status, "available");
  assert.equal(bridgeStatus({ readySessionCount: 2, hasBinding: true }).status, "unknown");
  assert.equal(bridgeStatus({ readySessionCount: 2, connected: false }).status, "unknown");
});

test("a failed bound session, or a binding that could not be resolved, is an error with the reason", () => {
  assert.deepEqual(bridgeStatus({ hasBinding: true, boundSessionStatus: "failed" }), {
    status: "error",
    error: "ChatGPT browser conversation failed",
  });
  assert.deepEqual(bridgeStatus({ hasBinding: true, bindingError: "tab closed" }), {
    status: "error",
    error: "tab closed",
  });
});

test("the binding's own failure outranks the bridge's, and the bridge's outranks a missing session", () => {
  assert.equal(bridgeStatus({ hasBinding: true, bindingError: "tab closed", bridgeError: "socket lost" }).error, "tab closed");
  assert.equal(bridgeStatus({ hasBinding: true, bridgeError: "socket lost" }).error, "socket lost");
  assert.deepEqual(bridgeStatus({ hasBinding: true }), {
    status: "unknown",
    error: "The bound browser conversation is not currently available",
  });
});

test("a disconnected bridge with nothing bound says nothing at all", () => {
  assert.deepEqual(bridgeStatus({ connected: false }), { status: "unknown", error: undefined });
  assert.equal(bridgeStatus({ connected: false, boundSessionStatus: "ready", hasBinding: true }).status, "unknown");
});

test("a ready session binds to its conversation and the tab it was seen in", () => {
  assert.deepEqual(
    bindingFromSession({ provider: "chatgpt", conversationUrl: "https://c/1", conversationIdentity: "c-1", tabId: 7, id: "s-1", status: "ready" }),
    { provider: "chatgpt", conversationUrl: "https://c/1", conversationIdentity: "c-1", preferredTabId: 7 },
  );
});
