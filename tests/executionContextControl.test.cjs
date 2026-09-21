const assert = require("node:assert/strict");
const test = require("node:test");
const { loadRuntimeHarness, deferred } = require("./support/runtimeHarness.cjs");

const setup = async (options = {}) => {
  const harness = loadRuntimeHarness({ purgeCompiledModules: true, ...options });
  await harness.runtime.handleMessage({ type: "ready" });
  await harness.runtime.configure({ pipelineId: "todo-implementation" });
  return harness;
};
const request = (harness, overrides = {}) => {
  const state = harness.runtime.getState();
  return { type: "executionContext.set", mode: "localTodoStateV1", expectedDefault: state.executionContext.defaultMode,
    pipelineId: state.selectedPipelineId, pipelineHash: state.selectedPipelineHash,
    attachmentIds: [], requestId: "context-choice", ...overrides };
};
const cleanup = async (harness) => {
  harness.adapterControls.forEach((control) => control.release.resolve());
  await harness.runtime.dispose();
  harness.cleanup();
};

test("composer setting defaults to legacy, persists once, and follows external setting changes", async () => {
  const harness = await setup();
  const messages = [];
  harness.runtime.attachWebview({ postMessage: (message) => { messages.push(message); return Promise.resolve(true); } });
  try {
    assert.deepEqual(harness.runtime.getState().executionContext, { defaultMode: "legacy", mode: "legacy", pinned: false, locked: false });
    const change = request(harness);
    await harness.runtime.handleMessage(change);
    await harness.runtime.handleMessage(change);
    assert.deepEqual(harness.configurationWrites, [{ key: "executionContextMode", value: "localTodoStateV1", target: 1 }]);
    assert.equal(harness.runtime.getState().executionContext.mode, "localTodoStateV1");
    assert.ok(messages.some((message) => message.type === "operation.result" && message.operation === "executionContext.set" && message.status === "completed"));
    harness.changeConfiguration("executionContextMode", "legacy");
    await new Promise(setImmediate);
    assert.equal(messages.filter((message) => message.type === "state.snapshot").at(-1).state.executionContext.defaultMode, "legacy");
  } finally { await cleanup(harness); }
});

for (const [scope, target] of [["workspaceValue", 2], ["workspaceFolderValue", 3]]) {
  test(`composer setting preserves ${scope} scope`, async () => {
    const harness = await setup({ configurationScopes: { executionContextMode: { [scope]: "legacy" } } });
    try {
      await harness.runtime.handleMessage(request(harness));
      assert.equal(harness.configurationWrites[0].target, target);
    } finally { await cleanup(harness); }
  });
}

test("host rejects stale setup, stale defaults, invalid payloads, and ineligible activation", async () => {
  const harness = await setup();
  try {
    await assert.rejects(harness.runtime.handleMessage(request(harness, { pipelineHash: "a".repeat(64) })), /setup changed/u);
    await assert.rejects(harness.runtime.handleMessage(request(harness, { expectedDefault: "localTodoStateV1" })), /default changed/u);
    await assert.rejects(harness.runtime.handleMessage(request(harness, { mode: "enabled" })), /Invalid/u);
    await assert.rejects(harness.runtime.handleMessage(request(harness, { extra: true })), /Invalid/u);
    await harness.runtime.configure({ pipelineId: "review-only" });
    assert.equal(harness.runtime.getState().executionContext.unavailable, "workflow");
    await assert.rejects(harness.runtime.handleMessage(request(harness)), /unavailable for this setup/u);
    assert.equal(harness.configurationWrites.length, 0);
  } finally { await cleanup(harness); }
});

test("failed persistence settles the request and keeps the saved default", async () => {
  const harness = await setup({ beforeConfigurationUpdate: () => { throw new Error("Settings are read-only"); } });
  const messages = [];
  harness.runtime.attachWebview({ postMessage: (message) => { messages.push(message); return Promise.resolve(true); } });
  try {
    await assert.rejects(harness.runtime.handleMessage(request(harness)), /read-only/u);
    assert.equal(harness.runtime.getState().executionContext.defaultMode, "legacy");
    assert.ok(messages.some((message) => message.type === "operation.result" && message.requestId === "context-choice" && message.status === "failed"));
  } finally { await cleanup(harness); }
});

test("rapid host requests serialize writes and refuse a run while its setting is being saved", async () => {
  const entered = deferred();
  const release = deferred();
  const harness = await setup({ beforeConfigurationUpdate: async () => { entered.resolve(); await release.promise; } });
  try {
    const first = harness.runtime.handleMessage(request(harness));
    await entered.promise;
    const second = harness.runtime.handleMessage(request(harness, { mode: "legacy", expectedDefault: "localTodoStateV1", requestId: "off" }));
    await assert.rejects(harness.runtime.preflightPipeline("Start", []), /operation is active/u);
    assert.equal(harness.configurationWrites.length, 1);
    release.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(harness.configurationWrites.map((item) => item.value), ["localTodoStateV1", "legacy"]);
  } finally { release.resolve(); await cleanup(harness); }
});

test("recorded replay mode stays locked while a changed default remains visible", async () => {
  const { captureRunSettings } = require("../dist/runtime/settingsSnapshot.js");
  const recordedRunSettings = captureRunSettings((key, fallback) => key === "executionContextMode" ? "localTodoStateV1" : fallback);
  const harness = await setup({ runtimeOptions: { recordedRunSettings } });
  try {
    assert.deepEqual(harness.runtime.getState().executionContext, { defaultMode: "legacy", mode: "localTodoStateV1", pinned: true, locked: true });
    await assert.rejects(harness.runtime.handleMessage(request(harness, { mode: "legacy" })), /new run/u);
    assert.equal(recordedRunSettings.values.executionContextMode, "localTodoStateV1");
    assert.equal(harness.configurationWrites.length, 0);
  } finally { await cleanup(harness); }
});

test("one eligibility rule checks serial shape, every assigned provider, workspace and attachments", async () => {
  const harness = await setup();
  try {
    const { executionContextUnavailable } = require("../dist/runtime/executionContextEligibility.js");
    const pipeline = harness.runtime.getState().selectedPipelineDefinition;
    assert.equal(executionContextUnavailable(pipeline, true, 0), undefined);
    assert.equal(executionContextUnavailable(pipeline, false, 0), "workspace");
    assert.equal(executionContextUnavailable(pipeline, true, 1), "attachments");
    for (const mutate of [
      (copy) => { copy.steps[1].parallel = true; },
      (copy) => { copy.steps[1].consensus = { mode: "unanimous", maxRounds: 2 }; },
      (copy) => { copy.steps[1].humanGate = "after"; },
      (copy) => { copy.steps[1].enabled = false; },
      (copy) => { copy.steps[0].enabled = false; },
      (copy) => { copy.steps[2].participants = ["worker", "reviewer"]; },
    ]) {
      const copy = structuredClone(pipeline);
      mutate(copy);
      assert.equal(executionContextUnavailable(copy, true, 0), "workflow");
    }
    for (const adapter of ["chatgpt-browser", "claude-browser", "zai-glm", "generic-browser"]) {
      const copy = structuredClone(pipeline);
      copy.agents[0].adapter = adapter;
      assert.equal(executionContextUnavailable(copy, true, 0), "providers");
    }
  } finally { await cleanup(harness); }
});

test("selected attachments prevent activation without erasing the saved default", async () => {
  const harness = await setup({ configuration: { executionContextMode: "localTodoStateV1" },
    saveAttachment: async (input) => ({ id: "spec", taskId: input.taskId, name: input.name, mimeType: input.mimeType, size: 4, path: "spec.txt", createdAt: new Date().toISOString() }) });
  try {
    await harness.runtime.handleMessage({ type: "attachment.add", taskId: harness.runtime.getState().taskId,
      clientId: "context-attachment", name: "spec.txt", mimeType: "text/plain", dataBase64: "c3BlYw==" });
    const attachmentIds = harness.runtime.getState().attachments.map((attachment) => attachment.id);
    assert.equal(attachmentIds.length, 1);
    await assert.rejects(harness.runtime.handleMessage(request(harness, { attachmentIds })), /unavailable for this setup/u);
    assert.equal(harness.configuration.get("executionContextMode"), "localTodoStateV1");
    assert.equal(harness.configurationWrites.length, 0);
  } finally { await cleanup(harness); }
});

test("a new ineligible run pins legacy while the saved efficient default stays on", async () => {
  const requests = [];
  const harness = await setup({ configuration: { executionContextMode: "localTodoStateV1" },
    onAdapterSend: ({ request: turn }) => { requests.push(turn); throw new Error("Keep recovery for inspection"); } });
  try {
    await harness.runtime.configure({ pipelineId: "review-only" });
    await assert.rejects(harness.runtime.runPipeline("Review the files", []), /Keep recovery for inspection/u);
    assert.ok(requests.length > 0);
    assert.ok(requests.every((turn) => turn.sessionMode !== "freshExecutionState"));
    assert.equal(harness.configuration.get("executionContextMode"), "localTodoStateV1");
    assert.equal(harness.runtime.getState().executionContext.mode, "legacy");
    const records = [...harness.workspaceState.values()].filter((item) => item?.resumableWorkflow?.runSettings);
    assert.ok(records.length > 0);
    assert.equal(records[0].resumableWorkflow.runSettings.values.executionContextMode, "legacy");
  } finally { await cleanup(harness); }
});

for (const record of ["legacy", "localTodoStateV1", "old-setting", "old-snapshot"]) {
  const recordedMode = record === "localTodoStateV1" ? record : "legacy";
  test(`reloaded recovery keeps ${record} after default changes and refuses composer writes`, async () => {
    const harness = await setup({ configuration: { executionContextMode: recordedMode },
      onAdapterSend: () => { throw new Error("Provider stopped"); } });
    let recovered;
    try {
      require("node:fs").mkdirSync(require("node:path").join(harness.workspaceDirectory, "src"));
      await assert.rejects(harness.runtime.runPipeline("Implement src/feature.txt", [], { allowedPaths: ["src"], writeScope: "configured" }), /Provider stopped/u);
      assert.equal(harness.runtime.getState().executionContext.mode, recordedMode);
      const initialWorkspaceState = structuredClone(Object.fromEntries(harness.workspaceState));
      for (const value of Object.values(initialWorkspaceState)) {
        if (!value?.resumableWorkflow) continue;
        if (record === "old-snapshot") delete value.resumableWorkflow.runSettings;
        if (record === "old-setting") delete value.resumableWorkflow.runSettings.values.executionContextMode;
      }
      await harness.runtime.dispose();
      recovered = loadRuntimeHarness({ purgeCompiledModules: true,
        storageDirectory: harness.storageDirectory,
        workspaceDirectories: [harness.workspaceDirectory],
        initialWorkspaceState,
        onAdapterSend: ({ request: turn }) => {
          assert.equal(recovered.runtime.getState().executionContext.mode, recordedMode);
          assert.equal(turn.sessionMode, recordedMode === "localTodoStateV1" ? "freshExecutionState" : undefined);
          throw new Error("Restart reached pinned provider");
        },
        configuration: { executionContextMode: recordedMode === "legacy" ? "localTodoStateV1" : "legacy" },
      });
      await recovered.runtime.handleMessage({ type: "ready" });
      assert.ok(recovered.runtime.getState().resumableWorkflow);
      const context = recovered.runtime.getState().executionContext;
      assert.equal(context.mode, recordedMode);
      assert.equal(context.pinned, true);
      assert.equal(context.locked, true);
      await assert.rejects(recovered.runtime.handleMessage(request(recovered, { mode: context.defaultMode })), /new run/iu);
      assert.equal(recovered.configurationWrites.length, 0);
      await assert.rejects(recovered.runtime.restartPipeline(), /Restart reached pinned provider/u);
      assert.equal(recovered.runtime.getState().executionContext.mode, recordedMode);
    } finally {
      if (recovered) await cleanup(recovered);
      await cleanup(harness);
    }
  });
}
