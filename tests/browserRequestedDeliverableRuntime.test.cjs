const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { crc32 } = require('node:zlib');
const { loadRuntimeHarness } = require('./support/runtimeHarness.cjs');
const { scratchRoot, removeScratch } = require('./support/scratch.cjs');

const sourceZip = (text) => {
  const name = Buffer.from('note.md'), data = Buffer.from(text), checksum = crc32(data);
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
  local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
};

for (const format of ['markdown', 'diff', 'zip', 'listing', 'missing', 'uncaptured']) {
  test(`runtime binds the requested ${format} deliverable to controller execution`, { timeout: 180000 }, async () => {
    const root = await scratchRoot('bachata-deliverable-runtime-');
    let harness;
    const prompts = [];
    const original = '# Before\n', updated = '# After\n\n\u0e0d \u043f\u0440\u0438\u0432\u0435\u0442\n';
    const archive = sourceZip(updated);
    const requirement = { format: ['missing', 'uncaptured'].includes(format) ? 'listing' : format, paths: ['note.md'] };
    const session = { id: 'session', provider: 'chatgpt', tabId: 1, frameId: 0, documentToken: 'document',
      conversationUrl: 'https://chatgpt.com/c/deliverable', conversationIdentity: 'chatgpt:deliverable', status: 'ready',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      capabilities: { submission: 'native', completion: 'native', interruption: 'native', assets: 'supported', conversationState: 'confirmed' } };
    const binding = () => ({ provider: session.provider, conversationUrl: session.conversationUrl, conversationIdentity: session.conversationIdentity });
    const status = () => ({ enabled: true, connected: true, sessions: [session], selectedSessionId: session.id });
    const bridge = { start: async () => {}, close: async () => {}, getStatus: status,
      subscribeStatus: (listener) => { listener(status()); return { dispose() {} }; }, bindSession: binding,
      bindConversation: () => {}, releaseBinding: () => {}, resolveBoundSession: () => session,
      beginBindingChange: async () => ({ commit: async () => {}, rollback: async () => {} }), openConversation: async () => session,
      fetchAsset: async function* (assetId) {
        yield { type: 'start', assetId, name: 'source.zip', size: archive.length };
        yield { type: 'chunk', assetId, sequence: 0, data: archive };
        yield { type: 'complete', assetId, size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') };
      } };
    const capture = (parts, agentId, sendCount) => {
      let offset = 0;
      const segments = parts.map((part) => { const start = offset; offset += part.text.length; return { ...part, start, end: offset }; });
      return { requestId: `request-${sendCount}`, agentId, sessionId: session.id, provider: session.provider,
        text: segments.map(({ text }) => text).join(''), segments, assets: [], captureFormat: 'renderedText', fidelity: 'bestEffort',
        finalConversationUrl: session.conversationUrl, finalConversationIdentity: session.conversationIdentity, finalSessionId: session.id,
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
    };
    try {
      await fs.mkdir(path.join(root, 'presets'));
      await fs.writeFile(path.join(root, 'note.md'), original);
      await fs.writeFile(path.join(root, 'presets/deliverable.pipeline.json'), JSON.stringify({ version: 1, id: 'deliverable', name: 'Deliverable',
        agents: [{ id: 'chatgpt', name: 'Builder', adapter: 'chatgpt-browser' }],
        roles: [{ id: 'worker', name: 'Worker', instructions: 'Deliver the requested representation', candidateAgentIds: ['chatgpt'],
          managed: true, managedRole: 'worker', readOnly: ['listing', 'missing', 'uncaptured'].includes(format),
          verificationChecks: [{ id: 'integrity', command: 'bachata:workspace-integrity' }] }],
        managedPolicy: { writeScope: 'configured', allowedPaths: ['note.md'], protectedPaths: ['.git', '.bachata'] },
        steps: [{ id: 'assign', name: 'Assign', enabled: true, humanGate: 'none', type: 'assignRoles', roleAssignments: [{ agentId: 'chatgpt', role: 'worker' }] },
          { id: 'deliver', name: 'Deliver', enabled: true, humanGate: 'none', type: 'agent', participants: ['worker'], promptTemplate: '{{userPrompt}}',
            parallel: false, consensus: false, browserDeliverable: requirement }] }));
      harness = loadRuntimeHarness({ purgeCompiledModules: true, extensionRoot: root, workspaceDirectories: [root],
        runtimeOptions: { bridge, startBridge: false, closeBridge: false },
        configuration: { browserActionReadOnlyPolicy: 'auto', managedBrowserAutoApprove: true, browserSemanticInterpreterEnabled: false },
        onAdapterSend: async ({ request, agentId, sendCount }) => {
          prompts.push(request.prompt); harness.adapterControls.get(agentId).release.resolve();
          if (format === 'uncaptured') return { answer: 'FILE note.md\n' };
          let parts;
          if (sendCount === 2 && format !== 'missing') {
            parts = format === 'zip' ? [{ type: 'text', text: 'Attached source.' }]
              : format === 'listing' ? [{ type: 'text', text: 'FILE note.md\n' }]
              : format === 'markdown' ? [{ type: 'text', text: 'FILE note.md\n' }, { type: 'codeBlock', language: 'markdown', text: updated }]
              : [{ type: 'text', text: 'PATCH note.md\n' }, { type: 'codeBlock', language: 'diff',
                text: 'diff --git a/note.md b/note.md\n--- a/note.md\n+++ b/note.md\n@@ -1 +1 @@\n-# Before\n+# After' }];
          } else {
            const envelope = { protocol: 'bachata-browser-turn-v1', status: sendCount === 1 ? 'needContext' : sendCount === 3 ? 'verify' : 'reviewComplete',
              actions: sendCount === 1 ? [{ kind: 'context.fileVersion', path: 'note.md' }] : sendCount === 3 ? [{ kind: 'verification.run', checkIds: ['integrity'] }] : [],
              summary: 'Done', objections: [], unresolved: [] };
            parts = [{ type: 'codeBlock', language: 'bachata-control', text: JSON.stringify(envelope) }];
          }
          const capturedResponse = capture(parts, agentId, sendCount);
          if (sendCount === 2 && format === 'zip') capturedResponse.assets = [{ id: 'archive', name: 'source.zip', size: archive.length,
            provider: session.provider, kind: 'generatedFile', sourceElement: 'assistantMessage', downloadAvailable: true }];
          return { answer: capturedResponse.text, capturedResponse };
        } });
      await harness.runtime.handleMessage({ type: 'ready' });
      if (['missing', 'uncaptured'].includes(format)) {
        await assert.rejects(harness.runtime.runPipeline('Return the requested deliverable for note.md.'),
          format === 'missing' ? /deliverable remains unresolved/ : /deliverable was not validated/);
      } else {
        const result = await harness.runtime.runPipeline('Return the requested deliverable for note.md.');
        assert.equal(result.status, 'completed', JSON.stringify(result));
      }
      assert.ok(prompts[0].includes(JSON.stringify(requirement)), 'initial handoff retains the exact manifest');
      assert.ok(prompts[0].includes('Controller-requested browser deliverable'));
      const selections = harness.transcript.filter(({ eventType }) => eventType === 'browser.deliverable.selected');
      assert.equal(selections.length, ['missing', 'uncaptured'].includes(format) ? 0 : 1);
      if (selections.length) {
        assert.deepEqual(selections[0].data.paths, ['note.md']);
        assert.equal(selections[0].data.completeness.taskCorrectness, 'unverified');
      }
      assert.equal(await fs.readFile(path.join(root, 'note.md'), 'utf8'), ['markdown', 'zip'].includes(format) ? updated : format === 'diff' ? '# After\n' : original);
      if (format === 'listing') {
        assert.ok(harness.transcript.some(({ eventType }) => eventType === 'browser.deliverable.evidence'));
        assert.ok(!harness.transcript.some(({ eventType, data }) => eventType === 'browser.managed.control' && data.actionResults.some(({ kind }) => kind === 'workspace.applyPatch')));
      }
      if (!['missing', 'uncaptured'].includes(format)) assert.equal(prompts.length, 4, 'context, deliverable, verification, terminal completion');
    } finally {
      if (harness) { harness.adapterControlHistory.forEach((control) => control.release.resolve()); await harness.runtime.dispose(); harness.cleanup(); }
      await removeScratch(root);
    }
  });
}
