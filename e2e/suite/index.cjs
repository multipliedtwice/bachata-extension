const assert = require("node:assert/strict");
const { readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const protocolVersion = 9;
const humanE2eVerificationCommand = "node -e \"require('node:fs').accessSync('human-e2e-result.txt')\"";

const waitFor = async (predicate, message, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
};

const hasPairWebview = () =>
  vscode.window.tabGroups.all.some((group) =>
    group.tabs.some((tab) => tab.input?.viewType === "bachata"),
  );

const pipeline = {
  version: 1,
  id: "human-e2e-recovery",
  name: "Human E2E recovery",
  description: "Deterministic Extension Host recovery verification",
  agents: [{ id: "human-e2e-agent", name: "Human E2E agent", adapter: "human-e2e-adapter" }],
  steps: [{
    id: "human-e2e-step",
    name: "Human E2E step",
    enabled: true,
    humanGate: "none",
    type: "agent",
    participants: ["human-e2e-agent"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    attachments: "none",
  }],
};

const browserPipeline = {
  version: 1,
  id: "human-e2e-browser",
  name: "Human E2E Browser Bridge",
  description: "Controlled Browser Bridge Extension Host verification",
  agents: [{ id: "human-e2e-browser", name: "Human E2E browser", adapter: "chatgpt-browser" }],
  steps: [{
    id: "human-e2e-browser-step",
    name: "Browser transport",
    enabled: true,
    humanGate: "none",
    type: "agent",
    participants: ["human-e2e-browser"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    attachments: "none",
  }],
};

const controlledBrowserSession = () => ({
  id: "chatgpt:7:human-e2e-document:chatgpt%3Ahttps%3A%2F%2Fchatgpt.com%2Fc%2Fhuman-e2e",
  provider: "chatgpt",
  tabId: 7,
  frameId: 0,
  documentId: "human-e2e-document",
  documentToken: "human-e2e-document-token",
  conversationUrl: "https://chatgpt.com/c/human-e2e",
  conversationIdentity: "chatgpt:https://chatgpt.com/c/human-e2e",
  title: "Controlled Human E2E chat",
  status: "ready",
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
});

const createCollector = (socket) => {
  const messages = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    const value = JSON.parse(String(event.data));
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(value));
    if (waiterIndex < 0) {
      messages.push(value);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  });
  return {
    next: (predicate, timeoutMs = 10_000) => {
      const index = messages.findIndex(predicate);
      if (index >= 0) {
        return Promise.resolve(messages.splice(index, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            const waiterIndex = waiters.indexOf(waiter);
            if (waiterIndex >= 0) {
              waiters.splice(waiterIndex, 1);
            }
            reject(new Error("Timed out waiting for controlled Browser Bridge message"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
};

const connectControlledBrowserPeer = async (endpoint, pairingToken) => {
  assert.equal(typeof WebSocket, "function", "Extension Host does not expose WebSocket");
  const socket = new WebSocket(endpoint);
  const collector = createCollector(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("Controlled Browser Bridge connection failed")), { once: true });
  });
  socket.send(JSON.stringify({
    type: "bridge.pair",
    protocolVersion,
    token: pairingToken,
  }));
  const paired = await collector.next((value) => value.type === "bridge.paired");
  assert.equal(typeof paired.connectionToken, "string");
  await collector.next((value) => value.type === "bridge.connected");
  await collector.next((value) => value.type === "provider.discover");
  const session = controlledBrowserSession();
  socket.send(JSON.stringify({
    type: "provider.status",
    protocolVersion,
    sessions: [session],
    selectedSessionId: session.id,
  }));
  return { socket, collector, session };
};

const completeControlledBrowserRequest = (socket, request, session) => {
  const answer = "Controlled Browser Bridge response";
  socket.send(JSON.stringify({
    type: "conversation.submitted",
    protocolVersion,
    requestId: request.requestId,
    agentId: request.agentId,
    sessionId: session.id,
  }));
  socket.send(JSON.stringify({
    type: "conversation.stream",
    protocolVersion,
    requestId: request.requestId,
    agentId: request.agentId,
    sessionId: session.id,
    mode: "append",
    text: answer,
  }));
  socket.send(JSON.stringify({
    type: "conversation.response",
    protocolVersion,
    requestId: request.requestId,
    agentId: request.agentId,
    sessionId: session.id,
    provider: "chatgpt",
    text: answer,
    segments: [{ type: "text", text: answer, start: 0, end: answer.length }],
    assets: [],
    captureFormat: "renderedText",
    fidelity: "bestEffort",
    finalConversationUrl: session.conversationUrl,
    finalConversationIdentity: session.conversationIdentity,
    finalSessionId: session.id,
    startedAt: "2026-08-06T00:00:00.000Z",
    completedAt: "2026-08-06T00:00:01.000Z",
  }));
};

const waitForAbort = async (signal) => {
  if (signal.aborted) return;
  await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
};

const registerAdapter = (api, phase, counters) =>
  api.registerAdapter("human-e2e-adapter", {
    create: (definition, context) => ({
      id: definition.id,
      adapterType: "human-e2e-adapter",
      capabilities: {
        streaming: true,
        resume: true,
        interrupt: true,
        attachments: false,
        repositoryTools: false,
        browserSessionSelection: false,
        passiveActionLoop: false,
      },
      checkAvailability: async () => "human-e2e",
      send: async function* (request, signal) {
        if (definition.id === "human-e2e-master") {
          counters.masterSends += 1;
          const answer = JSON.stringify({ status: "continue", deviations: [] });
          yield { type: "text", text: answer };
          yield { type: "complete", answer, status: "completed" };
          return;
        }
        if (definition.id === "human-e2e-todo-worker") {
          counters.todoSends += 1;
          if (phase === "prepare" || counters.todoSends > 1) {
            await waitForAbort(signal);
            yield { type: "complete", answer: "TODO work interrupted by the human E2E controller", status: "interrupted" };
            return;
          }
          await writeFile(
            path.join(request.workingDirectory, "human-e2e-result.txt"),
            "Created by the deterministic Bachata human E2E adapter.\n",
            "utf8",
          );
          yield { type: "text", text: "Created human-e2e-result.txt" };
          yield { type: "complete", answer: "Created human-e2e-result.txt", status: "completed" };
          return;
        }
        counters.sends += 1;
        if (phase === "prepare" && counters.sends === 1) {
          const response = await context.requestCodexUserInput(definition.id, {
            requestId: "human-e2e-question",
            questions: [{
              id: "continue",
              header: "Human E2E question",
              question: "Continue the deterministic recovery scenario?",
              isOther: false,
              isSecret: false,
              options: [{ label: "Continue", description: "Resume the scenario" }],
            }],
            isBlocking: true,
          });
          assert.deepEqual(response.answers, { continue: { answers: ["Continue"] } });
          counters.answeredQuestions += 1;
        }
        yield { type: "text", text: `Human E2E ${phase} send ${String(counters.sends)}` };
        yield {
          type: "complete",
          answer: `Human E2E ${phase} answer ${String(counters.sends)}`,
          status: phase === "prepare" && counters.sends === 1 ? "interrupted" : "completed",
        };
      },
      interrupt: async () => undefined,
      resetSession: async () => undefined,
      dispose: async () => undefined,
    }),
    validateDefinition: () => [],
    validateOptions: () => [],
  });

const openExtension = async (api) => {
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "bachata.open",
    "bachata.todo.start",
    "bachata.todo.resume",
    "bachata.todo.stop",
    "bachata.todo.status",
    "bachata.todo.abandon",
    "bachata.resources.clearQuarantine",
  ]) {
    assert.ok(commands.includes(command), `${command} is not registered`);
  }
  await vscode.commands.executeCommand("bachata.open");
  await api.humanE2e.waitForWebviewReady();
  await waitFor(hasPairWebview, "Bachata webview did not open");
};

const prepare = async (api, workspaceDirectory, checkpointPath, counters) => {
  assert.equal(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, workspaceDirectory);
  const uiResult = await api.humanE2e.runWebviewScenario(
    "Verify interrupted cold recovery and iteration continuation",
    2,
    pipeline,
    30_000,
  );
  assert.equal(uiResult.runCreated, true);
  assert.equal(uiResult.pipelineCreated, true);
  assert.ok(uiResult.conversationId, "Webview did not report the created run");
  const conversationId = uiResult.conversationId;
  assert.equal(uiResult.drawerOpened, true);
  assert.equal(uiResult.newDraftDeleteHidden, true);
  assert.equal(uiResult.sourcePipelineIdLocked, true);
  assert.equal(uiResult.pendingOperationCloseLocked, true);
  assert.equal(uiResult.editorOpened, true);
  assert.equal(uiResult.editorSaved, true);
  assert.equal(uiResult.interactionAnswered, true);
  assert.equal(uiResult.submitted, true);
  assert.equal(uiResult.iterationCount, 2);

  await waitFor(
    () => api.humanE2e.getManagerState().conversations.find(
      (conversation) => conversation.id === conversationId,
    )?.workflowStatus === "interrupted",
    "Webview-submitted pipeline did not reach interrupted state",
  );
  assert.equal(counters.sends, 1);
  assert.equal(counters.answeredQuestions, 1);

  const todoStarted = await api.humanE2e.runWebviewAction("startTodo", undefined, 30_000);
  assert.equal(todoStarted.completed, true);
  await waitFor(
    () => api.humanE2e.getManagerState().orchestration.tasks.some(
      (task) => task.id === "HUMAN-E2E" && task.status === "running",
    ),
    "TODO task did not enter the running state",
    30_000,
  );
  const todoRunId = api.humanE2e.getManagerState().orchestration.runId;
  assert.ok(todoRunId, "TODO run ID is unavailable");
  const todoStopped = await api.humanE2e.runWebviewAction("stopTodo", undefined, 30_000);
  assert.equal(todoStopped.completed, true);
  assert.equal(api.humanE2e.getManagerState().orchestration.status, "stopped");
  assert.equal(counters.todoSends, 1);
  assert.ok(counters.masterSends >= 1, "TODO scheduling did not invoke the Master pipeline");
  const preparedMasterChecks = api.humanE2e.getManagerState().orchestration.masterChecks;
  assert.equal(
    preparedMasterChecks.some((check) => check.phase === "schedule" && check.status === "continue"),
    true,
  );
  assert.equal(preparedMasterChecks.every((check) => check.status === "continue"), true);

  await api.humanE2e.flush();
  await writeFile(
    checkpointPath,
    JSON.stringify({ conversationId, todoRunId, phaseOnePid: process.pid }),
    "utf8",
  );
};

const recoverPipeline = async (api, conversationId, counters) => {
  await waitFor(
    () => api.humanE2e.getManagerState().conversations.find(
      (conversation) => conversation.id === conversationId,
    )?.workflowStatus === "interrupted",
    "Interrupted run was not restored from persisted state",
  );
  const selected = await api.humanE2e.runWebviewAction("selectRun", conversationId, 20_000);
  assert.equal(selected.completed, true);
  const resumed = await api.humanE2e.runWebviewAction("resumeWorkflow", conversationId, 20_000);
  assert.equal(resumed.completed, true);
  await waitFor(
    () => api.humanE2e.getManagerState().conversations.find(
      (conversation) => conversation.id === conversationId,
    )?.workflowStatus === "completed",
    "Cold-restored workflow did not complete",
    20_000,
  );
  const recoveredState = api.humanE2e.getManagerState();
  const recovered = recoveredState.conversations.find((conversation) => conversation.id === conversationId);
  assert.ok(recovered, "Recovered conversation is unavailable");
  assert.equal(recovered.running, false);
  assert.equal(recovered.activeIteration, 2);
  assert.equal(recovered.iterationCount, 2);
  assert.equal(counters.sends, 2);
  assert.equal(counters.answeredQuestions, 0);
  const eventTypes = recoveredState.eventsByConversation[conversationId].map((event) => event.type);
  assert.equal(eventTypes.filter((type) => type === "run.started").length, 1);
  assert.ok(eventTypes.includes("run.interrupted"));
  assert.ok(eventTypes.includes("run.resumed"));
  assert.ok(eventTypes.includes("iteration.resumed"));
  assert.equal(eventTypes.at(-1), "run.completed");
  assert.equal((await api.humanE2e.runWebviewAction("archiveRun", conversationId, 20_000)).completed, true);
  assert.equal(
    api.humanE2e.getManagerState().conversations.find((conversation) => conversation.id === conversationId)?.archived,
    true,
  );
  assert.equal((await api.humanE2e.runWebviewAction("unarchiveRun", conversationId, 20_000)).completed, true);
  assert.equal(
    api.humanE2e.getManagerState().conversations.find((conversation) => conversation.id === conversationId)?.archived,
    false,
  );
  assert.equal((await api.humanE2e.runWebviewAction("deleteRun", conversationId, 20_000)).completed, true);
  assert.equal(
    api.humanE2e.getManagerState().conversations.some((conversation) => conversation.id === conversationId),
    false,
  );
};

const recoverTodo = async (api, todoRunId, counters) => {
  await waitFor(
    () => api.humanE2e.getManagerState().orchestration.runId === todoRunId &&
      api.humanE2e.getManagerState().orchestration.status === "stopped",
    "Stopped TODO run was not restored",
    20_000,
  );
  const resumed = await api.humanE2e.runWebviewAction("resumeTodo", undefined, 30_000);
  assert.equal(resumed.completed, true);
  await waitFor(
    () => api.humanE2e.getManagerState().orchestration.status === "completed",
    "Resumed TODO run did not complete",
    60_000,
  );
  const completed = api.humanE2e.getManagerState().orchestration;
  assert.equal(completed.runId, todoRunId);
  const completedTask = completed.tasks.find((task) => task.id === "HUMAN-E2E");
  assert.equal(completedTask?.status, "done");
  assert.deepEqual(completedTask?.checks, [{
    command: humanE2eVerificationCommand,
    status: "passed",
  }]);
  assert.deepEqual(completed.finalChecks, [{
    command: humanE2eVerificationCommand,
    status: "passed",
  }]);
  assert.equal(
    completed.masterChecks.some((check) => check.phase === "schedule" && check.status === "continue"),
    true,
  );
  assert.equal(
    completed.masterChecks.some((check) => check.phase === "terminal" && check.status === "continue"),
    true,
  );
  assert.equal(completed.masterChecks.every((check) => check.status === "continue"), true);
  assert.ok(counters.masterSends >= 2, "Recovered TODO execution did not run scheduling and terminal Master checks");
  assert.ok(completed.integrationWorktree, "Completed TODO run has no integration worktree");
  assert.match(
    await readFile(path.join(completed.integrationWorktree, "human-e2e-result.txt"), "utf8"),
    /deterministic Bachata human E2E adapter/u,
  );
  assert.match(
    await readFile(path.join(completed.integrationWorktree, "TODO.md"), "utf8"),
    /- \[x\] \[HUMAN-E2E\]/u,
  );
  assert.equal(counters.todoSends, 1);
  const cleaned = await api.humanE2e.runWebviewAction("cleanupTodo", todoRunId, 30_000);
  assert.equal(cleaned.completed, true);
  assert.equal(
    api.humanE2e.getManagerState().orchestration.retainedRuns.some((run) => run.runId === todoRunId),
    false,
  );

  const secondStarted = await api.humanE2e.runWebviewAction("startTodo", undefined, 30_000);
  assert.equal(secondStarted.completed, true);
  await waitFor(
    () => api.humanE2e.getManagerState().orchestration.tasks.some(
      (task) => task.id === "HUMAN-E2E" && task.status === "running",
    ),
    "Second TODO task did not enter the running state",
    30_000,
  );
  const secondRunId = api.humanE2e.getManagerState().orchestration.runId;
  assert.ok(secondRunId && secondRunId !== todoRunId, "Second TODO run was not created");
  const abandoned = await api.humanE2e.runWebviewAction("abandonTodo", undefined, 40_000);
  assert.equal(abandoned.completed, true);
  assert.equal(api.humanE2e.getManagerState().orchestration.runId, undefined);
  assert.equal(counters.todoSends, 2);
};

const verifyControlledBrowserBridge = async (api) => {
  const uiResult = await api.humanE2e.runWebviewScenario(
    "Verify controlled Browser Bridge transport",
    1,
    browserPipeline,
    30_000,
    false,
  );
  assert.equal(uiResult.runCreated, true);
  assert.equal(uiResult.pipelineCreated, true);
  assert.equal(uiResult.submitted, false);
  assert.ok(uiResult.conversationId, "Browser Bridge run was not created");
  assert.ok(uiResult.browserEndpoint, "Browser Bridge endpoint is unavailable");
  assert.ok(uiResult.pairingToken, "Browser Bridge pairing token is unavailable");
  const peer = await connectControlledBrowserPeer(uiResult.browserEndpoint, uiResult.pairingToken);
  try {
    const discovered = await api.humanE2e.runWebviewAction("discoverBridge", undefined, 20_000);
    assert.equal(discovered.completed, true);
    await peer.collector.next((value) => value.type === "provider.discover");
    peer.socket.send(JSON.stringify({
      type: "provider.status",
      protocolVersion,
      sessions: [peer.session],
      selectedSessionId: peer.session.id,
    }));
    const bound = await api.humanE2e.runWebviewAction("selectBrowserSession", peer.session.id, 20_000);
    assert.equal(bound.completed, true);
    const submitted = await api.humanE2e.runWebviewAction("submitPreparedRun", undefined, 20_000);
    assert.equal(submitted.completed, true);
    const request = await peer.collector.next((value) => value.type === "conversation.send", 20_000);
    assert.equal(request.text, "Verify controlled Browser Bridge transport");
    assert.equal(request.sessionId, peer.session.id);
    assert.equal(request.documentToken, peer.session.documentToken);
    completeControlledBrowserRequest(peer.socket, request, peer.session);
    await waitFor(
      () => api.humanE2e.getManagerState().conversations.find(
        (conversation) => conversation.id === uiResult.conversationId,
      )?.workflowStatus === "completed",
      "Controlled Browser Bridge run did not complete",
      20_000,
    );
    const eventTypes = api.humanE2e.getManagerState().eventsByConversation[uiResult.conversationId]
      .map((event) => event.type);
    assert.equal(eventTypes.at(-1), "run.completed");
  } finally {
    peer.socket.close();
  }
  assert.equal(
    (await api.humanE2e.runWebviewAction("deleteRun", uiResult.conversationId, 20_000)).completed,
    true,
  );
};

const recover = async (api, checkpointPath, counters) => {
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
  assert.notEqual(checkpoint.phaseOnePid, process.pid, "Recovery must run in a fresh Extension Host process");
  await recoverPipeline(api, checkpoint.conversationId, counters);
  await recoverTodo(api, checkpoint.todoRunId, counters);
  await verifyControlledBrowserBridge(api);
  await api.humanE2e.flush();
};

const run = async () => {
  assert.equal(process.env.BACHATA_HUMAN_E2E, "1");
  const phase = process.env.BACHATA_HUMAN_E2E_PHASE;
  assert.ok(phase === "prepare" || phase === "recover", "Invalid Human E2E phase");
  const extension = vscode.extensions.getExtension("local.bachata-vscode");
  assert.ok(extension, "Bachata development extension is unavailable");
  const api = await extension.activate();
  assert.ok(api.humanE2e, "Human E2E API is unavailable");
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(workspaceFolder, "Human E2E workspace is unavailable");
  const checkpointPath = path.join(workspaceFolder.uri.fsPath, ".bachata-human-e2e.json");
  const counters = { sends: 0, answeredQuestions: 0, todoSends: 0, masterSends: 0 };
  const registration = registerAdapter(api, phase, counters);
  try {
    await openExtension(api);
    if (phase === "prepare") {
      await prepare(api, workspaceFolder.uri.fsPath, checkpointPath, counters);
    } else {
      await recover(api, checkpointPath, counters);
    }
  } finally {
    registration.dispose();
  }
};

module.exports = { run };
