const assert = require("node:assert/strict");
const test = require("node:test");

const { createBrowserBridgeRecovery } = require("../dist/browser/bridgeRecovery.js");

const endpoint = "ws://127.0.0.1:43127/bachata-browser-bridge-v9";
const tokenKey = "bachata.browserBridge.sharedToken.v1";
const tick = () => new Promise((resolve) => setImmediate(resolve));
const fixture = (overrides = {}) => {
  const values = new Map([["bachata.browserBridge.connectionToken.v8", "paired-browser"], [tokenKey, "existing-shared-token"]]);
  const quarantines = new Set(["browser-bridge:profile", "working-directory:unrelated"]);
  const statuses = [];
  const logs = [];
  const timers = new Map();
  const bindings = new Map();
  const secondaryReservations = new Set();
  const leaseAbort = new AbortController();
  const calls = { acquire: 0, reserve: 0, start: 0, close: 0, release: 0, quarantine: 0, reset: 0, discover: 0, shared: 0, stores: 0, secondaryRelease: 0 };
  let timerId = 0;
  let held = false;
  let heldByOther = overrides.liveLease ?? false;
  let reachable = overrides.reachable ?? false;
  let available = overrides.available ?? false;
  let connected = overrides.connected ?? true;
  let startFailure = overrides.startFailure;
  let closeFailure = overrides.closeFailure;
  let valid = false;
  let reserved = false;
  let ownedReady = false;
  let probeGate;
  let activeStatusListener;
  const bridgeStatus = () => ({ enabled: true, endpoint, connected, sessions: [], error: overrides.rawError, blockedReason: overrides.blockedReason });
  const broker = {
    inspectBrowserBridgeOwnership: () => ({ held: held || heldByOther, quarantined: quarantines.has("browser-bridge:profile"), ...(overrides.missingEndpoint ? {} : { endpoint: overrides.previousEndpoint ?? endpoint }) }),
    acquire: async () => { throw new Error("Unexpected generic acquisition"); },
    acquireBrowserBridge: async (request) => {
      calls.acquire += 1;
      assert.equal(request.isEndpointReserved(endpoint), true);
      if (overrides.previousEndpoint) assert.equal(request.isEndpointReserved(overrides.previousEndpoint), true);
      if (heldByOther || held) throw new Error("Another live owner holds the Bridge");
      if (overrides.acquireGate) await overrides.acquireGate;
      held = true;
      valid = true;
      quarantines.delete("browser-bridge:profile");
      return {
        id: "lease",
        resources: [],
        fences: {},
        signal: leaseAbort.signal,
        isValid: () => valid,
        assertValid: () => { assert.equal(valid, true); },
        release: async () => { calls.release += 1; held = false; valid = false; },
        quarantine: async () => { calls.quarantine += 1; held = false; valid = false; quarantines.add("browser-bridge:profile"); },
        confirmCleanup: async () => { quarantines.delete("browser-bridge:profile"); },
      };
    },
  };
  const makeBridge = (onStatusChange, shared = false) => ({
    reserve: async () => {
      calls.reserve += 1;
      if (reserved) throw Object.assign(new Error("Address in use"), { code: "EADDRINUSE" });
      reserved = true;
      return { endpoint, isHeld: () => reserved, release: async () => { if (closeFailure && !overrides.releaseWhileClosing) throw closeFailure; reserved = false; } };
    },
    start: async () => {
      calls.start += 1;
      if (!shared) assert.equal(held, true);
      if (typeof startFailure === "function") await startFailure();
      else if (startFailure) throw startFailure;
      ownedReady = !shared;
      onStatusChange(bridgeStatus());
    },
    close: async () => {
      calls.close += 1;
      if (typeof closeFailure === "function") await closeFailure();
      else if (closeFailure) throw closeFailure;
      if (!shared) { reserved = false; ownedReady = false; }
    },
    getStatus: bridgeStatus,
    subscribeStatus: () => ({ dispose: () => undefined }),
    resetPairing: async () => { calls.reset += 1; values.set("bachata.browserBridge.connectionToken.v8", "reset-by-user"); },
    discover: () => { calls.discover += 1; },
    refreshLocalModelConfig: () => undefined,
    bindConversation: (owner, binding) => { bindings.set(owner, binding); },
    releaseBinding: (owner) => { bindings.delete(owner); },
    resolveBoundSession: () => undefined,
    bindSession: () => ({ provider: "chatgpt", conversationIdentity: "session", conversationUrl: "https://chatgpt.com" }),
    openConversation: async () => { throw new Error("Unused"); },
    sendConversation: async function* () {},
    fetchAsset: async function* () {},
    revealAsset: async () => undefined,
    interrupt: async () => undefined,
  });
  const controller = createBrowserBridgeRecovery({
    enabled: true,
    endpoint,
    broker,
    secretStore: {
      get: async (key) => values.get(key),
      store: async (key, value) => { assert.equal(held, true); calls.stores += 1; values.set(key, value); },
      delete: async (key) => { values.delete(key); },
    },
    createOwnedServer: (onStatusChange, getSharedToken) => {
      activeStatusListener = onStatusChange;
      const bridge = makeBridge(onStatusChange);
      const start = bridge.start;
      bridge.start = async () => { assert.equal(getSharedToken(), values.get(tokenKey)); await start(); };
      return bridge;
    },
    onStatusChange: (status) => { statuses.push(status); },
    log: (message) => { logs.push(message); },
    probeEndpoint: async (candidate) => {
      if (probeGate) await probeGate;
      return overrides.probeEndpoint?.(candidate) ?? ({
        reachable: ownedReady || reachable,
        ...((ownedReady || available) ? { status: bridgeStatus() } : {}),
      });
    },
    reserveEndpoint: async (oldEndpoint) => {
      secondaryReservations.add(oldEndpoint);
      return { endpoint: oldEndpoint, isHeld: () => secondaryReservations.has(oldEndpoint), release: async () => { calls.secondaryRelease += 1; secondaryReservations.delete(oldEndpoint); } };
    },
    createSharedClient: ({ onStatusChange }) => { calls.shared += 1; activeStatusListener = onStatusChange; return makeBridge(onStatusChange, true); },
    schedule: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    cancelSchedule: (id) => { timers.delete(id); },
    retryBaseMs: 10,
    retryMaxMs: 40,
    healthCheckMs: 100,
    ...overrides.options,
  });
  return {
    controller, calls, quarantines, values, statuses, logs, timers, bindings, secondaryReservations,
    held: () => held,
    gateProbe: (value) => { probeGate = value; },
    reserved: () => reserved,
    live: (value) => { heldByOther = value; },
    reach: (value, usable = value) => { reachable = value; available = usable; },
    failStart: (value) => { startFailure = value; },
    failClose: (value) => { closeFailure = value; },
    loseLease: () => { valid = false; },
    abortLease: () => { valid = false; leaseAbort.abort(); },
    connect: (value) => { connected = value; activeStatusListener?.(bridgeStatus()); },
    advance: async () => {
      assert.equal(timers.size, 1);
      const [id, value] = timers.entries().next().value;
      timers.delete(id);
      value.callback();
      await tick();
      return value.delay;
    },
  };
};

test("activation heals only the Bridge quarantine without controls and preserves pairing", async () => {
  const f = fixture();
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.calls.acquire, 1);
  assert.equal(f.calls.start, 1);
  assert.equal(f.calls.reset, 0);
  assert.equal(f.calls.stores, 0);
  assert.equal(f.quarantines.has("browser-bridge:profile"), false);
  assert.equal(f.quarantines.has("working-directory:unrelated"), true);
  assert.equal(f.values.get("bachata.browserBridge.connectionToken.v8"), "paired-browser");
  assert.equal(f.statuses[0].connectionState, "connecting");
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});

test("shared credentials are created only after ownership acquisition", async () => {
  const f = fixture();
  f.values.delete(tokenKey);
  await f.controller.ensureAvailable();
  assert.equal(f.calls.stores, 1);
  assert.equal(f.values.get(tokenKey).length > 20, true);
  assert.equal(f.calls.reset, 0);
  await f.controller.dispose();
});

test("a live lease remains intact until its owner exits", async () => {
  const f = fixture({ liveLease: true });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.calls.start, 0);
  assert.equal(f.calls.release, 0);
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  assert.equal(f.reserved(), false);
  f.live(false);
  await f.advance();
  assert.equal(f.calls.start, 1);
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});

test("a reachable authenticated Bridge is reused without changing lease or quarantine", async () => {
  const f = fixture({ liveLease: true, reachable: true, available: true });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.calls.shared, 1);
  assert.equal(f.calls.reserve, 0);
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  assert.equal(f.calls.reset, 0);
  await f.controller.dispose();
  assert.equal(f.calls.release, 0);
});

test("an unknown reachable server is never taken over and ambiguity retries with bounded backoff", async () => {
  const f = fixture({ reachable: true });
  f.controller.startAutomatic();
  await tick();
  const delays = [];
  for (let index = 0; index < 6; index += 1) delays.push(await f.advance());
  assert.deepEqual(delays, [10, 20, 40, 40, 40, 40]);
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.calls.reserve, 0);
  assert.equal(f.calls.stores, 0);
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  f.reach(false);
  await f.advance();
  assert.equal(f.calls.start, 1);
  await f.controller.dispose();
});

test("activation, reconnect and wake coalesce into one ownership attempt", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = fixture({ acquireGate: gate });
  f.controller.startAutomatic();
  const one = f.controller.ensureAvailable();
  const two = f.controller.ensureAvailable();
  f.controller.notifyWake();
  await tick();
  assert.equal(one, two);
  assert.equal(f.calls.acquire, 1);
  release();
  await one;
  assert.equal(f.calls.start, 1);
  assert.equal(f.timers.size, 1);
  await f.controller.dispose();
});

test("startup failure releases closed resources and retries automatically", async () => {
  const f = fixture({ startFailure: new Error("Shared resource is quarantined: browser-bridge:profile database owner-id") });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.held(), false);
  assert.equal(f.reserved(), false);
  assert.equal(f.calls.release, 1);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  assert.doesNotMatch(JSON.stringify(f.statuses), /quarantin|browser-bridge:profile|database|owner-id/u);
  f.failStart(undefined);
  await f.advance();
  assert.equal(f.calls.start, 2);
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});

test("failed physical cleanup stays quarantined and cannot start a second server", async () => {
  const f = fixture({ startFailure: new Error("Cannot start"), closeFailure: new Error("Cannot close") });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.calls.quarantine > 0, true);
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  assert.equal(f.reserved(), true);
  await f.advance();
  assert.equal(f.calls.acquire, 1);
  assert.equal(f.calls.start, 1);
  f.failClose(undefined);
  f.failStart(undefined);
  await f.advance();
  assert.equal(f.calls.start, 2);
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});

test("only repeated concrete external failures enter blocked state", async () => {
  const f = fixture({ startFailure: Object.assign(new Error("Permission denied at internal database"), { code: "EACCES" }) });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  await f.advance();
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  await f.advance();
  assert.equal(f.controller.getStatus().connectionState, "blocked");
  assert.equal(f.controller.getStatus().blockedReason, "accessDenied");
  assert.doesNotMatch(JSON.stringify(f.statuses), /internal|database/u);
  f.failStart(undefined);
  await f.advance();
  assert.equal(f.controller.getStatus().connectionState, "connected");
  assert.equal(f.controller.getStatus().blockedReason, undefined);
  await f.controller.dispose();
});

test("Find browser only discovers and Reset pairing only changes credentials", async () => {
  const f = fixture({ reachable: true });
  f.controller.discover();
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.calls.reserve, 0);
  await assert.rejects(f.controller.resetPairing(), /Browser unavailable/u);
  assert.equal(f.calls.acquire, 0);
  f.reach(false);
  await f.controller.ensureAvailable();
  const acquisitions = f.calls.acquire;
  f.controller.discover();
  await f.controller.resetPairing();
  assert.equal(f.calls.acquire, acquisitions);
  assert.equal(f.calls.reset, 1);
  assert.equal(f.values.get("bachata.browserBridge.connectionToken.v8"), "reset-by-user");
  await f.controller.dispose();
});

test("recorded and configured endpoints are both reserved during atomic acquisition", async () => {
  const f = fixture({ previousEndpoint: "ws://127.0.0.1:43128/bachata-browser-bridge-v9" });
  assert.equal(await f.controller.ensureAvailable(), true);
  assert.equal(f.calls.start, 1);
  assert.equal(f.secondaryReservations.size, 0);
  assert.equal(f.calls.secondaryRelease, 1);
  await f.controller.dispose();
});

test("saved bindings survive deferred activation and lease loss recovery", async () => {
  const f = fixture({ liveLease: true });
  const binding = { provider: "chatgpt", conversationIdentity: "saved-conversation", conversationUrl: "https://chatgpt.com/c/saved" };
  f.controller.bindConversation("retained", binding);
  f.controller.bindConversation("released", binding);
  f.controller.releaseBinding("released");
  f.controller.startAutomatic();
  await tick();
  f.live(false);
  await f.advance();
  assert.equal(f.bindings.get("retained"), binding);
  assert.equal(f.bindings.has("released"), false);
  f.loseLease();
  f.controller.notifyWake();
  await tick();
  assert.equal(f.calls.start, 2);
  assert.equal(f.bindings.get("retained"), binding);
  await f.controller.dispose();
});

test("disposal cancels queued recovery and cannot publish late status", async () => {
  const f = fixture({ reachable: true });
  f.controller.startAutomatic();
  await tick();
  await f.controller.dispose();
  const count = f.statuses.length;
  assert.equal(f.timers.size, 0);
  f.controller.notifyWake();
  f.controller.startAutomatic();
  assert.equal(await f.controller.ensureAvailable(), false);
  f.connect(true);
  assert.equal(f.statuses.length, count);
  assert.equal(f.calls.acquire, 0);
});

test("transport errors and internal status never leak through the facade", async () => {
  const f = fixture({ rawError: "Shared resource is quarantined: browser-bridge:profile" });
  await f.controller.ensureAvailable();
  assert.equal(f.controller.getStatus().error, undefined);
  assert.doesNotMatch(JSON.stringify(f.statuses), /quarantin|browser-bridge:profile/u);
  await f.controller.dispose();
});


test("a reachable Bridge at the recorded previous port is reused instead of reserving either port", async () => {
  const oldEndpoint = "ws://127.0.0.1:43128/bachata-browser-bridge-v9";
  const f = fixture({
    previousEndpoint: oldEndpoint,
    probeEndpoint: (candidate) => candidate === oldEndpoint
      ? { reachable: true, status: { enabled: true, connected: true, sessions: [] } }
      : { reachable: false },
  });
  assert.equal(await f.controller.ensureAvailable(), true);
  assert.equal(f.calls.shared, 1);
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.calls.reserve, 0);
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  await f.controller.dispose();
});

test("legacy quarantine without endpoint metadata checks the default port before recovery", async () => {
  const f = fixture({
    missingEndpoint: true,
    options: { endpoint: "ws://127.0.0.1:43128/bachata-browser-bridge-v9" },
    probeEndpoint: (candidate) => ({ reachable: candidate === endpoint }),
  });
  assert.equal(await f.controller.ensureAvailable(), false);
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.calls.reserve, 0);
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  await f.controller.dispose();
});

test("a clean profile does not inspect the legacy default port when configured elsewhere", async () => {
  const observed = [];
  const customEndpoint = "ws://127.0.0.1:43128/bachata-browser-bridge-v9";
  const f = fixture({
    missingEndpoint: true,
    options: { endpoint: customEndpoint },
    probeEndpoint: (candidate) => { observed.push(candidate); return { reachable: true }; },
  });
  f.quarantines.delete("browser-bridge:profile");
  assert.equal(await f.controller.ensureAvailable(), false);
  assert.deepEqual(observed, [customEndpoint]);
  await f.controller.dispose();
});

test("lease revocation closes the server immediately without waiting for health polling", async () => {
  const f = fixture();
  f.controller.startAutomatic();
  await tick();
  f.abortLease();
  await tick();
  assert.equal(f.calls.close > 0, true);
  assert.equal(f.calls.release > 0, true);
  await f.controller.dispose();
});

test("subscribers immediately receive the current safe status", async () => {
  const f = fixture({ rawError: "Shared resource is quarantined" });
  await f.controller.ensureAvailable();
  const statuses = [];
  const subscription = f.controller.subscribeStatus((status) => statuses.push(status));
  assert.equal(statuses.length, 1);
  assert.equal(statuses[0].connectionState, "connected");
  assert.equal(statuses[0].error, undefined);
  assert.notEqual(statuses[0], f.controller.getStatus());
  subscription.dispose();
  await f.controller.dispose();
});

test("typed external status becomes blocked only after repeated recovery observations", async () => {
  const f = fixture({ connected: false, blockedReason: "browserUpdateRequired" });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  f.connect(false);
  f.connect(false);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  await f.advance();
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  await f.advance();
  assert.equal(f.controller.getStatus().connectionState, "blocked");
  assert.equal(f.controller.getStatus().blockedReason, "browserUpdateRequired");
  await f.controller.dispose();
});


test("a hanging startup times out, closes its reservation and retries", async () => {
  const f = fixture({ startFailure: () => new Promise(() => undefined) });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.calls.start, 1);
  assert.equal(f.held(), true);
  await f.advance();
  assert.equal(f.held(), false);
  assert.equal(f.reserved(), false);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  f.failStart(undefined);
  await f.advance();
  assert.equal(f.calls.start, 2);
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});

test("a hanging close is bounded and keeps uncertain cleanup quarantined", async () => {
  const f = fixture({ startFailure: new Error("Cannot start"), closeFailure: () => new Promise(() => undefined) });
  f.controller.startAutomatic();
  await tick();
  await f.advance();
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  assert.equal(f.calls.quarantine > 0, true);
  assert.equal(f.calls.acquire, 1);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  f.failStart(undefined);
  f.failClose(undefined);
  await f.advance();
  assert.equal(f.calls.start, 2);
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});


test("lease revocation closes immediately even during an unfinished health probe", async () => {
  const f = fixture();
  f.controller.startAutomatic();
  await tick();
  let finishProbe;
  const pending = new Promise((resolve) => { finishProbe = resolve; });
  f.gateProbe(pending);
  const health = f.controller.ensureAvailable();
  await tick();
  const previousCloses = f.calls.close;
  f.abortLease();
  assert.equal(f.calls.close, previousCloses + 1);
  finishProbe();
  f.gateProbe(undefined);
  await health;
  await f.controller.dispose();
});

test("repeated probe access denial is actionable without taking over the endpoint", async () => {
  const f = fixture({ probeEndpoint: () => ({ reachable: true, blockedReason: "accessDenied" }) });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  await f.advance();
  await f.advance();
  assert.equal(f.controller.getStatus().connectionState, "blocked");
  assert.equal(f.controller.getStatus().blockedReason, "accessDenied");
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.calls.reserve, 0);
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  await f.controller.dispose();
});

test("an ambiguous health response preserves a live owned server until it becomes available", async () => {
  let ambiguous = false;
  const f = fixture({ probeEndpoint: () => ambiguous ? { reachable: true } : undefined });
  f.controller.startAutomatic();
  await tick();
  ambiguous = true;
  assert.equal(await f.controller.ensureAvailable(), false);
  assert.equal(f.calls.close, 0);
  assert.equal(f.calls.release, 0);
  assert.equal(f.held(), true);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  ambiguous = false;
  await f.advance();
  assert.equal(f.calls.acquire, 1);
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});

test("a stalled credential read times out and recovers automatically when storage returns", async () => {
  let stalled = true;
  const f = fixture({ options: { secretStore: {
    get: async (key) => stalled ? new Promise(() => undefined) : f.values.get(key),
    store: async () => undefined,
    delete: async () => undefined,
  } } });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.calls.reserve, 0);
  await f.advance();
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  assert.equal(f.calls.acquire, 0);
  stalled = false;
  await f.advance();
  assert.equal(f.controller.getStatus().connectionState, "connected");
  assert.equal(f.calls.reset, 0);
  await f.controller.dispose();
});

test("a credential read stalled after acquisition releases the closed reservation", async () => {
  let reads = 0;
  const f = fixture({ options: { secretStore: {
    get: async (key) => ++reads === 2 ? new Promise(() => undefined) : f.values.get(key),
    store: async () => undefined,
    delete: async () => undefined,
  } } });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.held(), true);
  assert.equal(f.calls.start, 0);
  await f.advance();
  assert.equal(f.held(), false);
  assert.equal(f.reserved(), false);
  await f.advance();
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});

test("disposal cancels a pending credential read without awaiting storage or its deadline", async () => {
  let finishRead;
  const pending = new Promise((resolve) => { finishRead = resolve; });
  const f = fixture({ options: { secretStore: {
    get: () => pending,
    store: async () => undefined,
    delete: async () => undefined,
  } } });
  f.controller.startAutomatic();
  await tick();
  const observed = f.statuses.length;
  await f.controller.dispose();
  assert.equal(f.timers.size, 0);
  finishRead("late-token");
  await tick();
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.calls.start, 0);
  assert.equal(f.statuses.length, observed);
});

test("a stalled credential write keeps the endpoint reserved until the write settles", async () => {
  let finishWrite;
  let stores = 0;
  const pending = new Promise((resolve) => { finishWrite = resolve; });
  const f = fixture({ options: { secretStore: {
    get: async (key) => f.values.get(key),
    store: async (key, value) => { stores += 1; await pending; f.values.set(key, value); },
    delete: async () => undefined,
  } } });
  f.values.delete(tokenKey);
  f.controller.startAutomatic();
  await tick();
  assert.equal(stores, 1);
  assert.equal(f.reserved(), true);
  assert.equal(f.calls.start, 0);
  await f.advance();
  await f.advance();
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  assert.equal(f.quarantines.has("working-directory:unrelated"), true);
  assert.equal(f.reserved(), true);
  assert.equal(f.calls.close, 0);
  assert.equal(f.calls.release, 0);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  finishWrite();
  await tick();
  await f.advance();
  assert.equal(f.calls.start, 1);
  assert.equal(stores, 1);
  assert.equal(f.values.get("bachata.browserBridge.connectionToken.v8"), "paired-browser");
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});

test("disposing during a credential write remains bounded and cleans up after its late completion", async () => {
  let finishWrite;
  const pending = new Promise((resolve) => { finishWrite = resolve; });
  const f = fixture({ options: { secretStore: {
    get: async (key) => f.values.get(key),
    store: async (key, value) => { await pending; f.values.set(key, value); },
    delete: async () => undefined,
  } } });
  f.values.delete(tokenKey);
  f.controller.startAutomatic();
  await tick();
  const disposal = assert.rejects(f.controller.dispose(), /Browser unavailable/u);
  await tick();
  await f.advance();
  await f.advance();
  await disposal;
  assert.equal(f.reserved(), true);
  assert.equal(f.calls.start, 0);
  assert.equal(f.timers.size, 0);
  finishWrite();
  await tick();
  assert.equal(f.reserved(), false);
  assert.equal(f.quarantines.has("browser-bridge:profile"), false);
  assert.equal(f.quarantines.has("working-directory:unrelated"), true);
  assert.equal(f.timers.size, 0);
});

test("a stalled health probe preserves a live owner and retries without a second server", async () => {
  const f = fixture();
  f.controller.startAutomatic();
  await tick();
  f.gateProbe(new Promise(() => undefined));
  const pending = f.controller.ensureAvailable();
  await tick();
  await f.advance();
  assert.equal(await pending, false);
  assert.equal(f.calls.close, 0);
  assert.equal(f.calls.release, 0);
  assert.equal(f.held(), true);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  f.gateProbe(undefined);
  await f.advance();
  assert.equal(f.calls.acquire, 1);
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});

test("disposal aborts a pending endpoint probe and cannot acquire after its late completion", async () => {
  let finishProbe;
  const gate = new Promise((resolve) => { finishProbe = resolve; });
  const signals = [];
  const f = fixture({ options: { probeEndpoint: async (_endpoint, _token, _timeout, signal) => {
    signals.push(signal);
    await gate;
    return { reachable: false };
  } } });
  f.controller.startAutomatic();
  await tick();
  assert.equal(signals.length, 1);
  await f.controller.dispose();
  assert.equal(signals[0].aborted, true);
  assert.equal(f.timers.size, 0);
  finishProbe();
  await tick();
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.calls.reserve, 0);
});

test("an acquisition completing after disposal releases its unused lease", async () => {
  let finishAcquisition;
  const gate = new Promise((resolve) => { finishAcquisition = resolve; });
  const f = fixture({ acquireGate: gate });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.calls.acquire, 1);
  await f.controller.dispose();
  assert.equal(f.reserved(), false);
  finishAcquisition();
  await tick();
  assert.equal(f.held(), false);
  assert.equal(f.calls.release, 1);
  assert.equal(f.calls.start, 0);
  assert.equal(f.timers.size, 0);
});


test("an automatically assigned port probes only persisted endpoints and reserves the selected port once", async () => {
  const observed = [];
  const f = fixture({
    options: { endpoint: "ws://127.0.0.1:0/bachata-browser-bridge-v9" },
    probeEndpoint: (candidate) => { observed.push(candidate); return { reachable: false }; },
  });
  assert.equal(await f.controller.ensureAvailable(), true);
  assert.deepEqual(observed, [endpoint]);
  assert.equal(f.calls.reserve, 1);
  assert.equal(f.calls.secondaryRelease, 0);
  assert.equal(f.calls.acquire, 1);
  await f.controller.dispose();
});

test("a clean profile with an automatically assigned port starts without probing port zero", async () => {
  const observed = [];
  const f = fixture({
    missingEndpoint: true,
    options: { endpoint: "ws://127.0.0.1:0/bachata-browser-bridge-v9" },
    probeEndpoint: (candidate) => { observed.push(candidate); return { reachable: true }; },
  });
  f.quarantines.delete("browser-bridge:profile");
  assert.equal(await f.controller.ensureAvailable(), true);
  assert.deepEqual(observed, []);
  assert.equal(f.calls.secondaryRelease, 0);
  assert.equal(f.calls.start, 1);
  await f.controller.dispose();
});

test("a secondary reservation completing after disposal is released without acquiring ownership", async () => {
  const oldEndpoint = "ws://127.0.0.1:43128/bachata-browser-bridge-v9";
  let finishReservation;
  let held = false;
  let releases = 0;
  const pending = new Promise((resolve) => { finishReservation = resolve; });
  const f = fixture({ previousEndpoint: oldEndpoint, options: { reserveEndpoint: async (_endpoint, signal) => {
    await pending;
    assert.equal(signal.aborted, true);
    held = true;
    return { endpoint: oldEndpoint, isHeld: () => held, release: async () => { releases += 1; held = false; } };
  } } });
  f.controller.startAutomatic();
  await tick();
  assert.equal(f.reserved(), true);
  assert.equal(f.calls.acquire, 0);
  await f.controller.dispose();
  finishReservation();
  await tick();
  assert.equal(held, false);
  assert.equal(releases, 1);
  assert.equal(f.calls.acquire, 0);
  assert.equal(f.calls.start, 0);
  assert.equal(f.timers.size, 0);
});

test("an ownership request that outlives its deadline releases late acquisition before retry", async () => {
  let finishAcquisition;
  const gate = new Promise((resolve) => { finishAcquisition = resolve; });
  const f = fixture({ acquireGate: gate });
  f.controller.startAutomatic();
  await tick();
  await f.advance();
  assert.equal(f.reserved(), false);
  assert.equal(f.calls.start, 0);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  finishAcquisition();
  await tick();
  assert.equal(f.held(), false);
  assert.equal(f.calls.release, 1);
  await f.advance();
  assert.equal(f.calls.start, 1);
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});


test("cleanup cannot bypass an unfinished server shutdown through its port reservation", async () => {
  const f = fixture({
    startFailure: new Error("Startup remains pending"),
    closeFailure: () => new Promise(() => undefined),
    releaseWhileClosing: true,
  });
  f.controller.startAutomatic();
  await tick();
  await f.advance();
  assert.equal(f.reserved(), true);
  assert.equal(f.calls.release, 0);
  assert.equal(f.quarantines.has("browser-bridge:profile"), true);
  assert.equal(f.controller.getStatus().connectionState, "retrying");
  f.failClose(undefined);
  f.failStart(undefined);
  await f.advance();
  assert.equal(f.calls.start, 2);
  assert.equal(f.controller.getStatus().connectionState, "connected");
  await f.controller.dispose();
});
