const assert = require("node:assert/strict");
const test = require("node:test");
const { catalogEventHistories, catalogEventView } = require("../dist/conversations/catalogViews.js");
const { boundedTranscriptEntry, boundedTranscriptWindow } = require("../dist/state/transcriptBounds.js");
const { createStreamRedactor, redactedAgentOutput, STREAM_REDACTION_CARRY_UNITS } = require("../dist/security/streamRedaction.js");
const { boundedAgentOutput, AGENT_OUTPUT_UNITS } = require("../dist/state/boundedAgentOutput.js");
const { codexParticipantConfiguration, unmanagedCodexDelegation } = require("../dist/adapters/codexDelegationPolicy.js");
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), "utf8");

test("empty conversation keys share the aggregate ceiling and active priority", () => {
  const histories = Array.from({ length: 20000 }, (_, i) => ({ conversationId: `conversation-${i}-${"x".repeat(32)}`, events: [] }));
  const activeConversationId = histories.at(-1).conversationId;
  for (const aggregateBytes of [2, 3, 16, 128, 1024, 512 * 1024]) {
    const result = catalogEventHistories({ histories, activeConversationId, aggregateBytes });
    assert.ok(bytes(result) <= aggregateBytes);
    if (aggregateBytes >= 128) assert.ok(Object.hasOwn(result, activeConversationId));
    assert.ok(Object.keys(result).length < histories.length);
  }
});

test("active status and ruling survive thousands of histories and switching", () => {
  const histories = Array.from({ length: 5000 }, (_, i) => ({ conversationId: `c-${i}`, events: [
    { id: 1, type: "decision.published", createdAt: "t", payload: { status: "ruled", candidate: { summary: "Inspect the worker lease before retrying." } } },
    { id: 2, type: "run.interrupted", status: "interrupted", createdAt: "t" },
  ] }));
  for (const activeConversationId of ["c-4999", "c-2400", "c-0"]) {
    for (const aggregateBytes of [1024, 4096, 512 * 1024]) {
      const result = catalogEventHistories({ histories, activeConversationId, aggregateBytes });
      assert.ok(bytes(result) <= aggregateBytes);
      assert.ok(result[activeConversationId].some((row) => row.type === "run.interrupted"));
      assert.ok(result[activeConversationId].some((row) => row.type === "decision.published" && row.payload));
    }
  }
});

test("workflow attempts reject any invalid step, duplicate, hash or list", () => {
  const valid = { hash: "a".repeat(64), steps: [{ id: "worker", name: "Worker" }] };
  const project = (pipeline) => catalogEventView({ id: 1, type: "run.started", createdAt: "t", payload: { pipeline } }).attempt;
  assert.ok(project(valid));
  for (const hash of ["A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), "a".repeat(1000000)]) assert.equal(project({ ...valid, hash }), undefined);
  for (const steps of [[], [null, ...valid.steps], [...valid.steps, "bad"], [...valid.steps, ...valid.steps], [{ id: "bad space", name: "x" }], [{ id: "valid", name: " " }]]) assert.equal(project({ ...valid, steps }), undefined);
  assert.ok(project({ ...valid, steps: Array.from({ length: 64 }, (_, i) => ({ id: `s${i}`, name: "x".repeat(256) })) }));
  assert.equal(project({ ...valid, steps: Array.from({ length: 65 }, (_, i) => ({ id: `s${i}`, name: "x" })) }), undefined);
});

test("transcript metadata and windows obey UTF-8 ceilings and reload fixed points", () => {
  const item = boundedTranscriptEntry({ id: "🙂".repeat(10000), kind: "answer", createdAt: "t".repeat(10000), agentId: "a".repeat(10000), step: "s".repeat(10000), eventType: "e".repeat(10000), text: "Inspect the lease" });
  assert.ok(bytes(item) < 2000);
  assert.deepEqual(boundedTranscriptEntry(item), item);
  for (const ceiling of [2, 3, 16, 128, bytes(item) + 1, bytes(item) + 2, 4096]) {
    const window = boundedTranscriptWindow([item], ceiling);
    assert.ok(bytes(window) <= ceiling);
    assert.deepEqual(boundedTranscriptWindow(window, ceiling), window);
  }
});

const credentials = [
  ["Authorization: Bearer abcDEF1234567890\n", "abcDEF1234567890"],
  ["Bearer abcDEF1234567890\n", "abcDEF1234567890"],
  ['API_KEY="one two THREE_SECRET"\n', "THREE_SECRET"],
  ['{"api_key": "MULTILINE\nSECRET_VALUE"}\n', "SECRET_VALUE"],
  ["key sk-abcdefghijklmnopqrstuv\n", "abcdefghijklmnopqrstuv"],
  ["-----BEGIN RSA PRIVATE KEY-----\nPRIVATE_BODY\n-----END RSA PRIVATE KEY-----\n", "PRIVATE_BODY"],
  ["password:\nMULTILINE_SECRET\n", "MULTILINE_SECRET"],
  ["https://user:PASSWORD_SECRET@example.com\n", "PASSWORD_SECRET"],
];
for (const [text, secret] of credentials) {
  test(`stream redacts every split of ${text.slice(0, 24).replace(/\n/g, " ")}`, () => {
    const expected = redactedAgentOutput(text);
    assert.ok(!expected.includes(secret));
    for (let cut = 1; cut < text.length; cut += 1) {
      const stream = createStreamRedactor();
      const first = stream.push(text.slice(0, cut));
      assert.ok(!first.includes(secret.slice(0, 5)), `partial secret at ${cut}`);
      const second = stream.push(text.slice(cut));
      const final = stream.finish();
      assert.equal(first + second + final, expected);
      assert.ok(!second.includes(secret));
    }
  });
}

test("large streams retain bounded carry and withhold a truncated credential", () => {
  const stream = createStreamRedactor();
  let output = stream.push('API_KEY="');
  for (let i = 0; i < 10000; i += 1) {
    output = boundedAgentOutput(output + stream.push("PRIVATE_VALUE".repeat(20)));
    assert.ok(stream.retainedUnits() <= STREAM_REDACTION_CARRY_UNITS + 400);
    assert.ok(output.length <= AGENT_OUTPUT_UNITS);
    assert.ok(!output.includes("PRIVATE_VALUE"));
  }
  output += stream.push('"\nSafe conclusion.\n') + stream.finish();
  assert.ok(output.endsWith("Safe conclusion.\n"));
  stream.push('API_KEY="discarded');
  stream.reset();
  assert.equal(stream.push("Next run.\n") + stream.finish(), "Next run.\n");
});

test("Codex policy disables delegation and permits ordinary tools", () => {
  const policy = codexParticipantConfiguration();
  assert.equal(policy.config["features.multi_agent"], false);
  assert.equal(policy.config["features.multi_agent_v2"], false);
  assert.match(policy.developerInstructions, /Bachata alone/);
  assert.equal(policy.baseInstructions, policy.developerInstructions);
  for (const tool of ["spawn_agent", "collaboration.spawn_agent", "resume_agent", "send_input"]) assert.equal(unmanagedCodexDelegation({ method: "item/tool/call", params: { tool } }), tool);
  assert.equal(unmanagedCodexDelegation({ method: "item/started", params: { item: { type: "collabAgentToolCall", tool: "spawnAgent" } } }), "spawnAgent");
  assert.equal(unmanagedCodexDelegation({ method: "item/commandExecution/requestApproval", params: { command: "rg worker src" } }), undefined);
});

const fs = require("node:fs");
const path = require("node:path");
const schema = require("../dist/pipeline/schema.js");
const preset = JSON.parse(fs.readFileSync(path.join(__dirname, "../presets/implementation-plan.pipeline.json"), "utf8"));

test("shipped presets satisfy the bounded pipeline schema", () => {
  for (const name of fs.readdirSync(path.join(__dirname, "../presets"))) {
    if (!name.endsWith(".pipeline.json")) continue;
    const value = JSON.parse(fs.readFileSync(path.join(__dirname, "../presets", name), "utf8"));
    const result = schema.validatePipelineDefinition(value);
    assert.equal(result.success, true, `${name}: ${JSON.stringify(result.errors)}`);
    assert.ok(bytes(result.data) <= schema.MAX_PIPELINE_SERIALIZED_BYTES);
  }
});

test("oversized pipeline collections are rejected before item access", () => {
  for (const [key, limit] of [["agents", 64], ["roles", 128], ["steps", 64], ["resourceDependencies", 128]]) {
    const items = new Proxy(Array(limit + 1), { get(target, property) {
      if (property !== "length") throw new Error(`Unexpected item read: ${String(property)}`);
      return target.length;
    } });
    assert.equal(schema.validatePipelineDefinition({ ...preset, [key]: items }).success, false);
  }
});

test("pipeline strings, nested collections, depth and total bytes are bounded", () => {
  for (const value of [
    { ...preset, description: "x".repeat(schema.MAX_PIPELINE_STRING_LENGTH + 1) },
    { ...preset, unknown: Array(257).fill("x") },
    { ...preset, unknown: Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`k${i}`, "x"])) },
    { ...preset, unknown: Array.from({ length: 20 }).reduce((value) => ({ value }), {}) },
    { ...preset, unknown: Array(20).fill("🙂".repeat(16000)) },
  ]) assert.equal(schema.validatePipelineDefinition(value).success, false);
});

const { pendingApprovalFrom } = require("../dist/runtime/providerInteraction.js");
test("approval composition refuses unbounded choices before reading items and bounds network metadata", () => {
  const choices = new Proxy([], { get(target, key) { if (key === "length") return 1_000_000; throw new Error("unbounded choice read"); } });
  assert.throws(() => pendingApprovalFrom("codex", { requestId: "approval", kind: "command", choices }), /choice limit/);
  assert.throws(() => pendingApprovalFrom("codex", { requestId: "x".repeat(513), kind: "command", choices: [] }), /identifier/);
  const approval = pendingApprovalFrom("codex", { requestId: "approval", kind: "command", choices: [], networkApprovalContext: { host: "h".repeat(100_000), protocol: "p".repeat(100_000), port: Infinity } });
  assert.ok(Buffer.byteLength(JSON.stringify(approval)) < 8192);
  assert.equal(approval.networkApprovalContext.port, undefined);
});

// Enum and notification shapes audited against the installed app-server schema.
for (const tool of ["spawnAgent", "sendInput", "resumeAgent", "wait", "closeAgent", "sendMessage", "followupTask", "interruptAgent", "listAgents"]) {
  test(`Codex refuses actual collaboration item ${tool} in live and terminal wire shapes`, () => {
    const item = { type: "collabAgentToolCall", id: "collaboration-attempt", tool, status: "inProgress", senderThreadId: "scheduled", receiverThreadIds: [], agentsStates: {} };
    for (const method of ["item/started", "item/completed"]) assert.equal(unmanagedCodexDelegation({ method, params: { item } }), tool);
    for (const method of ["turn/started", "turn/completed"]) assert.equal(unmanagedCodexDelegation({ method, params: { turn: { id: "turn", items: [{ type: "agentMessage", text: "I can review agent scheduling" }, item] } } }), tool);
  });
}
test("Codex ordinary text, tools and historical response data do not become delegation", () => {
  for (const message of [
    { method: "item/started", params: { item: { type: "agentMessage", text: "spawn_agent and collaboration tools are forbidden; inspect their tests" } } },
    { method: "item/agentMessage/delta", params: { delta: "sendMessage and subagents are mentioned in this source" } },
    { method: "item/tool/call", params: { tool: "exec_command", arguments: { cmd: "rg spawn_agent src" } } },
    { id: 5, result: { thread: { turns: [{ items: [{ type: "collabAgentToolCall", tool: "spawnAgent" }] }] } } },
  ]) assert.equal(unmanagedCodexDelegation(message), undefined);
});

test("webview initialization and dispatch error text is bounded, redacted and stable", () => {
  const { webviewErrorMessage, WEBVIEW_ERROR_BYTES } = require("../dist/webview/errorMessage.js");
  for (const source of ['Authorization: Bearer PRIVATE_PROVIDER_TOKEN_123456\n', 'API_KEY="PRIVATE_PROVIDER_TOKEN_123456"\n', 'password=PRIVATE_PROVIDER_TOKEN_123456\n']) {
    const result = webviewErrorMessage(new Error(source + "🙂".repeat(20000)));
    assert.doesNotMatch(result, /PRIVATE_PROVIDER_TOKEN/);
    assert.ok(Buffer.byteLength(result, "utf8") <= WEBVIEW_ERROR_BYTES);
    assert.equal(webviewErrorMessage(result), result);
  }
});
