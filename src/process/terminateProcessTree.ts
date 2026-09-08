import { ChildProcess, spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const waitForExit = (child: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("close", () => resolve());
  });

const settleWithin = async (
  promise: Promise<void>,
  timeoutMs: number,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    promise.then(() => true, () => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
    }),
  ]);
  if (timer) {
    clearTimeout(timer);
  }
  return result;
};

const taskkill = (pid: number, force: boolean): Promise<boolean> =>
  new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const child = spawn("taskkill", args, {
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });

const signalPosixGroup = (
  child: ChildProcess,
  signal: NodeJS.Signals,
): void => {
  const pid = child.pid;
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      return;
    }
  }
};

const linuxGroupHasLiveMembers = (groupId: number): boolean | undefined => {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/u.test(entry)) {
        continue;
      }
      try {
        const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
        const commandEnd = stat.lastIndexOf(")");
        if (commandEnd < 0) {
          continue;
        }
        const fields = stat.slice(commandEnd + 2).trim().split(/\s+/u);
        if (Number(fields[2]) === groupId && fields[0] !== "Z") {
          return true;
        }
      } catch {
        continue;
      }
    }
    return false;
  } catch {
    return undefined;
  }
};

const posixGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return linuxGroupHasLiveMembers(pid) ?? true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const waitForPosixGroupExit = async (
  pid: number,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (!posixGroupExists(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !posixGroupExists(pid);
};

export const spawnDetachedProcessGroup = (): boolean =>
  process.platform !== "win32";

export const terminateProcessTree = async (
  child: ChildProcess,
  graceMs: number,
): Promise<boolean> => {
  const pid = child.pid;
  if (!pid) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      return false;
    }
    if (await settleWithin(waitForExit(child), graceMs)) {
      return true;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      return false;
    }
    return settleWithin(waitForExit(child), graceMs);
  }

  if (process.platform === "win32") {
    // taskkill exits non-zero for a pid that names no running task, so a tree that already
    // finished would otherwise read as a failed termination — and /T would be aimed at a
    // number Windows may already have handed to something else.
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }
    const terminated = await taskkill(pid, true);
    const parentExited = await settleWithin(waitForExit(child), graceMs);
    return terminated && parentExited;
  }

  if (!posixGroupExists(pid)) {
    return true;
  }
  signalPosixGroup(child, "SIGTERM");
  if (await waitForPosixGroupExit(pid, graceMs)) {
    return true;
  }
  signalPosixGroup(child, "SIGKILL");
  return waitForPosixGroupExit(pid, graceMs);
};
