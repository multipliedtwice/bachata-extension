const assert = require("node:assert/strict");
const test = require("node:test");
const { existsSync } = require("node:fs");
const { readFile, symlink, writeFile } = require("node:fs/promises");
const path = require("node:path");

const {
  makeScratchChild,
  removeScratch,
  removeScratchSync,
  scratchBase,
  scratchChild,
  scratchContainmentProblem,
  scratchPrefixProblem,
  scratchProblem,
  scratchRoot,
  scratchRootSync,
  scratchTraversalProblem,
} = require("./support/scratch.cjs");

// SAFETY. This suite's own cleanup is the most destructive thing in the repository: it runs
// `rm -r` in a `finally` on a path a test computed. Every such removal goes through
// `removeScratch`, so the guard that decides what a removal may reach is tested here directly,
// and tested against a recorder rather than against the filesystem: a test that disabled the
// guard and then called the real remover would be the escape it claims to forbid.

const recorder = () => {
  const removed = [];
  return { removed, record: (target) => removed.push(target) };
};

test("a cleanup target outside the directory the run created is refused before any removal", async () => {
  const root = await scratchRoot("bachata-scratch-guard-");
  const base = await scratchBase();
  const { removed, record } = recorder();
  try {
    const refused = [
      "",
      ".",
      "..",
      "relative/path",
      "dist",
      base,
      path.dirname(base),
      path.join(base, ".."),
      `${root}-sibling`,
      `${root}x`,
      path.join(base, "bachata-scratch-guard-not-this-run"),
      path.join(root, ".."),
      path.join(root, "..", "..", "elsewhere"),
      process.cwd(),
      path.resolve(__dirname, ".."),
      String(process.env.HOME ?? "/"),
      "$TMPDIR",
      "${TMPDIR}",
      path.join("$TMPDIR", "bachata-scratch-guard-x"),
    ];
    for (const target of refused) {
      removed.length = 0;
      await assert.rejects(() => removeScratch(target, record), /scratch target/u, JSON.stringify(target));
      assert.deepEqual(removed, [], `cleanup reached the remover for ${JSON.stringify(target)}`);
      assert.equal(typeof scratchProblem(target, base), "string");
    }
    // The synchronous half is the same guard, and a suite that builds its fixtures
    // synchronously removes them synchronously.
    for (const target of [base, path.dirname(base), path.join(root, ".."), `${root}x`]) {
      removed.length = 0;
      assert.throws(() => removeScratchSync(target, record), /scratch target/u, target);
      assert.deepEqual(removed, []);
    }
  } finally {
    await removeScratch(root);
  }
});

test("the directory a run created, and its descendants, are what a cleanup may remove", async () => {
  const root = await scratchRoot("bachata-scratch-accept-");
  const base = await scratchBase();
  const { removed, record } = recorder();
  try {
    const child = await makeScratchChild(root, "storage", "runs");
    assert.equal(scratchProblem(root, base), undefined);
    assert.equal(scratchProblem(child, base), undefined);
    removed.length = 0;
    await removeScratch(child, record);
    assert.deepEqual(removed, [child]);
    assert.equal(existsSync(child), true, "the recorder removed something");

    // A child path that would climb out of its root is refused where it is built, so no caller
    // can hand one to a remover in the first place.
    assert.throws(() => scratchChild(root, ".."), /escapes its root/u);
    assert.throws(() => scratchChild(root, "..", "elsewhere"), /escapes its root/u);
    assert.throws(() => scratchChild(root, "/elsewhere"), /escapes its root/u);
    assert.equal(scratchChild(root, "storage", "runs"), child);
  } finally {
    await removeScratch(root);
  }
});

test("a symlink inside a run's directory is removed as a link, not followed out of it", async () => {
  const root = await scratchRoot("bachata-scratch-link-");
  const outside = await scratchRoot("bachata-scratch-outside-");
  try {
    await writeFile(path.join(outside, "kept.txt"), "not this test's to delete", "utf8");
    const link = scratchChild(root, "link");
    await symlink(outside, link);
    await removeScratch(link);
    assert.equal(existsSync(link), false);
    assert.equal(existsSync(path.join(outside, "kept.txt")), true, "removal followed a symlink out");

    // And a path that reaches outside through a lexical climb is refused, which is the case the
    // string half of the guard answers. The symlink-ancestor case it cannot answer is below.
    const bridge = scratchChild(root, "bridge");
    await symlink(outside, bridge);
    await assert.rejects(() => removeScratch(path.join(bridge, "..", "..", "elsewhere")), /scratch target/u);
  } finally {
    await removeScratch(outside);
    await removeScratch(root);
  }
});

test("a descendant reached through a symlink ancestor is refused before any removal", async () => {
  // SAFETY. The case a lexical guard gets wrong. `root/link/victim` starts with `root` as a
  // string, resolves to itself under `path.resolve`, and names a file in a directory this run
  // does not own. The guard has to read the filesystem to tell those apart, and the proof is
  // that the recorder stays empty and the file outside is still byte-for-byte what it was.
  const root = await scratchRoot("bachata-scratch-escape-");
  const outside = await scratchRoot("bachata-scratch-escape-outside-");
  try {
    const sentinel = path.join(outside, "sentinel.txt");
    const contents = "not this run's to delete\n";
    await writeFile(sentinel, contents, "utf8");
    const before = await readFile(sentinel);

    const link = scratchChild(root, "link");
    await symlink(outside, link);

    // The lexical half accepts it: this is exactly what made the escape reachable.
    const base = await scratchBase();
    assert.equal(scratchProblem(path.join(link, "sentinel.txt"), base), undefined);
    // The containment check refuses it, naming the link rather than the target.
    assert.equal(
      scratchContainmentProblem(path.join(link, "sentinel.txt"), base),
      `a scratch target is reached through a symlink: ${link}`,
    );

    const { removed, record } = recorder();
    // An existing descendant, and one that does not exist: neither may be reached through a link.
    for (const victim of ["sentinel.txt", "never-created", path.join("never-created", "deeper")]) {
      removed.length = 0;
      await assert.rejects(() => removeScratch(path.join(link, victim), record), /reached through a symlink/u, victim);
      assert.deepEqual(removed, [], `cleanup reached the remover for ${victim}`);
      assert.throws(() => removeScratchSync(path.join(link, victim), record), /reached through a symlink/u, victim);
      assert.deepEqual(removed, [], `synchronous cleanup reached the remover for ${victim}`);
    }

    assert.deepEqual(await readFile(sentinel), before, "the file outside the owned root changed");
    assert.equal(existsSync(link), true, "the refusal removed the link it refused to traverse");
  } finally {
    await removeScratch(outside);
    await removeScratch(root);
  }
});

test("a symlink ancestor cannot redirect where a scratch child is created", async () => {
  // SAFETY. `mkdir` with `recursive` follows a link ancestor exactly as `rm` does, so a child
  // built under one would be written outside the owned root — and handed to a later cleanup.
  const root = await scratchRoot("bachata-scratch-write-");
  const outside = await scratchRoot("bachata-scratch-write-outside-");
  try {
    const link = scratchChild(root, "link");
    await symlink(outside, link);
    await assert.rejects(() => makeScratchChild(root, "link", "storage"), /reached through a symlink/u);
    assert.equal(existsSync(path.join(outside, "storage")), false, "a scratch child was written outside its root");
    // A child under a real directory is still created, and under a directory that does not exist
    // yet, which is what `recursive` is for.
    const real = await makeScratchChild(root, "storage", "runs");
    assert.equal(existsSync(real), true);
  } finally {
    await removeScratch(outside);
    await removeScratch(root);
  }
});

/** A filesystem error the way Node raises one: the classification is the `code`, not the text. */
const fsError = (code) => Object.assign(new Error(`${code}: simulated`), code === "" ? {} : { code });

test("an inspection that fails refuses, and only ENOENT or ENOTDIR means genuinely missing", () => {
  // The refusal is decided from `lstat` and `realpath`, so both are parameters and the walk is
  // driven from a table rather than from a filesystem shaped to match.
  //
  // SAFETY. This is the half of the guard that used to fail open. Every `lstat` failure was read
  // as "this ancestor does not exist", so a directory that could not be read because of a
  // permission or an I/O error ended the walk with the same answer a genuinely absent directory
  // gives — and that answer authorizes a recursive removal. Only `ENOENT` and `ENOTDIR` state
  // that a path is not there; everything else states that the question was not answered.
  const root = path.resolve(path.sep, "owned", "root");
  const link = { isSymbolicLink: () => true };
  const directory = { isSymbolicLink: () => false };
  const roots = new Set([root]);
  const walk = (entries, target, real = (entry) => entry) =>
    scratchTraversalProblem(
      target,
      roots,
      (entry) => {
        const found = entries[entry];
        if (found === undefined) throw fsError("ENOENT");
        if (found instanceof Error) throw found;
        return found;
      },
      real,
    );
  const linked = path.join(root, "link");
  assert.match(walk({ [linked]: link }, path.join(linked, "victim")), /reached through a symlink/u);

  // Missing, both ways a path can be missing: absent, and present-but-not-a-directory.
  assert.equal(walk({}, path.join(root, "absent", "victim")), undefined);
  assert.equal(
    walk({ [path.join(root, "file")]: fsError("ENOTDIR") }, path.join(root, "file", "victim")),
    undefined,
  );

  // Unreadable: refused, and the refusal names the path and the code it failed with.
  for (const code of ["EACCES", "EIO", "ELOOP", "ENAMETOOLONG", "EPERM"]) {
    assert.equal(
      walk({ [path.join(root, "opaque")]: fsError(code) }, path.join(root, "opaque", "victim")),
      `a scratch target's ancestor could not be inspected (${code}): ${path.join(root, "opaque")}`,
      code,
    );
  }
  // An error carrying no code at all is not evidence of absence either.
  assert.equal(
    walk({ [path.join(root, "opaque")]: fsError("") }, path.join(root, "opaque", "victim")),
    `a scratch target's ancestor could not be inspected (no error code): ${path.join(root, "opaque")}`,
  );

  // A real directory chain is accepted, and the target's own last segment is never stat-ed — that
  // is what keeps a link removable as a link.
  assert.equal(walk({ [path.join(root, "real")]: directory }, path.join(root, "real", "victim")), undefined);
  assert.equal(walk({}, linked), undefined);
  assert.equal(walk({ [linked]: link }, linked), undefined, "the target's own segment was inspected");

  // And the root's own identity, read the same way. A root that resolves elsewhere is a link; a
  // root that cannot be resolved at all is a refusal; a root that is not there has nothing under
  // it to traverse and nothing under it to remove.
  assert.match(
    walk({}, path.join(root, "victim"), () => path.join(path.sep, "elsewhere")),
    /root is reached through a symlink/u,
  );
  for (const code of ["EACCES", "EIO", "ELOOP"]) {
    assert.equal(
      walk({}, path.join(root, "victim"), () => {
        throw fsError(code);
      }),
      `a scratch target's root could not be inspected (${code}): ${root}`,
      code,
    );
  }
  assert.equal(
    walk({}, path.join(root, "victim"), () => {
      throw fsError("");
    }),
    `a scratch target's root could not be inspected (no error code): ${root}`,
  );
  for (const code of ["ENOENT", "ENOTDIR"]) {
    assert.equal(
      walk({}, path.join(root, "victim"), () => {
        throw fsError(code);
      }),
      undefined,
      code,
    );
  }
});

test("a target that is not already its own canonical path is refused before any removal", async () => {
  // SAFETY. `path.resolve(target) !== path.normalize(target)` detected a trailing separator and
  // nothing else: both functions collapse `.` and `..` and both fold repeated separators, so
  // `${root}/a/../victim` compared equal and was accepted — and the path the remover was then
  // handed was `${root}/victim`, which is not the path the caller wrote. The rule is now exact
  // equality with the canonical absolute path, so the string checked and the string removed are
  // the same characters.
  const root = await scratchRoot("bachata-scratch-canonical-");
  const base = await scratchBase();
  const { removed, record } = recorder();
  try {
    const victim = await makeScratchChild(root, "victim");
    const shapes = [
      `${root}${path.sep}a${path.sep}..${path.sep}victim`,
      `${root}${path.sep}.${path.sep}victim`,
      `${root}${path.sep}${path.sep}victim`,
      `${root}${path.sep}victim${path.sep}`,
      `${root}${path.sep}`,
      `${root}${path.sep}.`,
      `${root}${path.sep}victim${path.sep}${path.sep}`,
    ];
    for (const shape of shapes) {
      removed.length = 0;
      assert.match(
        String(scratchProblem(shape, base)),
        /must be its own canonical absolute path/u,
        JSON.stringify(shape),
      );
      await assert.rejects(() => removeScratch(shape, record), /canonical absolute path/u, JSON.stringify(shape));
      assert.deepEqual(removed, [], `cleanup reached the remover for ${JSON.stringify(shape)}`);
      // The synchronous half is the same guard.
      assert.throws(() => removeScratchSync(shape, record), /canonical absolute path/u, JSON.stringify(shape));
      assert.deepEqual(removed, [], `synchronous cleanup reached the remover for ${JSON.stringify(shape)}`);
      assert.equal(existsSync(victim), true, `a refused shape removed ${victim}`);
    }
    // The canonical spelling of the same directory is accepted, so the rule refuses spellings
    // rather than paths.
    removed.length = 0;
    await removeScratch(victim, record);
    assert.deepEqual(removed, [victim]);
  } finally {
    await removeScratch(root);
  }
});

test("a symlink is removable as itself while a descendant reached through it is not", async () => {
  // Two questions that a single `startsWith` answers identically and that have opposite answers:
  // deleting the link removes the link, and deleting through the link removes someone else's file.
  const root = await scratchRoot("bachata-scratch-link-vs-through-");
  const outside = await scratchRoot("bachata-scratch-link-vs-through-outside-");
  try {
    const sentinel = path.join(outside, "sentinel.txt");
    await writeFile(sentinel, "not this run's to delete\n", "utf8");
    const link = scratchChild(root, "link");
    await symlink(outside, link);

    assert.equal(scratchTraversalProblem(link, new Set([root])), undefined, "the link itself was refused");
    assert.equal(
      scratchTraversalProblem(path.join(link, "sentinel.txt"), new Set([root])),
      `a scratch target is reached through a symlink: ${link}`,
    );
    const { removed, record } = recorder();
    await removeScratch(link, record);
    assert.deepEqual(removed, [link]);
    assert.equal(existsSync(sentinel), true);
  } finally {
    await removeScratch(outside);
    await removeScratch(root);
  }
});

test("a scratch prefix that would create a directory somewhere else is refused", () => {
  // `mkdtemp` appends to whatever it is handed: a separator moves the result, and an absolute
  // prefix ignores the base outright.
  for (const prefix of ["", "/absolute-", `a${path.sep}b-`, "a/b-", "a\\b-", ".", ".."]) {
    assert.equal(typeof scratchPrefixProblem(prefix), "string", JSON.stringify(prefix));
    assert.throws(() => scratchRootSync(prefix), /scratch prefix/u, JSON.stringify(prefix));
  }
  assert.rejects(() => scratchRoot("../escape-"), /scratch prefix/u);
  assert.equal(scratchPrefixProblem("bachata-scratch-ok-"), undefined);
});

test("a directory this module never created cannot be removed even inside the temporary root", () => {
  const strayRoot = scratchRootSync("bachata-scratch-stray-");
  const base = require("node:fs").realpathSync.native(require("node:os").tmpdir());
  // Built the same way a scratch directory is, but presented as a bare path the guard has no
  // record of: the ownership check, not the prefix check, is what refuses it.
  assert.equal(scratchProblem(strayRoot, base, new Set()), `a scratch target must be a directory this run created: ${strayRoot}`);
  removeScratchSync(strayRoot);
  assert.equal(existsSync(strayRoot), false);
});
