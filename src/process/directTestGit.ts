import { spawn } from "node:child_process";

export type DirectTestGitResult = {
  exitCode?: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  cleanupConfirmed: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

const text = (value: unknown): string => {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf8") : "";
};

const bounded = (value: unknown, maximumBytes: number): { text: string; truncated: boolean } => {
  const buffer = Buffer.from(text(value), "utf8");
  return {
    text: buffer.subarray(0, maximumBytes).toString("utf8"),
    truncated: buffer.byteLength > maximumBytes,
  };
};

export const runDirectTestGit = async (
  args: string[],
  options: {
    cwd: string;
    environment?: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
    stdin?: string;
  },
): Promise<DirectTestGitResult> => {
  const child = spawn("git", args, {
    cwd: options.cwd,
    env: options.environment,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  child.stdin.end(options.stdin);
  return new Promise((resolve) => {
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    const abort = (): void => {
      cancelled = true;
      child.kill();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (code?: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const output = bounded(Buffer.concat(stdout), options.maxOutputBytes);
      const errors = bounded(Buffer.concat(stderr), options.maxOutputBytes);
      resolve({
        ...(typeof code === "number" ? { exitCode: code } : {}),
        stdout: output.text,
        stderr: errors.text,
        timedOut,
        cancelled,
        cleanupConfirmed: true,
        stdoutTruncated: output.truncated,
        stderrTruncated: errors.truncated,
      });
    };
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? undefined));
  });
};
