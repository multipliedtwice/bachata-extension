/*
 * A complete `ManagerState` and `PanelState` for the layout fixture. Complete on purpose: an
 * incomplete state trips the webview's own render-failure boundary, and a layout measured on the
 * failure banner would pass every hit-region check while proving nothing about the run tab strip.
 */
const timestamp = "2026-08-05T00:00:00.000Z";
const customAHash = "a".repeat(64);

const pipelineDefinition = {
  version: 1,
  id: "custom-a",
  name: "Review only",
  description: "Read the repository and report findings",
  agents: [{ id: "lead", name: "Lead", adapter: "codex-app-server" }],
  roles: [],
  steps: [{
    id: "step-1",
    name: "Implement",
    enabled: true,
    humanGate: "none",
    type: "agent",
    participants: ["lead"],
    promptTemplate: "{{userPrompt}}",
    parallel: false,
    consensus: false,
    attachments: "selected",
  }],
};

const conversationSummary = {
  id: "run-1",
  runRef: "run-1",
  title: "Clean fixture",
  iterationCount: 1,
  activeIteration: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
  running: false,
  workflowStatus: "idle",
  unread: 0,
  archived: false,
  selectedPipelineId: "custom-a",
  selectedPipelineHash: customAHash,
  pipelineScopeRoot: "/workspace",
};

// Two runs, because one run has no unselected tab and the strip's unselected state is exactly
// where a control can end up visible without being reachable. A one-run fixture would pass every
// assertion by never rendering the branch they are about.
const secondConversation = {
  ...conversationSummary,
  id: "run-2",
  runRef: "run-2",
  title: "Second run",
};

window.__managerState = {
  conversations: [conversationSummary, secondConversation],
  activeConversationId: "run-1",
  defaultPipelineIterations: 1,
  maxPipelineIterations: 10,
  interactions: [],
  eventsByConversation: {},
  resultsByConversation: {},
  conversationLocators: {},
  orchestration: { active: false, masterChecks: [], tasks: [], finalChecks: [], retainedRuns: [] },
  // An unread event, so the notification centre is drawn and its dismissal can be measured.
  notifications: {
    mode: "material",
    unread: 1,
    events: [{
      id: "converged:Y1:3-1-0-1",
      kind: "findingsConverged",
      level: "material",
      text: "Review converged: 3 resolved, 1 new, 0 regressed, 1 needs you.",
      action: "inspect",
      recordedAt: "2026-01-01T00:00:00.000Z",
      read: false,
    }],
  },
};

window.__panelState = {
  taskId: "run-1",
  workspaceRoots: ["/workspace"],
  trusted: true,
  pipelines: [{
    id: "custom-a",
    name: "Review only",
    editable: true,
    hash: customAHash,
    scopeKey: "workspace:/workspace",
    scopeRoot: "/workspace",
    participantCount: 1,
    participantNames: ["Lead"],
    stepCount: 1,
  }, {
    id: "custom-b",
    name: "Implement and review",
    editable: true,
    hash: "b".repeat(64),
    scopeKey: "workspace:/workspace",
    scopeRoot: "/workspace",
    participantCount: 3,
    participantNames: ["Lead", "Worker", "Reviewer"],
    stepCount: 4,
  }],
  selectedPipelineId: "custom-a",
  selectedPipelineHash: customAHash,
  pipelineScopeKey: "workspace:/workspace",
  pipelineScopeRoot: "/workspace",
  selectedPipelineDefinition: pipelineDefinition,
  adapterTypes: ["codex-app-server", "claude-code", "chatgpt-browser", "claude-browser", "generic-browser"],
  agents: {
    lead: { id: "lead", name: "Lead", adapterType: "codex-app-server", status: "idle", output: "" },
  },
  // Several responsibilities, one of them deliberately long, so the Agents popover is measured
  // with content that can actually overflow a narrow pane rather than a single short row.
  agentAssignments: {
    slots: [
      {
        agentId: "lead",
        responsibility: "Lead",
        roleId: "lead",
        defaultAdapter: "codex-app-server",
        assignedAdapter: "codex-app-server",
        overridden: false,
      },
      {
        agentId: "builder",
        responsibility: "Implementation and repository verification specialist",
        roleId: "builder",
        defaultAdapter: "claude-code",
        assignedAdapter: "chatgpt-browser",
        browserSessionId: "session-1",
        overridden: true,
      },
      {
        agentId: "qa",
        responsibility: "Quality assurance",
        roleId: "qa",
        defaultAdapter: "claude-code",
        assignedAdapter: "claude-code",
        overridden: false,
      },
    ],
    assignableAdapters: [
      "codex-app-server",
      "claude-code",
      "chatgpt-browser",
      "claude-browser",
      "generic-browser",
    ],
  },
  roles: {},
  running: false,
  workflowStatus: "idle",
  transcript: [],
  transcriptTotal: 0,
  transcriptHasMore: false,
  transcriptWindowSize: 300,
  approvals: [],
  attachments: [],
  maxAttachmentBytes: 20971520,
  maxAttachmentCount: 20,
  maxAttachmentTotalBytes: 52428800,
  pipelineMutable: true,
  browserActionPolicies: { readOnly: "ask", mutation: "ask", destructive: "ask", shell: "disabled" },
  browserBridge: {
    enabled: true,
    connected: true,
    sessions: [
      {
        id: "session-1",
        provider: "chatgpt",
        tabId: 7,
        conversationIdentity: "conversation-1",
        conversationUrl: "https://chatgpt.com/c/conversation-1",
        title: "A browser conversation with a deliberately long title that must wrap or clip cleanly",
        status: "ready",
      },
      {
        id: "session-2",
        provider: "claude",
        tabId: 8,
        conversationIdentity: "conversation-2",
        conversationUrl: "https://claude.ai/chat/conversation-2",
        title: "Second conversation",
        status: "ready",
      },
    ],
  },
  queuedMessages: [],
  queuePaused: false,
};

window.__send = (message) => {
  window.dispatchEvent(new MessageEvent("message", { data: message }));
};

window.__boot = () => {
  window.__send({ type: "manager.snapshot", state: window.__managerState });
  window.__send({
    type: "conversation.message",
    conversationId: "run-1",
    message: { type: "state.snapshot", state: window.__panelState },
  });
};

window.__boot();
