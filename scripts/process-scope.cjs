const { randomUUID } = require("node:crypto");
const { spawn } = require("node:child_process");
const {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");

const scopeEnvironmentKey = "BACHATA_PROCESS_SCOPE_TOKEN";
const delay = (durationMs) => new Promise((resolve) => setTimeout(resolve, Math.max(1, durationMs)));

const closeState = (child) => {
  let closed = false;
  const waiters = new Set();
  child.once("close", () => {
    closed = true;
    for (const settle of waiters) {
      settle(true);
    }
    waiters.clear();
  });
  return {
    isClosed: () => closed,
    wait: (timeoutMs) => {
      if (closed) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        let settled = false;
        const settle = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          waiters.delete(settle);
          resolve(value);
        };
        const timer = setTimeout(() => settle(false), Math.max(1, timeoutMs));
        waiters.add(settle);
      });
    },
  };
};

const taskkill = (pid, timeoutMs) =>
  new Promise((resolve) => {
    const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      env: process.env,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };
    const timeout = setTimeout(() => {
      settle(false);
      try {
        child.kill();
      } catch {
        return;
      } finally {
        child.unref();
      }
    }, Math.max(1, timeoutMs));
    child.once("error", () => settle(false));
    child.once("close", (code) => settle(code === 0));
  });

const linuxProcessState = (pid) => {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) {
      return undefined;
    }
    const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    const processGroup = Number(fields[2]);
    if (!fields[0] || !Number.isSafeInteger(processGroup)) {
      return undefined;
    }
    return { state: fields[0], processGroup };
  } catch {
    return undefined;
  }
};

const linuxGroupHasLiveProcesses = (processGroup) => {
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    const state = linuxProcessState(Number(entry.name));
    if (state?.processGroup === processGroup && state.state !== "Z") {
      return true;
    }
  }
  return false;
};

const posixGroupExists = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return false;
  }
  if (process.platform === "linux") {
    const live = linuxGroupHasLiveProcesses(pid);
    if (live !== undefined) {
      return live;
    }
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const signalPosixGroup = (pid, signal) => {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    return;
  }
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      return;
    }
  }
};

const pidExists = (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    return false;
  }
  if (process.platform === "linux") {
    const state = linuxProcessState(pid);
    if (state?.state === "Z") {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
};

const signalPid = (pid, signal) => {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    return;
  }
  try {
    process.kill(pid, signal);
  } catch {
    return;
  }
};

const linuxScopePids = (token) => {
  if (!existsSync("/proc/self/environ")) {
    return { supported: false, pids: [] };
  }
  const expected = `${scopeEnvironmentKey}=${token}`;
  let entries;
  try {
    entries = readdirSync("/proc", { withFileTypes: true });
  } catch {
    return { supported: false, pids: [] };
  }
  const pids = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) {
      continue;
    }
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
      continue;
    }
    try {
      const values = readFileSync(`/proc/${entry.name}/environ`, "utf8").split("\0");
      if (values.includes(expected)) {
        pids.push(pid);
      }
    } catch {
      continue;
    }
  }
  return { supported: true, pids };
};

const collectStream = (child, maximumBytes) =>
  new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    child.stdout?.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes <= maximumBytes) {
        chunks.push(chunk);
      }
    });
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => {
      resolve(code === 0 && bytes <= maximumBytes ? Buffer.concat(chunks).toString("utf8") : undefined);
    });
  });

const psScopePids = (token) => {
  const child = spawn("/bin/ps", ["eww", "-axo", "pid=,command="], {
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  return collectStream(child, 32 * 1024 * 1024).then((output) => {
    if (typeof output !== "string") {
      return { supported: false, pids: [] };
    }
    const marker = `${scopeEnvironmentKey}=${token}`;
    const pids = [];
    for (const line of output.split(/\r?\n/u)) {
      if (!line.includes(marker)) {
        continue;
      }
      const match = line.match(/^\s*(\d+)\s+/u);
      if (!match) {
        continue;
      }
      const pid = Number(match[1]);
      if (Number.isSafeInteger(pid) && pid > 1 && pid !== process.pid) {
        pids.push(pid);
      }
    }
    return { supported: true, pids };
  });
};

const scopePids = async (token) => {
  if (process.platform === "linux") {
    return linuxScopePids(token);
  }
  if (["darwin", "freebsd", "openbsd"].includes(process.platform)) {
    return psScopePids(token);
  }
  return { supported: false, pids: [] };
};

const drainPosixScope = async (pid, token, signal, timeoutMs, observed) => {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let supported = true;
  while (Date.now() < deadline) {
    signalPosixGroup(pid, signal);
    const scan = await scopePids(token);
    supported &&= scan.supported;
    for (const scopedPid of scan.pids) {
      observed.add(scopedPid);
    }
    for (const scopedPid of observed) {
      if (pidExists(scopedPid)) {
        signalPid(scopedPid, signal);
      } else {
        observed.delete(scopedPid);
      }
    }
    if (!posixGroupExists(pid) && observed.size === 0 && scan.pids.length === 0) {
      return supported;
    }
    await delay(25);
  }
  const scan = await scopePids(token);
  supported &&= scan.supported;
  for (const scopedPid of scan.pids) {
    observed.add(scopedPid);
  }
  for (const scopedPid of Array.from(observed)) {
    if (!pidExists(scopedPid)) {
      observed.delete(scopedPid);
    }
  }
  return supported && !posixGroupExists(pid) && observed.size === 0 && scan.pids.length === 0;
};

const terminatePosixScope = async (child, token, graceMs) => {
  const close = child.exitCode !== null || child.signalCode !== null ? undefined : closeState(child);
  const observed = new Set();
  const graceful = await drainPosixScope(child.pid, token, "SIGTERM", graceMs, observed);
  const drained = graceful || await drainPosixScope(child.pid, token, "SIGKILL", graceMs, observed);
  return drained && (close === undefined || await close.wait(graceMs));
};

const powershellPath = (environment) => {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.WINDIR;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("Windows SystemRoot is unavailable or invalid");
  }
  return path.win32.join(
    path.win32.normalize(systemRoot),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
};

const parseJsonFile = (filePath, label) => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    return { error: `${label} was unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
};

/**
 * The forced-kill verdict has to be readable from the `close` listener, which runs
 * synchronously inside the very emit that ends terminate()'s wait for it. Recording it in a
 * variable assigned after those awaits left the listener reading `false` on every forced
 * termination and falling back to status files a force-killed runner never wrote, so the scope
 * reported unconfirmed cleanup while terminate() reported success.
 */
const windowsScopeFromChild = (child, paths, forceKill = taskkill) => {
  const { temporaryDirectory, targetStatusPath, jobStatusPath } = paths;
  const close = closeState(child);
  let resolvedResult;
  let terminationRequested = false;
  let forcedKill;
  let termination;
  let settled = false;
  const result = new Promise((resolve) => {
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolvedResult = value;
      rmSync(temporaryDirectory, { recursive: true, force: true });
      resolve(value);
    };
    const settleFromStatusFiles = (runnerExitCode, signal) => {
      const target = parseJsonFile(targetStatusPath, "Windows target status");
      const job = parseJsonFile(jobStatusPath, "Windows Job Object status");
      const error = [target.error, job.error].filter((value) => typeof value === "string" && value).join("; ");
      settle({
        ...(Number.isInteger(target.exitCode) ? { exitCode: target.exitCode } : {}),
        ...(typeof target.signal === "string" && target.signal ? { signal: target.signal } : {}),
        cleanupConfirmed: job.cleanupConfirmed === true,
        terminationRequested,
        ...(error ? { error } : {}),
        runnerExitCode,
      });
    };
    child.once("error", (error) => {
      settle({
        cleanupConfirmed: false,
        error: `Windows process scope failed to start: ${error instanceof Error ? error.message : String(error)}`,
        terminationRequested,
      });
    });
    child.once("close", (runnerExitCode, signal) => {
      if (!forcedKill) {
        settleFromStatusFiles(runnerExitCode, signal);
        return;
      }
      void forcedKill.then((killed) => {
        if (!killed) {
          settleFromStatusFiles(runnerExitCode, signal);
          return;
        }
        settle({
          cleanupConfirmed: true,
          terminationRequested: true,
          ...(signal ? { signal } : {}),
          runnerExitCode,
        });
      });
    });
  });
  const terminate = (graceMs) => {
    if (resolvedResult) {
      return Promise.resolve(resolvedResult.cleanupConfirmed === true);
    }
    if (!termination) {
      terminationRequested = true;
      const budgetMs = Math.max(1, graceMs);
      const deadlineAt = Date.now() + budgetMs;
      let timeout;
      const deadline = new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), budgetMs);
      });
      forcedKill = child.pid
        ? Promise.race([
            new Promise((resolve) => resolve(forceKill(child.pid, budgetMs))).catch(() => false),
            deadline,
          ])
        : undefined;
      const attempt = (async () => {
        if (!forcedKill) {
          const value = await result;
          return value.cleanupConfirmed === true;
        }
        const killed = await forcedKill;
        const closed = await close.wait(Math.max(1, deadlineAt - Date.now()));
        if (killed && closed) {
          return true;
        }
        if (closed) {
          const value = await result;
          return value.cleanupConfirmed === true;
        }
        return false;
      })();
      termination = Promise.race([attempt, deadline]).finally(() => clearTimeout(timeout));
    }
    return termination;
  };
  return { child, result, terminate, containment: "jobObject" };
};

let windowsAssemblyDirectory;
const windowsAssemblyScopes = new Set();
const windowsAssemblyPath = () => {
  if (!windowsAssemblyDirectory) {
    windowsAssemblyDirectory = mkdtempSync(path.join(tmpdir(), "bachata-windows-assembly-"));
    process.once("exit", () => {
      if (windowsAssemblyScopes.size === 0) {
        rmSync(windowsAssemblyDirectory, { recursive: true, force: true });
      }
    });
  }
  return path.join(windowsAssemblyDirectory, "job.dll");
};

const spawnWindowsScope = (executable, args, options) => {
  const environment = options.env ?? process.env;
  const powershell = powershellPath(environment);
  const runnerEnvironment = {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH")),
    PSModulePath: path.win32.join(path.win32.dirname(powershell), "Modules"),
  };
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), "bachata-process-scope-"));
  const payloadPath = path.join(temporaryDirectory, "payload.json");
  const targetStatusPath = path.join(temporaryDirectory, "target-status.json");
  const jobStatusPath = path.join(temporaryDirectory, "job-status.json");
  const hostPath = path.join(__dirname, "windows-process-host.cjs");
  writeFileSync(payloadPath, JSON.stringify({
    executable,
    args,
    cwd: options.cwd ?? process.cwd(),
    modulePathEnvironment: Object.fromEntries(
      Object.entries(environment).filter(([name]) => name.toUpperCase() === "PSMODULEPATH"),
    ),
    shell: options.shell ?? false,
    stdinMode: options.stdio === "inherit"
      ? "inherit"
      : Array.isArray(options.stdio)
        ? options.stdio[0]
        : "ignore",
  }), "utf8");
  const scriptPath = path.join(__dirname, "windows-job-runner.ps1");
  let child;
  try {
    child = spawn(powershell, [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-HostExecutable",
      process.execPath,
      "-HostScript",
      hostPath,
      "-PayloadPath",
      payloadPath,
      "-TargetStatusPath",
      targetStatusPath,
      "-JobStatusPath",
      jobStatusPath,
      "-AssemblyPath",
      windowsAssemblyPath(),
    ], {
      cwd: options.cwd,
      env: runnerEnvironment,
      stdio: options.stdio,
      windowsHide: options.windowsHide ?? true,
    });
  } catch (error) {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
  windowsAssemblyScopes.add(child);
  child.once("close", () => windowsAssemblyScopes.delete(child));
  return windowsScopeFromChild(child, { temporaryDirectory, targetStatusPath, jobStatusPath });
};

const spawnPosixScope = (executable, args, options) => {
  const token = randomUUID();
  const child = spawn(executable, args, {
    ...options,
    env: {
      ...(options.env ?? process.env),
      [scopeEnvironmentKey]: token,
    },
    detached: true,
  });
  const close = closeState(child);
  let cleanup;
  let terminationRequested = false;
  const clean = (graceMs) => {
    cleanup ??= terminatePosixScope(child, token, graceMs);
    return cleanup;
  };
  const terminate = (graceMs) => {
    terminationRequested = true;
    return clean(graceMs);
  };
  const result = new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(value);
    };
    child.once("error", (error) => {
      void clean(options.cleanupGraceMs ?? 2_000).then((cleanupConfirmed) => {
        settle({
          cleanupConfirmed,
          terminationRequested,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    child.once("exit", (code, signal) => {
      void clean(options.cleanupGraceMs ?? 2_000).then(async (scopeCleaned) => {
        const outputClosed = await close.wait(1_000);
        if (!outputClosed) {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        settle({
          ...(code === null ? {} : { exitCode: code }),
          ...(signal ? { signal } : {}),
          cleanupConfirmed: scopeCleaned && outputClosed,
          terminationRequested,
          ...(!outputClosed ? { error: "Process output did not close after scope termination" } : {}),
        });
      });
    });
  });
  return { child, result, terminate, containment: "environmentScope" };
};

const spawnProcessScope = (executable, args, options = {}) =>
  process.platform === "win32"
    ? spawnWindowsScope(executable, args, options)
    : spawnPosixScope(executable, args, options);

module.exports = {
  scopeEnvironmentKey,
  spawnProcessScope,
  terminatePosixScope,
  windowsScopeFromChild,
};
