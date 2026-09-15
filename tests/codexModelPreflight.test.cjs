const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCodexAppServerAdapter } = require("../dist/adapters/codexAppServer.js");
const { scratchRootSync, removeScratchSync } = require("./support/scratch.cjs");

const mockCodex = path.join(__dirname, "fixtures", "mock-codex.cjs");

const createCodex = (overrides = {}) =>
  createCodexAppServerAdapter({
    command: mockCodex,
    commandCheckTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    turnTimeoutMs: 5000,
    interruptGraceMs: 500,
    requestApproval: async () => "accept",
    log: () => undefined,
    workspaceScope: "wholeWorkingDirectory",
    ...overrides,
  });

const sendRequest = (model) => ({
  prompt: "Review this change",
  workingDirectory: os.tmpdir(),
  attachments: [],
  permissionMode: "readOnly",
  ...(model === undefined ? {} : { model }),
});

const collect = async (iterable) => {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
};

const withMockModels = async (models, body) => {
  const previous = process.env.MOCK_CODEX_MODELS;
  const recordPath = path.join(scratchRootSync("bachata-codex-models-"), "rpc.jsonl");
  const previousRecord = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_CODEX_MODELS = models;
  process.env.MOCK_RECORD_PATH = recordPath;
  try {
    return await body(() =>
      fs.existsSync(recordPath)
        ? fs.readFileSync(recordPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : []);
  } finally {
    if (previous === undefined) delete process.env.MOCK_CODEX_MODELS;
    else process.env.MOCK_CODEX_MODELS = previous;
    if (previousRecord === undefined) delete process.env.MOCK_RECORD_PATH;
    else process.env.MOCK_RECORD_PATH = previousRecord;
    removeScratchSync(path.dirname(recordPath));
  }
};

test("a model this Codex does not offer is refused before any thread or turn begins", async () => {
  await withMockModels("gpt-5.6-sol,gpt-5.5", async (recorded) => {
    const adapter = createCodex();
    try {
      // The same shape every other pre-turn refusal takes: the turn never yields, it fails.
      await assert.rejects(
        collect(adapter.send(sendRequest("gpt-6-astra"), new AbortController().signal)),
        (error) => {
          assert.match(error.message, /does not offer the selected model "gpt-6-astra"/u);
          assert.match(error.message, /mock-codex\.cjs/u, "the refusal names the executable it asked");
          assert.match(error.message, /0\.146\.0/u, "the refusal names the version that answered");
          assert.match(error.message, /gpt-5\.6-sol, gpt-5\.5/u, "the refusal names what is offered");
          return true;
        },
      );

      const methods = recorded()
        .filter((entry) => entry.type === "rpc")
        .map((entry) => entry.message.method);
      assert.ok(methods.includes("model/list"), "the catalog is asked for");
      assert.equal(
        methods.includes("thread/start"),
        false,
        "no provider session may be created for a model the executable rejects",
      );
      assert.equal(
        methods.includes("turn/start"),
        false,
        "no turn may begin for a model the executable rejects",
      );
    } finally {
      await adapter.dispose();
    }
  });
});

test("a model this Codex offers runs, and discovery alone starts no turn", async () => {
  await withMockModels("gpt-5.6-sol,gpt-5.5", async (recorded) => {
    const adapter = createCodex();
    try {
      const catalog = await adapter.listModels();
      assert.equal(catalog.supported, true);
      assert.deepEqual(catalog.models.map((model) => model.id), ["gpt-5.6-sol", "gpt-5.5"]);
      assert.equal(catalog.runtimeVersion, "0.146.0");
      assert.equal(
        recorded().filter((entry) => entry.type === "rpc").map((entry) => entry.message.method)
          .includes("turn/start"),
        false,
        "listing models must never start a billable turn",
      );

      const events = await collect(adapter.send({
        ...sendRequest("gpt-5.5"),
        reasoningEffort: "high",
      }, new AbortController().signal));
      assert.equal(events.some((event) => event.type === "error"), false);
      const methods = recorded()
        .filter((entry) => entry.type === "rpc")
        .map((entry) => entry.message.method);
      assert.ok(methods.includes("thread/start"));
      assert.ok(methods.includes("turn/start"));
      assert.equal(recorded().find((entry) => entry.type === "turn").params.effort, "high");
    } finally {
      await adapter.dispose();
    }
  });
});

test("a Codex that cannot list models refuses nothing, so the reader's own model still runs", async () => {
  const adapter = createCodex();
  try {
    const catalog = await adapter.listModels();
    assert.equal(catalog.supported, false);
    assert.match(catalog.reason, /model list|model\/list/u);
    const events = await collect(adapter.send(sendRequest("gpt-6-astra"), new AbortController().signal));
    assert.equal(
      events.some((event) => event.type === "error"),
      false,
      "an unlistable provider proves nothing about a model, so nothing is refused",
    );
  } finally {
    await adapter.dispose();
  }
});


test("refreshing the Codex catalog asks the provider again without starting a turn", async () => {
  await withMockModels("provider-model-one,provider-model-two", async (recorded) => {
    const adapter = createCodex();
    try {
      await adapter.listModels();
      await adapter.listModels();
      const methods = recorded().filter((entry) => entry.type === "rpc").map((entry) => entry.message.method);
      assert.equal(methods.filter((method) => method === "model/list").length, 2);
      assert.equal(methods.includes("thread/start"), false);
      assert.equal(methods.includes("turn/start"), false);
    } finally { await adapter.dispose(); }
  });
});
