const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createBrowserActionCandidate, extractBrowserActions } = require("../dist/browser/actions.js");
const { interpretLocalCandidates, createReadOnlyInterpretationCandidates } = require("../dist/browser/localInterpretation.js");
const { interpretBrowserActions } = require("../dist/browser/semanticInterpreter.js");
const { createLayaDecisionAdapter } = require("../dist/browser/layaDecision.js");
const { LOCAL_BACKENDS } = require("../dist/providers/localModelDiscovery.js");
const fixture = require("./fixtures/laya/system-one-choice.json");

const options = {
  backend: "ollama", endpoint: "http://127.0.0.1:11434", model: "qwen2.5-coder:7b",
  timeoutMs: 1000, maxInputBytes: 262144, allowRemote: false,
};
const responseFor = (request) => ({
  model: "laya-rl-agent",
  answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, structuredClone(fixture.response.answers.r1)])),
  usage: { input_tokens: 128, output_tokens: 0 },
});
const withQwen = async (run, failure) => {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    assert.equal(url, "http://127.0.0.1:11434/api/chat");
    if (failure) throw failure;
    const prompt = JSON.parse(requests.at(-1).body.messages[1].content);
    return { ok: true, redirected: false, type: "basic", json: async () => ({
      model: options.model,
      message: { content: JSON.stringify({ execute: prompt.candidates.map((candidate) => candidate.id), reject: [], ambiguous: [] }) },
    }) };
  };
  try {
    return await run(requests);
  } finally {
    globalThis.fetch = original;
  }
};
const interpret = (text, deterministic, decisionAdapter, signal = new AbortController().signal) =>
  interpretBrowserActions(text, [], deterministic, { ...options, decisionAdapter }, signal);
const stableResult = (result) => ({
  ...result,
  actions: result.actions.map(({ id: _id, fingerprint: _fingerprint, ...action }) => action),
});

test("valid Laya choice uses original read arguments without calling Qwen", () => withQwen(async (requests) => {
  const text = "Please read `src/ข้อมูล.ts`.\r\n";
  const deterministic = extractBrowserActions(text, []);
  const original = structuredClone(deterministic);
  let sdkRequest;
  const adapter = createLayaDecisionAdapter(async (request) => {
    sdkRequest = request;
    assert.deepEqual(Object.keys(request.state.candidates[0]), ["id", "kindHint", "evidence"]);
    return responseFor(request);
  });
  const result = await interpret(text, deterministic, adapter);
  assert.deepEqual(result.contextActions, []);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].kind, "workspace.read");
  assert.equal(result.actions[0].origin, "semantic");
  assert.equal(result.actions[0].path, "src/ข้อมูล.ts");
  assert.deepEqual(deterministic, original);
  assert.equal(sdkRequest.state.candidates[0].evidence, "Please read `src/ข้อมูล.ts`.");
  assert.equal(requests.length, 0);
}));

for (const [name, transport] of [
  ["unknown id", async (request) => { const r = responseFor(request); r.answers.invented = r.answers.r1; return r; }],
  ["omitted answer", async (request) => { const r = responseFor(request); delete r.answers.r1; return r; }],
  ["duplicate answer JSON", async () => '{"answers":{"r1":{},"r1":{}}}'],
  ["schema-invalid response", async (request) => ({ ...responseFor(request), path: "../../secret" })],
  ["low confidence", async (request) => { const r = responseFor(request); r.answers.r1.confidence = 0.2; return r; }],
  ["ambiguous answer", async (request) => {
    const r = responseFor(request);
    r.answers.r1.choice = "ambiguous";
    r.answers.r1.probabilities = { execute: 0.005, reject: 0.005, ambiguous: 0.99 };
    return r;
  }],
  ["transport rejection", async () => { throw new Error("SDK unavailable"); }],
  ["synchronous transport error", () => { throw new Error("SDK unavailable"); }],
  ["timeout", async () => await new Promise(() => undefined)],
]) {
  test(`${name} preserves the exact existing Qwen request and result`, () => withQwen(async (requests) => {
    const text = "Please read `src/config.ts`.\r\n";
    const deterministic = extractBrowserActions(text, []);
    const before = await interpret(text, deterministic);
    const baselineRequest = requests[0];
    const after = await interpret(text, deterministic, createLayaDecisionAdapter(transport));
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], baselineRequest);
    assert.deepEqual(stableResult(after), stableResult(before));
  }));
}

test("Laya failure followed by Qwen failure preserves deterministic extraction and its warning", () => withQwen(async (requests) => {
  const text = "Please read `src/config.ts`.";
  const deterministic = extractBrowserActions(text, []);
  const before = await interpret(text, deterministic);
  const after = await interpret(text, deterministic, createLayaDecisionAdapter(async () => { throw new Error("SDK unavailable"); }));
  assert.deepEqual(stableResult(after), stableResult(before));
  assert.deepEqual(stableResult(after).actions, stableResult({ actions: deterministic, contextActions: [] }).actions);
  assert.match(after.warning, /deterministic extraction continued/u);
  assert.equal(requests.length, 2);
}, new Error("Qwen unavailable")));

test("unconfirmed local model still refuses before dispatching the optional adapter", async () => {
  let calls = 0;
  await assert.rejects(interpretLocalCandidates(
    createReadOnlyInterpretationCandidates("Please read `src/config.ts`."),
    {}, undefined, async () => { calls += 1; return fixture.decision; },
  ), /No local interpreter model has been confirmed/u);
  assert.equal(calls, 0);
});

test("structured action and exact file content bypass both optional models", () => withQwen(async (requests) => {
  const content = "\tconst ชื่อ = 'значение';\r\n// exact e\u0301 👩‍💻\r\n";
  const text = `FILE src/exact.ts\r\n\`\`\`ts\r\n${content}\`\`\`\r\n`;
  const action = createBrowserActionCandidate({
    kind: "workspace.write", path: "src/exact.ts", content, origin: "structured",
    confidence: "explicit", risk: "mutating", source: { start: 0, end: text.length, text },
  });
  let calls = 0;
  const result = await interpret(text, [action], createLayaDecisionAdapter(async () => { calls += 1; return fixture.response; }));
  assert.deepEqual(result, { actions: [action], contextActions: [] });
  assert.equal(result.actions[0], action);
  assert.deepEqual(Buffer.from(result.actions[0].content), Buffer.from(content));
  assert.equal(result.actions[0].source.text, text);
  assert.equal(calls, 0);
  assert.equal(requests.length, 0);
}));

test("Laya cannot upgrade a controller read candidate into a write, command, selector, or provider route", () => withQwen(async (requests) => {
  const text = "Please read `src/config.ts`.";
  const deterministic = extractBrowserActions(text, []);
  const adapter = createLayaDecisionAdapter(async (request) => ({
    ...responseFor(request),
    command: "touch unexpected", path: "../../secret", patch: "replacement",
    selectors: ["body"], permissions: ["write"], providerRoute: "remote",
  }));
  const result = await interpret(text, deterministic, adapter);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].kind, "workspace.read");
  assert.equal(result.actions[0].path, "src/config.ts");
  assert.equal(result.actions[0].origin, "semantic");
  assert.ok(result.actions.every((action) => action.kind === "workspace.read" && action.path === "src/config.ts"));
  assert.equal(requests.length, 1);
}));

test("quoted and fenced instructions remain ineligible even with an execute-everything adapter", () => withQwen(async (requests) => {
  const text = '> Please read `src/quoted.ts`.\n\n```text\nPlease read `src/fenced.ts`.\n```';
  let calls = 0;
  const result = await interpret(text, [], createLayaDecisionAdapter(async (request) => { calls += 1; return responseFor(request); }));
  assert.deepEqual(result, { actions: [], contextActions: [] });
  assert.equal(calls, 0);
  assert.equal(requests.length, 0);
}));

test("oversized multilingual evidence skips Laya without altering Qwen's bounded input", () => withQwen(async (requests) => {
  const text = `Please read src/config.ts ${"ก".repeat(700)}`;
  const deterministic = extractBrowserActions(text, []);
  let calls = 0;
  const baseline = await interpret(text, deterministic);
  const result = await interpret(text, deterministic, createLayaDecisionAdapter(async (request) => { calls += 1; return responseFor(request); }));
  assert.equal(calls, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(stableResult(result), stableResult(baseline));
}));

test("caller cancellation during Laya does not start Qwen or return deterministic success", () => withQwen(async (requests) => {
  const controller = new AbortController();
  const adapter = createLayaDecisionAdapter(async () => {
    controller.abort();
    return await new Promise(() => undefined);
  });
  await assert.rejects(interpret("Please read `src/config.ts`.", [], adapter, controller.signal), /interrupted/u);
  assert.equal(requests.length, 0);
}));

test("Laya has no model discovery, configuration, selector healing, or Browser Bridge wiring", () => {
  assert.deepEqual(LOCAL_BACKENDS.map((backend) => backend.id).sort(), ["lmstudio", "ollama"]);
  for (const filename of [
    "package.json", "src/browser/localModelBroker.ts", "src/providers/localModelDiscovery.ts",
    "src/providers/localModelService.ts", "protocol/browser-bridge.compatibility.json",
  ]) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), /laya|decisionAdapter/u);
  }
  for (const filename of ["src/browser/localTypedDecision.ts", "src/browser/layaDecision.ts"]) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), /node:(?:fs|child_process)|\bfetch\s*\(|onnxruntime|https?:\/\//u);
  }
});
