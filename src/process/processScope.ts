import {
  ChildProcess,
  ChildProcessWithoutNullStreams,
  spawn,
  SpawnOptionsWithoutStdio,
  StdioOptions,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";

import { spawnDetachedProcessGroup, terminateProcessTree } from "./terminateProcessTree";

export type ProcessScopeResult = {
  exitCode?: number;
  signal?: NodeJS.Signals;
  cleanupConfirmed: boolean;
  terminationRequested?: boolean;
  runnerExitCode?: number | null;
  error?: string;
};

export type ProcessScope = {
  child: ChildProcess;
  result: Promise<ProcessScopeResult>;
  terminate: (graceMs: number) => Promise<boolean>;
  containment: "jobObject" | "environmentScope";
};

export type ProcessScopeOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdio?: StdioOptions;
  windowsHide?: boolean;
  cleanupGraceMs?: number;
  shell?: boolean | string;
};

type ProcessScopeRuntime = {
  resolveProcessExecutable: (command: string, env?: NodeJS.ProcessEnv, cwd?: string) => string;
  scopeEnvironmentKey: string;
  spawnProcessScope: (
    executable: string,
    args: string[],
    options?: ProcessScopeOptions,
  ) => ProcessScope;
  terminatePosixScope: (
    child: ChildProcess,
    token: string,
    graceMs: number,
  ) => Promise<boolean>;
};

const runtime = require(path.resolve(
  __dirname,
  "../../scripts/process-scope.cjs",
)) as ProcessScopeRuntime;

export const resolveProcessExecutable = (
  command: string,
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): string => runtime.resolveProcessExecutable(command, env, cwd);

export const spawnProcessScope = (
  executable: string,
  args: string[],
  options: ProcessScopeOptions = {},
): ProcessScope => runtime.spawnProcessScope(executable, args, options);

export type ScopedProviderProcess = {
  child: ChildProcessWithoutNullStreams;
  terminate: (graceMs: number) => Promise<boolean>;
};

// EX-A5-R10. On POSIX the provider child carries the scope token the command runner scans for, so a
// descendant that leaves the launch process group is still reached by the token drain, which a group
// signal alone cannot name; Windows uses plain spawn + terminateProcessTree. The drain is scan-based:
// a descendant that unsets the token, or a grandchild spawned with a scrubbed environment, is not
// contained.
export const spawnScopedProviderProcess = (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ScopedProviderProcess => {
  const detached = spawnDetachedProcessGroup();
  const token = detached ? randomUUID() : undefined;
  const env = token === undefined
    ? options.env
    : { ...(options.env ?? process.env), [runtime.scopeEnvironmentKey]: token };
  const spawnOptions: SpawnOptionsWithoutStdio = {
    stdio: ["pipe", "pipe", "pipe"],
    detached,
    windowsHide: true,
  };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;
  if (env !== undefined) spawnOptions.env = env;
  const child = spawn(resolveProcessExecutable(command, env, options.cwd), args, spawnOptions);
  const terminate = (graceMs: number): Promise<boolean> =>
    token === undefined
      ? terminateProcessTree(child, graceMs)
      : runtime.terminatePosixScope(child, token, graceMs);
  return { child, terminate };
};
