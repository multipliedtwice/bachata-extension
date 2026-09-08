const assert = require("node:assert/strict");
const test = require("node:test");

const { createRuntimePersistence } = require("../dist/runtime/runtimePersistence.js");

// A harness with no clock and no workspace: every collaborator is a function this test owns, so
// what is asserted is the module's own rules rather than a runtime's behaviour around it.
const harness = (overrides = {}) => {
  const writes = [];
  const log = [];
  const mutations = [];
  const timers = [];
  let snapshot = { value: 0, kept: "yes" };
  const persistence = createRuntimePersistence({
    snapshot: () => snapshot,
    write: async (value) => {
      writes.push(value);
      if (overrides.failWrite && overrides.failWrite(value)) {
        throw new Error(`write refused: ${JSON.stringify(value)}`);
      }
    },
    withMutation: async (operation) => {
      mutations.push("enter");
      try {
        return await operation();
      } finally {
        mutations.push("exit");
      }
    },
    ...(overrides.assertWritable ? { assertWritable: overrides.assertWritable } : {}),
    log: (message) => log.push(message),
    debounceMs: 5,
    setTimer: (callback, delayMs) => {
      const entry = { callback, delayMs, cleared: false };
      timers.push(entry);
      return entry;
    },
    clearTimer: (entry) => {
      entry.cleared = true;
    },
  });
  return {
    persistence,
    writes,
    log,
    mutations,
    timers,
    setSnapshot: (value) => { snapshot = value; },
    fire: (index = timers.length - 1) => timers[index].callback(),
  };
};

test("a written value is read when the write runs and is a copy of it", async () => {
  const h = harness();
  const live = { value: 1, nested: { deep: true } };
  const pending = h.persistence.persistValue(() => live);
  live.value = 2;
  await pending;
  assert.deepEqual(h.writes, [{ value: 2, nested: { deep: true } }], "the value was read when the write was asked for");
  live.nested.deep = false;
  assert.equal(h.writes[0].nested.deep, true, "the written value still points at live state");
  assert.deepEqual(h.mutations, ["enter", "exit"], "the write ran outside the workspace mutation");
});

test("writes are serialised, and a failed write does not cancel the ones behind it", async () => {
  const h = harness({ failWrite: (value) => value.value === 2 });
  const order = [];
  const first = h.persistence.persistValue(() => ({ value: 1 }), () => order.push("after-1"));
  const second = h.persistence.persistValue(() => ({ value: 2 }));
  const third = h.persistence.persistValue(() => ({ value: 3 }), () => order.push("after-3"));
  await first;
  await assert.rejects(second, /write refused/u);
  await third;
  assert.deepEqual(h.writes.map((value) => value.value), [1, 2, 3]);
  assert.deepEqual(order, ["after-1", "after-3"], "a failed write still ran its after-write");
  await h.persistence.drain();
});

test("a patch is merged over the state as it stands when the write runs", async () => {
  const h = harness();
  const patch = { value: 9 };
  const pending = h.persistence.persistPatch(patch);
  patch.value = 10;
  h.setSnapshot({ value: 0, kept: "still here" });
  await pending;
  assert.deepEqual(h.writes, [{ value: 9, kept: "still here" }]);
});

test("an after-write runs only once its write has landed", async () => {
  const h = harness();
  const seen = [];
  await h.persistence.persistPatch({ value: 4 }, () => seen.push(h.writes.length));
  assert.deepEqual(seen, [1]);
});

test("persistNow writes the current state", async () => {
  const h = harness();
  h.setSnapshot({ value: 7, kept: "yes" });
  await h.persistence.persistNow();
  assert.deepEqual(h.writes, [{ value: 7, kept: "yes" }]);
});

test("a scheduled write coalesces, and any explicit write cancels it", async () => {
  const h = harness();
  h.persistence.schedulePersist();
  h.persistence.schedulePersist();
  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[0].cleared, true, "the earlier debounce was left armed");
  assert.equal(h.timers[1].delayMs, 5);

  await h.persistence.persistNow();
  assert.equal(h.timers[1].cleared, true, "an explicit write left a debounce armed behind it");
  assert.equal(h.writes.length, 1);
});

test("a scheduled write runs, and cancelling one stops it", async () => {
  const h = harness();
  h.setSnapshot({ value: 3, kept: "yes" });
  h.persistence.schedulePersist();
  h.fire();
  await h.persistence.drain();
  assert.deepEqual(h.writes, [{ value: 3, kept: "yes" }]);

  h.persistence.schedulePersist();
  h.persistence.cancelScheduledPersist();
  assert.equal(h.timers.at(-1).cleared, true);
  h.persistence.cancelScheduledPersist();
  await h.persistence.drain();
  assert.equal(h.writes.length, 1, "a cancelled debounce wrote anyway");
});

test("a scheduled write that fails is reported and does not escape", async () => {
  const h = harness({ failWrite: () => true });
  h.persistence.schedulePersist();
  h.fire();
  await h.persistence.drain().catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.log.length, 1, JSON.stringify(h.log));
  assert.match(h.log[0], /^Failed to persist runtime state: write refused/u);
});

test("a non-Error failure is still reported as text", async () => {
  const writes = [];
  const log = [];
  const timers = [];
  const persistence = createRuntimePersistence({
    snapshot: () => ({ value: 1 }),
    write: async () => { throw "not an error"; },
    withMutation: (operation) => operation(),
    log: (message) => log.push(message),
    setTimer: (callback, delayMs) => {
      const entry = { callback, delayMs };
      timers.push(entry);
      return entry;
    },
    clearTimer: () => undefined,
  });
  persistence.schedulePersist();
  assert.equal(timers[0].delayMs, 100, "the default debounce is not the runtime's 100ms");
  timers[0].callback();
  await persistence.drain().catch(() => undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["Failed to persist runtime state: not an error"]);
  assert.deepEqual(writes, []);
});

test("a workspace that refuses writes is asked before the queue and again inside it", async () => {
  const asked = [];
  let refuseInside = false;
  const h = harness({
    assertWritable: () => {
      asked.push(refuseInside ? "inside" : "outside");
      if (refuseInside) throw new Error("workspace is read-only");
    },
  });
  const pending = h.persistence.persistValue(() => ({ value: 1 }));
  refuseInside = true;
  await assert.rejects(pending, /workspace is read-only/u);
  assert.deepEqual(asked, ["outside", "inside"]);
  assert.deepEqual(h.writes, [], "a refused write reached the workspace anyway");

  refuseInside = true;
  assert.throws(() => h.persistence.persistValue(() => ({ value: 2 })), /workspace is read-only/u);
});

test("draining settles once the queued writes have finished", async () => {
  const h = harness({ failWrite: (value) => value.value === 2 });
  h.persistence.persistValue(() => ({ value: 1 })).catch(() => undefined);
  h.persistence.persistValue(() => ({ value: 2 })).catch(() => undefined);
  await h.persistence.drain();
  assert.deepEqual(h.writes.map((value) => value.value), [1, 2]);
});

test("with no clock supplied it uses the real one, and cancelling clears it", async () => {
  const writes = [];
  const persistence = createRuntimePersistence({
    snapshot: () => ({ value: 5 }),
    write: async (value) => { writes.push(value); },
    withMutation: (operation) => operation(),
    log: () => undefined,
    debounceMs: 1,
  });
  persistence.schedulePersist();
  persistence.cancelScheduledPersist();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(writes, [], "a cancelled real timer wrote anyway");

  persistence.schedulePersist();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await persistence.drain();
  assert.deepEqual(writes, [{ value: 5 }]);
});
