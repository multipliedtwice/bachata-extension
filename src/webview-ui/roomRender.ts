/**
 * Room layout: header, navigation, banners, and the composition of the room's three views.
 *
 * Concatenated last of the renderers, because it composes the direction, execution and chat
 * views the earlier modules provide.
 */

// Readiness the host has already refused is not "Ready", whatever the workflow status says.
const readinessBlocked = (panel: PanelState): boolean =>
  panel.workflowStatus === "idle" &&
  !panel.running &&
  ((panel.readiness?.findings ?? []).some((finding) => finding.status !== "ready") ||
    (panel.executionContract?.policyRefusals ?? []).length > 0);

const roomHeaderHtml = (
  panel: PanelState,
  conversation: ConversationSummary,
  views: { direction: boolean; execution: boolean },
): string => {
  const blockingCount = (panel.pendingGate ? 1 : 0) + panel.approvals.length;
  const rootConversation = rootConversationFor(conversation);
  const readOnly = conversation.archived;
  const waitingForResources = conversation.waitingForResources === true;
  // The composer's stop lives in the chat view only; every other view needs the same escape hatch.
  const interrupt = !readOnly && state.roomView !== "chat" && (panel.running || waitingForResources)
    ? `<button data-action="interrupt-run">${waitingForResources ? "Cancel wait" : "Stop"}</button>`
    : "";
  const selection = pendingPipelineSelection(conversation.id);
  const parentNavigation = rootConversation.id === conversation.id
    ? ""
    : `<button class="parent-run" data-action="select-conversation" data-conversation="${escapeAttribute(rootConversation.id)}">← ${escapeHtml(rootConversation.title)}</button>`;
  // A hidden Direction tab must not be a deleted Direction view: defining an initiative is only
  // reachable there, and a room with no direction yet is exactly the room where someone would want
  // to define one.
  const directionItem = views.direction
    ? ""
    : `<button data-action="room-view" data-view="direction">Open direction</button>`;
  const inspectorItem = `<button data-action="inspector-toggle" aria-expanded="${state.inspectorOpen ? "true" : "false"}">${state.inspectorOpen ? "Hide inspector" : "Show inspector"}</button>${directionItem}`;
  // The tab and the drawer row say "Waiting for you" and "Blocked"; the pill beside the title
  // used to say "Ready" in both cases. The panel stays the authority on running, since it is
  // what the runtime patches first.
  const waitingForHuman = panel.pendingGate !== undefined ||
    panel.approvals.length > 0 ||
    panel.workflowStatus === "paused" ||
    state.manager.interactions.some((interaction) => interaction.conversationId === conversation.id);
  const roomStatus = readinessBlocked(panel)
    ? { status: "error", label: "Blocked" }
    : waitingForHuman
      ? { status: "paused", label: "Waiting for you" }
      : waitingForResources
        ? { status: "paused", label: "Waiting for capacity" }
        : panel.running || conversation.running
          ? { status: "running", label: statusLabel("running") }
          : { status: panel.workflowStatus, label: statusLabel(panel.workflowStatus) };
  const moreActions = readOnly
    ? `${inspectorItem}<button data-action="pipeline-new" ${panel.pipelineMutable && !selection ? "" : "disabled"} title="${escapeAttribute(selection ? `Switching to ${selection.pipelineId}…` : panel.pipelineMutationReason ?? "Archived runs are read-only")}">New pipeline</button><button data-action="transcript-export">Export transcript</button><button data-action="run-unarchive" data-conversation="${escapeAttribute(rootConversation.id)}">Unarchive run</button><div class="menu-section">${notificationModeControlHtml()}</div>`
    : `${inspectorItem}<button data-action="pipeline-new" ${panel.pipelineMutable && !selection ? "" : "disabled"} title="${escapeAttribute(selection ? `Switching to ${selection.pipelineId}…` : panel.pipelineMutationReason ?? "Create pipeline")}">New pipeline</button><button data-action="pipeline-fork" ${panel.selectedPipelineDefinition && panel.pipelineMutable && !selection ? "" : "disabled"}>Fork selected pipeline</button><button data-action="availability-check">Check agents</button><button data-action="working-directory">Choose folder</button>${hasOrchestrationState() ? "" : orchestrationStartButtonHtml}<button data-action="transcript-export">Export transcript</button><button class="danger" data-action="task-reset">Reset run</button><div class="menu-section">${notificationModeControlHtml()}</div>`;
  return `<header class="room-header"><div class="room-title-block">${parentNavigation}<h1 class="room-title-heading" title="${escapeAttribute(runTabTooltip(conversation, conversationStatus(conversation).label))}"><button class="room-title" data-action="rename-conversation" ${readOnly ? "disabled" : ""}>${escapeHtml(conversation.title)}</button></h1><div class="room-meta"><span class="room-status status-${escapeAttribute(roomStatus.status)}">${escapeHtml(roomStatus.label)}</span>${readOnly ? `<span>Archived · read-only</span>` : ""}${panel.activeStep ? `<span>${escapeHtml(panel.activeStep)}</span>` : ""}${state.roomView === "execution" || readOnly ? `<span>${escapeHtml(panel.selectedPipelineDefinition?.name ?? "No pipeline")}</span>` : ""}${conversation.iterationCount > 1 ? `<span>Iteration ${String(conversation.activeIteration)} of ${String(conversation.iterationCount)}</span>` : ""}</div></div><div class="room-actions">${interrupt}${notificationBellHtml()}<div class="view-switch" role="group" aria-label="Run view">${views.direction || state.roomView === "direction" ? `<button data-action="room-view" data-view="direction" class="${state.roomView === "direction" ? "selected" : ""}" aria-pressed="${state.roomView === "direction" ? "true" : "false"}">Direction</button>` : ""}<button data-action="room-view" data-view="chat" class="${state.roomView === "chat" ? "selected" : ""}" aria-pressed="${state.roomView === "chat" ? "true" : "false"}">Chat</button>${views.execution || state.roomView === "execution" ? `<button data-action="room-view" data-view="execution" class="${state.roomView === "execution" ? "selected" : ""}" aria-pressed="${state.roomView === "execution" ? "true" : "false"}">Execution${blockingCount > 0 ? ` (${String(blockingCount)})` : ""}</button>` : ""}</div><details class="header-action-menu" ${disclosureAttributes(`header-menu:${conversation.id}`)}><summary aria-label="Run actions" title="Run actions"><i class="codicon codicon-ellipsis" aria-hidden="true"></i></summary><div>${moreActions}</div></details></div></header>`;
};

const findingStateLabel: Record<LongitudinalFindingState, string> = {
  new: "New",
  repeated: "Repeated",
  accepted: "Accepted",
  rejected: "Rejected",
  unresolved: "Unresolved",
  resolved: "Resolved",
  regressed: "Regressed",
  reopened: "Reopened",
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
    <h3>${escapeHtml(title || "This step failed")}</h3>
    <p>${escapeHtml(statement)}</p>
    <p class="muted">Bachata will not run this somewhere else on its own.</p>
    ${actions ? `<ul class="failure-recovery-choices">${actions}</ul>` : ""}
    ${detail ? `<details class="failure-recovery-detail" ${disclosureAttributes(`recovery:${entry.id}`)}><summary>Technical detail</summary><div class="markdown">${renderMarkdown(detail)}</div></details>` : ""}
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
      condition: "This run is archived and read-only.",
      requirement: "Unarchive it to continue work.",
      action: {
        label: "Unarchive",
        attributes: `data-action="run-unarchive" data-conversation="${escapeAttribute(rootConversationFor(conversation).id)}"`,
      },
    });
  }
  if (!panel.workingDirectory && panel.workspaceRoots.length !== 1) {
    blockers.push({
      condition: panel.workspaceRoots.length === 0
        ? "No workspace folder is open."
        : "No working root is selected in this multi-root window.",
      requirement: "Choose the repository this run targets.",
      action: { label: "Choose folder", attributes: `data-action="working-directory"` },
    });
  }
  if (draft.pendingAttachments.size > 0) {
    blockers.push({
      condition: `${String(draft.pendingAttachments.size)} attachment${draft.pendingAttachments.size === 1 ? " is" : "s are"} still being stored.`,
      requirement: "Wait for the attachment to finish.",
    });
  }
  if (Array.from(state.pendingRuns.values()).some(
    (request) => request.conversationId === conversationId && !request.accepted,
  )) {
    blockers.push({
      condition: "A previous submit has not been accepted by the runtime yet.",
      requirement: "Wait for it to be accepted or rejected, or discard it and send again.",
      action: { label: "Discard pending submit", attributes: `data-action="run-discard-pending"` },
    });
  }
  (panel.executionContract?.policyRefusals ?? []).forEach((refusal) => blockers.push({
    condition: refusal,
    requirement: "This repository's policy file refuses this run; change the pipeline or the policy before it can start.",
  }));
  if (draft.delivery === "immediate" && conversation?.waitingForResources === true) {
    blockers.push({
      condition: "Waiting for shared capacity.",
      requirement: "No provider or verification command has started. Cancel the wait, or queue this message instead.",
    });
  } else if (draft.delivery === "immediate" && panel.running) {
    blockers.push({
      condition: "A run is already executing here.",
      requirement: "Stop it, or choose Queue or Interrupt in the run options.",
    });
  }
  if (draft.prompt.trim().length === 0) {
    // EX-UI-02. Still a blocker, so Send stays refused and says why when asked; not drawn in the
    // list, because the field's own placeholder and the room's intro card already say it and a
    // third copy is the first thing a reader sees in an empty room.
    blockers.push({
      condition: "The run input is empty.",
      requirement: "Describe what this run must do.",
      quiet: true,
    });
  }
  const acknowledgement = panel.contractAcknowledgement;
  if (acknowledgement?.acknowledgementRequired === true) {
    blockers.push({
      condition: acknowledgement.diff.changes.length > 0
        ? "This run's authority is wider than the contract you last acknowledged."
        : "This run can write to the repository and its contract has not been acknowledged.",
      requirement: "Read the execution contract, then acknowledge it.",
      action: {
        label: "Acknowledge contract",
        attributes: `data-action="contract-acknowledge" data-fingerprint="${escapeAttribute(acknowledgement.fingerprint)}"`,
      },
    });
  }
  (panel.readiness?.findings ?? [])
    .filter((finding) => finding.status !== "ready")
    .forEach((finding) => blockers.push({
      condition: `${finding.label}: ${finding.detail}`,
      requirement: finding.status === "unsupported"
        ? "This pipeline cannot run in this window."
        : "Resolve this before the run can start.",
      ...(finding.remediationId
        ? {
            action: {
              label: "Fix",
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

const sendBlockersHtml = (blockers: SendBlocker[]): string => {
  const visible = blockers.filter((blocker) => blocker.quiet !== true);
  if (visible.length === 0) {
    return "";
  }
  return sendBlockersListHtml(visible);
};

// What a screen reader is told when Send refuses: the conditions as sentences, not the
// container's textContent, which runs the button labels into them.
const sendBlockersAnnouncement = (blockers: SendBlocker[]): string =>
  `Send is disabled. ${blockers.map((blocker) => `${blocker.condition} ${blocker.requirement}`).join(" ")}`;

const sendBlockersListHtml = (blockers: SendBlocker[]): string => {
  const announcement = sendBlockersAnnouncement(blockers);
  return `<div class="composer-blockers" id="composer-blockers" tabindex="-1" data-announcement="${escapeAttribute(announcement)}"><strong ${liveRegionAttributes("composer-blockers", "status", announcement)}>Send is disabled: ${escapeHtml(countLabel(blockers.length, "condition"))}</strong><ul>${blockers.map((blocker) => `<li><span class="blocker-condition">${escapeHtml(blocker.condition)}</span> <span class="blocker-requirement">${escapeHtml(blocker.requirement)}</span> ${blocker.action ? `<button ${blocker.action.attributes}>${escapeHtml(blocker.action.label)}</button>` : ""}</li>`).join("")}</ul></div>`;
};

/**
 * A blocked Send stays reachable and says why.
 *
 * `disabled` takes the control out of the tab order, so a keyboard reader arrives at the end of
 * the composer having never met the button and never heard the conditions that hold it. The
 * control keeps its place, is marked aria-disabled, points at the list of conditions, and the
 * action dispatcher is what refuses to fire it.
 */
const composerSubmitStateAttributes = (canSubmit: boolean, blockers: SendBlocker[]): string => {
  if (canSubmit) return "";
  // EX-UI-02. When the only condition is the one the field itself states, the reason travels on
  // the control rather than as a third copy of the same sentence above it.
  const visible = blockers.filter((blocker) => blocker.quiet !== true);
  return visible.length > 0
    ? `aria-disabled="true" aria-describedby="composer-blockers"`
    : `aria-disabled="true" aria-description="${escapeAttribute(blockers.map((blocker) => `${blocker.condition} ${blocker.requirement}`).join(" "))}"`;
};

const mainRoomHtml = (): string => {
  const conversation = activeConversation();
  if (!conversation) {
    // EX-UI-02. The Direction centre is offered where there is direction state, the same rule the
    // room header and `directionRender` already apply. Without it this room drew the whole centre,
    // five permanently visible secondary buttons included, for a workspace that has no direction.
    return `<main class="room-empty"><div><h1>No run selected</h1><p class="room-empty-promise">Bachata reviews code with several AI agents that challenge each other's findings. Start a run to pick a pipeline and describe the job.</p><div class="compact-actions room-empty-actions"><button class="primary" data-action="create-conversation">Start a run</button>${hasOrchestrationState() ? "" : orchestrationStartButtonHtml}</div></div>${hasDirectionState() ? directionHtml() : ""}${orchestrationHtml()}${recentActivityHtml()}</main>`;
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
    interactions: !readOnly && state.manager.interactions.some((interaction) => interaction.conversationId === conversation.id),
    workflow: (state.manager.eventsByConversation[conversation.id] ?? []).length > 0,
    result: state.manager.resultsByConversation?.[conversation.id] !== undefined,
    childRuns: isRoot && childConversationsFor(conversation.id).length > 0,
    orchestration: !readOnly && isRoot && hasOrchestrationState(),
    providerHistory: (state.manager.conversationLocators?.[conversation.id] ?? []).length > 0,
  };
  const introNeeded = panel.transcript.length === 0 &&
    !has.workflow && !has.childRuns && !has.interactions && !has.result;
  const archivedBanner = readOnly
    ? `<div class="archive-readonly-banner"><strong>Archived run</strong><span>History is read-only. Unarchive it to continue work.</span><button data-action="run-unarchive" data-conversation="${escapeAttribute(rootConversation.id)}">Unarchive</button></div>`
    : "";
  const blockingCount = (panel.pendingGate ? 1 : 0) + panel.approvals.length;
  const blockingSummary = `${String(blockingCount)} blocking ${blockingCount === 1 ? "decision" : "decisions"} pending.`;
  const blockingBanner = !readOnly && blockingCount > 0
    ? `<div class="blocking-workflow-banner" ${liveRegionAttributes("blocking-decisions", "status", blockingSummary)}><strong>Run needs your input</strong><span>${escapeHtml(blockingSummary)}</span><button data-action="room-view" data-view="execution" data-focus="pending-decision">Review and continue</button></div>`
    : "";
  // A tab that leads to a placeholder is not a route to anything. Execution is offered once the
  // room has something to execute or something already executed, and always while the user is
  // standing in it.
  const hasExecutionState = has.result || has.providerHistory || has.orchestration ||
    has.workflow || has.childRuns || has.decisions || has.interactions;
  const chatContent = (): string => {
    const intro = introNeeded
      ? readOnly
        ? `<section class="conversation-intro">${bachataMarkHtml}<h2>Archived run</h2><p>No transcript entries were stored for this run.</p></section>`
        : `<section class="conversation-intro">${bachataMarkHtml}<h2>Start a run</h2><p>Pick a pipeline, enter a job, and watch it execute.</p></section>${recentActivityHtml()}`
      : "";
    const transcript = panel.transcript.map((entry) => transcriptMessageHtml(panel, entry, readOnly)).join("");
    // The decision that stops the run sits where the run is being read, not one view away.
    const decisions = has.decisions ? `${gateHtml(panel)}${approvalsHtml(panel)}` : "";
    return `${notificationBubbleHtml()}${has.interactions ? interactionsHtml(conversation.id) : ""}<h2 class="sr-only">Conversation</h2>${panel.transcriptError ? `<p class="error-banner">${escapeHtml(panel.transcriptError)}</p>` : ""}${panel.transcriptHasMore ? `<button class="load-older" data-action="load-older">Load older messages</button>` : ""}${intro}${transcript}${readOnly ? "" : liveMessagesHtml(panel)}${decisions}${has.result ? resultSummaryHtml(conversation.id) : ""}${readOnly ? "" : queueHtml(panel)}`;
  };
  const executionContent = (): string => `${has.result ? resultCenterHtml(conversation.id, panel) : ""}${has.providerHistory ? providerHistoryHtml(conversation.id) : ""}${has.orchestration ? orchestrationHtml() : ""}${has.workflow ? workflowHtml(conversation.id) : ""}${has.childRuns ? childRunsHtml(conversation.id) : ""}${has.decisions ? `${gateHtml(panel)}${approvalsHtml(panel)}` : ""}${has.interactions ? interactionsHtml(conversation.id) : ""}${hasExecutionState ? "" : `<section class="conversation-intro">${bachataMarkHtml}<h2>Execution view</h2><p>Pipeline stages, task runs, gates, evidence, and final rulings appear here while the run executes.</p></section>`}`;
  const content = state.roomView === "direction"
    ? directionHtml()
    : `${directionBannerHtml()}${state.roomView === "execution" ? executionContent() : chatContent()}`;
  return `<section class="room-shell">${roomHeaderHtml(panel, conversation, { direction: hasDirectionState(), execution: hasExecutionState })}${archivedBanner}${blockingBanner}${browserBindingsHtml(panel, readOnly)}<div class="room-body ${state.inspectorOpen ? "with-inspector" : ""}"><main class="conversation-column"${inspectorCoversRoom() ? " inert" : ""}><div class="conversation-scroll ${introNeeded && state.roomView !== "execution" ? "is-empty" : ""}" id="conversation-scroll">${content}${state.roomView === "chat" ? "" : panel.transcriptError ? `<p class="error-banner">${escapeHtml(panel.transcriptError)}</p>` : ""}</div>${readOnly || state.roomView !== "chat" ? "" : composerHtml(panel, draft)}</main>${inspectorHtml(panel, readOnly)}</div></section>`;
};

// The finished run's verdict, said at the end of the transcript where the reader is, with the
// route to the evidence. Without it a completed run opened on the raw chat and nothing said
// there was a result.
const resultSummaryHtml = (conversationId: string): string => {
  const result = state.manager.resultsByConversation?.[conversationId];
  if (!result) return "";
  const assessment = result.finalAssessment?.summary;
  return `<section class="result-summary"><div><span class="decision-label">Run result</span><strong>${escapeHtml(resultHeadlineLabel(result))}</strong>${assessment ? `<p>${escapeHtml(assessment)}</p>` : ""}</div><button data-action="room-view" data-view="execution">Open the result</button></section>`;
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
