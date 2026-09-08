import { installTerminationHandlers } from "./install-termination-handlers.mjs";
import { spawnProcessScope } from "./process-scope.mjs";
import { waitForChild } from "./wait-for-child.mjs";
import { withWorktreeLock } from "./lib/worktreeLock.mjs";

const timeoutMs = Number(process.argv[2]);
const [executable, ...args] = process.argv.slice(3);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || !executable) {
  throw new Error("Usage: node scripts/run-bounded-command.mjs <timeout-ms> <command> [...args]");
}

let activeProcessScope;
const termination = installTerminationHandlers({
  getProcessScope: () => activeProcessScope,
  graceMs: 2_000,
});

const main = async () => {
  try {
    activeProcessScope = spawnProcessScope(executable, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      cleanupGraceMs: 2_000,
    });

    const result = await waitForChild(activeProcessScope, {
      timeoutMs,
      graceMs: 2_000,
      label: executable,
    });
    if (termination.isHandling()) {
      await termination.waitForCompletion();
      return;
    }
    if (result.signal) {
      throw new Error(`${executable} stopped by ${result.signal}`);
    }
    if (result.code !== 0) {
      process.exitCode = result.code;
    }
  } catch (error) {
    if (termination.isHandling()) {
      await termination.waitForCompletion();
      return;
    }
    throw error;
  } finally {
    termination.remove();
    activeProcessScope = undefined;
  }
};

await withWorktreeLock({ label: `bounded ${executable}` }, main);
