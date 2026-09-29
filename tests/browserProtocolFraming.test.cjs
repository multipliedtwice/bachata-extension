const assert = require("node:assert/strict");
const test = require("node:test");
const { protocolFraming, reminder } = require("../scripts/lib/browserProtocolFraming.cjs");
const { controllerPayload } = require("../scripts/lib/browserObservationBenchmark.cjs");
const { browserControlProtocolPrompt } = require("../dist/browser/controlProtocol.js");
const { composeManagedRolloverPrompt } = require("../dist/browser/managedConversationBudget.js");
const makePrompt = (handoff = false) => (handoff
  ? "Bachata managed task handoff. Treat this controller-provided state as authoritative."
  : "Bachata processed your managed control request. Continue the same task using only controller results below.")
  + "\n\n" + JSON.stringify({ results: [{ kind: "context.fileVersion", ok: true, path: "src/catalog.ts", fileVersion: "current" }],
    verification: [{ id: "integrity", status: "failed", summary: "Actual failure" }], readOnly: true }) + "\n\n" + browserControlProtocolPrompt;

test("framing keeps first contract and every controller JSON byte, including failures and current versions", () => {
  const frame = protocolFraming();
  assert.deepEqual(frame(makePrompt(true)), { prompt: makePrompt(true), compacted: false });
  const result = frame(makePrompt());
  assert.equal(result.compacted, true);
  assert.equal(controllerPayload(result.prompt).text, controllerPayload(makePrompt()).text);
  assert.ok(result.prompt.endsWith(reminder));
  assert.ok(Buffer.byteLength(result.prompt) < Buffer.byteLength(makePrompt()));
  assert.equal(frame(makePrompt(true)).compacted, false);
  assert.equal(protocolFraming()(makePrompt()).compacted, false);
});

test("framing leaves repairs, unrecognized contracts and plain follow-ups intact", () => {
  const frame = protocolFraming();
  frame(makePrompt(true));
  for (const prompt of ["Same task, another question", "Controller rejected the response\n\n" + browserControlProtocolPrompt,
    makePrompt().replace(browserControlProtocolPrompt, "New unknown protocol")]) {
    assert.deepEqual(frame(prompt), { prompt, compacted: false });
  }
});

test("the production rollover composer retains both complete contracts after previous exposure", () => {
  const frame = protocolFraming();
  frame(makePrompt(true));
  const rollover = composeManagedRolloverPrompt({ preparedPrompt: makePrompt(true), continuationPrompt: makePrompt(), maxBytes: 65_536 });
  assert.deepEqual(frame(rollover), { prompt: rollover, compacted: false });
  assert.equal(rollover.split(browserControlProtocolPrompt).length - 1, 2);
});
