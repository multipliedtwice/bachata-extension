const { existsSync } = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const [pidFile] = process.argv.slice(2);
const worker = path.join(__dirname, "mock-detached-session-worker.cjs");
const setsid = ["/usr/bin/setsid", "/bin/setsid"].find(existsSync) ?? "setsid";
const child = spawn(setsid, [process.execPath, worker, pidFile], {
  env: process.env,
  stdio: "ignore",
});
child.unref();
child.once("error", () => process.exit(1));
const deadline = Date.now() + 5_000;
const timer = setInterval(() => {
  if (existsSync(pidFile)) {
    clearInterval(timer);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    clearInterval(timer);
    process.exit(1);
  }
}, 10);
