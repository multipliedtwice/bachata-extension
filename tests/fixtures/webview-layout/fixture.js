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
  }],
  selectedPipelineId: "custom-a",
  selectedPipelineHash: customAHash,
  pipelineScopeKey: "workspace:/workspace",
  pipelineScopeRoot: "/workspace",
  selectedPipelineDefinition: pipelineDefinition,
  adapterTypes: ["codex-app-server"],
  agents: {
    lead: { id: "lead", name: "Lead", adapterType: "codex-app-server", status: "idle", output: "" },
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
  browserBridge: { enabled: true, connected: false, sessions: [] },
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
