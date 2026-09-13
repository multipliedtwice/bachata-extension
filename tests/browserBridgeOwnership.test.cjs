const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const {
  createResourceBroker,
  ResourceAcquireCancelledError,
  ResourceAcquireTimeoutError,
  ResourceQuarantinedError,
} = require("../dist/concurrency/resourceBroker.js");

const bridgeKey = "browser-bridge:profile";
const endpoint = "ws://127.0.0.1:43127/bachata-browser-bridge-v9";

const setup = async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bachata-bridge-ownership-"));
  const databasePath = path.join(root, "resources.sqlite");
  const brokers = [];
  t.after(async () => {
    await Promise.allSettled(brokers.map((broker) => broker.dispose()));
    await rm(root, { recursive: true, force: true });
  });
  const open = (ownerId, options = {}) => {
    const value = createResourceBroker({
      databasePath,
      ownerId,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 50,
      staleOwnerMs: 500,
      ...options,
    });
    brokers.push(value);
    return value;
  };
  const query = (operation) => {
    const database = new DatabaseSync(databasePath);
    try {
      return operation(database);
    } finally {
      database.close();
    }
  };
  const seed = (...keys) => query((database) => {
    for (const key of keys) {
      database.prepare(`
        INSERT INTO resource_quarantine(resource_key, reason, quarantined_at, owner_id)
        VALUES (?, 'Previous cleanup was interrupted', ?, 'previous-window')
      `).run(key, Date.now());
    }
  });
  return { root, databasePath, open, query, seed };
};

const acquire = (broker, options = {}) => broker.acquireBrowserBridge({
  endpoint,
  deadlineAt: Date.now() + 1000,
  isEndpointReserved: () => true,
  ...options,
});

test("Bridge acquisition automatically heals only its stale quarantine and publishes ownership atomically", async (t) => {
  const fixture = await setup(t);
  const owner = fixture.open("activation");
  fixture.seed(bridgeKey, "local-agents:global", "working-directory:other");
  assert.deepEqual(owner.inspectBrowserBridgeOwnership(), { held: false, quarantined: true });
  const lease = await acquire(owner);
  assert.equal(lease.isValid(), true);
  assert.equal(lease.fences[bridgeKey], 1);
  const ownership = owner.inspectBrowserBridgeOwnership();
  assert.equal(ownership.held, true);
  assert.equal(ownership.quarantined, false);
  assert.equal(ownership.endpoint, endpoint);
  assert.equal(typeof ownership.heartbeatAt, "number");
  assert.deepEqual(owner.listQuarantine().map((item) => item.key).sort(), ["local-agents:global", "working-directory:other"]);
  await lease.release();
  assert.deepEqual(owner.inspectBrowserBridgeOwnership(), { held: false, quarantined: false, endpoint });
});

test("ordinary resource acquisition cannot bypass Bridge quarantine", async (t) => {
  const fixture = await setup(t);
  const owner = fixture.open("ordinary");
  fixture.seed(bridgeKey);
  await assert.rejects(owner.acquire({
    resources: [{ key: bridgeKey, kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  }), ResourceQuarantinedError);
  assert.equal(owner.inspectBrowserBridgeOwnership().quarantined, true);
});

for (const [label, guard] of [["failed", () => false], ["asynchronous", () => Promise.resolve(true)]]) {
  test(`Bridge recovery refuses ${label} endpoint reservation proof`, async (t) => {
    const fixture = await setup(t);
    const owner = fixture.open("unreserved");
    fixture.seed(bridgeKey);
    await assert.rejects(acquire(owner, { isEndpointReserved: guard }), ResourceAcquireCancelledError);
    assert.deepEqual(owner.inspectBrowserBridgeOwnership(), { held: false, quarantined: true });
    fixture.query((database) => {
      assert.equal(database.prepare("SELECT count(*) AS count FROM resource_request").get().count, 0);
      assert.equal(database.prepare("SELECT count(*) AS count FROM resource_fence").get().count, 0);
    });
  });
}

test("Bridge recovery preserves a live lease even when quarantine also exists", async (t) => {
  const fixture = await setup(t);
  const first = fixture.open("live");
  const second = fixture.open("waiting");
  const held = await acquire(first);
  fixture.seed(bridgeKey);
  let guardCalls = 0;
  await assert.rejects(acquire(second, {
    deadlineAt: Date.now() + 80,
    isEndpointReserved: () => { guardCalls += 1; return true; },
  }), ResourceAcquireTimeoutError);
  assert.equal(guardCalls, 0);
  assert.equal(held.isValid(), true);
  assert.equal(second.inspectBrowserBridgeOwnership().quarantined, true);
  assert.equal(second.inspectBrowserBridgeOwnership().held, true);
  await held.release();
});

test("Bridge inspection treats an orphaned persisted lease as held until normal maintenance resolves it", async (t) => {
  const fixture = await setup(t);
  const first = fixture.open("orphan", { heartbeatIntervalMs: 10_000 });
  const second = fixture.open("observer", { heartbeatIntervalMs: 10_000 });
  const held = await acquire(first);
  fixture.query((database) => database.prepare("DELETE FROM resource_owner WHERE owner_id = ?").run("orphan"));
  assert.deepEqual(second.inspectBrowserBridgeOwnership(), { held: true, quarantined: false, endpoint });
  await held.release();
});

test("changing ports requires exclusive reservation of the previous endpoint as well", async (t) => {
  const fixture = await setup(t);
  const owner = fixture.open("port-change");
  const first = await acquire(owner);
  await first.quarantine("Server closure was not confirmed");
  const nextEndpoint = "ws://127.0.0.1:43128/bachata-browser-bridge-v9";
  const inspected = [];
  await assert.rejects(acquire(owner, {
    endpoint: nextEndpoint,
    isEndpointReserved: (value) => { inspected.push(value); return value === nextEndpoint; },
  }), ResourceAcquireCancelledError);
  assert.deepEqual(inspected, [nextEndpoint, endpoint]);
  assert.deepEqual(owner.inspectBrowserBridgeOwnership(), { held: false, quarantined: true, endpoint });
  const second = await acquire(owner, { endpoint: nextEndpoint });
  assert.ok(second.fences[bridgeKey] > first.fences[bridgeKey]);
  assert.equal(owner.inspectBrowserBridgeOwnership().endpoint, nextEndpoint);
  await second.release();
});

test("lease insertion failure rolls back quarantine removal, endpoint update, and fencing", async (t) => {
  const fixture = await setup(t);
  const owner = fixture.open("rollback");
  const initial = await acquire(owner);
  await initial.quarantine("Startup cleanup is unconfirmed");
  fixture.query((database) => database.exec(`
    CREATE TRIGGER refuse_bridge_lease BEFORE INSERT ON resource_lease_item
    WHEN NEW.resource_key = 'browser-bridge:profile'
    BEGIN SELECT RAISE(ABORT, 'Injected lease insertion failure'); END;
  `));
  await assert.rejects(acquire(owner, { endpoint: "ws://127.0.0.1:43128/bachata-browser-bridge-v9" }), /Injected lease insertion failure/u);
  assert.deepEqual(owner.inspectBrowserBridgeOwnership(), { held: false, quarantined: true, endpoint });
  fixture.query((database) => {
    assert.equal(database.prepare("SELECT count(*) AS count FROM resource_lease").get().count, 0);
    assert.equal(database.prepare("SELECT count(*) AS count FROM resource_request").get().count, 0);
    assert.equal(database.prepare("SELECT token FROM resource_fence WHERE resource_key = ?").get(bridgeKey).token, initial.fences[bridgeKey]);
    database.exec("DROP TRIGGER refuse_bridge_lease");
  });
  const recovered = await acquire(owner);
  assert.equal(recovered.fences[bridgeKey], initial.fences[bridgeKey] + 1);
  await recovered.release();
});

test("Bridge recovery continues after broker reload and an interrupted ownership cleanup", async (t) => {
  const fixture = await setup(t);
  const first = fixture.open("before-reload");
  const previous = await acquire(first);
  await first.dispose();
  const second = fixture.open("after-reload");
  assert.equal(second.inspectBrowserBridgeOwnership().quarantined, true);
  const recovered = await acquire(second);
  assert.ok(recovered.fences[bridgeKey] > previous.fences[bridgeKey]);
  await recovered.quarantine("Startup cleanup is unconfirmed");
  const retry = await acquire(second);
  assert.ok(retry.fences[bridgeKey] > recovered.fences[bridgeKey]);
  await retry.release();
});

test("Bridge recovery keeps FIFO order with existing resource requests", async (t) => {
  const fixture = await setup(t);
  const owner = fixture.open("holder");
  const earlier = fixture.open("earlier");
  const later = fixture.open("later");
  const held = await acquire(owner);
  const firstWaiting = earlier.acquire({
    resources: [{ key: bridgeKey, kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  });
  const secondWaiting = acquire(later);
  await held.release();
  const first = await firstWaiting;
  assert.equal(first.isValid(), true);
  assert.equal(fixture.query((database) => database.prepare("SELECT owner_id FROM resource_lease").get().owner_id), "earlier");
  await first.release();
  const second = await secondWaiting;
  assert.ok(second.fences[bridgeKey] > first.fences[bridgeKey]);
  await second.release();
});

test("concurrent windows recover one Bridge owner and preserve fencing across handoff", { timeout: 20_000 }, async (t) => {
  const fixture = await setup(t);
  const initializer = fixture.open("initializer");
  fixture.seed(bridgeKey, "local-agents:global");
  await initializer.dispose();
  const modulePath = path.resolve(__dirname, "../dist/concurrency/resourceBroker.js");
  const source = `
    const { createResourceBroker } = require(${JSON.stringify(modulePath)});
    const broker = createResourceBroker({ databasePath: process.argv[1], pollIntervalMs: 10 });
    process.on('message', async (command) => {
      if (command !== 'acquire') return;
      try {
        const lease = await broker.acquireBrowserBridge({
          endpoint: 'ws://127.0.0.1:43127/bachata-browser-bridge-v9',
          deadlineAt: Date.now() + 10_000,
          isEndpointReserved: () => true,
        });
        process.send({ type: 'acquired', fence: lease.fences['browser-bridge:profile'] });
        process.once('message', async () => {
          await lease.release();
          await broker.dispose();
          process.disconnect();
        });
      } catch (error) {
        process.send({ type: 'failed', message: error.message });
        await broker.dispose();
        process.disconnect();
      }
    });
    process.send({ type: 'ready' });
  `;
  const children = Array.from({ length: 2 }, () => {
    const child = spawn(process.execPath, ["-e", source, fixture.databasePath], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = "";
    child.stderr.on("data", (value) => { stderr += String(value); });
    const ready = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.on("message", (message) => { if (message.type === "ready") resolve(); });
    });
    const acquired = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.on("message", (message) => {
        if (message.type === "acquired") resolve({ child, fence: message.fence });
        if (message.type === "failed") reject(new Error(message.message));
      });
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `Child exited ${String(code)}`)));
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    return { child, ready, acquired, exited };
  });
  await Promise.all(children.map((entry) => entry.ready));
  children.forEach((entry) => entry.child.send("acquire"));
  const first = await Promise.race(children.map((entry) => entry.acquired));
  fixture.query((database) => {
    assert.equal(database.prepare("SELECT count(*) AS count FROM resource_lease_item WHERE resource_key = ?").get(bridgeKey).count, 1);
    assert.deepEqual(database.prepare("SELECT resource_key FROM resource_quarantine").all().map((row) => row.resource_key), ["local-agents:global"]);
  });
  first.child.send("release");
  const second = await children.find((entry) => entry.child !== first.child).acquired;
  assert.ok(second.fence > first.fence);
  second.child.send("release");
  await Promise.all(children.map((entry) => entry.exited));
});
