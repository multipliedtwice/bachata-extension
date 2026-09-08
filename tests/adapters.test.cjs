const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCodexAppServerAdapter } = require("../dist/adapters/codexAppServer.js");
const { createClaudeCodeAdapter } = require("../dist/adapters/claudeCode.js");
const { createAdapterRegistry, registerAdapterType } = require("../dist/adapters/registry.js");
const { isProviderFailureError } = require("../dist/adapters/providerFailure.js");
const { safeProcessEnvironment } = require("../dist/process/safeEnvironment.js");

const fixtures = path.join(__dirname, "fixtures");
const mockCodex = path.join(fixtures, "mock-codex.cjs");
const mockClaude = path.join(fixtures, "mock-claude.cjs");
const mockClaudePersistent = path.join(fixtures, "mock-claude-persistent.cjs");
const canonicalTmpdir = fs.realpathSync.native(os.tmpdir());

const collect = async (iterable) => {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
};

const completion = (events) => events.find((event) => event.type === "complete");
const session = (events) => events.find((event) => event.type === "session");

const createCodex = (
  requestApproval = async () => "accept",
  overrides = {},
) =>
  createCodexAppServerAdapter({
    command: mockCodex,
    commandCheckTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    turnTimeoutMs: 5000,
    interruptGraceMs: 500,
    requestApproval,
    log: () => undefined,
    ...overrides,
  });

const createClaude = (overrides = {}) =>
  createClaudeCodeAdapter({
    command: mockClaude,
    commandTimeoutMs: 5000,
    turnTimeoutMs: 5000,
    interruptGraceMs: 500,
    log: () => undefined,
    ...overrides,
  });

const request = (prompt, sessionId, attachments = [], sessionName) => ({
  sessionId,
  prompt,
  workingDirectory: os.tmpdir(),
  attachments,
  sessionName,
  permissionMode: "readOnly",
  approvalPolicy: "onRequest",
});

const fileApprovalTurn = async (data, scoped, onApproval) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bachata-file-approval-")));
  fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const value = 1;\n");
  fs.writeFileSync(path.join(root, "src", "nested", "app.ts"), "export const value = 1;\n");
  const approvals = [];
  const adapter = createCodex(async (approval) => {
    approvals.push(approval);
    await onApproval?.(root);
    return "accept";
  }, { workspaceScope: "wholeWorkingDirectory" });
  try {
    const events = await collect(adapter.send({
      ...request(`FILE_APPROVAL ${JSON.stringify(data)}`),
      workingDirectory: root,
      permissionMode: "workspaceWrite",
      ...(scoped ? { workspacePolicy: { readOnly: false, writeScope: "configured", allowedPaths: ["src"], commitMode: "allow" } } : {}),
    }, new AbortController().signal));
    return { approvals, result: completion(events) };
  } finally {
    await adapter.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

const proposedFileChange = (overrides = {}) => ({ path: "src/app.ts", kind: { type: "update" }, diff: "@@ -1 +1 @@\n-before\n+after\n", ...overrides });

test("Codex forwards a schema-shaped file approval when no workspace policy restricts it", async () => {
  const { approvals, result } = await fileApprovalTurn({ changes: [proposedFileChange()] }, false);
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].kind, "fileChange");
  assert.match(approvals[0].reason, /"src\/app\.ts"/);
  assert.equal(result.status, "completed");
});

test("Codex checks file approval paths from the matching proposed item, including rename targets", async () => {
  const { approvals, result } = await fileApprovalTurn({ changes: [proposedFileChange({ kind: { type: "update", move_path: "src/renamed.ts" } })] }, true);
  assert.equal(approvals.length, 1);
  assert.match(approvals[0].reason, /"src\/renamed\.ts"/);
  assert.deepEqual(approvals[0].choices.map((choice) => choice.id), ["accept", "decline", "cancel"]);
  assert.equal(result.status, "completed");
});

test("Codex rechecks file scope after an approval waits on the user", async () => {
  const { approvals, result } = await fileApprovalTurn({ changes: [proposedFileChange({ path: "src/nested/app.ts" })] }, true, async (root) => {
    fs.renameSync(path.join(root, "src", "nested"), path.join(root, "outside"));
    fs.symlinkSync(path.join(root, "outside"), path.join(root, "src", "nested"), "junction");
  });
  assert.equal(approvals.length, 1);
  assert.equal(result.status, "interrupted");
});

test("Codex refuses missing, stale, malformed and out-of-scope file proposals", async () => {
  for (const data of [
    { changes: [proposedFileChange()], omitStarted: true },
    { changes: [proposedFileChange()], completed: true },
    { changes: [proposedFileChange()], requestItemId: "another-item" },
    { changes: [proposedFileChange()], requestThreadId: "another-thread" },
    { changes: [proposedFileChange()], requestTurnId: "another-turn" },
    { changes: [proposedFileChange({ path: "outside.ts" })] },
    { changes: [proposedFileChange({ kind: { type: "update", move_path: "outside.ts" } })] },
    { changes: [proposedFileChange(), proposedFileChange({ path: 42 })] },
    { changes: [proposedFileChange({ kind: { type: "unexpected" } })] },
    { changes: [proposedFileChange({ kind: { type: "update", move_path: 42 } })] },
    { changes: [] },
  ]) {
    const { approvals, result } = await fileApprovalTurn(data, true);
    assert.deepEqual(approvals, [], JSON.stringify(data));
    assert.equal(result.status, "interrupted", JSON.stringify(data));
  }
});

test("Codex cancels an approval whose proposed item completed while the user was deciding", async () => {
  const { approvals, result } = await fileApprovalTurn({ changes: [proposedFileChange()], completeWhileApproval: true }, false,
    () => new Promise((resolve) => setTimeout(resolve, 100)));
  assert.equal(approvals.length, 1);
  assert.equal(result.status, "interrupted");
});

test("Codex adapter starts, names, streams, and resumes a thread", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-name-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const adapter = createCodex();
  try {
    assert.match(await adapter.checkAvailability(), /^codex app-server 0\.146\.0$/u);
    const first = await collect(
      adapter.send(
        request("first", undefined, [], "[bachata:R7K3M9QAB:C9D3K8AFT] Lead · Review src/job-workers"),
        new AbortController().signal,
      ),
    );
    assert.equal(session(first).sessionId, "thread-1");
    assert.deepEqual(completion(first), {
      type: "complete",
      status: "completed",
      answer: "mock codex answer",
    });

    const second = await collect(
      adapter.send(
        request(
          "second",
          "thread-1",
          [],
          "[bachata:R7K3M9QAB:C9D3K8AFT] Lead · Review src/job-workers",
        ),
        new AbortController().signal,
      ),
    );
    assert.equal(session(second).sessionId, "thread-1");
    assert.equal(completion(second).status, "completed");

    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const nameRequests = records.filter(
      (record) =>
        record.type === "rpc" && record.message.method === "thread/name/set",
    );
    assert.equal(nameRequests.length, 1);
    assert.deepEqual(nameRequests[0].message.params, {
      threadId: "thread-1",
      name: "[bachata:R7K3M9QAB:C9D3K8AFT] Lead · Review src/job-workers",
    });
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("a delayed readiness-process exit cannot fail the replacement Codex transport", async (t) => {
  const processScope = require("../dist/process/processScope.js");
  const originalSpawn = processScope.spawnScopedProviderProcess;
  let launches = 0;
  let replayExit;
  let exitObserved;
  const observed = new Promise((resolve) => { exitObserved = resolve; });
  t.mock.method(processScope, "spawnScopedProviderProcess", (...args) => {
    const scope = originalSpawn(...args);
    launches += 1;
    if (launches === 1) {
      const once = scope.child.once;
      scope.child.once = function (event, listener) {
        if (event !== "exit") return once.call(this, event, listener);
        return once.call(this, event, (...values) => {
          replayExit = () => listener(...values);
          exitObserved();
        });
      };
    } else {
      setImmediate(() => replayExit());
    }
    return scope;
  });
  const adapter = createCodex();
  try {
    await adapter.checkAvailability();
    await observed;
    const events = await collect(adapter.send(request("after readiness"), new AbortController().signal));
    assert.equal(launches, 2);
    assert.equal(completion(events).status, "completed");
    assert.equal(completion(events).answer, "mock codex answer");
  } finally {
    replayExit?.();
    await adapter.dispose();
  }
});

test("Codex adapter forwards approvals and restricts sandbox roots", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const approvals = [];
  const adapter = createCodex(async (approval) => {
    approvals.push(approval);
    return "accept";
  });

  try {
    const events = await collect(
      adapter.send(request("APPROVAL"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].command, "npm test");

    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const initialize = records.find(
      (record) =>
        record.type === "rpc" && record.message.method === "initialize",
    );
    assert.equal(
      initialize.message.params.clientInfo.version,
      require("../package.json").version,
    );
    assert.equal(
      initialize.message.params.capabilities.mcpServerOpenaiFormElicitation,
      true,
    );
    const turn = records.find(
      (record) => record.type === "turn",
    );
    assert.deepEqual(turn.params.sandboxPolicy, { type: "readOnly", networkAccess: false });
    assert.equal(turn.params.approvalPolicy, "on-request");
    const approvalResponse = records.find(
      (record) => record.type === "approval-response",
    );
    assert.equal(approvalResponse.message.result.decision, "accept");
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Codex interruption completes as interrupted", async () => {
  const adapter = createCodex();
  const controller = new AbortController();
  try {
    const pending = collect(adapter.send(request("DELAY"), controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const events = await pending;
    assert.equal(completion(events).status, "interrupted");
  } finally {
    await adapter.dispose();
  }
});


test("Codex interruption is sent when a notification reveals the turn before turn/start responds", async () => {
  const recordPath = path.join(
    os.tmpdir(),
    `mock-codex-early-interrupt-${Date.now()}.jsonl`,
  );
  const previousRecord = process.env.MOCK_RECORD_PATH;
  const previousMode = process.env.MOCK_CODEX_NOTIFY_TURN_BEFORE_RESPONSE;
  process.env.MOCK_RECORD_PATH = recordPath;
  process.env.MOCK_CODEX_NOTIFY_TURN_BEFORE_RESPONSE = "1";
  const adapter = createCodex(undefined, { requestTimeoutMs: 3000 });
  const controller = new AbortController();
  try {
    const pending = collect(adapter.send(request("DELAY"), controller.signal));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (
        fs.existsSync(recordPath) &&
        fs.readFileSync(recordPath, "utf8").includes('"type":"turn-notified"')
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    controller.abort();
    const events = await pending;
    assert.equal(completion(events).status, "interrupted");
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      records.filter(
        (record) =>
          record.type === "rpc" &&
          record.message.method === "turn/interrupt",
      ).length,
      1,
    );
  } finally {
    await adapter.dispose();
    if (previousRecord === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previousRecord;
    }
    if (previousMode === undefined) {
      delete process.env.MOCK_CODEX_NOTIFY_TURN_BEFORE_RESPONSE;
    } else {
      process.env.MOCK_CODEX_NOTIFY_TURN_BEFORE_RESPONSE = previousMode;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

// EX-G6-06. The owed behavioural test: a provider whose process tree survives the interrupt
// request. The descendant refuses SIGTERM, so `terminateProcessTree` can only confirm the tree
// is gone after its SIGKILL escalation. An adapter that settled on having asked would report
// `interrupted` while that process is still running.
// kill(pid, 0) reports a reaped process as gone (ESRCH) but a not-yet-reaped zombie as alive; on
// Linux a SIGKILLed descendant lingers as a zombie until its parent is reaped, so — like
// process.test.cjs and orchestrator.test.cjs — a State: Z entry counts as not running. This keeps
// the immediate post-completion assertion honest without adding a wait that would let a genuinely
// running descendant outlive confirmed cleanup.
const processRunning = (pid) => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error.code === "EPERM";
  }
  if (process.platform === "linux") {
    try {
      if (/^State:\s+Z/mu.test(fs.readFileSync(`/proc/${String(pid)}/status`, "utf8"))) {
        return false;
      }
    } catch (error) {
      if (error?.code === "ENOENT") return false;
    }
  }
  return true;
};

test("Codex reports an interrupted turn only once its surviving process tree is gone", async (context) => {
  if (process.platform === "win32") {
    context.skip("POSIX process group test");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-codex-resistant-"));
  const pidFile = path.join(directory, "descendant.pid");
  const previous = process.env.MOCK_CODEX_SIGTERM_RESISTANT_CHILD;
  process.env.MOCK_CODEX_SIGTERM_RESISTANT_CHILD = pidFile;
  const adapter = createCodex(undefined, { interruptGraceMs: 300 });
  const controller = new AbortController();
  let descendant;
  try {
    const pending = collect(adapter.send(request("DELAY"), controller.signal));
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (fs.existsSync(pidFile)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    descendant = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    assert.equal(processRunning(descendant), true, "the fixture descendant never started");

    controller.abort();
    const events = await pending;

    assert.equal(completion(events).status, "interrupted");
    assert.equal(
      processRunning(descendant),
      false,
      "the turn was reported interrupted while its process tree was still running",
    );
  } finally {
    // Bounded whatever happened above: a failed assertion must not leave the descendant behind.
    if (descendant !== undefined) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        undefined;
      }
    }
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CODEX_SIGTERM_RESISTANT_CHILD;
    } else {
      process.env.MOCK_CODEX_SIGTERM_RESISTANT_CHILD = previous;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// EX-A5-R10. The topology a group signal cannot reach at all: a provider descendant that calls
// setsid, leaving the process group the launch created while inheriting the environment. The group
// cleanup can only prove its own group is empty, so before the adapters were launched under the
// environment scope this descendant reported `interrupted` while still alive. The scope token it
// still carries is what the environment-scope drain scans for.
test("Codex interruption reaches a descendant that left the process group for its own session", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Linux setsid regression test");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-codex-detached-session-"));
  const pidFile = path.join(directory, "descendant.pid");
  const previous = process.env.MOCK_CODEX_DETACHED_SESSION_CHILD;
  process.env.MOCK_CODEX_DETACHED_SESSION_CHILD = pidFile;
  const adapter = createCodex(undefined, { interruptGraceMs: 1000 });
  const controller = new AbortController();
  let descendant;
  try {
    const pending = collect(adapter.send(request("DELAY"), controller.signal));
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (fs.existsSync(pidFile)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    descendant = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    assert.equal(processRunning(descendant), true, "the fixture descendant never started");

    controller.abort();
    const events = await pending;

    assert.equal(completion(events).status, "interrupted");
    assert.equal(
      processRunning(descendant),
      false,
      "a descendant that left the process group survived the interrupt",
    );
  } finally {
    if (descendant !== undefined) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        undefined;
      }
    }
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CODEX_DETACHED_SESSION_CHILD;
    } else {
      process.env.MOCK_CODEX_DETACHED_SESSION_CHILD = previous;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// EX-A5-R10. The same topology for the Claude Code adapter: a provider descendant that calls setsid
// leaves the launch process group but keeps the inherited environment, so the group signal cannot
// name it and only the scope token drain reaches it. Both adapters launch through the same scoped
// helper, so both must prove the escaped descendant is cleaned up on interruption.
test("Claude interruption reaches a descendant that left the process group for its own session", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Linux setsid regression test");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-claude-detached-session-"));
  const pidFile = path.join(directory, "descendant.pid");
  const previous = process.env.MOCK_CLAUDE_DETACHED_SESSION_CHILD;
  process.env.MOCK_CLAUDE_DETACHED_SESSION_CHILD = pidFile;
  const adapter = createClaude({ interruptGraceMs: 1000 });
  const controller = new AbortController();
  let descendant;
  try {
    const pending = collect(adapter.send(request("DELAY"), controller.signal));
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (fs.existsSync(pidFile)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    descendant = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    assert.equal(processRunning(descendant), true, "the fixture descendant never started");

    controller.abort();
    const events = await pending;

    assert.equal(completion(events).status, "interrupted");
    assert.equal(
      processRunning(descendant),
      false,
      "a descendant that left the process group survived the interrupt",
    );
  } finally {
    if (descendant !== undefined) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        undefined;
      }
    }
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CLAUDE_DETACHED_SESSION_CHILD;
    } else {
      process.env.MOCK_CLAUDE_DETACHED_SESSION_CHILD = previous;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// EX-A5-R10. The after-completion behaviour the finding named, not only interruption. Codex keeps
// its app-server between successful turns, so a detached-session descendant spawned during a
// completed turn is expected to still be alive after that turn — cleanup is owed at disposal, and
// disposal must reach the escaped descendant through the scope token.
test("Codex disposal cleans up a detached-session descendant left by a completed turn", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Linux setsid regression test");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-codex-detached-complete-"));
  const pidFile = path.join(directory, "descendant.pid");
  const previous = process.env.MOCK_CODEX_DETACHED_SESSION_CHILD;
  process.env.MOCK_CODEX_DETACHED_SESSION_CHILD = pidFile;
  const adapter = createCodex();
  let descendant;
  try {
    const events = await collect(adapter.send(request("hello"), new AbortController().signal));
    assert.equal(completion(events).status, "completed");
    descendant = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    // The reusable server is still up, so its detached descendant is expected to still be running.
    assert.equal(processRunning(descendant), true, "the completed turn's descendant was not observed");

    await adapter.dispose();
    // Immediate contract: cleanup is confirmed once dispose resolves — no polling grace that could
    // hide a still-running descendant. The zombie-aware helper treats a not-yet-reaped kill as gone.
    assert.equal(processRunning(descendant), false, "disposal left a detached-session descendant running");
  } finally {
    if (descendant !== undefined) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        undefined;
      }
    }
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CODEX_DETACHED_SESSION_CHILD;
    } else {
      process.env.MOCK_CODEX_DETACHED_SESSION_CHILD = previous;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// EX-A5-R10. Claude exits its per-turn child when the turn completes, and the completion path drains
// the launch scope, so a detached-session descendant of a completed run must not survive that
// cleanup — proven before disposal is even reached.
test("Claude completed-run cleanup does not leave a detached-session descendant", async (context) => {
  if (process.platform !== "linux") {
    context.skip("Linux setsid regression test");
    return;
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-claude-detached-complete-"));
  const pidFile = path.join(directory, "descendant.pid");
  const previous = process.env.MOCK_CLAUDE_DETACHED_SESSION_CHILD;
  process.env.MOCK_CLAUDE_DETACHED_SESSION_CHILD = pidFile;
  const adapter = createClaude();
  let descendant;
  try {
    const events = await collect(adapter.send(request("hello"), new AbortController().signal));
    assert.equal(completion(events).status, "completed");
    descendant = Number(fs.readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(descendant) && descendant > 0);
    // Immediate contract: the per-turn child exited and completion drained the scope, so the
    // descendant is already gone the moment the completed events are delivered — no polling grace.
    assert.equal(processRunning(descendant), false, "a completed run left a detached-session descendant running");

    await adapter.dispose();
  } finally {
    if (descendant !== undefined) {
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        undefined;
      }
    }
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CLAUDE_DETACHED_SESSION_CHILD;
    } else {
      process.env.MOCK_CLAUDE_DETACHED_SESSION_CHILD = previous;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Codex process exit rejects an active turn", async () => {
  const previous = process.env.MOCK_CODEX_CRASH;
  process.env.MOCK_CODEX_CRASH = "1";
  const adapter = createCodex();
  try {
    await assert.rejects(
      collect(adapter.send(request("crash"), new AbortController().signal)),
      /exited with code 3/,
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CODEX_CRASH;
    } else {
      process.env.MOCK_CODEX_CRASH = previous;
    }
  }
});

test("Codex malformed JSON rejects an active turn", async () => {
  const previous = process.env.MOCK_CODEX_INVALID_JSON;
  process.env.MOCK_CODEX_INVALID_JSON = "1";
  const adapter = createCodex();
  try {
    await assert.rejects(
      collect(adapter.send(request("invalid"), new AbortController().signal)),
      /invalid JSON/,
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CODEX_INVALID_JSON;
    } else {
      process.env.MOCK_CODEX_INVALID_JSON = previous;
    }
  }
});

test("Claude malformed JSON rejects after transport termination", async () => {
  const previous = process.env.MOCK_CLAUDE_INVALID_JSON;
  process.env.MOCK_CLAUDE_INVALID_JSON = "1";
  // Keep the permission channel open so malformed output terminates a live CLI.
  const adapter = createClaude({
    requestPermission: async () => ({ behavior: "deny", message: "denied" }),
  });
  try {
    await assert.rejects(
      collect(adapter.send(request("invalid"), new AbortController().signal)),
      /invalid stream JSON/,
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CLAUDE_INVALID_JSON;
    } else {
      process.env.MOCK_CLAUDE_INVALID_JSON = previous;
    }
  }
});

test("Claude adapter sends prompts through stream JSON stdin and resumes", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-claude-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const adapter = createClaude();
  try {
    assert.match(await adapter.checkAvailability(), /mock-claude/);
    const first = await collect(
      adapter.send(
        request(
          "prompt beginning --danger",
          undefined,
          [],
          "[bachata:R7K3M9QAB:C2M8Q4DTA] Worker · Review src/job-workers",
        ),
        new AbortController().signal,
      ),
    );
    const sessionId = session(first).sessionId;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(completion(first).answer, "mock claude answer");

    const second = await collect(
      adapter.send(request("follow-up", sessionId), new AbortController().signal),
    );
    assert.equal(session(second).sessionId, sessionId);

    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const firstArgv = records.find((record) => record.type === "argv").argv;
    assert.equal(firstArgv.includes("prompt beginning --danger"), false);
    assert.equal(firstArgv.includes("--name"), true);
    assert.equal(
      firstArgv.at(firstArgv.indexOf("--name") + 1),
      "[bachata:R7K3M9QAB:C2M8Q4DTA] Worker · Review src/job-workers",
    );
    const firstInput = records.find((record) => record.type === "input").message;
    assert.equal(firstInput.message.content[0].text, "prompt beginning --danger");
    const resumedArgv = records
      .filter((record) => record.type === "argv")
      .at(1).argv;
    assert.equal(resumedArgv.includes("--resume"), true);
    assert.equal(resumedArgv.includes(sessionId), true);
    assert.equal(resumedArgv.includes("--name"), false);
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

const readMockRecords = (recordPath) =>
  fs
    .readFileSync(recordPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

const awaitRemoval = async (target) => {
  for (let attempt = 0; attempt < 200 && fs.existsSync(target); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// The hook bearer token used to ride on the child's command line, where any process running as
// this user reads it out of the process listing.
test("Claude hook settings travel in a private file instead of the command line", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-claude-settings-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const adapter = createClaude();
  try {
    const events = await collect(
      adapter.send(request("settings"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");

    const records = readMockRecords(recordPath);
    const argv = records.find((record) => record.type === "argv").argv;
    const settingsValue = argv.at(argv.indexOf("--settings") + 1);
    assert.equal(path.isAbsolute(settingsValue), true);
    assert.equal(settingsValue.trimStart().startsWith("{"), false);
    assert.equal(
      argv.some((entry) => entry.includes("Bearer") || entry.includes("Authorization")),
      false,
    );

    const settingsFile = records.find((record) => record.type === "settings-file");
    assert.equal(settingsFile.path, settingsValue);
    assert.equal(settingsFile.hasAuthorization, true);
    if (process.platform !== "win32") {
      // Nothing outside this user may read the bearer token, in the file or through its directory.
      assert.equal(settingsFile.mode & 0o077, 0);
      assert.equal(settingsFile.mode & 0o600, 0o600);
      assert.equal(settingsFile.directoryMode & 0o077, 0);
    }

    await awaitRemoval(settingsValue);
    assert.equal(fs.existsSync(settingsValue), false);
    assert.equal(fs.existsSync(path.dirname(settingsValue)), false);
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Claude removes the hook settings directory when a run fails", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-claude-settings-failure-${Date.now()}.jsonl`);
  const previousRecord = process.env.MOCK_RECORD_PATH;
  const previousError = process.env.MOCK_CLAUDE_ERROR;
  process.env.MOCK_RECORD_PATH = recordPath;
  process.env.MOCK_CLAUDE_ERROR = "1";
  const adapter = createClaude();
  try {
    await assert.rejects(
      collect(adapter.send(request("settings failure"), new AbortController().signal)),
      /mock claude failure/,
    );
    const settingsFile = readMockRecords(recordPath).find(
      (record) => record.type === "settings-file",
    );
    await awaitRemoval(settingsFile.path);
    assert.equal(fs.existsSync(settingsFile.path), false);
    assert.equal(fs.existsSync(path.dirname(settingsFile.path)), false);
  } finally {
    await adapter.dispose();
    if (previousRecord === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previousRecord;
    }
    if (previousError === undefined) {
      delete process.env.MOCK_CLAUDE_ERROR;
    } else {
      process.env.MOCK_CLAUDE_ERROR = previousError;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Claude adapter routes AskUserQuestion through the pair interaction hook", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-claude-question-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const requests = [];
  const adapter = createClaude({
    requestUserInput: async (input) => {
      requests.push(input);
      return { answers: { "Which environment?": "Development" } };
    },
  });
  try {
    const events = await collect(
      adapter.send(request("ASK_USER"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].requestId, "toolu-question");
    assert.deepEqual(requests[0].questions, [
      {
        question: "Which environment?",
        header: "Environment",
        options: [
          { label: "Development", description: "Use local settings" },
          { label: "Production", description: "Use live settings" },
        ],
        multiSelect: false,
      },
    ]);
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const hook = records.find(
      (record) => record.type === "hook-response" && record.eventName === "PreToolUse",
    );
    assert.equal(
      hook.result.hookSpecificOutput.permissionDecision,
      "allow",
    );
    assert.deepEqual(
      hook.result.hookSpecificOutput.updatedInput.answers,
      { "Which environment?": "Development" },
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Claude adapter routes permission control requests through Bachata", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-claude-permission-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const requests = [];
  const adapter = createClaude({
    requestPermission: async (input) => {
      requests.push(input);
      return { behavior: "allow" };
    },
  });
  try {
    const events = await collect(
      adapter.send(request("PERMISSION"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].requestId, "control-permission");
    assert.equal(requests[0].toolName, "Bash");
    assert.deepEqual(requests[0].toolInput, { command: "npm test" });
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const argv = records.find((record) => record.type === "argv").argv;
    assert.deepEqual(
      argv.slice(argv.indexOf("--permission-prompt-tool"), argv.indexOf("--permission-prompt-tool") + 2),
      ["--permission-prompt-tool", "stdio"],
    );
    const control = records.find((record) => record.type === "control-response");
    assert.equal(
      control.message.response.response.behavior,
      "allow",
    );
    assert.deepEqual(
      control.message.response.response.updatedInput,
      { command: "npm test" },
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Claude adapter transmits image attachments as native content blocks", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-claude-image-${Date.now()}.jsonl`);
  const imagePath = path.join(os.tmpdir(), `mock-image-${Date.now()}.png`);
  fs.writeFileSync(imagePath, Buffer.from([137, 80, 78, 71]));
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const adapter = createClaude();
  try {
    const events = await collect(
      adapter.send(
        request("inspect this", undefined, [imagePath]),
        new AbortController().signal,
      ),
    );
    assert.equal(completion(events).status, "completed");
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const input = records.find((record) => record.type === "input").message;
    assert.equal(input.message.content[1].type, "image");
    assert.equal(input.message.content[1].source.media_type, "image/png");
    assert.equal(input.message.content[1].source.data, "iVBORw==");
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
    fs.rmSync(imagePath, { force: true });
  }
});

test("Claude adapter transmits text attachments as text content blocks", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-claude-text-${Date.now()}.jsonl`);
  const notesPath = path.join(os.tmpdir(), `mock-notes-${Date.now()}.md`);
  fs.writeFileSync(notesPath, "# Spec\nThe retry must stop after three attempts.\n", "utf8");
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const adapter = createClaude();
  try {
    const events = await collect(
      adapter.send(
        request("apply this specification", undefined, [notesPath]),
        new AbortController().signal,
      ),
    );
    assert.equal(completion(events).status, "completed");
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const input = records.find((record) => record.type === "input").message;
    assert.equal(input.message.content[1].type, "text");
    assert.match(input.message.content[1].text, /Attached file mock-notes-/u);
    assert.match(input.message.content[1].text, /stop after three attempts/u);
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
    fs.rmSync(notesPath, { force: true });
  }
});

test("Claude interruption completes as interrupted", async () => {
  const adapter = createClaude();
  const controller = new AbortController();
  try {
    const pending = collect(adapter.send(request("DELAY"), controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const events = await pending;
    assert.equal(completion(events).status, "interrupted");
  } finally {
    await adapter.dispose();
  }
});



test("Claude interruption force-kills a process that ignores SIGTERM", async () => {
  const previous = process.env.MOCK_CLAUDE_IGNORE_SIGTERM;
  process.env.MOCK_CLAUDE_IGNORE_SIGTERM = "1";
  const adapter = createClaude({ interruptGraceMs: 50 });
  const controller = new AbortController();
  try {
    const pending = collect(adapter.send(request("DELAY"), controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort();
    const events = await pending;
    assert.equal(completion(events).status, "interrupted");
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CLAUDE_IGNORE_SIGTERM;
    } else {
      process.env.MOCK_CLAUDE_IGNORE_SIGTERM = previous;
    }
  }
});


test("Codex quota failure is typed as side-effect-free before turn activity", async () => {
  const previous = process.env.MOCK_CODEX_QUOTA;
  process.env.MOCK_CODEX_QUOTA = "1";
  const adapter = createCodex(undefined, { resourceId: "codex-cli:test" });
  try {
    await assert.rejects(
      collect(adapter.send(request("quota"), new AbortController().signal)),
      (error) => {
        assert.equal(isProviderFailureError(error), true);
        assert.equal(error.failure.code, "quotaExhausted");
        assert.equal(error.failure.sideEffects, "none");
        assert.equal(error.failure.resourceId, "codex-cli:test");
        return true;
      },
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) delete process.env.MOCK_CODEX_QUOTA;
    else process.env.MOCK_CODEX_QUOTA = previous;
  }
});

test("Claude quota failure is typed as side-effect-free before assistant or tool activity", async () => {
  const previous = process.env.MOCK_CLAUDE_QUOTA;
  process.env.MOCK_CLAUDE_QUOTA = "1";
  const adapter = createClaude({ resourceId: "claude-code:test" });
  try {
    await assert.rejects(
      collect(adapter.send(request("quota"), new AbortController().signal)),
      (error) => {
        assert.equal(isProviderFailureError(error), true);
        assert.equal(error.failure.code, "quotaExhausted");
        assert.equal(error.failure.sideEffects, "none");
        assert.equal(error.failure.resourceId, "claude-code:test");
        return true;
      },
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) delete process.env.MOCK_CLAUDE_QUOTA;
    else process.env.MOCK_CLAUDE_QUOTA = previous;
  }
});

test("provider quota failures after visible activity are marked as possible side effects", async () => {
  const previousCodex = process.env.MOCK_CODEX_QUOTA_AFTER_ACTIVITY;
  const previousClaude = process.env.MOCK_CLAUDE_QUOTA_AFTER_ACTIVITY;
  process.env.MOCK_CODEX_QUOTA_AFTER_ACTIVITY = "1";
  process.env.MOCK_CLAUDE_QUOTA_AFTER_ACTIVITY = "1";
  const codex = createCodex(undefined, { resourceId: "codex-cli:test" });
  const claude = createClaude({ resourceId: "claude-code:test" });
  try {
    for (const adapter of [codex, claude]) {
      await assert.rejects(
        collect(adapter.send(request("quota after activity"), new AbortController().signal)),
        (error) => {
          assert.equal(isProviderFailureError(error), true);
          assert.equal(error.failure.code, "quotaExhausted");
          assert.equal(error.failure.sideEffects, "possible");
          return true;
        },
      );
    }
  } finally {
    await Promise.all([codex.dispose(), claude.dispose()]);
    if (previousCodex === undefined) delete process.env.MOCK_CODEX_QUOTA_AFTER_ACTIVITY;
    else process.env.MOCK_CODEX_QUOTA_AFTER_ACTIVITY = previousCodex;
    if (previousClaude === undefined) delete process.env.MOCK_CLAUDE_QUOTA_AFTER_ACTIVITY;
    else process.env.MOCK_CLAUDE_QUOTA_AFTER_ACTIVITY = previousClaude;
  }
});

test("Claude nonzero exit includes stderr", async () => {
  const previous = process.env.MOCK_CLAUDE_ERROR;
  process.env.MOCK_CLAUDE_ERROR = "1";
  const adapter = createClaude();
  try {
    await assert.rejects(
      collect(adapter.send(request("error"), new AbortController().signal)),
      /mock claude failure/,
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CLAUDE_ERROR;
    } else {
      process.env.MOCK_CLAUDE_ERROR = previous;
    }
  }
});

test("Claude error result rejects even when process exits zero", async () => {
  const previous = process.env.MOCK_CLAUDE_RESULT_ERROR;
  process.env.MOCK_CLAUDE_RESULT_ERROR = "1";
  const adapter = createClaude();
  try {
    await assert.rejects(
      collect(adapter.send(request("result error"), new AbortController().signal)),
      /mock result failure/,
    );
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CLAUDE_RESULT_ERROR;
    } else {
      process.env.MOCK_CLAUDE_RESULT_ERROR = previous;
    }
  }
});


test("Codex turn timeout rejects and leaves the adapter reusable", async () => {
  const adapter = createCodex(async () => "accept", {
    turnTimeoutMs: 500,
    interruptGraceMs: 100,
  });
  try {
    await assert.rejects(
      collect(adapter.send(request("DELAY"), new AbortController().signal)),
      /Codex turn timed out after 500 ms/,
    );
    const recovered = await collect(
      adapter.send(request("recovered"), new AbortController().signal),
    );
    assert.equal(completion(recovered).status, "completed");
  } finally {
    await adapter.dispose();
  }
});

test("Codex adapter rejects concurrent turns", async () => {
  const adapter = createCodex();
  const controller = new AbortController();
  try {
    const first = collect(adapter.send(request("DELAY"), controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      collect(adapter.send(request("second"), new AbortController().signal)),
      /already running/,
    );
    controller.abort();
    assert.equal(completion(await first).status, "interrupted");
  } finally {
    await adapter.dispose();
  }
});

test("Claude turn timeout rejects and leaves the adapter reusable", async () => {
  const adapter = createClaude({
    turnTimeoutMs: 1_000,
    interruptGraceMs: 100,
  });
  try {
    await assert.rejects(
      collect(adapter.send(request("DELAY"), new AbortController().signal)),
      /Claude turn timed out after 1000 ms/,
    );
    const recovered = await collect(
      adapter.send(request("recovered"), new AbortController().signal),
    );
    assert.equal(completion(recovered).status, "completed");
  } finally {
    await adapter.dispose();
  }
});

test("Codex handles numeric approval ids and cancels unsupported decisions", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-unsupported-${Date.now()}.jsonl`);
  const previousRecordPath = process.env.MOCK_RECORD_PATH;
  const previousUnsupported = process.env.MOCK_CODEX_UNSUPPORTED_DECISIONS;
  process.env.MOCK_RECORD_PATH = recordPath;
  process.env.MOCK_CODEX_UNSUPPORTED_DECISIONS = "1";
  const approvals = [];
  const adapter = createCodex(async (approval) => {
    approvals.push(approval);
    return "accept";
  });

  try {
    const events = await collect(
      adapter.send(request("APPROVAL"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "interrupted");
    assert.deepEqual(approvals[0].choices, [
      { id: "cancel", label: "Cancel" },
    ]);

    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const response = records.find(
      (record) => record.type === "approval-response",
    );
    assert.equal(typeof response.message.id, "number");
    assert.equal(response.message.result.decision, "cancel");
  } finally {
    await adapter.dispose();
    if (previousRecordPath === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previousRecordPath;
    }
    if (previousUnsupported === undefined) {
      delete process.env.MOCK_CODEX_UNSUPPORTED_DECISIONS;
    } else {
      process.env.MOCK_CODEX_UNSUPPORTED_DECISIONS = previousUnsupported;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Claude adapter rejects concurrent turns", async () => {
  const adapter = createClaude();
  const controller = new AbortController();
  try {
    const first = collect(adapter.send(request("DELAY"), controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await assert.rejects(
      collect(adapter.send(request("second"), new AbortController().signal)),
      /already running/,
    );
    controller.abort();
    assert.equal(completion(await first).status, "interrupted");
  } finally {
    await adapter.dispose();
  }
});

test("Codex workspace-write mode stays inside the working directory", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-write-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const adapter = createCodex();

  try {
    const writeRequest = {
      ...request("write"),
      permissionMode: "workspaceWrite",
      approvalPolicy: "onRequest",
    };
    const events = await collect(
      adapter.send(writeRequest, new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");

    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const turn = records.find((record) => record.type === "turn");
    assert.deepEqual(turn.params.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: [canonicalTmpdir],
      networkAccess: false,
      excludeTmpdirEnvVar: true,
      excludeSlashTmp: true,
    });
    assert.equal(turn.params.approvalPolicy, "on-request");
    const threadStart = records.find(
      (record) => record.type === "rpc" && record.message.method === "thread/start",
    );
    assert.equal(threadStart.message.params.sandbox, "workspace-write");
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Codex request timeout terminates ambiguous transport and recovers", async () => {
  const previous = process.env.MOCK_CODEX_HANG_METHOD;
  process.env.MOCK_CODEX_HANG_METHOD = "thread/start";
  const adapter = createCodex(async () => "accept", {
    requestTimeoutMs: 5_000,
    interruptGraceMs: 50,
  });

  try {
    const pending = collect(
      adapter.send(request("request timeout"), new AbortController().signal),
    );
    setTimeout(() => {
      delete process.env.MOCK_CODEX_HANG_METHOD;
    }, 50);
    await assert.rejects(pending, /Codex request thread\/start timed out after 5000 ms/);

    const recovered = await collect(
      adapter.send(request("recovered"), new AbortController().signal),
    );
    assert.equal(completion(recovered).status, "completed");
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CODEX_HANG_METHOD;
    } else {
      process.env.MOCK_CODEX_HANG_METHOD = previous;
    }
  }
});

test("Claude does not persist an unconfirmed generated session", async () => {
  const previous = process.env.MOCK_CLAUDE_NO_SESSION;
  process.env.MOCK_CLAUDE_NO_SESSION = "1";
  const adapter = createClaude();

  try {
    const events = [];
    await assert.rejects(
      async () => {
        for await (const event of adapter.send(
          request("no session"),
          new AbortController().signal,
        )) {
          events.push(event);
        }
      },
      /without confirming a session id/,
    );
    assert.equal(events.some((event) => event.type === "session"), false);
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_CLAUDE_NO_SESSION;
    } else {
      process.env.MOCK_CLAUDE_NO_SESSION = previous;
    }
  }
});


test("Codex returns an execution-policy amendment selected by the user", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-execpolicy-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const approvals = [];
  const adapter = createCodex(async (approval) => {
    approvals.push(approval);
    return approval.choices.find((choice) => choice.id.startsWith("execpolicy:"))?.id;
  });

  try {
    const events = await collect(
      adapter.send(request("EXECPOLICY"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");
    assert.deepEqual(approvals[0].proposedExecpolicyAmendment, ["npm", "test"]);
    assert.ok(
      approvals[0].choices.some((choice) =>
        choice.id.startsWith("execpolicy:"),
      ),
    );
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const response = records.find(
      (record) => record.type === "approval-response",
    );
    assert.deepEqual(response.message.result.decision, {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["npm", "test"],
      },
    });
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Codex exposes network approval context and returns a network policy amendment", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-network-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const approvals = [];
  const adapter = createCodex(async (approval) => {
    approvals.push(approval);
    return approval.choices.find((choice) =>
      choice.id.startsWith("networkPolicy:"),
    )?.id;
  });

  try {
    const events = await collect(
      adapter.send(request("NETWORK"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");
    assert.deepEqual(approvals[0].networkApprovalContext, {
      host: "example.com",
      protocol: "https",
      port: 443,
    });
    assert.deepEqual(approvals[0].additionalPermissions, {
      network: { hosts: ["example.com"] },
    });
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const response = records.find(
      (record) => record.type === "approval-response",
    );
    assert.deepEqual(response.message.result.decision, {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: {
          host: "example.com",
          action: "allow",
        },
      },
    });
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Codex permissions requests are surfaced and granted for the selected scope", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-permissions-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const approvals = [];
  const adapter = createCodex(async (approval) => {
    approvals.push(approval);
    return "grantForSession";
  });

  try {
    const events = await collect(
      adapter.send(request("PERMISSIONS"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");
    assert.equal(approvals[0].kind, "permissions");
    assert.deepEqual(approvals[0].requestedPermissions, {
      network: { hosts: ["example.com"] },
    });
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const response = records.find(
      (record) => record.type === "approval-response",
    );
    assert.deepEqual(response.message.result, {
      permissions: { network: { hosts: ["example.com"] } },
      scope: "session",
    });
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});


test("Codex forwards requestUserInput answers without altering the response shape", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-user-input-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const requests = [];
  const adapter = createCodex(undefined, {
    requestUserInput: async (input) => {
      requests.push(input);
      return {
        answers: {
          environment: { answers: ["Development"] },
          token: { answers: ["secret-value"] },
        },
      };
    },
  });
  try {
    const events = await collect(
      adapter.send(request("USER_INPUT"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].isBlocking, true);
    assert.equal(requests[0].questions[1].isSecret, true);
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const response = records.find(
      (record) => record.type === "approval-response" && record.requestType === "userInput",
    );
    assert.deepEqual(response.message.result, {
      answers: {
        environment: { answers: ["Development"] },
        token: { answers: ["secret-value"] },
      },
    });
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Codex forwards MCP form elicitation responses", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-mcp-form-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const requests = [];
  const adapter = createCodex(undefined, {
    requestMcpElicitation: async (input) => {
      requests.push(input);
      return {
        action: "accept",
        content: { region: "ap-southeast-1", replicas: 2 },
      };
    },
  });
  try {
    const events = await collect(
      adapter.send(request("MCP_FORM"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "completed");
    assert.equal(requests[0].mode, "form");
    assert.equal(requests[0].serverName, "mock-mcp");
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const response = records.find(
      (record) => record.type === "approval-response" && record.requestType === "mcpForm",
    );
    assert.deepEqual(response.message.result, {
      action: "accept",
      content: { region: "ap-southeast-1", replicas: 2 },
    });
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});

test("Codex auto-resolves nonblocking user input at the provider deadline", async () => {
  const recordPath = path.join(os.tmpdir(), `mock-codex-user-input-timeout-${Date.now()}.jsonl`);
  const previous = process.env.MOCK_RECORD_PATH;
  process.env.MOCK_RECORD_PATH = recordPath;
  const adapter = createCodex(undefined, {
    requestUserInput: async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { answers: { environment: { answers: ["Late"] } } };
    },
  });
  try {
    const events = await collect(
      adapter.send(request("USER_INPUT_NONBLOCKING"), new AbortController().signal),
    );
    assert.equal(completion(events).status, "interrupted");
    const records = fs
      .readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const response = records.find(
      (record) => record.type === "approval-response" && record.requestType === "userInput",
    );
    assert.deepEqual(response.message.result, { answers: {} });
  } finally {
    await adapter.dispose();
    if (previous === undefined) {
      delete process.env.MOCK_RECORD_PATH;
    } else {
      process.env.MOCK_RECORD_PATH = previous;
    }
    fs.rmSync(recordPath, { force: true });
  }
});


test("external adapter registrations are visible, disposable, and cannot replace built-ins", () => {
  const registration = {
    create: () => {
      throw new Error("not used");
    },
    validateDefinition: (definition) => definition.model === "invalid" ? ["invalid model"] : [],
    validateOptions: () => [],
  };
  assert.throws(
    () => registerAdapterType("claude-code", registration),
    /cannot be replaced/,
  );
  const disposable = registerAdapterType("local-model", registration);
  try {
    const registry = createAdapterRegistry();
    assert.equal(registry.has("local-model"), true);
    assert.equal(registry.types().includes("local-model"), true);
    assert.deepEqual(
      registry.validateDefinition({ id: "local", name: "Local", adapter: "local-model", model: "invalid" }),
      ["invalid model"],
    );
    assert.throws(
      () => registerAdapterType("local-model", registration),
      /already registered/,
    );
  } finally {
    disposable.dispose();
  }
  assert.equal(createAdapterRegistry().has("local-model"), false);
});


test("native availability probes use the restricted provider environment", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "bachata-provider-probe-env-"));
  const command = path.join(directory, "probe.cjs");
  // Codex readiness is an app-server handshake, so the probe answers the protocol and reports
  // the environment it was given inside the user agent the handshake reads.
  fs.writeFileSync(
    command,
    [
      '#!/usr/bin/env node',
      'const environment = JSON.stringify({',
      '  allowed: process.env.BACHATA_ALLOWED_PROBE_ENV,',
      '  secret: process.env.BACHATA_UNSAFE_PROBE_SECRET,',
      '});',
      'if (!process.argv.includes("app-server")) {',
      '  process.stdout.write(environment);',
      '  process.exit(0);',
      '}',
      'const readline = require("node:readline");',
      'readline.createInterface({ input: process.stdin }).on("line", (line) => {',
      '  const message = JSON.parse(line);',
      '  if (message.method === "initialize") {',
      '    process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "probe/" + environment } }) + "\\n");',
      '    return;',
      '  }',
      '  if (message.id === undefined) return;',
      '  process.stdout.write(JSON.stringify({',
      '    id: message.id,',
      '    error: { code: -32600, message: "invalid thread id: invalid character" },',
      '  }) + "\\n");',
      '});',
      '',
    ].join("\n"),
    "utf8",
  );
  const previousSecret = process.env.BACHATA_UNSAFE_PROBE_SECRET;
  process.env.BACHATA_UNSAFE_PROBE_SECRET = "must-not-leak";
  const environment = safeProcessEnvironment(directory, { BACHATA_ALLOWED_PROBE_ENV: "allowed" });
  const adapters = [
    createCodex(undefined, { command, environment }),
    createClaude({ command, environment }),
  ];
  try {
    for (const adapter of adapters) {
      const result = await adapter.checkAvailability();
      assert.deepEqual(
        JSON.parse(result.replace(/^codex app-server /u, "")),
        { allowed: "allowed" },
      );
    }
  } finally {
    await Promise.all(adapters.map((adapter) => adapter.dispose()));
    if (previousSecret === undefined) {
      delete process.env.BACHATA_UNSAFE_PROBE_SECRET;
    } else {
      process.env.BACHATA_UNSAFE_PROBE_SECRET = previousSecret;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("Claude turn completes when the CLI keeps running after its result", async () => {
  const adapter = createClaude({
    command: mockClaudePersistent,
    turnTimeoutMs: 15_000,
    requestPermission: async () => ({ behavior: "deny", message: "denied" }),
  });
  try {
    const started = Date.now();
    const events = await collect(
      adapter.send(request("PERSISTENT"), new AbortController().signal),
    );
    const done = completion(events);
    assert.equal(done.status, "completed");
    assert.equal(done.answer, "persistent answer");
    assert.ok(
      Date.now() - started < 10_000,
      "adapter must settle on the result message instead of waiting for the turn timeout",
    );
  } finally {
    await adapter.dispose();
  }
});
