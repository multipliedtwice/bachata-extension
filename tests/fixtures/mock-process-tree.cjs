#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");

const pidFile = process.argv[2];
const child = spawn(
  process.execPath,
  [
    "-e",
    "process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1000);",
  ],
  { stdio: "ignore" },
);
writeFileSync(pidFile, String(child.pid), "utf8");
process.on("SIGTERM", () => undefined);
setInterval(() => undefined, 1000);
