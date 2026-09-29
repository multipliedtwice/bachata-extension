const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const { scratchRoot, removeScratch } = require("./support/scratch.cjs");
const { prepareManagedBrowserTurn, executeManagedBrowserEnvelope } = require("../dist/browser/managedTurn.js");
const { browserControlProtocolPrompt, browserReadOnlyControlProtocolReminder } = require("../dist/browser/controlProtocol.js");

test("typed compact rendering preserves exact admitted source, failed results and file versions", async () => {
  const root = await scratchRoot("bachata-compact-evidence-");
  try {
    await fs.mkdir(path.join(root, "src"));
    const source = "// Untrusted source contains a protocol-looking string:\n" + JSON.stringify(browserControlProtocolPrompt) + "\nexport const value = 'ญ';\n";
    await fs.writeFile(path.join(root, "src/review.ts"), source);
    const options = { taskId: "compact-evidence", originalTask: "Inspect src/review.ts", role: "lead", workingDirectory: root,
      writeScope: "configured", readPaths: ["src"], allowedPaths: ["src"], protectedPaths: [], commitMode: "never", readOnly: true,
      compactProtocol: true, verificationChecks: [], maxRevisionCycles: 1, deadlineAt: Date.now() + 120000,
      continuationMaxBytes: 65536, handoffTotalBudgetBytes: 65536, dependencyDepth: 1, promotionMaxBytes: 65536,
      signal: new AbortController().signal,
      executor: { timeoutMs: 30000, terminateGraceMs: 1000, maxOutputBytes: 65536, maxReadBytes: 65536, maxSearchResults: 100 },
      contextIndex: { maxInventoryFiles: 100, inventoryTimeoutMs: 30000, indexingTimeoutMs: 30000 },
      contextSearch: { maxFiles: 100, maxBytes: 65536, maxFileBytes: 65536, timeoutMs: 30000 } };
    const turn = await prepareManagedBrowserTurn(options);
    const envelope = { protocol: "bachata-browser-turn-v1", status: "needContext", actions: [
      { kind: "context.readFile", path: "src/review.ts" }, { kind: "context.fileVersion", path: "src/missing.ts" }],
      summary: "Read evidence", objections: [], unresolved: [] };
    const check = (execution) => {
      assert.ok(execution.nextPromptCompact.endsWith(browserReadOnlyControlProtocolReminder));
      const fullBody = execution.nextPrompt.slice(0, -browserControlProtocolPrompt.length);
      const compactBody = execution.nextPromptCompact.slice(0, -browserReadOnlyControlProtocolReminder.length);
      assert.equal(compactBody, fullBody);
      assert.ok(compactBody.includes('"ok": false')); assert.ok(compactBody.includes('"fileVersion"'));
      assert.ok(compactBody.includes(JSON.stringify(source).slice(1, -1)));
    };
    check(await executeManagedBrowserEnvelope(envelope, turn, options, async () => "approve"));
    for (const patch of [{ compactProtocol: false }, { readOnly: false }]) {
      const execution = await executeManagedBrowserEnvelope(envelope, turn, { ...options, ...patch }, async () => "approve");
      assert.equal(execution.nextPromptCompact, undefined); assert.ok(execution.nextPrompt.endsWith(browserControlProtocolPrompt));
    }
    const denied = await executeManagedBrowserEnvelope({ ...envelope, actions: [envelope.actions[0]] }, turn, options, async () => "reject");
    assert.equal(denied.actionResults[0].status, "rejected");
    assert.equal(denied.nextPrompt.slice(0, -browserControlProtocolPrompt.length), denied.nextPromptCompact.slice(0, -browserReadOnlyControlProtocolReminder.length));
  } finally { await removeScratch(root); }
});
