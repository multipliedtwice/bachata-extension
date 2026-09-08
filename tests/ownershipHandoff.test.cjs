const assert = require("node:assert/strict");
const test = require("node:test");

const { ownershipReport } = require("../dist/concurrency/ownershipHandoff.js");

test("an owning window can release only when no work is active", () => {
  const idle = ownershipReport({
    owned: true,
    holderHeld: true,
    staleOwnerMs: 15_000,
    activeWork: [],
  });
  assert.match(idle.title, /This window owns/u);
  assert.deepEqual(idle.actions.map((action) => action.id), ["release"]);

  const busy = ownershipReport({
    owned: true,
    holderHeld: true,
    staleOwnerMs: 15_000,
    activeWork: ["a TODO orchestration run is executing"],
  });
  assert.deepEqual(busy.actions, []);
  assert.match(busy.detail, /cannot be released while work is active/u);
});

test("a live owner is never taken over, only asked for", () => {
  const report = ownershipReport({
    owned: false,
    blockedReason: "This workspace is already controlled by another Bachata Extension Host",
    holderHeld: true,
    holderHeartbeatAgeMs: 3_000,
    staleOwnerMs: 15_000,
    activeWork: [],
  });
  assert.deepEqual(report.actions.map((action) => action.id), ["retry", "reload"]);
  assert.match(report.detail, /reported 3s ago and is still alive/u);
  assert.match(report.detail, /never takes a live lease away/u);
});

test("a stale owner is reported as reclaimable", () => {
  const report = ownershipReport({
    owned: false,
    holderHeld: true,
    holderHeartbeatAgeMs: 40_000,
    staleOwnerMs: 15_000,
    activeWork: [],
  });
  assert.match(report.detail, /past the 15s stale threshold/u);
  assert.match(report.detail, /reclaimable/u);
});

test("no holder at all is reported plainly", () => {
  const report = ownershipReport({
    owned: false,
    holderHeld: false,
    staleOwnerMs: 15_000,
    activeWork: [],
  });
  assert.match(report.detail, /No other window is holding the lease/u);
});
