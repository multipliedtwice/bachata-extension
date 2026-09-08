const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { resolveProcessExecutable } = require("./process-scope.cjs");
const helperEnvironmentKeys = new Set(["PSMODULEPATH", "ELECTRON_RUN_AS_NODE", "NODEFAULTCURRENTDIRECTORYINEXEPATH", "PATH"]);

const [payloadPath, statusPath] = process.argv.slice(2);
if (!payloadPath || !statusPath) {
  process.exit(2);
}

const writeStatus = (value) => {
  writeFileSync(statusPath, JSON.stringify(value), "utf8");
};

let payload;
try {
  payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  if (!payload.helperEnvironment || typeof payload.helperEnvironment !== "object" || Array.isArray(payload.helperEnvironment)
    || Object.entries(payload.helperEnvironment).some(([name, value]) => !helperEnvironmentKeys.has(name.toUpperCase()) || typeof value !== "string")) {
    throw new Error("Windows target helper environment is missing or invalid");
  }
} catch (error) {
  writeStatus({ error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

let child;
try {
  const environment = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !helperEnvironmentKeys.has(name.toUpperCase()))),
    ...payload.helperEnvironment,
  };
  const shell = payload.shell === true || typeof payload.shell === "string" ? payload.shell : false;
  const executable = shell ? payload.executable : resolveProcessExecutable(payload.executable, environment, payload.cwd);
  child = spawn(executable, Array.isArray(payload.args) ? payload.args : [], {
    cwd: payload.cwd,
    env: environment,
    shell,
    stdio: [payload.stdinMode === "ignore" ? "ignore" : "inherit", "inherit", "inherit"],
    windowsHide: true,
  });
} catch (error) {
  writeStatus({ error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

let settled = false;
const settle = (value, exitCode) => {
  if (settled) {
    return;
  }
  settled = true;
  writeStatus(value);
  process.exit(exitCode);
};

child.once("error", (error) => {
  settle({ error: error instanceof Error ? error.message : String(error) }, 1);
});

child.once("exit", (code, signal) => {
  settle({
    ...(code === null ? {} : { exitCode: code }),
    ...(signal ? { signal } : {}),
  }, 0);
});
