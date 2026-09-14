const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { loadRuntimeHarness, purgeCompiledModules } = require("./support/runtimeHarness.cjs");
const { scratchRootSync, removeScratchSync } = require("./support/scratch.cjs");

const step = (id) => ({
  id,
  name: "Review",
  enabled: true,
  type: "agent",
  participants: ["codex"],
  promptTemplate: "{{userPrompt}}",
  parallel: false,
  consensus: false,
  humanGate: "none",
});

const withPipeline = async (steps, respond, check) => {
  const extensionRoot = scratchRootSync("bachata-transcript-steps-");
  fs.mkdirSync(path.join(extensionRoot, "presets"));
  fs.writeFileSync(path.join(extensionRoot, "presets", "review.pipeline.json"), JSON.stringify({
    version: 1,
    id: "recorded-step-review",
    name: "Recorded step review",
    agents: [{ id: "codex", name: "Reviewer", adapter: "codex-app-server", permissionMode: "readOnly" }],
    steps,
  }));
  let harness;
  harness = loadRuntimeHarness({
    extensionRoot,
    purgeCompiledModules: true,
    onAdapterSend: async (input) => {
      harness.adapterControls.get(input.agentId).release.resolve();
      return respond(input);
    },
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await check(harness);
  } finally {
    harness.adapterControlHistory.forEach((control) => control.release.resolve());
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
};

test("participant answers preserve exact step IDs when recorded names are identical", async () => {
  await withPipeline([step("initial-review"), step("followup-review")], async ({ sendCount }) => ({
    answer: `Assessment ${sendCount}`,
  }), async ({ runtime }) => {
    await runtime.runPipeline("Review the change");
    const answers = runtime.getState().transcript.filter((entry) => entry.kind === "answer");
    assert.deepEqual(answers.map(({ stepId, step: name, text }) => ({ stepId, name, text })), [
      { stepId: "initial-review", name: "Review", text: "Assessment 1" },
      { stepId: "followup-review", name: "Review", text: "Assessment 2" },
    ]);
    assert.notEqual(answers[0].id, answers[1].id);
  });
});

test("provider interruption retains the step that requested the participant", async () => {
  await withPipeline([step("interrupted-review")], async () => ({
    status: "interrupted",
    answer: "Review stopped before the remaining files",
  }), async ({ runtime }) => {
    const result = await runtime.runPipeline("Review the change");
    assert.equal(result.status, "interrupted");
    const response = runtime.getState().transcript.find((entry) => entry.kind === "interrupted" && entry.agentId === "codex");
    assert.ok(response);
    assert.equal(response.stepId, "interrupted-review");
    assert.equal(response.step, "Review");
    assert.match(response.text, /Review stopped/);
  });
});

test("participant errors retain their requesting step without attributing the run error", async () => {
  await withPipeline([step("failed-review")], async () => {
    throw new Error("The provider could not complete its review");
  }, async ({ runtime }) => {
    await assert.rejects(runtime.runPipeline("Review the change"), /provider could not complete/);
    const errors = runtime.getState().transcript.filter((entry) => entry.kind === "error");
    const response = errors.find((entry) => entry.agentId === "codex");
    assert.ok(response);
    assert.equal(response.stepId, "failed-review");
    assert.equal(response.step, "Review");
    assert.ok(errors.filter((entry) => !entry.agentId).every((entry) => entry.stepId === undefined));
  });
});

test("a user stop records the participant request step when aborting raises an exception", { timeout: 15000 }, async () => {
  await withPipeline([step("stopped-review")], async ({ signal }) => {
    await new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", resolve, { once: true });
    });
    throw new Error("Stream closed after user stop");
  }, async ({ runtime, adapterControls }) => {
    const running = runtime.runPipeline("Review the change");
    await adapterControls.get("codex").started.promise;
    await runtime.handleMessage({ type: "run.interrupt", agentId: "codex" });
    await running;
    const response = runtime.getState().transcript.find((entry) => entry.kind === "interrupted" && entry.agentId === "codex");
    assert.ok(response);
    assert.equal(response.stepId, "stopped-review");
    assert.equal(response.text, "Stopped by you");
    assert.equal(runtime.getState().transcript.some((entry) => entry.kind === "error"), false);
  });
});

test("a direct message outside a pipeline gate has no inferred step association", async () => {
  await withPipeline([step("selected-review")], async () => ({ answer: "Independent answer" }), async ({ runtime }) => {
    await runtime.handleMessage({
      type: "message.send",
      recipients: ["codex"],
      prompt: "Answer separately",
      mode: "review",
      attachmentIds: [],
      delivery: "immediate",
    });
    const response = runtime.getState().transcript.find((entry) => entry.kind === "answer");
    assert.ok(response);
    assert.equal(response.stepId, undefined);
    assert.equal(response.step, undefined);
  });
});

test("a direct intervention records the pipeline gate that received the request", { timeout: 15000 }, async () => {
  await withPipeline([{ ...step("gate-review"), humanGate: "after" }], async ({ sendCount }) => ({
    answer: sendCount === 1 ? "Initial review" : "Intervention assessment",
  }), async ({ runtime }) => {
    const running = runtime.handleMessage({ type: "pipeline.run", prompt: "Review the change", attachmentIds: [] });
    for (let attempt = 0; !runtime.getState().pendingGate && attempt < 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(runtime.getState().pendingGate?.stepId, "gate-review");
    await runtime.handleMessage({
      type: "message.send",
      recipients: ["codex"],
      prompt: "Check the unresolved finding",
      mode: "review",
      attachmentIds: [],
      delivery: "immediate",
    });
    const response = runtime.getState().transcript.find((entry) => entry.kind === "answer" && entry.text === "Intervention assessment");
    assert.ok(response);
    assert.equal(response.stepId, "gate-review");
    assert.equal(response.step, "Review");
    const event = runtime.getState().transcript.find((entry) => entry.eventType === "gate.intervention");
    assert.ok(event);
    assert.equal(event.stepId, "gate-review");
    await runtime.handleMessage({ type: "run.gate", action: "cancel" });
    await running;
  });
});

test("transcript step IDs survive parsing, byte accounting and persisted reloads", async () => {
  const root = path.resolve(__dirname, "..");
  const directory = scratchRootSync("bachata-transcript-step-store-");
  const filePath = path.join(directory, "transcript.jsonl");
  let store;
  let reloaded;
  const original = {
    id: "response-one",
    kind: "answer",
    agentId: "codex",
    step: "Review",
    stepId: "recorded-review",
    text: "Review completed",
    createdAt: "2026-09-14T00:00:00.000Z",
  };
  purgeCompiledModules(root);
  try {
    const { parseTranscriptEntry } = require("../dist/webview/protocol.js");
    const { boundedTranscriptEntry, transcriptEntryBytes } = require("../dist/state/transcriptBounds.js");
    const { createTranscriptStore } = require("../dist/state/transcriptStore.js");
    store = createTranscriptStore(directory, () => undefined);
    assert.equal(store.filePath, filePath);
    assert.equal(fs.existsSync(filePath), false);
    assert.deepEqual(await store.load(), []);
    const bounded = boundedTranscriptEntry(parseTranscriptEntry(original));
    assert.equal(bounded.stepId, "recorded-review");
    assert.equal(transcriptEntryBytes(bounded), Buffer.byteLength(JSON.stringify(bounded), "utf8"));
    await store.append(bounded);
    await store.flush();
    assert.deepEqual(await store.load(), [bounded]);
    assert.deepEqual(fs.readFileSync(filePath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line)), [bounded]);
    purgeCompiledModules(root);
    const { createTranscriptStore: reloadTranscriptStore } = require("../dist/state/transcriptStore.js");
    reloaded = reloadTranscriptStore(directory, () => undefined);
    assert.equal(reloaded.filePath, filePath);
    assert.deepEqual(await reloaded.load(), [bounded]);
    await reloaded.flush();
  } finally {
    try {
      await Promise.all([store?.flush(), reloaded?.flush()]);
    } finally {
      purgeCompiledModules(root);
      removeScratchSync(directory);
    }
  }
});

test("legacy transcript entries keep their recorded name without inventing an ID", () => {
  const { parseTranscriptEntry } = require("../dist/webview/protocol.js");
  const { boundedTranscriptEntry } = require("../dist/state/transcriptBounds.js");
  const original = {
    id: "legacy-response",
    kind: "answer",
    step: "Review",
    text: "Recorded review",
    createdAt: "2026-09-14T00:00:00.000Z",
  };
  const parsed = boundedTranscriptEntry(parseTranscriptEntry(original));
  assert.equal(parsed.step, "Review");
  assert.equal(parsed.stepId, undefined);
  for (const stepId of ["", " ", 123, null, {}]) {
    assert.equal(parseTranscriptEntry({ ...original, stepId }).stepId, undefined);
  }
});

test("oversized transcript step IDs obey the metadata bound", () => {
  const { boundedTranscriptEntry, TRANSCRIPT_STEP_BYTES } = require("../dist/state/transcriptBounds.js");
  const bounded = boundedTranscriptEntry({
    id: "long-step-response",
    kind: "answer",
    stepId: "s".repeat(10000),
    text: "Review completed",
    createdAt: "2026-09-14T00:00:00.000Z",
  });
  assert.ok(Buffer.byteLength(bounded.stepId, "utf8") <= TRANSCRIPT_STEP_BYTES);
});
