const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const { loadRuntimeHarness } = require("./support/runtimeHarness.cjs");
const { removeScratchSync, scratchRootSync } = require("./support/scratch.cjs");
const { RESUMED_STEP_NOTICE } = require("../dist/runtime/browserContinuity.js");

const browserSession = (id, identity, tabId) => {
  const now = new Date().toISOString();
  return {
    id,
    provider: "chatgpt",
    tabId,
    frameId: 0,
    documentToken: `document-${id}`,
    conversationUrl: `https://chatgpt.com/c/${identity}`,
    conversationIdentity: `chatgpt:https://chatgpt.com/c/${identity}`,
    title: id,
    status: "ready",
    createdAt: now,
    updatedAt: now,
    capabilities: {
      submission: "verifiedSend",
      completion: "verifiedLifecycle",
      interruption: "confirmed",
      conversationState: "confirmed",
    },
  };
};

const captured = (session, text, turn) => {
  const now = new Date().toISOString();
  return {
    requestId: `request-${String(turn)}`,
    agentId: "chatgpt",
    sessionId: session.id,
    provider: "chatgpt",
    text,
    segments: [{ type: "text", text, start: 0, end: text.length }],
    assets: [],
    captureFormat: "renderedText",
    fidelity: "bestEffort",
    finalConversationUrl: session.conversationUrl,
    finalConversationIdentity: session.conversationIdentity,
    finalSessionId: session.id,
    startedAt: now,
    completedAt: now,
  };
};

const trackedBridge = (onOpen) => {
  const sessions = [];
  const opened = [];
  const status = { enabled: true, connected: true, sessions };
  const bindings = new Map();
  const bindingFor = (session) => ({
    provider: session.provider,
    conversationUrl: session.conversationUrl,
    conversationIdentity: session.conversationIdentity,
    preferredTabId: session.tabId,
  });
  return {
    sessions,
    opened,
    bridge: {
      start: async () => undefined,
      close: async () => undefined,
      getStatus: () => status,
      subscribeStatus: (listener) => {
        listener(status);
        return { dispose: () => undefined };
      },
      resetPairing: async () => undefined,
      discover: () => undefined,
      bindSession: (ownerId, sessionId) => {
        const session = sessions.find((item) => item.id === sessionId);
        if (!session) throw new Error(`Unknown browser session: ${sessionId}`);
        bindings.set(ownerId, bindingFor(session));
        return bindingFor(session);
      },
      bindConversation: (ownerId, binding) => bindings.set(ownerId, structuredClone(binding)),
      releaseBinding: (ownerId) => bindings.delete(ownerId),
      resolveBoundSession: (ownerId, binding, sessionId) => {
        const effective = binding ?? bindings.get(ownerId);
        return [...sessions].reverse().find((session) =>
          session.id === sessionId
          || (effective !== undefined && session.conversationIdentity === effective.conversationIdentity));
      },
      openConversation: async (provider, _signal, preferredBinding, fresh) => {
        opened.push({ provider, preferredBinding: preferredBinding && structuredClone(preferredBinding), fresh });
        const next = onOpen(opened.length, sessions);
        sessions.push(next);
        return next;
      },
      sendConversation: () => {
        throw new Error("unused");
      },
      fetchAsset: () => {
        throw new Error("unused");
      },
      revealAsset: async () => undefined,
      interrupt: async () => undefined,
    },
  };
};

const pipelineRoot = (definition) => {
  const root = scratchRootSync("bachata-continuity-extension-");
  fs.mkdirSync(path.join(root, "presets"), { recursive: true });
  fs.writeFileSync(path.join(root, "presets", "cross-reference.pipeline.json"), JSON.stringify(definition));
  return root;
};

const agentStep = (id, template, participants) => ({
  id,
  name: id,
  enabled: true,
  participants,
  promptTemplate: template,
  parallel: false,
  consensus: false,
  humanGate: "none",
  type: "agent",
});

const browserOnlyPipeline = () => ({
  version: 1,
  id: "cross-reference-development",
  name: "Browser continuity",
  agents: [{ id: "chatgpt", name: "ChatGPT", adapter: "chatgpt-browser" }],
  steps: [
    agentStep("first", "First: {{userPrompt}}", ["chatgpt"]),
    agentStep("second", "Second: {{userPrompt}}", ["chatgpt"]),
  ],
});

const run = (harness) => harness.runtime.runPipeline("the task");

const withHarness = async (definition, bridge, onSend, body) => {
  const root = pipelineRoot(definition);
  const holder = {};
  holder.harness = loadRuntimeHarness({
    extensionRoot: root,
    runtimeOptions: { bridge, startBridge: false, closeBridge: false },
    configuration: { browserSemanticInterpreterEnabled: false },
    onAdapterSend: async (input) => {
      holder.harness.adapterControls.get(input.agentId).release.resolve();
      return onSend(input);
    },
  });
  try {
    await holder.harness.runtime.handleMessage({ type: "ready" });
    await body(holder.harness);
  } finally {
    holder.harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await holder.harness.runtime.dispose();
    holder.harness.cleanup();
    removeScratchSync(root);
  }
};

test("a browser participant that replaces a CLI participant mid-run receives the role's earlier answers", async () => {
  const tracked = trackedBridge(() => browserSession("opened", "opened", 1));
  const definition = {
    version: 1,
    id: "cross-reference-development",
    name: "Provider switch",
    agents: [
      { id: "codex", name: "Codex", adapter: "codex-app-server" },
      { id: "chatgpt", name: "ChatGPT", adapter: "chatgpt-browser" },
    ],
    roles: [{ id: "implementer", name: "Implementer", instructions: "Implement.", candidateAgentIds: ["codex", "chatgpt"] }],
    steps: [
      { id: "assign-cli", name: "Assign CLI", enabled: true, humanGate: "none", type: "assignRoles", roleAssignments: [{ agentId: "codex", role: "implementer" }] },
      agentStep("plan", "Plan: {{userPrompt}}", ["implementer"]),
      { id: "assign-browser", name: "Assign browser", enabled: true, humanGate: "none", type: "assignRoles", roleAssignments: [{ agentId: "chatgpt", role: "implementer" }] },
      agentStep("build", "Build: {{userPrompt}}", ["implementer"]),
    ],
  };
  const prompts = [];
  await withHarness(definition, tracked.bridge, ({ agentId, request, sendCount }) => {
    prompts.push({ agentId, prompt: request.prompt });
    if (agentId === "codex") return { answer: "CLI plan answer" };
    const session = tracked.sessions.at(-1);
    return { answer: "browser build answer", capturedResponse: captured(session, "browser build answer", sendCount) };
  }, async (harness) => {
    await run(harness);
    assert.deepEqual(tracked.opened, [{ provider: "chatgpt", preferredBinding: undefined, fresh: false }]);
    const browserPrompt = prompts.find((entry) => entry.agentId === "chatgpt")?.prompt ?? "";
    assert.match(browserPrompt, /^Bachata context handoff for the Implementer role\./u);
    assert.match(browserPrompt, /answered by Codex\) ---\nCLI plan answer/u);
    assert.ok(browserPrompt.indexOf("CLI plan answer") < browserPrompt.indexOf("Build: the task"));
    const codexPrompt = prompts.find((entry) => entry.agentId === "codex")?.prompt ?? "";
    assert.ok(!codexPrompt.includes("Bachata context handoff"));
    assert.ok(
      harness.transcript.some((entry) => entry.kind === "prompt" && entry.agentId === "chatgpt" && entry.data?.roleId === "implementer"),
      "the browser prompt entry did not record its role",
    );
  });
});

test("a lost browser conversation is reopened on its own identity without a handoff", async () => {
  const first = browserSession("first", "kept", 1);
  const tracked = trackedBridge((index) => (index === 1 ? first : { ...browserSession("reopened", "kept", 2) }));
  const prompts = [];
  await withHarness(browserOnlyPipeline(), tracked.bridge, ({ request, sendCount }) => {
    prompts.push(request.prompt);
    const session = tracked.sessions.at(-1);
    const answer = `answer ${String(sendCount)}`;
    if (sendCount === 1) first.status = "notReady";
    return { answer, capturedResponse: captured(session, answer, sendCount) };
  }, async (harness) => {
    await run(harness);
    assert.equal(tracked.opened.length, 2);
    assert.equal(tracked.opened[0].preferredBinding, undefined);
    assert.equal(tracked.opened[1].preferredBinding?.conversationIdentity, first.conversationIdentity);
    assert.equal(tracked.opened[1].fresh, false);
    assert.ok(prompts[1].startsWith("Second: the task\n"), prompts[1]);
  });
});

test("a conversation that cannot be reopened is replaced by a new one that receives a handoff", async () => {
  const first = browserSession("first", "lost", 1);
  const tracked = trackedBridge((index) => {
    if (index === 1) return first;
    if (index === 2) throw new Error("PROVIDER_NOT_READY: The previous provider conversation is open but streaming");
    return browserSession("replacement", "replacement", 3);
  });
  const prompts = [];
  await withHarness(browserOnlyPipeline(), tracked.bridge, ({ request, sendCount }) => {
    prompts.push(request.prompt);
    const session = tracked.sessions.at(-1);
    const answer = sendCount === 1 ? "first step answer" : "second step answer";
    if (sendCount === 1) first.status = "streaming";
    return { answer, capturedResponse: captured(session, answer, sendCount) };
  }, async (harness) => {
    await run(harness);
    assert.deepEqual(
      tracked.opened.map((entry) => [entry.preferredBinding?.conversationIdentity, entry.fresh]),
      [[undefined, false], [first.conversationIdentity, false], [undefined, false]],
    );
    assert.match(prompts[1], /^Bachata context handoff\./u);
    assert.match(prompts[1], /answered by ChatGPT\) ---\nfirst step answer/u);
    assert.match(prompts[1], /Continue with the current request\. ---\n\nSecond: the task\n/u);
  });
});

test("the first turn after resuming into an already prompted step is told the earlier reply may be lost", async () => {
  const session = browserSession("steady", "steady", 1);
  const tracked = trackedBridge(() => session);
  const prompts = [];
  let failSecondStep = true;
  await withHarness(browserOnlyPipeline(), tracked.bridge, ({ request, sendCount }) => {
    prompts.push(request.prompt);
    if (request.prompt.includes("Second: the task") && failSecondStep) {
      failSecondStep = false;
      throw new Error("browser tab went away");
    }
    const answer = `answer ${String(sendCount)}`;
    return { answer, capturedResponse: captured(session, answer, sendCount) };
  }, async (harness) => {
    await assert.rejects(run(harness), /browser tab went away/u);
    assert.equal(harness.runtime.getState().resumableWorkflow?.nextStepIndex, 1);
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.resumePipeline();
    assert.equal(tracked.opened.length, 1);
    assert.equal(prompts.length, 3);
    assert.ok(prompts[0].startsWith("First: the task\n"), prompts[0]);
    assert.ok(prompts[1].startsWith("Second: the task\n"), prompts[1]);
    assert.ok(prompts[2].startsWith(`${RESUMED_STEP_NOTICE}\n\nSecond: the task\n`), prompts[2]);
  });
});
