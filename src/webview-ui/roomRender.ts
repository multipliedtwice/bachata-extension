/**
 * Room layout: header, navigation, banners, and the composition of the room's three views.
 *
 * Concatenated last of the renderers, because it composes the direction, execution and chat
 * views the earlier modules provide.
 */

// Readiness the host has already refused is not "Ready", whatever the workflow status says.
const readinessBlocked = (panel: PanelState): boolean =>
  runPhaseOf(panel) === "idle" &&
  ((panel.readiness?.findings ?? []).some((finding) => finding.status !== "ready") ||
    (panel.executionContract?.policyRefusals ?? []).length > 0);

const blockingDecisionCount = (panel: PanelState, conversationId: string): number =>
  state.manager.interactions.filter((interaction) => interaction.conversationId === conversationId && interactionIsOpen(interaction)).length +
  (panel.pendingGate && !gateInteraction(conversationId, panel) ? 1 : 0) + panel.approvals.length;

const pendingDecisionCardsHtml = (panel: PanelState, conversationId: string): string =>
  `${panel.pendingGate && !gateInteraction(conversationId, panel) ? gateHtml(panel, conversationId) : ""}${approvalsHtml(panel)}`;

const runConfigurationLocked = (panel: PanelState, conversationId = activeId()): boolean =>
  panel.operationActive === true || panel.pendingGate !== undefined ||
  runPhaseOf(panel) === "running" || panel.approvals.length > 0 ||
  Object.values(panel.agents).some((agent) => agent.status === "running") ||
  conversationById(conversationId)?.waitingForResources === true;

const runActionsMenuHtml = (conversation: ConversationSummary, surface = "tab", selected = false): string => {
  const runActions = `${conversation.archived ? "" : `<button data-action="run-rename" data-conversation="${escapeAttribute(conversation.id)}">${escapeHtml(localize("Rename"))}</button>`}<button data-action="run-duplicate" data-conversation="${escapeAttribute(conversation.id)}"${runActionAttributes(conversation, "run-duplicate")}>${escapeHtml(localize("Duplicate"))}</button><button data-action="${conversation.archived ? "run-unarchive" : "run-archive"}" data-conversation="${escapeAttribute(conversation.id)}"${runActionAttributes(conversation, conversation.archived ? "run-unarchive" : "run-archive")}>${escapeHtml(conversation.archived ? localize("Unarchive") : localize("Archive"))}</button>`;
  const items = selected
    ? `<div class="run-action-menu-group" role="group" aria-label="${escapeAttribute(localize("Run"))}"><span class="run-action-menu-label">${escapeHtml(localize("Run"))}</span>${runActions}</div>${selectedRunWorkspaceMenuHtml(conversation)}<div class="run-action-menu-group run-action-menu-danger" role="group" aria-label="${escapeAttribute(localize("Danger zone"))}"><span class="run-action-menu-label">${escapeHtml(localize("Danger zone"))}</span>${selectedRunResetActionHtml(conversation)}<button class="danger" data-action="run-delete" data-conversation="${escapeAttribute(conversation.id)}"${runActionAttributes(conversation, "run-delete")}>${escapeHtml(localize("Delete"))}</button></div>`
    : `${runActions}<button class="danger" data-action="run-delete" data-conversation="${escapeAttribute(conversation.id)}"${runActionAttributes(conversation, "run-delete")}>${escapeHtml(localize("Delete"))}</button>`;
  return `<details class="run-action-menu${selected ? " header-action-menu merged-run-menu" : ""}" ${disclosureAttributes(`run-menu:${surface}:${conversation.id}`)}><summary class="icon-button" ${selected ? `id="room-actions-button" ` : ""}data-action="run-menu-toggle" aria-label="${escapeAttribute(localize("Actions for {0}", runTabLabel(conversation)))}" title="${escapeAttribute(localize("Run actions"))}"><i class="codicon codicon-ellipsis" aria-hidden="true"></i></summary><div class="run-action-menu-items">${items}</div></details>`;
};

const conversationStatus = (conversation: ConversationSummary): { status: string; label: string } => {
  if (state.manager.interactions.some((interaction) => interaction.conversationId === conversation.id && (interaction.status === "pending" || interaction.status === "paused"))) {
    return { status: "paused", label: localize("Waiting for you") };
  }
  if (conversation.waitingForResources) {
    return { status: "paused", label: localize("Waiting for capacity") };
  }
  const phase = bachataWebviewBehavior.runPhase(conversation.running, conversation.workflowStatus);
  const outcome = state.panels.get(conversation.id)?.resumableWorkflow?.outcome;
  return {
    status: phase === "running" ? "running" : conversation.workflowStatus,
    label: localRunStatusLabel(bachataWebviewBehavior.runStatusPresentation(phase, outcome).label),
  };
};

const runStatusIcon = (status: string, outcome?: string): string => {
  if (status === "archived") return "archive";
  const presentation = bachataWebviewBehavior.runStatusPresentation(
    bachataWebviewBehavior.runPhase(false, status),
    outcome,
  );
  return presentation.spinning ? `${presentation.icon} codicon-modifier-spin` : presentation.icon;
};

const pipelineNameFor = (pipelineId: string | undefined): string | undefined => {
  if (!pipelineId) {
    return undefined;
  }
  for (const panel of state.panels.values()) {
    const match = panel.pipelines.find((pipeline) => pipeline.id === pipelineId);
    if (match) {
      return match.name;
    }
  }
  return pipelineId;
};

const participantLabel = (participant: { name: string; adapter: string; model?: string }): string =>
  [participant.name, participant.adapter, participant.model].filter((part) => part).join(" · ");

const runParticipants = (conversation: ConversationSummary): string[] => {
  const panel = state.panels.get(conversation.id);
  const defined = panel?.selectedPipelineDefinition?.agents ?? [];
  if (defined.length > 0) {
    return defined.map(participantLabel);
  }
  if (conversation.participants && conversation.participants.length > 0) {
    return conversation.participants.map(participantLabel);
  }
  return Object.values(panel?.agents ?? {}).map((agent) => `${agent.name} · ${agent.adapterType}`);
};

const runTabTooltip = (conversation: ConversationSummary, label: string): string => {
  const panel = state.panels.get(conversation.id);
  const pipeline = panel?.selectedPipelineDefinition?.name ?? pipelineNameFor(conversation.selectedPipelineId);
  const participants = runParticipants(conversation);
  const childCount = state.manager.conversations.filter((candidate) => candidate.parentConversationId === conversation.id).length;
  return [
    runTabLabel(conversation),
    panel?.activeStep ? `${label} · ${panel.activeStep}` : label,
    pipeline ? localize("Pipeline: {0}", pipeline) : undefined,
    ...(participants.length > 0
      ? [
        participants.length === 1 ? localize("Participant:") : localize("Participants:"),
        ...participants.slice(0, 6).map((entry) => `  ${entry}`),
        ...(participants.length > 6 ? [localize("  +{0} more", participants.length - 6)] : []),
      ]
      : []),
    conversation.iterationCount > 1 ? localize("Iteration {0} of {1}", conversation.activeIteration, conversation.iterationCount) : undefined,
    childCount > 0 ? childCount === 1 ? localize("{0} task run", childCount) : localize("{0} task runs", childCount) : undefined,
    localize("Updated {0}", relativeTime(conversation.updatedAt)),
  ].filter((line) => line !== undefined).join("\n");
};

const isPristineRunDraft = (conversation: ConversationSummary): boolean => {
  const title = runTabLabel(conversation);
  return !conversation.archived && !conversation.running && conversation.waitingForResources !== true &&
    conversation.workflowStatus === "idle" && !conversation.input?.trim() &&
    !conversation.preparedDraft?.trim() && (title === "New run" || title === "New conversation");
};

const tabsHtml = (): string => {
  const active = activeConversation();
  const selectedRootId = active ? rootConversationFor(active).id : activeId();
  // An open archived run keeps its tab, so the strip still says where the reader is. A pristine
  // draft is the empty composer itself, not a run the user can return to.
  const runs = stableRunTabs().filter((conversation) =>
    !isPristineRunDraft(conversation) && (!conversation.archived || conversation.id === selectedRootId)
  );
  const archivedCount = rootRuns().filter((conversation) => conversation.archived).length;
  const logo = `<svg class="workspace-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false"><path d="M8.75 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 1 0 0-11M15.25 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 1 0 0-11"/></svg>`;
  const brand = state.roomView === "direction"
    ? `<button class="icon-button run-tabs-brand" data-action="room-view" data-view="chat" aria-label="${escapeAttribute(localize("Home"))}" title="${escapeAttribute(localize("Home"))}">${logo}</button>`
    : `<span class="icon-button run-tabs-brand" aria-hidden="true">${logo}</span>`;
  return `<nav class="run-tabs" aria-label="${escapeAttribute(localize("Bachata workspace"))}">
    ${brand}
    <button class="run-tab-all" data-action="run-drawer-toggle" aria-label="${escapeAttribute(localize("Browse all runs"))}" ${state.roomView === "direction" ? 'aria-current="page"' : ""} ${expandedControlAttributes(state.runDrawerOpen, "run-drawer")}>${escapeHtml(localize("Runs"))}${archivedCount > 0 ? `<small>${escapeHtml(localize("{0} archived", archivedCount))}</small>` : ""}</button>
    <div class="run-tabs-strip"><div class="run-tabs-scroll">${runs.map((conversation) => {
      const selected = conversation.id === selectedRootId && state.roomView !== "direction";
      const { status, label } = conversation.archived ? { status: "archived", label: localize("Archived") } : conversationStatus(conversation);
      return `<div class="run-tab ${selected ? "selected" : ""} ${conversation.archived ? "archived" : ""}">
        <button class="run-tab-select" data-action="select-conversation" data-conversation="${escapeAttribute(conversation.id)}" title="${escapeAttribute(runTabTooltip(conversation, label))}" ${selected ? 'aria-current="page"' : ""}>
          <i class="codicon codicon-${escapeAttribute(runStatusIcon(status, state.panels.get(conversation.id)?.resumableWorkflow?.outcome))} run-tab-status status-${escapeAttribute(status)}" aria-hidden="true"></i>
          <span>${escapeHtml(runTabLabel(conversation))}</span>
          <span class="sr-only">${escapeHtml(label)}</span>
          ${conversation.iterationCount > 1 ? `<small>${String(conversation.activeIteration)}/${String(conversation.iterationCount)}</small>` : ""}
          ${conversation.unread > 0 ? `<span class="unread"><span aria-hidden="true">${String(conversation.unread)}</span><span class="sr-only">${escapeHtml(conversation.unread === 1 ? localize("{0} unread message", conversation.unread) : localize("{0} unread messages", conversation.unread))}</span></span>` : ""}
        </button>
        ${selected ? selectedRunTabToolsHtml(conversation) : ""}
        ${runActionsMenuHtml(conversation, "tab", selected)}
      </div>`;
    }).join("")}</div></div>
    <button class="icon-button run-tab-new" data-action="create-conversation" aria-label="${escapeAttribute(localize("New run"))}" title="${escapeAttribute(localize("New run"))}"><i class="codicon codicon-add" aria-hidden="true"></i></button>
  </nav>`;
};

const runDrawerHtml = (): string => {
  if (!state.runDrawerOpen) {
    return "";
  }
  const query = state.roomSearch.trim().toLowerCase();
  const runs = rootRuns().filter((conversation) => {
    if (isPristineRunDraft(conversation)) {
      return false;
    }
    if (!state.showArchived && conversation.archived) {
      return false;
    }
    if (!query) {
      return true;
    }
    const children = state.manager.conversations.filter((candidate) => rootConversationFor(candidate).id === conversation.id);
    if (state.historyResultQuery === query) {
      return [conversation, ...children].some((candidate) => state.historyMatches.has(candidate.id));
    }
    return [conversation, ...children].some((candidate) =>
      `${candidate.title} ${candidate.input ?? ""} ${candidate.runRef} ${candidate.orchestrationTaskId ?? ""}`.toLowerCase().includes(query)
    );
  });
  const active = activeConversation();
  const selectedRootId = active ? rootConversationFor(active).id : undefined;
  // The list filters as the reader types. Sight sees it shrink; a status line is what says so to
  // everyone else, and it is the only place the result count is stated.
  const runCount = runs.length === 0
    ? localize("No matching runs.")
    : state.roomSearch
      ? runs.length === 1 ? localize("{0} run matches the search.", runs.length) : localize("{0} runs match the search.", runs.length)
      : runs.length === 1 ? localize("{0} run.", runs.length) : localize("{0} runs.", runs.length);
  return `<div class="run-drawer-backdrop" data-action="run-drawer-backdrop"><aside class="run-drawer" id="run-drawer" role="dialog" aria-modal="true" aria-label="${escapeAttribute(localize("All runs"))}">
    <header><h2>${escapeHtml(localize("Runs"))}</h2><button class="icon-button" data-action="run-drawer-toggle" aria-label="${escapeAttribute(localize("Close all runs"))}">×</button></header>
    <label class="sr-only" for="run-search">${escapeHtml(localize("Search runs"))}</label>
    <input id="run-search" class="room-search" value="${escapeAttribute(state.roomSearch)}" placeholder="${escapeAttribute(localize("Search runs and prompts…"))}" autofocus>
    <label class="archive-toggle"><input id="show-archived" type="checkbox" ${state.showArchived ? "checked" : ""}> ${escapeHtml(localize("Show archived runs"))}</label>
    ${state.historyResultsTruncated && state.historyResultQuery ? `<p class="search-truncated">${escapeHtml(localize("Search stopped at its evidence budget. Some older transcripts and events were not scanned."))}</p>` : ""}
    <p class="sr-only" ${liveRegionAttributes("run-drawer-count", "status", runCount)}>${escapeHtml(runCount)}</p>
    <div class="run-drawer-list">${runs.length === 0 ? `<p class="empty-list" aria-hidden="true">${escapeHtml(localize("No matching runs."))}</p>` : runs.map((conversation) => {
      const { status, label } = conversationStatus(conversation);
      const childCount = state.manager.conversations.filter((candidate) => candidate.parentConversationId === conversation.id).length;
      const selected = selectedRootId === conversation.id;
      return `<article class="run-drawer-item ${selected ? "selected" : ""} ${conversation.archived ? "archived" : ""}">
        <button class="run-drawer-select" data-action="select-conversation" data-conversation="${escapeAttribute(conversation.id)}" ${selected ? 'aria-current="true"' : ""}>
          <span class="room-presence status-${escapeAttribute(status)}"></span>
          <span><strong>${escapeHtml(runTabLabel(conversation))}</strong><small>${escapeHtml(label)}${childCount > 0 ? ` · ${escapeHtml(childCount === 1 ? localize("{0} task run", childCount) : localize("{0} task runs", childCount))}` : ""}</small></span>
          <time title="${escapeAttribute(formatDateTime(conversation.updatedAt))}">${escapeHtml(relativeTime(conversation.updatedAt))}</time>
        </button>
        ${runActionsMenuHtml(conversation, "drawer")}
      </article>`;
    }).join("")}</div>
    <footer class="run-drawer-footer"><nav aria-label="${escapeAttribute(localize("Project goals and decisions"))}"><button class="run-drawer-direction" data-action="room-view" data-view="direction" ${state.roomView === "direction" ? 'aria-current="page"' : ""} title="${escapeAttribute(localize("Project goals and decisions"))}"><i class="codicon codicon-compass" aria-hidden="true"></i>${escapeHtml(localize("Direction"))}</button></nav></footer>
  </aside></div>`;
};

const recentActivityHtml = (): string => {
  const waitingConversationIds = new Set(
    state.manager.interactions
      .filter((interaction) => interaction.status === "pending" || interaction.status === "paused")
      .map((interaction) => interaction.conversationId),
  );
  const activityPriority = (conversation: ConversationSummary): number =>
    waitingConversationIds.has(conversation.id)
      ? 0
      : conversation.waitingForResources
        ? 1
        : conversation.workflowStatus === "error"
          ? 2
          : bachataWebviewBehavior.runPhase(conversation.running, conversation.workflowStatus) === "running"
            ? 3
            : 4;
  const items = state.manager.conversations
    .filter((conversation) => !conversation.archived && conversation.id !== state.manager.activeConversationId)
    .sort((left, right) =>
      activityPriority(left) - activityPriority(right) ||
      right.updatedAt.localeCompare(left.updatedAt)
    )
    .slice(0, 8);
  if (items.length === 0) {
    return "";
  }
  return `<section class="recent-activity"><div class="section-heading"><div><strong>${escapeHtml(localize("Recent activity"))}</strong><small>${escapeHtml(localize("Waiting, failed, and recently updated work"))}</small></div><button data-action="run-drawer-open">${escapeHtml(localize("All runs"))}</button></div>${items.map((conversation) => {
    const { status, label } = conversationStatus(conversation);
    return `<button class="recent-activity-item" data-action="select-conversation" data-conversation="${escapeAttribute(conversation.id)}"><span class="room-presence status-${escapeAttribute(status)}"></span><span><strong>${escapeHtml(runTabLabel(conversation))}</strong><small>${escapeHtml(label)}</small></span><time title="${escapeAttribute(formatDateTime(conversation.updatedAt))}">${escapeHtml(relativeTime(conversation.updatedAt))}</time></button>`;
  }).join("")}</section>`;
};

const roomStatusFor = (
  panel: PanelState,
  conversation: ConversationSummary,
): { status: string; label: string; spinning: boolean; show: boolean } => {
  const blockingCount = blockingDecisionCount(panel, conversation.id);
  const waitingForResources = conversation.waitingForResources === true;
  const waitingForHuman = blockingCount > 0 || panel.workflowStatus === "paused";
  const phase = runPhaseOf(panel);
  const presentation = bachataWebviewBehavior.runStatusPresentation(phase, panel.resumableWorkflow?.outcome);
  const roomStatus = readinessBlocked(panel)
    ? { status: "error", label: localize("Blocked"), spinning: false }
    : waitingForHuman
      ? { status: "paused", label: localize("Waiting for you"), spinning: false }
      : waitingForResources
        ? { status: "paused", label: localize("Waiting for capacity"), spinning: false }
        : {
            status: phase === "running" ? "running" : panel.workflowStatus,
            label: localRunStatusLabel(presentation.label),
            spinning: presentation.spinning,
          };
  const requirements = conversation.archived ? [] : sendBlockers(conversation.id, panel, draftFor(conversation.id)).filter((blocker) => blocker.quiet !== true);
  const ready = roomStatus.status === "idle" && phase === "idle";
  return {
    ...roomStatus,
    label: requirements.length > 0 && ready ? localize("Needs attention") : roomStatus.label,
    show: requirements.length > 0 || !ready,
  };
};

const executionViewAvailable = (conversation: ConversationSummary, panel: PanelState): boolean => {
  const root = rootConversationFor(conversation);
  const readOnly = conversation.archived;
  return state.manager.resultsByConversation?.[conversation.id] !== undefined ||
    (!readOnly && root.id === conversation.id && hasOrchestrationState()) ||
    (state.manager.eventsByConversation[conversation.id] ?? []).length > 0 ||
    (root.id === conversation.id && childConversationsFor(conversation.id).length > 0) ||
    (!readOnly && (panel.pendingGate !== undefined || panel.approvals.length > 0)) ||
    (!readOnly && state.manager.interactions.some((interaction) => interaction.conversationId === conversation.id && interactionIsOpen(interaction)));
};

const selectedRunTabToolsHtml = (tabConversation: ConversationSummary): string => {
  const conversation = activeConversation() ?? tabConversation;
  const panel = state.panels.get(conversation.id) ?? emptyPanel();
  const execution = executionViewAvailable(conversation, panel) || state.roomView === "execution";
  const blockingCount = blockingDecisionCount(panel, conversation.id);
  const waitingForResources = conversation.waitingForResources === true;
  const stopping = !conversation.archived && state.roomView !== "chat" && (runPhaseOf(panel) === "running" || waitingForResources)
    ? `<button class="icon-button run-tab-tool run-tab-stop" data-action="interrupt-run" aria-label="${escapeAttribute(waitingForResources ? localize("Cancel wait") : localize("Stop"))}" title="${escapeAttribute(waitingForResources ? localize("Cancel wait") : localize("Stop"))}"${pendingInterrupts.has(conversation.id) ? ' disabled aria-busy="true"' : ""}><i class="codicon codicon-debug-stop" aria-hidden="true"></i></button>`
    : "";
  const status = roomStatusFor(panel, conversation);
  const statusText = `${status.spinning ? `<i class="codicon codicon-loading codicon-modifier-spin room-status-activity" aria-hidden="true"></i>` : ""}<span ${liveRegionAttributes(`room-status:${conversation.id}`, "status", status.label)}>${escapeHtml(status.label)}</span>`;
  const statusNode = status.show ? `<span class="room-status status-${escapeAttribute(status.status)} sr-only">${statusText}</span>` : "";
  const viewSwitcher = execution
    ? `<button class="icon-button run-tab-tool" data-action="room-view" data-view="chat" aria-pressed="${state.roomView === "chat" ? "true" : "false"}" aria-label="${escapeAttribute(localize("Chat"))}" title="${escapeAttribute(localize("Chat"))}"><i class="codicon codicon-comment-discussion" aria-hidden="true"></i></button><button class="icon-button run-tab-tool" data-action="room-view" data-view="execution" aria-pressed="${state.roomView === "execution" ? "true" : "false"}" aria-label="${escapeAttribute(blockingCount > 0 ? localize("Execution ({0})", blockingCount) : localize("Execution"))}" title="${escapeAttribute(blockingCount > 0 ? localize("Execution ({0})", blockingCount) : localize("Execution"))}"><i class="codicon codicon-list-tree" aria-hidden="true"></i></button>`
    : "";
  return `<div class="run-tab-tools" role="group" aria-label="${escapeAttribute(localize("Run view"))}">${statusNode}${viewSwitcher}${stopping}${notificationBellHtml()}</div>`;
};

const selectedRunWorkspaceMenuHtml = (tabConversation: ConversationSummary): string => {
  const conversation = activeConversation() ?? tabConversation;
  const panel = state.panels.get(conversation.id) ?? emptyPanel();
  const controlsLocked = runConfigurationLocked(panel, conversation.id);
  const requirements = conversation.archived ? [] : sendBlockers(conversation.id, panel, draftFor(conversation.id)).filter((blocker) => blocker.quiet !== true);
  const status = roomStatusFor(panel, conversation);
  const providerCheckDisabled = controlsLocked
    ? `disabled title="${escapeAttribute(localize("Available after the active operation finishes"))}"`
    : agentsAssignable(panel) ? "" : `disabled title="${escapeAttribute(localize("Select a pipeline with participants to check providers."))}"`;
  return `<div class="run-action-menu-group" role="group" aria-label="${escapeAttribute(localize("Workspace"))}"><span class="run-action-menu-label">${escapeHtml(localize("Workspace"))}</span><button data-action="inspector-toggle" aria-expanded="${state.inspectorOpen ? "true" : "false"}">${escapeHtml(state.inspectorOpen ? localize("Hide details") : localize("Show details"))}</button>${requirements.length > 0 ? `<button data-action="run-requirements" data-conversation="${escapeAttribute(conversation.id)}" aria-label="${escapeAttribute(localize("{0}. Review run requirements", status.label))}">${escapeHtml(localize("Review requirements"))}</button>` : ""}${conversation.archived ? "" : `<button data-action="availability-check" ${providerCheckDisabled}>${escapeHtml(localize("Check providers"))}</button><button data-action="working-directory" ${controlsLocked ? `disabled title="${escapeAttribute(localize("Available after the active operation finishes"))}"` : ""}>${escapeHtml(localize("Choose folder"))}</button>${hasOrchestrationState() ? "" : orchestrationStartButtonHtml()}`}<button data-action="transcript-export">${escapeHtml(localize("Export transcript"))}</button></div>`;
};

const selectedRunResetActionHtml = (tabConversation: ConversationSummary): string => {
  const conversation = activeConversation() ?? tabConversation;
  if (conversation.archived) return "";
  const panel = state.panels.get(conversation.id) ?? emptyPanel();
  const controlsLocked = runConfigurationLocked(panel, conversation.id);
  return `<button class="danger" data-action="task-reset" ${controlsLocked ? `disabled title="${escapeAttribute(localize("Stop the active operation before resetting"))}"` : ""}>${escapeHtml(localize("Reset run"))}</button>`;
};

const findingStateLabel: Record<LongitudinalFindingState, string> = {
  new: localize("New"),
  repeated: localize("Repeated"),
  accepted: localize("Accepted"),
  rejected: localize("Rejected"),
  unresolved: localize("Unresolved"),
  resolved: localize("Resolved"),
  regressed: localize("Regressed"),
  reopened: localize("Reopened"),
};

const findingLocationLabel = (finding: DirectionFinding): string =>
  finding.location === undefined
    ? ""
    : ` · ${finding.location.file}${finding.location.startLine === undefined ? "" : `:${String(finding.location.startLine)}`}`;

const bachataMarkHtml = `<div class="bachata-mark" aria-hidden="true"><svg viewBox="0 0 40 40" width="40" height="40" focusable="false"><circle class="bachata-mark-solid" cx="15" cy="20" r="9"></circle><circle class="bachata-mark-outline" cx="26" cy="20" r="9"></circle></svg></div>`;

/**
 * EX-UI-01. A failure that says what happened and offers the next safe action, beside the step
 * that failed.
 *
 * A provider refusal Bachata understands carries labelled choices. Flattened into prose they read
 * as a list of things the reader must go and find; here each one is the control itself. Nothing
 * here resends anything: every choice either opens a setting, re-checks the environment, or
 * leaves the run stopped.
 */
const recoveryChoiceAttributes = (choice: {
  id: string;
  setting?: string;
}): string | undefined => {
  if (choice.id === "runDoctor") return `data-action="recovery-doctor"`;
  if (choice.id === "chooseAnotherProvider") return `data-action="recovery-setup"`;
  if (choice.setting) return `data-action="recovery-setting" data-setting="${escapeAttribute(choice.setting)}"`;
  return undefined;
};

const providerRecoveryHtml = (entry: TranscriptEntry): string => {
  const data = entry.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return "";
  const record = data as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : "";
  const statement = typeof record.statement === "string" ? record.statement : "";
  const detail = typeof record.detail === "string" ? record.detail : "";
  const choices = Array.isArray(record.choices) ? record.choices : [];
  if (!title && !statement) return "";
  const actions = choices
    .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value))
    .map((choice) => {
      const label = typeof choice.label === "string" ? choice.label : "";
      const choiceDetail = typeof choice.detail === "string" ? choice.detail : "";
      const attributes = recoveryChoiceAttributes({
        id: typeof choice.id === "string" ? choice.id : "",
        ...(typeof choice.setting === "string" ? { setting: choice.setting } : {}),
      });
      if (!label) return "";
      // A choice with nothing to press is still what the reader may decide to do, so it is said
      // rather than drawn as a control that does nothing.
      return attributes
        ? `<li><button ${attributes} title="${escapeAttribute(choiceDetail)}">${escapeHtml(label)}</button><span>${escapeHtml(choiceDetail)}</span></li>`
        : `<li><span class="recovery-choice-plain">${escapeHtml(label)}</span><span>${escapeHtml(choiceDetail)}</span></li>`;
    })
    .join("");
  return `<section class="failure-recovery">
    <h3>${escapeHtml(title || localize("This step failed"))}</h3>
    <p>${escapeHtml(statement)}</p>
    <p class="muted">${escapeHtml(localize("Bachata will not run this somewhere else on its own."))}</p>
    ${actions ? `<ul class="failure-recovery-choices">${actions}</ul>` : ""}
    ${detail ? `<details class="failure-recovery-detail" ${disclosureAttributes(`recovery:${entry.id}`)}><summary>${escapeHtml(localize("Technical detail"))}</summary><div class="markdown">${renderMarkdown(detail)}</div></details>` : ""}
  </section>`;
};

type SendBlocker = {
  condition: string;
  requirement: string;
  action?: { label: string; attributes: string };
  /** EX-UI-02. Still refuses Send; not drawn, because the composer already says it. */
  quiet?: boolean;
};

const sendBlockers = (
  conversationId: string,
  panel: PanelState,
  draft: ConversationDraft,
): SendBlocker[] => {
  const conversation = conversationById(conversationId);
  const blockers: SendBlocker[] = [];
  if (conversation?.archived === true) {
    blockers.push({
      condition: localize("This run is archived and read-only."),
      requirement: localize("Unarchive it to continue work."),
      action: {
        label: localize("Unarchive"),
        attributes: `data-action="run-unarchive" data-conversation="${escapeAttribute(rootConversationFor(conversation).id)}"`,
      },
    });
  }
  if (!panel.workingDirectory && panel.workspaceRoots.length !== 1) {
    blockers.push({
      condition: panel.workspaceRoots.length === 0
        ? localize("No workspace folder is open.")
        : localize("No working root is selected in this multi-root window."),
      requirement: localize("Choose the repository this run targets."),
      action: { label: localize("Choose folder"), attributes: `data-action="working-directory"` },
    });
  }
  if (draft.pendingAttachments.size > 0) {
    blockers.push({
      condition: draft.pendingAttachments.size === 1
        ? localize("One attachment is still being stored.")
        : localize("{0} attachments are still being stored.", draft.pendingAttachments.size),
      requirement: localize("Wait for the attachment to finish."),
    });
  }
  if (Array.from(state.pendingRuns.values()).some(
    (request) => request.conversationId === conversationId && !request.accepted,
  )) {
    blockers.push({
      condition: localize("A previous submit has not been accepted by the runtime yet."),
      requirement: localize("Wait for it to be accepted or rejected, or discard it and send again."),
      action: { label: localize("Discard pending submit"), attributes: `data-action="run-discard-pending"` },
    });
  }
  (panel.executionContract?.policyRefusals ?? []).forEach((refusal) => blockers.push({
    condition: refusal,
    requirement: localize("This repository's policy file refuses this run; change the pipeline or the policy before it can start."),
  }));
  if (draft.delivery === "immediate" && conversation?.waitingForResources === true) {
    blockers.push({
      condition: localize("Waiting for shared capacity."),
      requirement: localize("Cancel the wait, or queue this message instead."),
      quiet: true,
    });
  } else if (draft.delivery === "immediate" && runPhaseOf(panel) === "running") {
    blockers.push({
      condition: localize("A run is already executing here."),
      requirement: localize("Stop it, or choose Queue or Interrupt in the run options."),
      quiet: true,
    });
  }
  const recovery = runRecoveryOf(panel, runPhaseOf(panel));
  if (draft.delivery === "immediate" && recovery !== undefined) {
    const preflight = recovery.step === "none" ? latestPreflightRecord(panel) : undefined;
    const needsFolder = preflight !== undefined && preflightActionsHtml(preflight) !== "";
    blockers.push({
      condition: recovery.step === "resume"
        ? localize("The pipeline is stopped.")
        : localize("The pipeline failed."),
      requirement: needsFolder
        ? localize("Choose a Git project folder before restarting.")
        : recovery.step === "resume"
          ? localize("Resume from the saved step, or start a new run for a different task.")
          : localize("Restart the pipeline after resolving the failure."),
      action: needsFolder
        ? { label: localize("Choose folder"), attributes: `data-action="working-directory"` }
        : recovery.step === "resume"
          ? { label: localize("Resume"), attributes: `data-action="workflow-resume"` }
          : { label: localize("Restart pipeline"), attributes: `data-action="workflow-restart"` },
    });
  }
  if (draft.prompt.trim().length === 0) {
    // EX-UI-02. Still a blocker, so Send stays refused and says why when asked; not drawn in the
    // list, because the field's own placeholder and the room's intro card already say it and a
    // third copy is the first thing a reader sees in an empty room.
    blockers.push({
      condition: localize("The run input is empty."),
      requirement: localize("Describe what this run must do."),
      quiet: true,
    });
  }
  (panel.readiness?.findings ?? [])
    .filter((finding) => finding.status !== "ready")
    .forEach((finding) => blockers.push({
      condition: `${finding.label}: ${finding.detail}`,
      requirement: finding.status === "unsupported"
        ? localize("This pipeline cannot run in this window.")
        : localize("Resolve this before the run can start."),
      ...(finding.remediationId
        ? {
            action: {
              label: localize("Fix"),
              attributes: `data-action="readiness-remediate" data-remediation="${escapeAttribute(finding.remediationId)}" data-detail="${escapeAttribute(finding.detail)}"`,
            },
          }
        : {}),
    }));
  return blockers;
};

const composerCanSubmit = (
  conversationId: string,
  panel: PanelState,
  draft: ConversationDraft,
): boolean => sendBlockers(conversationId, panel, draft).length === 0;

const sendRequirementsDescription = (blockers: SendBlocker[]): string => {
  const visible = blockers.filter((blocker) => blocker.quiet !== true);
  return (visible.length > 0 ? visible : blockers)
    .map((blocker) => `${blocker.condition} ${blocker.requirement}`)
    .join(" ");
};

const runRequirementsHtml = (conversationId: string): string => {
  const panel = state.panels.get(conversationId) ?? emptyPanel();
  const blockers = sendBlockers(conversationId, panel, draftFor(conversationId));
  const visible = blockers.filter((blocker) => blocker.quiet !== true);
  const requirements = visible.length > 0 ? visible : blockers;
  if (requirements.length === 0) return `<p class="run-requirements-ready" role="status">${escapeHtml(localize("Ready to send."))}</p>`;
  return `<ul class="run-requirements-list">${requirements.map((blocker) => `<li><div><strong>${escapeHtml(blocker.condition)}</strong><p>${escapeHtml(blocker.requirement)}</p></div>${blocker.action ? `<button type="button" data-run-requirement-remedy="true" ${blocker.action.attributes}>${escapeHtml(blocker.action.label)}</button>` : ""}</li>`).join("")}</ul>`;
};

const composerSubmitStateAttributes = (canSubmit: boolean, blockers: SendBlocker[]): string =>
  canSubmit ? "" : `aria-disabled="true" aria-description="${escapeAttribute(sendRequirementsDescription(blockers))}"`;

const mainRoomHtml = (): string => {
  const conversation = activeConversation();
  if (!conversation) {
    if (state.roomView === "direction") return `<main class="room-empty workspace-direction"><div class="conversation-scroll" id="conversation-scroll" data-scroll-key="workspace:direction">${directionHtml()}</div></main>`;
    // EX-UI-02. The Direction centre is offered where there is direction state, the same rule the
    // room header and `directionRender` already apply. Without it this room drew the whole centre,
    // five permanently visible secondary buttons included, for a workspace that has no direction.
    return `<main class="room-empty"><div><h1>${escapeHtml(localize("No run selected"))}</h1><p class="room-empty-promise">${escapeHtml(localize("Bachata reviews code with several AI agents that challenge each other's findings. Start a run to pick a pipeline and describe the job."))}</p><div class="compact-actions room-empty-actions"><button class="primary" data-action="create-conversation">${escapeHtml(localize("Start a run"))}</button>${hasOrchestrationState() ? "" : orchestrationStartButtonHtml()}</div></div>${hasDirectionState() ? directionHtml() : ""}${orchestrationHtml()}${recentActivityHtml()}</main>`;
  }
  const readOnly = conversation.archived;
  const panel = activePanel();
  const draft = activeDraft();
  const rootConversation = rootConversationFor(conversation);
  const isRoot = rootConversation.id === conversation.id;
  // What each view would hold, decided before either is drawn. Only the view on screen is
  // built: a live region built for the hidden view was recorded as announced while invisible,
  // so it entered the DOM muted the first time it was actually shown.
  const has = {
    decisions: !readOnly && (panel.pendingGate !== undefined || panel.approvals.length > 0),
    interactions: !readOnly && state.manager.interactions.some((interaction) => interaction.conversationId === conversation.id && interactionIsOpen(interaction)),
    workflow: (state.manager.eventsByConversation[conversation.id] ?? []).length > 0,
    result: state.manager.resultsByConversation?.[conversation.id] !== undefined,
    childRuns: isRoot && childConversationsFor(conversation.id).length > 0,
    orchestration: !readOnly && isRoot && hasOrchestrationState(),
  };
  const introNeeded = panel.transcript.length === 0 &&
    !has.workflow && !has.childRuns && !has.interactions && !has.result;
  const archivedBanner = readOnly
    ? `<div class="archive-readonly-banner"><strong>${escapeHtml(localize("Archived run"))}</strong><span>${escapeHtml(localize("History is read-only. Unarchive it to continue work."))}</span><button data-action="run-unarchive" data-conversation="${escapeAttribute(rootConversation.id)}">${escapeHtml(localize("Unarchive"))}</button></div>`
    : "";
  const blockingCount = blockingDecisionCount(panel, conversation.id);
  const blockingSummary = blockingCount === 1 ? localize("{0} decision pending", blockingCount) : localize("{0} decisions pending", blockingCount);
  const blockingBanner = !readOnly && blockingCount > 0
    ? `<div class="blocking-workflow-banner" ${liveRegionAttributes("blocking-decisions", "status", blockingSummary)}><strong>${escapeHtml(blockingSummary)}</strong><button data-action="room-view" data-view="execution" data-focus="pending-decision">${escapeHtml(blockingCount > 1 ? localize("Review decisions") : localize("Review decision"))}</button></div>`
    : "";
  // A tab that leads to a placeholder is not a route to anything. Execution is offered once the
  // room has something to execute or something already executed, and always while the user is
  // standing in it.
  const hasExecutionState = executionViewAvailable(conversation, panel);
  const chatContent = (): string => {
    const intro = introNeeded
      ? readOnly
        ? `<section class="conversation-intro">${bachataMarkHtml}<h2>${escapeHtml(localize("Archived run"))}</h2><p>${escapeHtml(localize("No transcript entries were stored for this run."))}</p></section>`
        : `<section class="conversation-intro">${bachataMarkHtml}<h2>${escapeHtml(localize("Start a run"))}</h2><p>${escapeHtml(localize("Pick a pipeline, enter a job, and watch it execute."))}</p></section>${recentActivityHtml()}`
      : "";
    const transcript = panel.transcript
      .filter((entry) => !isRunInformationEntry(entry))
      .map((entry) => transcriptMessageHtml(panel, entry, readOnly))
      .join("");
    // The decision that stops the run sits where the run is being read, not one view away.
    const decisions = has.decisions ? pendingDecisionCardsHtml(panel, conversation.id) : "";
    return `<h2 class="sr-only">${escapeHtml(localize("Conversation"))}</h2>${panel.transcriptError ? `<p class="error-banner">${escapeHtml(panel.transcriptError)}</p>` : ""}${panel.transcriptHasMore ? `<button class="load-older" data-action="load-older">${escapeHtml(localize("Load older messages"))}</button>` : ""}${intro}${transcript}${readOnly ? "" : liveMessagesHtml(panel)}${has.interactions ? interactionsHtml(conversation.id) : ""}${decisions}${runOutcomeHtml(conversation, panel, readOnly)}${readOnly ? "" : queueHtml(panel)}`;
  };
  const continuationFooter = state.roomView === "execution" ? resultContinuationFooterHtml(conversation.id, panel) : "";
  const resultLivesInFooter = continuationFooter.length > 0;
  const resultOverlayOpen = resultLivesInFooter && resultDetailsOpen(conversation.id);
  const executionContent = (): string => `${has.interactions ? interactionsHtml(conversation.id) : ""}${has.decisions ? pendingDecisionCardsHtml(panel, conversation.id) : ""}${has.result && !resultLivesInFooter ? resultCenterHtml(conversation.id, panel) : ""}${has.orchestration ? orchestrationHtml() : ""}${has.workflow ? workflowHtml(conversation.id) : ""}${has.childRuns ? childRunsHtml(conversation.id) : ""}${hasExecutionState ? "" : `<section class="conversation-intro">${bachataMarkHtml}<h2>${escapeHtml(localize("Execution"))}</h2><p>${escapeHtml(localize("Progress and results appear here."))}</p></section>`}`;
  const content = state.roomView === "direction"
      ? directionHtml()
      : `${directionBannerHtml()}${state.roomView === "execution" ? executionContent() : chatContent()}`;
  const viewport = `<div class="conversation-viewport ${state.roomView === "chat" ? "with-chat-navigation" : ""}"${resultOverlayOpen ? ' inert aria-hidden="true"' : ""}><div class="conversation-scroll ${state.roomView === "execution" ? "execution-content" : ""} ${introNeeded && state.roomView !== "execution" ? "is-empty" : ""}" id="conversation-scroll" data-scroll-key="${escapeAttribute(`${conversation.id}:${state.roomView}`)}">${content}${state.roomView === "chat" ? "" : panel.transcriptError ? `<p class="error-banner">${escapeHtml(panel.transcriptError)}</p>` : ""}</div>${state.roomView === "chat" ? `${chatMinimapHtml(panel)}<button class="jump-latest" data-action="jump-latest" hidden>${escapeHtml(localize("Latest"))}</button>` : ""}</div>`;
  const parentNavigation = isRoot
    ? ""
    : `<div class="child-run-navigation"><button class="parent-run" data-action="select-conversation" data-conversation="${escapeAttribute(rootConversation.id)}"><i class="codicon codicon-arrow-left" aria-hidden="true"></i>${escapeHtml(runTabLabel(rootConversation))}</button></div>`;
  return `<section class="room-shell"><h1 class="sr-only">${escapeHtml(runTabLabel(conversation))}</h1>${archivedBanner}${blockingBanner}${parentNavigation}<div class="room-body ${state.inspectorOpen ? "with-inspector" : ""}"><main class="conversation-column"${inspectorCoversRoom() ? " inert" : ""}>${viewport}${state.roomView === "execution" ? continuationFooter : readOnly || state.roomView !== "chat" ? "" : composerHtml(panel, draft)}</main>${inspectorHtml(panel, readOnly)}</div></section>`;
};

// The ended run's verdict and its ways back in, in one row at the end of the transcript. A run
// that is still working has neither, so nothing is drawn for it.
const runOutcomeHtml = (
  conversation: ConversationSummary,
  panel: PanelState,
  readOnly: boolean,
): string => {
  const phase = runPhaseOf(panel);
  if (phase === "running" || phase === "waiting") return "";
  const result = state.manager.resultsByConversation?.[conversation.id];
  const recovery = readOnly ? undefined : runRecoveryOf(panel, phase);
  if (!result && !recovery) return "";
  const failure = result?.finalAssessment?.failure;
  // A failed run's assessment summary embeds the provider's own sentence, and the chat has just
  // shown that sentence where the failure happened, so this row says where instead.
  const assessment = failure
    ? [
        failure.participant ?? failure.agentId,
        failure.step === undefined ? undefined : localize("at {0}", failure.step),
      ].filter((part): part is string => part !== undefined).join(" ")
    : result?.status === "interrupted" ? undefined : resultSummaryText(result?.finalAssessment?.summary);
  const detail = recovery ? recoveryPositionText(panel, recovery) : assessment;
  const shownPhase = result ? bachataWebviewBehavior.runPhase(false, result.status) : phase;
  const presentation = bachataWebviewBehavior.runStatusPresentation(shownPhase, panel.resumableWorkflow?.outcome);
  const headline = result ? resultHeadlineLabel(result, panel.resumableWorkflow?.outcome) : localRunStatusLabel(presentation.label);
  return `<section class="run-outcome status-${escapeAttribute(shownPhase)}" aria-label="${escapeAttribute(localize("Run result"))}"><div class="run-outcome-text"><strong><i class="codicon codicon-${escapeAttribute(presentation.icon)}" aria-hidden="true"></i> ${escapeHtml(headline)}</strong>${detail ? `<p>${escapeHtml(detail)}</p>` : ""}</div><div class="run-outcome-actions">${recoveryActionsHtml(panel, recovery)}${recovery ? `<details class="header-action-menu wide-trigger recovery-menu" ${disclosureAttributes(`recovery-menu:${conversation.id}`)}><summary aria-label="${escapeAttribute(localize("Recovery actions"))}">${escapeHtml(localize("More"))}</summary><div>${recoverySecondaryActionsHtml(panel, recovery)}</div></details>` : ""}${result ? `<button data-action="room-view" data-view="execution">${escapeHtml(localize("Open the result"))}</button>` : ""}</div></section>`;
};

const defaultAgentNames = ["Lead", "Worker", "Reviewer"];

const defaultAgent = (index: number, adapter: string): AgentDefinition => {
  const name = defaultAgentNames[index] ?? `Agent ${String(index + 1)}`;
  return {
    id: slugId(name),
    name,
    adapter,
  };
};

const defaultStepNames = ["Implement", "Review"];

const defaultAgentStep = (index: number, participant?: string): AgentStep => ({
  id: slugId(defaultStepNames[index] ?? `Step ${String(index + 1)}`),
  name: defaultStepNames[index] ?? `Step ${String(index + 1)}`,
  enabled: true,
  humanGate: "none",
  type: "agent",
  participants: participant ? [participant] : [],
  promptTemplate: "{{userPrompt}}",
  parallel: false,
  consensus: false,
  attachments: "selected",
});

const blankPipeline = (panel: PanelState): PipelineDefinition => {
  const adapter = panel.adapterTypes[0] ?? "codex-app-server";
  const agent = defaultAgent(0, adapter);
  return {
    version: 1,
    id: `custom-pipeline-${Date.now().toString(36)}`,
    name: "Custom pipeline",
    description: "",
    agents: [agent],
    roles: [],
    steps: [defaultAgentStep(0, agent.id)],
  };
};

const assignmentText = (value: Record<string, string> | undefined): string =>
  Object.entries(value ?? {}).map(([key, item]) => `${key}=${item}`).join(", ");

const parseAssignments = (value: string): Record<string, string> | undefined => {
  const entries = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item): [string, string] | undefined => {
      const separator = item.indexOf("=");
      if (separator <= 0 || separator === item.length - 1) {
        return undefined;
      }
      return [item.slice(0, separator).trim(), item.slice(separator + 1).trim()];
    })
    .filter((item): item is [string, string] => Boolean(item?.[0] && item[1]));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const defaultRole = (index: number): RoleDefinition => ({
  id: `role-${String(index + 1)}`,
  name: `Role ${String(index + 1)}`,
  instructions: "Perform the task from this role's specialist perspective.",
});

const editorCardKey = (kind: "agent" | "role" | "step", id: string): string =>
  `${kind}:${id}`;

const resetExpandedEditorCards = (_pipeline: PipelineDefinition): void => {
  state.expandedEditorCards = new Set();
};

const editorCardOpen = (kind: "agent" | "role" | "step", id: string): string =>
  state.expandedEditorCards.has(editorCardKey(kind, id)) ? "open" : "";

const browserAdapterTypes = new Set(["chatgpt-browser", "claude-browser", "generic-browser"]);
