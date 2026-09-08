const assert = require("node:assert/strict");
const test = require("node:test");

const { parseBridgeClientMessage } = require("../dist/browser/protocol.js");
const { parseWebviewMessage } = require("../dist/webview/protocol.js");

test("message parser validates and deduplicates dynamic recipients", () => {
  const result = parseWebviewMessage({
    type: "message.send",
    recipients: ["codex", "codex", "chatgpt"],
    prompt: "hello",
    mode: "review",
    attachmentIds: ["a", "a"],
  });

  assert.deepEqual(result, {
    success: true,
    message: {
      type: "message.send",
      recipients: ["codex", "chatgpt"],
      prompt: "hello",
      mode: "review",
      attachmentIds: ["a"],
      delivery: "immediate",
    },
  });
});

test("message parser rejects unknown properties", () => {
  const result = parseWebviewMessage({ type: "ready", extra: true });
  assert.equal(result.success, false);
  assert.match(result.error, /Invalid ready message/);
});

test("message parser accepts valid dynamic agent ids", () => {
  const result = parseWebviewMessage({
    type: "session.reset",
    agentId: "local-reviewer",
  });
  assert.deepEqual(result, {
    success: true,
    message: { type: "session.reset", agentId: "local-reviewer" },
  });
});



test("message parser rejects prototype-sensitive agent and pipeline ids", () => {
  for (const agentId of ["__proto__", "constructor", "toString"]) {
    const result = parseWebviewMessage({
      type: "session.reset",
      agentId,
    });
    assert.equal(result.success, false);
    assert.match(result.error, /invalid agent/);
  }
  const pipeline = parseWebviewMessage({
    type: "pipeline.select",
    pipelineId: "toString",
  });
  assert.equal(pipeline.success, false);
  assert.match(pipeline.error, /valid pipeline id/);
});

test("message parser rejects blank agent ids", () => {
  const result = parseWebviewMessage({
    type: "session.reset",
    agentId: "   ",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /invalid agent/);
});

test("message parser rejects empty pipeline prompts", () => {
  const result = parseWebviewMessage({
    type: "pipeline.run",
    prompt: "   ",
    attachmentIds: [],
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Prompt cannot be empty/);
});

test("message parser requires an explicit interaction mode", () => {
  const result = parseWebviewMessage({
    type: "message.send",
    recipients: ["codex"],
    prompt: "hello",
    attachmentIds: [],
  });
  assert.equal(result.success, false);
  assert.match(result.error, /invalid interaction mode/);
});

test("message parser validates pipeline selection and human gates", () => {
  assert.deepEqual(parseWebviewMessage({
    type: "pipeline.select",
    pipelineId: "chatgpt-browser-spike",
  }), {
    success: true,
    message: {
      type: "pipeline.select",
      pipelineId: "chatgpt-browser-spike",
    },
  });
  assert.deepEqual(
    parseWebviewMessage({ type: "run.gate", action: "continue" }),
    {
      success: true,
      message: { type: "run.gate", action: "continue" },
    },
  );
  assert.deepEqual(
    parseWebviewMessage({
      type: "run.gate",
      action: "rollback",
      targetStepId: "inspect",
    }),
    {
      success: true,
      message: {
        type: "run.gate",
        action: "rollback",
        targetStepId: "inspect",
      },
    },
  );
});

test("message parser validates attachment uploads", () => {
  const result = parseWebviewMessage({
    type: "attachment.add",
    taskId: "task-1",
    clientId: "client-1",
    name: "screen.png",
    mimeType: "image/png",
    dataBase64: "iVBORw==",
  });
  assert.equal(result.success, true);
});



test("message parser rejects attachment uploads without the active task id", () => {
  const result = parseWebviewMessage({
    type: "attachment.add",
    clientId: "client-1",
    name: "screen.png",
    mimeType: "image/png",
    dataBase64: "iVBORw==",
  });
  assert.equal(result.success, false);
  assert.match(result.error, /invalid attachment data/);
});

test("message parser validates approval choice ids", () => {
  const result = parseWebviewMessage({
    type: "approval.respond",
    agentId: "codex",
    requestId: "42",
    choiceId: "grantForTurn",
  });
  assert.deepEqual(result, {
    success: true,
    message: {
      type: "approval.respond",
      agentId: "codex",
      requestId: "42",
      choiceId: "grantForTurn",
    },
  });
});

test("browser protocol contract matches the VS Code implementation", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const contract = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, "..", "protocol", "browser-protocol-v9.contract.json"),
      "utf8",
    ),
  );
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "browser", "protocol.ts"),
    "utf8",
  );
  assert.equal(contract.protocolVersion, 9);
  assert.equal(contract.endpointPath, "/bachata-browser-bridge-v9");
  for (const type of [
    ...contract.clientMessageTypes,
    ...contract.serverMessageTypes,
  ]) {
    assert.equal(
      source.includes(`"${type}"`),
      true,
      `Missing protocol message ${type}`,
    );
  }
  for (const fixture of contract.clientCompatibilityFixtures) {
    const parsed = parseBridgeClientMessage(fixture);
    assert.equal(
      parsed.success,
      true,
      `Rejected client fixture ${fixture.type}: ${parsed.error ?? "unknown error"}`,
    );
  }
});

test("webview protocol accepts provider asset reveal requests", () => {
  assert.deepEqual(
    parseWebviewMessage({
      type: "browser.asset.reveal",
      assetId: "asset-provider-only",
    }),
    {
      success: true,
      message: {
        type: "browser.asset.reveal",
        assetId: "asset-provider-only",
      },
    },
  );
});

test("browser protocol bounds captured asset metadata", () => {
  const response = {
    type: "conversation.response",
    protocolVersion: 9,
    requestId: "request-asset",
    agentId: "chatgpt",
    sessionId: "session-asset",
    provider: "chatgpt",
    text: "asset",
    segments: [{ type: "text", text: "asset", start: 0, end: 5 }],
    assets: [
      {
        id: "asset-1",
        provider: "chatgpt",
        kind: "generatedFile",
        name: "report.txt",
        sourceElement: "assistantMessage",
        downloadAvailable: true,
      },
    ],
    captureFormat: "renderedText",
    fidelity: "bestEffort",
    finalConversationUrl: "https://chatgpt.com/c/asset",
    finalConversationIdentity: "chatgpt:asset",
    finalSessionId: "session-asset",
    startedAt: "2026-08-02T00:00:00.000Z",
    completedAt: "2026-08-02T00:00:01.000Z",
  };

  assert.equal(parseBridgeClientMessage(response).success, true);
  assert.equal(
    parseBridgeClientMessage({
      ...response,
      assets: [{ ...response.assets[0], name: "x".repeat(513) }],
    }).success,
    false,
  );
  assert.equal(
    parseBridgeClientMessage({
      ...response,
      assets: Array.from({ length: 101 }, (_, index) => ({
        ...response.assets[0],
        id: `asset-${index}`,
      })),
    }).success,
    false,
  );
  assert.equal(
    parseBridgeClientMessage({
      type: "asset.start",
      protocolVersion: 9,
      transferId: "transfer-1",
      assetId: "asset-1",
      name: "x".repeat(513),
    }).success,
    false,
  );

  const withSourceOrigin = (sourceOrigin) =>
    parseBridgeClientMessage({
      ...response,
      assets: [{ ...response.assets[0], sourceOrigin }],
    });

  // Every value URL.origin can produce for a link the transfer path will fetch.
  for (const accepted of [
    "https://cdn.example.invalid",
    "https://cdn.example.invalid:8443",
    "http://localhost:3000",
    "https://[::1]",
    "https://[2001:db8::1]:8443",
    "https://xn--80ak6aa92e.com",
  ]) {
    const parsed = withSourceOrigin(accepted);
    assert.equal(parsed.success, true, accepted);
    assert.equal(parsed.message.assets[0].sourceOrigin, accepted);
  }

  // Nothing else. URL.origin never emits a path, a query, a fragment, userinfo, a written-out
  // default port, an uppercased scheme, whitespace, or a scheme the transfer path cannot fetch.
  for (const rejected of [
    "https://evil.invalid<script>",
    "javascript://evil",
    "data:text/plain,hi",
    "blob:https://cdn.example.invalid/2a1b",
    "sandbox:/mnt/data/report.docx",
    "https://cdn.example.invalid/download/report.txt",
    "https://cdn.example.invalid?token=secret",
    "https://cdn.example.invalid#part",
    "https://user:secret@cdn.example.invalid",
    "https://cdn.example.invalid:443",
    "http://cdn.example.invalid:80",
    "HTTPS://CDN.EXAMPLE.INVALID",
    "https://cdn.example.invalid ",
    "cdn.example.invalid",
    "null",
    "",
    "x".repeat(2_049),
  ]) {
    assert.equal(withSourceOrigin(rejected).success, false, rejected);
  }
});

test("browser bridge compatibility manifest matches the packaged contract", () => {
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const path = require("node:path");
  const protocolDirectory = path.join(__dirname, "..", "protocol");
  const compatibility = JSON.parse(
    fs.readFileSync(path.join(protocolDirectory, "browser-bridge.compatibility.json"), "utf8"),
  );
  const contract = fs.readFileSync(
    path.join(protocolDirectory, compatibility.contractFile),
  );
  const digest = crypto.createHash("sha256").update(contract).digest("hex");

  assert.equal(compatibility.browserBridgePackage, "bachata-browser-bridge");
  assert.equal(compatibility.browserBridgeVersion, "0.6.7");
  assert.equal(compatibility.protocolVersion, 9);
  assert.equal(compatibility.sha256, digest);
});

test("pipeline mutations require an explicit storage scope and revision", () => {
  const definition = { version: 1 };
  const create = parseWebviewMessage({
    type: "pipeline.save",
    pipeline: definition,
    mode: "create",
    scopeKey: "workspace:/repo",
  });
  assert.equal(create.success, true);
  assert.equal(create.message.scopeKey, "workspace:/repo");

  const update = parseWebviewMessage({
    type: "pipeline.save",
    pipeline: definition,
    mode: "update",
    scopeKey: "workspace:/repo",
    sourcePipelineId: "custom",
    expectedHash: "a".repeat(64),
  });
  assert.equal(update.success, true);

  const missingScope = parseWebviewMessage({
    type: "pipeline.save",
    pipeline: definition,
    mode: "create",
  });
  assert.equal(missingScope.success, false);

  const deletion = parseWebviewMessage({
    type: "pipeline.delete",
    pipelineId: "custom",
    scopeKey: "workspace:/repo",
    expectedHash: "b".repeat(64),
  });
  assert.equal(deletion.success, true);
});

test("pipeline queue and interrupt delivery retain validated iteration counts", () => {
  for (const delivery of ["queue", "interrupt"]) {
    assert.deepEqual(
      parseWebviewMessage({
        type: "pipeline.run",
        requestId: `${delivery}-iterations`,
        prompt: "Repeat this pipeline",
        attachmentIds: [],
        iterationCount: 3,
        delivery,
      }),
      {
        success: true,
        message: {
          type: "pipeline.run",
          requestId: `${delivery}-iterations`,
          prompt: "Repeat this pipeline",
          attachmentIds: [],
          iterationCount: 3,
          iterationMode: "fixed",
          delivery,
        },
      },
    );
  }
});

// EX-AUD-05 / BB-AUD-06. `parseSegment` rejected only `end < start`, and accepted empty
// text, so a zero-length segment left the coverage cursor where it was. Any number of them
// tiled nothing and still satisfied the exact-coverage check.
test("zero-length and non-advancing segments are rejected", () => {
  const base = {
    type: "conversation.response",
    protocolVersion: 9,
    requestId: "r",
    agentId: "a",
    sessionId: "s",
    provider: "claude",
    captureFormat: "renderedText",
    fidelity: "bestEffort",
    finalConversationUrl: "https://claude.ai/chat/x",
    finalConversationIdentity: "x",
    finalSessionId: "s",
    startedAt: "2026-09-02T00:00:00.000Z",
    completedAt: "2026-09-02T00:00:01.000Z",
    assets: [],
  };
  const message = (text, segments) => ({ ...base, text, segments });

  const padding = Array.from({ length: 64 }, () => ({
    type: "text", text: "", start: 0, end: 0,
  }));
  const rejected = (segments, reason) => {
    const parsed = parseBridgeClientMessage(message("hello", segments));
    assert.equal(parsed.success, false, reason);
    assert.match(parsed.error, /Invalid conversation\.response/u);
  };
  rejected(
    [...padding, { type: "text", text: "hello", start: 0, end: 5 }],
    "a run of zero-length segments still tiled the text exactly",
  );
  rejected(
    [{ type: "text", text: "", start: 0, end: 0 }, { type: "text", text: "hello", start: 0, end: 5 }],
    "a leading zero-length segment was accepted",
  );
  rejected(
    [{ type: "text", text: "hello", start: 0, end: 5 }, { type: "text", text: "", start: 5, end: 5 }],
    "a trailing zero-length segment must not be accepted",
  );
});

test("valid exact tiling and an empty response are still accepted", () => {
  const base = {
    type: "conversation.response",
    protocolVersion: 9,
    requestId: "r",
    agentId: "a",
    sessionId: "s",
    provider: "claude",
    captureFormat: "renderedText",
    fidelity: "bestEffort",
    finalConversationUrl: "https://claude.ai/chat/x",
    finalConversationIdentity: "x",
    finalSessionId: "s",
    startedAt: "2026-09-02T00:00:00.000Z",
    completedAt: "2026-09-02T00:00:01.000Z",
    assets: [],
  };
  const empty = parseBridgeClientMessage({ ...base, text: "", segments: [] });
  assert.equal(empty.success, true, empty.error);
  assert.equal(empty.message.text, "");
  const tiled = parseBridgeClientMessage({
    ...base,
    text: "ab\n\ncd",
    segments: [
      { type: "text", text: "ab", start: 0, end: 2 },
      // A run of newlines between blocks is real text and must stay tileable.
      { type: "text", text: "\n\n", start: 2, end: 4 },
      { type: "codeBlock", text: "cd", start: 4, end: 6, language: "js" },
    ],
  });
  assert.equal(tiled.success, true, tiled.error);
  assert.equal(tiled.message.segments.length, 3);
});
