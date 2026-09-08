const assert = require("node:assert/strict");
const test = require("node:test");

const {
  deriveDependencyRegion,
  dependencyRegionStatement,
} = require("../dist/context/dependencyRegion.js");
const { reviewCandidate, reviewCandidatesMatch } = require("../dist/context/reviewScope.js");

const reader = (edges = {}) => ({
  dependenciesOf: async (path) => {
    if (edges.failDependencies?.includes(path)) throw new Error("not indexed");
    return edges.dependencies?.[path] ?? [];
  },
  dependentsOf: async (path) => {
    if (edges.failDependents?.includes(path)) throw new Error("not indexed");
    return {
      paths: edges.dependents?.[path] ?? [],
      complete: !(edges.incomplete ?? []).includes(path),
    };
  },
});

test("the region is the changed paths plus their direct dependencies", async () => {
  const region = await deriveDependencyRegion({
    changed: [{ path: "src/retry.ts", status: "modified" }],
    reader: reader({ dependencies: { "src/retry.ts": ["src/clock.ts"] } }),
  });
  assert.deepEqual(region.changedPaths, ["src/retry.ts"]);
  assert.deepEqual(region.dependencyPaths, ["src/clock.ts"]);
  assert.deepEqual(region.omissions, []);
});

test("direct dependents are included and never transitive", async () => {
  const region = await deriveDependencyRegion({
    changed: [{ path: "src/retry.ts", status: "modified" }],
    reader: reader({
      dependents: { "src/retry.ts": ["src/caller.ts"], "src/caller.ts": ["src/far.ts"] },
    }),
  });
  assert.deepEqual(region.dependencyPaths, ["src/caller.ts"], "the region walked past one hop");
});

test("a rename keeps both sides of the change", async () => {
  const region = await deriveDependencyRegion({
    changed: [{ path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" }],
    reader: reader({ dependencies: { "src/new.ts": ["src/clock.ts"] } }),
  });
  assert.deepEqual(region.changedPaths, ["src/new.ts", "src/old.ts"]);
  assert.ok(region.dependencyPaths.includes("src/clock.ts"));
});

test("a deleted file stays a changed path and seeds no edges", async () => {
  const region = await deriveDependencyRegion({
    changed: [{ path: "src/gone.ts", status: "deleted" }],
    reader: reader({ dependencies: { "src/gone.ts": ["src/clock.ts"] } }),
  });
  assert.deepEqual(region.changedPaths, ["src/gone.ts"]);
  assert.deepEqual(region.dependencyPaths, [], "a deleted file was resolved into edges");
});

test("unsupported and binary paths stay changed paths with no invented edges", async () => {
  const region = await deriveDependencyRegion({
    changed: [
      { path: "media/icon.png", status: "binary" },
      { path: "docs/GUIDE.md", status: "modified" },
      { path: "src/main.rs", status: "modified" },
    ],
    reader: reader({ dependencies: { "src/main.rs": ["src/lib.rs"] } }),
  });
  assert.deepEqual(region.changedPaths, ["docs/GUIDE.md", "media/icon.png", "src/main.rs"]);
  assert.deepEqual(region.dependencyPaths, [], "an unsupported path produced graph edges");
  assert.ok(region.omissions.some((entry) =>
    entry.path === "src/main.rs" && entry.reason === "unsupportedLanguage"));
});

test("an unavailable graph keeps the changed paths and states the omission", async () => {
  const region = await deriveDependencyRegion({
    changed: [{ path: "src/retry.ts", status: "modified" }],
  });
  assert.deepEqual(region.changedPaths, ["src/retry.ts"], "changed paths were lost with the graph");
  assert.deepEqual(region.dependencyPaths, []);
  assert.deepEqual(region.omissions, [{ path: "src/retry.ts", reason: "graphUnavailable" }]);
});

test("a truncated dependent scan states the omission and keeps what it found", async () => {
  const region = await deriveDependencyRegion({
    changed: [{ path: "src/retry.ts", status: "modified" }],
    reader: reader({
      dependents: { "src/retry.ts": ["src/caller.ts"] },
      incomplete: ["src/retry.ts"],
    }),
  });
  assert.deepEqual(region.dependencyPaths, ["src/caller.ts"]);
  assert.ok(region.omissions.some((entry) => entry.reason === "scanIncomplete"));
});

test("a path the index cannot read is an omission, not a guess", async () => {
  const region = await deriveDependencyRegion({
    changed: [{ path: "src/retry.ts", status: "modified" }],
    reader: reader({ failDependencies: ["src/retry.ts"] }),
  });
  assert.deepEqual(region.dependencyPaths, []);
  assert.deepEqual(region.omissions, [{ path: "src/retry.ts", reason: "notIndexed" }]);
});

test("the region is canonically ordered and deduplicated", async () => {
  const region = await deriveDependencyRegion({
    changed: [
      { path: "src/b.ts", status: "modified" },
      { path: "src/a.ts", status: "modified" },
      { path: "src/a.ts", status: "modified" },
    ],
    reader: reader({
      dependencies: { "src/a.ts": ["src/z.ts", "src/m.ts"], "src/b.ts": ["src/m.ts"] },
    }),
  });
  assert.deepEqual(region.changedPaths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(region.dependencyPaths, ["src/m.ts", "src/z.ts"]);
});

test("a changed graph changes the candidate digest", async () => {
  const before = await deriveDependencyRegion({
    changed: [{ path: "src/retry.ts", status: "modified" }],
    reader: reader({ dependencies: { "src/retry.ts": ["src/clock.ts"] } }),
  });
  const after = await deriveDependencyRegion({
    changed: [{ path: "src/retry.ts", status: "modified" }],
    reader: reader({ dependencies: { "src/retry.ts": ["src/clock.ts", "src/timer.ts"] } }),
  });
  const candidateFor = (region) => reviewCandidate({
    scope: "uncommitted",
    paths: region.changedPaths,
    dependencyRegion: region.dependencyPaths,
    regionOmissions: region.omissions,
  });
  assert.equal(
    reviewCandidatesMatch(candidateFor(before), candidateFor(after)),
    false,
    "a different dependency region produced the same candidate",
  );
  assert.equal(
    reviewCandidatesMatch(candidateFor(before), candidateFor(before)),
    true,
    "the same region did not reproduce the same candidate",
  );
});

test("omissions are part of the candidate identity", async () => {
  const complete = reviewCandidate({ scope: "uncommitted", paths: ["src/a.ts"] });
  const withOmission = reviewCandidate({
    scope: "uncommitted",
    paths: ["src/a.ts"],
    regionOmissions: [{ path: "src/a.ts", reason: "scanIncomplete" }],
  });
  assert.equal(
    reviewCandidatesMatch(complete, withOmission),
    false,
    "a review that omitted part of the region looked identical to a complete one",
  );
});

test("exported evidence separates changed paths from affected dependency paths", async () => {
  const region = await deriveDependencyRegion({
    changed: [{ path: "src/retry.ts", status: "modified" }],
    reader: reader({ dependents: { "src/retry.ts": ["src/caller.ts"] } }),
  });
  const statement = dependencyRegionStatement(region);
  assert.match(statement, /1 changed path: src\/retry\.ts/u);
  assert.match(statement, /1 affected dependency path: src\/caller\.ts/u);
  assert.match(statement, /No path was omitted/u);
});

test("two roots derive independent regions from their own paths", async () => {
  const first = await deriveDependencyRegion({
    changed: [{ path: "src/a.ts", status: "modified" }],
    reader: reader({ dependencies: { "src/a.ts": ["src/one.ts"] } }),
  });
  const second = await deriveDependencyRegion({
    changed: [{ path: "src/a.ts", status: "modified" }],
    reader: reader({ dependencies: { "src/a.ts": ["src/two.ts"] } }),
  });
  assert.deepEqual(first.dependencyPaths, ["src/one.ts"]);
  assert.deepEqual(second.dependencyPaths, ["src/two.ts"]);
});
