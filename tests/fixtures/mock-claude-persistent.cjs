#!/usr/bin/env node

const readline = require("node:readline");

if (process.argv.includes("--version")) {
  process.stdout.write("mock-claude-persistent 1.0.0\n");
  process.exit(0);
}

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const sessionId = valueAfter("--resume") || valueAfter("--session-id");
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const keepAlive = setInterval(() => undefined, 60_000);
let stdinEnded = false;

process.stdin.on("end", () => {
  stdinEnded = true;
  clearInterval(keepAlive);
  process.exit(0);
});

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  send({ type: "system", subtype: "init", session_id: sessionId });
  send({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "persistent answer" } },
  });
  send({
    type: "result",
    session_id: sessionId,
    is_error: false,
    result: "persistent answer",
  });
});

process.on("SIGTERM", () => {
  if (process.env.MOCK_CLAUDE_PERSISTENT_IGNORE_SIGTERM === "1") {
    return;
  }
  clearInterval(keepAlive);
  process.exit(0);
});

setTimeout(() => {
  if (!stdinEnded) {
    process.stderr.write("mock-claude-persistent was never released\n");
    process.exit(7);
  }
}, 30_000).unref();
