const assert = require("node:assert/strict");
const { appendFile, mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const vm = require("node:vm");

const {
  createWorkspaceMutationFence,
} = require("../dist/state/workspaceMutationFence.js");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

test("a newer workspace writer waits for an authorized commit and fences later stale mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-workspace-mutation-fence-"));
  const target = path.join(root, "state.txt");
  const first = await createWorkspaceMutationFence(root, { resourceKey: "workspace-state-writer:test", token: 1 });
  const entered = deferred();
  const release = deferred();
  let second;
  try {
    const firstCommit = first.run(async () => {
      entered.resolve();
      await release.promise;
      await appendFile(target, "first\n", "utf8");
    });
    await entered.promise;

    let secondActivated = false;
    const secondActivation = createWorkspaceMutationFence(root, {
      resourceKey: "workspace-state-writer:test",
      token: 2,
    }).then((value) => {
      secondActivated = true;
      second = value;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(secondActivated, false);

    release.resolve();
    await firstCommit;
    await secondActivation;

    await assert.rejects(
      first.run(() => appendFile(target, "stale\n", "utf8")),
      /workspace writer lease is stale/u,
    );
    await second.run(() => appendFile(target, "second\n", "utf8"));
    assert.equal(await readFile(target, "utf8"), "first\nsecond\n");
  } finally {
    release.resolve();
    await first.dispose().catch(() => undefined);
    await second?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a valid writer can recover after the broker fencing sequence is reset", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-workspace-mutation-reset-"));
  const target = path.join(root, "state.txt");
  const previous = await createWorkspaceMutationFence(root, {
    resourceKey: "workspace-state-writer:test",
    token: 9,
  });
  let replacement;
  try {
    replacement = await createWorkspaceMutationFence(root, {
      resourceKey: "workspace-state-writer:test",
      token: 1,
      assertWritable: () => undefined,
    });
    await assert.rejects(
      previous.run(() => appendFile(target, "stale\n", "utf8")),
      /workspace writer lease is stale/u,
    );
    await replacement.run(() => appendFile(target, "replacement\n", "utf8"));
    assert.equal(await readFile(target, "utf8"), "replacement\n");
  } finally {
    await previous.dispose().catch(() => undefined);
    await replacement?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("a delayed stale writer cannot reactivate an older token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-workspace-mutation-stale-"));
  const current = await createWorkspaceMutationFence(root, {
    resourceKey: "workspace-state-writer:test",
    token: 2,
  });
  try {
    await assert.rejects(
      createWorkspaceMutationFence(root, {
        resourceKey: "workspace-state-writer:test",
        token: 1,
        assertWritable: () => {
          throw new Error("Shared-resource lease ownership was replaced or expired");
        },
      }),
      /ownership was replaced or expired/u,
    );
    await current.run(() => appendFile(path.join(root, "state.txt"), "current\n", "utf8"));
  } finally {
    await current.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});


test("workspace mutation fencing distinguishes equal tokens from different resource identities", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-workspace-mutation-identity-"));
  const target = path.join(root, "state.txt");
  const first = await createWorkspaceMutationFence(root, {
    resourceKey: "workspace-state-writer:first",
    token: 1,
  });
  let second;
  try {
    second = await createWorkspaceMutationFence(root, {
      resourceKey: "workspace-state-writer:second",
      token: 1,
    });
    await assert.rejects(
      first.run(() => appendFile(target, "stale\n", "utf8")),
      /workspace writer lease is stale/u,
    );
    await second.run(() => appendFile(target, "current\n", "utf8"));
    assert.equal(await readFile(target, "utf8"), "current\n");
  } finally {
    await first.dispose().catch(() => undefined);
    await second?.dispose().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});


test("rejected fence activation closes its database before returning the original failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bachata-workspace-mutation-rejected-"));
  const filename = require.resolve("../dist/state/workspaceMutationFence.js");
  const requireModule = createRequire(filename);
  const sqlite = requireModule("./sqlite");
  const databases = [];
  const scopedModule = { exports: {} };
  vm.runInNewContext(readFileSync(filename, "utf8"), {
    exports: scopedModule.exports,
    require: (name) => name === "./sqlite" ? {
      ...sqlite,
      openSqliteDatabase: (...args) => {
        const database = sqlite.openSqliteDatabase(...args);
        databases.push(database);
        return database;
      },
    } : requireModule(name),
  }, { filename });
  try {
    for (const rejectedCheck of [1, 2]) {
      let checks = 0;
      const original = new Error(`writer replaced at activation check ${String(rejectedCheck)}`);
      await assert.rejects(scopedModule.exports.createWorkspaceMutationFence(root, {
        resourceKey: "workspace-state-writer:test",
        token: 1,
        assertWritable: () => {
          checks += 1;
          if (checks === rejectedCheck) throw original;
        },
      }), (error) => error === original);
      assert.equal(checks, rejectedCheck);
      assert.equal(databases.length, rejectedCheck);
      assert.throws(() => databases.at(-1).prepare("SELECT 1"), /database is not open/u);
    }
  } finally {
    for (const database of databases) {
      try { database.close(); } catch { /* Already closed. */ }
    }
    await rm(root, { recursive: true, force: true });
  }
});
