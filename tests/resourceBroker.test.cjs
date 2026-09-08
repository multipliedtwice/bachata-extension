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
  ResourceCapacityExceededError,
  ResourceLeaseLostError,
  ResourceQuarantinedError,
} = require("../dist/concurrency/resourceBroker.js");
const { repositoryExecutionClaims } = require("../dist/concurrency/repositoryResources.js");

const tempDatabase = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bachata-resource-broker-"));
  return { root, databasePath: path.join(root, "resources.sqlite") };
};

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const broker = (databasePath, ownerId, options = {}) => createResourceBroker({
  databasePath,
  ownerId,
  pollIntervalMs: 10,
  heartbeatIntervalMs: 50,
  staleOwnerMs: 500,
  ...options,
});

test("resource broker serializes the same exclusive resource across instances", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "first");
  const second = broker(temporary.databasePath, "second");
  const lease = await first.acquire({
    resources: [{ key: "database:test", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  });
  let acquired = false;
  const waiting = second.acquire({
    resources: [{ key: "database:test", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  }).then((value) => {
    acquired = true;
    return value;
  });
  await wait(80);
  assert.equal(acquired, false);
  await lease.release();
  const next = await waiting;
  assert.equal(acquired, true);
  await next.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("resource broker supports bounded capacity", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "first");
  const second = broker(temporary.databasePath, "second");
  const third = broker(temporary.databasePath, "third");
  const claims = [{ key: "bachata-runs:global", capacity: 2 }];
  const lease1 = await first.acquire({ resources: claims, deadlineAt: Date.now() + 1000 });
  const lease2 = await second.acquire({ resources: claims, deadlineAt: Date.now() + 1000 });
  await assert.rejects(
    third.acquire({ resources: claims, deadlineAt: Date.now() + 80 }),
    ResourceAcquireTimeoutError,
  );
  await Promise.all([lease1.release(), lease2.release()]);
  await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("queued higher capacity becomes available when the lower-capacity lease leaves", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "capacity-lower");
  const second = broker(temporary.databasePath, "capacity-higher");
  const held = await first.acquire({
    resources: [{ key: "capacity:transition", capacity: 1 }],
    deadlineAt: Date.now() + 1000,
  });
  const waiting = second.acquire({
    resources: [{ key: "capacity:transition", units: 2, capacity: 2 }],
    deadlineAt: Date.now() + 1000,
  });
  await wait(40);
  await held.release();
  const acquired = await waiting;
  assert.equal(acquired.resources[0].units, 2);
  assert.equal(acquired.resources[0].capacity, 2);
  await acquired.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("later lower-capacity requests do not block earlier higher-capacity requests", async () => {
  const temporary = await tempDatabase();
  const blocker = broker(temporary.databasePath, "capacity-blocker");
  const earlier = broker(temporary.databasePath, "capacity-earlier");
  const later = broker(temporary.databasePath, "capacity-later");
  const held = await blocker.acquire({
    resources: [{ key: "capacity:queue-order", capacity: 1 }],
    deadlineAt: Date.now() + 1000,
  });
  const earlierWaiting = earlier.acquire({
    resources: [{ key: "capacity:queue-order", units: 2, capacity: 2 }],
    deadlineAt: Date.now() + 1000,
  });
  await wait(30);
  const laterWaiting = later.acquire({
    resources: [{ key: "capacity:queue-order", capacity: 1 }],
    deadlineAt: Date.now() + 1000,
  });
  await wait(30);
  await held.release();
  const earlierLease = await earlierWaiting;
  assert.equal(earlierLease.resources[0].units, 2);
  let laterAcquired = false;
  const observedLater = laterWaiting.then((lease) => {
    laterAcquired = true;
    return lease;
  });
  await wait(30);
  assert.equal(laterAcquired, false);
  await earlierLease.release();
  const laterLease = await observedLater;
  await laterLease.release();
  await Promise.all([blocker.dispose(), earlier.dispose(), later.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("resource broker rejects claims that exceed their configured capacity", async () => {
  const temporary = await tempDatabase();
  const value = broker(temporary.databasePath, "capacity-limit");
  await assert.rejects(
    value.acquire({
      resources: [{ key: "capacity:hard-limit", units: 3, capacity: 2 }],
      deadlineAt: Date.now() + 1000,
    }),
    ResourceCapacityExceededError,
  );
  await value.dispose();
  await rm(temporary.root, { recursive: true, force: true });
});

test("resource capacity can increase after every prior request and lease has settled", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "first");
  const second = broker(temporary.databasePath, "second");
  const third = broker(temporary.databasePath, "third");
  const initial = await first.acquire({
    resources: [{ key: "capacity:reset", capacity: 1 }],
    deadlineAt: Date.now() + 1000,
  });
  await initial.release();
  const [one, two] = await Promise.all([
    second.acquire({
      resources: [{ key: "capacity:reset", capacity: 2 }],
      deadlineAt: Date.now() + 1000,
    }),
    third.acquire({
      resources: [{ key: "capacity:reset", capacity: 2 }],
      deadlineAt: Date.now() + 1000,
    }),
  ]);
  await Promise.all([one.release(), two.release()]);
  await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("managed worktrees share repository capacity while ordinary sessions remain exclusive", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "first");
  const second = broker(temporary.databasePath, "second");
  const third = broker(temporary.databasePath, "third");
  const identity = {
    canonicalWorkingDirectory: "/repository",
    repositoryIdentity: "/repository/.git",
    repositoryRoot: "/repository",
  };
  const managed = (workingDirectory) => repositoryExecutionClaims(
    { ...identity, canonicalWorkingDirectory: workingDirectory },
    { managedTask: true, repositoryCapacity: 2 },
  );
  const ordinary = repositoryExecutionClaims(identity, {
    managedTask: false,
    repositoryCapacity: 2,
  });
  const firstLease = await first.acquire({
    resources: managed("/repository/.bachata/task-a"),
    deadlineAt: Date.now() + 1000,
  });
  const secondLease = await second.acquire({
    resources: managed("/repository/.bachata/task-b"),
    deadlineAt: Date.now() + 1000,
  });
  await assert.rejects(
    third.acquire({ resources: ordinary, deadlineAt: Date.now() + 80 }),
    ResourceAcquireTimeoutError,
  );
  await Promise.all([firstLease.release(), secondLease.release()]);
  const ordinaryLease = await third.acquire({
    resources: ordinary,
    deadlineAt: Date.now() + 1000,
  });
  await ordinaryLease.release();
  await Promise.all([first.dispose(), second.dispose(), third.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("resource broker acquires multiple resources atomically", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "first");
  const second = broker(temporary.databasePath, "second");
  const databaseLease = await first.acquire({
    resources: [{ key: "database:test", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  });
  await assert.rejects(
    second.acquire({
      resources: [
        { key: "database:test", kind: "physical" },
        { key: "port:4173", kind: "physical" },
      ],
      deadlineAt: Date.now() + 80,
    }),
    ResourceAcquireTimeoutError,
  );
  const portLease = await first.acquire({
    resources: [{ key: "port:4173", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  });
  await portLease.release();
  await databaseLease.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("resource broker cancels a queued request exactly once", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "first");
  const second = broker(temporary.databasePath, "second");
  const lease = await first.acquire({
    resources: [{ key: "checks:global" }],
    deadlineAt: Date.now() + 1000,
  });
  const controller = new AbortController();
  const waiting = second.acquire({
    resources: [{ key: "checks:global" }],
    deadlineAt: Date.now() + 1000,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(waiting, ResourceAcquireCancelledError);
  await lease.release();
  const next = await second.acquire({
    resources: [{ key: "checks:global" }],
    deadlineAt: Date.now() + 1000,
  });
  await next.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("resource broker preserves FIFO order for overlapping requests", async () => {
  const temporary = await tempDatabase();
  const holder = broker(temporary.databasePath, "holder");
  const first = broker(temporary.databasePath, "first");
  const second = broker(temporary.databasePath, "second");
  const held = await holder.acquire({
    resources: [{ key: "database:test", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  });
  const order = [];
  const firstWaiter = first.acquire({
    resources: [{ key: "database:test", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  }).then(async (lease) => {
    order.push("first");
    await wait(30);
    await lease.release();
  });
  await wait(15);
  const secondWaiter = second.acquire({
    resources: [{ key: "database:test", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  }).then(async (lease) => {
    order.push("second");
    await lease.release();
  });
  await held.release();
  await Promise.all([firstWaiter, secondWaiter]);
  assert.deepEqual(order, ["first", "second"]);
  await Promise.all([holder.dispose(), first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("quarantine blocks physical resources until explicitly cleared", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "first");
  const second = broker(temporary.databasePath, "second");
  const lease = await first.acquire({
    resources: [{ key: "database:test", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  });
  await lease.quarantine("cleanup failed");
  await assert.rejects(
    second.acquire({
      resources: [{ key: "database:test", kind: "physical" }],
      deadlineAt: Date.now() + 1000,
    }),
    ResourceQuarantinedError,
  );
  assert.equal(second.listQuarantine().length, 1);
  assert.equal(second.clearQuarantine(["database:test"]), 1);
  const next = await second.acquire({
    resources: [{ key: "database:test", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  });
  await next.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("disposing an owner quarantines physical leases and releases abstract capacity", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "first");
  const second = broker(temporary.databasePath, "second");
  await first.acquire({
    resources: [
      { key: "repository:test", kind: "physical" },
      { key: "bachata-runs:global", capacity: 1 },
    ],
    deadlineAt: Date.now() + 1000,
  });
  await first.dispose();
  const abstractLease = await second.acquire({
    resources: [{ key: "bachata-runs:global", capacity: 1 }],
    deadlineAt: Date.now() + 1000,
  });
  await abstractLease.release();
  await assert.rejects(
    second.acquire({
      resources: [{ key: "repository:test", kind: "physical" }],
      deadlineAt: Date.now() + 1000,
    }),
    ResourceQuarantinedError,
  );
  await second.dispose();
  await rm(temporary.root, { recursive: true, force: true });
});

test("orphaned leases without an owner heartbeat are quarantined", async () => {
  const temporary = await tempDatabase();
  const first = broker(temporary.databasePath, "first", {
    heartbeatIntervalMs: 10_000,
    staleOwnerMs: 30_000,
  });
  const second = broker(temporary.databasePath, "second");
  const lease = await first.acquire({
    resources: [{ key: "repository:orphan", kind: "physical" }],
    deadlineAt: Date.now() + 1000,
  });
  const database = new DatabaseSync(temporary.databasePath);
  database.prepare("DELETE FROM resource_owner WHERE owner_id = ?").run("first");
  database.close();
  await assert.rejects(
    second.acquire({
      resources: [{ key: "repository:orphan", kind: "physical" }],
      deadlineAt: Date.now() + 1000,
    }),
    ResourceQuarantinedError,
  );
  assert.equal(second.listQuarantine().some((item) => item.key === "repository:orphan"), true);
  await lease.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("a replaced owner invalidates its local lease and advances the resource fence after startup grace", async () => {
  const temporary = await tempDatabase();
  let wallClock = 1_000;
  let firstMonotonic = 0;
  let secondMonotonic = 0;
  const first = broker(temporary.databasePath, "paused-owner", {
    now: () => wallClock,
    monotonicNow: () => firstMonotonic,
    heartbeatIntervalMs: 10_000,
    staleOwnerMs: 20_000,
  });
  const held = await first.acquire({
    resources: [{ key: "workspace:replace", capacity: 1 }],
    deadlineAt: wallClock + 1_000,
  });
  const firstFence = held.fences["workspace:replace"];
  wallClock += 25_000;
  const second = broker(temporary.databasePath, "live-owner", {
    now: () => wallClock,
    monotonicNow: () => secondMonotonic,
    heartbeatIntervalMs: 10_000,
    staleOwnerMs: 20_000,
  });
  assert.doesNotThrow(() => held.assertValid());
  for (let step = 1; step <= 4; step += 1) {
    wallClock += 5_000;
    secondMonotonic += 5_000;
    const probe = await second.acquire({
      resources: [{ key: `probe:replacement-grace:${String(step)}` }],
      deadlineAt: wallClock + 1_000,
    });
    await probe.release();
  }
  const replacement = await second.acquire({
    resources: [{ key: "workspace:replace", capacity: 1 }],
    deadlineAt: wallClock + 1_000,
  });
  assert.ok(replacement.fences["workspace:replace"] > firstFence);
  assert.equal(held.isValid(), false);
  assert.equal(held.signal.aborted, true);
  assert.throws(() => held.assertValid(), ResourceLeaseLostError);
  await replacement.release();
  await held.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("separate Node processes cannot overbook one resource", async () => {
  const temporary = await tempDatabase();
  const modulePath = path.resolve(__dirname, "../dist/concurrency/resourceBroker.js");
  const childSource = `
    const { createResourceBroker } = require(${JSON.stringify(modulePath)});
    const broker = createResourceBroker({ databasePath: process.argv[1], ownerId: process.argv[2], pollIntervalMs: 10 });
    (async () => {
      const lease = await broker.acquire({ resources: [{ key: 'cross-process', kind: 'physical' }], deadlineAt: Date.now() + 3000 });
      process.stdout.write('acquired\\n');
      await new Promise((resolve) => setTimeout(resolve, Number(process.argv[3])));
      await lease.release();
      await broker.dispose();
    })().catch((error) => { console.error(error); process.exit(1); });
  `;
  const start = (owner, hold) => {
    const child = spawn(process.execPath, ["-e", childSource, temporary.databasePath, owner, String(hold)], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${owner} ${code}`)));
    });
    return { child, exited };
  };
  const first = start("first", 180);
  await new Promise((resolve, reject) => {
    first.child.stdout.once("data", resolve);
    first.child.once("error", reject);
  });
  const startedAt = Date.now();
  const second = start("second", 0);
  await new Promise((resolve, reject) => {
    second.child.stdout.once("data", resolve);
    second.child.once("error", reject);
  });
  assert.ok(Date.now() - startedAt >= 120);
  await Promise.all([first.exited, second.exited]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("resource broker survives a long local suspension without expiring its own leases", async () => {
  const temporary = await tempDatabase();
  let wallClock = 1_000;
  let monotonicOffset = 0;
  const monotonicNow = () => Date.now() + monotonicOffset;
  const first = broker(temporary.databasePath, "suspended-owner", {
    now: () => wallClock,
    monotonicNow,
    heartbeatIntervalMs: 10_000,
    staleOwnerMs: 500,
  });
  const held = await first.acquire({
    resources: [
      { key: "repository:suspend", kind: "physical" },
      { key: "capacity:suspend", capacity: 1 },
    ],
    deadlineAt: wallClock + 1_000,
  });

  wallClock += 10_000;
  monotonicOffset += 10_000;
  const probe = await first.acquire({
    resources: [{ key: "probe:suspend" }],
    deadlineAt: wallClock + 1_000,
  });
  await probe.release();

  const second = broker(temporary.databasePath, "observer", {
    now: () => wallClock,
    monotonicNow,
    heartbeatIntervalMs: 10_000,
    staleOwnerMs: 500,
  });
  await assert.rejects(
    second.acquire({
      resources: [{ key: "capacity:suspend", capacity: 1 }],
      deadlineAt: wallClock + 80,
    }),
    ResourceAcquireTimeoutError,
  );
  assert.equal(second.listQuarantine().some((item) => item.key === "repository:suspend"), false);

  await held.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("a broker opened after wake gives a live pre-sleep owner time to heartbeat", async () => {
  const temporary = await tempDatabase();
  let wallClock = 1_000;
  let firstMonotonic = 0;
  let secondMonotonic = 0;
  const first = broker(temporary.databasePath, "pre-sleep-owner", {
    now: () => wallClock,
    monotonicNow: () => firstMonotonic,
    heartbeatIntervalMs: 50,
    staleOwnerMs: 500,
  });
  const held = await first.acquire({
    resources: [{ key: "repository:post-wake", kind: "physical" }],
    deadlineAt: wallClock + 1_000,
  });

  wallClock += 10_000;
  firstMonotonic += 10_000;
  const second = broker(temporary.databasePath, "post-wake-observer", {
    now: () => wallClock,
    monotonicNow: () => secondMonotonic,
    heartbeatIntervalMs: 50,
    staleOwnerMs: 500,
  });
  assert.doesNotThrow(() => held.assertValid());
  assert.equal(second.listQuarantine().some((item) => item.key === "repository:post-wake"), false);

  const resumed = await first.acquire({
    resources: [{ key: "probe:post-wake-owner" }],
    deadlineAt: wallClock + 1_000,
  });
  await resumed.release();
  secondMonotonic += 600;
  const probe = await second.acquire({
    resources: [{ key: "probe:post-wake-observer" }],
    deadlineAt: wallClock + 1_000,
  });
  await probe.release();

  assert.doesNotThrow(() => held.assertValid());
  assert.equal(second.listQuarantine().some((item) => item.key === "repository:post-wake"), false);
  await held.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("a newly opened broker removes a truly stale owner after startup grace", async () => {
  const temporary = await tempDatabase();
  const bootstrap = broker(temporary.databasePath, "bootstrap");
  await bootstrap.dispose();
  const database = new DatabaseSync(temporary.databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  database.prepare("INSERT INTO resource_owner(owner_id, heartbeat_at) VALUES (?, ?)")
    .run("crashed-before-wake", 1_000);
  database.prepare("INSERT INTO resource_lease(lease_id, owner_id, acquired_at) VALUES (?, ?, ?)")
    .run("stale-lease", "crashed-before-wake", 1_000);
  database.prepare("INSERT INTO resource_fence(resource_key, token) VALUES (?, ?)")
    .run("repository:stale-after-wake", 1);
  database.prepare(`
    INSERT INTO resource_lease_item(lease_id, resource_key, units, capacity, kind, fence_token)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("stale-lease", "repository:stale-after-wake", 1, 1, "physical", 1);
  database.close();

  let wallClock = 10_000;
  let monotonic = 0;
  const observer = broker(temporary.databasePath, "post-wake-cleaner", {
    now: () => wallClock,
    monotonicNow: () => monotonic,
    heartbeatIntervalMs: 50,
    staleOwnerMs: 500,
  });
  assert.equal(observer.listQuarantine().some((item) => item.key === "repository:stale-after-wake"), false);

  for (let step = 1; step <= 5; step += 1) {
    wallClock += 100;
    monotonic += 100;
    const probe = await observer.acquire({
      resources: [{ key: `probe:stale-cleanup:${String(step)}` }],
      deadlineAt: wallClock + 1_000,
    });
    await probe.release();
  }
  assert.equal(observer.listQuarantine().some((item) => item.key === "repository:stale-after-wake"), true);

  await observer.dispose();
  await rm(temporary.root, { recursive: true, force: true });
});

test("a forward wall-clock jump does not expire another live owner immediately", async () => {
  const temporary = await tempDatabase();
  let wallClock = 1_000;
  let monotonicOffset = 1_000 - Date.now();
  const options = {
    now: () => wallClock,
    monotonicNow: () => Date.now() + monotonicOffset,
    heartbeatIntervalMs: 10_000,
    staleOwnerMs: 500,
  };
  const first = broker(temporary.databasePath, "clock-forward-first", options);
  const second = broker(temporary.databasePath, "clock-forward-second", options);
  const held = await second.acquire({
    resources: [{ key: "clock:forward", kind: "physical" }],
    deadlineAt: wallClock + 1_000,
  });

  wallClock += 60_000;
  monotonicOffset += 10;
  const probe = await first.acquire({
    resources: [{ key: "clock:forward-probe" }],
    deadlineAt: wallClock + 1_000,
  });
  await probe.release();

  monotonicOffset += 10;
  await assert.rejects(
    first.acquire({
      resources: [{ key: "clock:forward", kind: "physical" }],
      deadlineAt: wallClock + 80,
    }),
    ResourceAcquireTimeoutError,
  );
  assert.equal(first.listQuarantine().some((item) => item.key === "clock:forward"), false);

  await held.release();
  await Promise.all([first.dispose(), second.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("resource acquisition keeps its original duration when the wall clock moves backward", async () => {
  const temporary = await tempDatabase();
  let wallClock = 10_000;
  const holder = broker(temporary.databasePath, "clock-holder", {
    now: () => wallClock,
  });
  const waiter = broker(temporary.databasePath, "clock-waiter", {
    now: () => wallClock,
  });
  const held = await holder.acquire({
    resources: [{ key: "clock:test" }],
    deadlineAt: wallClock + 1_000,
  });
  const startedAt = Date.now();
  const waiting = waiter.acquire({
    resources: [{ key: "clock:test" }],
    deadlineAt: wallClock + 90,
  });
  wallClock -= 60_000;
  await assert.rejects(waiting, ResourceAcquireTimeoutError);
  assert.ok(Date.now() - startedAt < 500);
  await held.release();
  await Promise.all([holder.dispose(), waiter.dispose()]);
  await rm(temporary.root, { recursive: true, force: true });
});

test("resource broker initialization is retry-safe across simultaneous fresh processes", async () => {
  const temporary = await tempDatabase();
  const modulePath = path.resolve(__dirname, "../dist/concurrency/resourceBroker.js");
  const childSource = `
    const { createResourceBroker } = require(${JSON.stringify(modulePath)});
    try {
      const broker = createResourceBroker({ databasePath: process.argv[1], ownerId: process.argv[2] });
      broker.dispose().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  `;
  const start = (owner) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", childSource, temporary.databasePath, owner], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve()
      : reject(new Error(`${owner} exited ${String(code)}: ${stderr}`)));
  });
  await Promise.all(Array.from({ length: 6 }, (_, index) => start(`starter-${String(index)}`)));
  await rm(temporary.root, { recursive: true, force: true });
});

test("a queued acquisition cannot escape disposal or race the closed database", async () => {
  const temporary = await tempDatabase();
  const holder = broker(temporary.databasePath, "holder");
  const disposing = broker(temporary.databasePath, "disposing");
  const held = await holder.acquire({
    resources: [{ key: "database:race", kind: "physical" }],
    deadlineAt: Date.now() + 5_000,
  });
  const queued = disposing.acquire({
    resources: [{ key: "database:race", kind: "physical" }],
    deadlineAt: Date.now() + 5_000,
  });
  const settled = queued.then(
    (lease) => ({ granted: true, lease }),
    (error) => ({ granted: false, error }),
  );
  await wait(30);
  const disposal = disposing.dispose();
  await held.release();
  const outcome = await settled;
  await disposal.catch(() => undefined);
  assert.equal(outcome.granted, false, "a lease was granted after the broker was disposed");
  assert.match(String(outcome.error?.message ?? ""), /disposed/u);

  const database = new DatabaseSync(temporary.databasePath);
  try {
    const rows = database.prepare("SELECT COUNT(*) AS total FROM resource_request WHERE owner_id = ?")
      .all("disposing");
    assert.equal(rows[0].total, 0, "the disposed owner left a pending request behind");
    const leases = database.prepare("SELECT COUNT(*) AS total FROM resource_lease WHERE owner_id = ?")
      .all("disposing");
    assert.equal(leases[0].total, 0, "the disposed owner left a lease behind");
  } finally {
    database.close();
  }
  await holder.dispose().catch(() => undefined);
  await rm(temporary.root, { recursive: true, force: true });
});

test("acquiring from a disposed broker is refused outright", async () => {
  const temporary = await tempDatabase();
  const instance = broker(temporary.databasePath, "closed");
  await instance.dispose();
  await assert.rejects(
    instance.acquire({
      resources: [{ key: "database:closed", kind: "physical" }],
      deadlineAt: Date.now() + 1_000,
    }),
    /disposed/u,
  );
  await rm(temporary.root, { recursive: true, force: true });
});

test("a schema migration that fails leaves no half-applied database behind", async () => {
  const temporary = await tempDatabase();
  // The shape shipped before resource_lease_item gained capacity and fence_token, which is what
  // a broker opening an upgraded installation's database has to migrate.
  const legacy = new DatabaseSync(temporary.databasePath);
  try {
    legacy.exec(`
      CREATE TABLE resource_lease (
        lease_id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL
      );
      CREATE TABLE resource_lease_item (
        lease_id TEXT NOT NULL REFERENCES resource_lease(lease_id) ON DELETE CASCADE,
        resource_key TEXT NOT NULL,
        units INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('abstract', 'physical')),
        PRIMARY KEY (lease_id, resource_key)
      );
      CREATE TABLE resource_capacity (
        resource_key TEXT PRIMARY KEY,
        capacity INTEGER NOT NULL
      );
    `);
    legacy.exec("INSERT INTO resource_capacity(resource_key, capacity) VALUES ('stale:key', 1)");
    // Fails the schema block after its two ALTER statements, standing in for the duplicate
    // column another host's concurrent migration raises there.
    legacy.exec(
      "CREATE TRIGGER refuse_capacity_reset BEFORE DELETE ON resource_capacity "
      + "BEGIN SELECT RAISE(ABORT, 'migration interrupted'); END",
    );
  } finally {
    legacy.close();
  }

  const leaseItemColumns = () => {
    const database = new DatabaseSync(temporary.databasePath);
    try {
      return database.prepare("PRAGMA table_info(resource_lease_item)").all().map((row) => String(row.name));
    } finally {
      database.close();
    }
  };

  const before = leaseItemColumns();
  assert.throws(() => broker(temporary.databasePath, "interrupted"), /migration interrupted/u);
  assert.deepEqual(
    leaseItemColumns(),
    before,
    "an interrupted migration committed its ALTER statements and left the schema half applied",
  );

  await rm(temporary.root, { recursive: true, force: true });
});
