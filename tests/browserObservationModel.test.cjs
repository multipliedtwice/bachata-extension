const assert = require("node:assert/strict");
const test = require("node:test");
const { grade, escapeControllerSlashes, source, rolloverSource, rolloverInventory, rejectedProposal } = require("../scripts/browser-observation-model.cjs");
const { validateBrowserControlEnvelope } = require("../dist/browser/controlProtocol.js");
const { controllerPayload } = require("../scripts/lib/browserObservationBenchmark.cjs");

const verification = [{ id: "integrity", status: "passed" }];
const verify = { kind: "verification.run", checkIds: ["integrity"] };
const inventory = { status: "reviewComplete", summary: JSON.stringify({ id: "entry080", region: "eu-central-2", releaseTag: "release-ญ-080" }) };

test("model result cannot pass using a previous phase's verification or a failed version request", () => {
  const version = { kind: "context.fileVersion", path: "src/catalog.ts", ok: true };
  assert.equal(grade("inventory", inventory, [], verification, [version]).passed, false);
  assert.equal(grade("inventory", inventory, [verify], verification, [{ ...version, ok: false }]).passed, false);
  assert.equal(grade("inventory", inventory, [verify], verification, [version]).passed, true);
});

test("model's integrity assertion cannot substitute for a controller verdict", () => {
  const version = { kind: "context.fileVersion", path: "src/catalog.ts", ok: true };
  assert.equal(grade("inventory", inventory, [verify], [{ id: "integrity", status: "failed" }], [version]).passed, false);
  assert.equal(grade("inventory", { ...inventory, summary: `${inventory.summary},\"workspaceIntegrity\":\"passed\"` }, [verify], verification, [version]).passed, false);
});

test("browser wire escaping preserves exact controller JSON and quoted source literals", () => {
  const payload = { results: [{ kind: "context.readFile", ok: true, path: "src/catalog.ts", snippet: {
    fileVersion: "version-current", text: 'const url = "http://example.test/a"; const regex = /a\\/b/; // ญ\n',
  } }] };
  const prompt = "Bachata processed your managed control request. Continue the same task using only controller results below.\n\n"
    + JSON.stringify(payload, null, 2) + "\n\nOriginal control protocol";
  const escaped = escapeControllerSlashes(prompt);
  assert.deepEqual(controllerPayload(escaped).value, payload);
  assert.ok(!controllerPayload(escaped).text.includes("http://"));
  assert.ok(escaped.endsWith("Original control protocol"));
  assert.equal(escapeControllerSlashes("Plain follow-up"), "Plain follow-up");
});

test("fresh generation must report changed fixture values rather than the old correct answer", () => {
  const version = { kind: "context.fileVersion", path: "src/catalog.ts", ok: true };
  assert.notEqual(source(), rolloverSource());
  assert.ok(rolloverSource().includes(`region: "${rolloverInventory.region}", releaseTag: "${rolloverInventory.releaseTag}"`));
  assert.equal(grade("inventory", inventory, [verify], verification, [version], rolloverInventory).passed, false);
  assert.equal(grade("inventory", { ...inventory, summary: JSON.stringify(rolloverInventory) }, [verify], verification, [version], rolloverInventory).passed, true);
});

test("planned invalid proposal is refused by the actual strict validator without altering the captured proposal", () => {
  const original = { protocol: "bachata-browser-turn-v1", status: "verify", actions: [verify], summary: "Verify", objections: [], unresolved: [] };
  assert.ok(validateBrowserControlEnvelope(original));
  const injected = rejectedProposal(original);
  assert.equal(validateBrowserControlEnvelope(injected), undefined);
  assert.equal(original.actions[0].researchUnknownKey, undefined);
});
