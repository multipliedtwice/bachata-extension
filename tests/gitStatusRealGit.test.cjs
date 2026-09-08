const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const run = promisify(execFile);
const { execFileSync } = require("node:child_process");
const { parsePorcelainDirtyPaths } = require("../dist/readiness/gitStatus.js");
const { evaluateReadiness } = require("../dist/readiness/model.js");
const { evaluateGitVersionSupport } = require("../dist/process/gitVersionSupport.js");

const gitSupport = (() => {
  try {
    return evaluateGitVersionSupport(execFileSync("git", ["--version"], { encoding: "utf8" }));
  } catch (error) {
    return { supported: false, requirementText: `Git is unavailable: ${String(error)}` };
  }
})();

const gitOnly = { skip: gitSupport.supported ? false : gitSupport.requirementText };
const posixNamesOnly = {
  skip: process.platform === "win32"
    ? "Quote and newline characters are not legal in Windows filenames"
    : gitOnly.skip,
};

const checklistPipeline = {
  id: "custom-checklist",
  name: "Custom checklist",
  agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
  steps: [{ id: "execute", name: "Execute", enabled: true, type: "executeChecklist", participants: [] }],
};

const readinessFor = (dirtyPaths, allowedDirtyPaths = [".bachata/pipelines"]) => evaluateReadiness({
  workspace: {
    trusted: true,
    roots: ["/work"],
    gitAvailable: true,
    gitClean: dirtyPaths.length === 0,
    dirtyPaths,
  },
  allowedDirtyPaths,
  adapters: [{ agentId: "codex", type: "codex-app-server", available: true, capabilities: [] }],
  bridge: { enabled: false, connected: false, sessions: [] },
  catalog: [checklistPipeline],
  selectedPipelineId: "custom-checklist",
  codexWorkspaceScope: "wholeWorkingDirectory",
});

const statusOf = async (root) => {
  const { stdout } = await run(
    "git",
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { cwd: root, encoding: "utf8" },
  );
  return stdout;
};

test("real Git -z output keeps non-ASCII names and rename sources, and readiness still blocks", gitOnly, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-git-status-"));
  try {
    await run("git", ["init"], { cwd: root });
    await run("git", ["config", "user.email", "bachata@example.invalid"], { cwd: root });
    await run("git", ["config", "user.name", "Bachata"], { cwd: root });
    await fs.mkdir(path.join(root, ".bachata", "pipelines"), { recursive: true });
    await fs.writeFile(path.join(root, ".bachata", "pipelines", "allowed.pipeline.json"), "{}\n");

    const allowedOnly = parsePorcelainDirtyPaths(await statusOf(root));
    assert.deepEqual(allowedOnly, [".bachata/pipelines/allowed.pipeline.json"]);
    assert.equal(readinessFor(allowedOnly).status, "ready");

    const unicodeName = "présent αβγ.ts";
    await fs.writeFile(path.join(root, unicodeName), "x");
    const withUnicode = parsePorcelainDirtyPaths(await statusOf(root));
    assert.ok(
      withUnicode.includes(unicodeName),
      `non-ASCII name was escaped: ${JSON.stringify(withUnicode)}`,
    );
    assert.equal(readinessFor(withUnicode).status, "blocked");
    await fs.rm(path.join(root, unicodeName));

    await run("git", ["add", "."], { cwd: root });
    await run("git", ["commit", "-m", "baseline"], { cwd: root });
    await run(
      "git",
      ["mv", ".bachata/pipelines/allowed.pipeline.json", "moved-out.json"],
      { cwd: root },
    );
    const renamed = parsePorcelainDirtyPaths(await statusOf(root));
    assert.ok(renamed.includes("moved-out.json"));
    assert.ok(
      renamed.includes(".bachata/pipelines/allowed.pipeline.json"),
      `rename source was dropped: ${JSON.stringify(renamed)}`,
    );
    assert.equal(readinessFor(renamed).status, "blocked");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("real Git -z keeps quote, arrow, and newline characters that belong to a pathname", posixNamesOnly, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-git-quoted-"));
  try {
    await run("git", ["init"], { cwd: root });
    await run("git", ["config", "user.email", "bachata@example.invalid"], { cwd: root });
    await run("git", ["config", "user.name", "Bachata"], { cwd: root });

    const quotedName = `"${".bachata"}"`;
    await fs.writeFile(path.join(root, quotedName), "x");
    const dirty = parsePorcelainDirtyPaths(await statusOf(root));

    assert.deepEqual(dirty, [quotedName], "literal quote characters were altered");
    assert.equal(dirty.includes(".bachata"), false);
    assert.equal(readinessFor(dirty, [".bachata"]).status, "blocked");

    await fs.rm(path.join(root, quotedName));

    const arrowDirectory = "nested -> .bachata/pipelines";
    await fs.mkdir(path.join(root, arrowDirectory), { recursive: true });
    await fs.writeFile(path.join(root, arrowDirectory, "x.pipeline.json"), "{}");
    const withArrow = parsePorcelainDirtyPaths(await statusOf(root));
    assert.deepEqual(
      withArrow,
      [`${arrowDirectory}/x.pipeline.json`],
      "an ordinary arrow in a pathname was treated as a rename separator",
    );
    assert.equal(withArrow.includes(".bachata/pipelines/x.pipeline.json"), false);
    assert.equal(readinessFor(withArrow, [".bachata/pipelines"]).status, "blocked");
    await fs.rm(path.join(root, "nested -> .bachata"), { recursive: true });

    const newlineName = "line\nbreak.ts";
    await fs.writeFile(path.join(root, newlineName), "x");
    const withNewline = parsePorcelainDirtyPaths(await statusOf(root));
    assert.ok(
      withNewline.includes(newlineName),
      `embedded newline was escaped or split: ${JSON.stringify(withNewline)}`,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});


const { captureCycleBaseline } = require("../dist/longitudinal/repositoryBaseline.js");

const withRepository = async (body) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-baseline-repo-"));
  try {
    await run("git", ["init", "-q", "."], { cwd: root });
    await run("git", ["config", "user.email", "bachata@example.invalid"], { cwd: root });
    await run("git", ["config", "user.name", "Bachata"], { cwd: root });
    await body(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
};

test("a deleted path that reappears changes the candidate", gitOnly, async () => {
  await withRepository(async (root) => {
    await fs.writeFile(path.join(root, "f.txt"), "original\n", "utf8");
    await fs.writeFile(path.join(root, "keep.txt"), "other\n", "utf8");
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["commit", "-qm", "base"], { cwd: root });
    await fs.rm(path.join(root, "f.txt"));

    const deleted = await captureCycleBaseline(root, "t1");
    assert.equal(
      deleted.contentComplete,
      true,
      "an ordinary unstaged deletion made the candidate incomplete",
    );
    assert.equal(deleted.dirty, true);

    await fs.writeFile(path.join(root, "f.txt"), "a different body\n", "utf8");
    const back = await captureCycleBaseline(root, "t2");
    assert.notEqual(
      deleted.worktreeDigest,
      back.worktreeDigest,
      "a deleted path that reappeared left the candidate unchanged",
    );

    await fs.rm(path.join(root, "f.txt"));
    const again = await captureCycleBaseline(root, "t3");
    assert.equal(
      deleted.worktreeDigest,
      again.worktreeDigest,
      "re-deleting the path did not return the candidate to its earlier value",
    );
  });
});

test("editing a conflicted file that the other side deleted changes the candidate", gitOnly, async () => {
  await withRepository(async (root) => {
    await fs.writeFile(path.join(root, "f.txt"), "base\n", "utf8");
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["commit", "-qm", "base"], { cwd: root });
    const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root }))
      .stdout.trim();

    await run("git", ["checkout", "-q", "-b", "theirs"], { cwd: root });
    await run("git", ["rm", "-q", "f.txt"], { cwd: root });
    await run("git", ["commit", "-qm", "delete"], { cwd: root });
    await run("git", ["checkout", "-q", branch], { cwd: root });
    await fs.writeFile(path.join(root, "f.txt"), "ours\n", "utf8");
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["commit", "-qm", "edit"], { cwd: root });
    await run("git", ["merge", "theirs"], { cwd: root }).catch(() => undefined);

    const status = (await run(
      "git",
      ["status", "--porcelain=v1"],
      { cwd: root },
    )).stdout;
    assert.match(status, /^UD /mu, "the fixture did not produce a modify/delete conflict");

    const before = await captureCycleBaseline(root, "t1");
    assert.equal(before.contentComplete, true);
    await fs.writeFile(path.join(root, "f.txt"), "ours, edited\n", "utf8");
    const after = await captureCycleBaseline(root, "t2");
    assert.notEqual(
      before.worktreeDigest,
      after.worktreeDigest,
      "an edit to a conflicted file left the candidate unchanged",
    );
  });
});

test("a workspace inside a repository subdirectory yields the repository candidate", gitOnly, async () => {
  await withRepository(async (root) => {
    const nested = path.join(root, "packages", "app");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "index.ts"), "export const a = 1;\n", "utf8");
    await run("git", ["add", "-A"], { cwd: root });
    await run("git", ["commit", "-qm", "base"], { cwd: root });
    await fs.writeFile(path.join(nested, "index.ts"), "export const a = 2;\n", "utf8");

    const fromRoot = await captureCycleBaseline(root, "t1");
    const fromNested = await captureCycleBaseline(nested, "t1");

    assert.equal(
      fromNested.contentComplete,
      true,
      "a subdirectory workspace could not hash repository-root-relative paths",
    );
    assert.equal(
      fromRoot.worktreeDigest,
      fromNested.worktreeDigest,
      "the same candidate produced different digests from a subdirectory",
    );
    assert.equal(fromRoot.commit, fromNested.commit);
  });
});
