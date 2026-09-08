#!/usr/bin/env node

const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  process.stdout.write("mock-claude 1.0.0\n");
  process.exit(0);
}

const valueAfter = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const sessionId = valueAfter("--resume") || valueAfter("--session-id");

const settingsValue = valueAfter("--settings");
const settingsSource = !settingsValue
  ? undefined
  : settingsValue.trimStart().startsWith("{")
    ? settingsValue
    : fs.readFileSync(settingsValue, "utf8");
const settings = settingsSource ? JSON.parse(settingsSource) : {};
const permissionPromptTool = valueAfter("--permission-prompt-tool");
const pendingControlResponses = new Map();
const invokeHook = async (eventName, payload) => {
  const group = settings.hooks && settings.hooks[eventName];
  const hook = Array.isArray(group) && group[0] && Array.isArray(group[0].hooks)
    ? group[0].hooks[0]
    : undefined;
  if (!hook || hook.type !== "http") {
    throw new Error(`Missing ${eventName} HTTP hook`);
  }
  const response = await fetch(hook.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(hook.headers || {}),
    },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  record({ type: "hook-response", eventName, result });
  return result;
};
const requestPermission = (payload) =>
  new Promise((resolve) => {
    pendingControlResponses.set(payload.request_id, resolve);
    send(payload);
  });
const send = (value) => {
  const output =
    process.env.MOCK_CLAUDE_NO_SESSION === "1"
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== "session_id"),
        )
      : value;
  process.stdout.write(`${JSON.stringify(output)}\n`);
};
const record = (value) => {
  if (!process.env.MOCK_RECORD_PATH) {
    return;
  }
  fs.appendFileSync(process.env.MOCK_RECORD_PATH, `${JSON.stringify(value)}\n`);
};

record({ type: "argv", argv: process.argv.slice(2) });

if (settingsValue && settingsValue !== settingsSource) {
  record({
    type: "settings-file",
    path: settingsValue,
    mode: fs.statSync(settingsValue).mode & 0o777,
    directoryMode: fs.statSync(path.dirname(settingsValue)).mode & 0o777,
    hasAuthorization: JSON.stringify(settings).includes("Bearer "),
  });
}

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  void (async () => {
  if (!line.trim()) {
    return;
  }

  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`invalid input: ${String(error)}\n`);
    process.exit(2);
  }
  record({ type: "input", message });

  if (message && message.type === "control_response") {
    const requestId = message.response && message.response.request_id;
    const resolve = pendingControlResponses.get(requestId);
    if (resolve) {
      pendingControlResponses.delete(requestId);
      record({ type: "control-response", message });
      resolve(message);
    }
    return;
  }

  const content = message && message.message && message.message.content;
  const prompt = Array.isArray(content)
    ? content.map((item) => (item && item.type === "text" ? item.text : "")).join("")
    : "";

  send({ type: "system", subtype: "init", session_id: sessionId });

  // EX-A5-R10. A descendant that leaves the launch process group with setsid while inheriting the
  // environment, spawned for every turn (completing or long-running) so both interruption and
  // completed-run cleanup can be exercised. A group signal can no longer name it; only the scope
  // token the environment still carries can, which is what the environment-scope cleanup scans for.
  const detachedSessionPidFile = process.env.MOCK_CLAUDE_DETACHED_SESSION_CHILD;
  if (detachedSessionPidFile) {
    const { existsSync } = require("node:fs");
    const setsid = ["/usr/bin/setsid", "/bin/setsid"].find(existsSync) ?? "setsid";
    require("node:child_process").spawn(
      setsid,
      [process.execPath, path.join(__dirname, "mock-detached-session-worker.cjs"), detachedSessionPidFile],
      { stdio: "ignore", env: process.env },
    ).unref();
    // Block until the descendant has actually published its PID, so a turn that completes fast
    // still proves a real descendant existed before completion — not merely a launch request.
    const wait = new Int32Array(new SharedArrayBuffer(4));
    for (let i = 0; i < 1000 && !existsSync(detachedSessionPidFile); i += 1) {
      Atomics.wait(wait, 0, 0, 5);
    }
  }

  if (process.env.MOCK_CLAUDE_INVALID_JSON === "1") {
    process.stdout.write("not-json\n");
    return;
  }

  if (process.env.MOCK_CLAUDE_QUOTA === "1") {
    process.stderr.write("You have reached your weekly usage limit\n");
    process.exit(4);
  }

  if (process.env.MOCK_CLAUDE_QUOTA_AFTER_ACTIVITY === "1") {
    send({
      type: "stream_event",
      session_id: sessionId,
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } },
    });
    process.stderr.write("You have reached your weekly usage limit\n");
    process.exit(4);
  }

  if (process.env.MOCK_CLAUDE_ERROR === "1") {
    process.stderr.write("mock claude failure\n");
    process.exit(4);
  }

  if (process.env.MOCK_CLAUDE_RESULT_ERROR === "1") {
    send({
      type: "result",
      session_id: sessionId,
      is_error: true,
      subtype: "mock_result_error",
      result: "mock result failure",
    });
    process.exit(0);
  }

  if (prompt.includes("DELAY")) {
    setInterval(() => undefined, 1_000);
    return;
  }

  if (prompt.includes("ASK_USER")) {
    await invokeHook("PreToolUse", {
      session_id: sessionId,
      hook_event_name: "PreToolUse",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu-question",
      tool_input: {
        questions: [
          {
            question: "Which environment?",
            header: "Environment",
            options: [
              { label: "Development", description: "Use local settings" },
              { label: "Production", description: "Use live settings" },
            ],
            multiSelect: false,
          },
        ],
      },
    });
  }

  if (prompt.includes("PERMISSION")) {
    if (permissionPromptTool !== "stdio") {
      throw new Error("Missing stdio permission prompt tool");
    }
    await requestPermission({
      type: "control_request",
      request_id: "control-permission",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "toolu-permission",
        input: { command: "npm test" },
        permission_suggestions: [],
      },
    });
  }

  send({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "mock " } },
  });
  send({
    type: "stream_event",
    session_id: sessionId,
    event: { type: "content_block_delta", delta: { type: "text_delta", text: "claude answer" } },
  });
  send({
    type: "result",
    session_id: sessionId,
    is_error: false,
    result: "mock claude answer",
  });
  process.exit(0);
  })().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(5);
  });
});

process.on("SIGTERM", () => {
  if (process.env.MOCK_CLAUDE_IGNORE_SIGTERM === "1") {
    return;
  }
  process.exit(0);
});
