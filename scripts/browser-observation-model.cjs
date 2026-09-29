// Research only: local models retain chat history and drive the real read-only controller.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { scratchRootSync, removeScratchSync } = require("../tests/support/scratch.cjs");
const { observationStore, project } = require("./lib/browserObservationPrototype.cjs");
const { analyzeTrajectory, controllerPayload } = require("./lib/browserObservationBenchmark.cjs");
const { protocolFraming } = require("./lib/browserProtocolFraming.cjs");
const { prepareManagedBrowserTurn, executeManagedBrowserEnvelope, MANAGED_WORKSPACE_INTEGRITY_COMMAND } = require("../dist/browser/managedTurn.js");
const { validateBrowserControlEnvelope, browserControlProtocolPrompt, extractLastJsonObject } = require("../dist/browser/controlProtocol.js");

const MODELS = ["qwen3.5:4b-q4_K_M", "ministral-3:8b-instruct-2512-q4_K_M"];
const MAX_ROUNDS = 8;
const within = (root, target) => {
  const relative = path.relative(root, target);
  return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const SYSTEM = "You are a read-only Bachata reviewer. Reply with a bare JSON object equivalent to the requested bachata-control block: protocol, status, actions, summary, objections, unresolved. Never invent tool results. For terminal answers, summary must be a JSON-encoded string containing the requested report. Use only tools listed by the controller. Read source with context.readFile, for example {\"kind\":\"context.readFile\",\"path\":\"src/catalog.ts\",\"startLine\":1,\"endLine\":128}; or context.read with provided snippetIds. Follow all controller permissions.";
const BROWSER_SYSTEM = SYSTEM.replace("Reply with a bare JSON object equivalent to the requested bachata-control block:",
  "Reply with one fenced bachata-control code block containing the exact JSON envelope, preserving all JSON string escapes:");
const TASK = "Audit src/catalog.ts. Policy: retryLimit must be <= 5, and entries with secure:true must use https:// endpoints. Report every violation, no false positives. Terminal summary must encode {findings:[{id,rule,value}]} where rule is retryLimit or endpoint and value is the actual number or endpoint string. Run the controller integrity check before finishing. Do not modify files. Choose your own context reads.";
const FOLLOWUP = "Same read-only review, final inventory: report entry080's region and releaseTag from current controller source. Confirm the current file version using context.fileVersion, and run the integrity check before finishing. Terminal summary must encode {id:entry080,region:<exact value>,releaseTag:<exact value>}. Choose the reads you need; do not modify files.";

const source = () => Array.from({ length: 128 }, (_, n) => {
  const id = `entry${String(n).padStart(3, "0")}`;
  const retryLimit = n === 64 ? 8 : n === 107 ? 9 : 3;
  const endpoint = `${n === 85 || n === 120 ? "http" : "https"}://service${String(n)}.example.test`;
  return `export const ${id} = { retryLimit: ${String(retryLimit)}, secure: true, endpoint: "${endpoint}", region: "${n === 80 ? "eu-central-2" : "ap-southeast-1"}", releaseTag: "${n === 80 ? "release-ญ-080" : `release-${String(n)}`}", note: "Catalog deployment ${String(n)}" };`;
}).join("\n") + "\n";

const expected = {
  audit: [
    { id: "entry064", rule: "retryLimit", value: 8 },
    { id: "entry107", rule: "retryLimit", value: 9 },
    { id: "entry085", rule: "endpoint", value: "http://service85.example.test" },
    { id: "entry120", rule: "endpoint", value: "http://service120.example.test" },
  ],
  inventory: { id: "entry080", region: "eu-central-2", releaseTag: "release-ญ-080" },
};
const canonicalFindings = (findings) => JSON.stringify(findings.map(({ id, rule, value }) => ({ id, rule, value })).sort((a, b) => `${a.id}:${a.rule}`.localeCompare(`${b.id}:${b.rule}`)));
const escapeControllerSlashes = (prompt) => {
  const decoded = controllerPayload(prompt);
  if (!decoded) return prompt;
  // ChatGPT's rich composer can serialize URL spans as Markdown links. JSON solidus
  // escapes avoid auto-link spans while decoding to exactly the original controller data.
  const json = decoded.text.replaceAll("/", "\\/");
  if (JSON.stringify(JSON.parse(json)) !== JSON.stringify(decoded.value)) throw new Error("Wire escaping changed controller evidence");
  return prompt.slice(0, decoded.start) + json + prompt.slice(decoded.end);
};
const grade = (phase, envelope, actions, verification, results = [], inventoryExpected = expected.inventory) => {
  let report;
  try { report = JSON.parse(envelope?.summary); } catch { return { passed: false, reason: "Terminal summary is not the requested JSON report" }; }
  const factsCorrect = phase === "audit"
    ? Array.isArray(report?.findings) && report.findings.every((item) => item && typeof item === "object") && canonicalFindings(report.findings) === canonicalFindings(expected.audit)
    : report && typeof report === "object" && Object.entries(inventoryExpected).every(([key, value]) => report[key] === value);
  const verified = actions.some(({ kind, checkIds }) => kind === "verification.run" && checkIds.includes("integrity"))
    && verification.some(({ id, status }) => id === "integrity" && status === "passed");
  const versionChecked = phase === "audit" || results.some(({ kind, path: file, ok }) => kind === "context.fileVersion" && file === "src/catalog.ts" && ok === true);
  return { passed: factsCorrect && verified && versionChecked && ["reviewComplete", "done"].includes(envelope.status), factsCorrect, verified, versionChecked };
};

const recallEnvelope = (value, store) => {
  if (value?.status !== "needContext" || !Array.isArray(value.actions) || value.actions.length < 1 || value.actions.length > 4
    || !value.actions.every((action) => action?.kind === "context.recallObservation")) return undefined;
  const standard = validateBrowserControlEnvelope({ ...value, status: "reviewComplete", actions: [] });
  if (!standard) throw new Error("Invalid research recall envelope");
  return value.actions.map((action) => {
    if (Object.keys(action).some((key) => !["kind", "id", "offsetBytes", "maxBytes"].includes(key))) throw new Error("Unknown recall key");
    return { kind: action.kind, ok: true, ...store.recall(action) };
  });
};

const optionsFor = (root) => ({
  taskId: "observation-model-research", originalTask: TASK, role: "lead", workingDirectory: root,
  writeScope: "configured", readPaths: ["src"], allowedPaths: ["src"], protectedPaths: [], commitMode: "never", readOnly: true,
  verificationChecks: [{ id: "integrity", command: MANAGED_WORKSPACE_INTEGRITY_COMMAND }],
  maxRevisionCycles: 1, deadlineAt: Date.now() + 1_200_000, continuationMaxBytes: 262_144,
  handoffTotalBudgetBytes: 131_072, dependencyDepth: 1, promotionMaxBytes: 131_072, signal: AbortSignal.timeout(1_200_000),
  executor: { timeoutMs: 30_000, terminateGraceMs: 1000, maxOutputBytes: 1_048_576, maxReadBytes: 1_048_576, maxSearchResults: 100 },
  contextIndex: { maxInventoryFiles: 100, inventoryTimeoutMs: 30_000, indexingTimeoutMs: 30_000 },
  contextSearch: { maxFiles: 100, maxBytes: 1_048_576, maxFileBytes: 1_048_576, timeoutMs: 30_000 },
});

const rolloverInventory = { id: "entry080", region: "eu-west-3", releaseTag: "release-ญ-rollover" };
const rolloverSource = () => source().replace('region: "eu-central-2", releaseTag: "release-ญ-080"',
  `region: "${rolloverInventory.region}", releaseTag: "${rolloverInventory.releaseTag}"`);
const rejectedProposal = (value, references) => {
  const injected = structuredClone(value);
  injected.actions[0].researchUnknownKey = true;
  if (validateBrowserControlEnvelope(injected, references)) throw new Error("Controller unexpectedly accepted the injected invalid field");
  return injected;
};

const runArm = async (model, policy, evidenceDirectory, complete, scenario = "standard") => {
  const recovery = scenario === "recovery-rollover";
  const root = scratchRootSync("bachata-observation-model-");
  const records = [];
  const messages = [{ role: "system", content: SYSTEM }];
  const metrics = { prompts: 0, sentPromptBytes: Buffer.byteLength(SYSTEM), answerBytes: 0, requestHistoryBytes: complete ? undefined : 0,
    promptEvalTokens: complete ? undefined : 0, outputTokens: complete ? undefined : 0, durationMs: 0, recalls: 0, packedExposures: 0, framingCompactions: 0, invalidResponses: 0, wireOverheadBytes: 0, actionKinds: {},
    injectedProtocolRejections: 0, injectedApprovalRejections: 0, confirmedApprovalRejections: 0, fullRepairPrompts: 0, fullHandoffs: 0, conversationGenerations: 1 };
  const phases = [];
  const saveRaw = () => fs.writeFileSync(path.join(evidenceDirectory, `${model.split(":")[0]}-${policy}.json`), JSON.stringify({ model, policy, messages, records, metrics, phases }, null, 2) + "\n");
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "catalog.ts"), source());
    let options = optionsFor(root);
    let turn = await prepareManagedBrowserTurn(options);
    const store = observationStore();
    let frame = protocolFraming();
    let prompt = turn.prompt;
    for (const phase of ["audit", "inventory"]) {
      if (phase === "inventory") {
        if (recovery) {
          // The fixture coordinator changes only its owned scratch source between
          // completed generations. The reviewer remains read-only throughout.
          fs.writeFileSync(path.join(root, "src", "catalog.ts"), rolloverSource());
          options = { ...optionsFor(root), originalTask: FOLLOWUP };
          turn = await prepareManagedBrowserTurn(options);
          prompt = turn.prompt;
          frame = protocolFraming();
          messages.splice(1);
          metrics.conversationGenerations += 1;
        } else prompt = FOLLOWUP;
      }
      const actions = [];
      const results = [];
      const firstRound = metrics.prompts;
      let terminal;
      let failure;
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const framing = policy === "framing-once" ? frame(prompt) : { prompt, compacted: false };
        const projection = policy === "inline-once" ? project(prompt, store, "inline-once") : { prompt: framing.prompt, packed: [] };
        const sent = projection.packed.length ? `${projection.prompt}\nResearch recall tool is available only for IDs beginning observation- from the displayed observation receipts, never snippet IDs. Use {\"protocol\":\"bachata-browser-turn-v1\",\"status\":\"needContext\",\"actions\":[{\"kind\":\"context.recallObservation\",\"id\":\"<observation receipt id>\",\"offsetBytes\":0,\"maxBytes\":16384}],\"summary\":\"Retrieve exact historical observation\",\"objections\":[],\"unresolved\":[]}. Do not combine recalls with other action kinds.` : projection.prompt;
        messages.push({ role: "user", content: sent });
        const historyBytes = messages.reduce((sum, entry) => sum + Buffer.byteLength(entry.content), 0);
        if (historyBytes > 100_000) { messages.pop(); failure = "History byte guard reached; no context-truncation claim"; break; }
        metrics.prompts += 1;
        metrics.sentPromptBytes += Buffer.byteLength(sent);
        metrics.packedExposures += projection.packed.length;
        metrics.framingCompactions += Number(framing.compacted);
        const payloadKind = controllerPayload(sent)?.kind;
        if (payloadKind === "handoff" && sent.endsWith(browserControlProtocolPrompt)) metrics.fullHandoffs += 1;
        if (sent.startsWith("Research controller rejected the response:") && sent.endsWith(browserControlProtocolPrompt)) metrics.fullRepairPrompts += 1;
        if (!complete) metrics.requestHistoryBytes += historyBytes;
        const started = Date.now();
        const response = complete ? undefined : await fetch("http://127.0.0.1:11434/api/chat", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages, format: "json", stream: false, think: false, keep_alive: "10m",
            options: { temperature: 0, seed: 23, num_ctx: 32768, num_predict: 1024 } }), signal: AbortSignal.timeout(180_000),
        });
        if (response && !response.ok) throw new Error(`Ollama HTTP ${String(response.status)}`);
        const completion = complete ? await complete({ sent, messages, phase, round: metrics.prompts, newConversation: recovery && phase === "inventory" && round === 0 }) : await response.json();
        const answer = completion.message?.content;
        if (typeof answer !== "string") throw new Error("Local model returned no answer");
        metrics.durationMs += Date.now() - started;
        if (!complete) {
          metrics.promptEvalTokens += completion.prompt_eval_count ?? 0;
          metrics.outputTokens += completion.eval_count ?? 0;
        }
        metrics.answerBytes += Buffer.byteLength(answer);
        metrics.sentPromptBytes += completion.sentPromptOverheadBytes ?? 0;
        metrics.wireOverheadBytes += completion.sentPromptOverheadBytes ?? 0;
        records.push({ prompt: completion.wirePrompt ?? sent, answer, phase, promptEvalTokens: completion.prompt_eval_count });
        messages.push({ role: "assistant", content: answer });
        if (completion.prompt_eval_count >= 31_000) { failure = "Context token guard reached"; break; }
        let value;
        try {
          value = complete ? extractLastJsonObject(answer) : JSON.parse(answer);
          const recalled = policy === "inline-once" ? recallEnvelope(value, store) : undefined;
          if (recalled) {
            metrics.recalls += recalled.length;
            prompt = ["Bachata processed your managed control request. Continue the same task using only controller results below.",
              JSON.stringify({ results: recalled }, null, 2), browserControlProtocolPrompt].join("\n\n");
            saveRaw();
            continue;
          }
          const envelope = validateBrowserControlEnvelope(value, turn.contextReferences);
          if (!envelope) throw new Error("Invalid managed control JSON");
          if (envelope.actions.some(({ kind }) => kind.startsWith("workspace."))) throw new Error("Mutation is outside this read-only research task");
          if (recovery && phase === "audit" && metrics.injectedProtocolRejections === 0 && envelope.actions.length) {
            records.at(-1).injectedProposal = rejectedProposal(value, turn.contextReferences);
            metrics.injectedProtocolRejections += 1;
            prompt = `Research controller rejected the response: planned fault injection added an unknown action field. The strict production validator refused it; no action was executed. Resubmit a valid proposal under the original task and permissions. Do not claim verification succeeded until a controller result confirms it.\n\n${browserControlProtocolPrompt}`;
            saveRaw();
            continue;
          }
          actions.push(...envelope.actions);
          for (const { kind } of envelope.actions) metrics.actionKinds[kind] = (metrics.actionKinds[kind] ?? 0) + 1;
          const execution = await executeManagedBrowserEnvelope(envelope, turn, options, async (candidate) => {
            if (recovery && phase === "inventory" && metrics.injectedApprovalRejections === 0
              && JSON.parse(candidate.source.text).kind === "context.fileVersion") {
              metrics.injectedApprovalRejections += 1;
              return "reject";
            }
            return candidate.risk === "readOnly" ? "approve" : "reject";
          });
          metrics.confirmedApprovalRejections += execution.actionResults.filter(({ status }) => status === "rejected").length;
          if (execution.terminal) { terminal = envelope; break; }
          if (!execution.nextPrompt) throw new Error("No controller continuation");
          prompt = execution.nextPrompt;
          if (recovery && execution.actionResults.some(({ status }) => status === "rejected")) {
            const renewedPermission = "Research fixture coordinator: the preceding lookup refusal was the planned one-time denial. Permission is now granted to retry context.fileVersion for src/catalog.ts once. Keep this fresh conversation's current evidence and all read-only restrictions; never treat the denied lookup as a successful version check.";
            prompt = prompt.slice(0, -browserControlProtocolPrompt.length) + renewedPermission + "\n\n" + browserControlProtocolPrompt;
          }
          results.push(...(controllerPayload(prompt)?.value.results ?? []));
        } catch (error) {
          metrics.invalidResponses += 1;
          if (metrics.invalidResponses > 1) { failure = "Repeated invalid control response"; break; }
          prompt = `Research controller rejected the response: ${error.message}. Return the exact managed JSON envelope; do not invent a successful result. Only controller-provided observation- IDs can be recalled. Read files using context.readFile with path, startLine, endLine; read snippet IDs using context.read with snippetIds.\n\n${browserControlProtocolPrompt}`;
        }
        process.stdout.write(JSON.stringify({ model, policy, phase, turn: metrics.prompts, actions: value?.actions?.map(({ kind }) => kind), packed: projection.packed.length }) + "\n");
        saveRaw();
      }
      phases.push({ phase, rounds: metrics.prompts - firstRound, ...grade(phase, terminal, actions, turn.verification, results,
        recovery && phase === "inventory" ? rolloverInventory : expected.inventory), ...(failure ? { failure } : {}) });
      saveRaw();
      process.stdout.write(JSON.stringify({ model, policy, ...phases.at(-1) }) + "\n");
      if (!terminal) break;
    }
    const recoveryPassed = !recovery || (metrics.injectedProtocolRejections === 1 && metrics.injectedApprovalRejections === 1
      && metrics.confirmedApprovalRejections === 1 && metrics.fullRepairPrompts === 1 && metrics.fullHandoffs === 2
      && metrics.conversationGenerations === 2);
    return { model, policy, scenario, ...metrics, phases, recoveryPassed, passed: phases.length === 2 && phases.every(({ passed }) => passed) && recoveryPassed,
      trajectory: analyzeTrajectory(records, complete ? "browser-model-driven-read-only-controller" : "local-model-driven-read-only-controller") };
  } finally {
    saveRaw();
    removeScratchSync(root);
  }
};

const runBrowserPair = async (bridge, output, { initialSession, candidatePolicy = "inline-once", baselineReport, scenario = "standard" } = {}) => {
  if (!["inline-once", "framing-once"].includes(candidatePolicy)) throw new Error("Unknown research candidate policy");
  if (!["standard", "recovery-rollover"].includes(scenario) || (scenario !== "standard" && baselineReport)) throw new Error("Recovery workload requires a new matched baseline");
  const { randomUUID } = require("node:crypto");
  const absoluteOutput = path.resolve(output);
  const repo = path.resolve(__dirname, "..");
  if (within(repo, absoluteOutput)) throw new Error("Research output must be outside the extension checkout");
  const evidenceDirectory = `${absoluteOutput}.raw`;
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(),
    provenance: "ChatGPT browser conversation via existing Bachata Bridge; visible model identity unverified",
    sourceSha256: createHash("sha256").update(source()).digest("hex"),
    runnerSha256: createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
    scenario, candidatePolicy, framingHelperSha256: createHash("sha256").update(fs.readFileSync(path.join(__dirname, "lib", "browserProtocolFraming.cjs"))).digest("hex"),
    ...(scenario === "recovery-rollover" ? { rolloverSourceSha256: createHash("sha256").update(rolloverSource()).digest("hex"),
      faultPlan: { invalidActionField: "researchUnknownKey", rejectFirstInventoryVersionLookup: true, freshChatBeforeInventory: true,
        fixtureChange: "entry080 region and releaseTag; owned scratch source only" } } : {}),
    controllerBuildSha256: Object.fromEntries(["browser/managedTurn.js", "browser/controlProtocol.js", "browser/contextReferences.js", "context/taskHandoff.js"].map((file) =>
      [file, createHash("sha256").update(fs.readFileSync(path.join(repo, "dist", file))).digest("hex")])),
    acceptance: { maxRoundsPerPhase: MAX_ROUNDS, maxAddedPromptsPerPair: 2, requireAllFactsAndChecks: true, requireFewerSentPromptBytes: true },
    runs: [], decisions: [] };
  const save = () => fs.writeFileSync(absoluteOutput, JSON.stringify(report, null, 2) + "\n");
  if (baselineReport) {
    const previousBytes = fs.readFileSync(baselineReport);
    const previous = JSON.parse(previousBytes);
    const baseline = previous.runs?.find(({ policy }) => policy === "baseline");
    if (previous.sourceSha256 !== report.sourceSha256
      || JSON.stringify(previous.controllerBuildSha256) !== JSON.stringify(report.controllerBuildSha256)
      || JSON.stringify(previous.acceptance) !== JSON.stringify(report.acceptance)
      || previous.provenance !== report.provenance || !baseline?.passed
      || baseline.phases?.length !== 2 || !baseline.phases.every(({ passed }) => passed)
      || !Number.isSafeInteger(baseline.sentPromptBytes) || baseline.sentPromptBytes <= 0) throw new Error("Previous baseline is not compatible with this research workload");
    report.baselineReuse = { reportName: path.basename(baselineReport), reportSha256: createHash("sha256").update(previousBytes).digest("hex"),
      recordedAt: previous.recordedAt, runnerSha256: previous.runnerSha256,
      limitation: "Sequential pilot using a prior baseline; browser model identity and provider conditions remain unverified" };
    report.runs.push(baseline);
  }
  fs.writeFileSync(path.join(evidenceDirectory, "runner-snapshot.cjs"), fs.readFileSync(__filename));
  fs.writeFileSync(path.join(evidenceDirectory, "framing-snapshot.cjs"), fs.readFileSync(path.join(__dirname, "lib", "browserProtocolFraming.cjs")));
  save();
  for (const policy of baselineReport ? [candidatePolicy] : ["baseline", candidatePolicy]) {
    const signal = AbortSignal.timeout(1_200_000);
    const ownerId = `bachata-observation-research:${randomUUID()}`;
    try {
      const session = (policy === "baseline" || baselineReport) && initialSession ? initialSession : await bridge.openConversation("chatgpt", signal, undefined, true);
      if (session.status !== "ready") throw new Error(`New ChatGPT conversation is ${session.status}`);
      bridge.bindSession(ownerId, session.id);
      let activeSessionId = session.id;
      const generationSessions = [session.id];
      const generationIdentities = new Map();
      let generation = 1;
      const result = await runArm("chatgpt-web-unverified", policy, evidenceDirectory, async ({ sent, round, newConversation }) => {
        if (newConversation) {
          const fresh = await bridge.openConversation("chatgpt", signal, undefined, true);
          if (fresh.status !== "ready" || generationSessions.includes(fresh.id)) throw new Error("Rollover did not open a fresh ready conversation");
          activeSessionId = fresh.id;
          generationSessions.push(fresh.id);
          generation += 1;
          bridge.bindSession(ownerId, fresh.id);
        }
        if (round > 1) {
          bridge.discover();
          // Let provider retirement and the shared client's status poll settle before a new send.
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        const readyDeadline = Date.now() + 15_000;
        while (!bridge.getStatus().sessions.some(({ id, status }) => id === activeSessionId && status === "ready")) {
          if (signal.aborted || Date.now() >= readyDeadline) throw new Error("Research conversation did not become ready for the next dispatch");
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        let submitted = false;
        let capture;
        const observedSessionIds = new Set([activeSessionId]);
        const requestId = randomUUID();
        const wireController = escapeControllerSlashes(sent);
        const prompt = `BACHATA_REQUEST_ID:${randomUUID()}\n\n${round === 1 || newConversation ? `${BROWSER_SYSTEM}\n\n${wireController}` : wireController}`;
        const dispatch = { policy, round, startedAt: new Date().toISOString(), promptBytes: Buffer.byteLength(prompt), events: [] };
        const dispatchFile = path.join(evidenceDirectory, `dispatch-${policy}-${String(round)}.json`);
        const saveDispatch = () => fs.writeFileSync(dispatchFile, JSON.stringify(dispatch, null, 2) + "\n");
        saveDispatch();
        try {
        for await (const event of bridge.sendConversation("chatgpt", prompt, activeSessionId, signal, [], Date.now() + 180_000, { ownerId, requestId })) {
          dispatch.events.push({ type: event.type, at: new Date().toISOString() });
          saveDispatch();
          if (event.type === "session" || event.type === "binding") {
            activeSessionId = event.sessionId;
            observedSessionIds.add(activeSessionId);
          }
          if (event.type === "submitted") submitted = true;
          if (event.type === "response") {
            if (capture) throw new Error("Multiple responses for one research dispatch");
            capture = event.response;
          }
        }
        } catch (error) { dispatch.error = error.message; saveDispatch(); throw error; }
        if (capture) fs.writeFileSync(path.join(evidenceDirectory, `capture-${policy}-${String(round)}.json`), JSON.stringify(capture, null, 2) + "\n");
        const matchingRequest = capture && (capture.requestId === requestId
          || (/^[a-f0-9-]{36}:[a-f0-9-]{36}$/u.test(capture.requestId) && capture.requestId.endsWith(`:${requestId}`)));
        if (!submitted || !capture || !matchingRequest || capture.provider !== "chatgpt"
          || !observedSessionIds.has(capture.sessionId) || capture.finalSessionId !== activeSessionId) throw new Error("Bridge did not confirm matching submission and capture");
        if (capture.finalConversationIdentity) generationIdentities.set(generation, capture.finalConversationIdentity);
        const lastSegment = capture.segments.filter(({ text }) => text.trim()).at(-1);
        if (lastSegment?.type !== "codeBlock" || lastSegment.language?.trim().toLowerCase().replaceAll("_", "-") !== "bachata-control") throw new Error("Browser reply did not end in the requested exact control code segment");
        return { message: { content: lastSegment.text }, wirePrompt: prompt,
          sentPromptOverheadBytes: Buffer.byteLength(prompt) - Buffer.byteLength(sent) - (round === 1 ? Buffer.byteLength(SYSTEM) : 0) };
      }, scenario);
      result.distinctGenerationSessions = new Set(generationSessions).size;
      result.distinctFinalConversationIdentities = new Set(generationIdentities.values()).size;
      if (scenario === "recovery-rollover" && (result.distinctGenerationSessions !== 2 || result.distinctFinalConversationIdentities !== 2)) result.passed = false;
      report.runs.push(result);
    } catch (error) { report.runs.push({ model: "chatgpt-web-unverified", policy, passed: false, error: error.message }); }
    finally { bridge.releaseBinding(ownerId); }
    save();
  }
  const [baseline, projected] = report.runs;
  report.decisions.push({ candidateMetBar: baseline.passed && projected.passed
    && projected.prompts <= baseline.prompts + 2 && projected.sentPromptBytes < baseline.sentPromptBytes,
  ...(baseline.sentPromptBytes && projected.sentPromptBytes ? { byteReduction: 1 - projected.sentPromptBytes / baseline.sentPromptBytes,
    addedPrompts: projected.prompts - baseline.prompts, packedExposures: projected.packedExposures, recalls: projected.recalls, framingCompactions: projected.framingCompactions } : {}) });
  save();
  return { status: "completed", output: absoluteOutput, runs: report.runs.map(({ policy, passed, prompts, sentPromptBytes, error }) => ({ policy, passed, prompts, sentPromptBytes, error })), decisions: report.decisions };
};

const runBrowserDiagnostic = async (bridge, output, session) => {
  const ownerId = `bachata-observation-probe:${require("node:crypto").randomUUID()}`;
  const record = { provenance: "One generated short submission through existing Bridge", startedAt: new Date().toISOString(), events: [] };
  bridge.bindSession(ownerId, session.id);
  try {
    for await (const event of bridge.sendConversation("chatgpt", "Return exactly one JSON object: {\"ok\":true}.", session.id, AbortSignal.timeout(120_000), [], Date.now() + 120_000, { ownerId })) {
      record.events.push({ type: event.type, at: new Date().toISOString() });
      if (event.type === "response") record.answer = event.response.text;
    }
  } catch (error) { record.error = error.message; }
  finally { bridge.releaseBinding(ownerId); }
  record.completedAt = new Date().toISOString();
  record.passed = record.events.some(({ type }) => type === "submitted") && typeof record.answer === "string";
  fs.writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
  return { status: record.passed ? "passed" : "failed", ...record };
};

const main = async (args = process.argv.slice(2)) => {
  const argument = (key) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
  const output = argument("--output");
  const selected = argument("--model");
  if (!output || (selected && !MODELS.includes(selected))) throw new Error("Use --output FILE and optional --model installed supported model");
  const absoluteOutput = path.resolve(output);
  const repo = path.resolve(__dirname, "..");
  if (within(repo, absoluteOutput)) throw new Error("Research output must be outside the extension checkout");
  const evidenceDirectory = `${absoluteOutput}.raw`;
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const tagsResponse = await fetch("http://127.0.0.1:11434/api/tags", { signal: AbortSignal.timeout(5_000) });
  if (!tagsResponse.ok) throw new Error(`Ollama model inventory HTTP ${String(tagsResponse.status)}`);
  const tags = await tagsResponse.json();
  const report = { schemaVersion: 1, recordedAt: new Date().toISOString(),
    provenance: "Local Ollama chat history driving compiled Bachata controller; not a Browser Bridge/provider run",
    revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout?.trim() || null,
    sourceSha256: createHash("sha256").update(source()).digest("hex"),
    runnerSha256: createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
    controllerBuildSha256: Object.fromEntries(["browser/managedTurn.js", "browser/controlProtocol.js", "browser/contextReferences.js", "context/taskHandoff.js"].map((file) =>
      [file, createHash("sha256").update(fs.readFileSync(path.join(repo, "dist", file))).digest("hex")])),
    modelDigests: Object.fromEntries(tags.models.filter(({ name }) => MODELS.includes(name)).map(({ name, digest }) => [name, digest])),
    generation: { temperature: 0, seed: 23, contextTokens: 32768, maxOutputTokens: 1024 },
    acceptance: { maxRoundsPerPhase: MAX_ROUNDS, maxAddedPromptsPerPair: 2, requireAllFactsAndChecks: true, requireFewerSentPromptBytes: true },
    models: selected ? [selected] : MODELS, runs: [], decisions: [] };
  const save = () => fs.writeFileSync(absoluteOutput, JSON.stringify(report, null, 2) + "\n");
  save();
  for (const model of report.models) {
    for (const policy of ["baseline", "inline-once"]) {
      try { report.runs.push(await runArm(model, policy, evidenceDirectory)); }
      catch (error) { report.runs.push({ model, policy, passed: false, error: error.message }); }
      save();
    }
    const [baseline, projected] = report.runs.filter((run) => run.model === model);
    report.decisions.push({ model, candidateMetBar: baseline.passed && projected.passed
      && projected.prompts <= baseline.prompts + 2 && projected.sentPromptBytes < baseline.sentPromptBytes,
    ...(baseline.sentPromptBytes && projected.sentPromptBytes ? { byteReduction: 1 - projected.sentPromptBytes / baseline.sentPromptBytes,
      addedPrompts: projected.prompts - baseline.prompts, packedExposures: projected.packedExposures, recalls: projected.recalls } : {}) });
    save();
  }
  process.stdout.write(JSON.stringify({ output: absoluteOutput, decisions: report.decisions }) + "\n");
};

module.exports = { source, rolloverSource, rolloverInventory, rejectedProposal, grade, main, runBrowserPair, runBrowserDiagnostic, escapeControllerSlashes };
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
