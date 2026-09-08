import { readdirSync, readFileSync } from "node:fs";
import processScopeRuntime from "./process-scope.cjs";

const delay = (durationMs) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(1, durationMs)));

const waitForExit = (child, timeoutMs) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(false);
    }, Math.max(1, timeoutMs));
    child.once("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });

const linuxGroupHasLiveMembers = (groupId) => {
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

const posixGroupExists = (pid) => {
  try {
    process.kill(-pid, 0);
    return linuxGroupHasLiveMembers(pid) ?? true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const waitForPosixGroupExit = async (pid, timeoutMs) => {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() < deadline) {
    if (!posixGroupExists(pid)) {
      return true;
    }
    await delay(25);
  }
  return !posixGroupExists(pid);
};

const signalPosixGroup = (child, signal) => {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      return;
    }
  }
};

export const terminateProcessTree = async (child, graceMs) => {
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
    if (await waitForExit(child, graceMs)) {
      return true;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      return false;
    }
    return waitForExit(child, graceMs);
  }

  if (process.platform === "win32") {
    // taskkill exits non-zero for a pid that names no running task, so a tree that already
    // finished would otherwise read as a failed termination — and /T would be aimed at a
    // number Windows may already have handed to something else.
    if (child.exitCode !== null || child.signalCode !== null) {
      return true;
    }
    const terminated = await processScopeRuntime.terminateWindowsProcessTree(pid, graceMs);
    const parentExited = await waitForExit(child, graceMs);
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
