const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { openReadOnlyStateCatalog, READ_ONLY_CATALOG_FILENAME } = require("../dist/state/readOnlyCatalog.js");
const { readOnlyPipelines } = require("../dist/state/readOnlyPipelines.js");
const { createStateCatalog } = require("../dist/state/catalog.js");
const { openSqliteDatabase } = require("../dist/state/sqlite.js");
const { processIsAlive } = require("../dist/pipeline/catalogStorage.js");
const { createReadOnlyProductService } = require("../dist/state/readOnlyProductState.js");

// EX-AUD-13. Three retained best-effort paths in the persistence layer. Each one absorbs a
// failure that has an observable answer of its own, and each is exercised here rather than
// left to a comment.

const workspace = () => fs.mkdtempSync(path.join(os.tmpdir(), "bachata-readonly-"));

// A pipeline the schema actually accepts: the repository's own preset, re-identified.
const presetPath = path.join(__dirname, "..", "presets", "gpt-pair.pipeline.json");
const pipeline = (id) => JSON.stringify({
  ...JSON.parse(fs.readFileSync(presetPath, "utf8")),
  id,
  name: id,
});

test("a pipeline file a reader cannot parse is skipped, not fatal", async () => {
  const root = workspace();
  const directory = path.join(root, ".bachata", "pipelines");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "readable.json"), pipeline("readable"), "utf8");
  fs.writeFileSync(path.join(directory, "truncated.json"), "{ \"id\": \"broken\"", "utf8");
  fs.writeFileSync(path.join(directory, "wrong-shape.json"), JSON.stringify({ id: 7 }), "utf8");

  const pipelines = await readOnlyPipelines({
    extensionDirectory: path.join(root, "no-extension-here"),
    workspaceRoots: [root],
  });
  assert.deepEqual(pipelines.map((entry) => entry.definition.id), ["readable"]);
});

test("a missing pipeline directory lists nothing rather than failing", async () => {
  const root = workspace();
  assert.deepEqual(
    await readOnlyPipelines({
      extensionDirectory: path.join(root, "absent"),
      workspaceRoots: [path.join(root, "also-absent")],
    }),
    [],
  );
});

test("a read-only catalog can be closed twice", () => {
  const root = workspace();
  const writer = createStateCatalog(root);
  writer.close?.();
  assert.equal(fs.existsSync(path.join(root, READ_ONLY_CATALOG_FILENAME)), true);

  const reader = openReadOnlyStateCatalog(root);
  assert.equal(reader.present, true);
  reader.close();
  assert.doesNotThrow(() => reader.close());
});

// The open retry closes a half-open handle before deciding whether to retry. A close that
// refuses must not replace the error the caller needs to see.
test("an initializer failure survives a handle that will not close", () => {
  const root = workspace();
  const databasePath = path.join(root, "probe.sqlite");
  assert.throws(
    () =>
      openSqliteDatabase(databasePath, (database) => {
        database.close();
        throw new Error("initializer refused");
      }),
    /initializer refused/u,
  );
});

// EX-AUD-13. Liveness decides whether a held pipeline-catalog lock may be reclaimed. The
// zombie check runs on Linux only, so the host it reads is injected: every branch is decided
// here rather than by whichever machine the suite happens to run on.

const livenessHost = (overrides = {}) => ({
  platform: "linux",
  readProcessStat: () => "1234 (node) S 1 1234 1234 0 -1",
  signalProcess: () => undefined,
  ...overrides,
});

const errno = (code) => {
  const error = new Error(code);
  error.code = code;
  return error;
};

test("a Linux zombie is dead even though a zero signal still reaches it", () => {
  let signalled = 0;
  assert.equal(
    processIsAlive(1234, livenessHost({
      readProcessStat: () => "1234 (node) Z 1 1234 1234 0 -1",
      signalProcess: () => { signalled += 1; },
    })),
    false,
  );
  assert.equal(signalled, 0, "the signal probe ran after the zombie was already proved dead");
});

test("a running Linux process is alive", () => {
  for (const state of ["R", "S", "D", "T"]) {
    assert.equal(
      processIsAlive(1234, livenessHost({
        readProcessStat: () => `1234 (node) ${state} 1 1234 1234 0 -1`,
      })),
      true,
      `state ${state}`,
    );
  }
});

test("a command name containing spaces and parentheses does not shift the state field", () => {
  assert.equal(
    processIsAlive(1234, livenessHost({
      readProcessStat: () => "1234 (my (odd) name) Z 1 1234 1234 0 -1",
    })),
    false,
  );
  assert.equal(
    processIsAlive(1234, livenessHost({
      readProcessStat: () => "1234 (my (odd) name) S 1 1234 1234 0 -1",
    })),
    true,
  );
});

test("a /proc entry that cannot be read leaves the signal probe to decide", () => {
  const unreadable = { readProcessStat: () => { throw errno("ENOENT"); } };
  assert.equal(processIsAlive(1234, livenessHost(unreadable)), true);
  assert.equal(
    processIsAlive(1234, livenessHost({
      ...unreadable,
      signalProcess: () => { throw errno("ESRCH"); },
    })),
    false,
  );
});

test("a stat line with no command terminator is not parsed for a state", () => {
  assert.equal(
    processIsAlive(1234, livenessHost({ readProcessStat: () => "malformed" })),
    true,
  );
});

test("no /proc is read off Linux", () => {
  let reads = 0;
  for (const platform of ["darwin", "win32", "freebsd"]) {
    assert.equal(
      processIsAlive(1234, livenessHost({
        platform,
        readProcessStat: () => { reads += 1; return "1234 (node) Z 1"; },
      })),
      true,
      platform,
    );
  }
  assert.equal(reads, 0, "a non-Linux host read /proc");
});

test("the signal probe reports the three answers it can give", () => {
  const host = (signalProcess) => livenessHost({ platform: "darwin", signalProcess });
  assert.equal(processIsAlive(1234, host(() => undefined)), true);
  // A pid owned by another user exists, so it is alive.
  assert.equal(processIsAlive(1234, host(() => { throw errno("EPERM"); })), true);
  assert.equal(processIsAlive(1234, host(() => { throw errno("ESRCH"); })), false);
  assert.equal(processIsAlive(1234, host(() => { throw new Error("no code"); })), false);
});

// EX-AUD-13. Disposing a read-only window closes its watchers. A watcher the platform has
// already closed must not stop the rest of the teardown.

const fakeWatcher = (overrides = {}) => ({
  closed: 0,
  unref() { this.unreffed = (this.unreffed ?? 0) + 1; return this; },
  close() { this.closed += 1; },
  ...overrides,
});

const readOnlyService = (watchFactory) => {
  const root = workspace();
  const writer = createStateCatalog(root);
  writer.close?.();
  return createReadOnlyProductService({
    storageRoot: root,
    ownership: { owned: false, reason: "another window owns this workspace" },
    watchStorage: true,
    watchFactory,
  });
};

test("disposing survives a watcher the platform already closed", () => {
  const watcher = fakeWatcher({
    close() {
      this.closed += 1;
      throw errno("EBADF");
    },
  });
  const service = readOnlyService(() => watcher);
  assert.doesNotThrow(() => service.dispose());
  assert.equal(watcher.closed, 1);
  // The teardown continued: a second dispose finds nothing left to close.
  assert.doesNotThrow(() => service.dispose());
  assert.equal(watcher.closed, 1);
});

test("a platform that refuses recursive watching gets the two directories instead", () => {
  const created = [];
  const service = readOnlyService((target, options) => {
    if (options.recursive) throw errno("ERR_FEATURE_UNAVAILABLE_ON_PLATFORM");
    created.push(target);
    return fakeWatcher();
  });
  try {
    assert.equal(created.length, 2);
    assert.equal(created.some((target) => target.endsWith("orchestration")), true);
  } finally {
    service.dispose();
  }
});

test("a platform that watches recursively is asked for one watcher", () => {
  const created = [];
  const service = readOnlyService((target, options) => {
    created.push({ target, recursive: options.recursive });
    return fakeWatcher();
  });
  try {
    assert.deepEqual(created.map((entry) => entry.recursive), [true]);
  } finally {
    service.dispose();
  }
});
