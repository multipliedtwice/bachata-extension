const { spawn } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");

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
} catch (error) {
  writeStatus({ error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
}

let child;
try {
  child = spawn(payload.executable, Array.isArray(payload.args) ? payload.args : [], {
    cwd: payload.cwd,
    env: process.env,
    shell: payload.shell === true || typeof payload.shell === "string" ? payload.shell : false,
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
