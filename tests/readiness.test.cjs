const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateReadiness, recommendedPipelineId } = require("../dist/readiness/model.js");
const { parsePorcelainDirtyPaths } = require("../dist/readiness/gitStatus.js");

const pipeline = (id, adapter) => ({
  version: 1,
  id,
  name: id,
  agents: [{ id: "agent", name: "Agent", adapter }],
  steps: [],
});
// Codex cannot withhold the paths Bachata excludes, so every Codex pipeline is blocked until a
// human records that whole-working-directory reads are acceptable. Tests that are about
// something else record that acknowledgement; the ones below assert the default.
const base = (selectedPipelineId, catalog, adapters = []) => ({
  workspace: { trusted: true, roots: ["/work"], gitAvailable: true },
  adapters,
  bridge: { enabled: true, connected: false, sessions: [] },
  catalog,
  selectedPipelineId,
  codexWorkspaceScope: "wholeWorkingDirectory",
});

test("Codex-only pipeline is ready without Claude", () => {
  const catalog = [pipeline("codex-review", "codex-app-server")];
  assert.equal(evaluateReadiness(base("codex-review", catalog, [
    { type: "codex-app-server", available: true },
    { type: "claude-code", available: false },
  ])).status, "ready");
});

test("Claude-only pipeline is ready without Codex", () => {
  const catalog = [pipeline("claude-review", "claude-code")];
  assert.equal(evaluateReadiness(base("claude-review", catalog, [
    { type: "codex-app-server", available: false },
    { type: "claude-code", available: true },
  ])).status, "ready");
});

test("missing selected provider needs setup", () => {
  const catalog = [pipeline("codex-review", "codex-app-server")];
  const result = evaluateReadiness(base("codex-review", catalog, []));
  assert.equal(result.status, "needsSetup");
  assert.equal(result.findings.at(-1).remediationId, "provider.install.codex");
});

test("untrusted workspace blocks execution", () => {
  const catalog = [pipeline("codex-review", "codex-app-server")];
  const input = base("codex-review", catalog, [{ type: "codex-app-server", available: true }]);
  input.workspace.trusted = false;
  assert.equal(evaluateReadiness(input).status, "blocked");
});

test("remote browser provider is unsupported", () => {
  const catalog = [pipeline("browser", "claude-browser")];
  const input = base("browser", catalog);
  input.remoteName = "ssh-remote";
  assert.equal(evaluateReadiness(input).status, "unsupported");
});

test("connected Bridge without a selected session needs setup", () => {
  const catalog = [pipeline("browser", "claude-browser")];
  const input = base("browser", catalog);
  input.bridge.connected = true;
  assert.equal(evaluateReadiness(input).status, "needsSetup");
});

test("ready Bridge session satisfies browser pipeline", () => {
  const catalog = [pipeline("browser", "claude-browser")];
  const input = base("browser", catalog);
  input.bridge = {
    enabled: true,
    connected: true,
    selectedSessionId: "s1",
    sessions: [{
      id: "s1", provider: "claude", tabId: 1, frameId: 0, documentToken: "d",
      conversationUrl: "https://claude.ai/new", conversationIdentity: "new",
      status: "ready", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      capabilities: {
        submission: "verifiedSend", completion: "verifiedLifecycle",
        interruption: "confirmed", assets: "textOnly", conversationState: "confirmed",
      },
    }],
  };
  assert.equal(evaluateReadiness(input).status, "ready");
});

test("browser readiness fails closed without reported session capabilities", () => {
  const catalog = [pipeline("browser", "claude-browser")];
  const input = base("browser", catalog);
  input.bridge = {
    enabled: true, connected: true, selectedSessionId: "s1",
    sessions: [{ id: "s1", provider: "claude", tabId: 1, frameId: 0, documentToken: "d", conversationUrl: "https://claude.ai/new", conversationIdentity: "new", status: "ready", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }],
  };
  assert.equal(evaluateReadiness(input).status, "needsSetup");
});

test("recommendation selects an available single-provider preset", () => {
  const catalog = [pipeline("codex-review", "codex-app-server"), pipeline("claude-review", "claude-code")];
  assert.equal(recommendedPipelineId(catalog, [{ type: "claude-code", available: true }]), "claude-review");
});

test("each browser agent uses its own bound session", () => {
  const definition = {
    version: 1, id: "Bachata", name: "Bachata",
    agents: [
      { id: "worker", name: "Worker", adapter: "claude-browser" },
      { id: "lead", name: "Lead", adapter: "claude-browser" },
    ],
    steps: [],
  };
  const input = base("Bachata", [definition]);
  input.bridge = {
    enabled: true, connected: true, sessions: ["one", "two"].map((id, index) => ({
      id, provider: "claude", tabId: index, frameId: 0, documentToken: id,
      conversationUrl: `https://claude.ai/${id}`, conversationIdentity: id, status: "ready",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      capabilities: { submission: "verifiedSend", completion: "verifiedLifecycle", interruption: "confirmed", assets: "textOnly", conversationState: "confirmed" },
    })),
  };
  input.browserBindings = { worker: "one", lead: "two" };
  assert.equal(evaluateReadiness(input).status, "ready");
  input.browserBindings.lead = undefined;
  assert.equal(evaluateReadiness(input).status, "needsSetup");
});

test("required capabilities fail closed", () => {
  const definition = pipeline("capabilities", "codex-app-server");
  definition.steps = [{
    id: "review", name: "review", enabled: true, humanGate: "none", type: "agent",
    participants: ["agent"], promptTemplate: "x", parallel: false, consensus: false,
    requiredCapabilities: ["attachments"],
  }];
  const result = evaluateReadiness(base("capabilities", [definition], [{
    agentId: "agent", type: "codex-app-server", available: true, capabilities: ["streaming"],
  }]));
  assert.equal(result.status, "needsSetup");
  assert.match(result.findings.at(-1).detail, /attachments/u);
});

test("catalog errors and stale selected roots block", () => {
  const definition = pipeline("codex-review", "codex-app-server");
  const input = base("codex-review", [definition], [{ type: "codex-app-server", available: true }]);
  input.catalogError = "invalid custom pipeline";
  input.selectedRoot = "/closed";
  const result = evaluateReadiness(input);
  assert.equal(result.status, "blocked");
  assert.equal(result.findings.filter((item) => item.status === "blocked").length, 2);
});

test("Git is optional for a local review but required for managed workflows", () => {
  const review = pipeline("review", "codex-app-server");
  const reviewInput = base("review", [review], [{ type: "codex-app-server", available: true }]);
  reviewInput.workspace.gitAvailable = false;
  assert.equal(evaluateReadiness(reviewInput).status, "ready");
  const managed = { ...review, id: "managed", managedPolicy: { commitMode: "never" } };
  const managedInput = base("managed", [managed], [{ type: "codex-app-server", available: true }]);
  managedInput.workspace.gitAvailable = false;
  assert.equal(evaluateReadiness(managedInput).status, "blocked");
});

test("managed workflows block on a dirty Git workspace", () => {
  const input = base("managed", [{
    version: 1,
    id: "managed",
    name: "Managed",
    agents: [],
    steps: [{ id: "execute", name: "Execute", enabled: true, humanGate: "none", type: "executeChecklist", inputName: "items", pipelineId: "task", checks: ["bachata:project-checks"] }],
  }], []);
  input.workspace.gitAvailable = true;
  input.workspace.gitClean = false;
  assert.equal(evaluateReadiness(input).status, "blocked");
});

test("generic browser readiness requires the managed capability set", () => {
  const pipeline = {
    id: "generic-pair",
    name: "Generic Bachata",
    agents: [{ id: "generic", name: "Generic", adapter: "generic-browser", model: "browser" }],
    steps: [],
  };
  const session = (capabilities) => ({
    id: "session-1",
    provider: "generic",
    tabId: 1,
    frameId: 0,
    documentToken: "token",
    conversationUrl: "https://example.invalid/chat/1",
    conversationIdentity: "generic:1",
    status: "ready",
    capabilities,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  });
  const evaluate = (capabilities) => evaluateReadiness({
    workspace: { trusted: true, roots: ["/work"], gitAvailable: true },
    adapters: [],
    bridge: { enabled: true, connected: true, selectedSessionId: "session-1", sessions: [session(capabilities)] },
    catalog: [pipeline],
    selectedPipelineId: "generic-pair",
  });

  const managed = evaluate({
    submission: "verifiedSend",
    completion: "verifiedLifecycle",
    interruption: "confirmed",
    assets: "supported",
    conversationState: "confirmed",
  });
  assert.equal(managed.status, "ready");

  const unverified = evaluate({
    submission: "syntheticEnter",
    completion: "verifiedLifecycle",
    interruption: "unavailable",
    assets: "textOnly",
    conversationState: "confirmed",
  });
  assert.equal(unverified.status, "needsSetup");
  assert.match(
    unverified.findings.find((finding) => finding.id === "bridge.generic").detail,
    /verified Send/u,
  );
});

test("agent-specific adapter readiness wins over a general probe", () => {
  const pipeline = {
    id: "codex-review",
    name: "Codex review",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex", capabilities: ["structuredOutput"] }],
    steps: [],
  };
  const readiness = evaluateReadiness({
    workspace: { trusted: true, roots: ["/work"], gitAvailable: true },
    adapters: [
      { type: "codex-app-server", available: false, capabilities: [], detail: "Probe found no CLI" },
      { agentId: "codex", type: "codex-app-server", available: true, capabilities: ["structuredOutput"], detail: "codex 1.0" },
    ],
    bridge: { enabled: false, connected: false, sessions: [] },
    catalog: [pipeline],
    selectedPipelineId: "codex-review",
    codexWorkspaceScope: "wholeWorkingDirectory",
  });
  assert.equal(readiness.status, "ready");
  assert.equal(readiness.findings.find((finding) => finding.id === "adapter.codex").detail, "codex 1.0");
});

test("a reported agent failure is not masked by an available adapter probe", () => {
  const pipeline = {
    id: "codex-review",
    name: "Codex review",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
    steps: [],
  };
  const readiness = evaluateReadiness({
    workspace: { trusted: true, roots: ["/work"], gitAvailable: true },
    adapters: [
      { type: "codex-app-server", available: true, capabilities: ["structuredOutput"] },
      { agentId: "codex", type: "codex-app-server", available: false, capabilities: [], detail: "codex exited with 1" },
    ],
    bridge: { enabled: false, connected: false, sessions: [] },
    catalog: [pipeline],
    selectedPipelineId: "codex-review",
    codexWorkspaceScope: "wholeWorkingDirectory",
  });
  assert.equal(readiness.status, "needsSetup");
  assert.equal(
    readiness.findings.find((finding) => finding.id === "adapter.codex").detail,
    "codex exited with 1",
  );
});

test("a dirty permitted pipeline catalog does not block its own checklist pipeline", () => {
  const pipeline = {
    id: "custom-checklist",
    name: "Custom checklist",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
    steps: [{ id: "execute", name: "Execute", enabled: true, type: "executeChecklist", participants: [] }],
  };
  const evaluate = (dirtyPaths, allowedDirtyPaths) => evaluateReadiness({
    workspace: {
      trusted: true,
      roots: ["/work"],
      gitAvailable: true,
      gitClean: false,
      dirtyPaths,
    },
    allowedDirtyPaths,
    adapters: [{ agentId: "codex", type: "codex-app-server", available: true, capabilities: [] }],
    bridge: { enabled: false, connected: false, sessions: [] },
    catalog: [pipeline],
    selectedPipelineId: "custom-checklist",
    codexWorkspaceScope: "wholeWorkingDirectory",
  });

  const permitted = evaluate([".bachata/pipelines/custom-checklist.pipeline.json"], [".bachata/pipelines"]);
  assert.equal(permitted.findings.some((finding) => finding.id === "git.clean"), false);
  assert.equal(permitted.status, "ready");

  const blocked = evaluate([".bachata/pipelines/custom-checklist.pipeline.json", "src/a.ts"], [".bachata/pipelines"]);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.findings.some((finding) => finding.id === "git.clean"), true);

  const unknownPaths = evaluate(undefined, [".bachata/pipelines"]);
  assert.equal(unknownPaths.status, "blocked");
});

test("nested, sibling, absolute, and traversal-shaped dirty paths never match an allowed root", () => {
  const pipeline = {
    id: "custom-checklist",
    name: "Custom checklist",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
    steps: [{ id: "execute", name: "Execute", enabled: true, type: "executeChecklist", participants: [] }],
  };
  const evaluate = (dirtyPaths) => evaluateReadiness({
    workspace: {
      trusted: true,
      roots: ["/work"],
      gitAvailable: true,
      gitClean: false,
      dirtyPaths,
    },
    allowedDirtyPaths: [".bachata/pipelines"],
    adapters: [{ agentId: "codex", type: "codex-app-server", available: true, capabilities: [] }],
    bridge: { enabled: false, connected: false, sessions: [] },
    catalog: [pipeline],
    selectedPipelineId: "custom-checklist",
  });
  const blocking = (dirtyPaths) =>
    evaluate(dirtyPaths).findings.some((finding) => finding.id === "git.clean");

  assert.equal(blocking(["nested/.bachata/pipelines/evil.pipeline.json"]), true);
  assert.equal(blocking(["vendor/nested/.bachata/pipelines/a.json"]), true);
  assert.equal(blocking([".bachata/pipelines-evil/a.json"]), true);
  assert.equal(blocking([".bachata/pipelinesevil.json"]), true);
  assert.equal(blocking([".bachata/pipelines/../../etc/passwd"]), true);
  assert.equal(blocking(["/tmp/.bachata/pipelines/a.json"]), true);
  assert.equal(blocking(["C:\\repo\\.bachata\\pipelines\\a.json"]), true);

  assert.equal(blocking([".bachata/pipelines"]), false);
  assert.equal(blocking([".bachata/pipelines/a.pipeline.json"]), false);
  assert.equal(blocking(["./.bachata/pipelines/a.pipeline.json"]), false);
  assert.equal(blocking([".bachata//pipelines/a.pipeline.json"]), false);
  assert.equal(blocking([".bachata\\pipelines\\a.pipeline.json"]), false);
  assert.equal(blocking([".bachata/./pipelines/a.pipeline.json"]), false);
});

const nulRecords = (...records) => `${records.join("\0")}\0`;

test("porcelain -z parsing keeps every pathname byte, including quotes, newlines, and CRLF", () => {
  const status = nulRecords(
    " M .bachata/pipelines/a.pipeline.json",
    "M  src/staged.ts",
    "?? docs/new.md",
    "A  \"literally quoted.ts\"",
    " D removed.ts",
    "?? weird\nname.ts",
    "?? windows\r\nname.ts",
    "?? spaced   name.ts",
  );
  assert.deepEqual(parsePorcelainDirtyPaths(status), [
    ".bachata/pipelines/a.pipeline.json",
    "src/staged.ts",
    "docs/new.md",
    "\"literally quoted.ts\"",
    "removed.ts",
    "weird\nname.ts",
    "windows\r\nname.ts",
    "spaced   name.ts",
  ]);
  assert.deepEqual(parsePorcelainDirtyPaths(""), []);
});

test("a filename whose own characters are quotes never collapses onto an allowed root", () => {
  const quoted = `"${".bachata/pipelines/x"}"`;
  assert.deepEqual(
    parsePorcelainDirtyPaths(nulRecords(`?? ${quoted}`)),
    [quoted],
  );
  const pipeline = {
    id: "custom-checklist",
    name: "Custom checklist",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
    steps: [{ id: "execute", name: "Execute", enabled: true, type: "executeChecklist", participants: [] }],
  };
  const readiness = evaluateReadiness({
    workspace: {
      trusted: true,
      roots: ["/work"],
      gitAvailable: true,
      gitClean: false,
      dirtyPaths: parsePorcelainDirtyPaths(nulRecords(`?? ${quoted}`)),
    },
    allowedDirtyPaths: [".bachata/pipelines"],
    adapters: [{ agentId: "codex", type: "codex-app-server", available: true, capabilities: [] }],
    bridge: { enabled: false, connected: false, sessions: [] },
    catalog: [pipeline],
    selectedPipelineId: "custom-checklist",
  });
  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.findings.some((finding) => finding.id === "git.clean"), true);
});

test("only a rename or copy status consumes a second pathname", () => {
  assert.deepEqual(
    parsePorcelainDirtyPaths(nulRecords("R  new/name.ts", "old/name.ts")),
    ["new/name.ts", "old/name.ts"],
  );
  assert.deepEqual(
    parsePorcelainDirtyPaths(nulRecords("C  copy/name.ts", "origin/name.ts")),
    ["copy/name.ts", "origin/name.ts"],
  );
  assert.throws(
    () => parsePorcelainDirtyPaths(nulRecords("R  only/new.ts")),
    /incomplete rename status record/u,
  );
});

test("an ordinary arrow inside a filename is one path, never a rename", () => {
  const status = nulRecords("?? nested -> .bachata/pipelines/x.pipeline.json");
  assert.deepEqual(parsePorcelainDirtyPaths(status), [
    "nested -> .bachata/pipelines/x.pipeline.json",
  ]);
  const pipeline = {
    id: "custom-checklist",
    name: "Custom checklist",
    agents: [{ id: "codex", name: "Codex", adapter: "codex-app-server", model: "gpt-5-codex" }],
    steps: [{ id: "execute", name: "Execute", enabled: true, type: "executeChecklist", participants: [] }],
  };
  const readiness = evaluateReadiness({
    workspace: {
      trusted: true,
      roots: ["/work"],
      gitAvailable: true,
      gitClean: false,
      dirtyPaths: parsePorcelainDirtyPaths(status),
    },
    allowedDirtyPaths: [".bachata/pipelines"],
    adapters: [{ agentId: "codex", type: "codex-app-server", available: true, capabilities: [] }],
    bridge: { enabled: false, connected: false, sessions: [] },
    catalog: [pipeline],
    selectedPipelineId: "custom-checklist",
  });
  assert.equal(readiness.status, "blocked");
  assert.equal(readiness.findings.some((finding) => finding.id === "git.clean"), true);
});

test("a malformed porcelain record fails closed instead of guessing", () => {
  assert.throws(
    () => parsePorcelainDirtyPaths(nulRecords("XY")),
    /invalid porcelain status record/u,
  );
});

test("capability findings name the provider and the missing ability in plain words", () => {
  const pipeline = {
    id: "browser-pair",
    name: "Browser pair",
    agents: [{
      id: "chatgpt",
      name: "ChatGPT",
      adapter: "chatgpt-browser",
      model: "browser",
      capabilities: ["passiveActionLoop"],
    }],
    steps: [],
  };
  const readiness = evaluateReadiness({
    workspace: { trusted: true, roots: ["/work"], gitAvailable: true },
    adapters: [],
    bridge: {
      enabled: true,
      connected: true,
      selectedSessionId: "session-1",
      sessions: [{
        id: "session-1",
        provider: "chatgpt",
        tabId: 3,
        frameId: 0,
        documentToken: "token",
        conversationUrl: "https://chatgpt.com/c/1",
        conversationIdentity: "chatgpt:1",
        status: "ready",
        capabilities: {
          submission: "syntheticEnter",
          completion: "manualOnly",
          interruption: "unavailable",
          assets: "textOnly",
          conversationState: "confirmed",
        },
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      }],
    },
    catalog: [pipeline],
    selectedPipelineId: "browser-pair",
  });

  const finding = readiness.findings.find((item) => item.id === "bridge.chatgpt");
  assert.equal(finding.status, "needsSetup");
  assert.match(finding.detail, /autonomous action loop/u);
  assert.doesNotMatch(finding.detail, /passiveActionLoop/u);
});

test("unavailable local providers explain themselves without capability jargon", () => {
  const pipeline = {
    id: "codex-review",
    name: "Codex review",
    agents: [{
      id: "codex",
      name: "Codex",
      adapter: "codex-app-server",
      model: "gpt-5-codex",
      capabilities: ["attachments"],
    }],
    steps: [],
  };
  const readiness = evaluateReadiness({
    workspace: { trusted: true, roots: ["/work"], gitAvailable: true },
    adapters: [{ agentId: "codex", type: "codex-app-server", available: true, capabilities: [] }],
    bridge: { enabled: false, connected: false, sessions: [] },
    catalog: [pipeline],
    selectedPipelineId: "codex-review",
    codexWorkspaceScope: "wholeWorkingDirectory",
  });

  const finding = readiness.findings.find((item) => item.id === "adapter.codex");
  assert.match(finding.detail, /Codex \(codex-app-server\) cannot provide image attachments/u);
});

test("a Codex pipeline is blocked until whole-working-directory reads are accepted", () => {
  const catalog = [pipeline("codex-review", "codex-app-server")];
  const input = base("codex-review", catalog, [{ type: "codex-app-server", available: true }]);
  delete input.codexWorkspaceScope;
  const result = evaluateReadiness(input);
  assert.equal(result.status, "blocked");
  const blocker = result.findings.find((finding) => finding.status === "blocked");
  assert.equal(blocker.remediationId, "provider.readScope");
  assert.match(blocker.detail, /no per-path readable-root capability/u);
});

test("an explicitly refused scope is not silently upgraded", () => {
  const catalog = [pipeline("codex-review", "codex-app-server")];
  const input = base("codex-review", catalog, [{ type: "codex-app-server", available: true }]);
  input.codexWorkspaceScope = "refuseNarrowedScope";
  assert.equal(evaluateReadiness(input).status, "blocked");
});

test("a disabled provider makes its pipeline unsupported rather than merely unready", () => {
  const catalog = [pipeline("codex-review", "codex-app-server")];
  const input = base("codex-review", catalog, [{ type: "codex-app-server", available: true }]);
  input.disabledProviders = ["codex-app-server"];
  const result = evaluateReadiness(input);
  assert.equal(result.status, "unsupported");
  const finding = result.findings.find((entry) => entry.status === "unsupported");
  assert.equal(finding.remediationId, "provider.enable");
  assert.match(finding.detail, /bachata\.disabledProviders/u);
});

test("disabling one provider leaves another provider's pipeline ready", () => {
  const catalog = [pipeline("claude-review", "claude-code")];
  const input = base("claude-review", catalog, [{ type: "claude-code", available: true }]);
  input.disabledProviders = ["codex-app-server"];
  assert.equal(evaluateReadiness(input).status, "ready");
});
