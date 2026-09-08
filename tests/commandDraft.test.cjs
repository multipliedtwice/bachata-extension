const assert = require("node:assert/strict");
const test = require("node:test");
const { createCommandDraft } = require("../dist/context/commandDraft.js");

test("native command drafts have deterministic scopes and no execution instruction", () => {
  const file = createCommandDraft({ scope: "file", filePath: "/work/src/a.ts", workspaceRoot: "/work" });
  assert.match(file.prompt, /src\/a\.ts/u);
  const selection = createCommandDraft({ scope: "selection", filePath: "/work/a.ts", workspaceRoot: "/work", selection: { startLine: 2, endLine: 3, text: "const x = 1;" } });
  assert.match(selection.prompt, /a\.ts:2-3/u);
  assert.match(createCommandDraft({ scope: "stagedDiff" }).prompt, /git diff --cached/u);
  assert.throws(() => createCommandDraft({ scope: "selection", filePath: "/work/a.ts" }), /Select code/u);
});

test("workspace names beginning with dots stay workspace-relative", () => {
  const draft = createCommandDraft({ scope: "file", filePath: "/work/..foo/a.ts", workspaceRoot: "/work" });
  assert.match(draft.prompt, /\.\.foo\/a\.ts/u);
  assert.doesNotMatch(draft.prompt, /\/work\//u);
});

test("staged diff drafts name the repository they target", () => {
  const draft = createCommandDraft({ scope: "stagedDiff", workspaceRoot: "/work/service-api" });
  assert.equal(draft.title, "Review the staged Git diff in service-api");
  assert.match(draft.prompt, /repository service-api/u);
});

const {
  gitReviewCommand,
  isReviewableGitRef,
} = require("../dist/context/commandDraft.js");

test("git-native review scopes resolve to exact read-only Git commands", () => {
  assert.equal(gitReviewCommand({ scope: "stagedDiff" }), "git diff --cached");
  assert.equal(gitReviewCommand({ scope: "uncommitted" }), "git diff HEAD");
  assert.equal(
    gitReviewCommand({ scope: "branchAgainstBase", baseRef: "main", headRef: "HEAD" }),
    "git diff main...HEAD",
  );
  assert.equal(gitReviewCommand({ scope: "commit", commit: "abc1234" }), "git show abc1234");
  assert.equal(
    gitReviewCommand({ scope: "commitRange", baseRef: "v1", headRef: "v2" }),
    "git diff v1..v2",
  );
});

test("a ref that could inject an argument or a range is refused", () => {
  assert.equal(isReviewableGitRef("main"), true);
  assert.equal(isReviewableGitRef("release/1.2"), true);
  assert.equal(isReviewableGitRef("--upload-pack=evil"), false);
  assert.equal(isReviewableGitRef("main;rm -rf /"), false);
  assert.equal(isReviewableGitRef("a..b"), false);
  assert.equal(isReviewableGitRef("main.lock"), false);
  assert.equal(isReviewableGitRef(""), false);
  assert.throws(() => gitReviewCommand({ scope: "branchAgainstBase" }), /base ref is required/u);
  assert.throws(() => gitReviewCommand({ scope: "commit" }), /commit is required/u);
  assert.throws(() => gitReviewCommand({ scope: "commitRange", baseRef: "v1" }), /two reviewable Git refs/u);
});

test("every git review scope produces a titled read-only draft", () => {
  const scopes = ["stagedDiff", "uncommitted", "branchAgainstBase", "commit", "commitRange"];
  const git = { baseRef: "main", headRef: "HEAD", commit: "abc1234" };
  for (const scope of scopes) {
    const draft = createCommandDraft({ scope, workspaceRoot: "/work/repo", git });
    assert.match(draft.title, /^Review .+ in repo$/u);
    assert.match(draft.prompt, /Do not modify files/u);
    assert.match(draft.prompt, /evidence-backed findings/u);
  }
});
