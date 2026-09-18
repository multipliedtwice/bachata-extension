/*
 * Demo scenes for the documentation screenshots. The UI is the real dist/webview.js; the run data
 * below is invented demo content for a fictional "demo-shop" repository and is labelled as such on
 * the site. Base states come from the layout fixture so this file only states what differs.
 */
const at = "2026-09-18T09:30:00.000Z";
const later = "2026-09-18T09:41:00.000Z";
const reviewHash = "d".repeat(64);
const clone = (value) => structuredClone(value);

const loadJson = async (path) => (await fetch(path)).json();

const applyTheme = async (name) => {
  const colors = await loadJson("../../tests/fixtures/webview-layout/theme-colors.json");
  const root = document.documentElement;
  for (const property of [...root.style]) if (property.startsWith("--vscode-")) root.style.removeProperty(property);
  for (const [key, value] of Object.entries(colors[name])) root.style.setProperty(`--vscode-${key.replaceAll(".", "-")}`, value);
  document.body.style.background = colors[name]["editor.background"];
  document.body.style.color = colors[name]["editor.foreground"];
};

const pipelineSummaries = [
  ["review", "Code review", 1, ["Reviewer"], 1],
  ["review-only", "Code review — reconcile findings", 2, ["Reviewer 1", "Reviewer 2"], 3],
  ["fix", "Fix a bug", 1, ["Implementer"], 2],
  ["implementation-plan", "Implementation plan", 1, ["Planner"], 1],
  ["ui-ux-review", "UI/UX review", 2, ["Usability reviewer", "Accessibility reviewer"], 2],
  ["code-review-refine", "Code review and refinement", 2, ["Implementer", "Independent reviewer"], 7],
].map(([id, name, participantCount, participantNames, stepCount]) => ({
  id, name, editable: false, builtIn: true, hash: id === "review-only" ? reviewHash : id.padEnd(64, "0").slice(0, 64),
  scopeKey: "workspace:/Users/demo/demo-shop", scopeRoot: "/Users/demo/demo-shop", participantCount, participantNames, stepCount,
}));

const assignments = {
  slots: [
    { agentId: "reviewer-1", responsibility: "Reviewer 1", roleId: "reviewer-1", defaultAdapter: "codex-app-server", assignedAdapter: "codex-app-server", overridden: false },
    { agentId: "reviewer-2", responsibility: "Reviewer 2", roleId: "reviewer-2", defaultAdapter: "claude-code", assignedAdapter: "claude-code", overridden: false },
  ],
  assignableAdapters: ["codex-app-server", "claude-code", "chatgpt-browser", "claude-browser", "generic-browser"],
  availableAdapters: ["codex-app-server", "claude-code", "chatgpt-browser", "claude-browser"],
  discovering: false,
  adapterModels: {},
};

const reviewContract = {
  pipelineId: "review-only",
  pipelineName: "Code review — reconcile findings",
  safetyLevel: "review",
  providers: [
    { agentId: "reviewer-1", name: "Reviewer 1", adapter: "codex-app-server", adapterLabel: "Codex", roles: ["Reviewer 1"], status: "ready" },
    { agentId: "reviewer-2", name: "Reviewer 2", adapter: "claude-code", adapterLabel: "Claude Code", roles: ["Reviewer 2"], status: "ready" },
  ],
  roles: [],
  scope: { workingDirectory: "/Users/demo/demo-shop", writeScope: "readOnly", writablePaths: [], readablePaths: ["src/checkout"], protectedPaths: [".env", ".git"] },
  commitPolicy: "never",
  verification: [],
  verificationResources: [],
  humanGates: [],
  limits: { iterations: 1, maxIterations: 10, iterationMode: "fixed", consensusSteps: [{ stepId: "reconcile", stepName: "Reconcile findings", maxRounds: 10, roundLimitRetryable: false }] },
  assurance: "readOnly",
  assuranceLabel: "Read-only",
  assuranceStatement: "This run can read the selected scope and cannot change files.",
  fallbacks: [],
  completion: ["Ends after one pass. A finished pass is not proof the code is correct."],
  blockers: [],
  outboundContext: ["reviewer-1", "reviewer-2"].map((agentId, index) => ({
    agentId,
    name: `Reviewer ${index + 1}`,
    adapterLabel: index === 0 ? "Codex" : "Claude Code",
    transport: "local CLI",
    entries: [
      { kind: "prompt", label: "Your request", detail: "The text you type in the composer", exact: true },
      { kind: "files", label: "src/checkout", detail: "Files the provider may read in this folder", exact: false },
    ],
    exclusions: [".env", ".git"],
    redactions: [],
  })),
};

const findings = [
  {
    id: "F1", subject: "Discount applied twice on retry", severity: "error", disposition: "accepted",
    message: "applyCoupon runs again when the payment step retries, so the order total is reduced twice.",
    location: { file: "src/checkout/applyCoupon.ts", startLine: 42 },
    evidence: ["retryPayment() calls buildOrder(), which calls applyCoupon() without checking order.couponApplied."],
    challenges: ["Reviewer 2 checked whether the idempotency key prevents it; it covers the charge, not the total."],
    provenance: { source: "pipelineDecision", stepId: "reconcile", participantIds: ["reviewer-1", "reviewer-2"], decisionStatus: "accepted" },
  },
  {
    id: "F2", subject: "Currency rounding before tax", severity: "warning", disposition: "accepted",
    message: "Line totals are rounded before tax is added, which can differ from the invoice by one cent.",
    location: { file: "src/checkout/totals.ts", startLine: 18 },
    evidence: ["roundCurrency() is called inside the line loop instead of once on the final sum."],
    challenges: ["Reviewer 1 confirmed the invoice service rounds once at the end."],
    provenance: { source: "pipelineDecision", stepId: "reconcile", participantIds: ["reviewer-1", "reviewer-2"], decisionStatus: "accepted" },
  },
  {
    id: "F3", subject: "Should expired carts be kept?", severity: "information", disposition: "unresolved",
    message: "Reviewers disagree whether expired carts should be deleted or archived.",
    location: { file: "src/checkout/cartCleanup.ts", startLine: 7 },
    evidence: ["cartCleanup deletes rows older than 30 days."],
    challenges: ["Reviewer 1: deletion loses analytics history. Reviewer 2: archiving keeps personal data longer."],
    provenance: { source: "pipelineDecision", stepId: "reconcile", participantIds: ["reviewer-1", "reviewer-2"], decisionStatus: "resolved" },
  },
];

const reviewAnswer = (lines) => lines.join("\n");

const baseStates = async () => {
  const definition = await loadJson("../../presets/review-only.pipeline.json");
  const conversation = {
    id: "run-1", runRef: "R0007", title: "[R0007] Review checkout discounts", iterationCount: 1, activeIteration: 0,
    createdAt: at, updatedAt: later, running: false, workflowStatus: "completed", unread: 0, archived: false,
    selectedPipelineId: "review-only", selectedPipelineHash: reviewHash, pipelineScopeRoot: "/Users/demo/demo-shop",
    participants: [
      { name: "Reviewer 1", adapter: "codex-app-server", agentId: "reviewer-1" },
      { name: "Reviewer 2", adapter: "claude-code", agentId: "reviewer-2" },
    ],
  };
  const others = [
    { ...conversation, id: "run-2", runRef: "R0006", title: "[R0006] Plan: guest checkout", workflowStatus: "completed", selectedPipelineId: "implementation-plan", updatedAt: at },
    { ...conversation, id: "run-3", runRef: "R0005", title: "[R0005] Fix: coupon double apply", workflowStatus: "idle", selectedPipelineId: "fix", updatedAt: at },
  ];
  const manager = {
    ...clone(window.__managerState),
    conversations: [conversation, ...others],
    activeConversationId: "run-1",
    notifications: { mode: "material", unread: 0, events: [] },
    eventsByConversation: {
      "run-1": [
        { id: 1, type: "run.started", status: "running", title: conversation.title, createdAt: at },
        ...definition.steps.map((step, index) => ({ id: 2 + index, type: "step.started", status: "running", title: step.name, payload: { stepId: step.id, index }, createdAt: at })),
        { id: 9, type: "run.completed", status: "completed", title: "Run completed", createdAt: later },
      ],
    },
    resultsByConversation: {
      "run-1": {
        status: "completed",
        changedFiles: [],
        checks: [],
        providers: conversation.participants,
        findings,
        finalRuling: "Two findings accepted after challenge. One disagreement needs your decision.",
        rulingProvenance: { kind: "unanimousConsensus", participants: conversation.participants.map(({ name, adapter, agentId }) => ({ name, adapter, agentId })) },
        consensusRuling: true,
        unresolvedRisks: ["Reviewers disagree on whether expired carts are deleted or archived."],
        recoveredErrors: [],
        evidence: [
          { kind: "changedFiles", label: "Changed files", state: "notApplicable", detail: "Read-only run; no files changed." },
          { kind: "verification", label: "Verification", state: "notApplicable", detail: "Read-only review runs no repository checks." },
          { kind: "finalRuling", label: "Final ruling", state: "recorded", detail: "Unanimous consensus in round 2." },
        ],
        evidenceGaps: ["No repository test was run. A model saying the code is correct is not a check."],
        finalAssessment: {
          outcome: "completed",
          method: "consensus",
          summary: "Both reviewers reached the same finding set in round 2 of 10.",
          producedBy: conversation.participants,
        },
        continuation: { available: true, resultVersion: "demo", pipelineId: "fix", pipelines: [{ id: "fix", name: "Fix a bug" }, { id: "code-review-refine", name: "Code review and refinement" }] },
        readableMarkdown: "# Run result",
      },
    },
    conversationLocators: {},
  };
  const panel = {
    ...clone(window.__panelState),
    taskId: "run-1",
    workspaceRoots: ["/Users/demo/demo-shop"],
    pipelines: pipelineSummaries,
    selectedPipelineId: "review-only",
    selectedPipelineHash: reviewHash,
    selectedPipelineDefinition: definition,
    pipelineScopeKey: "workspace:/Users/demo/demo-shop",
    pipelineScopeRoot: "/Users/demo/demo-shop",
    pipelineMutable: true,
    advancedMode: false,
    agents: {
      "reviewer-1": { id: "reviewer-1", name: "Reviewer 1", adapterType: "codex-app-server", status: "idle", output: "" },
      "reviewer-2": { id: "reviewer-2", name: "Reviewer 2", adapterType: "claude-code", status: "idle", output: "" },
    },
    agentAssignments: assignments,
    executionContract: reviewContract,
    readiness: { status: "ready", findings: [] },
    workflowStatus: "completed",
    transcript: [
      { id: "u1", kind: "prompt", eventType: "user.message", text: "Review src/checkout for bugs in how discounts and totals are calculated.", createdAt: at },
      { id: "a1", kind: "answer", agentId: "reviewer-1", step: "Independent review", text: reviewAnswer([
        "I found two problems in `src/checkout`:",
        "",
        "1. **Discount applied twice on retry** — `applyCoupon.ts:42`. `retryPayment()` rebuilds the order and applies the coupon again.",
        "2. **Currency rounding before tax** — `totals.ts:18`. Each line is rounded before tax is added.",
        "",
        "I also think `cartCleanup.ts` should archive expired carts instead of deleting them.",
      ]), createdAt: at },
      { id: "a2", kind: "answer", agentId: "reviewer-2", step: "Independent review", text: reviewAnswer([
        "I agree with the double discount. The idempotency key protects the charge, not the order total.",
        "",
        "I confirm the rounding issue: the invoice service rounds once, at the end.",
        "",
        "I disagree about archiving carts: archived carts keep personal data longer than the privacy policy allows.",
      ]), createdAt: later },
      { id: "a3", kind: "answer", agentId: "reviewer-1", step: "Reconcile findings", text: "Round 2: I accept both confirmations. The cart retention question is a product decision, so I mark it unresolved for the user.", createdAt: later },
    ],
    transcriptTotal: 4,
  };
  delete panel.resumableWorkflow;
  return { manager, panel, definition };
};

const send = (manager, panel) => {
  window.__send({ type: "manager.snapshot", state: manager });
  window.__send({ type: "conversation.message", conversationId: manager.activeConversationId, message: { type: "state.snapshot", state: panel } });
};

const click = (selector) => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`missing ${selector}`);
  element.click();
  return element;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

window.__scenes = {
  async composer() {
    const { manager, panel } = await baseStates();
    const draft = { ...manager.conversations[0], id: "draft-1", runRef: "R0008", title: "[R0008] New run", workflowStatus: "idle" };
    send({ ...manager, conversations: [draft, ...manager.conversations], activeConversationId: "draft-1" }, { ...panel, taskId: "draft-1", workflowStatus: "idle", transcript: [], transcriptTotal: 0 });
    await settle();
    const prompt = document.getElementById("composer-prompt");
    prompt.value = "Review src/checkout for bugs in how discounts and totals are calculated.";
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  },
  async contract() {
    await this.composer();
    await settle();
    click(".composer-settings-button");
  },
  async pipelinePicker() {
    await this.composer();
    await settle();
    click("#pipeline-picker-button");
  },
  async agents() {
    await this.composer();
    await settle();
    click('[data-action="agents-picker-toggle"]');
  },
  async bridgePairing() {
    await this.agentsBrowser({ enabled: true, connected: false, connectionState: "disconnected", endpoint: "ws://127.0.0.1:43127/bachata-browser-bridge-v9", pairingToken: "demo-token-not-real-0000000000000000000000", sessions: [] });
    await settle();
    click('[data-action="agents-bridge-toggle"]');
  },
  async agentsBrowser(bridgeOverride) {
    const { manager, panel } = await baseStates();
    const draft = { ...manager.conversations[0], id: "draft-1", runRef: "R0008", title: "[R0008] New run", workflowStatus: "idle" };
    const slots = panel.agentAssignments.slots.map((slot) => slot.agentId === "reviewer-2"
      ? { ...slot, assignedAdapter: "chatgpt-browser", browserSessionId: "session-1", overridden: true }
      : slot);
    const browserBridge = {
      enabled: true,
      connected: true,
      sessions: [
        { id: "session-1", provider: "chatgpt", tabId: 7, conversationIdentity: "demo-1", title: "Checkout review", status: "ready" },
        { id: "session-2", provider: "claude", tabId: 8, conversationIdentity: "demo-2", title: "Second opinion", status: "ready" },
      ],
    };
    send({ ...manager, conversations: [draft, ...manager.conversations], activeConversationId: "draft-1" },
      { ...panel, taskId: "draft-1", workflowStatus: "idle", transcript: [], transcriptTotal: 0, browserBridge: bridgeOverride ?? browserBridge, agentAssignments: { ...panel.agentAssignments, slots } });
    await settle();
    click('[data-action="agents-picker-toggle"]');
  },
  async transcript() {
    const { manager, panel } = await baseStates();
    send(manager, panel);
  },
  async execution() {
    await this.transcript();
    await settle();
    click('.run-tab.selected [data-action="room-view"][data-view="execution"]');
  },
  async direction() {
    const { manager, panel } = await baseStates();
    const retold = [
      ["Cancellation never leaks a worktree", "Checkout totals are always correct"],
      ["Every cancel path is proven", "Every discount and tax path is covered by a test"],
      ["Guard the cleanup path in the controller", "Apply each coupon once per order"],
      ["No leaked worktree after cancel", "Retrying payment never changes the total"],
      ["No new dependencies", "No change to the public checkout API"],
      ["Should cancelled runs retry automatically?", "Should expired carts be deleted or archived?"],
      ["Retry policy", "Cart retention"],
      ["Automatic retries hide flakiness", "Archiving keeps personal data longer; deleting loses analytics history"],
      ["src/orchestrator", "src/checkout"],
      ["The retry loop never terminates", "Free shipping threshold ignores discounted total"],
      ["Retry loop", "Shipping threshold"],
      ["Cancellation bypasses cleanup", "applyCoupon runs again when payment retries"],
      ["Cancellation guard", "Discount applied twice on retry"],
      ["The worktree survives a cancel", "Rounding before tax differs from the invoice"],
      ["Worktree leak", "Currency rounding before tax"],
      ["Cancellation ownership", "Where totals are computed"],
      ["src/a.ts", "src/checkout/applyCoupon.ts"],
    ];
    let text = JSON.stringify(await loadJson("../../tests/fixtures/webview-layout/direction.json"));
    for (const [from, to] of retold) text = text.replaceAll(from, to);
    const direction = JSON.parse(text);
    send({ ...manager, direction }, panel);
    await settle();
    if (!document.getElementById("run-drawer")) click('[data-action="run-drawer-toggle"]');
    click(".run-drawer-direction");
  },
  async editor() {
    await this.composer();
    await settle();
    click('[data-action="pipeline-edit"]');
  },
};

window.__show = async (scene, theme = "dark") => {
  await applyTheme(theme);
  await window.__scenes[scene]();
  await settle();
  return document.getElementById("root").innerText.slice(0, 300);
};
