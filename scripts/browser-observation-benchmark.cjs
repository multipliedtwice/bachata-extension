const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { analyzeTrajectory, controllerPayload, parseTrace } = require("./lib/browserObservationBenchmark.cjs");
const { measurePrototype } = require("./lib/browserObservationPrototype.cjs");
const { scratchRootSync, removeScratchSync } = require("../tests/support/scratch.cjs");

const fixture = async () => {
  const { prepareManagedBrowserTurn, executeManagedBrowserEnvelope, MANAGED_WORKSPACE_INTEGRITY_COMMAND } = require("../dist/browser/managedTurn.js");
  const root = scratchRootSync("bachata-browser-observations-");
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "small.ts"), Array.from({ length: 8 }, (_, index) => `export const retryLimit${String(index)} = 3;`).join("\n") + "\n");
    fs.writeFileSync(path.join(root, "src", "catalog.ts"), Array.from({ length: 800 }, (_, index) =>
      `export const item${String(index)} = { label: "Catalog row ${String(index)}", note: "Useful detail survives retrieval: ไทย русский", enabled: true };`).join("\n") + "\n");
    const controller = new AbortController();
    const reports = [];
    for (const scenario of ["metadata", "small-read", "large-read"]) {
      const options = {
        taskId: `observation-research-${scenario}`, originalTask: "Inspect src/catalog.ts and src/small.ts; preserve exact source and verification status.",
        role: "worker", workingDirectory: root, writeScope: "configured", readPaths: ["src"], allowedPaths: ["src"],
        protectedPaths: [], commitMode: "never", readOnly: true,
        verificationChecks: [{ id: "integrity", command: MANAGED_WORKSPACE_INTEGRITY_COMMAND }],
        maxRevisionCycles: 1, deadlineAt: Date.now() + 300_000, continuationMaxBytes: 524_288,
        handoffTotalBudgetBytes: 262_144, dependencyDepth: 1, promotionMaxBytes: 786_432, signal: controller.signal,
        executor: { timeoutMs: 30_000, terminateGraceMs: 1000, maxOutputBytes: 1_048_576, maxReadBytes: 1_048_576, maxSearchResults: 100 },
        contextIndex: { maxInventoryFiles: 100, inventoryTimeoutMs: 30_000, indexingTimeoutMs: 30_000 },
        contextSearch: { maxFiles: 100, maxBytes: 1_048_576, maxFileBytes: 1_048_576, timeoutMs: 30_000 },
      };
      const turn = await prepareManagedBrowserTurn(options);
      const records = [{ prompt: turn.prompt }];
      for (let round = 1; round < 200; round += 1) {
        const action = round % 25 === 0 ? { kind: "verification.run", checkIds: ["integrity"] }
          : scenario === "metadata" || round % 5 === 0 ? { kind: "context.readMetadata", field: "allowedPaths" }
          : { kind: "context.readFile", path: scenario === "small-read" ? "src/small.ts" : "src/catalog.ts", startLine: 1, endLine: scenario === "small-read" ? 8 : 240 };
        const envelope = { protocol: "bachata-browser-turn-v1", status: "needContext", actions: [action], summary: "Read controller evidence", objections: [], unresolved: [] };
        const result = await executeManagedBrowserEnvelope(envelope, turn, options, async (candidate) => candidate.risk === "readOnly" ? "approve" : "reject");
        if (!result.nextPrompt) throw new Error("Scripted read produced no continuation");
        if (action.kind === "context.readFile") {
          const observed = controllerPayload(result.nextPrompt).value.results[0];
          if (observed.ok !== true || !observed.snippet?.text) throw new Error(`Fixture read failed: ${JSON.stringify(observed)}`);
        }
        records.at(-1).answer = JSON.stringify(envelope);
        records.push({ prompt: result.nextPrompt });
      }
      reports.push({ scenario, ...analyzeTrajectory(records, "scripted-controller-fixture"), prototype: measurePrototype(records), inlineOncePrototype: measurePrototype(records, "inline-once") });
    }
    return reports;
  } finally {
    // The scratch helper checks the canonical, owned absolute target before recursive cleanup.
    removeScratchSync(root);
  }
};

const main = async (args = process.argv.slice(2)) => {
  const outputAt = args.indexOf("--output");
  const output = outputAt >= 0 ? args[outputAt + 1] : undefined;
  const traceAt = args.indexOf("--trace");
  const trace = traceAt >= 0 ? args[traceAt + 1] : undefined;
  if (!output || (args.includes("--fixture") === Boolean(trace))) {
    throw new Error("Use browser-observations --fixture | --trace FILE, with --output FILE");
  }
  if (trace && path.resolve(trace) === path.resolve(output)) throw new Error("Output must not overwrite the input transcript");
  const reports = trace
    ? (() => { const records = parseTrace(fs.readFileSync(trace, "utf8")); return [{ ...analyzeTrajectory(records, "recorded-prompts"), prototype: measurePrototype(records), inlineOncePrototype: measurePrototype(records, "inline-once") }]; })()
    : await fixture();
  const report = {
    schemaVersion: 1, recordedAt: new Date().toISOString(),
    revision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(__dirname, ".."), encoding: "utf8" }).stdout?.trim() || null,
    collectorSha256: Object.fromEntries(["scripts/browser-observation-benchmark.cjs", "scripts/lib/browserObservationBenchmark.cjs", "scripts/lib/browserObservationPrototype.cjs"].map((file) =>
      [file, createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", file))).digest("hex")])),
    ...(trace ? {} : { controllerBuildSha256: Object.fromEntries(["browser/managedTurn.js", "browser/controlProtocol.js", "browser/contextReferences.js", "context/taskHandoff.js"].map((file) =>
      [file, createHash("sha256").update(fs.readFileSync(path.join(__dirname, "..", "dist", file))).digest("hex")])) }),
    measurement: "UTF-8 bytes in controller prompts; not provider tokens, billed input, cache savings, latency or model quality",
    traceGrouping: "Trace mode sums recognized managed prompts; it does not infer provider sessions or retained history",
    reports,
  };
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  for (const row of reports) process.stdout.write(JSON.stringify({
    scenario: row.scenario ?? "recorded-prompts", prompts: row.prompts, promptBytes: row.promptBytes,
    observationShare: row.observationShare, largeObservationShare: row.largeObservationShare,
    repeatedObservationShare: row.repeatedObservationShare, omissionFlags: row.omissionFlags,
  }) + "\n");
};

module.exports = { main };
if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
