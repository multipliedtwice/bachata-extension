import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installTerminationHandlers } from "./install-termination-handlers.mjs";
import { spawnProcessScope } from "./process-scope.mjs";
import { waitForChild } from "./wait-for-child.mjs";
import { withWorktreeLock } from "./lib/worktreeLock.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const boundedPrefix = "node scripts/run-bounded-command.mjs 600000 node ";
const graceMs = 2_000;

const readJobs = async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  return Object.entries(packageJson.scripts)
    .filter(([name]) => name.startsWith("test:coverage:"))
    .map(([name, command]) => {
      if (typeof command !== "string" || !command.startsWith(boundedPrefix)) {
        throw new Error(`${name} must use the standard bounded coverage command`);
      }
      return { name, args: command.slice(boundedPrefix.length).trim().split(/\s+/u) };
    });
};

const numberFromEnvironment = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

const isolatedEnvironment = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "bachata-coverage-"));
  return {
    directory,
    environment: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
  };
};

const runJob = async (job, timeoutMs, activeScopes) => {
  const isolated = await isolatedEnvironment();
  const scope = spawnProcessScope(process.execPath, job.args, {
    cwd: root,
    env: isolated.environment,
    shell: process.platform === "win32",
    stdio: "inherit",
    cleanupGraceMs: graceMs,
  });
  activeScopes.add(scope);
  try {
    process.stdout.write(`[coverage] ${job.name} started\n`);
    await waitForChild(scope, { timeoutMs, graceMs, label: job.name });
    process.stdout.write(`[coverage] ${job.name} passed\n`);
  } finally {
    activeScopes.delete(scope);
    await rm(isolated.directory, { recursive: true, force: true });
  }
};

const runBatch = async (jobs, concurrency, timeoutMs, activeScopes) => {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      await runJob(jobs[index], timeoutMs, activeScopes);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(jobs.length, concurrency) }, () => worker()),
  );
};

const run = async () => {
  const jobs = await readJobs();
  const concurrency = Math.min(
    jobs.length,
    numberFromEnvironment("BACHATA_COVERAGE_CONCURRENCY", 4),
  );
  const timeoutMs = numberFromEnvironment("BACHATA_COMMAND_TIMEOUT_MS", 600_000);
  const activeScopes = new Set();
  const aggregateScope = {
    terminate: async (signalGraceMs) => {
      const outcomes = await Promise.all(
        [...activeScopes].map((scope) => scope.terminate(signalGraceMs)),
      );
      return outcomes.every(Boolean);
    },
  };
  const termination = installTerminationHandlers({ getProcessScope: () => aggregateScope, graceMs });
  const aggregateNames = new Set(["test:coverage:source", "test:coverage:critical"]);
  const aggregateJobs = jobs.filter((job) => aggregateNames.has(job.name));
  const focusedJobs = jobs.filter((job) => !aggregateNames.has(job.name));
  try {
    await withWorktreeLock({ label: "coverage suite" }, async () => {
      await runBatch(aggregateJobs, 2, timeoutMs, activeScopes);
      await runBatch(focusedJobs, concurrency, timeoutMs, activeScopes);
    });
  } finally {
    termination.remove();
    if (activeScopes.size > 0) await aggregateScope.terminate(graceMs);
  }
};

await run();
