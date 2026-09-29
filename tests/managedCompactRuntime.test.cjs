const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { loadRuntimeHarness } = require("./support/runtimeHarness.cjs");
const { scratchRoot, removeScratch } = require("./support/scratch.cjs");
const { browserControlProtocolPrompt, browserReadOnlyControlProtocolReminder } = require("../dist/browser/controlProtocol.js");
const { captureRunSettings } = require("../dist/runtime/settingsSnapshot.js");

for (const mode of ["default", "compact", "budget", "identity", "restored", "old-restored", "provisional"]) {
  test(`real managed runtime ${mode} sends full handoffs and repairs and selects the configured result protocol`, { timeout: 180_000 }, async () => {
    const root = await scratchRoot("bachata-compact-runtime-");
    let harness;
    const prompts = [], opens = [];
    const expectedCompact = ["compact", "budget", "identity", "restored", "provisional"].includes(mode);
    const recorded = captureRunSettings((key, fallback) => key === "browserManagedCompactProtocol" ? true : fallback);
    if (mode === "old-restored") delete recorded.values.browserManagedCompactProtocol;
    const listeners = new Set();
    let current;
    const newSession = () => {
      const conversationUrl = mode === "provisional" && opens.length === 0 ? "https://chatgpt.com/" : `https://chatgpt.com/c/fixture-${opens.length}`;
      current = { id: `session-${opens.length}`, provider: "chatgpt", tabId: opens.length + 1, frameId: 0,
        documentToken: `document-${opens.length}`, conversationUrl, conversationIdentity: `chatgpt:${conversationUrl}`,
        status: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        capabilities: { submission: "native", completion: "native", interruption: "native", assets: "supported", conversationState: "confirmed" } };
      for (const listener of listeners) listener(status());
      return current;
    };
    newSession();
    const binding = () => ({ provider: current.provider, conversationUrl: current.conversationUrl, conversationIdentity: current.conversationIdentity });
    const status = () => ({ enabled: true, connected: true, sessions: [current], selectedSessionId: current.id });
    const bridge = { start: async () => {}, close: async () => {}, getStatus: status,
      subscribeStatus: (listener) => { listeners.add(listener); listener(status()); return { dispose() { listeners.delete(listener); } }; },
      bindSession: binding, bindConversation: () => {}, releaseBinding: () => {}, resolveBoundSession: () => current,
      beginBindingChange: async () => ({ commit: async () => {}, rollback: async () => {} }),
      openConversation: async (_provider, _signal, binding, fresh) => {
        if (mode === "provisional" && fresh) assert.equal(binding, undefined);
        opens.push(fresh); return newSession();
      },
    };
    try {
      await fs.mkdir(path.join(root, "src")); await fs.mkdir(path.join(root, "presets"));
      await fs.writeFile(path.join(root, "src/review.ts"), "export const value = 1;\n");
      await fs.writeFile(path.join(root, "presets/compact.pipeline.json"), JSON.stringify({
        version: 1, id: "compact-review", name: "Compact review",
        agents: [{ id: "chatgpt", name: "Reviewer", adapter: "chatgpt-browser" }],
        roles: [{ id: "reviewer", name: "Reviewer", instructions: "Read-only review", candidateAgentIds: ["chatgpt"],
          managed: true, managedRole: "worker", readOnly: true, verificationChecks: [{ id: "integrity", command: "bachata:workspace-integrity" }] }],
        managedPolicy: { writeScope: "configured", allowedPaths: ["src"], protectedPaths: [".git", ".bachata"] },
        steps: [{ id: "assign", name: "Assign", enabled: true, humanGate: "none", type: "assignRoles", roleAssignments: [{ agentId: "chatgpt", role: "reviewer" }] },
          { id: "review", name: "Review", enabled: true, humanGate: "none", type: "agent", participants: ["reviewer"], promptTemplate: "{{userPrompt}}", parallel: false, consensus: false }],
      }));
      harness = loadRuntimeHarness({ purgeCompiledModules: true, extensionRoot: root, workspaceDirectories: [root],
        runtimeOptions: { bridge, startBridge: false, closeBridge: false,
          ...(["restored", "old-restored"].includes(mode) ? { recordedRunSettings: recorded } : {}) },
        configuration: { browserManagedCompactProtocol: !["default", "restored"].includes(mode), browserManagedConversationMaxBytes: 262144,
          browserActionReadOnlyPolicy: "auto", browserSemanticInterpreterEnabled: false },
        onAdapterSend: async ({ request, agentId, sendCount }) => {
          prompts.push(request.prompt); harness.adapterControls.get(agentId).release.resolve();
          const envelope = { protocol: "bachata-browser-turn-v1", status: sendCount === 1 ? "needContext" : sendCount === 3 ? "verify" : "reviewComplete",
            actions: sendCount === 1 ? [{ kind: "context.fileVersion", path: "src/review.ts" }] : sendCount === 3 ? [{ kind: "verification.run", checkIds: ["integrity"] }] : [],
            summary: "Reviewed", objections: [], unresolved: [] };
          const code = JSON.stringify(envelope);
          if (mode === "identity" && sendCount === 2) {
            current.documentToken = "document-reloaded";
            for (const listener of listeners) listener(status());
          }
          const answer = sendCount === 2 ? "invalid control" : `${mode === "budget" && sendCount === 1 ? "x".repeat(270000) : ""}\n\`\`\`bachata-control\n${code}\n\`\`\``;
          return { answer, capturedResponse: { requestId: `request-${sendCount}`, agentId, sessionId: current.id, provider: "chatgpt", text: answer,
            segments: sendCount === 2 ? [{ type: "text", text: answer, start: 0, end: answer.length }]
              : [{ type: "codeBlock", language: "bachata-control", text: code, start: answer.indexOf(code), end: answer.indexOf(code) + code.length }],
            assets: [], captureFormat: "renderedText", fidelity: "bestEffort", finalConversationUrl: current.conversationUrl,
            finalConversationIdentity: current.conversationIdentity, finalSessionId: current.id,
            startedAt: new Date().toISOString(), completedAt: new Date().toISOString() } };
        },
      });
      await harness.runtime.handleMessage({ type: "ready" });
      const result = await harness.runtime.runPipeline("Review src/review.ts without editing files.");
      assert.equal(result.status, "completed"); assert.equal(prompts.length, 4);
      const markers = prompts.map((prompt) => /^BACHATA_REQUEST_ID:([0-9a-f-]{36})\n\n/u.exec(prompt)?.[1]);
      assert.ok(markers.every(Boolean)); assert.equal(new Set(markers).size, prompts.length);
      assert.ok(prompts[0].includes(browserControlProtocolPrompt)); assert.ok(prompts[0].includes("Bachata managed task handoff"));
      assert.ok(prompts[2].endsWith(browserControlProtocolPrompt)); assert.ok(prompts[2].includes("previous response did not contain a valid"));
      assert.ok(prompts[3].endsWith(expectedCompact ? browserReadOnlyControlProtocolReminder : browserControlProtocolPrompt));
      if (mode === "budget") {
        assert.ok(opens.length >= 2); assert.ok(opens.every(Boolean));
        assert.ok(prompts[1].includes("Bachata opened a fresh role conversation"));
        assert.ok(prompts[1].includes("Bachata managed task handoff")); assert.ok(prompts[1].endsWith(browserControlProtocolPrompt));
        assert.ok(harness.transcript.some(({ eventType, data }) => eventType === "browser.managed.conversationRollover" && data.reason === "budget"));
      } else {
        assert.ok(prompts[1].endsWith(expectedCompact ? browserReadOnlyControlProtocolReminder : browserControlProtocolPrompt));
        if (mode === "identity") {
          assert.ok(prompts[2].includes("Bachata managed task handoff"));
          assert.ok(harness.transcript.some(({ eventType, data }) => eventType === "browser.managed.conversationRollover" && data.reason === "generation"));
        }
      }
      assert.equal(await fs.readFile(path.join(root, "src/review.ts"), "utf8"), "export const value = 1;\n");
    } finally {
      if (harness) { harness.adapterControlHistory.forEach((control) => control.release.resolve()); await harness.runtime.dispose(); harness.cleanup(); }
      await removeScratch(root);
    }
  });
}
