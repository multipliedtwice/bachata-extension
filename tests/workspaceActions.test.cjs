const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  createBrowserActionCandidate,
} = require("../dist/browser/actions.js");
const {
  executeBrowserAction,
} = require("../dist/browser/workspaceActions.js");

const action = (value) => createBrowserActionCandidate({
  risk: value.kind === "workspace.delete" ? "destructive" : "mutating",
  origin: "structured",
  confidence: "explicit",
  source: { start: 0, end: 1, text: "x" },
  ...value,
});

const options = (workingDirectory, signal = new AbortController().signal, mutationContext) => ({
  workingDirectory,
  signal,
  timeoutMs: 2_000,
  terminateGraceMs: 500,
  maxOutputBytes: 16_384,
  maxReadBytes: 16_384,
  maxSearchResults: 100,
  ...(mutationContext ? { mutationContext } : {}),
});

const sha256File = async (directory, relativePath) =>
  createHash("sha256").update(await fs.readFile(path.join(directory, relativePath))).digest("hex");

const expectedFilesFor = async (directory, paths) =>
  Promise.all(paths.map(async (relativePath) => ({
    path: relativePath,
    sha256: await sha256File(directory, relativePath),
  })));

const temporaryDirectory = async () => fs.mkdtemp(path.join(os.tmpdir(), "bachata-workspace-actions-"));

const removeDirectory = async (directory) => {
  await fs.rm(directory, { recursive: true, force: true });
};

test("an already-aborted write performs no side effects", async () => {
  const directory = await temporaryDirectory();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await executeBrowserAction(
      action({ kind: "workspace.write", path: "created.txt", content: "created" }),
      options(directory, controller.signal),
    );
    assert.equal(result.status, "failed");
    assert.match(result.stderr, /interrupted/);
    await assert.rejects(fs.stat(path.join(directory, "created.txt")), /ENOENT/);
  } finally {
    await removeDirectory(directory);
  }
});

test("an already-aborted shell command is never started", async () => {
  const directory = await temporaryDirectory();
  try {
    const controller = new AbortController();
    controller.abort();
    const result = await executeBrowserAction(
      action({ kind: "shell.run", command: "printf started > started.txt" }),
      options(directory, controller.signal),
    );
    assert.equal(result.status, "failed");
    assert.match(result.stderr, /interrupted/);
    await assert.rejects(fs.stat(path.join(directory, "started.txt")), /ENOENT/);
  } finally {
    await removeDirectory(directory);
  }
});

test("deleting a symlink removes only the requested link", async () => {
  const directory = await temporaryDirectory();
  try {
    const target = path.join(directory, "target");
    const link = path.join(directory, "link");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "kept.txt"), "kept");
    await fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
    const result = await executeBrowserAction(
      action({ kind: "workspace.delete", path: "link", recursive: false }),
      options(directory),
    );
    assert.equal(result.status, "completed");
    await assert.rejects(fs.lstat(link), /ENOENT/);
    assert.equal(await fs.readFile(path.join(target, "kept.txt"), "utf8"), "kept");
  } finally {
    await removeDirectory(directory);
  }
});

test("workspace writes cannot follow symbolic-link leaves", async () => {
  const directory = await temporaryDirectory();
  try {
    const target = path.join(directory, "target.txt");
    await fs.writeFile(target, "original");
    await fs.symlink(target, path.join(directory, "link.txt"), "file");
    const result = await executeBrowserAction(
      action({ kind: "workspace.write", path: "link.txt", content: "changed" }),
      options(directory),
    );
    assert.equal(result.status, "failed");
    assert.match(result.stderr, /cannot write through symbolic links/);
    assert.equal(await fs.readFile(target, "utf8"), "original");
  } finally {
    await removeDirectory(directory);
  }
});

test("workspace reads block credential files and searches omit them", async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(path.join(directory, ".env"), "SECRET=hidden");
    await fs.writeFile(path.join(directory, "source.ts"), "const visible = 'needle';");
    const read = await executeBrowserAction(
      action({ kind: "workspace.read", path: ".env" }),
      options(directory),
    );
    assert.equal(read.status, "failed");
    assert.match(read.stderr, /Restricted path is not allowed|credential, VCS, dependency, or generated paths/);
    const search = await executeBrowserAction(
      action({ kind: "workspace.search", path: ".", query: "hidden" }),
      options(directory),
    );
    assert.equal(search.status, "completed");
    assert.equal(search.stdout, "No matches");
  } finally {
    await removeDirectory(directory);
  }
});


test("workspace listings omit sensitive, VCS, dependency, and generated paths", async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.mkdir(path.join(directory, ".git"));
    await fs.mkdir(path.join(directory, ".ssh"));
    await fs.mkdir(path.join(directory, "node_modules", "pkg"), { recursive: true });
    await fs.mkdir(path.join(directory, "dist"));
    await fs.mkdir(path.join(directory, "build"));
    await fs.mkdir(path.join(directory, "coverage"));
    await fs.mkdir(path.join(directory, "src"));
    await fs.writeFile(path.join(directory, ".env"), "SECRET=hidden");
    await fs.writeFile(path.join(directory, ".git", "config"), "config");
    await fs.writeFile(path.join(directory, ".ssh", "id_rsa"), "key");
    await fs.writeFile(path.join(directory, "node_modules", "pkg", "index.js"), "module");
    await fs.writeFile(path.join(directory, "dist", "bundle.js"), "dist");
    await fs.writeFile(path.join(directory, "build", "bundle.js"), "build");
    await fs.writeFile(path.join(directory, "coverage", "coverage.json"), "coverage");
    await fs.writeFile(path.join(directory, "src", "index.ts"), "visible");

    const listed = await executeBrowserAction(
      action({ kind: "workspace.list", path: ".", recursive: true }),
      options(directory),
    );
    assert.equal(listed.status, "completed");
    assert.match(listed.stdout, /src\/index\.ts/);
    for (const hidden of [
      ".env",
      ".git",
      ".ssh",
      "node_modules",
      "dist",
      "build",
      "coverage",
    ]) {
      assert.equal(listed.stdout.includes(hidden), false, hidden);
    }

    for (const restricted of [".env", ".git", ".ssh", "node_modules", "dist"]) {
      const direct = await executeBrowserAction(
        action({ kind: "workspace.list", path: restricted, recursive: true }),
        options(directory),
      );
      assert.equal(direct.status, "failed");
      assert.match(direct.stderr, /Restricted path is not allowed|Resolved path is restricted|cannot inspect credential, VCS, dependency, or generated paths/);
    }
  } finally {
    await removeDirectory(directory);
  }
});


test("workspace read and search reject VCS, dependency, and generated paths", async () => {
  const directory = await temporaryDirectory();
  try {
    const restricted = [".git", "node_modules", "dist", "build", "coverage"];
    for (const name of restricted) {
      await fs.mkdir(path.join(directory, name), { recursive: true });
      await fs.writeFile(path.join(directory, name, "value.txt"), "restricted needle");
      const read = await executeBrowserAction(
        action({ kind: "workspace.read", path: `${name}/value.txt` }),
        options(directory),
      );
      assert.equal(read.status, "failed", name);
      assert.match(read.stderr, /Restricted path is not allowed|Resolved path is restricted|cannot inspect credential, VCS, dependency, or generated paths/);
      const search = await executeBrowserAction(
        action({ kind: "workspace.search", path: name, query: "needle" }),
        options(directory),
      );
      assert.equal(search.status, "failed", name);
      assert.match(search.stderr, /Restricted path is not allowed|Resolved path is restricted|cannot inspect credential, VCS, dependency, or generated paths/);
    }
  } finally {
    await removeDirectory(directory);
  }
});

test("workspace inspection rejects worktree metadata files and restricted symlink aliases", async (context) => {
  if (process.platform === "win32") {
    context.skip("Symbolic-link creation is not consistently available on Windows");
    return;
  }
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(path.join(directory, ".git"), "gitdir: /tmp/repository.git\n");
    await fs.symlink(path.join(directory, ".git"), path.join(directory, "metadata-link"), "file");

    const listed = await executeBrowserAction(
      action({ kind: "workspace.list", path: ".", recursive: true }),
      options(directory),
    );
    assert.equal(listed.status, "completed");
    assert.equal(listed.stdout.includes(".git"), false);

    for (const target of [".git", "metadata-link"]) {
      for (const candidate of [
        action({ kind: "workspace.list", path: target, recursive: true }),
        action({ kind: "workspace.read", path: target }),
        action({ kind: "workspace.search", path: target, query: "gitdir" }),
      ]) {
        const result = await executeBrowserAction(candidate, options(directory));
        assert.equal(result.status, "failed", `${target} ${candidate.kind}`);
        assert.match(result.stderr, /Restricted path is not allowed|Resolved path is restricted|cannot inspect credential, VCS, dependency, or generated paths/);
      }
    }
  } finally {
    await removeDirectory(directory);
  }
});

test("browser shell actions are rejected without invoking the user-selected login shell", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX shell selection does not apply on Windows");
    return;
  }
  const directory = await temporaryDirectory();
  const wrapper = path.join(directory, "shell-wrapper.sh");
  const marker = path.join(directory, "wrapper-started.txt");
  const previous = process.env.SHELL;
  try {
    await fs.writeFile(
      wrapper,
      `#!/bin/sh\nprintf wrapper > ${JSON.stringify(marker)}\nexec /bin/sh "$@"\n`,
    );
    await fs.chmod(wrapper, 0o755);
    process.env.SHELL = wrapper;
    const result = await executeBrowserAction(
      action({ kind: "shell.run", command: "printf approved" }),
      options(directory),
    );
    assert.equal(result.status, "failed");
    assert.match(result.stderr, /Arbitrary shell actions are disabled/);
    await assert.rejects(fs.stat(marker), /ENOENT/);
  } finally {
    if (previous === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previous;
    }
    await removeDirectory(directory);
  }
});

const applyPatch = async (directory, patch, existingPaths = [], mutationContext) => executeBrowserAction(
  action({
    kind: "workspace.applyPatch",
    patch,
    expectedFiles: await expectedFilesFor(directory, existingPaths),
  }),
  options(directory, new AbortController().signal, mutationContext),
);

test("workspace patches apply additions, modifications, and deletions", async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(path.join(directory, "modify.txt"), "old\n");
    await fs.writeFile(path.join(directory, "delete.txt"), "delete\n");
    const patch = `diff --git a/added.txt b/added.txt
new file mode 100644
--- /dev/null
+++ b/added.txt
@@ -0,0 +1 @@
+added
diff --git a/modify.txt b/modify.txt
--- a/modify.txt
+++ b/modify.txt
@@ -1 +1 @@
-old
+new
diff --git a/delete.txt b/delete.txt
deleted file mode 100644
--- a/delete.txt
+++ /dev/null
@@ -1 +0,0 @@
-delete
`;
    const result = await applyPatch(directory, patch, ["modify.txt", "delete.txt"]);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.affectedPaths.sort(), ["added.txt", "delete.txt", "modify.txt"]);
    assert.equal(await fs.readFile(path.join(directory, "added.txt"), "utf8"), "added\n");
    assert.equal(await fs.readFile(path.join(directory, "modify.txt"), "utf8"), "new\n");
    await assert.rejects(fs.stat(path.join(directory, "delete.txt")), /ENOENT/);
  } finally {
    await removeDirectory(directory);
  }
});

test("multi-file patch publication rolls back earlier files when a later publication fails", async (context) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    context.skip("The permission fault-injection fixture requires a non-root POSIX user");
    return;
  }
  const directory = await temporaryDirectory();
  const locked = path.join(directory, "locked");
  try {
    await fs.mkdir(locked);
    await fs.writeFile(path.join(directory, "a.txt"), "old-a\n");
    await fs.writeFile(path.join(locked, "b.txt"), "old-b\n");
    await fs.chmod(locked, 0o555);
    const patch = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old-a
+new-a
diff --git a/newdir/new.txt b/newdir/new.txt
new file mode 100644
--- /dev/null
+++ b/newdir/new.txt
@@ -0,0 +1 @@
+new-file
diff --git a/locked/b.txt b/locked/b.txt
--- a/locked/b.txt
+++ b/locked/b.txt
@@ -1 +1 @@
-old-b
+new-b
`;
    const result = await applyPatch(directory, patch, ["a.txt", "locked/b.txt"]);
    assert.equal(result.status, "failed");
    assert.equal(await fs.readFile(path.join(directory, "a.txt"), "utf8"), "old-a\n");
    assert.equal(await fs.readFile(path.join(locked, "b.txt"), "utf8"), "old-b\n");
    await assert.rejects(fs.stat(path.join(directory, "newdir")), /ENOENT/);
    assert.deepEqual(result.affectedPaths.sort(), ["a.txt", "locked/b.txt", "newdir/new.txt"]);
  } finally {
    await fs.chmod(locked, 0o755).catch(() => undefined);
    await removeDirectory(directory);
  }
});

test("workspace patches apply rename-only and copy-only changes", async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(path.join(directory, "rename-source.txt"), "rename\n");
    await fs.writeFile(path.join(directory, "copy-source.txt"), "copy\n");
    const patch = `diff --git a/rename-source.txt b/renamed.txt
similarity index 100%
rename from rename-source.txt
rename to renamed.txt
diff --git a/copy-source.txt b/copied.txt
similarity index 100%
copy from copy-source.txt
copy to copied.txt
`;
    const result = await applyPatch(directory, patch, ["rename-source.txt", "copy-source.txt"]);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.affectedPaths.sort(), ["copied.txt", "copy-source.txt", "rename-source.txt", "renamed.txt"]);
    assert.equal(await fs.readFile(path.join(directory, "renamed.txt"), "utf8"), "rename\n");
    await assert.rejects(fs.stat(path.join(directory, "rename-source.txt")), /ENOENT/);
    assert.equal(await fs.readFile(path.join(directory, "copy-source.txt"), "utf8"), "copy\n");
    assert.equal(await fs.readFile(path.join(directory, "copied.txt"), "utf8"), "copy\n");
  } finally {
    await removeDirectory(directory);
  }
});

test("workspace patches apply mode-only, binary, and quoted-path changes", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode changes are not portable to Windows");
    return;
  }
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(path.join(directory, "script.sh"), "echo ok\n", { mode: 0o644 });
    await fs.writeFile(path.join(directory, "bin.dat"), Buffer.from([0, 1, 2]));
    await fs.writeFile(path.join(directory, "space name.txt"), "old\n");
    const patch = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
diff --git a/bin.dat b/bin.dat
index 8352675d67aed6625ece79af41c27fdb4ee2e867..1592e5c60f1a460928916dc5681fee1a9bd10868 100644
GIT binary patch
literal 3
KcmZQzWCj2L2ml2D

literal 3
KcmZQzWC8#H2LJ>B

diff --git "a/space name.txt" "b/space name.txt"
--- "a/space name.txt"
+++ "b/space name.txt"
@@ -1 +1 @@
-old
+new
`;
    const result = await applyPatch(directory, patch, ["script.sh", "bin.dat", "space name.txt"]);
    assert.equal(result.status, "completed");
    assert.deepEqual(result.affectedPaths.sort(), ["bin.dat", "script.sh", "space name.txt"]);
    assert.equal((await fs.stat(path.join(directory, "script.sh"))).mode & 0o777, 0o755);
    assert.deepEqual(await fs.readFile(path.join(directory, "bin.dat")), Buffer.from([0, 1, 3]));
    assert.equal(await fs.readFile(path.join(directory, "space name.txt"), "utf8"), "new\n");
  } finally {
    await removeDirectory(directory);
  }
});

test("mode-only patches require a source hash and enforce allowedPaths", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX mode changes are not portable to Windows");
    return;
  }
  const directory = await temporaryDirectory();
  try {
    await fs.mkdir(path.join(directory, "src"));
    await fs.writeFile(path.join(directory, "outside.sh"), "echo outside\n", { mode: 0o644 });
    const patch = `diff --git a/outside.sh b/outside.sh
old mode 100644
new mode 100755
`;

    const missingHash = await executeBrowserAction(
      action({ kind: "workspace.applyPatch", patch, expectedFiles: [] }),
      options(directory),
    );
    assert.equal(missingHash.status, "failed");
    assert.match(missingHash.stderr, /expected SHA-256/);
    assert.equal((await fs.stat(path.join(directory, "outside.sh"))).mode & 0o777, 0o644);

    const scoped = await applyPatch(
      directory,
      patch,
      ["outside.sh"],
      { allowedPaths: ["src"], commitMode: "never" },
    );
    assert.equal(scoped.status, "failed");
    assert.match(scoped.stderr, /outside the task scope/);
    assert.equal((await fs.stat(path.join(directory, "outside.sh"))).mode & 0o777, 0o644);
  } finally {
    await removeDirectory(directory);
  }
});

test("binary new-file patches are checked against authoritative Git targets", async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.mkdir(path.join(directory, "src"));
    const patch = `diff --git a/outside.bin b/outside.bin
new file mode 100644
index 0000000000000000000000000000000000000000..f620c3d5f57b1b5323f31ec94c77a9d33fa18166
GIT binary patch
literal 8
PcmZQzWMXFd&%h1<13m!}

literal 0
HcmV?d00001

`;
    const result = await applyPatch(
      directory,
      patch,
      [],
      { allowedPaths: ["src"], commitMode: "never" },
    );
    assert.equal(result.status, "failed");
    assert.match(result.stderr, /outside the task scope/);
    await assert.rejects(fs.stat(path.join(directory, "outside.bin")), /ENOENT/);
  } finally {
    await removeDirectory(directory);
  }
});

test("workspace patches reject empty, malformed, traversal, and absolute paths", async () => {
  const directory = await temporaryDirectory();
  const outside = path.join(path.dirname(directory), `bachata-outside-${path.basename(directory)}.txt`);
  try {
    const cases = [
      "",
      "not a patch",
      `diff --git a/../${path.basename(outside)} b/../${path.basename(outside)}\nnew file mode 100644\n--- /dev/null\n+++ b/../${path.basename(outside)}\n@@ -0,0 +1 @@\n+outside\n`,
      `diff --git a/value.txt b/value.txt\n--- /dev/null\n+++ ${outside}\n@@ -0,0 +1 @@\n+outside\n`,
    ];
    for (const patch of cases) {
      const result = await applyPatch(directory, patch);
      assert.equal(result.status, "failed");
    }
    await assert.rejects(fs.stat(outside), /ENOENT/);
  } finally {
    await fs.rm(outside, { force: true });
    await removeDirectory(directory);
  }
});


test("workspace patch subprocesses share one action deadline", async (context) => {
  if (process.platform === "win32") {
    context.skip("The fake Git executable fixture is POSIX-only");
    return;
  }
  const directory = await temporaryDirectory();
  const binaryDirectory = path.join(directory, "bin");
  const previousPath = process.env.PATH;
  try {
    const firstSubprocessMs = 1_800;
    const actionTimeoutMs = 3_000;
    const terminateGraceMs = 500;
    const sharedDeadlineCeilingMs = actionTimeoutMs + terminateGraceMs + 1_000;
    const perSubprocessDeadlineFloorMs = firstSubprocessMs + actionTimeoutMs;

    await fs.mkdir(binaryDirectory);
    const fakeGit = path.join(binaryDirectory, "git");
    await fs.writeFile(
      fakeGit,
      `#!/usr/bin/env node
process.stdin.resume();
setTimeout(() => {
  if (process.argv.includes("--numstat")) {
    process.stdout.write(Buffer.from("MQkwCXZhbHVlLnR4dAA=", "base64"));
  }
}, ${String(firstSubprocessMs)});
`,
    );
    await fs.chmod(fakeGit, 0o755);
    process.env.PATH = `${binaryDirectory}${path.delimiter}${previousPath ?? ""}`;
    const started = Date.now();
    const result = await executeBrowserAction(
      action({
        kind: "workspace.applyPatch",
        patch: "diff --git a/value.txt b/value.txt\n--- a/value.txt\n+++ b/value.txt\n@@ -1 +1 @@\n-old\n+new\n",
      }),
      {
        ...options(directory),
        timeoutMs: actionTimeoutMs,
        terminateGraceMs,
      },
    );
    const elapsed = Date.now() - started;
    assert.equal(result.status, "failed");
    assert.match(result.stderr, new RegExp(`timed out after ${String(actionTimeoutMs)} ms`));
    assert.ok(
      sharedDeadlineCeilingMs < perSubprocessDeadlineFloorMs,
      "the ceiling must stay below the per-subprocess-deadline floor or the assertion proves nothing",
    );
    assert.ok(
      elapsed < sharedDeadlineCeilingMs,
      `elapsed ${String(elapsed)} ms exceeded the shared-deadline ceiling ${String(sharedDeadlineCeilingMs)} ms; a per-subprocess deadline would take at least ${String(perSubprocessDeadlineFloorMs)} ms`,
    );
  } finally {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    await removeDirectory(directory);
  }
});

test("browser shell actions are rejected before environment secrets can be exposed", async () => {
  const directory = await temporaryDirectory();
  const previous = process.env.BACHATA_WORKSPACE_ACTION_SECRET;
  process.env.BACHATA_WORKSPACE_ACTION_SECRET = "must-not-leak";
  try {
    const result = await executeBrowserAction(
      action({
        kind: "shell.run",
        command: "node -e \"process.stdout.write(process.env.BACHATA_WORKSPACE_ACTION_SECRET || 'missing')\"",
      }),
      options(directory),
    );
    assert.equal(result.status, "failed");
    assert.match(result.stderr, /Arbitrary shell actions are disabled/);
  } finally {
    if (previous === undefined) {
      delete process.env.BACHATA_WORKSPACE_ACTION_SECRET;
    } else {
      process.env.BACHATA_WORKSPACE_ACTION_SECRET = previous;
    }
    await removeDirectory(directory);
  }
});

test("workspace actions reject paths outside the configured root", async () => {
  const directory = await temporaryDirectory();
  try {
    const result = await executeBrowserAction(
      action({ kind: "workspace.read", path: "../outside.txt" }),
      options(directory),
    );
    assert.equal(result.status, "failed");
    assert.match(result.stderr, /Path escapes the workspace|outside the working directory/);
  } finally {
    await removeDirectory(directory);
  }
});

test("workspace search output respects the UTF-8 byte limit", async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(
      path.join(directory, "large.txt"),
      `needle ${"😀".repeat(1_000)}`,
    );
    const result = await executeBrowserAction(
      action({ kind: "workspace.search", path: ".", query: "needle" }),
      {
        ...options(directory),
        maxOutputBytes: 96,
        maxReadBytes: 16_384,
      },
    );
    assert.equal(result.status, "completed");
    assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 96);
    assert.doesNotMatch(result.stdout, /�/);
    assert.match(result.stdout, /output truncated/);
  } finally {
    await removeDirectory(directory);
  }
});

test("workspace reads do not return a partial UTF-8 code point", async () => {
  const directory = await temporaryDirectory();
  try {
    await fs.writeFile(path.join(directory, "emoji.txt"), "😀😀");
    const result = await executeBrowserAction(
      action({ kind: "workspace.read", path: "emoji.txt" }),
      {
        ...options(directory),
        maxOutputBytes: 256,
        maxReadBytes: 5,
      },
    );
    assert.equal(result.status, "completed");
    assert.doesNotMatch(result.stdout, /�/);
    assert.match(result.stdout, /😀/);
    assert.match(result.stdout, /truncated after 5 bytes/);
  } finally {
    await removeDirectory(directory);
  }
});

test("browser shell output commands are rejected before execution", async () => {
  const directory = await temporaryDirectory();
  try {
    const command = `"${process.execPath}" -e "process.stdout.write('😀'.repeat(1000))"`;
    const result = await executeBrowserAction(
      action({ kind: "shell.run", command }),
      {
        ...options(directory),
        maxOutputBytes: 96,
      },
    );
    assert.equal(result.status, "failed");
    assert.match(result.stderr, /Arbitrary shell actions are disabled/);
  } finally {
    await removeDirectory(directory);
  }
});

test("workspace writes preserve existing permission bits", async (context) => {
  if (process.platform === "win32") {
    context.skip("Windows does not expose POSIX executable bits");
    return;
  }
  const directory = await temporaryDirectory();
  try {
    const target = path.join(directory, "script.sh");
    await fs.writeFile(target, "old");
    await fs.chmod(target, 0o755);
    const result = await executeBrowserAction(
      action({
        kind: "workspace.write",
        path: "script.sh",
        content: "new",
        expectedFiles: await expectedFilesFor(directory, ["script.sh"]),
      }),
      options(directory),
    );
    assert.equal(result.status, "completed");
    assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
  } finally {
    await removeDirectory(directory);
  }
});
