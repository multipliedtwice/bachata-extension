#!/usr/bin/env node

// EX-G6-06. A descendant that stays alive past SIGTERM. It belongs to its parent's POSIX process
// group, so a group SIGTERM reaches it and it declines; only the SIGKILL escalation ends it. Its
// whole purpose is to make "the tree is gone" arrive strictly later than "the request to end it
// was sent", so a turn that reports interruption on the request alone can be told apart from one
// that reports it on the confirmed answer.
const fs = require("node:fs");

const [, , pidFile] = process.argv;

process.on("SIGTERM", () => undefined);
process.on("SIGINT", () => undefined);

// Never outlive the test run, whatever happens to the parent.
setTimeout(() => process.exit(0), 30_000).unref();
setInterval(() => undefined, 1_000);

fs.writeFileSync(pidFile, String(process.pid));
