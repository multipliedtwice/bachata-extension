#!/usr/bin/env node

const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

// Generated from the installed CLI by scripts/generate-codex-protocol.mjs. The mock refuses
// exactly what codex-cli refuses, so no adapter test can pass by recording a payload the real
// app-server rejects.
const protocol = JSON.parse(
  fs.readFileSync(path.join(__dirname, "codex-protocol.json"), "utf8"),
).generated;
const uuidLike = /^[0-9a-fA-F-]{32,36}$/u;

if (process.argv.includes("--version")) {
  process.stdout.write("mock-codex 1.0.0\n");
  process.exit(0);
}

if (!process.argv.includes("app-server")) {
  process.stderr.write("expected app-server\n");
  process.exit(2);
}

const send = (value) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

const invalidRequest = (id, message) => {
  send({ id, error: { code: -32600, message } });
};

const approvalPolicyError = (value) =>
  value === undefined || protocol.askForApproval.strings.includes(value)
  || (value !== null && typeof value === "object"
    && protocol.askForApproval.objectVariants.some((variant) => variant in value))
    ? undefined
    : `Invalid request: unknown variant \`${String(value)}\`, expected one of ${
      [...protocol.askForApproval.strings, ...protocol.askForApproval.objectVariants]
        .map((entry) => `\`${entry}\``).join(", ")}`;

const sandboxModeError = (value) =>
  value === undefined || protocol.sandboxMode.includes(value)
    ? undefined
    : `Invalid request: unknown variant \`${String(value)}\`, expected one of ${
      protocol.sandboxMode.map((entry) => `\`${entry}\``).join(", ")}`;

const sandboxPolicyError = (value) => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") return "Invalid request: missing field `type`";
  const variant = protocol.sandboxPolicy[value.type];
  if (!variant) {
    return `Invalid request: unknown variant \`${String(value.type)}\`, expected one of ${
      Object.keys(protocol.sandboxPolicy).map((entry) => `\`${entry}\``).join(", ")}`;
  }
  const unsupported = Object.keys(value).find((key) => !variant.properties.includes(key));
  if (unsupported) {
    return `Invalid request: ${value.type}.${unsupported} is no longer supported; use permissionProfile for restricted reads`;
  }
  return undefined;
};

const threadIdError = (value, noun) =>
  typeof value === "string" && uuidLike.test(value)
    ? undefined
    : `invalid ${noun} id: invalid character: expected an optional prefix of \`urn:uuid:\` followed by [0-9a-fA-F-], found \`${String(value).slice(0, 1)}\` at 1`;

const record = (value) => {
  if (!process.env.MOCK_RECORD_PATH) {
    return;
  }
  fs.appendFileSync(process.env.MOCK_RECORD_PATH, `${JSON.stringify(value)}\n`);
};

let threadCounter = 0;
let turnCounter = 0;
let active;
let approvalRequestId = 1000;
const approvalIds = new Set();

const complete = (status = "completed") => {
  if (!active) {
    return;
  }
  const current = active;
  active = undefined;
  if (current.timer) {
    clearTimeout(current.timer);
  }
  if (status === "completed") {
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: current.threadId,
        turnId: current.turnId,
        delta: "mock ",
      },
    });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: current.threadId,
        turnId: current.turnId,
        delta: "codex answer",
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: current.threadId,
        turnId: current.turnId,
        item: { type: "agentMessage", text: "mock codex answer" },
      },
    });
  }
  send({
    method: "turn/completed",
    params: {
      threadId: current.threadId,
      turn: {
        id: current.turnId,
        threadId: current.threadId,
        status,
        error: null,
      },
    },
  });
};

const startTurn = (message) => {
  const threadId = message.params.threadId;
  const turnId = `turn-${++turnCounter}`;
  const input = message.params.input;
  const text = Array.isArray(input)
    ? input.map((item) => (item && item.type === "text" ? item.text : "")).join("")
    : "";
  record({ type: "turn", params: message.params });
  active = { threadId, turnId, text };
  const sendTurnStartResponse = () => {
    send({
      id: message.id,
      result: {
        turn: { id: turnId, status: "inProgress", items: [], error: null },
      },
    });
  };
  if (process.env.MOCK_CODEX_NOTIFY_TURN_BEFORE_RESPONSE === "1") {
    send({
      method: "turn/started",
      params: {
        threadId,
        turn: { id: turnId, threadId, status: "inProgress" },
      },
    });
    record({ type: "turn-notified", threadId, turnId });
    setTimeout(sendTurnStartResponse, 500);
  } else {
    sendTurnStartResponse();
  }

  // EX-G6-06. A provider whose process tree outlives the interrupt request. The descendant is in
  // this process's own group and refuses SIGTERM, so termination is only confirmed after the
  // SIGKILL escalation.
  const resistantPidFile = process.env.MOCK_CODEX_SIGTERM_RESISTANT_CHILD;
  if (resistantPidFile) {
    require("node:child_process").spawn(
      process.execPath,
      [path.join(__dirname, "mock-sigterm-resistant-worker.cjs"), resistantPidFile],
      { stdio: "ignore" },
    ).unref();
  }

  // EX-A5-R10. A descendant that leaves the launch process group by starting its own session with
  // setsid, while inheriting the environment. A group signal can no longer name it; only the scope
  // token the environment still carries can, which is exactly what the environment-scope cleanup
  // scans for.
  const detachedSessionPidFile = process.env.MOCK_CODEX_DETACHED_SESSION_CHILD;
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

  if (process.env.MOCK_CODEX_QUOTA_AFTER_ACTIVITY === "1") {
    send({
      method: "item/agentMessage/delta",
      params: { threadId, turnId, delta: "partial" },
    });
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          threadId,
          status: "failed",
          error: { message: "You have reached your weekly usage limit" },
        },
      },
    });
    active = undefined;
    return;
  }

  if (process.env.MOCK_CODEX_INVALID_JSON === "1") {
    process.stdout.write("not-json\n");
    return;
  }

  if (process.env.MOCK_CODEX_CRASH === "1") {
    setTimeout(() => process.exit(3), 10);
    return;
  }

  if (
    text.includes("APPROVAL") ||
    text.includes("EXECPOLICY") ||
    text.includes("NETWORK") ||
    text.includes("PERMISSIONS") ||
    text.includes("USER_INPUT") ||
    text.includes("MCP_FORM") ||
    text.includes("MCP_URL")
  ) {
    const id = ++approvalRequestId;
    active.approvalId = id;
    approvalIds.add(id);

    if (text.startsWith("FILE_APPROVAL ")) {
      const data = JSON.parse(text.slice("FILE_APPROVAL ".length));
      const item = { id: "patch-1", type: "fileChange", status: "inProgress", changes: data.changes };
      const proposal = { threadId, turnId, startedAtMs: Date.now(), item };
      if (!data.omitStarted) send({ method: "item/started", params: proposal });
      if (data.completed) send({ method: "item/completed", params: { ...proposal, item: { ...item, status: "completed" } } });
      send({ id, method: "item/fileChange/requestApproval", params: {
        itemId: data.requestItemId ?? item.id,
        threadId: data.requestThreadId ?? threadId,
        turnId: data.requestTurnId ?? turnId,
        startedAtMs: Date.now(),
        reason: "Review proposed file changes",
        grantRoot: null,
      } });
      if (data.completeWhileApproval) setTimeout(() => {
        send({ method: "item/completed", params: { ...proposal, item: { ...item, status: "completed" } } });
      }, 30);
      return;
    }

    if (text.includes("USER_INPUT")) {
      active.requestType = "userInput";
      send({
        id,
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          isBlocking: !text.includes("USER_INPUT_NONBLOCKING"),
          ...(text.includes("USER_INPUT_NONBLOCKING") ? { autoResolutionMs: 20 } : {}),
          questions: [
            {
              id: "environment",
              header: "Environment",
              question: "Which environment should be used?",
              isOther: true,
              isSecret: false,
              options: [
                { label: "Development", description: "Use development" },
                { label: "Production", description: "Use production" },
              ],
            },
            {
              id: "token",
              header: "Token",
              question: "Enter the temporary token",
              isOther: false,
              isSecret: true,
            },
          ],
        },
      });
      return;
    }

    if (text.includes("MCP_FORM")) {
      active.requestType = "mcpForm";
      send({
        id,
        method: "mcpServer/elicitation/request",
        params: {
          threadId,
          turnId,
          serverName: "mock-mcp",
          mode: "form",
          message: "Configure deployment",
          requestedSchema: {
            type: "object",
            required: ["region", "replicas"],
            properties: {
              region: {
                type: "string",
                title: "Region",
                enum: ["ap-southeast-1", "eu-west-1"],
              },
              replicas: {
                type: "integer",
                title: "Replicas",
                minimum: 1,
              },
            },
          },
        },
      });
      return;
    }

    if (text.includes("MCP_URL")) {
      active.requestType = "mcpUrl";
      send({
        id,
        method: "mcpServer/elicitation/request",
        params: {
          threadId,
          turnId,
          serverName: "mock-mcp",
          mode: "url",
          message: "Open the authorization page",
          url: "https://example.com/authorize",
          elicitationId: "auth-1",
        },
      });
      return;
    }

    if (text.includes("PERMISSIONS")) {
      send({
        id,
        method: "item/permissions/requestApproval",
        params: {
          threadId,
          turnId,
          reason: "mock permissions",
          cwd: process.cwd(),
          permissions: {
            network: { hosts: ["example.com"] },
          },
        },
      });
      return;
    }

    const params = {
      threadId,
      turnId,
      command: ["npm", "test"],
      cwd: process.cwd(),
      reason: "mock approval",
      availableDecisions: ["accept", "decline", "cancel"],
    };

    if (text.includes("EXECPOLICY")) {
      params.proposedExecpolicyAmendment = ["npm", "test"];
      params.availableDecisions = [
        {
          acceptWithExecpolicyAmendment: {
            execpolicy_amendment: ["npm", "test"],
          },
        },
        "decline",
        "cancel",
      ];
    }

    if (text.includes("NETWORK")) {
      params.networkApprovalContext = {
        host: "example.com",
        protocol: "https",
        port: 443,
      };
      params.commandActions = [{ type: "network", host: "example.com" }];
      params.additionalPermissions = {
        network: { hosts: ["example.com"] },
      };
      params.proposedNetworkPolicyAmendments = [
        { host: "example.com", action: "allow" },
      ];
      params.availableDecisions = [
        {
          applyNetworkPolicyAmendment: {
            network_policy_amendment: {
              host: "example.com",
              action: "allow",
            },
          },
        },
        "decline",
        "cancel",
      ];
    }

    if (process.env.MOCK_CODEX_UNSUPPORTED_DECISIONS === "1") {
      params.availableDecisions = [{ type: "unsupported" }];
    }

    send({
      id,
      method: "item/commandExecution/requestApproval",
      params,
    });
    return;
  }

  if (text.includes("DELAY")) {
    return;
  }

  active.timer = setTimeout(() => complete("completed"), 10);
};

const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) {
    return;
  }
  const message = JSON.parse(line);
  record({ type: "rpc", pid: process.pid, message });

  const hangMethod = process.env.MOCK_CODEX_HANG_METHOD;
  if (hangMethod && hangMethod === message.method) {
    return;
  }

  if (message.method === "initialize") {
    const clientInfo = message.params && message.params.clientInfo;
    if (!clientInfo || typeof clientInfo.name !== "string" || typeof clientInfo.version !== "string") {
      invalidRequest(message.id, "Invalid request: missing field `clientInfo`");
      return;
    }
    send({
      id: message.id,
      result: {
        userAgent: `${clientInfo.name}/0.146.0 (mock)`,
        codexHome: "/mock/.codex",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    const rejection = approvalPolicyError(message.params.approvalPolicy)
      ?? sandboxModeError(message.params.sandbox);
    if (rejection) {
      invalidRequest(message.id, rejection);
      return;
    }
    const threadId = `thread-${++threadCounter}`;
    send({ id: message.id, result: { thread: { id: threadId } } });
    return;
  }
  if (message.method === "thread/resume") {
    const rejection = approvalPolicyError(message.params.approvalPolicy)
      ?? sandboxModeError(message.params.sandbox);
    if (rejection) {
      invalidRequest(message.id, rejection);
      return;
    }
    if (String(message.params.threadId).startsWith("bachata-")) {
      invalidRequest(message.id, threadIdError(message.params.threadId, "session"));
      return;
    }
    send({
      id: message.id,
      result: { thread: { id: message.params.threadId } },
    });
    return;
  }
  if (message.method === "turn/start") {
    const rejection = approvalPolicyError(message.params.approvalPolicy)
      ?? sandboxPolicyError(message.params.sandboxPolicy);
    if (rejection) {
      invalidRequest(message.id, rejection);
      return;
    }
    if (String(message.params.threadId).startsWith("bachata-")) {
      invalidRequest(message.id, threadIdError(message.params.threadId, "thread"));
      return;
    }
    if (process.env.MOCK_CODEX_QUOTA === "1") {
      send({ id: message.id, error: { code: 429, message: "You have reached your weekly usage limit" } });
      return;
    }
    startTurn(message);
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    complete("interrupted");
    return;
  }
  if (approvalIds.has(message.id)) {
    approvalIds.delete(message.id);
    record({ type: "approval-response", requestType: active?.requestType, message });
    if (!active) {
      return;
    }
    const result = message.result || {};
    if (active.requestType === "userInput") {
      if (result.answers && Object.keys(result.answers).length > 0) {
        active.timer = setTimeout(() => complete("completed"), 10);
      } else {
        complete("interrupted");
      }
      return;
    }
    if (active.requestType === "mcpForm" || active.requestType === "mcpUrl") {
      if (result.action === "accept") {
        active.timer = setTimeout(() => complete("completed"), 10);
      } else {
        complete("interrupted");
      }
      return;
    }
    const decision = result.decision;
    const grantedPermissions =
      result.permissions && Object.keys(result.permissions).length > 0;
    if (
      decision === "accept" ||
      decision === "acceptForSession" ||
      (decision && typeof decision === "object") ||
      grantedPermissions
    ) {
      active.timer = setTimeout(() => complete("completed"), 10);
    } else {
      complete("interrupted");
    }
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, result: {} });
  }
});

process.on("SIGTERM", () => process.exit(0));
