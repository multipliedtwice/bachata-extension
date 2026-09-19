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
    availableAdapters: [
      "codex-app-server",
      "claude-code",
      "chatgpt-browser",
      "claude-browser",
      "generic-browser",
    ],
    discovering: false,
    // A provider that reported its models and one that cannot be asked, so the popover is
    // measured with both the model list and the explicit model field present.
    adapterModels: {
      "codex-app-server": {
        status: "listed",
        models: [
          {
            id: "gpt-5.6-sol",
            label: "GPT-5.6-Sol",
            isDefault: true,
            defaultReasoningEffort: "medium",
            reasoningEfforts: [
              { id: "low", description: "Faster" },
              { id: "medium", description: "Balanced" },
              { id: "high", description: "More reasoning" },
            ],
          },
          { id: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
          { id: "gpt-5.5", label: "GPT-5.5" },
        ],
      },
      "claude-code": {
        status: "unsupported",
        models: [],
        detail: "This provider does not report a model list, so a model name is taken as written.",
      },
    },
  },
  // One ready local model and one off, so the Agents popover is measured with both states present.
  localModels: {
    semanticInterpreter: {
      enabled: false,
      discovering: false,
      status: "disabled",
      detail: "Off. Explicit bachata-action blocks and built-in pattern matching only.",
      explicit: false,
      availableModels: [],
    },
    selectorHealing: {
      enabled: true,
      discovering: false,
      status: "ready",
      detail: "qwen2.5-coder:7b on http://127.0.0.1:11434",
      backend: "ollama",
      backendLabel: "Ollama",
      endpoint: "http://127.0.0.1:11434",
      model: "qwen2.5-coder:7b",
      explicit: false,
      availableModels: [
        { id: "qwen2.5-coder:7b", backend: "ollama", availability: "loaded" },
        { id: "deepseek-r1:8b", backend: "ollama", availability: "installed" },
      ],
    },
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

/*
 * A stopped run, for the execution view: a four-step pipeline, the events that prove where it got
 * to, the failure it stopped on, the checkpoint it left, and the provider locators. Measured at
 * every width because this is the view a reader is in when a run has gone wrong, and it carries
 * the widest content the product draws — step rows, a failure block and two recovery actions.
 */
const executionPipelineDefinition = {
  ...pipelineDefinition,
  id: "custom-b",
  name: "Implement and review",
  agents: [
    { id: "lead", name: "Lead", adapter: "codex-app-server" },
    { id: "builder", name: "Builder", adapter: "claude-code" },
  ],
  steps: [
    { id: "plan", name: "Plan the change", enabled: true, humanGate: "none", type: "agent", participants: ["lead"], promptTemplate: "{{userPrompt}}", parallel: false, consensus: false, attachments: "selected" },
    { id: "implement", name: "Implement the change and record every repository verification command it ran", enabled: true, humanGate: "none", type: "agent", participants: ["builder"], promptTemplate: "{{userPrompt}}", parallel: false, consensus: false, attachments: "selected" },
    { id: "review", name: "Independent specialist review", enabled: true, humanGate: "none", type: "agent", participants: ["lead", "builder"], promptTemplate: "{{userPrompt}}", parallel: true, consensus: true, attachments: "selected" },
    { id: "sign-off", name: "Sign off", enabled: true, humanGate: "none", type: "agent", participants: ["lead"], promptTemplate: "{{userPrompt}}", parallel: false, consensus: false, attachments: "selected" },
  ],
};

const providerError =
  "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";

// The event rows below are the shape `catalogViews.catalogEventView` actually sends: a bounded,
// redacted projection of what each event recorded, never a raw provider payload. That the manager
// really produces this shape is proved with the real projection in `tests/webviewDom.test.cjs`;
// here the rows are written out so this fixture stays a layout fixture with no manager in it.
window.__executionManagerState = {
  ...window.__managerState,
  eventsByConversation: {
    "run-1": [
      { id: 1, type: "run.started", status: "running", title: "Clean fixture", createdAt: timestamp },
      { id: 2, type: "step.started", status: "running", title: "Plan the change", payload: { stepId: "plan", index: 0 }, createdAt: timestamp },
      { id: 3, type: "output.validated", status: "completed", title: "plan", payload: { agentId: "lead", hash: "c".repeat(64) }, createdAt: timestamp },
      { id: 4, type: "step.started", status: "running", title: "Implement the change and record every repository verification command it ran", payload: { stepId: "implement", index: 1 }, createdAt: timestamp },
      { id: 5, type: "iteration.failed", status: "failed", title: "Iteration 1 failed", payload: { message: providerError }, createdAt: timestamp },
      // A step's own recorded detail: filed under the step, titled something other than the step's
      // own name, and carrying the bounded projection the step's "Technical detail" disclosure
      // renders. Without one the disclosure has nothing to draw and the layout of an expanded step
      // goes unmeasured.
      { id: 6, type: "provider.failure", status: "failed", title: "Codex could not start", payload: { stepId: "implement", adapter: "codex-app-server", model: "gpt-6-astra", attempt: 1, exitCode: 1, error: providerError }, createdAt: timestamp },
    ],
  },
  resultsByConversation: {
    "run-1": {
      status: "error",
      changedFiles: [],
      checks: [],
      providers: [{ agentId: "builder", name: "Builder", adapter: "codex-app-server", model: "gpt-6-astra" }],
      findings: [],
      unresolvedRisks: [providerError],
      recoveredErrors: [],
      evidence: [],
      evidenceGaps: [],
      finalAssessment: {
        outcome: "failedBeforeRuling",
        method: "none",
        summary: `Failed before final ruling: Builder (codex-app-server · gpt-6-astra) — ${providerError}`,
        producedBy: [],
        failure: {
          error: providerError,
          agentId: "builder",
          participant: "Builder",
          adapter: "codex-app-server",
          provider: "codex-app-server",
          model: "gpt-6-astra",
          step: "Implement the change and record every repository verification command it ran",
        },
      },
    },
  },
  conversationLocators: {
    "run-1": [
      {
        role: "Builder",
        provider: "Codex",
        adapter: "codex-app-server",
        reconstruction: "available",
        reconstructionDetail: "Codex keeps this conversation under its own rollout directory on this machine.",
        lastSeenAt: timestamp,
      },
    ],
  },
};

window.__executionPanelState = {
  ...window.__panelState,
  selectedPipelineId: "custom-b",
  selectedPipelineDefinition: executionPipelineDefinition,
  workflowStatus: "error",
  transcript: [
    { id: "user-1", kind: "prompt", eventType: "user.message", text: "Add the feature and prove it", createdAt: timestamp },
    { id: "prompt-1", kind: "prompt", agentId: "lead", step: "Independent specialist analysis", eventType: "agent.prompt", text: "AGENT PROMPT · INDEPENDENT SPECIALIST ANALYSIS", createdAt: timestamp },
    { id: "prompt-2", kind: "prompt", agentId: "builder", step: "Independent specialist analysis", eventType: "agent.prompt", text: "AGENT PROMPT · INDEPENDENT SPECIALIST ANALYSIS", createdAt: timestamp },
    { id: "answer-1", kind: "answer", agentId: "lead", text: "Planned the change", createdAt: timestamp },
    { id: "error-1", kind: "error", eventType: "provider.failure", step: "Implement", text: providerError, data: { code: "protocolError", provider: "codex-app-server", retryable: false, evidence: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"' + providerError + '"}}' }, createdAt: timestamp },
  ],
  transcriptTotal: 5,
  resumableWorkflow: {
    attemptId: "attempt-1",
    outcome: "failed",
    failureScope: "step",
    stepName: "Implement the change and record every repository verification command it ran",
    pipelineId: "custom-b",
    pipelineName: "Implement and review",
    pipelineHash: "b".repeat(64),
    userPrompt: "Add the feature and prove it",
    attachmentIds: [],
    nextStepIndex: 1,
    totalSteps: 4,
    updatedAt: timestamp,
  },
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

window.__bootExecution = () => {
  window.__send({ type: "manager.snapshot", state: window.__executionManagerState });
  window.__send({
    type: "conversation.message",
    conversationId: "run-1",
    message: { type: "state.snapshot", state: window.__executionPanelState },
  });
};

window.__bootPristine = () => {
  const draft = {
    ...conversationSummary,
    id: "draft-1",
    runRef: "RNEW00001",
    title: "[RNEW00001] New run",
  };
  window.__send({
    type: "manager.snapshot",
    state: {
      ...window.__managerState,
      conversations: [draft],
      activeConversationId: draft.id,
      eventsByConversation: {},
      resultsByConversation: {},
    },
  });
  window.__send({
    type: "conversation.message",
    conversationId: draft.id,
    message: { type: "state.snapshot", state: { ...window.__panelState, taskId: draft.id } },
  });
};

window.__boot();
