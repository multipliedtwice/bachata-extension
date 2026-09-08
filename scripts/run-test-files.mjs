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

const timeoutMs = Math.max(10_000, Number(process.env.BACHATA_TEST_FILE_TIMEOUT_MS ?? 600_000));
const graceMs = Math.max(500, Number(process.env.BACHATA_TEST_FILE_KILL_GRACE_MS ?? 2_000));
let activeProcessScope;
const termination = installTerminationHandlers({
  getProcessScope: () => activeProcessScope,
  graceMs,
});

const run = async (file) => {
  activeProcessScope = spawnProcessScope(process.execPath, ["--test", file], {
    stdio: "inherit",
    cleanupGraceMs: graceMs,
  });
  try {
    const result = await waitForChild(activeProcessScope, {
      timeoutMs,
      graceMs,
      label: file,
    });
    if (termination.isHandling()) {
      await termination.waitForCompletion();
      return;
    }
    if (result.signal) {
      throw new Error(`${file} stopped by ${result.signal}`);
    }
    if (result.code === null) {
      throw new Error(`${file} exited without an exit code`);
    }
    return result.code;
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
  const failures = [];
  try {
    for (const file of files) {
      if (termination.isHandling()) {
        await termination.waitForCompletion();
        return;
      }
      process.stdout.write(`\n[test-file] ${file}\n`);
      const code = await run(file);
      if (termination.isHandling()) {
        await termination.waitForCompletion();
        return;
      }
      if (code !== undefined && code !== 0) {
        failures.push(`${file} exited with ${String(code)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Test files failed:\n${failures.join("\n")}`);
    }
  } finally {
    termination.remove();
  }
});
