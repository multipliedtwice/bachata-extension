const assert = require("node:assert/strict");
const test = require("node:test");
const { execFileSync, spawnSync } = require("node:child_process");
const { chmodSync, mkdirSync, writeFileSync, copyFileSync, renameSync, rmSync, symlinkSync } = require("node:fs");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const { pathToFileURL } = require("node:url");

const { gitWorktreeSkip } = require("./support/orchestration.cjs");
const { makeScratchChild, removeScratch, scratchRoot } = require("./support/scratch.cjs");

// Which files the gates are answerable for.
//
// `lint` and `format:check` enumerated `git ls-files -z`, which is tracked files and nothing
// else. Every file that had been written but not yet added was outside both gates — which is
// every file at the moment it is most likely to carry the mistake the gate exists to catch, and
// the state this working tree spends most of its life in. The gates now enumerate tracked plus
// unignored untracked files, and what proves it is the real script text run over a real Git
// repository rather than a copy of its rules asserted here.

// The gate's own enumeration primitives, loaded as the module the gate loads them as.
const candidateModulePath = path.resolve(__dirname, "..", "scripts", "lib", "candidateFiles.mjs");
const loadCandidateModule = async () => await import(pathToFileURL(candidateModulePath).href);
const loadCandidateFiles = async () => (await loadCandidateModule()).candidateFiles;

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const write = (root, relative, contents) => {
  const target = path.join(root, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents, "utf8");
  return target;
};

/**
 * A repository carrying the gates themselves.
 *
 * The scripts are copied rather than reimplemented: a test that restated the enumeration would
 * prove its own copy of the rule. What runs here is the file `npm run lint` runs.
 */
const gateRepository = async (root) => {
  const repository = await makeScratchChild(root, "repository");
  git(repository, "init", ".");
  git(repository, "config", "user.name", "Test");
  git(repository, "config", "user.email", "test@example.invalid");
  mkdirSync(path.join(repository, "scripts", "lib"), { recursive: true });
  const source = path.resolve(__dirname, "..", "scripts");
  for (const relative of [
    "lint.mjs",
    "format-check.mjs",
    path.join("lib", "candidateFiles.mjs"),
    path.join("lib", "containment.mjs"),
  ]) {
    copyFileSync(path.join(source, relative), path.join(repository, "scripts", relative));
  }
  write(repository, ".gitignore", "generated/\n");
  return repository;
};

const runGate = (repository, script, preload = "") => {
  const args = preload ? ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] : [];
  const result = spawnSync(process.execPath, [...args, path.join("scripts", script)], {
    cwd: repository,
    encoding: "utf8",
  });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
};

test("both gates cover tracked and unignored untracked files, and no ignored ones", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-gate-coverage-");
  try {
    const repository = await gateRepository(root);
    // Tracked and clean.
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    // Untracked and clean, including names a newline-separated listing would quote and
    // re-encode — the files a gate that parsed quoted output would silently skip.
    write(repository, "src/untracked.mjs", "export const untracked = 1;\n");
    write(repository, "src/with space.mjs", "export const spaced = 1;\n");
    const unusual = process.platform === "win32" ? "src/naïve-quoted.mjs" : 'src/naïve-"quoted".mjs';
    write(repository, unusual, "export const unusual = 1;\n");
    // Ignored generated output, carrying both violations.
    write(repository, "generated/ignored.mjs", "// @ts-ignore  \nexport const ignored = 1;\n");

    const candidateFiles = await loadCandidateFiles();
    const enumerated = candidateFiles(repository);
    assert.ok(enumerated.includes("src/tracked.mjs"), JSON.stringify(enumerated));
    assert.ok(enumerated.includes("src/untracked.mjs"), JSON.stringify(enumerated));
    assert.ok(enumerated.includes("src/with space.mjs"), JSON.stringify(enumerated));
    assert.ok(enumerated.includes(unusual), JSON.stringify(enumerated));
    assert.equal(enumerated.includes("generated/ignored.mjs"), false, "an ignored file was enumerated");
    // Deterministic: the same tree enumerates the same files in the same order.
    assert.deepEqual(candidateFiles(repository), enumerated);
    assert.equal(new Set(enumerated).size, enumerated.length, "the enumeration repeated a path");

    // And the gates themselves pass over that tree, ignored violations included.
    // The gates pass over that tree, ignored violations included, and each says exactly how many
    // eligible files it read out of how many candidates it enumerated.
    const lint = runGate(repository, "lint.mjs");
    assert.equal(lint.status, 0, lint.output);
    assert.match(lint.output, /Lint checked 8 of 8 eligible file\(s\), out of 9 candidates \(tracked and unignored untracked\), 1 skipped as ineligible and found no problems\./u);
    const format = runGate(repository, "format-check.mjs");
    assert.equal(format.status, 0, format.output);
    assert.match(format.output, /Format check passed for 8 of 8 eligible file\(s\), out of 9 candidates \(tracked and unignored untracked\), 1 skipped as ineligible\./u);
  } finally {
    await removeScratch(root);
  }
});

test("a lint violation in a file that was never added fails the gate", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-gate-lint-");
  try {
    const repository = await gateRepository(root);
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    assert.equal(runGate(repository, "lint.mjs").status, 0);

    write(repository, "src/untracked.mjs", "// @ts-ignore\nexport const untracked = 1;\n");
    const failed = runGate(repository, "lint.mjs");
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /src\/untracked\.mjs:1: no-ts-ignore/u);
  } finally {
    await removeScratch(root);
  }
});

// The code projection blanked a string's delimiters along with its contents, and the
// unconditional-skip rule then required one of those erased delimiters immediately after
// `.skip(`. The guard meant to prohibit a silently skipped case accepted one.
test("an unconditional skipped case fails the lint gate", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-gate-skip-");
  try {
    const repository = await gateRepository(root);
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    assert.equal(runGate(repository, "lint.mjs").status, 0);

    write(
      repository,
      "tests/release.test.cjs",
      'test.skip("critical release scenario", () => {\n  throw new Error("failure");\n});\n',
    );
    const failed = runGate(repository, "lint.mjs");
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /tests\/release\.test\.cjs:1: no-unconditional-test-skip/u);
  } finally {
    await removeScratch(root);
  }
});

// The rule reads code, not prose: a skipped case named inside a comment or quoted in a string is
// not a skipped case.
test("the unconditional-skip rule ignores a mention inside a comment or a string", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-gate-skip-mention-");
  try {
    const repository = await gateRepository(root);
    write(
      repository,
      "tests/release.test.cjs",
      [
        '// test.skip("documented, not performed", () => {});',
        'const sample = \'test.skip("quoted", () => {});\';',
        "module.exports = sample.length;",
        "",
      ].join("\n"),
    );
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    const passed = runGate(repository, "lint.mjs");
    assert.equal(passed.status, 0, passed.output);
  } finally {
    await removeScratch(root);
  }
});

test("a format violation in a file that was never added fails the gate", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-gate-format-");
  try {
    const repository = await gateRepository(root);
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    assert.equal(runGate(repository, "format-check.mjs").status, 0);

    write(repository, "src/untracked.mjs", "export const untracked = 1;   \n");
    const failed = runGate(repository, "format-check.mjs");
    assert.equal(failed.status, 1, failed.output);
    assert.match(failed.output, /src\/untracked\.mjs: trailing whitespace on line 1/u);
  } finally {
    await removeScratch(root);
  }
});

test("a gate outside a Git checkout refuses rather than reporting nothing to check", async () => {
  const root = await scratchRoot("bachata-gate-nogit-");
  try {
    const { candidateFiles, trackedDeletions } = await loadCandidateModule();
    const failing = () => ({ status: 128, stdout: "", stderr: "not a git repository" });
    assert.equal(candidateFiles(root, failing), undefined);
    // The deletion listing refuses the same way: a gate that could not ask Git which absent
    // files are meant to be absent cannot classify its own read failures.
    assert.equal(trackedDeletions(root, failing), undefined);
    // A run that produced no stdout at all is a failure too, not an empty tree.
    assert.equal(candidateFiles(root, () => ({ status: 0 })), undefined);
    assert.equal(trackedDeletions(root, () => ({ status: 0 })), undefined);
    // And a successful run does produce a set, so the refusal is about failure and not about
    // the function never answering.
    assert.deepEqual([...trackedDeletions(root, () => ({ status: 0, stdout: "" }))], []);
  } finally {
    await removeScratch(root);
  }
});

test("the enumeration primitive carries no literal NUL byte", async () => {
  // The separator this module parses is a NUL. Writing it as a literal byte made the file itself
  // binary: `file` reported `data`, `grep` reported "binary file matches" instead of the line,
  // and a diff would not show a change to it. The escape is six ASCII characters and parses to
  // the same code unit.
  const bytes = await readFile(candidateModulePath);
  assert.equal(bytes.includes(0), false, "the module source contains a literal NUL byte");
  const source = bytes.toString("utf8");
  assert.match(source, /split\(NUL\)/u, "the module no longer splits on the NUL constant");
  // Every byte in the file is a printable character, a tab or a newline.
  const control = [...bytes].filter((byte) => byte < 9 || (byte > 10 && byte < 32) || byte === 127);
  assert.deepEqual(control, [], "the module source contains control bytes");
});

test("a gate counts what it read, not what it enumerated", async () => {
  // SAFETY OF THE CLAIM. `candidateSummary(files)` reported every enumerated path as checked, so
  // "Lint checked 537 candidate files" was false in two directions at once: neither gate checks
  // every extension, and both used to skip silently over any file they could not open. The
  // counts below close arithmetically — eligible is exactly checked plus tracked deletions plus
  // unreadable — so a file cannot leave the accounting without being named.
  const root = await scratchRoot("bachata-gate-counts-");
  try {
    const { candidateSummary, inspectCandidates } = await loadCandidateModule();
    const eligible = (relative) => relative.endsWith(".mjs");
    const failing = (code) => () => Promise.reject(Object.assign(new Error(code), { code }));
    const files = ["a.mjs", "b.mjs", "c.json", "gone.mjs", "opaque.mjs"];
    const result = await inspectCandidates({
      files,
      deletions: new Set(["gone.mjs"]),
      eligible,
      read: (relative) =>
        relative === "gone.mjs"
          ? failing("ENOENT")()
          : relative === "opaque.mjs"
            ? failing("EACCES")()
            : Promise.resolve(`// ${relative}\n`),
    });
    assert.deepEqual(result.counts, {
      enumerated: 5,
      eligible: 4,
      checked: 2,
      ineligible: 1,
      trackedDeletions: 1,
      unreadable: 1,
      refused: 0,
    });
    assert.equal(
      result.counts.eligible,
      result.counts.checked +
        result.counts.trackedDeletions +
        result.counts.unreadable +
        result.counts.refused,
      "the accounting does not close",
    );
    assert.deepEqual(result.inspected.map((entry) => entry.relative), ["a.mjs", "b.mjs"]);
    assert.deepEqual(result.problems, ["opaque.mjs: could not be read (EACCES)"]);
    assert.match(candidateSummary(result.counts), /^2 of 4 eligible file\(s\)/u);
    assert.match(candidateSummary(result.counts), /1 tracked deletion\(s\) skipped/u);
    assert.match(candidateSummary(result.counts), /1 unreadable/u);

    // A candidate that is absent and that Git does not record as a deleted tracked file is a
    // third thing: the tree changed while the gate was running. It is reported, not skipped.
    const raced = await inspectCandidates({
      files: ["gone.mjs"],
      deletions: new Set(),
      eligible,
      read: failing("ENOENT"),
    });
    assert.equal(raced.counts.trackedDeletions, 0);
    assert.equal(raced.counts.unreadable, 1);
    assert.match(raced.problems[0], /the tree changed while the gate was running/u);
    // An error with no code at all is not evidence of anything, so it fails closed as well.
    const codeless = await inspectCandidates({
      files: ["odd.mjs"],
      deletions: new Set(),
      eligible,
      read: () => Promise.reject(new Error("no code")),
    });
    assert.deepEqual(codeless.problems, ["odd.mjs: could not be read (no error code)"]);
  } finally {
    await removeScratch(root);
  }
});

test("an eligible file a gate cannot read fails the gate instead of vanishing from it", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-gate-portable-");
  let opaque;
  try {
    const repository = await gateRepository(root);
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    assert.equal(runGate(repository, "lint.mjs").status, 0);

    opaque = write(repository, "src/opaque.mjs", "export const opaque = 1;\n");
    const preload = process.platform === "win32" ? `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const open = fs.open;
      fs.open = (file, ...args) => String(file) === ${JSON.stringify(opaque)}
        ? Promise.reject(Object.assign(new Error("fixture read denied"), { code: "EACCES" }))
        : open(file, ...args);
      syncBuiltinESMExports();
    ` : "";
    if (process.platform !== "win32") chmodSync(opaque, 0o000);
    const lint = runGate(repository, "lint.mjs", preload);
    assert.equal(lint.status, 1, lint.output);
    assert.match(lint.output, /src\/opaque\.mjs: could not be read \(EACCES\) — not checked/u);
    const format = runGate(repository, "format-check.mjs", preload);
    assert.equal(format.status, 1, format.output);
    assert.match(format.output, /src\/opaque\.mjs: could not be read \(EACCES\) — not checked/u);
  } finally {
    if (opaque) chmodSync(opaque, 0o600);
    await removeScratch(root);
  }
});

test("a tracked file deleted from the working tree is accounted for, not treated as checked", gitWorktreeSkip, async () => {
  // `git ls-files --cached` lists index entries, so a deleted tracked file is still a candidate
  // and still fails to open. Git is the only thing that can say the absence is intended.
  const root = await scratchRoot("bachata-gate-deleted-");
  try {
    const repository = await gateRepository(root);
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    write(repository, "src/removed.mjs", "export const removed = 1;\n");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    rmSync(path.join(repository, "src/removed.mjs"));

    const { candidateFiles, trackedDeletions } = await loadCandidateModule();
    assert.ok(candidateFiles(repository).includes("src/removed.mjs"), "a deleted tracked file left the candidate set");
    assert.deepEqual([...trackedDeletions(repository)], ["src/removed.mjs"]);

    const lint = runGate(repository, "lint.mjs");
    assert.equal(lint.status, 0, lint.output);
    assert.match(lint.output, /1 tracked deletion\(s\) skipped/u);
    const format = runGate(repository, "format-check.mjs");
    assert.equal(format.status, 0, format.output);
    assert.match(format.output, /1 tracked deletion\(s\) skipped/u);
  } finally {
    await removeScratch(root);
  }
});

test("a filename cannot write a line of the gate's own output", gitWorktreeSkip, async () => {
  // A newline is a legal byte in a path. A gate that prints one finding per line and interpolates
  // the path raw lets a filename append lines that read like the gate's own — including a line
  // that reads like a passing result, or one that blames a file that is fine.
  const root = await scratchRoot("bachata-gate-portable-");
  try {
    const repository = await gateRepository(root);
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    const forged = "src/inject\n- src/decoy.mjs:1: no-ts-ignore: forged.mjs";
    const stored = process.platform === "win32" ? "src/injected.mjs" : forged;
    write(repository, stored, "// @ts-ignore\nexport const injected = 1;\n");
    const preload = process.platform === "win32" ? `
      import child from "node:child_process";
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const spawn = child.spawnSync;
      child.spawnSync = (...args) => {
        const result = spawn(...args);
        if (args[0] === "git" && args[1][0] === "ls-files" && typeof result.stdout === "string") {
          result.stdout = result.stdout.replace(${JSON.stringify(stored)}, ${JSON.stringify(forged)});
        }
        return result;
      };
      for (const name of ["open", "lstat"]) {
        const original = fs[name];
        fs[name] = (file, ...args) => original(
          String(file) === ${JSON.stringify(path.join(repository, forged))}
            ? ${JSON.stringify(path.join(repository, stored))} : file, ...args);
      }
      syncBuiltinESMExports();
    ` : "";
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const { candidateFiles } = await loadCandidateModule();
    assert.ok(candidateFiles(repository).includes(stored), "the NUL-separated listing lost the path");
    assert.deepEqual(candidateFiles(repository, () => ({ status: 0, stdout: `${forged}\u0000` })), [forged]);

    const lint = runGate(repository, "lint.mjs", preload);
    assert.equal(lint.status, 1, lint.output);
    assert.equal(lint.output.match(/^- /gmu).length, 1, lint.output);
    assert.match(lint.output, /^- "src\/inject\\n- src\/decoy\.mjs:1: no-ts-ignore: forged\.mjs":1: no-ts-ignore/mu);
    assert.equal(
      /^- src\/decoy\.mjs:1: no-ts-ignore: forged$/mu.test(lint.output),
      false,
      "a filename wrote a line of the gate's output",
    );
    assert.equal(lint.output.includes("Lint found 1 problem(s):"), true, lint.output);
  } finally {
    await removeScratch(root);
  }
});


// CONTAINMENT. A path Git enumerates is a name in the repository; the bytes behind it need not be.
// Both gates joined `root` to the enumerated name and read it, so a tracked or unignored symbolic
// link pointing outside made the gate read, report on and quote a file outside the tree it is
// answerable for. Reproduced before the fix: a scratch `src/linked.mjs` pointing at an outside
// file made `format-check.mjs` report the OUTSIDE file's trailing whitespace under the
// in-repository name. What follows drives the real gate scripts over real links.

const outsideFile = async (root, contents) => {
  const outside = await makeScratchChild(root, "outside");
  const target = path.join(outside, "outside.mjs");
  writeFileSync(target, contents, "utf8");
  return target;
};

test("an eligible symbolic link is refused rather than followed out of the repository", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-gate-symlink-");
  try {
    const repository = await gateRepository(root);
    // The outside target carries BOTH gates' violations, so following it would be visible in
    // either gate's findings rather than only in a count.
    const target = await outsideFile(root, "// @ts-ignore\nexport const outside = 1;   \n");
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    // Tracked: an index entry of mode 120000.
    symlinkSync(target, path.join(repository, "src/linked.mjs"));
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    assert.equal(git(repository, "ls-files", "-s", "src/linked.mjs").split(/\s+/u)[0], "120000");
    // Untracked but unignored: enumerated by `--others`, and equally a link.
    symlinkSync(target, path.join(repository, "src/untracked_link.mjs"));

    for (const script of ["lint.mjs", "format-check.mjs"]) {
      const result = runGate(repository, script);
      assert.equal(result.status, 1, `${script} did not fail: ${result.output}`);
      assert.match(result.output, /src\/linked\.mjs: is a symbolic link/u);
      assert.match(result.output, /src\/untracked_link\.mjs: is a symbolic link/u);
      // The decisive assertion: neither gate reported anything ABOUT the outside contents. A gate
      // that followed the link reported `trailing whitespace on line 1` (format) or
      // `no-ts-ignore` (lint) against the in-repository name.
      assert.equal(
        /linked\.mjs: trailing whitespace/u.test(result.output),
        false,
        `${script} read through the link: ${result.output}`,
      );
      assert.equal(
        /linked\.mjs:\d+: no-ts-ignore/u.test(result.output),
        false,
        `${script} read through the link: ${result.output}`,
      );
      // Both refusals are named individually. The coverage summary is printed only when a gate
      // passes, so what a failing gate owes is one named finding per refused candidate, which is
      // what is asserted above; the counts themselves are asserted against `inspectCandidates`.
      assert.equal(result.output.match(/is a symbolic link/gu).length, 2, result.output);
    }
  } finally {
    await removeScratch(root);
  }
});

test("a link to an in-repository file is refused by the same rule, and the real file is still checked once", gitWorktreeSkip, async () => {
  // ONE POLICY, STATED. Every symbolic link is refused, whatever it points at. The alternative —
  // resolving the target and allowing links that stay inside — would need a realpath comparison
  // that is itself racy, and would check the same bytes twice under two names. An in-repository
  // target is already a candidate under its own name, so refusing the link loses no coverage.
  const root = await scratchRoot("bachata-gate-symlink-inside-");
  try {
    const repository = await gateRepository(root);
    write(repository, "src/real.mjs", "export const real = 1;\n");
    symlinkSync(path.join(repository, "src/real.mjs"), path.join(repository, "src/alias.mjs"));
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");

    const result = runGate(repository, "format-check.mjs");
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /src\/alias\.mjs: is a symbolic link/u);
    assert.equal(/src\/real\.mjs/u.test(result.output), false, result.output);
    assert.equal(result.output.match(/is a symbolic link/gu).length, 1, result.output);
  } finally {
    await removeScratch(root);
  }
});

test("the reader never opens the path a link points at", gitWorktreeSkip, async () => {
  // A recorder over the real `open`: every absolute path the reader asks for is written down, so
  // "the outside file was not read" is a recorded fact rather than an inference from the output.
  const root = await scratchRoot("bachata-gate-recorder-");
  try {
    const { containedReader, symlinkRefusalIsAtomic } = await loadCandidateModule();
    const repository = await makeScratchChild(root, "repository");
    const target = await outsideFile(root, "export const outside = 1;\n");
    mkdirSync(path.join(repository, "src"), { recursive: true });
    writeFileSync(path.join(repository, "src/real.mjs"), "export const real = 1;\n", "utf8");
    symlinkSync(target, path.join(repository, "src/linked.mjs"));

    const opened = [];
    const { open } = require("node:fs/promises");
    const read = containedReader({
      root: repository,
      open: (file, flags) => {
        opened.push(file);
        return open(file, flags);
      },
    });

    assert.equal(await read("src/real.mjs"), "export const real = 1;\n");
    await assert.rejects(() => read("src/linked.mjs"), /is a symbolic link/u);
    assert.equal(opened.includes(target), false, `the reader opened the outside target: ${JSON.stringify(opened)}`);
    assert.deepEqual(opened, [path.join(repository, "src/real.mjs")]);
    // On POSIX the link is refused by the open itself, so not even the link's own name is opened.
    // On Windows the preceding `lstat` refuses it and the flag degrades to zero; the module says
    // which guarantee it is offering rather than asserting the stronger one everywhere.
    assert.equal(symlinkRefusalIsAtomic, process.platform !== "win32");
  } finally {
    await removeScratch(root);
  }
});

test("an eligible candidate that is not a regular file is refused, not silently checked", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-gate-portable-");
  try {
    const { containedReader } = await loadCandidateModule();
    const repository = await makeScratchChild(root, "repository");
    // A directory carrying an eligible extension opens successfully on POSIX and is caught by the
    // `fstat` on the handle, not by anything about its name.
    mkdirSync(path.join(repository, "src", "looks-like.mjs"), { recursive: true });
    const read = containedReader({ root: repository });
    await assert.rejects(() => read("src/looks-like.mjs"), /is a directory, and a gate reads regular files/u);

    // A FIFO is the case that would otherwise hang instead of failing: opening one for reading
    // blocks until a writer arrives, and `O_NONBLOCK` is what turns that into a refusal.
    if (process.platform === "win32") {
      const fifo = containedReader({
        root: repository,
        lstat: async () => ({
          isSymbolicLink: () => false, isFile: () => false,
          isDirectory: () => false, isFIFO: () => true,
        }),
        open: async () => { throw new Error("a FIFO must never be opened"); },
      });
      await assert.rejects(() => fifo("src/pipe.mjs"), /is a FIFO, and a gate reads regular files/u);
    } else {
      const made = spawnSync("mkfifo", [path.join(repository, "src", "pipe.mjs")], { encoding: "utf8" });
      assert.equal(made.status, 0, made.stderr);
      await assert.rejects(() => read("src/pipe.mjs"), /is a FIFO, and a gate reads regular files/u);
    }
  } finally {
    await removeScratch(root);
  }
});

test("a refusal is counted apart from a read, a deletion and an unexpected failure", async () => {
  const root = await scratchRoot("bachata-gate-refusal-counts-");
  try {
    const { candidateSummary, containedReader, inspectCandidates } = await loadCandidateModule();
    const eligible = (relative) => relative.endsWith(".mjs");
    const linkStat = { isSymbolicLink: () => true };
    const fileStat = { isSymbolicLink: () => false };
    const failing = (code) => Object.assign(new Error(code || "no code"), ...(code ? [{ code }] : []));

    // The reader's own failure modes, driven by injection rather than by a filesystem arranged to
    // produce them. An unexpected `lstat` or `open` error is NOT converted into a refusal: it is
    // an unexpected error and must fail the gate as one.
    const reader = (stats, openBehaviour) =>
      containedReader({
        root: "/repository",
        lstat: () => (stats instanceof Error ? Promise.reject(stats) : Promise.resolve(stats)),
        open: openBehaviour,
      });
    await assert.rejects(() => reader(linkStat, () => Promise.reject(new Error("unreachable")))("a.mjs"), /is a symbolic link/u);
    for (const code of ["EACCES", "EIO", ""]) {
      await assert.rejects(
        () => reader(failing(code), () => Promise.reject(new Error("unreachable")))("a.mjs"),
        (error) => error.candidateRefusal === undefined,
        `an ${code || "codeless"} lstat failure was turned into a refusal`,
      );
      await assert.rejects(
        () => reader(fileStat, () => Promise.reject(failing(code)))("a.mjs"),
        (error) => error.candidateRefusal === undefined,
        `an ${code || "codeless"} open failure was turned into a refusal`,
      );
    }

    // And the accounting: refusals, reads, tracked deletions and unexpected failures are four
    // separate counts, and together they still close against `eligible`.
    const refuse = (reason) => Promise.reject(Object.assign(new Error(reason), { candidateRefusal: reason }));
    const result = await inspectCandidates({
      files: ["read.mjs", "link.mjs", "dir.mjs", "gone.mjs", "opaque.mjs", "skip.json"],
      deletions: new Set(["gone.mjs"]),
      eligible,
      read: (relative) =>
        relative === "link.mjs"
          ? refuse("is a symbolic link, and a gate does not read through one to bytes outside the tree it is answerable for")
          : relative === "dir.mjs"
            ? refuse("is a directory, and a gate reads regular files")
            : relative === "gone.mjs"
              ? Promise.reject(failing("ENOENT"))
              : relative === "opaque.mjs"
                ? Promise.reject(failing("EACCES"))
                : Promise.resolve("export const read = 1;\n"),
    });
    assert.deepEqual(result.counts, {
      enumerated: 6,
      eligible: 5,
      checked: 1,
      ineligible: 1,
      trackedDeletions: 1,
      unreadable: 1,
      refused: 2,
    });
    assert.equal(
      result.counts.eligible,
      result.counts.checked +
        result.counts.trackedDeletions +
        result.counts.unreadable +
        result.counts.refused,
      "the accounting does not close",
    );
    assert.match(candidateSummary(result.counts), /2 refused/u);
    assert.equal(result.problems.length, 3);
    assert.match(result.problems.join("\n"), /link\.mjs: is a symbolic link/u);
    assert.match(result.problems.join("\n"), /dir\.mjs: is a directory/u);
    assert.match(result.problems.join("\n"), /opaque\.mjs: could not be read \(EACCES\)/u);

    // A tracked deletion still reads as a deletion when the reader is the one reporting ENOENT,
    // and an absent candidate with no tracked deletion behind it still reads as a changing tree.
    const raced = await inspectCandidates({
      files: ["gone.mjs"],
      deletions: new Set(),
      eligible,
      read: () => Promise.reject(failing("ENOENT")),
    });
    assert.equal(raced.counts.refused, 0);
    assert.equal(raced.counts.unreadable, 1);
    assert.match(raced.problems[0], /the tree changed while the gate was running/u);
  } finally {
    await removeScratch(root);
  }
});

// A stat answer for a named entry kind, with every predicate `entryKind` consults present. A
// half-built double would report "not a regular file" for a FIFO and hide which branch ran.
const kindStats = (kind) => ({
  isSymbolicLink: () => kind === "symlink",
  isFile: () => kind === "file",
  isDirectory: () => kind === "directory",
  isFIFO: () => kind === "fifo",
  isSocket: () => kind === "socket",
  isBlockDevice: () => kind === "block",
  isCharacterDevice: () => kind === "character",
});

test("a tracked file under a symbolic-link ancestor is refused, not read from outside the repository", gitWorktreeSkip, async () => {
  // THE ESCAPE THIS CLOSES, AND WHY THE FINAL COMPONENT WAS NEVER ENOUGH. `git ls-files --cached`
  // reads names out of the index. Git therefore never descends the working tree for a tracked
  // path to be enumerated, and a directory replaced by a link after the fact still yields every
  // tracked name under it — with no link on the final component for `O_NOFOLLOW` to catch. Run
  // against the version of the reader that inspected the final component only, the format gate
  // reported the OUTSIDE file's trailing whitespace under the in-repository name.
  const root = await scratchRoot("bachata-gate-ancestor-outside-");
  try {
    const repository = await gateRepository(root);
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    // The outside file carries BOTH gates' violations, so following the ancestor would show up in
    // either gate's findings rather than only in a count.
    const outside = await makeScratchChild(root, "outside");
    writeFileSync(path.join(outside, "tracked.mjs"), "// @ts-ignore\nexport const outside = 1;   \n", "utf8");
    renameSync(path.join(repository, "src"), path.join(repository, "src.real"));
    symlinkSync(outside, path.join(repository, "src"), process.platform === "win32" ? "junction" : "dir");
    // Nothing about the index changed: the tracked entry is still an ordinary file, not a link.
    assert.equal(git(repository, "ls-files", "-s", "src/tracked.mjs").split(/\s+/u)[0], "100644");
    assert.ok(git(repository, "ls-files", "--cached").includes("src/tracked.mjs"));

    for (const script of ["lint.mjs", "format-check.mjs"]) {
      const result = runGate(repository, script);
      assert.equal(result.status, 1, `${script} did not fail: ${result.output}`);
      assert.match(result.output, /src\/tracked\.mjs: an ancestor is a symbolic link/u);
      // The decisive assertions: neither gate reported anything ABOUT the outside contents.
      assert.equal(
        /src\/tracked\.mjs: trailing whitespace/u.test(result.output),
        false,
        `${script} read through the ancestor: ${result.output}`,
      );
      assert.equal(
        /src\/tracked\.mjs:\d+: no-ts-ignore/u.test(result.output),
        false,
        `${script} read through the ancestor: ${result.output}`,
      );
    }
  } finally {
    await removeScratch(root);
  }
});

test("a symbolic-link ancestor is refused even when it points back inside the repository", gitWorktreeSkip, async () => {
  // ONE POLICY, STATED. An ancestor link is refused wherever it points, exactly as a final
  // component link is. Resolving the target and allowing the ones that stay inside would need a
  // realpath comparison that is itself racy, and would read the same bytes twice under two names.
  // The real directory is already a candidate under its own name, so nothing is lost: the file
  // below is reported once, under `inner/`, and the link path is refused.
  const root = await scratchRoot("bachata-gate-ancestor-inside-");
  try {
    const repository = await gateRepository(root);
    write(repository, "src/tracked.mjs", "export const tracked = 1;\n");
    write(repository, "inner/tracked.mjs", "export const inner = 1;   \n");
    git(repository, "add", "--all");
    git(repository, "commit", "-m", "initial");
    renameSync(path.join(repository, "src"), path.join(repository, "src.real"));
    symlinkSync(path.join(repository, "inner"), path.join(repository, "src"), process.platform === "win32" ? "junction" : "dir");

    const result = runGate(repository, "format-check.mjs");
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /src\/tracked\.mjs: an ancestor is a symbolic link/u);
    assert.match(result.output, /inner\/tracked\.mjs: trailing whitespace on line 1/u);
    assert.equal(result.output.match(/trailing whitespace/gu).length, 1, result.output);
  } finally {
    await removeScratch(root);
  }
});

test("a repository root reached through a symbolic link is refused before any candidate is opened", gitWorktreeSkip, async () => {
  const root = await scratchRoot("bachata-gate-linked-root-");
  try {
    const { containedReader } = await loadCandidateModule();
    const repository = await makeScratchChild(root, "repository");
    mkdirSync(path.join(repository, "src"), { recursive: true });
    writeFileSync(path.join(repository, "src/real.mjs"), "export const real = 1;\n", "utf8");
    const linkedRoot = path.join(root, "linked-root");
    symlinkSync(repository, linkedRoot, process.platform === "win32" ? "junction" : "dir");

    const opened = [];
    const { open } = require("node:fs/promises");
    const read = containedReader({
      root: linkedRoot,
      open: (file, flags) => {
        opened.push(file);
        return open(file, flags);
      },
    });
    await assert.rejects(() => read("src/real.mjs"), /the owned root is a symbolic link/u);
    assert.deepEqual(opened, [], `the reader opened through a linked root: ${JSON.stringify(opened)}`);
    // The same candidate through the canonical root is ordinary, so the refusal is about the root
    // and not about the file.
    assert.equal(await containedReader({ root: repository })("src/real.mjs"), "export const real = 1;\n");
  } finally {
    await removeScratch(root);
  }
});

test("an unanswerable containment question is a refusal, and a genuinely absent component is not", async () => {
  const { containedReader } = await loadCandidateModule();
  const failing = (code) => Object.assign(new Error(code || "no code"), ...(code ? [{ code }] : []));
  const unreachableOpen = () => Promise.reject(new Error("unreachable"));
  const reader = (overrides) =>
    containedReader({
      root: "/repository",
      resolveReal: (value) => value,
      inspectAncestor: () => kindStats("directory"),
      lstat: () => Promise.resolve(kindStats("file")),
      open: unreachableOpen,
      ...overrides,
    });

  // Every failure that leaves the containment question unanswered fails closed as a NAMED
  // refusal, at the root and at an ancestor alike. `ELOOP` is in the list on purpose: a link loop
  // during the walk is exactly the case an "it is probably missing" reading would wave through.
  for (const code of ["EACCES", "EIO", "ELOOP", ""]) {
    await assert.rejects(
      () => reader({ resolveReal: () => { throw failing(code); } })("src/a.mjs"),
      (error) =>
        typeof error.candidateRefusal === "string" &&
        /the owned root could not be inspected/u.test(error.candidateRefusal),
      `an ${code || "codeless"} root inspection failure did not refuse`,
    );
    await assert.rejects(
      () => reader({ inspectAncestor: () => { throw failing(code); } })("src/a.mjs"),
      (error) =>
        typeof error.candidateRefusal === "string" &&
        /an ancestor could not be inspected/u.test(error.candidateRefusal),
      `an ${code || "codeless"} ancestor inspection failure did not refuse`,
    );
  }

  // A component that is genuinely absent is not a containment problem. The walk answers nothing,
  // the read fails with `ENOENT`, and it stays an ENOENT so `inspectCandidates` can still tell a
  // tracked deletion from a tree that changed mid-run.
  for (const code of ["ENOENT", "ENOTDIR"]) {
    await assert.rejects(
      () =>
        reader({
          inspectAncestor: () => { throw failing(code); },
          lstat: () => Promise.reject(failing("ENOENT")),
        })("src/a.mjs"),
      (error) => error.candidateRefusal === undefined && error.code === "ENOENT",
      `an ${code} ancestor turned into a refusal instead of an absence`,
    );
  }

  // A candidate whose joined path leaves the root by name alone never reaches the filesystem.
  await assert.rejects(
    () => reader({})("../outside.mjs"),
    /resolves outside the repository the gate is answerable for/u,
  );
});

test("an ancestor link, a named non-regular entry and a non-regular handle are each refused before any byte is read", async () => {
  const { containedReader } = await loadCandidateModule();
  const opened = [];
  const reader = (overrides) =>
    containedReader({
      root: "/repository",
      resolveReal: (value) => value,
      inspectAncestor: () => kindStats("directory"),
      lstat: () => Promise.resolve(kindStats("file")),
      open: (file) => {
        opened.push(file);
        return Promise.reject(new Error("unreachable"));
      },
      ...overrides,
    });

  // An ancestor link is refused with the open never attempted, so no name outside the tree is
  // even handed to the operating system.
  await assert.rejects(
    () => reader({ inspectAncestor: () => kindStats("symlink") })("src/a.mjs"),
    /an ancestor is a symbolic link/u,
  );
  assert.deepEqual(opened, []);

  // The candidate's own `lstat` names the kind, and a non-regular entry is refused there rather
  // than by the `fstat` that follows. That is the guarantee Windows needs: a directory, a FIFO or
  // a device node does not open the same way there, so a refusal that depended on the open having
  // succeeded would not hold.
  for (const [kind, expected] of [["directory", /is a directory/u], ["fifo", /is a FIFO/u], ["socket", /is a socket/u], ["block", /is a block device/u], ["character", /is a character device/u]]) {
    await assert.rejects(() => reader({ lstat: () => Promise.resolve(kindStats(kind)) })("src/a.mjs"), expected);
  }
  assert.deepEqual(opened, [], `a non-regular entry was opened: ${JSON.stringify(opened)}`);

  // And the `fstat` on the handle still refuses an object whose NAME said regular file, which is
  // the case a name-only check cannot see. The handle is closed either way.
  let closed = 0;
  await assert.rejects(
    () =>
      reader({
        open: () =>
          Promise.resolve({
            stat: () => Promise.resolve(kindStats("directory")),
            readFile: () => Promise.reject(new Error("a refused handle was read")),
            close: () => {
              closed += 1;
              return Promise.resolve();
            },
          }),
      })("src/a.mjs"),
    /is a directory, and a gate reads regular files/u,
  );
  assert.equal(closed, 1);
});
