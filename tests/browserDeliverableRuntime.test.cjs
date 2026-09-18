const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { loadRuntimeHarness } = require("./support/runtimeHarness.cjs");

const session = { id: "browser-session", provider: "chatgpt", tabId: 1, frameId: 0, documentToken: "document-token", conversationUrl: "https://chatgpt.com/c/retry-review", conversationIdentity: "retry-review", status: "ready", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), capabilities: { submission: "verifiedSend", completion: "verifiedLifecycle", interruption: "confirmed", assets: "supported", conversationState: "confirmed" } };
const binding = { provider: session.provider, conversationUrl: session.conversationUrl, conversationIdentity: session.conversationIdentity };
const bridge = {
  start: async () => {}, close: async () => {},
  getStatus: () => ({ enabled: true, connected: true, sessions: [session], selectedSessionId: session.id }),
  subscribeStatus: (listener) => { listener({ enabled: true, connected: true, sessions: [session], selectedSessionId: session.id }); return { dispose() {} }; },
  bindSession: () => binding, bindConversation: () => {}, releaseBinding: () => {},
  resolveBoundSession: () => session, openConversation: async () => session,
  fetchAsset: async function* () { throw new Error("No download expected"); },
};
const captured = (text, turn) => ({ requestId: `request-${turn}`, agentId: "chatgpt", sessionId: session.id, provider: session.provider, text, segments: [{ type: "text", text, start: 0, end: text.length }], assets: [], captureFormat: "renderedText", fidelity: "bestEffort", finalConversationUrl: session.conversationUrl, finalConversationIdentity: session.conversationIdentity, finalSessionId: session.id, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
const definition = (lead = false) => ({
  version: 1, id: "cross-reference-development", name: "Review retry behavior",
  agents: [{ id: "chatgpt", name: "Reviewer", adapter: "chatgpt-browser" }],
  ...(lead ? { roles: [{ id: "lead", name: "Lead", instructions: "Review retry handling", candidateAgentIds: ["chatgpt"], managed: true, managedOptional: true, managedRole: "lead", readOnly: true, verificationChecks: [{ id: "integrity", command: "bachata:workspace-integrity" }] }] } : {}),
  steps: [...(lead ? [{ id: "assign", name: "Assign reviewer", enabled: true, humanGate: "none", type: "assignRoles", roleAssignments: [{ agentId: "chatgpt", role: "lead" }] }] : []), { id: "review", name: "Review retry behavior", enabled: true, participants: [lead ? "lead" : "chatgpt"], promptTemplate: "{{userPrompt}}", parallel: false, consensus: false, humanGate: "none", type: "agent" }],
});

for (const variant of ["issued", "unissued", "stale", "unresolved-deliverable", "source-deliverable"]) {
// Windows runs every child through a Job Object host, so a git call that takes milliseconds
// elsewhere costs the better part of a second there. The budget is a fixture value, not the
// behaviour under test, so it is scaled rather than letting the platform's process cost decide
// whether an action was refused.
const slowPlatformFactor = process.platform === "win32" ? 6 : 1;

  test(`runtime programmatic browser ${variant} preserves contracts and terminal classification`, { timeout: 15000 * slowPlatformFactor }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "bachata-browser-runtime-"));
    await fs.mkdir(path.join(root, "presets"));
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src/retry.ts"), "export const retryCount = 2;\n");
    await fs.writeFile(path.join(root, "presets/review.pipeline.json"), JSON.stringify(definition(!variant.endsWith("deliverable"))));
    let harness;
    const prompts = [];
    harness = loadRuntimeHarness({
      purgeCompiledModules: true, extensionRoot: root, workspaceDirectories: [root],
      runtimeOptions: { bridge, startBridge: false, closeBridge: false },
      configuration: { browserActionReadOnlyPolicy: "auto", browserActionMutationPolicy: "auto", browserSemanticInterpreterEnabled: false },
      onAdapterSend: async ({ request, agentId, sendCount }) => {
        prompts.push(request.prompt);
        harness.adapterControls.get(agentId).release.resolve();
        let answer;
        if (variant === "source-deliverable") answer = sendCount === 1 ? "diff --git a/src/guard.ts b/src/guard.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/guard.ts\n@@ -0,0 +1 @@\n+export const stopPending = false;\n" : "The stop guard source is installed.";
        else if (variant === "unresolved-deliverable") answer = sendCount === 1 ? "[Updated sources](sandbox:/tmp/source.zip)" : "The work is complete.";
        else {
          assert.match(request.prompt, /Bachata managed review contract/);
          assert.match(request.prompt, /Bachata browser fallback workspace protocol/);
          assert.ok(!request.prompt.includes(root), "controller prompt leaked the absolute workspace");
          const candidate = /^Candidate: (candidate-[a-f0-9-]+)$/mu.exec(request.prompt)?.[1];
          assert.ok(candidate, request.prompt);
          if (variant === "stale") await fs.writeFile(path.join(root, "src/retry.ts"), "export const unrelatedEdit = true;\n");
          answer = JSON.stringify({ candidate: variant === "unissued" ? "candidate-unissued" : candidate, review: { verdict: "accept", summary: "Retry guard is correct", defects: [] } });
        }
        return { answer, capturedResponse: captured(answer, sendCount) };
      },
    });
    try {
      await harness.runtime.handleMessage({ type: "ready" });
      let result;
      if (variant === "issued" || variant === "source-deliverable") result = await harness.runtime.runPipeline("Review retry handling and preserve unrelated changes.");
      else await assert.rejects(harness.runtime.runPipeline("Review retry handling and preserve unrelated changes."), variant === "unresolved-deliverable" ? /deliverable remains unresolved/ : /Managed Lead did not return a usable review verdict/);
      assert.ok(prompts.length > 0, JSON.stringify(harness.runtime.getState().agents));
      if (variant === "source-deliverable") {
        assert.equal(result.status, "completed");
        assert.equal(await fs.readFile(path.join(root, "src/guard.ts"), "utf8"), "export const stopPending = false;\n");
        assert.equal(await fs.readFile(path.join(root, "src/retry.ts"), "utf8"), "export const retryCount = 2;\n");
        assert.equal(prompts.length, 2);
      } else if (variant === "issued") {
        assert.equal(result.status, "completed", JSON.stringify(result));
        assert.ok(harness.transcript.some((entry) => entry.eventType === "review.managedLead" && entry.data.decision === "accept"));
      } else {
        assert.equal(harness.runtime.getState().workflowStatus, "error");
        if (variant === "unresolved-deliverable") {
          assert.equal(prompts.length, 3);
          assert.match(prompts[1], /not captured as a downloadable asset/);
          assert.match(prompts[2], /still unresolved/);
        }
      }
    } finally {
      harness.adapterControlHistory.forEach((control) => control.release.resolve());
      await harness.runtime.dispose(); harness.cleanup();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
