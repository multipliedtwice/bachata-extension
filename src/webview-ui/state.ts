/**
 * Webview state and its accessors.
 *
 * Concatenated after types.ts and before the renderers (tsconfig.webview.json, module: none,
 * outFile). Every renderer reads state through the accessors here, so the store is declared
 * once and before anything that reads it.
 */

const vscode = acquireVsCodeApi();
const rootElement = document.getElementById("root");
const liveStatusElement = document.getElementById("bachata-live-status");
if (!rootElement || !liveStatusElement) {
  throw new Error("Missing webview root elements");
}
// Narrowed once, at the declaration, so every concatenated module sees a non-null element
// rather than re-proving it.
const root: HTMLElement = rootElement;
const liveStatus: HTMLElement = liveStatusElement;
let lastStatusAnnouncement = "";
let lastStatusAnnouncedAt = 0;
// A repeated event is still an event: a second approval request reads the same sentence as the
// first, so only an immediate echo of the same render burst is suppressed.
const STATUS_REPEAT_WINDOW_MS = 1000;
const STATUS_CLEAR_MS = 10_000;
let statusClearTimer: ReturnType<typeof setTimeout> | undefined;
const announceStatus = (message: string): void => {
  const normalized = message.trim();
  const now = Date.now();
  if (
    !normalized ||
    (normalized === lastStatusAnnouncement && now - lastStatusAnnouncedAt < STATUS_REPEAT_WINDOW_MS)
  ) {
    return;
  }
  lastStatusAnnouncement = normalized;
  lastStatusAnnouncedAt = now;
  liveStatus.textContent = "";
  requestAnimationFrame(() => {
    liveStatus.textContent = normalized;
  });
  // The sentence has been read by then; left in place it is stale text a reader can land on.
  if (statusClearTimer !== undefined) clearTimeout(statusClearTimer);
  statusClearTimer = setTimeout(() => {
    if (liveStatus.textContent === normalized) liveStatus.textContent = "";
  }, STATUS_CLEAR_MS);
};

/**
 * Live regions that a render rebuilt without changing them.
 *
 * render() replaces the whole tree, so every role="alert" and role="status" region is inserted
 * again on each pass and a screen reader reads it again with it. An explicit aria-live="off"
 * overrides the role's implicit live value while the content is unchanged, so the region keeps
 * its place in the accessibility tree and announces once, when what it says is new.
 */
let announcedLiveRegions = new Map<string, string>();
let renderedLiveRegions = new Map<string, string>();

const beginLiveRegionPass = (): void => {
  announcedLiveRegions = renderedLiveRegions;
  renderedLiveRegions = new Map<string, string>();
};

const liveRegionAttributes = (key: string, role: "alert" | "status", content: string): string => {
  renderedLiveRegions.set(key, content);
  return announcedLiveRegions.get(key) === content
    ? `role="${role}" aria-live="off"`
    : `role="${role}"`;
};

const fieldErrorSlotId = (fieldId: string): string => `${fieldId}-error`;

const workflowAnnouncement = (status: WorkflowStatus): string | undefined => {
  if (status === "running") return "Run started.";
  if (status === "paused") return "Run paused.";
  if (status === "completed") return "Run completed.";
  if (status === "interrupted") return "Run interrupted.";
  if (status === "error") return "Run failed.";
  return undefined;
};

const announceRunTransition = (
  previousRunning: boolean,
  previousStatus: WorkflowStatus,
  running: boolean,
  status: WorkflowStatus,
): void => {
  if (!previousRunning && running) {
    announceStatus("Run started.");
    return;
  }
  if (previousStatus !== status) {
    const announcement = workflowAnnouncement(status);
    if (announcement) announceStatus(announcement);
  }
};

const emptyPanel = (): PanelState => ({
  taskId: "",
  workspaceRoots: [],
  trusted: false,
  pipelines: [],
  pipelineScopeKey: "extension",
  adapterTypes: [],
  agents: {},
  roles: {},
  running: false,
  workflowStatus: "idle",
  transcript: [],
  transcriptTotal: 0,
  transcriptHasMore: false,
  transcriptWindowSize: 300,
  approvals: [],
  attachments: [],
  maxAttachmentBytes: 20_971_520,
  maxAttachmentCount: 20,
  maxAttachmentTotalBytes: 52_428_800,
  pipelineMutable: true,
  advancedMode: false,
  browserActionPolicies: { readOnly: "ask", mutation: "ask", destructive: "ask", shell: "disabled" },
  browserBridge: { enabled: true, connected: false, sessions: [] },
  queuedMessages: [],
  queuePaused: false,
});

const state: {
  hydrated: boolean;
  manager: ManagerState;
  panels: Map<string, PanelState>;
  drafts: Map<string, ConversationDraft>;
  errors: Map<string, string>;
  // Keyed by the id of the control that was refused, so a refusal survives the next render
  // instead of living only in the DOM node a background snapshot replaces.
  fieldErrors: Map<string, string>;
  managerError?: string;
  roomSearch: string;
  historyMatches: Set<string>;
  historySearchRequestId?: string;
  historySearchQuery?: string;
  historyResultsTruncated?: boolean;
  historyResultQuery?: string;
  showArchived: boolean;
  runDrawerOpen: boolean;
  inspectorOpen: boolean;
  composerOptionsOpen: boolean;
  roomView: "chat" | "execution" | "direction";
  historyFilter: string;
  directionRationale: string;
  directionEvidence: string;
  editorOpen: boolean;
  editorConversationId?: string;
  editorMode: "form" | "json";
  editorDraft?: PipelineDefinition;
  editorSourcePipelineId?: string;
  editorSourcePipelineName?: string;
  editorSourcePipelineHash?: string;
  editorPipelineScopeKey?: string;
  editorRaw: string;
  editorOriginalRaw: string;
  editorErrors: string[];
  editorOutputSchemas: Map<string, string>;
  expandedEditorCards: Set<string>;
  collapsedEditorSections: Set<string>;
  disclosureStates: Map<string, boolean>;
  pendingEditorOperation?: PendingEditorOperation;
  pendingRuns: Map<string, PendingRunRequest>;
  pendingPipelineSelections: Map<string, { conversationId: string; pipelineId: string }>;
  pendingInteractions: Set<string>;
  pendingApprovals: Set<string>;
  secretDrafts: Map<string, string>;
  pausedSecretInteractions: Set<string>;
  dragging?: { kind: "agent" | "role" | "step"; index: number };
  dialog?: AppDialog;
  dialogReturnFocusSelector?: string;
  editorReturnFocusSelector?: string;
} = {
  hydrated: false,
  manager: {
    conversations: [],
    activeConversationId: "",
    defaultPipelineIterations: 1,
    maxPipelineIterations: 10,
    interactions: [],
    eventsByConversation: {},
    resultsByConversation: {},
    orchestration: { active: false, masterChecks: [], tasks: [], finalChecks: [], retainedRuns: [] },
    notifications: { mode: "material", unread: 0, events: [] },
    conversationLocators: {},
    direction: {
      cycles: [],
      artifacts: [],
      externalEvidence: [],
      staleExternalEvidenceIds: [],
      decisions: [],
      findings: [],
      saturation: { saturated: false, quietFreshReviews: 0, quietReviewSignal: 2, signalReached: false, reasons: [] },
      direction: {
        acceptanceCriteria: [],
        constraints: [],
        acceptedArtifacts: [],
        proposedArtifacts: [],
        decisionsNeedingHuman: [],
        outstandingAcceptedFindings: [],
        unresolvedFindings: [],
        saturation: { saturated: false, quietFreshReviews: 0, quietReviewSignal: 2, signalReached: false, reasons: [] },
        saturationDisclaimer: "",
        nextAction: { kind: "defineInitiative", label: "State what this work is trying to achieve", detail: "" },
      },
    },
  },
  panels: new Map(),
  drafts: new Map(),
  errors: new Map(),
  fieldErrors: new Map(),
  roomSearch: "",
  historyMatches: new Set(),
  showArchived: false,
  runDrawerOpen: false,
  inspectorOpen: false,
  composerOptionsOpen: false,
  roomView: "chat",
  historyFilter: "",
  directionRationale: "",
  directionEvidence: "",
  editorOpen: false,
  editorMode: "form",
  editorRaw: "",
  editorOriginalRaw: "",
  editorErrors: [],
  editorOutputSchemas: new Map(),
  expandedEditorCards: new Set(),
  collapsedEditorSections: new Set(["details", "guardrails", "agents", "roles"]),
  disclosureStates: new Map(),
  pendingRuns: new Map(),
  pendingPipelineSelections: new Map(),
  pendingInteractions: new Set(),
  pendingApprovals: new Set(),
  secretDrafts: new Map(),
  pausedSecretInteractions: new Set(),
};

type RunDiffState = { files: RunPatchFile[]; truncated?: string; bytes: number };
type ResultSelectionState = {
  conversationId: string;
  files: Set<string>;
  hunks: Map<string, Set<number>>;
  diff?: RunDiffState;
};

const RESULT_SELECTION_LIMIT = 8;
const RESULT_DIFF_BYTE_LIMIT = 8 * 1_048_576;

const resultSelections = new Map<string, ResultSelectionState>();

const selectionKey = (conversationId: string, runId: string): string =>
  `${conversationId}\u0000${runId}`;

const retainedDiffBytes = (): number =>
  Array.from(resultSelections.values()).reduce(
    (total, entry) => total + (entry.diff?.bytes ?? 0),
    0,
  );

const evictResultSelections = (protectedKey: string): void => {
  while (resultSelections.size > RESULT_SELECTION_LIMIT) {
    const oldest = Array.from(resultSelections.keys()).find((key) => key !== protectedKey);
    if (oldest === undefined) break;
    resultSelections.delete(oldest);
  }
  while (retainedDiffBytes() > RESULT_DIFF_BYTE_LIMIT) {
    const oldest = Array.from(resultSelections.entries())
      .find(([key, entry]) => key !== protectedKey && entry.diff !== undefined);
    if (!oldest) break;
    delete oldest[1].diff;
  }
  const kept = resultSelections.get(protectedKey);
  if (kept?.diff && retainedDiffBytes() > RESULT_DIFF_BYTE_LIMIT) {
    kept.diff = {
      files: [],
      bytes: 0,
      truncated: "This run's diff is larger than the panel keeps in memory. Export the patch to review it, or apply the whole run.",
    };
  }
};

const resultSelection = (
  conversationId: string,
  runId: string | undefined,
): ResultSelectionState => {
  const key = selectionKey(conversationId, runId ?? "");
  const existing = resultSelections.get(key);
  if (existing) return existing;
  const created: ResultSelectionState = {
    conversationId,
    files: new Set<string>(),
    hunks: new Map<string, Set<number>>(),
  };
  resultSelections.set(key, created);
  evictResultSelections(key);
  return created;
};

const knownResultPaths = (conversationId: string): Set<string> =>
  new Set(state.manager.resultsByConversation?.[conversationId]?.changedFiles ?? []);

const selectedResultPaths = (
  conversationId: string,
  runId: string | undefined,
): string[] => {
  const known = knownResultPaths(conversationId);
  return Array.from(resultSelection(conversationId, runId).files).filter((path) => known.has(path));
};

const selectedHunkReferences = (
  conversationId: string,
  runId: string | undefined,
): Array<{ path: string; index: number }> => {
  const entry = resultSelection(conversationId, runId);
  const known = knownResultPaths(conversationId);
  const files = new Set(selectedResultPaths(conversationId, runId));
  const inventory = new Map((entry.diff?.files ?? []).map((file) => [file.path, file.hunks.length]));
  return Array.from(entry.hunks.entries())
    .filter(([path]) => known.has(path) && !files.has(path) && inventory.has(path))
    .flatMap(([path, indexes]) => Array.from(indexes)
      .filter((index) => index < (inventory.get(path) ?? 0))
      .map((index) => ({ path, index })));
};

const pruneResultSelections = (
  conversations: Array<{ id: string; archived?: boolean }>,
): void => {
  const live = new Set(
    conversations.filter((conversation) => conversation.archived !== true)
      .map((conversation) => conversation.id),
  );
  Array.from(resultSelections.entries())
    .filter(([, entry]) => !live.has(entry.conversationId))
    .forEach(([key]) => resultSelections.delete(key));
  evictResultSelections("");
};

/** EX-UI-02. Whether a disclosure is currently open, for a surface that must not repeat it. */
const disclosureOpen = (key: string, defaultOpen = false): boolean =>
  state.disclosureStates.get(`${activeId()}:${key}`) ?? defaultOpen;

const notificationCenterOpen = (): boolean => disclosureOpen("notification-center");

/**
 * What each disclosure was drawn as.
 *
 * Chromium queues a toggle event for a <details> parsed with `open`, so every render of an
 * open card looked like the reader opening it, and a card drawn open once was recorded open for
 * good. A toggle that only repeats what the render emitted is not a choice and is not recorded.
 */
const renderedDisclosures = new Map<string, boolean>();

const disclosureAttributes = (key: string, defaultOpen = false): string => {
  const scopedKey = `${activeId()}:${key}`;
  const open = state.disclosureStates.get(scopedKey) ?? defaultOpen;
  renderedDisclosures.set(scopedKey, open);
  return `data-disclosure-key="${escapeAttribute(scopedKey)}"${open ? " open" : ""}`;
};

const recordDisclosure = (scopedKey: string, open: boolean): void => {
  if (renderedDisclosures.get(scopedKey) === open) return;
  renderedDisclosures.set(scopedKey, open);
  state.disclosureStates.set(scopedKey, open);
};

/**
 * A control that expands a panel rendered only while open. `aria-controls` must name an element
 * that exists, so it is emitted only alongside the panel; a dangling IDREF is an ARIA error and
 * assistive technology drops the relationship rather than reporting it.
 */
const expandedControlAttributes = (open: boolean, panelId: string): string =>
  `aria-expanded="${open ? "true" : "false"}"${open ? ` aria-controls="${escapeAttribute(panelId)}"` : ""}`;

/**
 * Disables a control and says what it is waiting for in the same breath, so a greyed button is
 * never left unexplained. `undefined` leaves the control enabled and unannotated.
 */
const disabledWithReason = (reason: string | undefined): string =>
  reason === undefined ? "" : ` disabled title="${escapeAttribute(reason)}"`;

/**
 * The view state a reader can throw away without losing work.
 *
 * Everything reset here is presentation: which room is open, what is expanded, which drawer is
 * showing. The draft, the transcript, the run and any open pipeline editor draft are untouched,
 * so this is safe to offer as an escape hatch from a view that will not draw.
 */
const resetViewState = (): void => {
  state.roomView = "chat";
  state.runDrawerOpen = false;
  state.inspectorOpen = false;
  state.composerOptionsOpen = false;
  state.roomSearch = "";
  state.historyFilter = "";
  state.expandedEditorCards.clear();
  state.disclosureStates.clear();
  state.fieldErrors.clear();
  delete state.dialog;
  delete state.dialogReturnFocusSelector;
  scheduleRender();
};

const announceManagerTransition = (previous: ManagerState, next: ManagerState): void => {
  if (previous.conversations.length === 0) {
    return;
  }
  const previousConversation = previous.conversations.find(
    (conversation) => conversation.id === next.activeConversationId,
  );
  const nextConversation = next.conversations.find(
    (conversation) => conversation.id === next.activeConversationId,
  );
  if (previousConversation && nextConversation) {
    if (!previousConversation.waitingForResources && nextConversation.waitingForResources) {
      announceStatus("Run is waiting for shared capacity.");
    } else if (previousConversation.waitingForResources && !nextConversation.waitingForResources && nextConversation.running) {
      announceStatus("Shared capacity is available. Run started.");
    } else {
      announceRunTransition(
        previousConversation.running,
        previousConversation.workflowStatus,
        nextConversation.running,
        nextConversation.workflowStatus,
      );
    }
  }

  const previousInteractions = new Set(
    previous.interactions
      .filter((interaction) => interaction.conversationId === next.activeConversationId)
      .map((interaction) => interaction.interactionRef),
  );
  if (next.interactions.some((interaction) =>
    interaction.conversationId === next.activeConversationId &&
    !previousInteractions.has(interaction.interactionRef)
  )) {
    announceStatus("Input is required to continue the run.");
  }

  const previousOrchestrationStatus = previous.orchestration.status;
  const nextOrchestrationStatus = next.orchestration.status;
  if (nextOrchestrationStatus && previousOrchestrationStatus !== nextOrchestrationStatus) {
    const labels: Record<string, string> = {
      running: "TODO execution started.",
      stopping: "TODO execution is stopping.",
      stopped: "TODO execution stopped.",
      completed: "TODO execution completed.",
      blocked: "TODO execution is blocked.",
      failed: "TODO execution failed.",
      abandoning: "TODO execution is being abandoned.",
      cleanupPending: "TODO cleanup needs attention.",
      abandoned: "TODO execution was abandoned.",
    };
    const announcement = labels[nextOrchestrationStatus];
    if (announcement) announceStatus(announcement);
  }
};

const codeBlocks = new Map<string, string>();
let codeBlockSequence = 0;
let renderScheduled = false;


const submitShortcutLabel = ((): string => {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return /mac/i.test(agent) ? "⌘ + Enter" : "Ctrl + Enter";
})();

const relativeTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${String(minutes)}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `${String(hours)}h ago`;
  }
  const days = Math.round(hours / 24);
  if (days < 7) {
    return `${String(days)}d ago`;
  }
  return date.toLocaleDateString();
};

const messageTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};

const activeId = (): string => state.manager.activeConversationId;
const activePanel = (): PanelState => state.panels.get(activeId()) ?? emptyPanel();
const conversationById = (conversationId: string): ConversationSummary | undefined =>
  state.manager.conversations.find((conversation) => conversation.id === conversationId);
const activeConversation = (): ConversationSummary | undefined => conversationById(activeId());

const rootConversationFor = (conversation: ConversationSummary): ConversationSummary => {
  const visited = new Set<string>();
  let current = conversation;
  while (current.parentConversationId && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = conversationById(current.parentConversationId);
    if (!parent) {
      break;
    }
    current = parent;
  }
  return current;
};

const childConversationsFor = (conversationId: string): ConversationSummary[] =>
  state.manager.conversations
    .filter((conversation) =>
      conversation.id !== conversationId &&
      rootConversationFor(conversation).id === conversationId
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

const draftFor = (conversationId: string): ConversationDraft => {
  let draft = state.drafts.get(conversationId);
  if (!draft) {
    const conversation = state.manager.conversations.find((item) => item.id === conversationId);
    const localDraft = restoredDraft(conversationId);
    const preparedPrompt = localDraft ?? conversation?.preparedDraft ?? "";
    if (localDraft !== undefined && localDraft !== conversation?.preparedDraft) {
      vscode.postMessage({
        type: "conversation.saveDraft",
        conversationId,
        text: localDraft,
      });
    }
    draft = {
      prompt: preparedPrompt,
      iterationCount: conversation?.iterationCount ?? state.manager.defaultPipelineIterations,
      iterationMode: "fixed",
      requiredCleanPasses: 2,
      delivery: "immediate",
      selectedAttachmentIds: new Set<string>(),
      pendingAttachments: new Map<string, PendingAttachment>(),
    };
    state.drafts.set(conversationId, draft);
  }
  return draft;
};

let draftSaveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDraftSave: { conversationId: string; text: string } | undefined;

const persistedDrafts = (): Record<string, string> => {
  const stored = vscode.getState?.()?.drafts;
  return stored && typeof stored === "object" && !Array.isArray(stored) ? { ...stored } : {};
};

const rememberDraftLocally = (conversationId: string, text: string): void => {
  if (!vscode.setState) return;
  const drafts = persistedDrafts();
  if (text.trim().length === 0) {
    if (!(conversationId in drafts)) return;
    delete drafts[conversationId];
  } else {
    if (drafts[conversationId] === text) return;
    drafts[conversationId] = text.slice(0, 131_072);
  }
  vscode.setState({ ...vscode.getState?.(), drafts });
};

const forgetDraftLocally = (conversationId: string): void => {
  rememberDraftLocally(conversationId, "");
};

const restoredDraft = (conversationId: string): string | undefined =>
  persistedDrafts()[conversationId];

/**
 * The drafts the host kept while this window was not open.
 *
 * The host posts them once the panel is ready, which is after the reader can already have typed.
 * Text typed in this session is the newer text and the restored copy never replaces it; an empty
 * draft has nothing to lose, so that is the one the host's copy fills.
 */
const restoreDrafts = (drafts: Record<string, string> | undefined): void => {
  let restored = 0;
  Object.entries(drafts ?? {}).forEach(([conversationId, text]) => {
    if (text.length === 0) return;
    if ((state.drafts.get(conversationId)?.prompt ?? "").length > 0) return;
    draftFor(conversationId).prompt = text;
    rememberDraftLocally(conversationId, text);
    restored += 1;
  });
  if (restored > 0) scheduleRender();
};

/**
 * The host also keeps the pipeline editor draft, and it is the only copy a window restored by the
 * panel serializer has. It is seeded into this window's own storage rather than applied directly,
 * so the single restore path below stays the one that decides what a draft becomes.
 */
const restoreHostState = (restored: PersistedWebviewState): void => {
  restoreDrafts(restored.drafts);
  if (!restored.editor || !vscode.setState || persistedEditorDraft()) return;
  vscode.setState({ ...(vscode.getState?.() ?? {}), editor: restored.editor });
};

/**
 * The pipeline draft, kept where a closed tab or a reloaded window cannot take it.
 *
 * Closing the editor from inside the app asks before discarding the draft; closing the tab or
 * reloading the window used to discard it silently. The raw text is stored as the reader left it,
 * unparsable included, alongside the last structurally valid draft the form view needs to draw.
 */
const persistedEditorDraft = (): PersistedEditorDraft | undefined => vscode.getState?.()?.editor;

const rememberEditorLocally = (): void => {
  if (!vscode.setState) return;
  const stored = { ...(vscode.getState?.() ?? {}) };
  if (!state.editorOpen || !state.editorDraft) {
    if (stored.editor === undefined) return;
    delete stored.editor;
    vscode.setState(stored);
    return;
  }
  const editor: PersistedEditorDraft = {
    raw: state.editorRaw,
    draft: safeJson(state.editorDraft),
    mode: state.editorMode,
    originalRaw: state.editorOriginalRaw,
  };
  setOptionalProperty(editor, "conversationId", state.editorConversationId);
  setOptionalProperty(editor, "sourcePipelineId", state.editorSourcePipelineId);
  setOptionalProperty(editor, "sourcePipelineName", state.editorSourcePipelineName);
  setOptionalProperty(editor, "sourcePipelineHash", state.editorSourcePipelineHash);
  setOptionalProperty(editor, "scopeKey", state.editorPipelineScopeKey);
  if (stored.editor !== undefined && safeJson(stored.editor) === safeJson(editor)) return;
  vscode.setState({ ...stored, editor });
};

let editorRestorePending = true;

const restorePersistedEditor = (): void => {
  if (!editorRestorePending) return;
  const stored = persistedEditorDraft();
  const conversationId = stored?.conversationId ?? activeId();
  if (!stored || state.editorOpen) {
    editorRestorePending = false;
    return;
  }
  if (!conversationId || !state.panels.has(conversationId)) return;
  editorRestorePending = false;
  const parsed: unknown = ((): unknown => {
    try {
      return JSON.parse(stored.draft);
    } catch {
      return undefined;
    }
  })();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const draft = parsed as PipelineDefinition;
  if (!Array.isArray(draft.steps) || !Array.isArray(draft.agents)) return;
  state.editorConversationId = conversationId;
  state.editorDraft = draft;
  state.editorRaw = stored.raw;
  state.editorMode = stored.mode;
  state.editorOriginalRaw = stored.originalRaw;
  state.editorErrors = [];
  state.editorOutputSchemas.clear();
  draft.steps.forEach((step) => {
    if (step.type === "agent" && step.output) {
      state.editorOutputSchemas.set(step.id, safeJson(step.output.schema));
    }
  });
  setOptionalProperty(state, "editorSourcePipelineId", stored.sourcePipelineId);
  setOptionalProperty(state, "editorSourcePipelineName", stored.sourcePipelineName);
  setOptionalProperty(state, "editorSourcePipelineHash", stored.sourcePipelineHash);
  setOptionalProperty(state, "editorPipelineScopeKey", stored.scopeKey);
  state.editorOpen = true;
  scheduleRender();
};

const flushDraftSave = (): void => {
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = undefined;
  }
  if (!pendingDraftSave) return;
  const pending = pendingDraftSave;
  pendingDraftSave = undefined;
  vscode.postMessage({
    type: "conversation.saveDraft",
    conversationId: pending.conversationId,
    text: pending.text,
  });
};

const scheduleDraftSave = (conversationId: string, text: string): void => {
  rememberDraftLocally(conversationId, text);
  if (pendingDraftSave && pendingDraftSave.conversationId !== conversationId) {
    flushDraftSave();
  }
  pendingDraftSave = { conversationId, text };
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(flushDraftSave, 500);
};

const discardPreparedDraft = (conversationId: string): void => {
  forgetDraftLocally(conversationId);
  if (pendingDraftSave?.conversationId === conversationId) {
    pendingDraftSave = undefined;
    if (draftSaveTimer) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = undefined;
    }
  }
  const conversation = state.manager.conversations.find((item) => item.id === conversationId);
  if (conversation) delete conversation.preparedDraft;
  vscode.postMessage({ type: "conversation.consumePreparedDraft", conversationId });
};

const cancelDraftSave = (conversationId: string): void => {
  forgetDraftLocally(conversationId);
  if (pendingDraftSave?.conversationId !== conversationId) return;
  pendingDraftSave = undefined;
  if (draftSaveTimer) {
    clearTimeout(draftSaveTimer);
    draftSaveTimer = undefined;
  }
};

const activeDraft = (): ConversationDraft => draftFor(activeId());

const rootRuns = (): ConversationSummary[] =>
  state.manager.conversations
    .filter((conversation) => !conversation.parentConversationId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));


const longitudinalState = (): LongitudinalState =>
  state.manager.direction ?? EMPTY_LONGITUDINAL_STATE;
