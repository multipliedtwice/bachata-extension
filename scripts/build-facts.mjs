import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  collectMaintainedSourceFiles,
  collectTrackedMaintainedSourceFiles,
  trackedRepositoryPaths,
} from "./source-distribution.mjs";
import { releaseMetadataFindings } from "./lib/releaseMetadata.mjs";
import { resolvePinnedBridgeArchive } from "./lib/releaseArtifacts.mjs";
import { withWorktreeLock } from "./lib/worktreeLock.mjs";

// This generator writes measurements only. It never writes, edits, or infers a release
// verdict: SHIP and NO-SHIP live in docs/RELEASE_VERDICT.md and are authored by a human who
// reads these facts. tests/buildFacts.test.cjs holds that boundary.
//
//   node scripts/build-facts.mjs                     regenerate BUILD_FACTS.md
//   node scripts/build-facts.mjs --check             fail when the reproducible facts drifted
//   node scripts/build-facts.mjs --test-log=<path>   also record counts from a real test run
//
// Facts split in two. "Repository inventory" enumerates Git-tracked paths with `git ls-files`
// and hashes their current working-tree bytes, so --check compares it. "Observed on one
// machine" depends on the checkout, the installed dependencies and the host, so it is
// recorded but never compared.
//
// The collector contract is generated into the file rather than asserted as a fixed
// sentence: a static scope claim is exactly the kind of hand-maintained statement that
// outlives the collector it describes. Tracked enumeration with working-tree bytes equals
// HEAD only on a clean tree, and the generated contract says which it was.

const root = process.cwd();
// `--out <path>` lets a test generate into a temporary file. Without it the generator
// writes the tracked facts, so a unit test never has to dirty the checkout to exercise
// write mode.
const outFlag = process.argv.indexOf("--out");
// The generated file is itself maintained source, so its own bytes are held out of the
// manifest digest it records. That exclusion keys off the tracked name, never the output
// path, so `--out` redirects where the bytes land without changing what they say.
const trackedFactsName = "BUILD_FACTS.md";
const factsPath = outFlag >= 0 && process.argv[outFlag + 1]
  ? path.resolve(process.argv[outFlag + 1])
  : path.join(root, trackedFactsName);
const check = process.argv.includes("--check");
const testLogArgument = process.argv.find((value) => value.startsWith("--test-log="));
const requireClean = process.argv.includes("--require-clean");
const argumentValue = (prefix) => {
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const fileDigest = async (absolute) => sha256(await readFile(absolute));

const directoryBytes = async (absolute) => {
  if (!existsSync(absolute)) return undefined;
  let total = 0;
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(child);
        continue;
      }
      if (!entry.isFile()) continue;
      total += (await stat(child)).size;
    }
  };
  await walk(absolute);
  return total;
};

const megabytes = (bytes) =>
  bytes === undefined ? "not present" : `${(bytes / 1_000_000).toFixed(2)} MB`;

const gitOutput = (args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const compatibility = JSON.parse(
  readFileSync(path.join(root, "protocol", "browser-bridge.compatibility.json"), "utf8"),
);

const countSettings = () => {
  const groups = [packageJson.contributes.configuration].flat();
  return {
    total: groups.reduce((sum, group) => sum + Object.keys(group.properties).length, 0),
    groups: groups.map((group) => [group.title, Object.keys(group.properties).length]),
  };
};

const readIfPresent = (relative) => {
  const absolute = path.join(root, relative);
  return existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
};

const screenshotFiles = () => {
  const directory = path.join(root, "media", "screenshots");
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => /\.(?:png|jpe?g|gif|webp)$/iu.test(name))
    : [];
};

const metadataFindings = (stage) => releaseMetadataFindings({
  packageJson,
  readme: readIfPresent("README.md"),
  screenshotFiles: screenshotFiles(),
  bridgeInstallDocument: readIfPresent("docs/BROWSER_BRIDGE_INSTALL.md"),
  validationRecord: readIfPresent("docs/RELEASE_VALIDATION_RECORD.md"),
  providerTerms: readIfPresent("docs/PROVIDER_TERMS.md"),
  compatibilityMatrix: readIfPresent("docs/COMPATIBILITY_MATRIX.md"),
  providerDocumentationSource: readIfPresent("src/readiness/providerDocs.ts"),
  artifacts: {},
  stage,
});

/*
 * A log is a report about some candidate, not evidence about this one. Recording it binds
 * the run's exit status, the source manifest the caller says it ran against, any artifact
 * hash, and the time it was observed. Where the caller supplies no manifest, or supplies one
 * this tree no longer holds, the row says so; it never says the candidate passed.
 */
const testCounts = async (measuredManifestDigest) => {
  if (!testLogArgument) return undefined;
  const logPath = testLogArgument.slice("--test-log=".length);
  const log = await readFile(path.resolve(root, logPath), "utf8");
  const sum = (label) => Array.from(log.matchAll(new RegExp(`^\\u2139 ${label} (\\d+)$`, "gmu")))
    .reduce((total, match) => total + Number(match[1]), 0);
  const tests = sum("tests");
  if (tests === 0) {
    throw new Error(`No node:test summary was found in ${logPath}; do not record a run that did not happen.`);
  }
  const exitStatus = argumentValue("--test-exit=");
  if (exitStatus === undefined || !/^\d+$/u.test(exitStatus)) {
    throw new Error("Recording a test log requires --test-exit=<code>; a log without its run's exit status evidences nothing.");
  }
  const declaredManifest = argumentValue("--test-source-digest=");
  return {
    source: path.relative(root, path.resolve(root, logPath)),
    tests,
    pass: sum("pass"),
    fail: sum("fail"),
    skipped: sum("skipped"),
    exitStatus: Number(exitStatus),
    declaredManifest,
    artifactSha256: argumentValue("--test-artifact-sha256="),
    manifestBinding: declaredManifest === undefined
      ? "unbound"
      : declaredManifest === measuredManifestDigest
        ? "current"
        : "different",
    observedAt: new Date().toISOString(),
  };
};

const testRunStatement = (tests) => {
  if (!tests) return "not collected in this generation";
  const counts = `${String(tests.tests)} tests, ${String(tests.pass)} passed, ${String(tests.fail)} failed, ${String(tests.skipped)} skipped`;
  const binding = tests.manifestBinding === "current"
    ? `source manifest ${tests.declaredManifest} matches this tree`
    : tests.manifestBinding === "different"
      ? `source manifest ${tests.declaredManifest} is not this tree, so the log describes another candidate`
      : "no source manifest was supplied, so the log is bound to no candidate";
  return [
    counts,
    `exit status ${String(tests.exitStatus)}`,
    binding,
    tests.artifactSha256 ? `artifact SHA-256 ${tests.artifactSha256}` : "no artifact hash was supplied",
    `observed ${tests.observedAt}`,
    `from ${tests.source}`,
  ].join("; ");
};

// Two different sets, on purpose. The COUNT is the whole maintained set, including this file,
// so it stays comparable with `npm run source:export` and with the source-distribution test.
// The DIGEST omits this file alone, because a file cannot contain a hash of itself; every other
// maintained file is covered, so any source change still moves the digest.
const sourceFacts = async () => {
  const tracked = await collectTrackedMaintainedSourceFiles(root);
  const workingTree = await collectMaintainedSourceFiles(root);
  const digests = [];
  for (const relative of tracked.files) {
    if (relative === trackedFactsName) continue;
    digests.push(`${relative} ${await fileDigest(path.join(root, relative))}`);
  }
  return {
    trackedCount: tracked.files.length,
    workingTreeCount: workingTree.length,
    enumeratedByGit: tracked.enumeratedByGit,
    manifestDigest: sha256(digests.join("\n")),
  };
};

const trackedInventory = () => {
  const tracked = trackedRepositoryPaths(root);
  const countMatching = (test) => tracked === undefined
    ? undefined
    : Array.from(tracked).filter(test).length;
  return {
    presets: countMatching((entry) => /^presets\/[^/]+\.json$/u.test(entry)),
    testFiles: countMatching((entry) => /^tests\/[^/]+\.test\.cjs$/u.test(entry)),
    benchmarkTasks: countMatching((entry) => /^benchmarks\/tasks\/[^/]+\.json$/u.test(entry)),
    benchmarkResults: countMatching((entry) => /^benchmarks\/runs\/.+\.json$/u.test(entry)),
    longitudinalResults: countMatching((entry) => /^benchmarks\/longitudinal\/runs\/.+\.json$/u.test(entry)),
  };
};

// Declarations, never outcomes: a promotion type says what a preset asks to persist, not
// that any run produced it.
const declaredPromotionTypes = async () => {
  const directory = path.join(root, "presets");
  if (!existsSync(directory)) return [];
  const names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  const types = new Set();
  for (const name of names) {
    const parsed = JSON.parse(await readFile(path.join(directory, name), "utf8"));
    for (const step of parsed.steps ?? []) {
      const declared = step.artifactPromotion?.type;
      if (typeof declared === "string") types.add(declared);
    }
  }
  return Array.from(types).sort();
};

// Counted over the same tracked set as the task row, so the two never describe different
// scopes of the repository.
const benchmarkArms = async (tracked) => {
  if (tracked === undefined) return undefined;
  let arms = 0;
  for (const relative of Array.from(tracked).filter((entry) => /^benchmarks\/tasks\/[^/]+\.json$/u.test(entry))) {
    const parsed = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    arms += Object.keys(parsed.arms ?? {}).length;
  }
  return arms;
};

const moderatedInventory = () => {
  const document = readIfPresent("docs/MODERATED_VALIDATION.md");
  const rows = Array.from(document.matchAll(/^\| *(?!-)(?!Task\b)[^|\n]+\|/gmu)).length;
  const notPerformed = Array.from(document.matchAll(/Not performed/gu)).length;
  return { rows, notPerformed };
};

const artifactFacts = async () => {
  const stagedVsix = path.join(root, `bachata-vscode-${packageJson.version}.vsix`);
  const vsix = existsSync(stagedVsix)
    ? {
        name: path.basename(stagedVsix),
        bytes: (await stat(stagedVsix)).size,
        sha256: await fileDigest(stagedVsix),
      }
    : undefined;
  let bridge;
  try {
    const pinned = await resolvePinnedBridgeArchive(root);
    bridge = { name: pinned.fileName, bytes: pinned.size, sha256: pinned.sha256 };
  } catch (error) {
    bridge = { name: "unresolved", detail: error instanceof Error ? error.message : String(error) };
  }
  return { vsix, bridge };
};

const row = (name, value) => `| ${name} | ${value} |`;

const collectorContract = (facts) => [
  facts.source.enumeratedByGit
    ? "Paths enumerated with `git ls-files`; untracked files are excluded."
    : "Git was unavailable, so paths were enumerated from the filesystem and untracked files are included.",
  "Bytes are read from the current working tree, not from Git objects.",
  "`npm run check:build-facts` compares this table. `--require-clean` refuses a modified tree for release-level reproducibility.",
].join(" ");

// Which commit these values describe is deliberately absent from the compared section.
// Naming the revision or the clean/dirty state there makes the gate unsatisfiable: writing
// the file dirties the tree, and committing it moves HEAD, so a committed file can never
// describe the commit it belongs to. It is recorded below, where nothing compares it.
const treeStateContract = (facts) =>
  facts.dirty === undefined
    ? "Whether the working tree is clean could not be determined, so these values may not describe any commit."
    : facts.dirty
      ? `The working tree was modified, so these values describe the working tree and not commit ${facts.revision ?? "HEAD"}.`
      : `The working tree was clean, so these values also describe commit ${facts.revision ?? "HEAD"}.`;

const inventoryValue = (value) => value === undefined ? "not enumerable without Git" : String(value);

const reproducibleSection = (facts) => [
  "## Repository inventory",
  "",
  collectorContract(facts),
  "",
  "| Fact | Value |",
  "| --- | --- |",
  row("Extension version", packageJson.version),
  row("Pinned Browser Bridge version", compatibility.browserBridgeVersion),
  row("Browser protocol version", String(compatibility.protocolVersion)),
  // EX-G6-18. A row that says "Git-tracked" must not report a number reached without Git. The
  // enumeration falls back to the whole maintained tree where there is no checkout, which is the
  // right answer to a different question, so these two say plainly that they were not measured.
  row(
    "Maintained source files (Git-tracked)",
    inventoryValue(facts.source.enumeratedByGit ? facts.source.trackedCount : undefined),
  ),
  row(
    "Maintained source manifest SHA-256 (Git-tracked)",
    inventoryValue(facts.source.enumeratedByGit ? facts.source.manifestDigest : undefined),
  ),
  row("Contributed settings", String(facts.settings.total)),
  ...facts.settings.groups.map(([title, count]) => row(`Settings in "${title}"`, String(count))),
  row("Contributed commands", String(packageJson.contributes.commands.length)),
  row("Built-in presets (Git-tracked)", inventoryValue(facts.inventory.presets)),
  row("Test files (Git-tracked)", inventoryValue(facts.inventory.testFiles)),
  row("Declared artifact promotion types", facts.promotionTypes.length > 0 ? facts.promotionTypes.join(", ") : "none declared"),
  row("Benchmark tasks (Git-tracked)", inventoryValue(facts.inventory.benchmarkTasks)),
  row("Benchmark arms declared (Git-tracked tasks)", inventoryValue(facts.benchmarkArms)),
  row("Benchmark result records (Git-tracked)", inventoryValue(facts.inventory.benchmarkResults)),
  row("Longitudinal result records (Git-tracked)", inventoryValue(facts.inventory.longitudinalResults)),
  row("Moderated validation rows", String(facts.moderated.rows)),
  row("Moderated rows marked Not performed", String(facts.moderated.notPerformed)),
  row("Release-metadata findings (identity stage)", String(facts.identityFindings)),
  row("Release-metadata findings (evidence stage)", String(facts.evidenceFindings)),
  "",
].join("\n");

const observedSection = (facts) => [
  "## Observed on one machine",
  "",
  "Depends on the checkout, the installed dependencies and the host. Recorded, never compared.",
  "",
  treeStateContract(facts),
  "",
  "| Observation | Value |",
  "| --- | --- |",
  row("Revision", facts.revision ?? "not a Git checkout"),
  row("Working tree", facts.dirty === undefined ? "unknown" : facts.dirty ? "modified" : "clean"),
  row("Maintained source files (working tree, what source:export carries)", String(facts.source.workingTreeCount)),
  row("Platform", `${os.type()} ${os.release()} ${os.arch()}`),
  row("Node", process.version),
  row("Git", facts.gitVersion ?? "not available"),
  row("dist", megabytes(facts.distBytes)),
  ...facts.dependencyBytes.map(([name, bytes]) => row(`node_modules/${name}`, megabytes(bytes))),
  row(
    "Staged VSIX",
    facts.artifacts.vsix
      ? `${facts.artifacts.vsix.name}, ${megabytes(facts.artifacts.vsix.bytes)}, SHA-256 ${facts.artifacts.vsix.sha256}`
      : `no bachata-vscode-${packageJson.version}.vsix is staged`,
  ),
  row(
    "Pinned Browser Bridge ZIP",
    facts.artifacts.bridge
      ? facts.artifacts.bridge.sha256
        ? `${facts.artifacts.bridge.name}, ${megabytes(facts.artifacts.bridge.bytes)}, SHA-256 ${facts.artifacts.bridge.sha256}`
        : facts.artifacts.bridge.detail
      : "not resolved",
  ),
  row("Test run", testRunStatement(facts.tests)),
  "",
].join("\n");

const render = (facts) => [
  "# Build facts",
  "",
  "Generated by `scripts/build-facts.mjs`. Do not edit by hand.",
  "",
  "These are measurements. This file carries no release decision. The release verdict is",
  "authored by a human in `docs/RELEASE_VERDICT.md`, which cites this file.",
  "",
  reproducibleSection(facts),
  observedSection(facts),
].join("\n");

const reproducible = (document) => {
  const start = document.indexOf("## Repository inventory");
  const end = document.indexOf("## Observed on one machine");
  return start < 0 || end < 0 ? undefined : document.slice(start, end).trim();
};

const dependencies = ["typescript", "ts-morph", "@ts-morph", "ajv", "fast-glob", "ignore", "jsonrepair"];

const source = await sourceFacts();
const porcelain = gitOutput(["status", "--porcelain"]);
const facts = {
  source,
  settings: countSettings(),
  inventory: trackedInventory(),
  promotionTypes: await declaredPromotionTypes(),
  benchmarkArms: await benchmarkArms(trackedRepositoryPaths(root)),
  moderated: moderatedInventory(),
  identityFindings: metadataFindings("identity").length,
  evidenceFindings: metadataFindings("evidence").length,
  revision: gitOutput(["rev-parse", "HEAD"]),
  dirty: porcelain === undefined ? undefined : porcelain.length > 0,
  gitVersion: gitOutput(["--version"]),
  // Walking dist while a concurrent build rewrites it throws mid-walk, so this read takes
  // the worktree lock like every other dist consumer in the composite chain. An inherited
  // token makes the nested case free.
  distBytes: await withWorktreeLock(
    { label: "build facts dist measurement" },
    async () => await directoryBytes(path.join(root, "dist")),
  ),
  dependencyBytes: await Promise.all(
    dependencies.map(async (name) => [name, await directoryBytes(path.join(root, "node_modules", name))]),
  ),
  artifacts: await artifactFacts(),
  tests: await testCounts(source.manifestDigest),
};

if (requireClean && facts.dirty !== false) {
  console.error(
    "--require-clean refuses a modified or unknown working tree: release-level facts must describe a commit.",
  );
  process.exit(1);
}

const rendered = `${render(facts)}\n`;

if (!check) {
  writeFileSync(factsPath, rendered);
  console.log(`wrote ${path.relative(root, factsPath)}`);
  process.exit(0);
}

if (!existsSync(factsPath)) {
  console.error("BUILD_FACTS.md does not exist; run `npm run docs:build-facts`.");
  process.exit(1);
}
const committed = reproducible(readFileSync(factsPath, "utf8"));
const measured = reproducible(rendered);

/*
 * EX-G6-18. A maintained-source distribution carries no VCS metadata by design, and running this
 * gate is part of the documented flow for an extracted one. Half the inventory is enumerated with
 * `git ls-files`, so without a checkout those rows read "not enumerable without Git" and the
 * whole-section comparison failed — the distribution could not pass the checks it advertises.
 *
 * A checkout keeps the strict comparison, unchanged: the section must match byte for byte. Where
 * there is no checkout, every fact that can still be measured is compared, the ones that cannot
 * are named rather than passed over, and nothing is reported as verified that was not.
 */
const INVENTORY_UNAVAILABLE = "not enumerable without Git";

const inventoryRows = (section) => new Map(
  (section ?? "")
    .split("\n")
    .map((line) => /^\|\s(.+?)\s\|\s(.+?)\s\|$/u.exec(line.trim()))
    .filter((match) => match !== null && match[1] !== "Fact" && !/^-+$/u.test(match[1]))
    .map((match) => [match[1], match[2]]),
);

const measuredRows = inventoryRows(measured);
const withoutCheckout = [...measuredRows.values()].includes(INVENTORY_UNAVAILABLE);

if (!withoutCheckout) {
  if (committed !== measured) {
    console.error(
      "BUILD_FACTS.md records reproducible facts this tree no longer holds; run `npm run docs:build-facts`.\n"
      + `recorded:\n${committed ?? "(no section)"}\n\nmeasured:\n${measured ?? "(no section)"}`,
    );
    process.exit(1);
  }
  console.log("BUILD_FACTS.md matches this tree under its recorded collector contract.");
} else {
  const committedRows = inventoryRows(committed);
  const unverifiable = [];
  const drifted = [];
  for (const [fact, value] of measuredRows) {
    if (value === INVENTORY_UNAVAILABLE) {
      unverifiable.push(fact);
      continue;
    }
    const recordedValue = committedRows.get(fact);
    if (recordedValue !== value) {
      drifted.push(`${fact}: recorded ${recordedValue ?? "(absent)"}, measured ${value}`);
    }
  }
  const absent = [...committedRows.keys()].filter((fact) => !measuredRows.has(fact));
  if (drifted.length > 0 || absent.length > 0) {
    console.error(
      "BUILD_FACTS.md records reproducible facts this tree no longer holds; run `npm run docs:build-facts`.\n"
      + [...drifted, ...absent.map((fact) => `${fact}: recorded but not measured here`)]
        .map((entry) => `- ${entry}`)
        .join("\n"),
    );
    process.exit(1);
  }
  console.log(
    `BUILD_FACTS.md matches every fact this tree can measure. ${String(unverifiable.length)} fact(s) need a Git checkout and were not verified here: ${unverifiable.join(", ")}.`,
  );
}
