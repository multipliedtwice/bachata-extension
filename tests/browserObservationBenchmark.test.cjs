const assert = require("node:assert/strict");
const test = require("node:test");
const { analyzeTrajectory, controllerPayload, parseTrace } = require("../scripts/lib/browserObservationBenchmark.cjs");
const { observationStore, project } = require("../scripts/lib/browserObservationPrototype.cjs");

const header = "Bachata processed your managed control request. Continue the same task using only controller results below.";
const handoff = "Bachata managed task handoff. Treat this controller-provided state as authoritative.";
const prompt = (payload, prefix = header) => `${prefix}\n\n${JSON.stringify(payload, null, 2)}\n\nProtocol {example}`;

test("measurement handles escaped braces, quotes and multilingual UTF-8 wire bytes", () => {
  const text = 'ไทย русский } { "quoted"\n\\path';
  const payload = { results: [{ kind: "context.readFile", snippet: { text } }] };
  const rendered = prompt(payload);
  assert.deepEqual(controllerPayload(rendered).value, payload);
  const result = analyzeTrajectory([{ prompt: rendered }], "fixture");
  assert.equal(result.promptBytes, Buffer.byteLength(rendered));
  assert.equal(result.observationTextWireBytes, Buffer.byteLength(JSON.stringify(text)));
  assert.equal(result.controllerJsonBytes, Buffer.byteLength(JSON.stringify(payload, null, 2)));
  assert.equal(result.protocolAndWrapperBytes + result.controllerMetadataJsonBytes + result.observationTextWireBytes, result.promptBytes);
  assert.throws(() => controllerPayload(`${header}\n{"incomplete":`), /incomplete/);
});

test("repeated source bytes stay separate from status and reset at a fresh handoff", () => {
  const text = "x".repeat(8192);
  const payload = { context: [{ text }], verification: [{ status: "failed", summary: "check failed" }] };
  const result = analyzeTrajectory([
    { prompt: prompt(payload, handoff) }, { prompt: prompt(payload) }, { prompt: prompt(payload, handoff) },
  ], "fixture");
  assert.equal(result.handoffs, 2);
  assert.equal(result.largeObservationTextWireBytes, 3 * Buffer.byteLength(JSON.stringify(text)));
  assert.equal(result.repeatedObservationTextWireBytes, Buffer.byteLength(JSON.stringify(text)) + Buffer.byteLength(JSON.stringify("check failed")));
  assert.equal(result.categories.verification.strings, 3);
  assert.ok(!JSON.stringify(result).includes(text));
});

test("native export imports only managed prompts and pairs each agent's recorded answer", () => {
  const managed = prompt({ results: [] });
  const entries = [
    { kind: "prompt", eventType: "user.message", text: managed },
    { kind: "prompt", eventType: "agent.prompt", agentId: "web", text: managed },
    { kind: "prompt", eventType: "agent.prompt", agentId: "local", text: "Local task" },
    { kind: "answer", agentId: "local", text: "Local answer" },
    { kind: "answer", agentId: "web", text: "Web answer" },
  ];
  assert.deepEqual(parseTrace(JSON.stringify({ transcript: entries })), [{ prompt: managed, answer: "Web answer" }]);
  assert.deepEqual(parseTrace(entries.map((entry) => JSON.stringify(entry)).join("\n")), [{ prompt: managed, answer: "Web answer" }]);
});

test("nonmanaged traces produce no observation claim and malformed traces refuse", () => {
  assert.equal(analyzeTrajectory(parseTrace(JSON.stringify([{ kind: "prompt", eventType: "agent.prompt", text: "ordinary task" }])), "recorded-prompts").prompts, 0);
  assert.throws(() => parseTrace('{"wrong":[]}'), /Expected transcript/);
  assert.throws(() => parseTrace("bad JSONL"));
});

test("prototype keeps status/version metadata and recalls exact Unicode across bounded pages", () => {
  const source = "ไทย русский source detail\n".repeat(600);
  const payload = { results: [{ kind: "context.readFile", ok: true, snippet: { fileVersion: "file-version-exact", text: source, truncated: true } }], verification: [{ status: "failed", summary: "Required check failed" }] };
  const store = observationStore();
  const projected = project(prompt(payload), store);
  const decoded = controllerPayload(projected.prompt).value;
  assert.equal(decoded.results[0].snippet.fileVersion, "file-version-exact");
  assert.equal(decoded.results[0].snippet.truncated, true);
  assert.deepEqual(decoded.verification, payload.verification);
  const receipt = decoded.results[0].snippet.text.observation;
  assert.equal(receipt.incomplete, true);
  const parts = [];
  for (let offset = 0; offset < Buffer.byteLength(source);) {
    const reply = store.recall({ id: receipt.id, offsetBytes: offset, maxBytes: 1024 });
    parts.push(Buffer.from(reply.text));
    offset = reply.nextOffsetBytes;
  }
  assert.equal(Buffer.concat(parts).toString("utf8"), source);
  assert.throws(() => store.recall({ id: receipt.id, offsetBytes: 1, maxBytes: 1024 }), /UTF-8/);
  assert.throws(() => store.recall({ id: receipt.id, offsetBytes: 0, maxBytes: 16385 }), /Invalid/);
  assert.throws(() => observationStore().recall({ id: receipt.id, offsetBytes: 0, maxBytes: 1024 }), /Unknown/);
  assert.equal(store.admit(source, "source"), receipt.id);
});

test("inline-once exposes complete first source and never assumes a different scope saw it", () => {
  const source = "source".repeat(2000);
  const rendered = prompt({ context: [{ text: source }] });
  const store = observationStore();
  assert.equal(project(rendered, store, "inline-once").prompt, rendered);
  const second = project(rendered, store, "inline-once");
  assert.equal(controllerPayload(second.prompt).value.context[0].text.observation.previouslyExposedInThisScope, true);
  assert.equal(project(rendered, observationStore(), "inline-once").prompt, rendered);
});
