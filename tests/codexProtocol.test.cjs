const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  assertCodexScopeSupported,
  codexApprovalPolicies,
  codexApprovalPolicyWire,
  codexSandboxModeWire,
  codexSandboxModes,
  codexSandboxPolicyFields,
  codexSandboxPolicyWire,
  codexScopeRefusal,
  codexWorkspaceScopes,
  isCodexScopeError,
} = require("../dist/adapters/codexWire.js");
const { createCodexAppServerAdapter } = require("../dist/adapters/codexAppServer.js");
const { classifyProviderFailure, providerFallbackFailureCodes } = require("../dist/adapters/providerFailure.js");
const {
  providerRecovery,
  providerRecoveryStatement,
} = require("../dist/adapters/providerRecovery.js");

const protocol = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "codex-protocol.json"), "utf8"),
);
const mockCodex = path.join(__dirname, "fixtures", "mock-codex.cjs");

const createAdapter = (overrides = {}) =>
  createCodexAppServerAdapter({
    command: mockCodex,
    commandCheckTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    turnTimeoutMs: 5000,
    interruptGraceMs: 500,
    requestApproval: async () => "accept",
    log: () => undefined,
    ...overrides,
  });

const withRecording = async (body) => {
  const recordPath = path.join(os.tmpdir(), `codex-protocol-${process.pid}-${Math.random()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  try {
    return await body(() => (fs.existsSync(recordPath)
      ? fs.readFileSync(recordPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : []));
  } finally {
    if (previous === undefined) delete process.env.MOCK_RECORD_PATH;
    else process.env.MOCK_RECORD_PATH = previous;
    fs.rmSync(recordPath, { force: true });
  }
};

const drain = async (adapter, request) => {
  for await (const event of adapter.send(request, new AbortController().signal)) {
    void event;
  }
};

const workspaceRequest = (overrides = {}) => ({
  prompt: "task",
  workingDirectory: os.tmpdir(),
  attachments: [],
  permissionMode: "readOnly",
  ...overrides,
});

test("the enum sets Bachata serialises are exactly the ones the installed CLI declares", () => {
  assert.deepEqual([...codexSandboxModes].sort(), protocol.generated.sandboxMode);
  assert.deepEqual([...codexApprovalPolicies].sort(), protocol.generated.askForApproval.strings);
});

test("file approval paths belong to the proposed item rather than the approval request", () => {
  assert.deepEqual(protocol.generated.fileChangeApprovalParams, ["grantRoot", "itemId", "reason", "startedAtMs", "threadId", "turnId"]);
  assert.deepEqual(protocol.generated.fileChangeItemRequired, ["changes", "id", "status", "type"]);
  assert.deepEqual(protocol.generated.fileUpdateChangeRequired, ["diff", "kind", "path"]);
  assert.deepEqual(protocol.generated.patchChangeKinds.update.properties, ["move_path", "type"]);
});

test("every sandbox policy variant Bachata can send carries exactly the fields the protocol declares", () => {
  for (const [variant, fields] of Object.entries(codexSandboxPolicyFields)) {
    assert.deepEqual(
      [...fields].sort(),
      protocol.generated.sandboxPolicy[variant].properties,
      `${variant} does not match the generated protocol`,
    );
  }
});

test("Bachata's internal approval vocabulary maps onto supported protocol values only", () => {
  assert.equal(codexApprovalPolicyWire("onRequest"), "on-request");
  assert.equal(codexApprovalPolicyWire("unlessTrusted"), "untrusted");
  assert.equal(codexApprovalPolicyWire(undefined), "on-request");
  for (const value of ["onRequest", "unlessTrusted", undefined]) {
    assert.equal(protocol.generated.askForApproval.strings.includes(codexApprovalPolicyWire(value)), true);
  }
});

test("Bachata's internal permission modes map onto supported sandbox modes only", () => {
  assert.equal(codexSandboxModeWire("readOnly", undefined), "read-only");
  assert.equal(codexSandboxModeWire("workspaceWrite", undefined), "workspace-write");
  assert.equal(
    codexSandboxModeWire("workspaceWrite", { readOnly: true, commitMode: "never" }),
    "read-only",
    "a read-only policy outranks the requested permission mode",
  );
  assert.equal(protocol.generated.sandboxMode.includes(codexSandboxModeWire("readOnly", undefined)), true);
});

test("the serialised sandbox policy never carries a readable-root field the protocol removed", () => {
  const readOnly = codexSandboxPolicyWire("readOnly", undefined, []);
  assert.deepEqual(readOnly, { type: "readOnly", networkAccess: false });
  const workspaceWrite = codexSandboxPolicyWire("workspaceWrite", undefined, ["/work"]);
  assert.deepEqual(workspaceWrite, {
    type: "workspaceWrite",
    writableRoots: ["/work"],
    networkAccess: false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  });
  for (const policy of [readOnly, workspaceWrite]) {
    assert.deepEqual(
      Object.keys(policy).filter((key) => !protocol.generated.sandboxPolicy[policy.type].properties.includes(key)),
      [],
    );
  }
});

test("the recorded rejections the fixture captured are the ones Bachata no longer produces", () => {
  assert.match(protocol.observed.rejectedCamelCaseApproval, /unknown variant `onRequest`/u);
  assert.match(protocol.observed.rejectedCamelCaseSandboxMode, /unknown variant `workspaceWrite`/u);
  assert.match(protocol.observed.rejectedReadOnlyAccessField, /readOnly\.access is no longer supported/u);
  assert.match(
    protocol.observed.rejectedWorkspaceWriteReadOnlyAccessField,
    /workspaceWrite\.readOnlyAccess is no longer supported/u,
  );
  assert.deepEqual(
    protocol.observed.permissionProfiles,
    [":danger-full-access", ":read-only", ":workspace"],
    "no permission profile expresses a per-path readable root",
  );
});

test("a turn serialises the exact wire payload the protocol accepts", async () => {
  await withRecording(async (records) => {
    const adapter = createAdapter({ workspaceScope: "wholeWorkingDirectory" });
    try {
      await drain(adapter, workspaceRequest({
        permissionMode: "workspaceWrite",
        approvalPolicy: "unlessTrusted",
        workspacePolicy: { readOnly: false, writeScope: "workspace", allowedPaths: ["."], commitMode: "never" },
      }));
      const sent = records();
      const threadStart = sent.find((record) => record.type === "rpc" && record.message.method === "thread/start");
      assert.equal(threadStart.message.params.sandbox, "workspace-write");
      assert.equal(threadStart.message.params.approvalPolicy, "untrusted");
      const turn = sent.find((record) => record.type === "turn");
      assert.equal(turn.params.approvalPolicy, "untrusted");
      assert.equal(turn.params.sandboxPolicy.type, "workspaceWrite");
    } finally {
      await adapter.dispose();
    }
  });
});

test("a resumed thread restates the policy instead of inheriting whatever started it", async () => {
  await withRecording(async (records) => {
    const adapter = createAdapter({ workspaceScope: "wholeWorkingDirectory" });
    try {
      await drain(adapter, workspaceRequest({
        sessionId: "0199a04e-4c15-7e90-99e4-78a5dfc5c09a",
        permissionMode: "readOnly",
        approvalPolicy: "onRequest",
        workspacePolicy: { readOnly: true, writeScope: "readOnly", allowedPaths: [], commitMode: "never" },
      }));
      const resume = records().find(
        (record) => record.type === "rpc" && record.message.method === "thread/resume",
      );
      assert.equal(resume.message.params.sandbox, "read-only");
      assert.equal(resume.message.params.approvalPolicy, "on-request");
    } finally {
      await adapter.dispose();
    }
  });
});

test("the mock refuses the payloads the real app-server refuses", async () => {
  await withRecording(async () => {
    const { spawn } = require("node:child_process");
    const readline = require("node:readline");
    const child = spawn(process.execPath, [mockCodex, "app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    const pending = new Map();
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message);
      }
    });
    let id = 1;
    const send = (method, params) => new Promise((resolve) => {
      const requestId = id += 1;
      pending.set(requestId, resolve);
      child.stdin.write(`${JSON.stringify({ method, id: requestId, params })}\n`);
    });
    try {
      await send("initialize", { clientInfo: { name: "test", version: "0" }, capabilities: {} });
      const camelApproval = await send("thread/start", { approvalPolicy: "onRequest", sandbox: "read-only" });
      assert.match(camelApproval.error.message, /unknown variant `onRequest`/u);
      const camelMode = await send("thread/start", { approvalPolicy: "on-request", sandbox: "workspaceWrite" });
      assert.match(camelMode.error.message, /unknown variant `workspaceWrite`/u);
      const removedField = await send("turn/start", {
        threadId: "thread-1",
        input: [],
        approvalPolicy: "on-request",
        sandboxPolicy: { type: "readOnly", networkAccess: false, access: { readableRoots: [] } },
      });
      assert.match(removedField.error.message, /readOnly\.access is no longer supported/u);
    } finally {
      child.kill("SIGKILL");
    }
  });
});

test("readiness performs the handshake and reports the server's own agent", async () => {
  const adapter = createAdapter();
  try {
    assert.match(await adapter.checkAvailability(), /^codex app-server 0\.146\.0$/u);
  } finally {
    await adapter.dispose();
  }
});

test("readiness fails closed when the command does not speak the protocol", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handshake-"));
  const command = path.join(directory, "silent.cjs");
  fs.writeFileSync(command, "#!/usr/bin/env node\nprocess.stdout.write('ok\\n');\n", "utf8");
  const adapter = createAdapter({ command });
  try {
    await assert.rejects(adapter.checkAvailability(), /invalid JSON|exited|initialize|protocol/u);
  } finally {
    await adapter.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("readiness fails closed when initialize answers without a user agent", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handshake-"));
  const command = path.join(directory, "empty-initialize.cjs");
  fs.writeFileSync(
    command,
    [
      "#!/usr/bin/env node",
      "const readline = require('node:readline');",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.id === undefined) return;",
      "  process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\\n');",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const adapter = createAdapter({ command });
  try {
    await assert.rejects(adapter.checkAvailability(), /did not answer initialize with a userAgent/u);
  } finally {
    await adapter.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("readiness fails closed when the server rejects a payload Bachata must send", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handshake-"));
  const command = path.join(directory, "rejecting.cjs");
  fs.writeFileSync(
    command,
    [
      "#!/usr/bin/env node",
      "const readline = require('node:readline');",
      "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      "  const message = JSON.parse(line);",
      "  if (message.method === 'initialize') {",
      "    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: 'old/0.1.0' } }) + '\\n');",
      "    return;",
      "  }",
      "  if (message.id === undefined) return;",
      "  process.stdout.write(JSON.stringify({",
      "    id: message.id,",
      "    error: { code: -32600, message: 'Invalid request: unknown variant `workspace-write`' },",
      "  }) + '\\n');",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const adapter = createAdapter({ command });
  try {
    await assert.rejects(
      adapter.checkAvailability(),
      /rejected Bachata's read-only sandbox mode payload/u,
    );
  } finally {
    await adapter.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a handshake that times out fails closed and leaves the adapter reusable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-handshake-"));
  const command = path.join(directory, "hanging.cjs");
  fs.writeFileSync(
    command,
    [
      "#!/usr/bin/env node",
      "const readline = require('node:readline');",
      "readline.createInterface({ input: process.stdin }).on('line', () => undefined);",
      "setInterval(() => undefined, 1000);",
      "",
    ].join("\n"),
    "utf8",
  );
  const adapter = createAdapter({ command, commandCheckTimeoutMs: 200, requestTimeoutMs: 200 });
  try {
    await assert.rejects(adapter.checkAvailability(), /timed out/u);
    await assert.rejects(adapter.checkAvailability(), /timed out/u);
  } finally {
    await adapter.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a narrower read scope is refused with the exact reason and remedy", () => {
  const declared = codexScopeRefusal(
    { readOnly: true, commitMode: "never", readPaths: ["src"] },
    "wholeWorkingDirectory",
  );
  assert.equal(declared.reason, "declaredReadPaths");
  assert.match(declared.message, /explicit read paths \(src\)/u);

  const restricted = codexScopeRefusal(
    { readOnly: true, commitMode: "never", restrictedPaths: ["secrets"] },
    "wholeWorkingDirectory",
  );
  assert.equal(restricted.reason, "restrictedPaths");
  assert.match(restricted.message, /withholds explicit paths \(secrets\)/u);

  const unacknowledged = codexScopeRefusal({ readOnly: true, commitMode: "never" }, "refuseNarrowedScope");
  assert.equal(unacknowledged.reason, "unacknowledgedExclusions");
  assert.match(unacknowledged.message, /bachata\.codexWorkspaceScope/u);

  assert.equal(codexScopeRefusal({ readOnly: true, commitMode: "never" }, "wholeWorkingDirectory"), undefined);
  assert.equal(codexScopeRefusal(undefined, "refuseNarrowedScope"), undefined);
});

test("an acknowledgement never overrides a run-scoped confidentiality promise", () => {
  for (const scope of codexWorkspaceScopes) {
    assert.equal(
      isCodexScopeError(codexScopeRefusal({ readOnly: true, commitMode: "never", readPaths: ["src"] }, scope)),
      true,
    );
    assert.equal(
      isCodexScopeError(codexScopeRefusal({ readOnly: true, commitMode: "never", restrictedPaths: [".env"] }, scope)),
      true,
    );
  }
  assert.throws(
    () => assertCodexScopeSupported({ readOnly: true, commitMode: "never" }, "refuseNarrowedScope"),
    (error) => isCodexScopeError(error) && error.code === "CODEX_SCOPE_UNSUPPORTED",
  );
});

test("a protocol rejection is classified as a protocol failure and never falls back", () => {
  const failure = classifyProviderFailure(
    new Error("Invalid request: unknown variant `onRequest`, expected one of `untrusted`"),
    "codex-app-server",
    "codex-cli:default",
    "none",
  );
  assert.equal(failure.code, "protocolError");
  assert.equal(failure.retryable, false);
  assert.equal(providerFallbackFailureCodes.has(failure.code), false);
});

test("a refused read scope is classified separately and never falls back", () => {
  const failure = classifyProviderFailure(
    new Error("Codex CLI 0.146.0 has no per-path readable-root capability: ..."),
    "codex-app-server",
    "codex-cli:default",
    "none",
  );
  assert.equal(failure.code, "scopeUnsupported");
  assert.equal(providerFallbackFailureCodes.has(failure.code), false);
});

test("a protocol failure offers explicit recovery choices instead of another provider", () => {
  const failure = classifyProviderFailure(
    new Error("Invalid request: unknown variant `onRequest`"),
    "codex-app-server",
    "codex-cli:default",
    "none",
  );
  const recovery = providerRecovery(failure);
  assert.deepEqual(
    recovery.choices.map((choice) => choice.id),
    ["runDoctor", "openProviderSettings", "chooseAnotherProvider", "disableProvider", "stop"],
  );
  assert.equal(recovery.choices.some((choice) => choice.id === "acceptWholeWorkingDirectory"), false);
});

test("a refused scope offers the acknowledgement only when the refusal is not run-scoped", () => {
  const failure = classifyProviderFailure(
    new Error("Codex CLI 0.146.0 has no per-path readable-root capability"),
    "codex-app-server",
    "codex-cli:default",
    "none",
  );
  assert.equal(
    providerRecovery(failure).choices.some((choice) => choice.id === "acceptWholeWorkingDirectory"),
    true,
  );
  assert.equal(
    providerRecovery(failure, { runScopedRefusal: true }).choices
      .some((choice) => choice.id === "acceptWholeWorkingDirectory"),
    false,
  );
});

test("a transient failure keeps its existing fallback eligibility", () => {
  const failure = classifyProviderFailure(
    new Error("You have reached your weekly usage limit"),
    "codex-app-server",
    "codex-cli:default",
    "none",
  );
  assert.equal(providerFallbackFailureCodes.has(failure.code), true);
  assert.equal(providerRecovery(failure), undefined);
});

test("a refused run never starts a provider process", async () => {
  await withRecording(async (records) => {
    const adapter = createAdapter();
    try {
      await assert.rejects(
        drain(adapter, workspaceRequest({
          workspacePolicy: { readOnly: true, writeScope: "readOnly", allowedPaths: [], commitMode: "never" },
        })),
        /has no per-path readable-root capability/u,
      );
      assert.deepEqual(records(), [], "a refusal must not reach the provider at all");
    } finally {
      await adapter.dispose();
    }
  });
});

test("readiness leaves no provider process behind", async () => {
  await withRecording(async (records) => {
    const adapter = createAdapter();
    try {
      await adapter.checkAvailability();
      const pids = [...new Set(records().filter((record) => record.type === "rpc").map((record) => record.pid))];
      assert.ok(pids.length > 0, "the handshake never reached its provider fixture");
      for (const pid of pids) {
        assert.ok(Number.isSafeInteger(pid) && pid > 0, "the fixture did not identify its own process");
        assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the handshake left its provider process running");
      }
    } finally {
      await adapter.dispose();
    }
  });
});

test("the handshake probes carry the working directory it was asked about", async () => {
  await withRecording(async (records) => {
    const adapter = createAdapter({ workingDirectory: os.tmpdir() });
    try {
      await adapter.checkAvailability();
      const resumes = records().filter(
        (record) => record.type === "rpc" && record.message.method === "thread/resume",
      );
      assert.equal(resumes.length, 2);
      resumes.forEach((record) => assert.equal(record.message.params.cwd, os.tmpdir()));
    } finally {
      await adapter.dispose();
    }
  });
});

test("a run-scoped refusal never offers an acknowledgement that would not help", () => {
  const runScoped = classifyProviderFailure(
    new Error(
      "Codex CLI 0.146.0 has no per-path readable-root capability: ... This run declares explicit read paths (src), so Codex cannot keep the read scope this run asks for.",
    ),
    "codex-app-server",
    "codex-cli:default",
    "none",
  );
  assert.equal(
    providerRecovery(runScoped).choices.some((choice) => choice.id === "acceptWholeWorkingDirectory"),
    false,
    "accepting whole-directory reads would not make a run-scoped refusal runnable",
  );
  const unacknowledged = classifyProviderFailure(
    new Error("Codex CLI 0.146.0 has no per-path readable-root capability: Bachata withholds ..."),
    "codex-app-server",
    "codex-cli:default",
    "none",
  );
  assert.equal(
    providerRecovery(unacknowledged).choices.some((choice) => choice.id === "acceptWholeWorkingDirectory"),
    true,
  );
});

test("a recovery statement names what happened and every choice", () => {
  const failure = classifyProviderFailure(
    new Error("Invalid request: unknown variant `onRequest`"),
    "codex-app-server",
    "codex-cli:default",
    "none",
  );
  const statement = providerRecoveryStatement(providerRecovery(failure));
  assert.match(statement, /rejected Bachata's request/u);
  assert.match(statement, /will not run this somewhere else on its own/u);
  assert.match(statement, /- Run Doctor:/u);
  assert.match(statement, /- Disable this provider:/u);
});
