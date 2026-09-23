const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync, spawnSync } = require("node:child_process");

const { loadRuntimeHarness } = require("../tests/support/runtimeHarness.cjs");
const { scratchRootSync, removeScratchSync } = require("../tests/support/scratch.cjs");

const root = path.resolve(__dirname, "..");
const benchmarks = path.join(root, "benchmarks");
const contextRoot = path.join(benchmarks, "context-mode");
const MODES = (process.env.BENCHMARK_MODES ?? "legacy,localTodoStateV1").split(",").filter(Boolean);
const REPEAT = Number(process.env.BENCHMARK_REPEAT ?? "1");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

const copyFixtureTree = (fixtureRoot, target, excludedPaths) => {
  const excluded = new Set(excludedPaths);
  const walk = (source, destination) => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const relative = path.relative(fixtureRoot, from).split(path.sep).join("/");
      if (excluded.has(relative)) continue;
      const to = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        walk(from, to);
      } else {
        fs.copyFileSync(from, to);
      }
    }
  };
  walk(fixtureRoot, target);
};

const normalizedSource = (value) =>
  value.replace(/\r\n/gu, "\n").split("\n").map((line) => line.replace(/\s+$/u, "")).join("\n").trim();

const gitIn = (cwd) => (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const changedFiles = (git) =>
  git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .sort();

const filesUnder = (directory) => fs.existsSync(directory)
  ? fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(path.join(directory, entry.name)) : [path.join(directory, entry.name)])
  : [];

const jsonLines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const claudeUsage = (sessionId) => {
  const file = filesUnder(path.join(os.homedir(), ".claude", "projects")).find((candidate) => candidate.endsWith(`${sessionId}.jsonl`));
  if (!file) return undefined;
  const byMessage = new Map(jsonLines(file)
    .filter((entry) => entry.type === "assistant" && entry.message?.usage)
    .map((entry) => [entry.message.id, entry.message.usage]));
  const sum = (key) => [...byMessage.values()].reduce((total, usage) => total + (usage[key] ?? 0), 0);
  const cacheRead = sum("cache_read_input_tokens");
  const cacheWrite = sum("cache_creation_input_tokens");
  return { inputTotal: sum("input_tokens") + cacheWrite + cacheRead, cacheRead, cacheWrite, output: sum("output_tokens") };
};

const codexUsage = (threadId) => {
  const file = filesUnder(path.join(os.homedir(), ".codex", "sessions")).find((candidate) => candidate.endsWith(".jsonl") && candidate.includes(threadId));
  if (!file) return undefined;
  const last = jsonLines(file).map((entry) => entry.payload).filter((payload) => payload?.type === "token_count" && payload.info?.total_token_usage).at(-1);
  if (!last) return undefined;
  const usage = last.info.total_token_usage;
  return { inputTotal: usage.input_tokens, cacheRead: usage.cached_input_tokens ?? 0, cacheWrite: 0, output: usage.output_tokens };
};

const providerUsage = (calls) => {
  const sessions = [...new Map(calls.flatMap((call) => call.sessionIds.map((id) => [`${call.adapter}:${id}`, { adapter: call.adapter, id }]))).values()];
  const perSession = sessions.map(({ adapter, id }) => ({
    adapter, id, usage: adapter === "claude-code" ? claudeUsage(id) : adapter === "codex-app-server" ? codexUsage(id) : undefined,
  }));
  const known = perSession.filter((entry) => entry.usage);
  const sum = (key) => known.reduce((total, entry) => total + entry.usage[key], 0);
  return {
    sessions: perSession,
    complete: known.length === perSession.length,
    inputTotal: sum("inputTotal"),
    uncachedInput: sum("inputTotal") - sum("cacheRead"),
    output: sum("output"),
  };
};

const recordingRegistry = (calls) => (registry) => ({
  ...registry,
  create: (definition, context) => {
    const adapter = registry.create(definition, context);
    return {
      ...adapter,
      send: async function* (request, signal) {
        const call = {
          agentId: definition.id,
          adapter: definition.adapter,
          promptBytes: Buffer.byteLength(request.prompt),
          sessionMode: request.sessionMode ?? "existing",
          resumedSession: request.sessionId !== undefined,
          sessionIds: [],
          startedAt: Date.now(),
        };
        calls.push(call);
        for await (const event of adapter.send(request, signal)) {
          if (event.type === "session") call.sessionIds.push(event.sessionId);
          if (event.type === "complete") {
            call.status = event.status;
            call.answerBytes = Buffer.byteLength(event.answer);
          }
          yield event;
        }
        call.durationMs = Date.now() - call.startedAt;
      },
    };
  },
});

const runArm = async (task, mode) => {
  const fixtureRoot = path.join(benchmarks, task.fixture);
  const workspace = scratchRootSync(`bachata-context-${task.id}-${mode}-`);
  const reference = task.answerKey?.referenceFile;
  const checkScript = task.answerKey?.checkScript;
  copyFixtureTree(fixtureRoot, workspace, [reference, checkScript].filter(Boolean));
  const git = gitIn(workspace);
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", "commit", "-qm", "fixture");
  const calls = [];
  const interactions = [];
  const harness = loadRuntimeHarness({
    purgeCompiledModules: true,
    realProviderProbes: true,
    workspaceDirectories: [workspace],
    configuration: { executionContextMode: "legacy", codexWorkspaceScope: "wholeWorkingDirectory" },
    wrapRealAdapterRegistry: recordingRegistry(calls),
    runtimeOptions: {
      requestInteraction: async (request) => {
        interactions.push({ kind: request.kind, title: request.title });
        return { selected: [], freeText: "", source: "cancel" };
      },
    },
  });
  const startedAt = Date.now();
  let status;
  let error;
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.configure({ workingDirectory: workspace, pipelineId: "todo-implementation" });
    if (mode === "localTodoStateV1") {
      const selected = harness.runtime.getState();
      await harness.runtime.handleMessage({ type: "executionContext.set", mode, expectedDefault: "legacy",
        pipelineId: selected.selectedPipelineId, pipelineHash: selected.selectedPipelineHash,
        attachmentIds: [], requestId: "benchmark-enable" });
    }
    const pinned = harness.runtime.getState().executionContext;
    if (pinned?.defaultMode !== mode) throw new Error(`Mode not applied: expected ${mode}, got ${String(pinned?.defaultMode)}`);
    const result = await harness.runtime.runPipeline(task.prompt, [], { allowedPaths: ["src"], writeScope: "configured" });
    status = result.status;
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const durationMs = Date.now() - startedAt;
  const changed = changedFiles(git);
  const expected = [...(task.answerKey?.expectedChangedFiles ?? [])].sort();
  const referenceMatch = reference
    ? expected.every((file) => fs.existsSync(path.join(workspace, file))
      && normalizedSource(fs.readFileSync(path.join(workspace, file), "utf8"))
        === normalizedSource(fs.readFileSync(path.join(fixtureRoot, reference), "utf8")))
    : undefined;
  const check = checkScript
    ? spawnSync(process.execPath, [path.join(fixtureRoot, checkScript), workspace], { encoding: "utf8", timeout: 30_000 })
    : undefined;
  const checkPassed = check ? check.status === 0 : undefined;
  const verification = harness.transcript
    .filter((entry) => entry.eventType === "verification.controller")
    .map((entry) => entry.text);
  const record = {
    taskId: task.id,
    mode,
    pipelineId: "todo-implementation",
    recordedAt: new Date().toISOString(),
    status: status ?? "error",
    ...(error ? { error } : {}),
    durationMs,
    changedFiles: changed,
    scopeHeld: JSON.stringify(changed) === JSON.stringify(expected),
    ...(referenceMatch === undefined ? {} : { referenceMatch }),
    ...(checkPassed === undefined ? {} : { checkPassed, ...(checkPassed ? {} : { checkFailure: (check.stderr.split("\n").find((line) => line.includes("AssertionError")) ?? check.stderr.slice(0, 400)).trim() }) }),
    correct: (status === "completed") && JSON.stringify(changed) === JSON.stringify(expected) && referenceMatch !== false && checkPassed !== false,
    verification,
    interactions,
    calls,
    promptBytesTotal: calls.reduce((sum, call) => sum + call.promptBytes, 0),
    providerUsage: providerUsage(calls),
  };
  await harness.runtime.dispose();
  harness.cleanup();
  if (process.env.BENCHMARK_KEEP_WORKSPACE !== "1") removeScratchSync(workspace);
  return record;
};

const loadTasks = (directory) => fs.existsSync(directory)
  ? fs.readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => readJson(path.join(directory, name)))
  : [];

const nextRunIndex = (directory, mode) => 1 + fs.readdirSync(directory)
  .map((name) => new RegExp(`^${mode}\\.(\\d+)\\.json$`, "u").exec(name)?.[1])
  .filter(Boolean)
  .reduce((max, value) => Math.max(max, Number(value)), 0);

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)];
};

const summary = (tasks) => {
  process.stdout.write("\ntask | mode | correct/runs | median provider input | median uncached | median output | median calls\n");
  for (const task of tasks) {
    const directory = path.join(contextRoot, "runs", task.id);
    for (const mode of ["legacy", "localTodoStateV1"]) {
      const records = fs.existsSync(directory)
        ? fs.readdirSync(directory).filter((name) => name.startsWith(`${mode}.`)).map((name) => readJson(path.join(directory, name)))
        : [];
      if (records.length === 0) continue;
      const usage = records.filter((record) => record.providerUsage?.complete);
      process.stdout.write([
        task.id, mode, `${String(records.filter((record) => record.correct).length)}/${String(records.length)}`,
        String(median(usage.map((record) => record.providerUsage.inputTotal))),
        String(median(usage.map((record) => record.providerUsage.uncachedInput))),
        String(median(usage.map((record) => record.providerUsage.output))),
        String(median(records.map((record) => record.calls.length))),
      ].join(" | ") + "\n");
    }
  }
};

const main = async () => {
  const taskIds = process.argv.slice(2);
  const tasks = [...loadTasks(path.join(benchmarks, "tasks")), ...loadTasks(path.join(contextRoot, "tasks"))]
    .filter((task) => task.kind === "fix" && (taskIds.length === 0 || taskIds.includes(task.id)));
  if (tasks.length === 0) throw new Error("No fix task selected");
  for (let round = 1; round <= REPEAT; round += 1) {
    for (const task of tasks) {
      const directory = path.join(contextRoot, "runs", task.id);
      fs.mkdirSync(directory, { recursive: true });
      for (const mode of MODES) {
        process.stdout.write(`${task.id} ${mode} round ${String(round)}: running\n`);
        const record = await runArm(task, mode);
        const index = nextRunIndex(directory, mode);
        fs.writeFileSync(path.join(directory, `${mode}.${String(index)}.json`), `${JSON.stringify(record, null, 2)}\n`);
        process.stdout.write(`${task.id} ${mode} #${String(index)}: ${record.correct ? "correct" : "incorrect"} | ${record.status} | scope ${record.scopeHeld ? "held" : "broken"}${record.checkFailure ? ` | ${record.checkFailure}` : ""} | calls ${String(record.calls.length)} | prompt bytes ${String(record.promptBytesTotal)} | provider input ${String(record.providerUsage.inputTotal)} (uncached ${String(record.providerUsage.uncachedInput)}) output ${String(record.providerUsage.output)}${record.providerUsage.complete ? "" : " partial"} | ${String(Math.round(record.durationMs / 1000))}s${record.error ? ` | ${record.error}` : ""}\n`);
      }
    }
  }
  summary(tasks);
};

main().then(() => process.exit(0), (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
