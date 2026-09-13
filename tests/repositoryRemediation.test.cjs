const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateReadiness } = require("../dist/readiness/model.js");
const { remediationPlan } = require("../dist/readiness/remediation.js");
const { gitReadinessFrom } = require("../dist/readiness/gitReadiness.js");
const {
  assertWorkspacePolicyAudit,
  captureWorkspacePolicyAudit,
} = require("../dist/adapters/workspacePolicyAudit.js");
const { scratchRootSync, removeScratchSync } = require("./support/scratch.cjs");

const managedPipeline = {
  version: 1,
  id: "managed",
  name: "Managed",
  agents: [{ id: "agent", name: "Agent", adapter: "codex-app-server" }],
  steps: [],
  managedPolicy: { commitMode: "never" },
};

const input = (workspace) => ({
  workspace: { trusted: true, roots: ["/work"], ...workspace },
  adapters: [{ type: "codex-app-server", available: true }],
  bridge: { enabled: true, connected: false, sessions: [] },
  catalog: [managedPipeline],
  selectedPipelineId: "managed",
  selectedRoot: "/work",
  codexWorkspaceScope: "wholeWorkingDirectory",
});

test("a Git probe distinguishes an unusable Git from a root that holds no repository", () => {
  const notARepository = gitReadinessFrom({
    outcome: "statusFailed",
    error: new Error("fatal: not a git repository (or any of the parent directories): .git"),
  });
  assert.equal(notARepository.available, false);
  assert.equal(notARepository.repository, false);

  const missingGit = gitReadinessFrom({ outcome: "versionFailed", error: new Error("spawn git ENOENT") });
  assert.equal(missingGit.available, false);
  assert.equal(missingGit.repository, undefined, "an absent Git says nothing about the root");

  const usable = gitReadinessFrom({ outcome: "status", version: "git version 2.55.0", status: "" });
  assert.equal(usable.repository, true);
});

test("a root that is not a repository is still blocked, and its Fix names the root rather than Git", () => {
  const blocked = evaluateReadiness(input({ gitAvailable: false, gitRepository: false }));
  assert.equal(blocked.status, "blocked", "the Git audit stays in force");
  const git = blocked.findings.find((finding) => finding.id === "git");
  assert.equal(git.status, "blocked");
  assert.equal(git.remediationId, "workspace.selectRepository");
  assert.match(git.detail, /\/work is not a Git repository/u);

  // An absent Git is still an absent Git, and still sends the reader to install one.
  const noGit = evaluateReadiness(input({ gitAvailable: false }));
  assert.equal(noGit.findings.find((finding) => finding.id === "git").remediationId, "git.install");
});

test("the repository Fix takes the reader to working-directory selection, and weakens nothing", () => {
  const plan = remediationPlan("workspace.selectRepository", {
    codexCommand: "codex",
    claudeCommand: "claude",
    detail: "/work is not a Git repository",
  });
  assert.equal(plan.id, "workspace.selectRepository");
  assert.equal(plan.condition, "/work is not a Git repository");
  // The action the panel offers first must be the one that changes the root.
  assert.equal(plan.actions[0].kind, "chooseWorkingDirectory");
  assert.ok(plan.steps.some((step) => /child of the folder that is open/u.test(step)));
  assert.ok(
    plan.steps.some((step) => /Git audit stays in force/u.test(step)),
    "the remedy must not read as a way around the audit",
  );
  assert.ok(
    plan.steps.some((step) => /Bachata never creates a repository for you/u.test(step)),
    "Bachata must not offer to run git init on the reader's behalf",
  );
  assert.equal(plan.recheck.kind, "gitStatus");
});

test("the worktree remediation also offers working-directory selection", () => {
  const plan = remediationPlan("doctor.run", { codexCommand: "codex", claudeCommand: "claude" });
  assert.ok(
    plan.actions.some((action) => action.kind === "chooseWorkingDirectory"),
    "a worktree is cut from the repository at the working directory, so the reader must be able to change it",
  );
  // Only the first three actions are offered, so the new one has to be inside that window.
  assert.ok(plan.actions.slice(0, 3).some((action) => action.kind === "chooseWorkingDirectory"));
});

test("autonomous local-agent execution is still refused outside a Git repository", async () => {
  // The remedy above changes which root a run points at. It must not have made a non-repository
  // root runnable: this is the refusal that protects post-turn validation, and it stands.
  const root = scratchRootSync("bachata-remediation-nonrepo-");
  try {
    const request = {
      prompt: "p",
      workingDirectory: root,
      attachments: [],
      workspacePolicy: {
        readOnly: false,
        writeScope: "task",
        allowedPaths: ["src"],
        commitMode: "never",
        automated: true,
      },
    };
    const before = await captureWorkspacePolicyAudit(request);
    assert.equal(before.isGitRepository, false);
    await assert.rejects(
      assertWorkspacePolicyAudit(request, before),
      /Choose a Git project folder\./u,
    );
  } finally {
    removeScratchSync(root);
  }
});

// What the run refuses on, and what it must not refuse on.
//
// `pipelineRunRefusal` consumed only `blocked` findings. Bridge disconnected, no session selected
// and a session that cannot carry the pipeline's capabilities are all reported as `needsSetup` —
// the name of the remedy, not a statement that the requirement is optional — so a browser pipeline
// reached its participants with no transport at all.

const { participatingAgentIds, runBlockingFindings } = require("../dist/readiness/model.js");

const browserPipeline = {
  version: 1,
  id: "browser",
  name: "Browser",
  agents: [{ id: "chatgpt", name: "ChatGPT", adapter: "chatgpt-browser", capabilities: ["passiveActionLoop"] }],
  steps: [
    {
      id: "ask",
      name: "Ask",
      enabled: true,
      type: "agent",
      participants: ["chatgpt"],
      promptTemplate: "{{userPrompt}}",
      parallel: false,
      consensus: false,
      humanGate: "none",
    },
  ],
};

const browserInput = (bridge) => ({
  workspace: { trusted: true, roots: ["/work"], gitAvailable: true },
  adapters: [{ type: "chatgpt-browser", available: true }],
  bridge: { enabled: true, ...bridge },
  catalog: [browserPipeline],
  selectedPipelineId: "browser",
  selectedRoot: "/work",
  codexWorkspaceScope: "wholeWorkingDirectory",
});

const readySession = (capabilities) => ({
  id: "session-1",
  provider: "chatgpt",
  tabId: 1,
  frameId: 0,
  documentToken: "document-1",
  conversationUrl: "https://chatgpt.com/c/session-1",
  conversationIdentity: "session-1",
  title: "A tab",
  status: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...(capabilities === undefined ? {} : { capabilities }),
});

test("a browser pipeline cannot start without its bridge, its session, or its capabilities", () => {
  const disconnected = evaluateReadiness(browserInput({ connected: false, sessions: [] }));
  assert.deepEqual(
    runBlockingFindings(disconnected.findings).map((entry) => entry.detail),
    ["Connect the Browser Bridge"],
    "a disconnected bridge did not stop the run",
  );

  const noSession = evaluateReadiness(browserInput({ connected: true, sessions: [readySession()] }));
  assert.deepEqual(
    runBlockingFindings(noSession.findings).map((entry) => entry.detail),
    ["Select a ready chatgpt browser session"],
    "a run started with no session selected",
  );

  const weakSession = evaluateReadiness(browserInput({
    connected: true,
    selectedSessionId: "session-1",
    sessions: [readySession({ completion: "manualOnly", conversationState: "confirmed" })],
  }));
  assert.equal(
    runBlockingFindings(weakSession.findings).length,
    1,
    "a session that cannot carry the pipeline's capabilities did not stop the run",
  );

  const usable = evaluateReadiness(browserInput({
    connected: true,
    selectedSessionId: "session-1",
    sessions: [readySession({
      submission: "verifiedSend",
      completion: "verifiedLifecycle",
      interruption: "confirmed",
      conversationState: "confirmed",
    })],
  }));
  assert.deepEqual(runBlockingFindings(usable.findings), [], "a ready bridge and session still refused");
});

test("a provider still being asked about, or a Git nobody has checked, is not a refusal", () => {
  // A local provider is transient in both directions: the host may still be discovering it, and one
  // refused turn is not a provider that has gone away. The run's own preflight validates the
  // capabilities the pipeline needs against the adapters it actually built.
  const undiscovered = evaluateReadiness({
    ...input({ gitAvailable: undefined }),
    adapters: [],
  });
  assert.deepEqual(
    runBlockingFindings(undiscovered.findings).map((entry) => entry.id),
    [],
    "startup turned an unfinished question into a permanent refusal",
  );
  assert.ok(
    undiscovered.findings.some((entry) => entry.id === "git" && entry.status === "needsSetup"),
    "the Git finding this case is about is missing",
  );
});

test("a local-agent pipeline that needs Git is refused outside a repository and accepted inside a child one", () => {
  const notARepository = evaluateReadiness(input({
    gitAvailable: false,
    gitRepository: false,
  }));
  assert.ok(
    runBlockingFindings(notARepository.findings).some((entry) => entry.id === "git"),
    "a managed pipeline started in a folder holding no repository",
  );

  // The remedy is to point Bachata at the repository, which is often a child of the open folder.
  // Once it is selected, the same pipeline is accepted.
  const childRepository = evaluateReadiness({
    ...input({ gitAvailable: true, gitRepository: true }),
    selectedRoot: "/work/packages/app",
  });
  assert.deepEqual(
    runBlockingFindings(childRepository.findings),
    [],
    "a valid child repository was refused",
  );
});

test("a browser candidate for a role a local agent fills is not this run's blocker", () => {
  // Every preset names each provider it could use. A role statically assigned to a local agent
  // still lists browser candidates, and refusing on those would refuse every run on a machine with
  // no bridge — including the orchestration presets, which have no browser participant at all.
  const rolePipeline = {
    version: 1,
    id: "roles",
    name: "Roles",
    agents: [
      { id: "codex", name: "Codex", adapter: "codex-app-server" },
      { id: "gpt-lead", name: "ChatGPT", adapter: "chatgpt-browser" },
    ],
    roles: [{ id: "lead", name: "Lead", candidateAgentIds: ["gpt-lead"] }],
    steps: [
      {
        id: "assign",
        name: "Assign",
        enabled: true,
        type: "assignRoles",
        humanGate: "none",
        roleAssignments: [{ role: "lead", agentId: "codex" }],
      },
      {
        id: "plan",
        name: "Plan",
        enabled: true,
        type: "agent",
        participants: ["lead"],
        promptTemplate: "{{userPrompt}}",
        parallel: false,
        consensus: false,
        humanGate: "none",
      },
    ],
  };
  assert.deepEqual(participatingAgentIds(rolePipeline), ["codex"]);
  const readiness = evaluateReadiness({
    workspace: { trusted: true, roots: ["/work"], gitAvailable: true },
    adapters: [{ type: "codex-app-server", available: true }],
    bridge: { enabled: false, connected: false, sessions: [] },
    catalog: [rolePipeline],
    selectedPipelineId: "roles",
    selectedRoot: "/work",
    codexWorkspaceScope: "wholeWorkingDirectory",
  });
  assert.ok(
    readiness.findings.some((entry) => entry.id === "bridge.gpt-lead" && entry.status === "unsupported"),
    "the candidate's own finding is still reported to the reader",
  );
  assert.deepEqual(
    runBlockingFindings(readiness.findings, { participatingAgentIds: participatingAgentIds(rolePipeline) }),
    [],
    "a provider no enabled step runs stopped the run",
  );
});
