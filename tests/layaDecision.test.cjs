const assert = require("node:assert/strict");
const test = require("node:test");
const fixture = require("./fixtures/laya/system-one-choice.json");
const {
  TYPED_DECISION_LIMITS,
  projectTypedDecisionCandidates,
  tryTypedDecision,
} = require("../dist/browser/localTypedDecision.js");
const {
  createLayaSystemOneRequest,
  parseLayaSystemOneDecision,
  createLayaDecisionAdapter,
} = require("../dist/browser/layaDecision.js");

const candidates = fixture.request.state.candidates;
const clone = (value) => structuredClone(value);
const abstains = async (response) => {
  assert.equal(parseLayaSystemOneDecision(response, candidates), undefined);
  assert.equal(await tryTypedDecision(candidates, createLayaDecisionAdapter(async () => response)), undefined);
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Laya request and response match the published system_one choice shape exactly", async () => {
  assert.deepEqual(createLayaSystemOneRequest(candidates), fixture.request);
  assert.deepEqual(parseLayaSystemOneDecision(fixture.response, candidates), fixture.decision);
  let called = 0;
  const adapter = createLayaDecisionAdapter(async (request, signal) => {
    called += 1;
    assert.deepEqual(request, fixture.request);
    assert.equal(signal.aborted, false);
    return clone(fixture.response);
  });
  assert.deepEqual(await tryTypedDecision(candidates, adapter), fixture.decision);
  assert.equal(called, 1);
});

for (const [name, mutate] of [
  ["unknown candidate", (r) => { r.answers.invented = r.answers.r1; }],
  ["omitted candidate", (r) => { delete r.answers.s2; }],
  ["empty answers", (r) => { r.answers = {}; }],
  ["duplicate answer entries", (r) => { r.answers = [["r1", r.answers.r1], ["r1", r.answers.r1]]; }],
  ["unknown outcome", (r) => { r.answers.r1.choice = "shell.run"; }],
  ["wrong question type", (r) => { r.answers.r1.type = "score"; }],
  ["missing answer field", (r) => { delete r.answers.r1.action; }],
  ["missing confidence", (r) => { delete r.answers.r1.confidence; }],
  ["low confidence", (r) => { r.answers.r1.confidence = 0.8999; }],
  ["confidence inconsistent with published entropy formula", (r) => { r.answers.r1.confidence = 0.99; }],
  ["non-finite confidence", (r) => { r.answers.r1.confidence = NaN; }],
  ["string confidence", (r) => { r.answers.r1.confidence = "0.99"; }],
  ["out-of-range confidence", (r) => { r.answers.r1.confidence = 1.01; }],
  ["unknown probability label", (r) => { r.answers.r1.probabilities.path = 0; }],
  ["missing probability", (r) => { delete r.answers.r1.probabilities.reject; }],
  ["negative probability", (r) => { r.answers.r1.probabilities.reject = -0.1; }],
  ["non-finite probability", (r) => { r.answers.r1.probabilities.reject = Infinity; }],
  ["unnormalized probabilities", (r) => { r.answers.r1.probabilities.reject = 0.8; }],
  ["choice contradicts distribution", (r) => { r.answers.r1.choice = "reject"; }],
  ["weak distribution despite confidence", (r) => { r.answers.r1.probabilities = { execute: 0.4, reject: 0.3, ambiguous: 0.3 }; }],
  ["tied choices", (r) => { r.answers.r1.probabilities = { execute: 0.5, reject: 0.5, ambiguous: 0 }; }],
  ["action authority", (r) => { r.answers.r1.action.command = "touch unexpected"; }],
  ["invalid action probability", (r) => { r.answers.r1.action.act_probability = null; }],
  ["path authority", (r) => { r.answers.r1.path = "../../secret"; }],
  ["patch authority", (r) => { r.patch = "replacement content"; }],
  ["selector authority", (r) => { r.selectors = ["body"]; }],
  ["provider routing metadata", (r) => { r.routing = { model: "multilingual" }; }],
  ["wrong model marker", (r) => { r.model = "some-other-model"; }],
  ["missing model marker", (r) => { delete r.model; }],
  ["missing usage", (r) => { delete r.usage; }],
  ["invalid usage", (r) => { r.usage.input_tokens = -1; }],
  ["fractional usage", (r) => { r.usage.input_tokens = 1.5; }],
  ["unsafe usage integer", (r) => { r.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1; }],
  ["generated output tokens", (r) => { r.usage.output_tokens = 1; }],
]) {
  test(`Laya abstains on ${name}`, async () => {
    const response = clone(fixture.response);
    mutate(response);
    await abstains(response);
  });
}

for (const [name, response] of [
  ["null", null], ["array", []], ["unparseable text", "not JSON"],
  ["JSON text", JSON.stringify(fixture.response)],
  ["duplicate JSON keys", '{"model":"laya-rl-agent","answers":{"r1":{},"r1":{}},"usage":{"input_tokens":1,"output_tokens":0}}'],
]) {
  test(`Laya rejects ${name} rather than repairing it`, () => abstains(response));
}

test("SDK act_probability never grants or removes action authority", async () => {
  const response = clone(fixture.response);
  response.answers.r1.action.act_probability = 1;
  response.answers.s2.action.act_probability = 0;
  assert.deepEqual(await tryTypedDecision(candidates, createLayaDecisionAdapter(async () => response)), fixture.decision);
});

test("an ambiguous answer delegates the entire batch, never a partial Laya decision", async () => {
  const response = clone(fixture.response);
  response.answers.s2.choice = "ambiguous";
  response.answers.s2.probabilities = { execute: 0.005, reject: 0.005, ambiguous: 0.99 };
  assert.deepEqual(parseLayaSystemOneDecision(response, candidates), { execute: ["r1"], reject: [], ambiguous: ["s2"] });
  assert.equal(await tryTypedDecision(candidates, createLayaDecisionAdapter(async () => response)), undefined);
});

for (const [name, result] of [
  ["unknown id", { execute: ["invented"], reject: ["s2"], ambiguous: [] }],
  ["duplicate id", { execute: ["r1", "r1"], reject: ["s2"], ambiguous: [] }],
  ["duplicate across outcomes", { execute: ["r1"], reject: ["r1", "s2"], ambiguous: [] }],
  ["omitted id", { execute: ["r1"], reject: [], ambiguous: [] }],
  ["missing outcome", { execute: ["r1"], reject: ["s2"] }],
  ["extra authority", { ...fixture.decision, command: "touch unexpected" }],
  ["non-array outcome", { execute: "r1", reject: ["s2"], ambiguous: [] }],
]) {
  test(`the pluggable gate independently rejects ${name}`, async () => {
    assert.equal(await tryTypedDecision(candidates, async () => result), undefined);
  });
}

test("candidate projection strips arguments and source, freezes copies, and preserves exact Unicode evidence", async () => {
  const evidence = "กรุณา read src/ผู้ใช้.ts\r\nПрочитай src/данные.ts\t👩‍💻 e\u0301";
  const input = [{ id: "r1", kindHint: "read", evidence, parsedArguments: { path: "src/ผู้ใช้.ts" }, source: { text: "exact capture" }, command: "unexpected" }];
  const before = clone(input);
  const request = createLayaSystemOneRequest(input);
  assert.equal(request.state.candidates[0].evidence, evidence);
  assert.deepEqual(Buffer.from(request.state.candidates[0].evidence), Buffer.from(evidence));
  assert.deepEqual(Object.keys(request.state.candidates[0]), ["id", "kindHint", "evidence"]);
  for (const value of [request, request.state, request.state.candidates, request.state.candidates[0], request.questions, request.questions.r1, request.questions.r1.criteria]) {
    assert.equal(Object.isFrozen(value), true);
  }
  assert.equal(Reflect.set(request.state.candidates[0], "evidence", "replacement"), false);
  assert.deepEqual(input, before);
  assert.deepEqual(await tryTypedDecision(input, async (projected) => {
    assert.deepEqual(projected, request.state.candidates);
    return { execute: ["r1"], reject: [], ambiguous: [] };
  }), { execute: ["r1"], reject: [], ambiguous: [] });
});

for (const language of ["Please read src/config.ts", "กรุณาอ่าน src/ข้อมูล.ts", "Прочитайте src/данные.ts", "请读取 src/配置.ts", "Lire src/café.ts 👩‍💻"]) {
  test(`multilingual fixture bytes are retained: ${language}`, async () => {
    const input = [{ id: "r1", kindHint: "read", evidence: language }];
    const response = clone(fixture.response);
    delete response.answers.s2;
    const adapter = createLayaDecisionAdapter(async (request) => {
      assert.equal(request.state.candidates[0].evidence, language);
      return response;
    });
    assert.deepEqual(await tryTypedDecision(input, adapter), { execute: ["r1"], reject: [], ambiguous: [] });
  });
}

for (const [name, input] of [
  ["no candidates", []],
  ["too many candidates", Array.from({ length: 17 }, (_, i) => ({ id: `r${i + 1}`, kindHint: "read", evidence: "read src/a.ts" }))],
  ["duplicate candidates", [candidates[0], candidates[0]]],
  ["unknown kind", [{ ...candidates[0], kindHint: "unknown" }]],
  ["verification action", [{ ...candidates[0], kindHint: "verify" }]],
  ["filesystem write", [{ ...candidates[0], kindHint: "workspace.write" }]],
  ["prototype id", [{ ...candidates[0], id: "__proto__" }]],
  ["empty id", [{ ...candidates[0], id: "" }]],
  ["oversized id", [{ ...candidates[0], id: "r".repeat(65) }]],
  ["empty evidence", [{ ...candidates[0], evidence: "  " }]],
  ["overlong ASCII evidence", [{ ...candidates[0], evidence: "a".repeat(2049) }]],
  ["overlong UTF-8 evidence", [{ ...candidates[0], evidence: "ก".repeat(683) }]],
  ["ill-formed Unicode", [{ ...candidates[0], evidence: "read src/\ud800.ts" }]],
  ["overlong batch", Array.from({ length: 5 }, (_, i) => ({ id: `r${i + 1}`, kindHint: "read", evidence: "a".repeat(2048) }))],
]) {
  test(`input bounds abstain without transport for ${name}`, async () => {
    let calls = 0;
    assert.equal(createLayaSystemOneRequest(input), undefined);
    assert.equal(await tryTypedDecision(input, async () => { calls += 1; return fixture.decision; }), undefined);
    assert.equal(calls, 0);
  });
}

test("exact evidence and candidate bounds do not truncate input", () => {
  const input = [{ ...candidates[0], evidence: "é".repeat(1024) }];
  assert.equal(Buffer.byteLength(input[0].evidence), TYPED_DECISION_LIMITS.evidenceBytes);
  assert.deepEqual(projectTypedDecisionCandidates(input), input);
  const sixteen = Array.from({ length: 16 }, (_, i) => ({ id: `r${i + 1}`, kindHint: "read", evidence: "read src/a.ts" }));
  assert.equal(Object.keys(createLayaSystemOneRequest(sixteen).questions).length, 16);
});

test("absent adapter, invalid budget, thrown transport and rejected transport all abstain", async () => {
  assert.equal(await tryTypedDecision(candidates), undefined);
  for (const budget of [0, -1, 251, Infinity, NaN]) {
    assert.equal(await tryTypedDecision(candidates, async () => assert.fail("invalid budget dispatched"), undefined, budget), undefined);
  }
  assert.equal(await tryTypedDecision(candidates, () => { throw new Error("transport"); }), undefined);
  assert.equal(await tryTypedDecision(candidates, async () => { throw new Error("transport"); }), undefined);
});

test("deadline aborts transport and refuses late output even when transport ignores cancellation", async () => {
  let finish;
  let signal;
  let calls = 0;
  const adapter = createLayaDecisionAdapter(async (_request, receivedSignal) => {
    calls += 1;
    signal = receivedSignal;
    return await new Promise((resolve) => { finish = resolve; });
  });
  assert.equal(await tryTypedDecision(candidates, adapter, undefined, 5), undefined);
  assert.equal(signal.aborted, true);
  assert.equal(await tryTypedDecision(candidates, adapter), undefined);
  assert.equal(calls, 1, "a timed-out pending adapter was invoked again");
  finish(fixture.response);
  await delay(0);
  assert.equal(calls, 1);
});

test("late transport rejection is handled and releases the pending adapter", async () => {
  let reject;
  let calls = 0;
  const adapter = async () => {
    calls += 1;
    if (calls === 1) return await new Promise((_resolve, decline) => { reject = decline; });
    return fixture.decision;
  };
  assert.equal(await tryTypedDecision(candidates, adapter, undefined, 5), undefined);
  reject(new Error("late failure"));
  await delay(0);
  assert.deepEqual(await tryTypedDecision(candidates, adapter), fixture.decision);
  assert.equal(calls, 2);
});

test("caller cancellation propagates, including when the adapter ignores its signal", async () => {
  const before = new AbortController();
  before.abort();
  await assert.rejects(tryTypedDecision(candidates, async () => assert.fail("cancelled dispatch"), before.signal), /interrupted/u);
  const during = new AbortController();
  let received;
  const pending = tryTypedDecision(candidates, async (_input, signal) => {
    received = signal;
    during.abort();
    return await new Promise(() => undefined);
  }, during.signal);
  await assert.rejects(pending, /interrupted/u);
  assert.equal(received.aborted, true);
});

test("a synchronous adapter cannot make an expired decision win the timer race", async () => {
  const result = await tryTypedDecision(candidates, async () => {
    const until = performance.now() + 15;
    while (performance.now() < until) {}
    return fixture.decision;
  }, undefined, 5);
  assert.equal(result, undefined);
});

test("schema validation refuses accessors without invoking them", async () => {
  let accessed = false;
  const response = clone(fixture.response);
  Object.defineProperty(response.answers.r1, "choice", { enumerable: true, get: () => { accessed = true; return "execute"; } });
  await abstains(response);
  assert.equal(accessed, false);
});
