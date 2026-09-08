const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const exporter = path.join(root, "scripts", "source-distribution.mjs");

const doesNotExist = async (candidate) => {
  await assert.rejects(access(candidate));
};

test("source exporter emits maintained source only and validator rejects artifacts", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bachata-vscode-source-"));
  const output = path.join(parent, "export");
  try {
    const exported = await execFileAsync(
      process.execPath,
      [exporter, "export", output],
      { cwd: root, timeout: 30_000 },
    );
    assert.match(exported.stdout, /maintained source files/u);
    assert.equal(
      JSON.parse(await readFile(path.join(output, "package.json"), "utf8")).name,
      "bachata-vscode",
    );
    await access(path.join(output, "src", "extension.ts"));
    await access(path.join(output, "protocol", "browser-bridge.compatibility.json"));
    await access(path.join(output, "media", "icon.png"));
    await access(path.join(output, "media", "readme-header.png"));
    await access(path.join(output, "media", "walkthrough-setup.md"));
    // The exported tree is installed with `npm ci` by continuous integration and by any
    // reader who builds it, so its lockfile is part of the distribution.
    await access(path.join(output, "package-lock.json"));
    await doesNotExist(path.join(output, "dist"));
    await doesNotExist(path.join(output, ".bachata-worktree.lock"));
    await doesNotExist(path.join(output, "managed-fallback-verification.json"));

    await mkdir(path.join(output, "test-results"));
    await writeFile(path.join(output, "test-results", "result.json"), "{}\n", "utf8");
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [exporter, "verify", output],
        { cwd: root, timeout: 30_000 },
      ),
      /Source distribution validation failed/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("source exporter refuses targets inside the source package", async () => {
  const candidate = path.join(root, `.bachata-source-export-${process.pid}-${Date.now()}`);
  await assert.rejects(
    execFileAsync(
      process.execPath,
      [exporter, "export", candidate],
      { cwd: root, timeout: 30_000 },
    ),
    /outside the source package/u,
  );
  await doesNotExist(candidate);
});

test("source verification rejects packages missing required build inputs", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bachata-vscode-source-required-"));
  const output = path.join(parent, "export");
  try {
    await execFileAsync(process.execPath, [exporter, "export", output], { cwd: root, timeout: 60_000 });
    await rm(path.join(output, "protocol", "browser-protocol-v9.contract.json"));
    await assert.rejects(
      execFileAsync(process.execPath, [exporter, "verify", output], { cwd: root, timeout: 60_000 }),
      /required build input is missing/u,
    );

    await rm(path.join(output, "LICENSE"));
    await assert.rejects(
      execFileAsync(process.execPath, [exporter, "verify", output], { cwd: root, timeout: 60_000 }),
      /required maintained source entry is missing/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("both packages export the root lockfile and refuse nested ones", async () => {
  const exporterSource = await readFile(path.join(root, "scripts", "source-distribution.mjs"), "utf8");
  assert.equal(
    exporterSource.includes("\"package-lock.json\","),
    true,
    "the source profiles must carry the root package-lock.json",
  );
  assert.match(
    exporterSource,
    /rootOnlyFileNames/u,
    "a lockfile is maintained source only at the package root",
  );
  assert.equal(
    exporterSource.includes("\".vscodeignore\","),
    false,
    "VSCE refuses a package that declares both a files property and a .vscodeignore, so the "
    + "source profile must not allow one",
  );
});

test("a nested lockfile is never exported and fails verification", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bachata-vscode-source-nested-"));
  const output = path.join(parent, "export");
  const nested = path.join(root, "scripts", "package-lock.json");
  try {
    await writeFile(nested, JSON.stringify({ name: "nested-install", lockfileVersion: 3 }), "utf8");
    await execFileAsync(process.execPath, [exporter, "export", output], { cwd: root, timeout: 60_000 });
    await access(path.join(output, "package-lock.json"));
    await doesNotExist(path.join(output, "scripts", "package-lock.json"));

    await writeFile(
      path.join(output, "scripts", "package-lock.json"),
      JSON.stringify({ name: "nested-install", lockfileVersion: 3 }),
      "utf8",
    );
    await assert.rejects(
      execFileAsync(process.execPath, [exporter, "verify", output], { cwd: root, timeout: 60_000 }),
      /Source distribution validation failed/u,
      "a nested lockfile inside a maintained directory must fail verification",
    );
  } finally {
    await rm(nested, { force: true });
    await rm(parent, { recursive: true, force: true });
  }
});

test("the exported extension source installs with npm ci", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "bachata-vscode-source-lockfile-"));
  const output = path.join(parent, "export");
  try {
    await execFileAsync(process.execPath, [exporter, "export", output], { cwd: root, timeout: 60_000 });
    const exported = JSON.parse(await readFile(path.join(output, "package-lock.json"), "utf8"));
    const repository = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
    assert.equal(exported.lockfileVersion, repository.lockfileVersion);
    assert.equal(exported.name, repository.name);
    assert.ok(
      Number(exported.lockfileVersion) >= 1,
      "npm ci requires a lockfile with lockfileVersion >= 1",
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// EX-A5-R18. The mandatory suite reads files straight out of the tree it runs in — the release
// workflow, the ignore file, the lock implementation, the generated build facts. An export that
// carries fewer of them than the contract records is an export the suite cannot run against, and
// the only way to know is to build a fresh one and look. No pre-existing archive is read here:
// an archive whose assembly is unknown proves nothing about this checkout's export contract.
test("a fresh source export carries every file the mandatory suite reads", async () => {
  const { collectMaintainedSourceFiles } = await import(
    `file://${path.join(root, "scripts", "source-distribution.mjs")}`
  );
  const parent = await mkdtemp(path.join(os.tmpdir(), "bachata-vscode-source-suite-inputs-"));
  const output = path.join(parent, "export");
  try {
    await execFileAsync(process.execPath, [exporter, "export", output], { cwd: root, timeout: 120_000 });
    const declared = await collectMaintainedSourceFiles(root);
    const missing = [];
    for (const relative of declared) {
      try {
        await access(path.join(output, relative));
      } catch {
        missing.push(relative);
      }
    }
    assert.deepEqual(missing, [], "the export contract declares files the export does not carry");
    // The inputs the mandatory suite reads by name, stated here so a change to either side has to
    // be a deliberate one rather than a silent divergence.
    for (const relative of [
      ".github/workflows/paired-release.yml",
      ".gitignore",
      "scripts/build.mjs",
      "scripts/lib/worktreeLock.mjs",
      "BUILD_FACTS.md",
      "docs/RELEASE_VERDICT.md",
    ]) {
      assert.ok(
        declared.includes(relative),
        `${relative} is read by the mandatory suite but is not part of the export contract`,
      );
      await access(path.join(output, relative));
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the recorded maintained source count matches what the exporter carries", async () => {
  const { collectMaintainedSourceFiles } = await import(
    `file://${path.join(root, "scripts", "source-distribution.mjs")}`
  );
  const files = await collectMaintainedSourceFiles(root);
  const facts = await readFile(path.join(root, "BUILD_FACTS.md"), "utf8");
  const recorded = /\| Maintained source files \(working tree, what source:export carries\) \| (\d+) \|/u.exec(facts);
  assert.notEqual(recorded, null, "BUILD_FACTS.md must record the maintained source count");
  assert.equal(
    Number(recorded[1]),
    files.length,
    "BUILD_FACTS.md records a stale maintained source count; rerun npm run docs:build-facts",
  );
  const verdict = await readFile(path.join(root, "docs", "RELEASE_VERDICT.md"), "utf8");
  assert.match(
    verdict,
    /BUILD_FACTS\.md/u,
    "docs/RELEASE_VERDICT.md must cite the generated build facts rather than restate them",
  );
});

test("the verdict uses maintained-source identity instead of an absent sidecar manifest", async () => {
  const verdict = await readFile(path.join(root, "docs", "RELEASE_VERDICT.md"), "utf8");
  assert.doesNotMatch(verdict, /bachata-vscode-\d+\.\d+\.\d+\.SHA256SUMS/u);
  assert.match(verdict, /BUILD_FACTS\.md/u);
  assert.match(verdict, /npm run source:export/u);
  assert.match(verdict, /npm run source:verify/u);
});

test("the lockfile root metadata matches package.json, so npm ci installs this package", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
  const rootEntry = lock.packages?.[""] ?? {};
  const canonical = (value) =>
    JSON.stringify(Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right))));
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.version, manifest.version);
  assert.equal(rootEntry.name, manifest.name);
  assert.equal(rootEntry.version, manifest.version);
  assert.equal(rootEntry.license, manifest.license);
  assert.equal(
    canonical(rootEntry.engines),
    canonical(manifest.engines),
    "the lockfile records stale engines; regenerate it with npm install --package-lock-only",
  );
  assert.equal(
    canonical(rootEntry.engines).includes(String(manifest.engines.node)),
    true,
    "the declared Node floor must reach the lockfile npm ci reads",
  );
});

test("check:lockfile refuses a tree with no lockfile instead of accepting a lockless mode", async () => {
  const source = await readFile(path.join(root, "scripts", "check-lockfile.mjs"), "utf8");
  assert.match(source, /No package-lock\.json is present/u);
  assert.equal(
    /source-only distribution without a lockfile/u.test(source),
    false,
    "the lockless distribution contract is retired",
  );
  const parent = await mkdtemp(path.join(os.tmpdir(), "bachata-lockfile-gate-"));
  try {
    await writeFile(
      path.join(parent, "package.json"),
      JSON.stringify({ name: "bachata-vscode", version: "0.0.0", dependencies: {} }),
      "utf8",
    );
    await assert.rejects(
      execFileAsync(process.execPath, [path.join(root, "scripts", "check-lockfile.mjs")], {
        cwd: parent,
        timeout: 30_000,
      }),
      /No package-lock\.json is present/u,
    );
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

// This repository's suite must run from a checkout of this repository alone. The Browser
// Bridge half of this assertion lives in that repository's own suite; the two exporters are
// held together by the shared fixture digest below, not by reading across a sibling path
// that an isolated checkout does not have.
test("this exporter declares only the package it belongs to", async () => {
  const extension = await readFile(path.join(root, "scripts", "source-distribution.mjs"), "utf8");
  assert.match(extension, /"bachata-vscode": \{/u);
  assert.equal(
    /"bachata-browser-bridge": \{/u.test(extension),
    false,
    "a foreign package profile is unreachable here and drifts from the exporter that uses it",
  );
});

test("generated facts enumerate tracked paths and exclude untracked files", async () => {
  const module = await import(
    `file://${path.join(root, "scripts", "source-distribution.mjs")}`
  );
  const tracked = await module.collectTrackedMaintainedSourceFiles(root);
  const workingTree = await module.collectMaintainedSourceFiles(root);
  assert.ok(
    tracked.files.length <= workingTree.length,
    "the tracked set is a subset of the maintained working tree",
  );
  // EX-G6-18. A maintained-source distribution carries no VCS metadata by design, and running
  // this suite is part of the documented flow for an extracted one. Where there is no checkout
  // to ask, the enumeration says so and reports the whole maintained tree — that much is still
  // checkable, and the Git comparison below is checkout-only rather than quietly skipped.
  if (!tracked.enumeratedByGit) {
    assert.deepEqual(
      [...tracked.files].sort(),
      [...workingTree].sort(),
      "without a checkout the tracked enumeration must be the whole maintained tree, not a guess",
    );
    const factsWithoutGit = await readFile(path.join(root, "BUILD_FACTS.md"), "utf8");
    assert.match(
      factsWithoutGit,
      /\| Maintained source files \(Git-tracked\) \| \d+ \|/u,
      "BUILD_FACTS.md must record the tracked source count",
    );
    return;
  }
  const trackedSet = new Set(tracked.files);
  // `entry => trackedSet.has(entry) || true` was a tautology and could not fail. Prove the
  // distinction against Git itself rather than by creating a file: other test files measure
  // this same tree concurrently, so a probe that mutates it makes their gates flaky.
  const listed = await execFileAsync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 32 * 1024 * 1024 });
  const gitTracked = new Set(listed.stdout.split("\0").filter(Boolean));
  assert.ok(gitTracked.size > 0, "git ls-files reported nothing; this guard proves nothing");

  const untrackedInWorkingTree = workingTree.filter((entry) => !gitTracked.has(entry));
  assert.deepEqual(
    tracked.files.filter((entry) => !gitTracked.has(entry)),
    [],
    "the tracked enumeration returned paths Git does not track",
  );
  assert.deepEqual(
    workingTree.filter((entry) => gitTracked.has(entry)).sort(),
    [...tracked.files].sort(),
    "the tracked enumeration is not the working tree filtered by Git",
  );
  assert.equal(
    tracked.files.length + untrackedInWorkingTree.length,
    workingTree.length,
    "the two enumerations do not partition the maintained working tree",
  );

  const facts = await readFile(path.join(root, "BUILD_FACTS.md"), "utf8");
  const recordedTracked = /\| Maintained source files \(Git-tracked\) \| (\d+) \|/u.exec(facts);
  assert.notEqual(recordedTracked, null, "BUILD_FACTS.md must record the tracked source count");
  assert.equal(Number(recordedTracked[1]), tracked.files.length);
});

test("an excluded name is skipped before it is stat-ed, even as a broken symbolic link", async () => {
  const { collectMaintainedSourceFiles } = await import(
    `file://${path.join(root, "scripts", "source-distribution.mjs")}`
  );
  const link = path.join(root, "node_modules-probe-link");
  const excluded = path.join(root, "node_modules");
  const hadExcluded = await access(excluded).then(() => true, () => false);
  if (hadExcluded) {
    // node_modules already exists here; prove the excluded-name rule against it directly.
    const files = await collectMaintainedSourceFiles(root);
    assert.equal(
      files.some((entry) => entry.startsWith("node_modules")),
      false,
      "an excluded dependency root was collected",
    );
    return;
  }
  await symlink(path.join(root, "does-not-exist"), link);
  try {
    await assert.rejects(collectMaintainedSourceFiles(root), /symbolic links/u);
  } finally {
    await rm(link, { force: true });
  }
});

test("a symbolic link the manifest carries is still refused", async () => {
  const { collectMaintainedSourceFiles } = await import(
    `file://${path.join(root, "scripts", "source-distribution.mjs")}`
  );
  const link = path.join(root, "src", `bachata-link-probe-${randomUUID()}.ts`);
  await symlink(path.join(root, "package.json"), link);
  try {
    await assert.rejects(
      collectMaintainedSourceFiles(root),
      /symbolic links/u,
      "a symbolic link inside maintained source was accepted",
    );
  } finally {
    await rm(link, { force: true });
  }
});

// Shared lexical-exclusion matrix. The same fixture file, byte for byte, lives in the
// Browser Bridge repository; the digest assertion below fails if either copy is edited alone.
const SHARED_EXPORT_FIXTURE_SHA256 =
  "4bee20465b81f4d053ed3d25745a41ece0488625b740f3f10ba6f9f448bfa039";

const sharedExportFixtures = () =>
  JSON.parse(
    require("node:fs").readFileSync(
      path.join(root, "protocol", "source-export.fixtures.json"),
      "utf8",
    ),
  );

test("the shared source-export fixture table cannot drift on one side", async () => {
  const bytes = await readFile(path.join(root, "protocol", "source-export.fixtures.json"));
  assert.equal(
    require("node:crypto").createHash("sha256").update(bytes).digest("hex"),
    SHARED_EXPORT_FIXTURE_SHA256,
  );
  assert.equal(sharedExportFixtures().id, "bachata-source-export-exclusion-v1");
});

const buildExportCaseTree = async (base, outside, testCase) => {
  const target = path.join(base, testCase.path);
  await mkdir(path.dirname(target), { recursive: true });
  if (testCase.type === "directory") {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "carried.txt"), "carried\n");
    return;
  }
  if (testCase.type === "file") {
    await writeFile(target, "carried\n");
    return;
  }
  // The link target lives outside the package, as a hoisted `node_modules` link does.
  const linkTarget = path.join(outside, "link-target");
  if (testCase.type === "symlink") {
    await mkdir(linkTarget, { recursive: true });
    await writeFile(path.join(linkTarget, "carried.txt"), "carried\n");
    await symlink(linkTarget, target);
    return;
  }
  await symlink(path.join(outside, "absent-target"), target);
};

test("the exporter applies every shared exclusion case by name before type", async () => {
  const { collectMaintainedSourceFiles } = await import(`file://${exporter}`);
  for (const testCase of sharedExportFixtures().cases) {
    const parent = await mkdtemp(path.join(os.tmpdir(), "bachata-extension-export-case-"));
    const source = path.join(parent, "package");
    try {
      await mkdir(path.join(source, "src"), { recursive: true });
      await writeFile(path.join(source, "package.json"), JSON.stringify({ name: "bachata-vscode" }));
      await writeFile(path.join(source, "README.md"), "# fixture\n");
      await writeFile(path.join(source, "src", "index.ts"), "export const value = 1;\n");
      await buildExportCaseTree(source, parent, testCase);

      const collected = collectMaintainedSourceFiles(source);
      if (testCase.rejected) {
        await assert.rejects(
          collected,
          /symbolic links/u,
          `${testCase.name}: a carried symbolic link must be rejected`,
        );
        continue;
      }
      const files = await collected;
      const carried = files.some((relative) =>
        relative === testCase.path || relative.startsWith(`${testCase.path}/`));
      assert.equal(
        carried,
        !testCase.excluded,
        `${testCase.name}: expected excluded=${String(testCase.excluded)} for ${testCase.path}`,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }
});
