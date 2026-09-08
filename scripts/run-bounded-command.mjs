import { installTerminationHandlers } from "./install-termination-handlers.mjs";
import { spawnProcessScope } from "./process-scope.mjs";
import { waitForChild } from "./wait-for-child.mjs";
import { withWorktreeLock } from "./lib/worktreeLock.mjs";

const requestedTimeoutMs = Number(process.argv[2]);
const timeoutMs = Number(process.env.BACHATA_COMMAND_TIMEOUT_MS?.trim() || requestedTimeoutMs);
const [executable, ...args] = process.argv.slice(3);
const validTimeout = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647;
if (!validTimeout(requestedTimeoutMs) || !executable) {
  throw new Error("Usage: node scripts/run-bounded-command.mjs <timeout-ms> <command> [...args]");
}
if (!validTimeout(timeoutMs)) {
  throw new Error("BACHATA_COMMAND_TIMEOUT_MS must be an integer from 1 to 2147483647");
}

let activeProcessScope;
const termination = installTerminationHandlers({
  getProcessScope: () => activeProcessScope,
  graceMs: 2_000,
});

const main = async () => {
  try {
    const environment = { ...process.env };
    delete environment.BACHATA_COMMAND_TIMEOUT_MS;
    activeProcessScope = spawnProcessScope(executable, args, {
      stdio: "inherit",
      env: environment,
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
