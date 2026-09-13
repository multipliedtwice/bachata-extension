const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { createServer } = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const test = require("node:test");

const { createBrowserBridgeRecovery } = require("../dist/browser/bridgeRecovery.js");
const { createBrowserBridgeServer } = require("../dist/browser/bridgeServer.js");
const { createSharedBrowserBridgeClient, probeBrowserBridgeEndpoint } = require("../dist/browser/sharedBridgeTransport.js");
const { createResourceBroker } = require("../dist/concurrency/resourceBroker.js");

const availablePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
};

const waitFor = async (condition, description) => {
  const deadline = Date.now() + 8_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

for (const automaticPort of [false, true]) test(`real Bridge recovery and shared RPC elect one owner, preserve pairing and recover after owner shutdown automatically (${automaticPort ? "automatic port" : "configured port"})`, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-bridge-integration-"));
  const databasePath = path.join(root, "resources.sqlite");
  const port = automaticPort ? 0 : await availablePort();
  const endpoint = `ws://127.0.0.1:${port}/bachata-browser-bridge-v9`;
  const values = new Map([
    ["bachata.browserBridge.connectionToken.v8", "retained-browser-pairing-credential"],
    ["bachata.browserBridge.extensionOrigin.v8", "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
  ]);
  const pairingCredentials = [...values];
  const secretWrites = [];
  const secretStore = {
    get: async (key) => values.get(key),
    store: async (key, value) => { secretWrites.push(key); values.set(key, value); },
    delete: async (key) => { secretWrites.push(key); values.delete(key); },
  };
  const startedOwners = [];
  const authenticatedClients = [];
  const windows = [];
  const database = new DatabaseSync(databasePath);
  const currentOwners = () => database.prepare(`
    SELECT lease.owner_id AS ownerId
    FROM resource_lease_item AS item
    JOIN resource_lease AS lease ON lease.lease_id = item.lease_id
    WHERE item.resource_key = 'browser-bridge:profile'
  `).all().map((row) => row.ownerId);
  const makeWindow = (id) => {
    const broker = createResourceBroker({
      databasePath,
      ownerId: id,
      pollIntervalMs: 10,
      heartbeatIntervalMs: 100,
      staleOwnerMs: 2_000,
    });
    const statuses = [];
    const controller = createBrowserBridgeRecovery({
      enabled: true,
      endpoint,
      broker,
      secretStore,
      retryBaseMs: 25,
      retryMaxMs: 100,
      healthCheckMs: 50,
      attemptTimeoutMs: 500,
      cleanupTimeoutMs: 1_000,
      onStatusChange: (status) => { statuses.push(status); },
      log: () => undefined,
      createOwnedServer: (onStatusChange, sharedToken) => {
        const server = createBrowserBridgeServer({
          enabled: true,
          port,
          secretStore,
          sharedToken,
          onStatusChange,
          log: () => undefined,
        });
        const start = server.start;
        server.start = async () => {
          await start();
          startedOwners.push(id);
        };
        return server;
      },
      createSharedClient: (options) => {
        const client = createSharedBrowserBridgeClient({ ...options, pollIntervalMs: 50 });
        const start = client.start;
        client.start = async () => {
          await start();
          authenticatedClients.push({ id, status: client.getStatus() });
        };
        return client;
      },
    });
    const window = { id, broker, controller, statuses };
    windows.push(window);
    return window;
  };
  try {
    const first = makeWindow("integration-window-one");
    const second = makeWindow("integration-window-two");
    const stale = await first.broker.acquire({
      resources: [
        { key: "browser-bridge:profile", kind: "physical" },
        { key: "working-directory:unrelated-integration", kind: "physical" },
      ],
      deadlineAt: Date.now() + 1_000,
    });
    await stale.quarantine("The previous process ended before confirming cleanup");
    first.controller.startAutomatic();
    second.controller.startAutomatic();
    await waitFor(() => startedOwners.length === 1 && authenticatedClients.length >= 1,
      "one server owner and an authenticated second window");
    const owner = windows.find((window) => window.id === startedOwners[0]);
    const standby = windows.find((window) => window !== owner);
    const ownedEndpoint = owner.controller.getStatus().endpoint;
    assert.ok(ownedEndpoint);
    assert.notEqual(new URL(ownedEndpoint).port, "0");
    assert.deepEqual(currentOwners(), [owner.id]);
    assert.equal(authenticatedClients[0].id, standby.id);
    assert.equal(authenticatedClients[0].status.endpoint, ownedEndpoint);
    assert.equal(authenticatedClients[0].status.pairingToken, owner.controller.getStatus().pairingToken);
    assert.deepEqual(first.broker.listQuarantine().map((item) => item.key), ["working-directory:unrelated-integration"]);
    for (const [key, value] of pairingCredentials) assert.equal(values.get(key), value);
    assert.deepEqual(secretWrites, ["bachata.browserBridge.sharedToken.v1"]);
    const token = values.get("bachata.browserBridge.sharedToken.v1");
    assert.ok((await probeBrowserBridgeEndpoint(ownedEndpoint, token)).status);
    assert.deepEqual(await probeBrowserBridgeEndpoint(ownedEndpoint, "incorrect-token"), { reachable: true });

    await owner.controller.dispose();
    await waitFor(() => startedOwners.length === 2 && currentOwners()[0] === standby.id,
      "the remaining window to recover ownership automatically");
    assert.deepEqual(startedOwners, [owner.id, standby.id]);
    assert.deepEqual(currentOwners(), [standby.id]);
    const resumedEndpoint = standby.controller.getStatus().endpoint;
    assert.ok(resumedEndpoint);
    assert.notEqual(new URL(resumedEndpoint).port, "0");
    assert.ok((await probeBrowserBridgeEndpoint(resumedEndpoint, token)).status);
    assert.deepEqual(standby.broker.listQuarantine().map((item) => item.key), ["working-directory:unrelated-integration"]);
    for (const [key, value] of pairingCredentials) assert.equal(values.get(key), value);
    assert.deepEqual(secretWrites, ["bachata.browserBridge.sharedToken.v1"]);
    assert.doesNotMatch(JSON.stringify(windows.flatMap((window) => window.statuses)),
      /quarantin|browser-bridge:profile|integration-window|resources\.sqlite/iu);
  } finally {
    for (const window of windows) await window.controller.dispose();
    for (const window of windows) await window.broker.dispose();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
