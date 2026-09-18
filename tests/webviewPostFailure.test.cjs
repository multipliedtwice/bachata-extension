const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
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

test("a webview that keeps refusing posts is logged once per distinct failure", async () => {
  const extensionRoot = scratchRootSync("bachata-post-failure-extension-");
  fs.mkdirSync(path.join(extensionRoot, "presets"), { recursive: true });
  fs.writeFileSync(
    path.join(extensionRoot, "presets", "cross-reference.pipeline.json"),
    JSON.stringify(definition("cross-reference-development", "Current pipeline")),
  );
  const harness = loadRuntimeHarness({ extensionRoot });
  let failure = "Shared-resource lease ownership was replaced or expired";
  let refuse = true;
  const attached = harness.runtime.attachWebview({
    postMessage: async () => {
      if (refuse) throw new Error(failure);
      return true;
    },
  });
  const posts = () => harness.outputLines.filter((line) => line.startsWith("Failed to post webview message:")).length;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  try {
    await harness.runtime.handleMessage({ type: "ready" });
    await harness.runtime.handleMessage({ type: "ready" });
    await settle();
    assert.equal(posts(), 1);
    failure = "A different failure";
    await harness.runtime.handleMessage({ type: "ready" });
    await settle();
    assert.equal(posts(), 2);
    refuse = false;
    await harness.runtime.handleMessage({ type: "ready" });
    await settle();
    refuse = true;
    await harness.runtime.handleMessage({ type: "ready" });
    await settle();
    assert.equal(posts(), 3, "a failure after a successful post was not reported again");
  } finally {
    attached.dispose();
    await harness.runtime.dispose();
    harness.cleanup();
    removeScratchSync(extensionRoot);
  }
});
