import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { installTerminationHandlers } from "./install-termination-handlers.mjs";
import { spawnProcessScope } from "./process-scope.mjs";
import { waitForChild } from "./wait-for-child.mjs";
import { withWorktreeLock } from "./lib/worktreeLock.mjs";

const inputs = process.argv.slice(2);
if (inputs.length === 0) {
  throw new Error("At least one test file or directory is required");
}

// Keep the normal lexical order unless CI names a small set of historically fragile files. This
// lets a failing lane report quickly without making the default order depend on mutable history.
const priorityNames = (process.env.BACHATA_TEST_PRIORITY ?? "")
  .split(",")
  .map((value) => value.trim().replaceAll("\\", "/"))
  .filter(Boolean);
const priorityRank = new Map(priorityNames.map((name, index) => [name, index]));
const fileRank = (file) => {
  const normalized = file.replaceAll("\\", "/");
  const basename = path.basename(normalized);
  return priorityRank.get(normalized) ?? priorityRank.get(basename) ?? Number.MAX_SAFE_INTEGER;
};
const orderedFiles = (values) => values.slice().sort((left, right) => {
  const rankDifference = fileRank(left) - fileRank(right);
  return rankDifference || left.localeCompare(right);
});

const files = [];
for (const input of inputs) {
  const details = await stat(input);
  if (details.isDirectory()) {
    const entries = await readdir(input, { withFileTypes: true });
    files.push(
      ...entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".test.cjs"))
        .map((entry) => path.join(input, entry.name))
        .sort(),
    );
    continue;
  }
  files.push(input);
}
if (files.length === 0) {
  throw new Error("No test files were found");
}
files.splice(0, files.length, ...orderedFiles(files));

// One process scope covers the whole lane instead of one per file. The node test runner already
// forks a child process per test file, so per-file isolation is unchanged, but a per-file scope
// paid the Windows Job Object setup — a powershell.exe launch and a runtime C# compile — 232 times
// over. That overhead, not the tests, was the difference between a 36 minute Linux lane and a four
// hour Windows one.
//
// The bound splits in two as a result. BACHATA_TEST_FILE_TIMEOUT_MS still bounds a whole file: the
// runner isolates each file in its own process and represents it as a test, so --test-timeout cuts
// the file off and reports every case behind it as cancelledByParent rather than running it. It has
// to hold the slowest file on the slowest platform, not the slowest single case. The lane is capped
// separately by BACHATA_TEST_RUN_TIMEOUT_MS, and that cap, not the file bound, is what keeps a hang
// from occupying a runner for hours.
const timeoutMs = Math.max(10_000, Number(process.env.BACHATA_TEST_FILE_TIMEOUT_MS ?? 600_000));
const runTimeoutMs = Math.max(
  timeoutMs,
  Number(process.env.BACHATA_TEST_RUN_TIMEOUT_MS ?? 3_600_000),
);
const graceMs = Math.max(500, Number(process.env.BACHATA_TEST_FILE_KILL_GRACE_MS ?? 2_000));
let activeProcessScope;
const termination = installTerminationHandlers({
  getProcessScope: () => activeProcessScope,
  graceMs,
});

const run = async (label) => {
  activeProcessScope = spawnProcessScope(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      `--test-timeout=${String(timeoutMs)}`,
      ...files,
    ],
    {
      stdio: "inherit",
      cleanupGraceMs: graceMs,
    },
  );
  try {
    const result = await waitForChild(activeProcessScope, {
      timeoutMs: runTimeoutMs,
      graceMs,
      label,
    });
    if (termination.isHandling()) {
      await termination.waitForCompletion();
      return;
    }
    if (result.signal) {
      throw new Error(`${label} stopped by ${result.signal}`);
    }
    if (result.code !== 0) {
      throw new Error(`${label} exited with ${String(result.code)}`);
    }
  } catch (error) {
    if (termination.isHandling()) {
      await termination.waitForCompletion();
      return;
    }
    throw error;
  } finally {
    activeProcessScope = undefined;
  }
};

await withWorktreeLock({ label: "unit tests" }, async () => {
  const label = `${String(files.length)} test files`;
  try {
    process.stdout.write(`\n[test-run] ${label}\n`);
    await run(label);
  } finally {
    termination.remove();
  }
});
