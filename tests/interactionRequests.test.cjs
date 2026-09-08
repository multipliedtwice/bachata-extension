const assert = require("node:assert/strict");
const test = require("node:test");

const {
  checklistStoragePlan,
  interactionContextFrom,
  interactionPayloadHash,
  interactionTimeoutMs,
  responseFromResolution,
  supersededInteractionRefs,
} = require("../dist/conversations/interactionRequests.js");

const request = (overrides = {}) => ({
  sourceKey: "approval:lead:r-1",
  kind: "permission",
  title: "Permission",
  prompt: "May I?",
  options: [{ id: "allow", label: "Allow" }],
  allowFreeText: false,
  secret: false,
  ...overrides,
});

test("a request is the same request while everything the person reads is the same", () => {
  assert.equal(interactionPayloadHash(request()), interactionPayloadHash(request({ title: "Other title", sourceKey: "x" })));
  assert.notEqual(interactionPayloadHash(request()), interactionPayloadHash(request({ prompt: "May I now?" })));
  assert.notEqual(interactionPayloadHash(request()), interactionPayloadHash(request({ secret: true })));
  assert.match(interactionPayloadHash(request()), /^[0-9a-f]{64}$/u);
});

test("the stored context carries the presentation and the payload it identifies", () => {
  assert.deepEqual(interactionContextFrom(request({ fallback: { type: "lead", originAgentId: "lead", title: "t", prompt: "p", options: [], allowFreeText: true } }), "abc"), {
    title: "Permission",
    allowFreeText: false,
    secret: false,
    fallback: { type: "lead", originAgentId: "lead", title: "t", prompt: "p", options: [], allowFreeText: true },
    payloadHash: "abc",
  });
});

test("a request's own timeout wins, and the configured one is never under a second", () => {
  assert.equal(interactionTimeoutMs({ requested: 250, configured: 120_000 }), 250);
  assert.equal(interactionTimeoutMs({ configured: 120_000 }), 120_000);
  assert.equal(interactionTimeoutMs({ configured: 10 }), 1_000);
});

test("open interactions from the same source asking something else are superseded; the same question is reused", () => {
  const open = [
    { interactionRef: "i-1", sourceKey: "approval:lead:r-1", context: { payloadHash: "old" } },
    { interactionRef: "i-2", sourceKey: "approval:lead:r-1#2", context: { payloadHash: "old" } },
    { interactionRef: "i-3", sourceKey: "approval:lead:r-1", context: { payloadHash: "same" } },
    { interactionRef: "i-4", sourceKey: "approval:worker:r-1", context: { payloadHash: "old" } },
    { interactionRef: "i-5", sourceKey: "approval:lead:r-1", context: "not a record" },
    { interactionRef: "i-6" },
  ];
  assert.deepEqual(
    supersededInteractionRefs(open, { sourceKey: "approval:lead:r-1", payloadHash: "same" }),
    ["i-1", "i-2", "i-5"],
  );
});

const items = [{ id: "a", title: "A", details: "d", dependencies: [], paths: ["src/a.ts"] }];

test("a checklist is stored when nothing is stored, in the catalog's shape", () => {
  assert.deepEqual(checklistStoragePlan({ interactionRef: "i-1", stored: [], requested: items }), {
    action: "store",
    items: [{ issueId: "a", title: "A", details: "d", dependencies: [], paths: ["src/a.ts"] }],
  });
});

test("a stored checklist that is the same request is kept; a different one is refused by name", () => {
  const stored = [{ issueId: "a", title: "A", details: "d", dependencies: [], paths: ["src/a.ts"] }];
  assert.deepEqual(checklistStoragePlan({ interactionRef: "i-1", stored, requested: items }), { action: "keep" });
  assert.deepEqual(
    checklistStoragePlan({ interactionRef: "i-9", stored, requested: [{ ...items[0], title: "B" }] }),
    { action: "refuse", message: "Interaction i-9 has a different persisted checklist" },
  );
});

test("a held resolution is read back as strings, text, and the runtime's own source names", () => {
  assert.deepEqual(
    responseFromResolution({ resolution: { selected: ["allow", 7, null], freeText: "ok" }, resolutionSource: "lead" }),
    { selected: ["allow"], freeText: "ok", source: "lead" },
  );
  assert.equal(responseFromResolution({ resolutionSource: "timeout" }).source, "timeout");
  assert.equal(responseFromResolution({ resolutionSource: "cancel" }).source, "cancel");
  assert.equal(responseFromResolution({ resolutionSource: "superseded" }).source, "cancel");
  assert.deepEqual(responseFromResolution({ resolution: "nonsense", resolutionSource: "user" }), {
    selected: [],
    freeText: "",
    source: "user",
  });
  assert.equal(responseFromResolution({}).source, "user");
});
