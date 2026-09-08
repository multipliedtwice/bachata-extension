const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  PIPELINE_CATALOG_REFRESH_DEBOUNCE_MS,
  catalogMutationFailure,
  catalogOwnershipIdentity,
  catalogRefreshFailureMessages,
  catalogRefreshSchedule,
  catalogWatchPatterns,
} = require("../dist/conversations/pipelineCatalogCoordination.js");
const { chainSerially } = require("../dist/state/serialQueue.js");

test("two spellings of one Windows directory are one owner", () => {
  assert.equal(
    catalogOwnershipIdentity("C:\\Repo\\.bachata\\pipelines", "win32"),
    catalogOwnershipIdentity("c:\\repo\\.BACHATA\\Pipelines", "win32"),
  );
});

test("elsewhere the path is kept as written, because two spellings are two directories", () => {
  const lower = catalogOwnershipIdentity("/repo/.bachata/pipelines", "darwin");
  const upper = catalogOwnershipIdentity("/repo/.BACHATA/pipelines", "darwin");
  assert.notEqual(lower, upper);
  assert.equal(lower, path.resolve("/repo/.bachata/pipelines"));
  assert.equal(catalogOwnershipIdentity("/repo/x", "linux"), path.resolve("/repo/x"));
});

test("a clean mutation reports nothing", () => {
  assert.equal(catalogMutationFailure({}), undefined);
});

test("a failed write is reported on its own", () => {
  const operationError = new Error("write refused");
  assert.equal(catalogMutationFailure({ operationError }), operationError);
});

test("a release that could not be confirmed is reported even when the write succeeded", () => {
  const releaseError = new Error("release refused");
  assert.equal(catalogMutationFailure({ releaseError }), releaseError);
});

test("both failures travel together rather than one hiding the other", () => {
  const operationError = new Error("write refused");
  const releaseError = new Error("release refused");
  const failure = catalogMutationFailure({ operationError, releaseError });
  assert.ok(failure instanceof AggregateError);
  assert.equal(failure.message, "Pipeline catalog mutation failed and ownership cleanup also failed");
  assert.deepEqual(failure.errors, [operationError, releaseError]);
});

test("a disposed manager schedules no refresh and cancels nothing", () => {
  assert.deepEqual(catalogRefreshSchedule({ disposed: true, refreshPending: true }), {
    schedule: false,
    cancelPending: false,
  });
});

test("a burst of file events collapses into one refresh", () => {
  assert.deepEqual(catalogRefreshSchedule({ disposed: false, refreshPending: false }), {
    schedule: true,
    cancelPending: false,
  });
  assert.deepEqual(catalogRefreshSchedule({ disposed: false, refreshPending: true }), {
    schedule: true,
    cancelPending: true,
  });
  assert.equal(PIPELINE_CATALOG_REFRESH_DEBOUNCE_MS, 100);
});

test("every workspace root's catalog is watched, plus the shared one", () => {
  assert.deepEqual(
    catalogWatchPatterns({
      workspaceRoots: ["/a", "/b"],
      sharedDirectory: "/storage/pipelines",
    }),
    [
      { base: "/a", glob: ".bachata/pipelines/*.pipeline.json" },
      { base: "/b", glob: ".bachata/pipelines/*.pipeline.json" },
      { base: "/storage/pipelines", glob: "*.pipeline.json" },
    ],
  );
});

test("a root listed twice is watched once, so one write is one event", () => {
  assert.deepEqual(
    catalogWatchPatterns({ workspaceRoots: ["/a", "/a"], sharedDirectory: "/s" }).map(
      (pattern) => pattern.base,
    ),
    ["/a", "/s"],
  );
});

test("with no workspace open the shared catalog is still watched", () => {
  assert.deepEqual(catalogWatchPatterns({ workspaceRoots: [], sharedDirectory: "/s" }), [
    { base: "/s", glob: "*.pipeline.json" },
  ]);
});

test("each runtime that failed to reload is reported on its own", () => {
  assert.deepEqual(
    catalogRefreshFailureMessages([
      { status: "fulfilled", value: undefined },
      { status: "rejected", reason: new Error("catalog unreadable") },
      { status: "rejected", reason: "gone" },
    ]),
    [
      "Pipeline catalog refresh failed: catalog unreadable",
      "Pipeline catalog refresh failed: gone",
    ],
  );
});

test("a sweep where every runtime reloaded says nothing", () => {
  assert.deepEqual(catalogRefreshFailureMessages([{ status: "fulfilled", value: 1 }]), []);
});

test("serialized operations run one at a time, in order", async () => {
  const order = [];
  let queue = Promise.resolve();
  const run = (label, delayMs) => {
    const link = chainSerially(queue, async () => {
      order.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      order.push(`${label}:end`);
      return label;
    });
    queue = link.settled;
    return link.result;
  };
  const first = run("a", 20);
  const second = run("b", 1);
  assert.deepEqual(await Promise.all([first, second]), ["a", "b"]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
});

test("a rejection reaches the caller and does not refuse the next operation", async () => {
  let queue = Promise.resolve();
  const run = (operation) => {
    const link = chainSerially(queue, operation);
    queue = link.settled;
    return link.result;
  };
  const failingLink = chainSerially(queue, async () => {
    throw new Error("refused");
  });
  queue = failingLink.settled;
  const following = run(async () => "ran anyway");
  await assert.rejects(failingLink.result, /refused/u);
  assert.equal(await failingLink.settled, undefined);
  assert.equal(await following, "ran anyway");
});
