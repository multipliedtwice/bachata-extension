const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { createPipelineSnapshot } = require("../dist/pipeline/identity.js");
const { removeScratchSync, scratchRootSync } = require("./support/scratch.cjs");
const { loadRuntimeHarness } = require("./support/runtimeHarness.cjs");

const definition = (id, name) => ({
  version: 1,
  id,
  name,
  agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server" }],
  steps: [{
    id: "work",
    name: "Work",
    enabled: true,
    participants: ["codex"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    humanGate: "none",
    type: "agent",
  }],
});

test("a run whose pipeline left the catalog keeps its recorded copy and says so", async () => {
  const extensionRoot = scratchRootSync("bachata-removed-pipeline-extension-");
  const workspace = scratchRootSync("bachata-removed-pipeline-workspace-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "cross-reference.pipeline.json"),
    JSON.stringify(definition("cross-reference-development", "Current pipeline")),
  );
  const retired = definition("retired-review", "Retired review");
  const harness = loadRuntimeHarness({
    extensionRoot,
    workspaceDirectories: [workspace],
    initialWorkspaceState: {
      "bachata.runtimeState.v5": {
        taskDirty: true,
        selectedPipelineId: retired.id,
        selectedPipelineSnapshot: createPipelineSnapshot(retired, "builtin"),
        attachments: [],
      },
    },
    onCommandCheck: ({ command }) => `${command} mock-1.0.0`,
  });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    const state = harness.runtime.getState();
    assert.equal(state.selectedPipelineId, "retired-review");
    assert.equal(state.selectedPipelineRemoved, true);
    assert.equal(state.selectedPipelineDefinition.name, "Retired review");
    assert.equal(state.pipelines.some((pipeline) => pipeline.id === "retired-review"), false);
    assert.equal(
      state.readiness.findings.some((finding) => finding.id === "pipeline"),
      false,
      "readiness asked for a pipeline the run already has",
    );
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(workspace);
    removeScratchSync(extensionRoot);
  }
});

test("a pipeline still in the catalog is not reported as removed", async () => {
  const extensionRoot = scratchRootSync("bachata-current-pipeline-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  const current = definition("cross-reference-development", "Current pipeline");
  fs.writeFileSync(path.join(extensionRoot, "presets", "cross-reference.pipeline.json"), JSON.stringify(current));
  const harness = loadRuntimeHarness({ extensionRoot });
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    assert.equal(harness.runtime.getState().selectedPipelineRemoved, undefined);
  } finally {
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});
