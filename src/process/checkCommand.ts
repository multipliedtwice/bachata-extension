import {
  appendBoundedBuffer,
  boundedBufferText,
  createBoundedBuffer,
} from "./boundedOutput";
import { commandInvocation } from "./commandInvocation";
import { ProcessScopeResult, spawnProcessScope } from "./processScope";

export type CheckCommandOptions = {
  timeoutMs?: number;
  terminateGraceMs?: number;
  maxOutputBytes?: number;
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  trim?: boolean;
};

type CheckOutcome =
  | { type: "result"; result: ProcessScopeResult }
  | { type: "termination"; cleanupConfirmed: boolean };

export const checkCommand = async (
  command: string,
  args: string[] = ["--version"],
  options: CheckCommandOptions = {},
): Promise<string> => {
  const invocation = commandInvocation(command, args);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const terminateGraceMs = options.terminateGraceMs ?? 1_000;
  const maxOutputBytes = options.maxOutputBytes ?? 65_536;
  const stdout = createBoundedBuffer(maxOutputBytes);
  const stderr = createBoundedBuffer(maxOutputBytes);
  const scope = spawnProcessScope(invocation.command, invocation.args, {
    ...(options.workingDirectory === undefined ? {} : { cwd: options.workingDirectory }),
    env: options.environment ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    cleanupGraceMs: terminateGraceMs,
  });
  scope.child.stdout?.on("data", (chunk: Buffer) => appendBoundedBuffer(stdout, chunk));
  scope.child.stderr?.on("data", (chunk: Buffer) => appendBoundedBuffer(stderr, chunk));

  let timedOut = false;
  let settleTermination: ((value: CheckOutcome) => void) | undefined;
  const terminationOutcome = new Promise<CheckOutcome>((resolve) => {
    settleTermination = resolve;
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    void scope.terminate(terminateGraceMs).then(
      (cleanupConfirmed) => settleTermination?.({ type: "termination", cleanupConfirmed }),
      () => settleTermination?.({ type: "termination", cleanupConfirmed: false }),
    );
  }, timeoutMs);

  let outcome: CheckOutcome;
  try {
    outcome = await Promise.race([
      scope.result.then((result): CheckOutcome => ({ type: "result", result })),
      terminationOutcome,
    ]);
  } finally {
    clearTimeout(timeout);
  }

  const result = outcome.type === "result"
    ? outcome.result
    : { cleanupConfirmed: outcome.cleanupConfirmed };
  if (timedOut) {
    const suffix = result.cleanupConfirmed ? "" : "; process scope cleanup could not be confirmed";
    throw new Error(`${command} availability check timed out after ${String(timeoutMs)} ms${suffix}`);
  }
  if (result.error) {
    throw new Error(`${command}: ${result.error}`);
  }
  if (!result.cleanupConfirmed) {
    throw new Error(`${command} process scope cleanup could not be confirmed`);
  }
  const stdoutText = boundedBufferText(stdout);
  const stderrText = boundedBufferText(stderr);
  if (result.exitCode !== 0) {
    throw new Error(
      stderrText.trim() ||
        `${command} exited with code ${String(result.exitCode)} and signal ${String(result.signal)}`,
    );
  }
  const output = stdoutText || stderrText;
  return options.trim === false ? output : output.trim();
};
