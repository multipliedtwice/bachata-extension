const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  readCatalogText,
  reconcilePipelineCatalogArtifacts,
  resolvePipelineScope,
  withPipelineCatalogFileLock,
  writeCatalogTextIfUnchanged,
} = require("../dist/pipeline/catalogStorage.js");

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const remove = (...values) => {
  values.forEach((value) => fs.rmSync(value, { recursive: true, force: true }));
};

test("pipeline scope matches canonical multi-root paths while preserving the display root", async () => {
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-real-"));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-link-parent-"));
  const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-second-"));
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-extension-"));
  const linkedRoot = path.join(linkParent, "linked-root");
  fs.symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  try {
    const scope = await resolvePipelineScope({
      workingDirectory: realRoot,
      workspaceRoots: [linkedRoot, secondRoot],
      extensionDirectory,
    });
    assert.equal(scope.root, path.resolve(linkedRoot));
    assert.equal(scope.canonicalRoot, fs.realpathSync(realRoot));
    assert.equal(
      scope.directory,
      path.join(fs.realpathSync(realRoot), ".bachata", "pipelines"),
    );
    assert.match(scope.key, /^workspace:/u);
  } finally {
    remove(linkParent, realRoot, secondRoot, extensionDirectory);
  }
});

test("pipeline scope ignores a configured root that is no longer in the workspace", async () => {
  const removedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-removed-"));
  const remainingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-remaining-"));
  const anotherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-another-"));
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-extension-"));
  try {
    const single = await resolvePipelineScope({
      workspaceRoots: [remainingRoot],
      configuredRoot: removedRoot,
      extensionDirectory,
    });
    assert.equal(single.root, path.resolve(remainingRoot));
    assert.equal(single.canonicalRoot, fs.realpathSync(remainingRoot));

    const multi = await resolvePipelineScope({
      workspaceRoots: [remainingRoot, anotherRoot],
      configuredRoot: removedRoot,
      extensionDirectory,
    });
    assert.equal(multi.root, undefined);
    assert.equal(multi.canonicalRoot, undefined);
    assert.equal(multi.directory, fs.realpathSync(extensionDirectory));
    assert.match(multi.key, /^extension:/u);
  } finally {
    remove(removedRoot, remainingRoot, anotherRoot, extensionDirectory);
  }
});

test("pipeline scope rejects a workspace catalog redirected outside the canonical root", async () => {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-root-"));
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-external-"));
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-extension-"));
  fs.symlinkSync(externalRoot, path.join(workspaceRoot, ".bachata"), process.platform === "win32" ? "junction" : "dir");
  try {
    await assert.rejects(
      resolvePipelineScope({
        workingDirectory: workspaceRoot,
        workspaceRoots: [workspaceRoot],
        extensionDirectory,
      }),
      /resolves outside workspace root/u,
    );
  } finally {
    remove(workspaceRoot, externalRoot, extensionDirectory);
  }
});

test("physical catalog file locks serialize independent mutation coordinators", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-lock-"));
  const scope = await resolvePipelineScope({
    workspaceRoots: [],
    extensionDirectory,
  });
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const order = [];
  try {
    const first = withPipelineCatalogFileLock(scope, async () => {
      order.push("first-start");
      firstStarted.resolve();
      await releaseFirst.promise;
      order.push("first-end");
    });
    await firstStarted.promise;
    const second = withPipelineCatalogFileLock(scope, async () => {
      order.push("second-start");
      order.push("second-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(order, ["first-start"]);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second-start", "second-end"]);
  } finally {
    releaseFirst.resolve();
    remove(extensionDirectory);
  }
});

test("catalog writes reject stale expected content", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-cas-"));
  const scope = await resolvePipelineScope({
    workspaceRoots: [],
    extensionDirectory,
  });
  const target = path.join(scope.directory, "sample.pipeline.json");
  try {
    await withPipelineCatalogFileLock(scope, () =>
      writeCatalogTextIfUnchanged(scope, target, "first\n", undefined)
    );
    await assert.rejects(
      withPipelineCatalogFileLock(scope, () =>
        writeCatalogTextIfUnchanged(scope, target, "second\n", undefined)
      ),
      /changed on disk/u,
    );
    assert.equal(await readCatalogText(scope, target), "first\n");
  } finally {
    remove(extensionDirectory);
  }
});

test("a stale-looking lock owned by a live local process is not reclaimed", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-live-lock-"));
  const scope = await resolvePipelineScope({
    workspaceRoots: [],
    extensionDirectory,
  });
  const lockPath = path.join(scope.directory, ".pipeline-catalog.lock");
  fs.mkdirSync(scope.directory, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    token: "live-owner",
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date(Date.now() - 20_000).toISOString(),
  })}\n`);
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(lockPath, old, old);
  let entered = false;
  try {
    await assert.rejects(
      withPipelineCatalogFileLock(
        scope,
        async () => {
          entered = true;
        },
        { timeoutMs: 1_000, staleMs: 10_000 },
      ),
      /Timed out waiting/u,
    );
    assert.equal(entered, false);
    assert.equal(fs.existsSync(lockPath), true);
  } finally {
    remove(extensionDirectory);
  }
});

test("an abandoned stale lock from a dead local process is reclaimed", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-dead-lock-"));
  const scope = await resolvePipelineScope({
    workspaceRoots: [],
    extensionDirectory,
  });
  const lockPath = path.join(scope.directory, ".pipeline-catalog.lock");
  fs.mkdirSync(scope.directory, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    token: "dead-owner",
    pid: 2_147_483_647,
    hostname: os.hostname(),
    createdAt: new Date(Date.now() - 20_000).toISOString(),
  })}\n`);
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(lockPath, old, old);
  try {
    const result = await withPipelineCatalogFileLock(
      scope,
      async () => "acquired",
      { timeoutMs: 1_000, staleMs: 10_000 },
    );
    assert.equal(result, "acquired");
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    remove(extensionDirectory);
  }
});


test("an active reclaim intent blocks new catalog lock ownership", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-reclaim-live-"));
  const scope = await resolvePipelineScope({
    workspaceRoots: [],
    extensionDirectory,
  });
  fs.mkdirSync(scope.directory, { recursive: true });
  const intentPath = path.join(scope.directory, ".pipeline-catalog.reclaim-test-live");
  fs.writeFileSync(intentPath, `${JSON.stringify({
    token: "live-reclaimer",
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: new Date().toISOString(),
  })}\n`);
  let entered = false;
  try {
    await assert.rejects(
      withPipelineCatalogFileLock(
        scope,
        async () => {
          entered = true;
        },
        { timeoutMs: 1_000, staleMs: 10_000 },
      ),
      /Timed out waiting/u,
    );
    assert.equal(entered, false);
    assert.equal(fs.existsSync(intentPath), true);
  } finally {
    remove(extensionDirectory);
  }
});

test("an abandoned reclaim intent is removed before catalog lock acquisition", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-reclaim-dead-"));
  const scope = await resolvePipelineScope({
    workspaceRoots: [],
    extensionDirectory,
  });
  fs.mkdirSync(scope.directory, { recursive: true });
  const intentPath = path.join(scope.directory, ".pipeline-catalog.reclaim-test-dead");
  fs.writeFileSync(intentPath, `${JSON.stringify({
    token: "dead-reclaimer",
    pid: 2_147_483_647,
    hostname: os.hostname(),
    createdAt: new Date(Date.now() - 20_000).toISOString(),
  })}\n`);
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(intentPath, old, old);
  try {
    const result = await withPipelineCatalogFileLock(
      scope,
      async () => "acquired",
      { timeoutMs: 1_000, staleMs: 10_000 },
    );
    assert.equal(result, "acquired");
    assert.equal(fs.existsSync(intentPath), false);
  } finally {
    remove(extensionDirectory);
  }
});

test("concurrent stale-lock reclaimers never overlap catalog ownership", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-reclaim-race-"));
  const scope = await resolvePipelineScope({
    workspaceRoots: [],
    extensionDirectory,
  });
  const lockPath = path.join(scope.directory, ".pipeline-catalog.lock");
  fs.mkdirSync(scope.directory, { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify({
    token: "dead-owner",
    pid: 2_147_483_647,
    hostname: os.hostname(),
    createdAt: new Date(Date.now() - 20_000).toISOString(),
  })}\n`);
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(lockPath, old, old);
  let active = 0;
  let maximumActive = 0;
  try {
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      withPipelineCatalogFileLock(
        scope,
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return index;
        },
        { timeoutMs: 3_000, staleMs: 10_000 },
      )
    ));
    assert.equal(maximumActive, 1);
    assert.equal(fs.existsSync(lockPath), false);
    assert.deepEqual(
      fs.readdirSync(scope.directory).filter((name) => name.startsWith(".pipeline-catalog.reclaim-")),
      [],
    );
  } finally {
    remove(extensionDirectory);
  }
});

test("catalog updates publish only when the exact previous content is still current", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-update-cas-"));
  const scope = await resolvePipelineScope({
    workspaceRoots: [],
    extensionDirectory,
  });
  const target = path.join(scope.directory, "sample.pipeline.json");
  try {
    await withPipelineCatalogFileLock(scope, () =>
      writeCatalogTextIfUnchanged(scope, target, "first\n", undefined)
    );
    await withPipelineCatalogFileLock(scope, () =>
      writeCatalogTextIfUnchanged(scope, target, "second\n", "first\n")
    );
    await assert.rejects(
      withPipelineCatalogFileLock(scope, () =>
        writeCatalogTextIfUnchanged(scope, target, "third\n", "first\n")
      ),
      /changed on disk/u,
    );
    assert.equal(await readCatalogText(scope, target), "second\n");
  } finally {
    remove(extensionDirectory);
  }
});


test("catalog recovery restores a staged previous version when publication did not commit", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-recovery-before-"));
  const scope = await resolvePipelineScope({ workspaceRoots: [], extensionDirectory });
  const target = path.join(scope.directory, "sample.pipeline.json");
  const transaction = "00000000-0000-4000-8000-000000000001";
  const previous = path.join(scope.directory, `.sample.pipeline.json.123.${transaction}.previous`);
  const temporary = path.join(scope.directory, `.sample.pipeline.json.123.${transaction}.tmp`);
  try {
    fs.mkdirSync(scope.directory, { recursive: true });
    fs.writeFileSync(target, "old\n");
    fs.renameSync(target, previous);
    fs.writeFileSync(temporary, "new\n");
    await reconcilePipelineCatalogArtifacts(scope);
    assert.equal(fs.readFileSync(target, "utf8"), "old\n");
    assert.equal(fs.existsSync(previous), false);
    assert.equal(fs.existsSync(temporary), false);
  } finally {
    remove(extensionDirectory);
  }
});

test("catalog recovery finalizes a replacement that already published", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-recovery-after-"));
  const scope = await resolvePipelineScope({ workspaceRoots: [], extensionDirectory });
  const target = path.join(scope.directory, "sample.pipeline.json");
  const transaction = "00000000-0000-4000-8000-000000000002";
  const previous = path.join(scope.directory, `.sample.pipeline.json.123.${transaction}.previous`);
  const temporary = path.join(scope.directory, `.sample.pipeline.json.123.${transaction}.tmp`);
  try {
    fs.mkdirSync(scope.directory, { recursive: true });
    fs.writeFileSync(previous, "old\n");
    fs.writeFileSync(temporary, "new\n");
    fs.linkSync(temporary, target);
    await reconcilePipelineCatalogArtifacts(scope);
    assert.equal(fs.readFileSync(target, "utf8"), "new\n");
    assert.equal(fs.existsSync(previous), false);
    assert.equal(fs.existsSync(temporary), false);
  } finally {
    remove(extensionDirectory);
  }
});

test("catalog recovery preserves ambiguous concurrent content", async () => {
  const extensionDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-catalog-recovery-conflict-"));
  const scope = await resolvePipelineScope({ workspaceRoots: [], extensionDirectory });
  const target = path.join(scope.directory, "sample.pipeline.json");
  const transaction = "00000000-0000-4000-8000-000000000003";
  const previous = path.join(scope.directory, `.sample.pipeline.json.123.${transaction}.previous`);
  const temporary = path.join(scope.directory, `.sample.pipeline.json.123.${transaction}.tmp`);
  try {
    fs.mkdirSync(scope.directory, { recursive: true });
    fs.writeFileSync(previous, "old\n");
    fs.writeFileSync(temporary, "intended\n");
    fs.writeFileSync(target, "other\n");
    await assert.rejects(reconcilePipelineCatalogArtifacts(scope), /concurrent content/u);
    assert.equal(fs.readFileSync(target, "utf8"), "other\n");
    assert.equal(fs.readFileSync(previous, "utf8"), "old\n");
    assert.equal(fs.readFileSync(temporary, "utf8"), "intended\n");
  } finally {
    remove(extensionDirectory);
  }
});
