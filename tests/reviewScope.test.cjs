const assert = require("node:assert/strict");
const test = require("node:test");

const {
  reviewCandidate,
  reviewCandidatesMatch,
  reviewScopeStatement,
} = require("../dist/context/reviewScope.js");

test("every delta scope produces its own exact candidate identity", () => {
  const candidates = [
    reviewCandidate({ scope: "stagedDiff" }),
    reviewCandidate({ scope: "uncommitted" }),
    reviewCandidate({ scope: "branchAgainstBase", git: { baseRef: "main", headRef: "HEAD" } }),
    reviewCandidate({ scope: "commit", git: { commit: "abc123" } }),
    reviewCandidate({ scope: "commitRange", git: { baseRef: "abc123", headRef: "def456" } }),
  ];
  const digests = new Set(candidates.map((candidate) => candidate.inputDigest));
  assert.equal(digests.size, 5, "two different delta scopes shared one candidate identity");
  candidates.forEach((candidate) => {
    assert.equal(candidate.comprehensive, false, "a delta review claimed to be comprehensive");
    assert.ok(candidate.source.length > 0);
  });
});

test("a different base or commit is a different candidate", () => {
  const first = reviewCandidate({ scope: "branchAgainstBase", git: { baseRef: "main", headRef: "HEAD" } });
  const second = reviewCandidate({ scope: "branchAgainstBase", git: { baseRef: "release", headRef: "HEAD" } });
  assert.equal(reviewCandidatesMatch(first, second), false);
  assert.equal(
    reviewCandidatesMatch(first, reviewCandidate({
      scope: "branchAgainstBase",
      git: { baseRef: "main", headRef: "HEAD" },
    })),
    true,
    "the same scope did not reproduce the same candidate",
  );
});

test("changed paths and the dependency region are part of the identity", () => {
  const base = reviewCandidate({ scope: "stagedDiff", paths: ["src/a.ts"] });
  const moved = reviewCandidate({ scope: "stagedDiff", paths: ["src/a.ts", "src/b.ts"] });
  assert.equal(
    reviewCandidatesMatch(base, moved),
    false,
    "the repository moved underneath the review and the evidence stayed current",
  );
  const withRegion = reviewCandidate({
    scope: "stagedDiff",
    paths: ["src/a.ts"],
    dependencyRegion: ["src/uses-a.ts"],
  });
  assert.equal(reviewCandidatesMatch(base, withRegion), false);
  assert.deepEqual(withRegion.dependencyRegion, ["src/uses-a.ts"]);
});

test("path order never changes identity, but path content does", () => {
  const one = reviewCandidate({ scope: "uncommitted", paths: ["src/b.ts", "src/a.ts"] });
  const two = reviewCandidate({ scope: "uncommitted", paths: ["src/a.ts", "src/b.ts"] });
  assert.equal(reviewCandidatesMatch(one, two), true, "path order changed the candidate");
});

test("renamed, deleted and binary paths stay exact", () => {
  const candidate = reviewCandidate({
    scope: "uncommitted",
    paths: ["old name.ts -> new name.ts", "deleted.ts", "media/icon.png"],
  });
  assert.deepEqual(candidate.paths, ["deleted.ts", "media/icon.png", "old name.ts -> new name.ts"]);
  assert.match(reviewScopeStatement(candidate), /old name\.ts -> new name\.ts/u);
});

test("exported evidence states the exact reviewed scope and never implies comprehensiveness", () => {
  const statement = reviewScopeStatement(reviewCandidate({
    scope: "commit",
    git: { commit: "abc123" },
    paths: ["src/a.ts"],
    dependencyRegion: ["src/uses-a.ts"],
  }));
  assert.match(statement, /Scope: commit/u);
  assert.match(statement, /not a comprehensive fresh review/u);
  assert.match(statement, /1 path in scope: src\/a\.ts/u);
  assert.match(statement, /affected dependency region: src\/uses-a\.ts/u);
  assert.match(statement, /Input digest: [0-9a-f]{64}/u);
});

test("an empty scope says so rather than implying nothing changed was reviewed", () => {
  const statement = reviewScopeStatement(reviewCandidate({ scope: "stagedDiff" }));
  assert.match(statement, /No changed path was recorded/u);
  assert.match(statement, /No dependency region was included/u);
});

test("two repositories with the same scope are distinguished by their own paths", () => {
  const first = reviewCandidate({ scope: "uncommitted", paths: ["/work/a/src/x.ts"] });
  const second = reviewCandidate({ scope: "uncommitted", paths: ["/work/b/src/x.ts"] });
  assert.equal(reviewCandidatesMatch(first, second), false, "two roots shared one candidate");
});
