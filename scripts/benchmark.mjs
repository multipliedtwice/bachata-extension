import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARMS,
  armPipelineIds,
  armVerification,
  benchmarkVerdict,
  compareArms,
  scoreRun,
  validateRunRecord,
  validateTaskDesign,
} from "./lib/benchmark.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const benchmarks = path.join(root, "benchmarks");

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const extensionVersion = (await readJson(path.join(root, "package.json"))).version;

const insideDirectory = (directory, candidate) => {
  const relative = path.relative(directory, candidate);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const filesUnder = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(target) : [target];
  }));
  return nested.flat().sort();
};

export const fixtureSha256 = async (fixtureRoot) => {
  const files = await filesUnder(fixtureRoot);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(path.relative(fixtureRoot, file).split(path.sep).join("/"));
    digest.update(" ");
    digest.update(await readFile(file));
    digest.update(" ");
  }
  return digest.digest("hex");
};

const fileSha256 = async (file) =>
  createHash("sha256").update(await readFile(file)).digest("hex");

const exists = async (file) => stat(file).then(() => true).catch(() => false);

const gitTracks = (file) => {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", file], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error || result.status === 128) return undefined;
  return result.status === 0;
};

const artifactFacts = async (artifactPath) => {
  if (typeof artifactPath !== "string" || artifactPath.length === 0) return undefined;
  const resolved = path.resolve(root, artifactPath);
  if (!insideDirectory(root, resolved)) return { inside: false, exists: false };
  if (!await exists(resolved)) return { inside: true, exists: false };
  return { inside: true, exists: true, sha256: await fileSha256(resolved) };
};

const producedFacts = async (producedFiles) => {
  const entries = await Promise.all(
    Object.entries(producedFiles ?? {}).map(async ([relative, committed]) => {
      if (typeof committed !== "string" || committed.length === 0) {
        return [relative, { inside: false, exists: false }];
      }
      const resolved = path.resolve(benchmarks, committed);
      if (!insideDirectory(benchmarks, resolved)) return [relative, { inside: false, exists: false }];
      if (!await exists(resolved)) return [relative, { inside: true, exists: false }];
      return [relative, {
        inside: true,
        exists: true,
        tracked: gitTracks(resolved),
        path: resolved,
      }];
    }),
  );
  return Object.fromEntries(entries);
};

const normalizedSource = (value) =>
  value.replace(/\r\n/gu, "\n").split("\n").map((line) => line.replace(/\s+$/u, "")).join("\n").trim();

const referenceMatches = async (task, run, produced) => {
  const reference = task.answerKey?.referenceFile;
  if (typeof reference !== "string") return undefined;
  const referencePath = path.join(benchmarks, task.fixture, reference);
  if (!await exists(referencePath)) return false;
  const expectedSource = normalizedSource(await readFile(referencePath, "utf8"));
  const expectedFiles = task.answerKey?.expectedChangedFiles ?? [];
  if (expectedFiles.length === 0) return false;
  for (const relative of expectedFiles) {
    const facts = produced[relative];
    if (!facts?.exists || !facts.path) return false;
    if (normalizedSource(await readFile(facts.path, "utf8")) !== expectedSource) return false;
  }
  return true;
};

const bundleFacts = async (bundlePath) => {
  if (typeof bundlePath !== "string" || bundlePath.length === 0) return undefined;
  const resolved = path.resolve(benchmarks, bundlePath);
  if (!insideDirectory(benchmarks, resolved)) return { inside: false, exists: false };
  if (!await exists(resolved)) return { inside: true, exists: false };
  return {
    inside: true,
    exists: true,
    tracked: gitTracks(resolved),
    value: await readJson(resolved).catch(() => undefined),
  };
};

const taskFiles = (await readdir(path.join(benchmarks, "tasks")))
  .filter((name) => name.endsWith(".json"))
  .sort();

const tasks = await Promise.all(
  taskFiles.map((name) => readJson(path.join(benchmarks, "tasks", name))),
);

const rows = [];
const comparisons = [];
const provenanceErrors = [];

for (const task of tasks) {
  const designErrors = validateTaskDesign(task);
  if (designErrors.length > 0) {
    provenanceErrors.push(...designErrors);
    comparisons.push("incomplete");
    continue;
  }
  const fixtureHash = await fixtureSha256(path.join(benchmarks, task.fixture));
  const scored = {};
  for (const arm of ARMS) {
    const file = path.join(benchmarks, "runs", task.id, `${arm}.json`);
    if (!await exists(file)) continue;
    const run = await readJson(file).catch(() => undefined);
    const produced = await producedFacts(run?.producedFiles);
    const errors = validateRunRecord(task, arm, run, {
      extensionVersion,
      fixtureSha256: fixtureHash,
      artifact: await artifactFacts(run?.provenance?.artifactPath),
      bundle: await bundleFacts(run?.provenance?.runBundle),
      produced,
    });
    if (errors.length > 0) {
      provenanceErrors.push(...errors);
      continue;
    }
    scored[arm] = scoreRun(task, run, {
      referenceMatch: await referenceMatches(task, run, produced),
    });
    rows.push(scored[arm]);
  }
  comparisons.push(compareArms(scored.single, scored.paired));
}

console.log(`Extension version under test: ${extensionVersion}`);
console.log(`Preregistered tasks: ${String(tasks.length)} (${tasks.map((task) => `${task.id}:${task.kind}`).join(", ")})`);
tasks.forEach((task) => {
  ARMS.forEach((arm) => {
    console.log(`  ${task.id} ${arm}: ${armPipelineIds(task, arm).join(", ")} | verification ${armVerification(task, arm).join(", ") || "none declared"}`);
  });
});
console.log(`Validated arms: ${String(rows.length)} of ${String(tasks.length * ARMS.length)}`);

if (provenanceErrors.length > 0) {
  console.log("");
  console.log("Rejected for provenance:");
  provenanceErrors.forEach((error) => console.log(`  ${error}`));
}

if (rows.length > 0) {
  console.log("");
  console.log("task | arm | pipeline | supported/required | false positives | verification | scope held | completion | reference | eligible | correct");
  rows.forEach((row) => {
    console.log([
      row.taskId,
      row.arm,
      row.pipelineId,
      `${String(row.supportedFindings)}/${String(row.requiredFindings)}`,
      String(row.falsePositives),
      row.verificationOutcome,
      row.changedScopeHeld ? "yes" : "no",
      row.completion,
      row.referenceMatch === undefined ? "n/a" : row.referenceMatch ? "match" : "differs",
      row.eligible ? "yes" : "no",
      row.correct ? "yes" : "no",
    ].join(" | "));
  });
}

console.log("");
console.log(benchmarkVerdict(comparisons, provenanceErrors));
if (provenanceErrors.length > 0) process.exit(1);
