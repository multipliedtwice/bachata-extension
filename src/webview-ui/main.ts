
const editorTargetId = (): string => state.editorConversationId ?? activeId();

const editorPanel = (): PanelState =>
  state.panels.get(editorTargetId()) ?? emptyPanel();

const postRuntime = (message: unknown, conversationId = activeId()): void => {
  vscode.postMessage({ type: "conversation.runtime", conversationId, message });
};

const requestId = (): string => crypto.randomUUID();

const approvalKey = (agentId: string, requestIdValue: string): string => `${agentId}:${requestIdValue}`;

const pendingPipelineSelection = (conversationId = activeId()): { conversationId: string; pipelineId: string } | undefined =>
  Array.from(state.pendingPipelineSelections.values()).find((item) => item.conversationId === conversationId);

const editorSchemaFingerprint = (): string =>
  safeJson(Array.from(state.editorOutputSchemas.entries()).sort(([left], [right]) => left.localeCompare(right)));

const editorFingerprint = (): string => `${state.editorRaw}
${editorSchemaFingerprint()}`;

/**
 * The draft the editor is currently holding, in whichever mode holds it.
 *
 * `tolerant` is what the mode tabs use. A step's output schema is edited as free text, and an
 * unparsable one used to refuse the switch to JSON — so the one view that can repair the text was
 * the view a broken text locked you out of. A tolerant read reports the same errors and still
 * hands back the draft, leaving each unparsable schema at its last valid value.
 */
const parseEditorPipeline = (
  options: { tolerant?: boolean } = {},
): PipelineDefinition | undefined => {
  let pipeline: PipelineDefinition;
  if (state.editorMode === "form") {
    if (!state.editorDraft) {
      return undefined;
    }
    pipeline = clonePipeline(state.editorDraft);
    const errors: string[] = [];
    pipeline.steps.forEach((step) => {
      if (step.type !== "agent" || !step.output) {
        return;
      }
      const raw = state.editorOutputSchemas.get(step.id) ?? safeJson(step.output.schema);
      try {
        const schema: unknown = JSON.parse(raw);
        if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
          throw new Error(localize("must be a JSON object"));
        }
        step.output.schema = schema as JsonValue;
      } catch (error) {
        errors.push(localize("{0} output schema {1}", step.name, error instanceof Error ? error.message : String(error)));
      }
    });
    if (state.editorSourcePipelineId && pipeline.id !== state.editorSourcePipelineId) {
      errors.push(localize("Pipeline ID is locked while editing {0}. Create a new pipeline to use another ID.", state.editorSourcePipelineName ?? state.editorSourcePipelineId));
    }
    if (errors.length > 0) {
      state.editorErrors = errors;
      scheduleRender();
      if (options.tolerant !== true) {
        return undefined;
      }
    }
    return pipeline;
  }
  try {
    const parsed: unknown = JSON.parse(state.editorRaw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(localize("Pipeline JSON must be an object"));
    }
    const pipeline = parsed as PipelineDefinition;
    if (state.editorSourcePipelineId && pipeline.id !== state.editorSourcePipelineId) {
      throw new Error(localize("Pipeline ID is locked while editing {0}. Create a new pipeline to use another ID.", state.editorSourcePipelineName ?? state.editorSourcePipelineId));
    }
    return pipeline;
  } catch (error) {
    state.editorErrors = [error instanceof Error ? error.message : String(error)];
    scheduleRender();
    return undefined;
  }
};

const editorIsDirty = (): boolean => state.editorOpen && editorFingerprint() !== state.editorOriginalRaw;


const discardPipelineEditor = (): void => {
  state.editorOpen = false;
  delete state.editorConversationId;
  delete state.editorDraft;
  delete state.editorSourcePipelineId;
  delete state.editorSourcePipelineName;
  delete state.editorSourcePipelineHash;
  delete state.editorPipelineScopeKey;
  state.editorErrors = [];
  state.editorOutputSchemas.clear();
  state.expandedEditorCards.clear();
  delete state.pendingEditorOperation;
  const returnFocusSelector = state.editorReturnFocusSelector;
  delete state.editorReturnFocusSelector;
  scheduleRender();
  // Back to whatever opened the editor — the pencil, or the item in the run menu — rather than
  // the first match of a selector list, which was a menu item hidden in a closed menu.
  restoreDialogFocus(returnFocusSelector);
};

const closePipelineEditor = (force = false): boolean => {
  if (!force && state.pendingEditorOperation && !editorOperationStalled()) {
    return false;
  }
  if (!force && editorIsDirty()) {
    openDialog({
      kind: "discardEditor",
      title: localize("Discard pipeline changes?"),
      message: localize("Unsaved pipeline changes will be lost."),
      confirmLabel: localize("Discard changes"),
      danger: true,
    });
    return false;
  }
  discardPipelineEditor();
  return true;
};

const slugId = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48) || "item";

const autoGeneratedIdPattern = /^(agent|role|step|item)(-\d+)?$/u;

const generatedPipelineIdPattern = /^custom-pipeline-[a-z0-9]+$/u;

const idFollowsName = (currentId: string, previousName: string): boolean =>
  currentId === slugId(previousName) || autoGeneratedIdPattern.test(currentId);

const uniqueId = (base: string, used: Set<string>): string => {
  const normalized = base.trim() || "item";
  if (!used.has(normalized)) {
    return normalized;
  }
  let suffix = 2;
  while (used.has(`${normalized}-${String(suffix)}`)) {
    suffix += 1;
  }
  return `${normalized}-${String(suffix)}`;
};

const renameRecordKey = <T>(value: Record<string, T> | undefined, from: string, to: string): Record<string, T> | undefined => {
  if (!value || from === to || !(from in value)) {
    return value;
  }
  const next = { ...value };
  const moved = next[from];
  // `from in value` is checked above, so the key is there.
  if (moved !== undefined) {
    next[to] = moved;
  }
  delete next[from];
  return next;
};

const moveEditorCardKey = (kind: "agent" | "role" | "step", from: string, to: string): void => {
  if (state.expandedEditorCards.delete(editorCardKey(kind, from))) {
    state.expandedEditorCards.add(editorCardKey(kind, to));
  }
};

const replacePipelineReference = (pipeline: PipelineDefinition, from: string, to: string, kind: "agent" | "role"): void => {
  pipeline.steps.forEach((step) => {
    if (step.type === "agent" || step.type === "checklist") {
      step.participants = step.participants.map((value) => value === from ? to : value);
      const permissionModes = renameRecordKey(step.permissionModes, from, to);
      setOptionalProperty(step, "permissionModes", permissionModes);
      const approvalPolicies = renameRecordKey(step.approvalPolicies, from, to);
      setOptionalProperty(step, "approvalPolicies", approvalPolicies);
      if (step.type === "agent" && step.consensusConfig?.arbiter === from) {
        step.consensusConfig.arbiter = to;
      }
    } else if (step.type === "assignRoles") {
      step.roleAssignments = step.roleAssignments.map((assignment) => kind === "agent"
        ? { ...assignment, agentId: assignment.agentId === from ? to : assignment.agentId }
        : { ...assignment, role: assignment.role === from ? to : assignment.role });
    }
  });
};

const removePipelineReference = (pipeline: PipelineDefinition, id: string, kind: "agent" | "role"): void => {
  pipeline.steps.forEach((step) => {
    if (step.type === "agent" || step.type === "checklist") {
      step.participants = step.participants.filter((value) => value !== id);
      if (step.permissionModes) {
        delete step.permissionModes[id];
        if (Object.keys(step.permissionModes).length === 0) delete step.permissionModes;
      }
      if (step.approvalPolicies) {
        delete step.approvalPolicies[id];
        if (Object.keys(step.approvalPolicies).length === 0) delete step.approvalPolicies;
      }
      if (step.type === "agent" && step.consensusConfig?.arbiter === id) {
        step.consensusConfig.mode = "unanimous";
        delete step.consensusConfig.arbiter;
        if (step.consensusConfig.onMaxRounds === "requestArbiterRuling") {
          step.consensusConfig.onMaxRounds = "humanGate";
        }
      }
    } else if (step.type === "assignRoles") {
      step.roleAssignments = step.roleAssignments.filter((assignment) => kind === "agent" ? assignment.agentId !== id : assignment.role !== id);
    }
  });
};

const clonePipeline = (pipeline: PipelineDefinition): PipelineDefinition =>
  structuredClone(pipeline);

const jsonDetailsHtml = (title: string, value: unknown, key = title): string =>
  bachataWebviewBehavior.hasDetail(value)
    ? `<details class="activity-details" ${disclosureAttributes(`json:${key}`)}><summary><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i>${escapeHtml(title)}</summary>${codeBlockHtml(safeJson(value), "json")}</details>`
    : "";

const localRunStatusLabel = (label: string): string => {
  const labels: Record<string, string> = {
    Working: localize("Working"),
    "Waiting for you": localize("Waiting for you"),
    Failed: localize("Failed"),
    Completed: localize("Completed"),
    Ready: localize("Ready"),
    "Stopped by you": localize("Stopped by you"),
    Interrupted: localize("Interrupted"),
  };
  return labels[label] ?? label;
};

const statusLabel = (status: WorkflowStatus): string =>
  localRunStatusLabel(bachataWebviewBehavior.runStatusPresentation(bachataWebviewBehavior.runPhase(false, status)).label);

const gateActionLabel = (action: HumanGateAction): string => {
  const labels: Record<HumanGateAction, string> = {
    continue: localize("Continue"),
    skip: localize("Skip"),
    cancel: localize("Cancel"),
    retry: localize("Retry"),
    discardStep: localize("Discard results"),
    rerunStep: localize("Rerun step"),
    repeatConsensus: localize("Discuss again"),
    requestArbiterRuling: localize("Ask the arbiter to rule"),
    acceptUnresolved: localize("Finish with unresolved findings"),
    acceptParticipant: localize("Finish with selected conclusion"),
    rollback: localize("Return to step"),
  };
  return labels[action] ?? action;
};

const agentOrder = (panel: PanelState): string[] => Object.keys(panel.agents);
const agentSide = (panel: PanelState, agentId: string): "left" | "right" => {
  const index = agentOrder(panel).indexOf(agentId);
  return index < 0 || index % 2 === 0 ? "left" : "right";
};

const eventLabel = (entry: TranscriptEntry): string =>
  (entry.eventType ?? entry.kind).replaceAll(".", " ");

const workflowResumeMarkerHtml = (entry: TranscriptEntry): string => {
  const nextStepIndex = jsonRecord(entry.data)?.nextStepIndex;
  const label = typeof nextStepIndex === "number" && Number.isSafeInteger(nextStepIndex) && nextStepIndex >= 0
    ? localize("Continued after interruption · from step {0}", nextStepIndex + 1)
    : localize("Continued after interruption");
  return `<div class="workflow-transition" data-entry="${escapeAttribute(entry.id)}" role="separator" aria-label="${escapeAttribute(label)}"><span aria-hidden="true">${escapeHtml(label)}</span></div>`;
};

const browserActionCard = (panel: PanelState, entry: TranscriptEntry): string => {
  const agent = entry.agentId ? panel.agents[entry.agentId] : undefined;
  const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : undefined;
  const actionValue = data && "action" in data ? data.action : entry.data;
  const resultValue = data && "result" in data ? data.result : undefined;
  const title = entry.eventType === "browser.action.detected" ? localize("Action detected") : localize("Action result");
  return `<article class="action-card ${entry.eventType === "browser.action.result" ? "result" : "detected"}">
    <div class="activity-kicker">${escapeHtml(agent?.name ?? entry.agentId ?? localize("Browser agent"))} · ${escapeHtml(title)}</div>
    <div class="action-summary">${renderMarkdown(entry.text)}</div>
    ${actionValue === undefined ? "" : jsonDetailsHtml(localize("Action"), actionValue, `${entry.id}:action`)}
    ${resultValue === undefined ? "" : jsonDetailsHtml(localize("Result"), resultValue, `${entry.id}:result`)}
    <time datetime="${escapeAttribute(entry.createdAt)}" title="${escapeAttribute(formatDateTime(entry.createdAt))}">${escapeHtml(messageTime(entry.createdAt))}</time>
  </article>`;
};

// Only a canonical HTTP(S) origin is ever placed next to the Save action, so the value has to
// parse, carry a scheme the transfer path actually fetches, have a non-opaque origin, and
// re-serialize to itself exactly. That last check rejects a path, query, fragment, userinfo,
// whitespace, a written-out default port, or an uppercased scheme, none of which URL.origin can
// produce. Escaping is not validation: a value that fails is dropped, never rendered. This
// repeats browser/protocol.ts because the webview is compiled with module=None and shares no
// code with the extension host.
const assetSourceOrigin = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.origin !== "null" &&
    parsed.origin === value
    ? value
    : undefined;
};

const capturedAssets = (entry: TranscriptEntry): Array<{
  id: string;
  provider: "chatgpt" | "claude" | "generic";
  kind: string;
  name: string;
  mimeType?: string;
  size?: number;
  sourceElement: "assistantMessage" | "artifactPane";
  downloadAvailable: boolean;
  previewText?: string;
  sourceOrigin?: string;
}> => {
  const data = entry.data;
  if (!data || typeof data !== "object" || Array.isArray(data) || !("assets" in data) || !Array.isArray(data.assets)) {
    return [];
  }
  return data.assets.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    if (
      typeof value.id !== "string" ||
      (value.provider !== "chatgpt" && value.provider !== "claude" && value.provider !== "generic") ||
      typeof value.kind !== "string" ||
      typeof value.name !== "string" ||
      (value.sourceElement !== "assistantMessage" && value.sourceElement !== "artifactPane") ||
      typeof value.downloadAvailable !== "boolean" ||
      (value.mimeType !== undefined && typeof value.mimeType !== "string") ||
      (value.size !== undefined && (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0)) ||
      (value.previewText !== undefined && typeof value.previewText !== "string")
    ) {
      return [];
    }
    const sourceOrigin = assetSourceOrigin(value.sourceOrigin);
    return [{
      id: value.id,
      provider: value.provider,
      kind: value.kind,
      name: value.name,
      sourceElement: value.sourceElement,
      downloadAvailable: value.downloadAvailable,
      ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
      ...(typeof value.size === "number" ? { size: value.size } : {}),
      ...(typeof value.previewText === "string" ? { previewText: value.previewText } : {}),
      ...(sourceOrigin === undefined ? {} : { sourceOrigin }),
    }];
  });
};

const capturedAssetsHtml = (entry: TranscriptEntry, readOnly = false): string => {
  const assets = capturedAssets(entry);
  if (assets.length === 0) {
    return "";
  }
  return `<section class="browser-assets"><div class="browser-assets-heading">${escapeHtml(localize("Files and artifacts"))}</div>${assets
    .map((asset) => {
      const provider = browserProviderName(asset.provider);
      const source = asset.sourceElement === "artifactPane" ? localize("artifact pane") : localize("assistant reply");
      const size = asset.size === undefined ? "" : ` · ${escapeHtml(formatBytes(asset.size))}`;
      const actions = readOnly
        ? `<span class="browser-asset-unavailable">${escapeHtml(localize("Unarchive to save or open"))}</span>`
        : `${asset.downloadAvailable
          ? `<button data-action="browser-asset-save" data-asset-id="${escapeAttribute(asset.id)}">${escapeHtml(localize("Save to workspace…"))}</button>`
          : `<span class="browser-asset-unavailable">${escapeHtml(localize("Provider-only content"))}</span>`}<button data-action="browser-asset-reveal" data-asset-id="${escapeAttribute(asset.id)}">${escapeHtml(localize("Open in provider…"))}</button>`;
      return `<article class="browser-asset"><div class="browser-asset-main"><strong>${escapeHtml(asset.name)}</strong><span>${escapeHtml(provider)} · ${escapeHtml(asset.kind)} · ${escapeHtml(source)}${size}</span>${asset.mimeType ? `<small>${escapeHtml(asset.mimeType)}</small>` : ""}${asset.sourceOrigin ? `<span class="browser-asset-source">${escapeHtml(localize("Source link: {0}", asset.sourceOrigin))}</span>` : ""}</div><div class="browser-asset-actions">${actions}</div>${asset.previewText ? `<details class="browser-asset-preview" ${disclosureAttributes(`asset:${entry.id}:${asset.id}`)}><summary>${escapeHtml(localize("Preview"))}</summary>${codeBlockHtml(asset.previewText, "plain")}</details>` : ""}</article>`;
    })
    .join("")}</section>`;
};

const avatarHtml = (identity: string, name: string, className: string): string => {
  const hue = Array.from(identity).reduce((total, character) => (total * 31 + character.charCodeAt(0)) % 360, 7);
  return `<svg class="${className}" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="16" fill="hsl(${String(hue)} 46% 34%)"></circle><text x="16" y="16" text-anchor="middle" dominant-baseline="central" font-size="14" font-weight="700" fill="#ffffff">${escapeHtml(name.slice(0, 1).toUpperCase())}</text></svg>`;
};

const transcriptMessageHtml = (panel: PanelState, entry: TranscriptEntry, readOnly = false): string => {
  if (entry.eventType === "browser.action.detected" || entry.eventType === "browser.action.result") {
    return browserActionCard(panel, entry);
  }
  if (entry.eventType === "workflow.resumed") {
    return workflowResumeMarkerHtml(entry);
  }
  if (entry.eventType === "user.message") {
    return `<article class="message-row user-row" data-entry="${escapeAttribute(entry.id)}">
      ${avatarHtml("user", localize("You"), "agent-avatar user-avatar")}
      <div class="message user-message" title="${escapeAttribute(formatDateTime(entry.createdAt))}"><div class="message-author">${escapeHtml(localize("You"))}</div><div class="message-text markdown">${renderMarkdown(entry.text)}</div><time datetime="${escapeAttribute(entry.createdAt)}">${escapeHtml(messageTime(entry.createdAt))}</time></div>
    </article>`;
  }
  if (entry.agentId && ["answer", "interrupted", "error"].includes(entry.kind)) {
    const agent = panel.agents[entry.agentId];
    const side = agentSide(panel, entry.agentId);
    const fallback = entry.kind === "interrupted" ? localize("Interrupted") : "";
    return `<article class="message-row agent-row ${side}" data-entry="${escapeAttribute(entry.id)}" data-agent-id="${escapeAttribute(entry.agentId)}">
      ${avatarHtml(entry.agentId, agent?.name ?? entry.agentId, "agent-avatar")}
      <div class="message agent-message ${entry.kind === "error" ? "message-error" : ""}" title="${escapeAttribute(formatDateTime(entry.createdAt))}">
        <button class="message-author message-author-action" data-action="message-details" data-message-id="${escapeAttribute(entry.id)}">${escapeHtml(agent?.name ?? entry.agentId)}</button>
        <div class="message-text markdown">${entry.eventType === "provider.recovery" ? "" : renderMarkdown(entry.text || fallback)}</div>
        ${entry.eventType === "provider.recovery" ? providerRecoveryHtml(entry) : ""}
        ${entry.eventType === "browser.response" ? capturedAssetsHtml(entry, readOnly) : ""}
        ${entry.eventType === "provider.failure" ? jsonDetailsHtml(localize("Technical detail"), entry.data, `${entry.id}:activity`) : ""}
        <time datetime="${escapeAttribute(entry.createdAt)}">${escapeHtml(messageTime(entry.createdAt))}</time>
      </div>
    </article>`;
  }
  const preflight = preflightRecordOf(entry);
  if (preflight !== undefined) {
    return `<article class="system-message system-error run-preflight-failure" data-entry="${escapeAttribute(entry.id)}">
    <p class="run-preflight-text">${escapeHtml(entry.text)}</p>
    ${readOnly ? "" : preflightActionsHtml(preflight)}
    ${preflightDetailsHtml(preflight, `preflight:${entry.id}`)}
    <time datetime="${escapeAttribute(entry.createdAt)}" title="${escapeAttribute(formatDateTime(entry.createdAt))}">${escapeHtml(messageTime(entry.createdAt))}</time>
  </article>`;
  }
  const exactPrompt = entry.eventType === "agent.prompt";
  return `<article class="system-message ${entry.kind === "error" ? "system-error" : ""} ${exactPrompt ? "exact-prompt" : ""}" data-entry="${escapeAttribute(entry.id)}">
    <div class="activity-kicker">${escapeHtml(eventLabel(entry))}${entry.step ? ` · ${escapeHtml(entry.step)}` : ""}</div>
    ${exactPrompt ? `<details ${disclosureAttributes(`prompt:${entry.id}`)}><summary>${escapeHtml(localize("Exact prompt"))}</summary><div class="markdown exact-prompt-body">${renderMarkdown(entry.text)}</div></details>` : `<div class="markdown">${renderMarkdown(entry.text)}</div>`}
    ${entry.data === undefined ? "" : jsonDetailsHtml(entry.eventType === "provider.failure" ? localize("Technical detail") : localize("Structured data"), entry.data, `${entry.id}:structured`)}
    <time datetime="${escapeAttribute(entry.createdAt)}" title="${escapeAttribute(formatDateTime(entry.createdAt))}">${escapeHtml(messageTime(entry.createdAt))}</time>
  </article>`;
};

/**
 * Event types the primary chat keeps even though they are not a participant's answer: a request,
 * a decision the reader has to act on, or a statement that the run changed course.
 */
const primaryChatEventTypes = new Set<string>([
  "user.message",
  "provider.recovery",
  "browser.action.detected",
  "browser.action.result",
  "browser.response",
  "workflow.resumed",
  "workflow.restarted",
  "workflow.settingsRejected",
]);

/**
 * Whether an entry is bookkeeping rather than conversation.
 *
 * The chat is where a reader follows what was asked and what came back. Exact prompts, step
 * transitions and status lines are provenance: each one true, and together the reason a four-step
 * run scrolled past several screens of "AGENT PROMPT · INDEPENDENT SPECIALIST ANALYSIS" cards
 * before the first answer. They are kept, in order, inside one disclosure — nothing is dropped,
 * and the reader decides when to read it.
 */
const isRunInformationEntry = (entry: TranscriptEntry): boolean => {
  if (entry.eventType !== undefined && primaryChatEventTypes.has(entry.eventType)) return false;
  if (entry.kind === "error") return false;
  if (entry.agentId !== undefined && (entry.kind === "answer" || entry.kind === "interrupted")) {
    return false;
  }
  return true;
};

const liveMessagesHtml = (panel: PanelState): string =>
  Object.values(panel.agents)
    .filter((agent) => agent.status === "running")
    .map((agent) => {
      const side = agentSide(panel, agent.id);
      return `<article class="message-row agent-row ${side} live-message" data-agent-id="${escapeAttribute(agent.id)}">
        ${avatarHtml(agent.id, agent.name, "agent-avatar")}
        <div class="message agent-message"><div class="message-author"><button class="message-author-action" data-action="message-details" data-agent="${escapeAttribute(agent.id)}" aria-label="${escapeAttribute(localize("View prompt for {0}", agent.name))}">${escapeHtml(agent.name)}</button> <span class="typing">${escapeHtml(localize("working"))}</span></div><div class="message-text markdown" data-live-agent-output="${escapeAttribute(agent.id)}">${renderMarkdown(agent.output || "…")}</div></div>
      </article>`;
    })
    .join("");

const queueAudience = (panel: PanelState, message: QueuedMessage): string => {
  const names = message.recipients.map((agentId) => panel.agents[agentId]?.name ?? agentId);
  const mode = message.mode === "review" ? localize("review, read-only") : localize("implementation, may write");
  return names.length === 0 ? localize("Recipients chosen by the pipeline · {0}", mode) : localize("To {0} · {1}", listText(names, ", "), mode);
};

const queueHtml = (panel: PanelState): string => {
  if (panel.queuedMessages.length === 0) {
    return "";
  }
  const queued = panel.queuedMessages
    .map((message, index) => {
      const headline = message.kind === "pipeline"
        ? (message.iterationCount ?? 1) > 1 ? localize("Pipeline · {0} iterations", message.iterationCount ?? 1) : localize("Pipeline")
        : localize("Direct message");
      // A queue of identical "Cancel" buttons names nothing, and the prompt is clamped to three
      // lines, so the control says which message it drops and the prompt keeps its full text.
      return `<article class="queue-item" title="${escapeAttribute(formatDateTime(message.createdAt))}"><span class="queue-index">${String(index + 1)}</span><div><strong>${escapeHtml(headline)}</strong><small>${escapeHtml(queueAudience(panel, message))}</small><p class="queue-prompt" title="${escapeAttribute(message.prompt)}">${escapeHtml(message.prompt)}</p>${message.blockedReason ? `<p ${liveRegionAttributes(`queue-blocked:${message.id}`, "alert", message.blockedReason)}>${escapeHtml(message.blockedReason)}</p>` : ""}</div><button data-action="queue-cancel" data-message-id="${escapeAttribute(message.id)}" aria-label="${escapeAttribute(localize("Cancel queued message {0}, {1}", index + 1, headline))}">${escapeHtml(localize("Cancel"))}</button></article>`;
    })
    .join("");
  const queueBlocked = Boolean(panel.queuedMessages[0]?.blockedReason);
  return `<section class="queue-panel"><div class="queue-heading"><strong>${escapeHtml(localize("Queued messages"))}</strong>${panel.queuePaused && !queueBlocked ? `<button data-action="queue-resume">${escapeHtml(localize("Resume queue"))}</button>` : ""}</div>${queued}</section>`;
};

const attachmentStripHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const pending = Array.from(draft.pendingAttachments.values())
    .map((attachment) => `<div class="attachment-chip pending"><img src="${escapeAttribute(attachment.previewUrl)}" alt=""><span>${escapeHtml(attachment.name)}</span><small>${escapeHtml(localize("uploading"))}</small></div>`)
    .join("");
  const stored = panel.attachments
    .map((attachment) => {
      const inputId = `attachment-${attachment.id}`;
      const preview = attachment.previewUri
        ? `<img src="${escapeAttribute(attachment.previewUri)}" alt="${escapeAttribute(localize("Preview of {0}", attachment.name))}">`
        : "";
      return `<div class="attachment-chip" title="${escapeAttribute(attachment.name)}"><input id="${escapeAttribute(inputId)}" type="checkbox" data-action="attachment-select" data-attachment-id="${escapeAttribute(attachment.id)}" aria-label="${escapeAttribute(localize("Include {0} in this message", attachment.name))}" ${draft.selectedAttachmentIds.has(attachment.id) ? "checked" : ""}><label for="${escapeAttribute(inputId)}">${preview}<span>${escapeHtml(attachment.name)}</span><small>${escapeHtml(formatBytes(attachment.size))}</small></label><button type="button" class="icon-button" data-action="attachment-remove" data-attachment-id="${escapeAttribute(attachment.id)}" aria-label="${escapeAttribute(localize("Remove attachment {0}", attachment.name))}">×</button></div>`;
    })
    .join("");
  return pending || stored ? `<div class="attachment-strip-shell"><div class="attachment-strip">${pending}${stored}</div></div>` : "";
};

/**
 * Whether TODO orchestration has anything to report.
 *
 * The card rendered on every idle room with nothing in it but a "Run TODO.md" button, so an
 * orchestration surface was permanently on screen for work that had never started. The start
 * action moved to the room's overflow menu, which is what lets the empty card be absent rather
 * than merely quiet.
 */
// The runtime's status enums, said as words. The run header already does this for workflow
// status; a card two inches away printing "cleanupPending" beside it read as a different product.
const orchestrationStatusLabels: Record<string, string> = {
  pending: localize("Pending"),
  queued: localize("Queued"),
  running: localize("Working"),
  stopping: localize("Stopping"),
  stopped: localize("Stopped"),
  completed: localize("Completed"),
  blocked: localize("Blocked"),
  failed: localize("Failed"),
  abandoning: localize("Abandoning"),
  cleanupPending: localize("Cleanup needed"),
  abandoned: localize("Abandoned"),
  skipped: localize("Skipped"),
};

const orchestrationStatusLabel = (status: string): string =>
  orchestrationStatusLabels[status] ?? status;

const agentStatusLabels: Record<AgentStatus, string> = {
  unknown: localize("Unknown"),
  available: localize("Available"),
  idle: localize("Idle"),
  running: localize("Working"),
  interrupted: localize("Interrupted"),
  error: localize("Failed"),
};

const hasOrchestrationState = (): boolean => {
  const orchestration = state.manager.orchestration;
  return orchestration.runId !== undefined ||
    orchestration.active ||
    orchestration.tasks.length > 0 ||
    (orchestration.retainedRuns ?? []).length > 0;
};

const orchestrationStartButtonHtml = (): string => `<button data-action="orchestration-start" ${orchestrationStartPending ? `disabled aria-busy="true" title="${escapeAttribute(localize("Waiting for TODO orchestration to start"))}"` : ""}>${escapeHtml(orchestrationStartPending ? localize("Starting TODO.md…") : localize("Run TODO.md"))}</button>`;

const orchestrationHtml = (): string => {
  if (!hasOrchestrationState()) {
    return "";
  }
  const orchestration = state.manager.orchestration;
  const run = orchestration.runId !== undefined;
  const active = orchestration.active;
  const controls = orchestration.status === "abandoning"
    ? `<button class="danger" data-action="orchestration-abandon" ${active ? "disabled" : ""}>${escapeHtml(localize("Retry Git cleanup"))}</button>`
    : active
      ? `<button data-action="orchestration-stop">${escapeHtml(localize("Stop and interrupt active work"))}</button><button class="danger" data-action="orchestration-abandon">${escapeHtml(localize("Abandon Git resources"))}</button>`
      : run && ["stopped", "failed", "blocked"].includes(orchestration.status ?? "")
        ? `<button class="primary" data-action="orchestration-resume">${escapeHtml(localize("Resume TODO run"))}</button><button class="danger" data-action="orchestration-abandon">${escapeHtml(localize("Abandon Git resources"))}</button>`
        : `<button class="primary" data-action="orchestration-start">${escapeHtml(localize("Run TODO.md"))}</button>`;
  const tasks = orchestration.tasks.length === 0 ? "" : `<div class="orchestration-tasks">${orchestration.tasks.map((task) => `<button data-action="${task.conversationId ? "select-conversation" : "noop"}" ${task.conversationId ? `data-conversation="${escapeAttribute(task.conversationId)}"` : "disabled"} class="orchestration-task status-${escapeAttribute(task.status)}"><span class="room-presence status-${escapeAttribute(task.status)}"></span><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(orchestrationStatusLabel(task.status))} · ${escapeHtml(localize("attempt {0}", task.attempts))}</small>${task.lastError ? `<small class="error">${escapeHtml(task.lastError)}</small>` : ""}${(task.blockers ?? []).length === 0 ? "" : `<small class="blocker">${escapeHtml(localize("Blocked by: {0}", listText(task.blockers, " · ")))}</small>`}${task.summary ? `<small>${renderInline(task.summary)}</small>` : ""}</span></button>`).join("")}</div>`;
  const retainedRuns = orchestration.retainedRuns ?? [];
  const retained = retainedRuns.length === 0
    ? ""
    : `<section class="retained-runs"><div class="retained-runs-heading"><strong>${escapeHtml(localize("Retained TODO runs"))}</strong><small>${escapeHtml(localize("Integration worktrees remain until cleanup completes."))}</small></div>${retainedRuns.map((item) => {
      const cleanupPending = item.status === "cleanupPending";
      const disabled = active;
      const disabledTitle = active
        ? `title="${escapeAttribute(localize("Wait for the active TODO operation to finish"))}"`
        : "";
      return `<article class="retained-run" title="${escapeAttribute(formatDateTime(item.updatedAt))}">
      <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.integrationBranch)}</small><span class="path-line">${escapeHtml(item.integrationWorktree)}</span><small>${escapeHtml(item.taskCount === 1 ? localize("{0} task", item.taskCount) : localize("{0} tasks", item.taskCount))} · ${escapeHtml(cleanupPending ? localize("cleanup pending") : localize("completed"))}</small></div>
      <div class="compact-actions"><button data-action="orchestration-reveal" data-run-id="${escapeAttribute(item.runId)}" ${cleanupPending ? `disabled title="${escapeAttribute(localize("The retained path may already be removed"))}"` : ""}>${escapeHtml(localize("Reveal worktree"))}</button><button class="danger" data-action="orchestration-cleanup" data-run-id="${escapeAttribute(item.runId)}" data-run-title="${escapeAttribute(item.title)}" data-run-branch="${escapeAttribute(item.integrationBranch)}" data-cleanup-pending="${cleanupPending ? "true" : "false"}" ${disabled ? `disabled ${disabledTitle}` : ""}>${escapeHtml(cleanupPending ? localize("Retry cleanup") : localize("Clean up Git resources"))}</button></div>
    </article>`;
    }).join("")}</section>`;
  const idle = !active && !run && orchestration.tasks.length === 0 && retainedRuns.length === 0;
  const done = orchestration.tasks.filter((task) => task.status === "completed").length;
  const progress = orchestration.tasks.length > 0 ? ` · ${escapeHtml(localize("{0} of {1} tasks done", done, orchestration.tasks.length))}` : "";
  return `<details class="orchestration-card" ${disclosureAttributes("orchestration", !idle)}><summary class="section-heading"><div><strong>${escapeHtml(orchestration.title ?? localize("TODO orchestration"))}</strong><small>${escapeHtml(orchestration.status === undefined ? localize("No active TODO run") : orchestrationStatusLabel(orchestration.status))}${progress}${orchestration.integrationBranch ? ` · ${escapeHtml(orchestration.integrationBranch)}` : ""}</small></div><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary><div class="orchestration-body"><div class="compact-actions">${controls}</div>${tasks}${retained}</div></details>`;
};

const participantsHtml = (panel: PanelState, readOnly = false): string => {
  const sessions = panel.browserBridge.sessions;
  const controlsLocked = readOnly || runConfigurationLocked(panel);
  return Object.values(panel.agents)
    .map((agent) => {
      const provider = browserProviderForAdapterType(agent.adapterType);
      const providerSessions = provider ? sessions.filter((session) => session.provider === provider) : [];
      const browserSelect = provider
        ? `<label class="field"><span>${escapeHtml(localize("Browser conversation"))}</span><select data-action="browser-session" data-agent="${escapeAttribute(agent.id)}" ${controlsLocked ? "disabled" : ""}><option value="">${escapeHtml(localize("Not bound"))}</option>${providerSessions.map((session) => `<option value="${escapeAttribute(session.id)}" ${agent.sessionId === session.id ? "selected" : ""} ${session.status !== "ready" ? "disabled" : ""}>${escapeHtml(session.title ?? session.conversationUrl)} · ${escapeHtml(browserSessionCapabilityLabel(session))}</option>`).join("")}</select></label>`
        : "";
      const roles = Object.entries(panel.roles).filter(([, id]) => id === agent.id).map(([role]) => role).join(", ");
      return `<article class="participant-card" title="${escapeAttribute(agent.version ? localize("Provider version {0}", agent.version) : localize("Provider version not reported"))}"><div class="participant-heading">${avatarHtml(agent.id, agent.name, "participant-avatar")}<div><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.adapterType)}</small></div><span class="agent-status status-${escapeAttribute(agent.status)}">${escapeHtml(agentStatusLabels[agent.status] ?? agent.status)}</span></div>${agent.error ? `<p class="error">${escapeHtml(agent.error)}</p>` : ""}${browserSelect}<div class="participant-actions"><small>${escapeHtml(roles || localize("No assigned role"))}</small><button data-action="session-reset" data-agent="${escapeAttribute(agent.id)}" ${controlsLocked || !agent.sessionId ? "disabled" : ""}>${escapeHtml(localize("Reset session"))}</button></div></article>`;
    })
    .join("");
};

const browserSessionCapabilityLabel = (session: BrowserSession): string => {
  // First match only, as before: one caveat is what fits beside a tab's title in a picker.
  const status = labelFor(browserSessionStatusLabel, session.status);
  if (session.provider !== "generic" || !session.capabilities) return status;
  if (session.capabilities.conversationState === "uncertain") return localize("{0} · unverified history", status);
  if (session.capabilities.completion === "manualOnly") return localize("{0} · you mark answers complete", status);
  if (session.capabilities.submission !== "verifiedSend") return localize("{0} · unverified send", status);
  if (session.capabilities.interruption !== "confirmed") return localize("{0} · cannot be interrupted", status);
  return localize("{0} · fully automatic", status);
};

// Under 900px the inspector is a sheet over the room body, and a sheet that leaves the controls
// beneath it in the tab order is a trap: Stop and Send were reachable through it.
const inspectorCoversRoom = (): boolean =>
  state.inspectorOpen &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(max-width: 900px)")?.matches === true;

const inspectorHtml = (panel: PanelState, readOnly = false): string => {
  if (!state.inspectorOpen) {
    return "";
  }
  const bridge = panel.browserBridge;
  const bridgePresentation = browserBridgePresentation(bridge, "inspector:bridge");
  const pipeline = panel.selectedPipelineDefinition;
  const pipelineSummary = pipeline ? `<section class="inspector-pipeline"><h3>${escapeHtml(localize("Pipeline"))}</h3><div class="inspector-summary-row"><div><strong>${escapeHtml(pipeline.name)}</strong><small>${escapeHtml(countLabel(pipeline.steps.filter((step) => step.enabled).length, "step"))} · ${escapeHtml(countLabel(pipeline.agents.length, "participant"))}</small></div><button data-action="pipeline-view">${escapeHtml(localize("View pipeline"))}</button></div></section>` : "";
  const controlsLocked = readOnly || runConfigurationLocked(panel);
  const bridgeActions = !bridge.enabled ? "" : `<div class="compact-actions bridge-pairing-actions">${bridge.pairingToken && !bridge.connected ? `<button data-action="bridge-copy-token"${readOnly ? " disabled" : ""}>${escapeHtml(localize("Copy pairing token"))}</button>` : ""}<button data-action="bridge-discover"${readOnly ? " disabled" : ""}>${escapeHtml(localize("Find browser"))}</button><button data-action="bridge-reset"${controlsLocked ? " disabled" : ""}>${escapeHtml(localize("Reset pairing"))}</button></div>`;
  return `<aside class="inspector" aria-label="${escapeAttribute(localize("Run details"))}"><div class="inspector-header"><h2 id="inspector-title" tabindex="-1">${escapeHtml(localize("Run details"))}</h2><button class="icon-button" data-action="inspector-toggle" aria-label="${escapeAttribute(localize("Close run details"))}">×</button></div><div class="inspector-scroll"><section><h3>${escapeHtml(localize("Participants"))}</h3>${participantsHtml(panel, readOnly)}</section>${pipelineSummary}<section class="inspector-environment"><h3>${escapeHtml(localize("Environment"))}</h3><dl class="bridge-details"><dt>${escapeHtml(localize("Folder"))}</dt><dd>${escapeHtml(panel.workingDirectory ?? localize("Not selected"))}</dd><dt>${escapeHtml(localize("Browser Bridge"))}</dt><dd>${bridgePresentation.statusHtml}</dd></dl>${bridgeActions}${bridgePresentation.reasonHtml}<div class="compact-actions"><button data-action="working-directory" ${controlsLocked ? "disabled" : ""}>${escapeHtml(localize("Choose folder"))}</button><button data-action="availability-check" ${controlsLocked || !agentsAssignable(panel) ? "disabled" : ""}${!agentsAssignable(panel) ? ` title="${escapeAttribute(localize("Select a pipeline with participants to check providers."))}"` : ""}>${escapeHtml(localize("Check providers"))}</button></div></section></div></aside>`;
};

// The read-only sweep still disables outright; the composer's own blockers no longer do.
const composerSubmitBlocked = (button: HTMLButtonElement): boolean =>
  button.disabled || button.getAttribute("aria-disabled") === "true";

const refreshComposerSubmitState = (): void => {
  const action = root.querySelector<HTMLElement>(".composer-send");
  if (action) action.innerHTML = composerPrimaryActionHtml(activePanel(), activeDraft());
};

const safetyLevelLabels: Record<ExecutionContract["safetyLevel"], string> = {
  review: localize("Review · read-only"),
  interactive: localize("Interactive implementation · you approve actions"),
  managed: localize("Managed implementation · controller-owned scope and verification"),
  orchestration: localize("TODO orchestration · isolated unattended execution"),
};

const writeScopeLabels: Record<ExecutionContract["scope"]["writeScope"], string> = {
  readOnly: localize("no repository writes"),
  task: localize("isolated task worktree"),
  configured: localize("configured working directory"),
  workspace: localize("workspace files"),
};

const contractStatusLabels: Record<ExecutionContract["providers"][number]["status"], string> = {
  ready: localize("ready"), blocked: localize("blocked"), needsSetup: localize("needs setup"), unsupported: localize("not supported here"),
};

const contractGateLabels: Record<string, string> = {
  none: localize("no human decision"), both: localize("before and after the step runs"),
  before: localize("before the step runs"), beforeStep: localize("before the step runs"),
  after: localize("after the step runs"), afterStep: localize("after the step runs"),
  invalidConsensus: localize("when a consensus round is invalid"), maxConsensusRounds: localize("at the consensus round limit"),
};

const writeScopeText = (value: string): string =>
  value === "readOnly" || value === "task" || value === "configured" || value === "workspace"
    ? writeScopeLabels[value]
    : value;

const authorityChangeValue = (label: string, value: string): string =>
  label === "Write scope" ? writeScopeText(value)
    : label === "Commit authority" ? (value === "allow" ? localize("commits allowed") : value === "never" ? localize("no commits") : value)
      : value;


const contractList = (values: string[], empty: string): string => values.length > 0
  ? `<ul class="contract-list">${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
  : `<p class="muted">${escapeHtml(empty)}</p>`;

// The composer's rendering — the surface, the pipeline picker, the settings panel and the run
// contract — and the pipeline-picker control functions live in composerRender.ts; the contract
// label maps above are consumed there. The picker functions are called from the action dispatch
// and the document keydown handler below.

const refreshInteractionSubmitState = (interactionRef: string): void => {
  const interaction = state.manager.interactions.find((item) => item.interactionRef === interactionRef);
  const button = root.querySelector<HTMLButtonElement>(
    `[data-action="interaction-submit"][data-interaction-ref="${interactionRef}"]`,
  );
  if (!interaction || !button) {
    return;
  }
  const selected = Array.from(
    root.querySelectorAll<HTMLInputElement>(`[data-interaction-option="${interactionRef}"]:checked`),
  ).map((input) => input.value);
  const text = interaction.secret
    ? state.secretDrafts.get(interactionRef) ?? ""
    : root.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `#interaction-text-${interactionRef}`,
      )?.value ?? "";
  const pending = state.pendingInteractions.has(interactionRef);
  button.disabled = pending || !interactionCanSubmit(interaction, selected, text);
  const blockedReason = interactionSubmitBlockedReason(interaction, selected, text);
  if (blockedReason === undefined) button.removeAttribute("title");
  else button.title = blockedReason;
  button.textContent = pending ? localize("Submitting…") : interactionSubmitLabel(interaction, selected);
  const textInput = root.querySelector<HTMLTextAreaElement>(`#interaction-text-${interactionRef}`);
  if (interaction.kind === "humanGate" && textInput) {
    const presentation = interactionTextPresentation(interaction, selected);
    textInput.placeholder = presentation.placeholder;
    textInput.setAttribute("aria-label", presentation.label);
  }
};

const interactionPromptHtml = (
  interaction: InteractionSummary,
  promptId: string,
): string => {
  const [firstLine, ...detailLines] = interaction.prompt.split("\n");
  const summary = firstLine ?? interaction.prompt;
  const inlineToolInput = interaction.kind === "permission" && detailLines.length === 0
    ? /^(Tool:\s*[^:]+):\s*([\[{][\s\S]*)$/u.exec(interaction.prompt)
    : null;
  if (interaction.kind !== "permission" || (detailLines.length === 0 && !inlineToolInput)) {
    return `<p id="${promptId}">${escapeHtml(interaction.prompt)}</p>`;
  }
  let readableSummary = summary.replace(/^Tool:\s*/u, "");
  let details = detailLines.join("\n");
  if (inlineToolInput) {
    const inlinePayload = inlineToolInput[2] ?? "";
    readableSummary = (inlineToolInput[1] ?? summary).replace(/^Tool:\s*/u, "");
    try {
      details = `Input:\n${JSON.stringify(JSON.parse(inlinePayload), undefined, 2)}`;
    } catch {
      details = `Input:\n${inlinePayload}`;
    }
  }
  return `<p class="interaction-prompt-summary" id="${promptId}">${escapeHtml(readableSummary)}</p>
    <details class="interaction-details"><summary>${escapeHtml(localize("Request details"))}</summary><pre>${escapeHtml(details)}</pre></details>`;
};

const interactionHtml = (interaction: InteractionSummary): string => {
  const options = interaction.options
    .map(optionValue)
    .filter((item): item is NonNullable<ReturnType<typeof optionValue>> => Boolean(item));
  const multiple = interaction.kind === "executionChecklist";
  const paused = interaction.status === "paused";
  const pending = state.pendingInteractions.has(interaction.interactionRef);
  const controls = options.map((option) => `<label class="interaction-option">
    <input type="${multiple ? "checkbox" : "radio"}" name="interaction-${escapeAttribute(interaction.interactionRef)}" value="${escapeAttribute(option.id)}" data-interaction-option="${escapeAttribute(interaction.interactionRef)}" ${interaction.selected.includes(option.id) ? "checked" : ""} ${pending ? "disabled" : ""}>
    <span><strong>${escapeHtml(option.label)}</strong>${option.description ? `<small>${escapeHtml(option.description)}</small>` : ""}</span>
  </label>`).join("");
  const promptId = `interaction-prompt-${escapeAttribute(interaction.interactionRef)}`;
  const textId = `interaction-text-${escapeAttribute(interaction.interactionRef)}`;
  const textPresentation = interactionTextPresentation(interaction);
  const freeText = interaction.allowFreeText
    ? interaction.secret
      ? `<label class="sr-only" for="${textId}">${escapeHtml(localize("Secret response"))}</label><input id="${textId}" class="interaction-text" type="password" data-interaction-secret="${escapeAttribute(interaction.interactionRef)}" value="${escapeAttribute(state.secretDrafts.get(interaction.interactionRef) ?? "")}" placeholder="${escapeAttribute(localize("Secret stays only in this webview until submitted"))}" autocomplete="off" ${pending ? "disabled" : ""}>`
      : `<label class="sr-only" for="${textId}">${escapeHtml(textPresentation.label)}</label><textarea id="${textId}" class="interaction-text" data-interaction-text="${escapeAttribute(interaction.interactionRef)}" placeholder="${escapeAttribute(textPresentation.placeholder)}" ${pending ? "disabled" : ""}>${escapeHtml(interaction.freeText)}</textarea>`
    : "";
  const timer = paused
    ? `<span class="interaction-timer paused">${escapeHtml(localize("Paused"))}${interaction.remainingMs !== undefined ? ` · ${formatDuration(interaction.remainingMs)}` : ""}</span>`
    : interaction.deadlineAt
      ? `<span class="interaction-timer"><span class="sr-only">${escapeHtml(localize("Time remaining"))} </span><span data-deadline="${escapeAttribute(interaction.deadlineAt)}"></span></span>`
      : "";
  const expiry = !paused && interaction.deadlineAt
    ? `<p class="interaction-expired" data-deadline-passed="${escapeAttribute(interaction.deadlineAt)}" hidden>${escapeHtml(localize("Deadline passed. An answer still counts until Bachata resolves this."))} ${escapeHtml(interactionTimeoutConsequence(interaction.kind))}</p>`
    : "";
  const canSubmit = interactionCanSubmit(interaction);
  const submitBlockedReason = interactionSubmitBlockedReason(interaction);
  return `<article class="interaction-card interaction-${escapeAttribute(interaction.kind)} ${pending ? "pending" : ""}" id="interaction-${escapeAttribute(interaction.interactionRef)}" data-interaction-ref="${escapeAttribute(interaction.interactionRef)}" tabindex="-1">
    <div class="interaction-heading"><div><strong>${escapeHtml(interaction.title ?? interaction.kind)}</strong></div>${timer}</div>
    ${interactionPromptHtml(interaction, promptId)}
    ${expiry}
    ${interaction.kind === "humanGate" ? disagreementSummaryHtml(interaction) : ""}
    ${controls ? `<div class="interaction-options" role="${multiple ? "group" : "radiogroup"}" aria-labelledby="${promptId}">${controls}</div>` : ""}
    ${freeText}
    <div class="interaction-actions">
      <button data-action="interaction-${paused ? "resume" : "pause"}" data-interaction-ref="${escapeAttribute(interaction.interactionRef)}" ${pending ? "disabled" : ""}>${escapeHtml(paused ? localize("Resume") : localize("Pause"))}</button>
      <button class="primary" data-action="interaction-submit" data-interaction-ref="${escapeAttribute(interaction.interactionRef)}"${submitBlockedReason === undefined ? "" : ` title="${escapeAttribute(submitBlockedReason)}"`} ${canSubmit ? "" : "disabled"}>${escapeHtml(pending ? localize("Submitting…") : interactionSubmitLabel(interaction))}</button>
    </div>
  </article>`;
};

const interactionsHtml = (conversationId: string): string =>
  state.manager.interactions
    .filter((interaction) => interaction.conversationId === conversationId && interactionIsOpen(interaction))
    .map(interactionHtml)
    .join("");

const jsonRecord = (value: JsonValue | undefined): { [key: string]: JsonValue } | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;

const jsonString = (value: JsonValue | undefined): string | undefined =>
  typeof value === "string" ? value : undefined;

/**
 * The global errors a reader is shown, each one once.
 *
 * A failure that happens while a conversation is being initialized is recorded in two places: the
 * manager holds it because the manager is what failed to build the conversation, and the
 * conversation holds it because the conversation is what cannot run. Both were rendered
 * unconditionally, so an invalid pipeline catalogue — one message, one cause — appeared as two
 * identical alerts stacked on top of each other. Distinct errors are still both shown: two
 * different failures are two facts, and collapsing them would hide one.
 */
const globalErrorMessages = (managerError: string | undefined, conversationError: string | undefined): string[] => [
  ...new Set(
    [managerError, conversationError].map(productErrorMessage).filter(
      (message): message is string => typeof message === "string" && message.length > 0,
    ),
  ),
];

/**
 * A failure the reader has read can be put away.
 *
 * The banner used to stay until the state that produced it changed, which for a failure nothing
 * retries is never. Dismissal clears the message wherever it is recorded, so the banner does not
 * come straight back on the next render, and leaves any second, different failure standing.
 */
const globalErrorsHtml = (): string =>
  globalErrorMessages(state.managerError, state.errors.get(activeId()))
    .map((message) =>
      `<div class="global-error" ${liveRegionAttributes(`global-error:${message}`, "alert", message)}>${escapeHtml(message)}<button class="icon-button global-error-dismiss" data-action="error-dismiss" data-error-message="${escapeAttribute(message)}" aria-label="${escapeAttribute(localize("Dismiss this failure"))}" title="${escapeAttribute(localize("Dismiss this failure"))}">×</button></div>`)
    .join("");

/**
 * Field validation, redrawn from the store after every render.
 *
 * A refusal written straight into the live DOM is erased by the next background snapshot, which
 * takes the message and the aria-invalid flag with it and leaves a form that looks accepted. The
 * store holds the refusal; this puts it back into the tree the render just built.
 */
const applyFieldErrors = (): void => {
  state.fieldErrors.forEach((message, fieldId) => {
    document.getElementById(fieldId)?.setAttribute("aria-invalid", "true");
    const slot = document.getElementById(fieldErrorSlotId(fieldId));
    if (slot) slot.textContent = message;
  });
};

type CodeBlockScrollSnapshot = {
  key: string;
  top: number;
  left: number;
  focused: boolean;
};

const codeBlockScrollKey = (block: HTMLElement): string | undefined => {
  const surface = block.closest<HTMLElement>("[data-code-scroll-surface], [data-entry], [data-live-agent-output]");
  if (!surface) return undefined;
  const identity = surface.dataset.codeScrollSurface ?? (surface.dataset.entry !== undefined
    ? `entry:${surface.dataset.entry}`
    : `live:${surface.dataset.liveAgentOutput ?? ""}`);
  const scope = block.closest<HTMLElement>("[data-scroll-key]")?.dataset.scrollKey ?? activeId();
  if (block.hasAttribute("data-output-scroll")) return `${scope}:${identity}:output`;
  const index = Array.from(surface.querySelectorAll<HTMLElement>("pre"))
    .filter((candidate) => candidate.closest("[data-code-scroll-surface], [data-entry], [data-live-agent-output]") === surface)
    .indexOf(block);
  return index < 0 ? undefined : `${scope}:${identity}:code:${String(index)}`;
};

const captureCodeBlockScroll = (): CodeBlockScrollSnapshot[] =>
  Array.from(root.querySelectorAll<HTMLElement>("pre, [data-output-scroll]")).flatMap((block) => {
    const key = codeBlockScrollKey(block);
    return key === undefined ? [] : [{ key, top: block.scrollTop, left: block.scrollLeft, focused: document.activeElement === block }];
  });

const restoreCodeBlockScroll = (snapshots: readonly CodeBlockScrollSnapshot[]): void => {
  const positions = new Map(snapshots.map((snapshot) => [snapshot.key, snapshot]));
  root.querySelectorAll<HTMLElement>("pre, [data-output-scroll]").forEach((block) => {
    const key = codeBlockScrollKey(block);
    const position = key === undefined ? undefined : positions.get(key);
    if (!position) return;
    block.scrollTop = position.top;
    block.scrollLeft = position.left;
    if (position.focused) block.focus({ preventScroll: true });
  });
};

// The popover that owns focus for as long as it is open. Both are dismissed by focus leaving them,
// so neither may have focus put back outside it by a render.
const openPopoverSelector = (): string | undefined =>
  state.pipelinePickerOpen
    ? ".pipeline-picker"
    : state.agentsPickerOpen
      ? ".agents-picker"
      : undefined;

let pendingRenderFocus: (() => void) | undefined;
const focusAfterRender = (focus: () => void): void => {
  pendingRenderFocus = focus;
  scheduleRender();
};

const render = (): void => {
  for (const id of pendingInterrupts) {
    const panel = state.panels.get(id);
    if ((!panel || runPhaseOf(panel) !== "running") && !conversationById(id)?.waitingForResources) pendingInterrupts.delete(id);
  }
  if (!state.hydrated) {
    root.innerHTML = `<div class="app-shell">${tabsHtml()}<div class="workspace-shell"><main class="room-empty" aria-busy="true"><p class="muted">${escapeHtml(localize("Loading runs…"))}</p></main></div></div>`;
    return;
  }
  beginLiveRegionPass();
  codeBlocks.clear();
  codeBlockSequence = 0;
  const scroll = document.getElementById("conversation-scroll");
  const inspectorScroll = root.querySelector<HTMLElement>(".inspector-scroll");
  const inspectorScrollTop = inspectorScroll?.scrollTop ?? 0;
  const resultFooter = root.querySelector<HTMLElement>(".execution-result-footer");
  const resultFooterScroll = resultFooter === null ? undefined : {
    key: resultFooter.dataset.scrollKey, top: resultFooter.scrollTop, left: resultFooter.scrollLeft,
  };
  const resultDetailsScroll = root.querySelector<HTMLElement>(".result-details-scroll");
  const resultDetailsScrollState = resultDetailsScroll === null ? undefined : {
    key: resultDetailsScroll.dataset.scrollKey, top: resultDetailsScroll.scrollTop, left: resultDetailsScroll.scrollLeft,
  };
  const distanceFromBottom = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : 0;
  const scrollTopBefore = scroll ? scroll.scrollTop : 0;
  const previousScrollKey = scroll?.dataset.scrollKey;
  if (scroll && previousScrollKey) {
    state.scrollPositions.set(previousScrollKey, {
      top: scroll.scrollTop,
      distanceFromBottom,
      following: distanceFromBottom < 90,
    });
  }
  const control = captureControl();
  const tabStrip = captureRunTabStrip();
  const dialogScroll = captureDialogScroll();
  const codeBlockScroll = captureCodeBlockScroll();
  try {
    root.innerHTML = `<div class="app-shell"><button class="skip-link" data-action="skip-to-composer">${escapeHtml(localize("Skip to run input"))}</button>${tabsHtml()}<div class="workspace-shell">${readOnlyBannerHtml(state.manager.readOnly)}${globalErrorsHtml()}${mainRoomHtml()}</div>${runDrawerHtml()}${pipelineEditorHtml()}${appDialogHtml()}</div>`;
    // A control the reader cannot use must say so before it is pressed, not after it refuses.
    applyReadOnlyControls(root, state.manager.readOnly);
    applyFieldErrors();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recovery = state.editorOpen && state.editorMode === "form"
      ? `<p>${escapeHtml(localize("The pipeline editor could not draw this definition. Retry opens it as JSON so the draft can still be repaired."))}</p>`
      : state.editorOpen
        ? `<p>${escapeHtml(localize("The pipeline editor could not draw this definition. Close it to return to the run."))}</p>`
        : "";
    // Retry redraws the same state, so it is the only escape hatch that can fail the same way
    // twice. Resetting the view drops the presentation state a failing render is most likely to
    // be drawing, and the output channel is where the reader reads the failure out of Bachata
    // rather than out of this banner.
    const actions = `<div class="compact-actions"><button class="primary" data-action="render-retry">${escapeHtml(localize("Retry"))}</button>${state.editorOpen ? `<button data-action="render-editor-close">${escapeHtml(localize("Close pipeline editor"))}</button>` : ""}<button data-action="render-reset">${escapeHtml(localize("Reset this view"))}</button><button data-action="render-open-output">${escapeHtml(localize("Open the Bachata output"))}</button></div>`;
    if (state.editorOpen && state.editorMode === "form") {
      state.editorMode = "json";
    }
    const tabs = ((): string => { try { return tabsHtml(); } catch { return ""; } })();
    root.innerHTML = `<div class="app-shell">${tabs}<main class="render-failure" ${liveRegionAttributes("render-failure", "alert", message)}><h1>${escapeHtml(localize("Bachata could not render this view"))}</h1><p>${escapeHtml(localize("Bachata could not draw this view from the current state. The run itself is untouched, and every other run is still open in the list."))}</p>${recovery}${actions}<details class="render-failure-details"><summary>${escapeHtml(localize("Technical details"))}</summary><p>${escapeHtml(message)}</p></details></main></div>`;
    restoreControl(control);
    restoreRunTabStrip(tabStrip);
    positionOpenRunMenus();
    return;
  }
  const nextScroll = document.getElementById("conversation-scroll");
  if (nextScroll) {
    // Replacing the tree reset the scroll position; putting it back is a restore, not a
    // scroll, so the stylesheet's smooth behaviour is switched off for the assignment.
    nextScroll.setAttribute("data-restoring", "");
    const nextScrollKey = nextScroll.dataset.scrollKey ?? "";
    const storedScroll = state.scrollPositions.get(nextScrollKey);
    const sameSurface = nextScrollKey.length > 0 && nextScrollKey === previousScrollKey;
    if ((nextScroll.getAttribute("class") ?? "").split(/\s+/u).includes("is-empty")) {
      nextScroll.scrollTop = 0;
    } else if (sameSurface && state.roomView === "chat" && distanceFromBottom < 90) {
      nextScroll.scrollTop = nextScroll.scrollHeight;
    } else if (sameSurface && transcriptGrewAbove) {
      nextScroll.scrollTop = Math.max(0, nextScroll.scrollHeight - nextScroll.clientHeight - distanceFromBottom);
    } else if (sameSurface) {
      nextScroll.scrollTop = scrollTopBefore;
    } else if (storedScroll?.following === true || (storedScroll === undefined && state.roomView === "chat")) {
      nextScroll.scrollTop = nextScroll.scrollHeight;
    } else {
      nextScroll.scrollTop = storedScroll?.top ?? 0;
    }
    nextScroll.removeAttribute("data-restoring");
  }
  const nextInspectorScroll = root.querySelector<HTMLElement>(".inspector-scroll");
  if (nextInspectorScroll) nextInspectorScroll.scrollTop = inspectorScrollTop;
  transcriptGrewAbove = false;
  settleCodeBlockFocus();
  restoreCodeBlockScroll(codeBlockScroll);
  restoreControl(control, openPopoverSelector());
  const nextResultFooter = root.querySelector<HTMLElement>(".execution-result-footer");
  const resultDetailsAreOpen = (nextResultFooter?.getAttribute("class") ?? "")
    .split(/\s+/u)
    .includes("result-details-open");
  if (nextResultFooter && resultDetailsAreOpen) {
    nextResultFooter.scrollTop = 0;
    nextResultFooter.scrollLeft = 0;
  } else if (nextResultFooter && resultFooterScroll && resultFooterScroll.key === nextResultFooter.dataset.scrollKey) {
    nextResultFooter.scrollTop = resultFooterScroll.top;
    nextResultFooter.scrollLeft = resultFooterScroll.left;
  }
  const nextResultDetailsScroll = root.querySelector<HTMLElement>(".result-details-scroll");
  if (nextResultDetailsScroll && resultDetailsScrollState && resultDetailsScrollState.key === nextResultDetailsScroll.dataset.scrollKey) {
    nextResultDetailsScroll.scrollTop = resultDetailsScrollState.top;
    nextResultDetailsScroll.scrollLeft = resultDetailsScrollState.left;
  }
  restoreDialogScroll(dialogScroll);
  rememberEditorLocally();
  focusEmptyComposer(control !== undefined);
  refreshVisibleCountdowns();
  restoreRunTabStrip(tabStrip);
  positionOpenRunMenus();
  const focus = pendingRenderFocus;
  pendingRenderFocus = undefined;
  focus?.();
  refreshConversationNavigation();
  if (nextScroll) rememberConversationScroll(nextScroll);
  discoverVisibleAgentModels();
};

// Set by the reducer when older entries are prepended, so the next render keeps the reader's
// distance from the bottom rather than their offset from a top that has moved.
let transcriptGrewAbove = false;

/**
 * A code block is a focusable region only when it scrolls.
 *
 * Every block used to be a tab stop, so a full transcript put hundreds of stops between the
 * run tabs and the composer. A block that fits needs no keyboard route into it.
 */
const settleCodeBlockFocus = (): void => {
  root.querySelectorAll<HTMLElement>("pre[data-code-region]").forEach((block) => {
    const scrolls = block.scrollWidth > block.clientWidth || block.scrollHeight > block.clientHeight;
    if (scrolls) {
      block.setAttribute("tabindex", "0");
      block.setAttribute("role", "region");
      block.setAttribute("aria-label", block.dataset.codeRegion ?? localize("code block"));
    } else {
      block.removeAttribute("tabindex");
      block.removeAttribute("role");
      block.removeAttribute("aria-label");
    }
  });
};

const panelSelectHasFocus = (): boolean =>
  document.activeElement instanceof HTMLSelectElement &&
  document.activeElement.closest(".agents-popover, .composer-settings") !== null;

const scheduleRender = (): void => {
  if (composing || pointerActivationPending || panelSelectHasFocus()) {
    deferredRender = true;
    return;
  }
  if (renderScheduled) {
    return;
  }
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    if (composing || pointerActivationPending || panelSelectHasFocus()) {
      deferredRender = true;
      return;
    }
    render();
  });
};

const attachmentExtensionMimeTypes: Record<string, string> = {
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

const attachmentMimeType = (file: File): string => {
  const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
  const byExtension = attachmentExtensionMimeTypes[extension];
  if (byExtension) return byExtension;
  return file.type;
};

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(localize("Failed to read attachment")));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error(localize("Attachment encoding failed")));
        return;
      }
      resolve(result.slice(comma + 1));
    };
    reader.readAsDataURL(file);
  });

const addFiles = async (files: FileList): Promise<void> => {
  const conversationId = activeId();
  const conversation = conversationById(conversationId);
  const panel = state.panels.get(conversationId) ?? emptyPanel();
  const draft = draftFor(conversationId);
  if (conversation?.archived) {
    state.errors.set(conversationId, localize("Archived runs are read-only"));
    scheduleRender();
    return;
  }
  const taskId = panel.taskId;
  const allowed = new Set([
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/gif",
    "text/plain",
    "text/markdown",
    "application/json",
  ]);
  let reservedCount = panel.attachments.length + draft.pendingAttachments.size;
  let reservedBytes = panel.attachments.reduce((total, attachment) => total + attachment.size, 0) +
    Array.from(draft.pendingAttachments.values()).reduce((total, attachment) => total + attachment.size, 0);
  const selected = Array.from(files);
  let accepted = 0;
  for (const [index, file] of selected.entries()) {
    const mimeType = attachmentMimeType(file);
    if (!allowed.has(mimeType)) {
      state.errors.set(conversationId, localize("Unsupported attachment type: {0}", file.type || file.name));
      continue;
    }
    if (file.size > panel.maxAttachmentBytes) {
      state.errors.set(conversationId, localize("{0} exceeds the {1} per-attachment limit", file.name, formatBytes(panel.maxAttachmentBytes)));
      continue;
    }
    if (reservedCount >= panel.maxAttachmentCount) {
      const skipped = selected.length - index;
      state.errors.set(
        conversationId,
        localize("Only {0} attachments can be sent with one run. {1} added, {2} skipped, starting at {3}. Remove an attachment before adding more.", panel.maxAttachmentCount, accepted, skipped, file.name),
      );
      break;
    }
    if (reservedBytes + file.size > panel.maxAttachmentTotalBytes) {
      const remaining = Math.max(0, panel.maxAttachmentTotalBytes - reservedBytes);
      state.errors.set(
        conversationId,
        localize("{0} exceeds the remaining attachment allowance ({1} available)", file.name, formatBytes(remaining)),
      );
      continue;
    }
    reservedCount += 1;
    reservedBytes += file.size;
    accepted += 1;
    const clientId = crypto.randomUUID();
    const previewUrl = URL.createObjectURL(file);
    draft.pendingAttachments.set(clientId, { clientId, name: file.name, size: file.size, previewUrl });
    scheduleRender();
    try {
      const dataBase64 = await fileToBase64(file);
      postRuntime({ type: "attachment.add", clientId, taskId, name: file.name, mimeType, dataBase64 }, conversationId);
    } catch (error) {
      reservedCount -= 1;
      reservedBytes -= file.size;
      URL.revokeObjectURL(previewUrl);
      draft.pendingAttachments.delete(clientId);
      state.errors.set(conversationId, error instanceof Error ? error.message : String(error));
      scheduleRender();
    }
  }
};

const submitMessage = (delivery: MessageDelivery): void => {
  const conversationId = activeId();
  if (pendingInterrupts.has(conversationId)) {
    announceStatus(localize("Wait for the current interruption to finish."));
    return;
  }
  const panel = activePanel();
  const draft = activeDraft();
  const prompt = draft.prompt.trim();
  const blockers = sendBlockers(conversationId, panel, { ...draft, delivery });
  const [firstBlocker] = blockers;
  if (firstBlocker) {
    explainSendRequirements(conversationId, blockers);
    return;
  }
  cancelDraftSave(conversationId);
  const attachmentIds = Array.from(draft.selectedAttachmentIds);
  const iterationCount = Math.max(
    1,
    Math.min(
      state.manager.maxPipelineIterations,
      Math.trunc(draft.iterationCount || state.manager.defaultPipelineIterations),
    ),
  );
  const id = requestId();
  draft.iterationCount = iterationCount;
  draft.delivery = delivery;
  state.pendingRuns.set(id, { conversationId, prompt, attachmentIds, accepted: false });
  state.errors.delete(conversationId);
  postRuntime({
    type: "pipeline.run",
    prompt,
    attachmentIds,
    delivery,
    iterationCount,
    iterationMode: draft.iterationMode,
    requiredCleanPasses: draft.requiredCleanPasses,
    requestId: id,
  }, conversationId);
  scheduleRender();
};

const openPipelineEditor = (fresh = false): void => {
  const conversationId = activeId();
  const panel = activePanel();
  if (conversationById(conversationId)?.archived) {
    state.errors.set(conversationId, localize("Archived runs are read-only"));
    scheduleRender();
    return;
  }
  if (!panel.pipelineMutable) {
    state.errors.set(activeId(), panel.pipelineMutationReason ?? localize("The pipeline cannot be changed right now"));
    scheduleRender();
    return;
  }
  if (pendingPipelineSelection(conversationId)) {
    state.errors.set(conversationId, localize("Wait for the selected pipeline to finish switching before opening the editor"));
    scheduleRender();
    return;
  }
  const selected = panel.pipelines.find((pipeline) => pipeline.id === panel.selectedPipelineId);
  let pipeline = fresh || !panel.selectedPipelineDefinition ? blankPipeline(panel) : clonePipeline(panel.selectedPipelineDefinition);
  if (!fresh && selected && !selected.editable) {
    const used = new Set(panel.pipelines.map((item) => item.id));
    pipeline.id = uniqueId(`${pipeline.id}-custom`, used);
    pipeline.name = localize("{0} copy", pipeline.name);
  }
  state.editorConversationId = conversationId;
  editorScrollSession += 1;
  if (!state.editorOpen) setOptionalProperty(state, "editorReturnFocusSelector", dialogReturnFocusSelector());
  const editorSource = !fresh && selected?.editable ? selected : undefined;
  if (editorSource === undefined) {
    delete state.editorSourcePipelineId;
    delete state.editorSourcePipelineName;
    delete state.editorSourcePipelineHash;
  } else {
    state.editorSourcePipelineId = editorSource.id;
    state.editorSourcePipelineName = editorSource.name;
    setOptionalProperty(state, "editorSourcePipelineHash", editorSource.hash);
  }
  state.editorPipelineScopeKey = panel.pipelineScopeKey;
  state.editorDraft = pipeline;
  resetExpandedEditorCards(pipeline);
  state.editorOutputSchemas.clear();
  pipeline.steps.forEach((step) => {
    if (step.type === "agent" && step.output) {
      state.editorOutputSchemas.set(step.id, safeJson(step.output.schema));
    }
  });
  state.editorRaw = safeJson(pipeline);
  state.editorMode = "form";
  state.editorErrors = [];
  delete state.pendingEditorOperation;
  state.editorOpen = true;
  state.editorOriginalRaw = editorFingerprint();
  scheduleRender();
  // The first field is usually inside a collapsed card, and focusing a control the reader
  // cannot see does nothing — which left focus on the button behind the modal.
  requestAnimationFrame(() => {
    const editor = root.querySelector<HTMLElement>(".pipeline-editor");
    if (!editor) return;
    const heading = document.getElementById("pipeline-editor-title");
    const field = reachableControls(editor).find((control) => control.matches("input, textarea, select"));
    (field ?? heading ?? reachableControls(editor)[0])?.focus();
  });
};

const syncEditorRaw = (): void => {
  if (state.editorDraft) {
    state.editorRaw = safeJson(state.editorDraft);
  }
};

const moveItem = <T>(items: T[], from: number, to: number): void => {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) {
    return;
  }
  const [item] = items.splice(from, 1);
  // The bounds check above proves the splice removed exactly one item.
  if (item !== undefined) {
    items.splice(to, 0, item);
  }
};

const controlValues = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string[] =>
  element instanceof HTMLSelectElement && element.multiple
    ? Array.from(element.selectedOptions, (option) => option.value)
    : element.value.split(",").map((item) => item.trim()).filter(Boolean);

const setOptionalString = (target: Record<string, unknown>, field: string, value: string): void => {
  const trimmed = value.trim();
  if (trimmed) target[field] = trimmed;
  else delete target[field];
};

const parseVerificationChecks = (value: string): Array<{ id: string; command: string }> | undefined => {
  const checks = value.split(/\r?\n/).map((line) => {
    const separator = line.indexOf("=");
    if (separator <= 0) return undefined;
    const id = line.slice(0, separator).trim();
    const command = line.slice(separator + 1).trim();
    return id && command ? { id, command } : undefined;
  }).filter((check): check is { id: string; command: string } => check !== undefined);
  return checks.length > 0 ? checks : undefined;
};

const conversationFromTarget = (target: HTMLElement): ConversationSummary | undefined =>
  target.dataset.conversation ? conversationById(target.dataset.conversation) : undefined;

const setRunDrawerOpen = (open: boolean): void => {
  state.runDrawerOpen = open;
  scheduleRender();
  requestAnimationFrame(() => {
    const target = open
      ? document.getElementById("run-search")
      : root.querySelector<HTMLElement>('[data-action="run-drawer-toggle"]');
    target?.focus();
    // After the focus, not with it: focusing the search field scrolls the list to the top, so
    // revealing the current run in the same frame would be undone.
    if (open && root.querySelector<HTMLElement>(".run-drawer-list")?.dataset.scrollRestored !== "true") {
      requestAnimationFrame(() => {
        root.querySelector<HTMLElement>(".run-drawer-item.selected")
          ?.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    }
  });
};

// Every floating menu dismisses the same way, so they share one selector: a menu left off this
// list stays open under Escape and under a click elsewhere while its siblings close.
const transientMenuSelector = ".run-action-menu, .header-action-menu, .notification-center";

// A floating menu is placed by measurement against the viewport: the run-tab menu, the room's
// overflow menu and the notification panel all used to anchor to one edge of their summary and
// clipped whenever that edge was near the side of a narrow panel.
const renameConversation = (conversation: ConversationSummary): void => {
  openDialog({
    kind: "renameRun",
    title: localize("Rename run"),
    message: localize("Use a concise title that distinguishes this run from the others."),
    confirmLabel: localize("Rename"),
    conversationId: conversation.id,
    inputValue: runTabLabel(conversation),
  });
};

const setEditorOperation = (
  operation: PendingEditorOperation["operation"],
  id: string,
  returnFocusSelector = dialogReturnFocusSelector(),
): void => {
  editorOperationStartedAt = Date.now();
  state.pendingEditorOperation = {
    operation,
    requestId: id,
    conversationId: editorTargetId(),
    ...(returnFocusSelector === undefined ? {} : { returnFocusSelector }),
  };
  state.editorErrors = [];
  scheduleRender();
};

const startPipelineImport = (returnFocusSelector?: string): void => {
  const id = requestId();
  setEditorOperation("pipeline.import", id, returnFocusSelector);
  postRuntime({ type: "pipeline.import", requestId: id }, editorTargetId());
};

const startPipelineFork = (): void => {
  const pipelineId = activePanel().selectedPipelineId;
  if (!pipelineId) return;
  openPipelineEditor(false);
  const id = requestId();
  setEditorOperation("pipeline.fork", id);
  postRuntime({ type: "pipeline.fork", pipelineId, requestId: id }, editorTargetId());
};

const startPipelineDelete = (
  pipelineId: string,
  scopeKey: string,
  expectedHash: string,
  returnFocusSelector?: string,
): void => {
  const id = requestId();
  setEditorOperation("pipeline.delete", id, returnFocusSelector);
  postRuntime(
    { type: "pipeline.delete", pipelineId, scopeKey, expectedHash, requestId: id },
    editorTargetId(),
  );
};

// Opening a menu, and marking notifications read, leave what is behind the menu as it was; every
// other action changes it, so the menu that issued the action is dismissed with the rest.
const menuPreservingActions = new Set(["run-menu-toggle", "notification-read-all"]);
const dialogMenuActions = new Set(["task-reset", "run-rename", "run-archive", "run-delete", "workflow-discard", "run-requirements"]);

const dismissTransientMenus = (origin: Element | null): void => {
  // An item chosen from a menu changes what is behind it, so that menu is dismissed too.
  const chosen = origin?.closest<HTMLElement>("[data-action]") ?? null;
  const chosenMenu = chosen?.closest<HTMLDetailsElement>(transientMenuSelector);
  const keptMenu = chosen === null || menuPreservingActions.has(chosen.dataset.action ?? "")
    ? origin?.closest<HTMLDetailsElement>(transientMenuSelector) ?? null
    : null;
  root.querySelectorAll<HTMLDetailsElement>(transientMenuSelector).forEach((menu) => {
    if (menu !== keptMenu) {
      menu.open = false;
      const disclosureKey = menu.dataset.disclosureKey;
      if (disclosureKey) {
        state.disclosureStates.set(disclosureKey, false);
      }
    }
  });
  // Host-only actions leave the room in place. Keep focus reachable after their menu closes;
  // actions which open a view/dialog subsequently move focus to that destination.
  if (chosenMenu && chosenMenu !== keptMenu && !dialogMenuActions.has(chosen?.dataset.action ?? "")) chosenMenu.querySelector<HTMLElement>("summary")?.focus();
  if (
    state.composerSettingsOpen &&
    !origin?.closest(".composer-settings, .composer-settings-button") &&
    origin?.closest<HTMLElement>("[data-action]")?.dataset.action !== "composer-settings-toggle"
  ) {
    state.composerSettingsOpen = false;
    scheduleRender();
  }
  if (
    state.pipelinePickerOpen &&
    !origin?.closest(".pipeline-picker") &&
    origin?.closest<HTMLElement>("[data-action]")?.dataset.action !== "pipeline-picker-toggle" &&
    origin?.closest<HTMLElement>("[data-action]")?.dataset.action !== "pipeline-picker-select"
  ) {
    state.pipelinePickerOpen = false;
    state.pipelinePickerQuery = "";
    delete state.pipelinePickerActiveId;
    scheduleRender();
  }
  if (
    state.agentsPickerOpen &&
    !origin?.closest(".agents-picker") &&
    origin?.closest<HTMLElement>("[data-action]")?.dataset.action !== "recovery-change-model"
  ) {
    state.agentsPickerOpen = false;
    delete state.agentsBrowserFor;
    scheduleRender();
  }
};

// Action dispatch and input handling are installed by installActionListeners() in
// actions.ts, which this bootstrap calls below.
root.addEventListener("pointerdown", () => { pointerActivationPending = true; }, true);
const finishPointerActivation = (): void => {
  pointerActivationPending = false;
  if (deferredRender && !composing) {
    deferredRender = false;
    scheduleRender();
  }
};
document.addEventListener("pointerup", () => { setTimeout(finishPointerActivation, 0); }, true);
document.addEventListener("click", finishPointerActivation);
document.addEventListener("pointercancel", finishPointerActivation, true);
window.addEventListener("blur", finishPointerActivation);

root.addEventListener("compositionstart", () => {
  composing = true;
});

root.addEventListener("compositionend", () => {
  composing = false;
  if (deferredRender) {
    deferredRender = false;
    scheduleRender();
  }
});

// Focus leaving the picker closes it, so a popover is never left open behind the prompt or another
// control. Focus is already elsewhere, so this does not steal it back.
document.addEventListener("focusin", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (deferredRender && !composing && !pointerActivationPending && !panelSelectHasFocus()) {
    deferredRender = false;
    scheduleRender();
  }
  if (state.agentsPickerOpen) {
    const insideAgents = target && typeof target.closest === "function" ? target.closest(".agents-picker") : null;
    if (!insideAgents) {
      state.agentsPickerOpen = false;
      delete state.agentsBrowserFor;
      scheduleRender();
    }
  }
  if (!state.pipelinePickerOpen) {
    return;
  }
  const insidePicker = target && typeof target.closest === "function" ? target.closest(".pipeline-picker") : null;
  if (!insidePicker) {
    state.pipelinePickerOpen = false;
    state.pipelinePickerQuery = "";
    delete state.pipelinePickerActiveId;
    scheduleRender();
  }
});

// A slot's provider choices are one radiogroup: one tab stop, and the arrows move inside it. Moving
// focus deliberately does not assign — an assignment restarts a provider, which is far too much for
// an arrow key — so the reader arrows to a choice and presses Enter or Space, which the buttons
// already answer natively.
const moveAgentsChoiceFocus = (current: HTMLElement, key: string): boolean => {
  const group = current.closest(".agents-choices");
  if (!group) {
    return false;
  }
  // Filtered in script rather than with `:not([disabled])`, because the selector is the kind a
  // minimal DOM does not implement and the behaviour must be testable.
  const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]')).filter(
    (radio) => !(radio instanceof HTMLButtonElement && radio.disabled),
  );
  const index = radios.indexOf(current);
  if (radios.length === 0 || index === -1) {
    return false;
  }
  const target = key === "ArrowDown" || key === "ArrowRight"
    ? radios[(index + 1) % radios.length]
    : key === "ArrowUp" || key === "ArrowLeft"
      ? radios[(index - 1 + radios.length) % radios.length]
      : key === "Home"
        ? radios[0]
        : radios[radios.length - 1];
  target?.focus();
  return true;
};

document.addEventListener("pointerdown", () => {
  root.dataset.focusInput = "pointer";
});

document.addEventListener("keydown", (event) => {
  root.dataset.focusInput = "keyboard";
  if (!event.altKey && !event.ctrlKey && !event.metaKey &&
    event.target instanceof HTMLElement &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) &&
    moveRunTabFocus(event.target, event.key)) {
    event.preventDefault();
    return;
  }
  if (
    state.agentsPickerOpen &&
    event.target instanceof HTMLElement &&
    event.target.getAttribute("role") === "radio" &&
    ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) &&
    moveAgentsChoiceFocus(event.target, event.key)
  ) {
    event.preventDefault();
    return;
  }
  // The combobox keyboard is scoped to the picker's own focus. If focus has moved on — Tab into the
  // prompt, say — these keys are the prompt's again, so Enter there can never select a pipeline
  // because a popover was left open.
  const onPickerButton = event.target instanceof HTMLElement && event.target.id === "pipeline-picker-button";
  const onPickerSearch = event.target instanceof HTMLElement && event.target.id === "pipeline-picker-search";
  const insidePipelinePicker = event.target instanceof HTMLElement && event.target.closest(".pipeline-picker") !== null;
  if (state.pipelinePickerOpen && insidePipelinePicker && event.key === "Escape") {
    event.preventDefault();
    closePipelinePicker();
    return;
  }
  if (state.pipelinePickerOpen && onPickerSearch) {
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Enter") commitPipelinePickerActive();
      else movePipelinePickerActive(event.key);
      return;
    }
  }
  if (state.pipelinePickerOpen && onPickerButton) {
    if (event.key === "Tab") {
      if (!event.shiftKey) {
        event.preventDefault();
        document.getElementById("pipeline-picker-search")?.focus();
      } else closePipelinePicker(false);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "Escape") {
        closePipelinePicker();
      } else if (event.key === "Enter") {
        commitPipelinePickerActive();
      } else {
        movePipelinePickerActive(event.key);
      }
      return;
    }
  }
  if (
    !state.pipelinePickerOpen &&
    onPickerButton &&
    event.target instanceof HTMLElement &&
    event.target.getAttribute("aria-disabled") !== "true" &&
    (event.key === "ArrowDown" || event.key === "ArrowUp")
  ) {
    event.preventDefault();
    openPipelinePicker();
    return;
  }
  if (
    event.target instanceof HTMLTextAreaElement &&
    bachataWebviewBehavior.shouldSubmitComposer(event.target.id, event.key, event.ctrlKey, event.metaKey)
  ) {
    event.preventDefault();
    // The keyboard route to sending has to refuse for the same reason the Send button does.
    if (!declineDisabledControl(event.target)) submitMessage(activeDraft().delivery);
  }
  if (event.key === "Enter" && state.dialog && event.target instanceof HTMLInputElement && event.target.id === "app-dialog-input") {
    event.preventDefault();
    confirmDialog();
  }
  if (event.key === "Tab" && (state.dialog || state.editorOpen || state.runDrawerOpen)) {
    const dialog = root.querySelector<HTMLElement>(
      state.dialog ? ".app-dialog" : state.editorOpen ? ".pipeline-editor" : ".run-drawer",
    );
    const controls = dialog ? reachableControls(dialog) : [];
    if (controls.length > 0) {
      const activeIndex = controls.findIndex((control) => control === document.activeElement);
      // Focus outside the modal is brought back in rather than allowed to roam the page behind it.
      const nextIndex = activeIndex < 0
        ? (event.shiftKey ? controls.length - 1 : 0)
        : bachataWebviewBehavior.wrappedFocusIndex(activeIndex, controls.length, event.shiftKey);
      if (nextIndex !== undefined) {
        event.preventDefault();
        controls[nextIndex]?.focus();
      }
    }
  }
  if (event.key === "Escape" && !state.dialog && closeActiveMenu()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && state.dialog) {
    event.preventDefault();
    closeDialog();
  } else if (event.key === "Escape" && state.editorOpen) {
    event.preventDefault();
    closePipelineEditor();
  } else if (event.key === "Escape" && state.runDrawerOpen) {
    event.preventDefault();
    setRunDrawerOpen(false);
  } else if (event.key === "Escape" && state.agentsPickerOpen) {
    event.preventDefault();
    closeAgentsPicker();
  } else if (event.key === "Escape" && state.composerSettingsOpen) {
    event.preventDefault();
    state.composerSettingsOpen = false;
    scheduleRender();
    requestAnimationFrame(() => root.querySelector<HTMLElement>('[data-action="composer-settings-toggle"]')?.focus());
  } else if (event.key === "Escape" && state.roomView === "execution" && resultDetailsOpen(activeId())) {
    event.preventDefault();
    state.disclosureStates.set(resultDetailsKey(activeId()), false);
    scheduleRender();
    focusAfterRender(() => root.querySelector<HTMLElement>('[data-action="result-details-toggle"]')?.focus());
  }
});

root.addEventListener("toggle", (event: Event) => {
  const disclosure = event.target instanceof HTMLDetailsElement
    && event.target.matches("details[data-disclosure-key]")
    ? event.target
    : undefined;
  const disclosureKey = disclosure?.dataset.disclosureKey;
  if (disclosure && disclosureKey) {
    recordDisclosure(disclosureKey, disclosure.open);
    if (disclosure.open && (disclosure.matches(".header-action-menu") || disclosure.matches(".notification-center"))) {
      root.querySelectorAll<HTMLDetailsElement>("details.header-action-menu[open], details.notification-center[open]").forEach((other) => {
        if (other !== disclosure) {
          other.open = false;
          if (other.dataset.disclosureKey) recordDisclosure(other.dataset.disclosureKey, false);
        }
      });
      const summary = disclosure.querySelector<HTMLElement>(":scope > summary");
      if (summary) positionRunMenu(summary);
    }
    return;
  }
  const section = event.target instanceof HTMLDetailsElement && event.target.matches(".editor-section[data-editor-section]")
    ? event.target
    : undefined;
  const sectionKey = section?.dataset.editorSection;
  if (section && sectionKey) {
    if (section.open) {
      state.collapsedEditorSections.delete(sectionKey);
    } else {
      state.collapsedEditorSections.add(sectionKey);
    }
    return;
  }
  const details = event.target instanceof HTMLDetailsElement && event.target.matches(".editor-card[data-editor-card-key]")
    ? event.target
    : undefined;
  const key = details?.dataset.editorCardKey;
  if (!details || !key) {
    return;
  }
  if (details.open) {
    state.expandedEditorCards.add(key);
  } else {
    state.expandedEditorCards.delete(key);
  }
}, true);

root.addEventListener("dragstart", (event) => {
  if (state.pendingEditorOperation) {
    event.preventDefault();
    return;
  }
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-drag-handle]") : null;
  if (!target || (target.dataset.dragHandle !== "agent" && target.dataset.dragHandle !== "role" && target.dataset.dragHandle !== "step")) return;
  state.dragging = { kind: target.dataset.dragHandle, index: Number(target.dataset.index) };
  event.dataTransfer?.setData("text/plain", `${target.dataset.dragHandle}:${target.dataset.index}`);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
});

root.addEventListener("dragover", (event) => {
  if (!state.pendingEditorOperation && state.dragging && event.target instanceof Element && event.target.closest("[data-drag-kind]")) event.preventDefault();
});

root.addEventListener("drop", (event) => {
  if (state.pendingEditorOperation) {
    delete state.dragging;
    return;
  }
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-drag-kind]") : null;
  const dragging = state.dragging;
  delete state.dragging;
  if (!target || !dragging || target.dataset.dragKind !== dragging.kind || !state.editorDraft) return;
  event.preventDefault();
  const to = Number(target.dataset.index);
  if (dragging.kind === "agent") moveItem(state.editorDraft.agents, dragging.index, to);
  else if (dragging.kind === "role") moveItem(state.editorDraft.roles ?? (state.editorDraft.roles = []), dragging.index, to);
  else moveItem(state.editorDraft.steps, dragging.index, to);
  syncEditorRaw();
  scheduleRender();
});

const settleUi = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

const waitForUi = async (
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 25));
  }
  return predicate();
};

const runHumanE2eUiScenario = async (
  message: Extract<ExtensionMessage, { type: "humanE2e.uiRun" }>,
): Promise<void> => {
  const existingConversationIds = new Set(state.manager.conversations.map((conversation) => conversation.id));
  root.querySelector<HTMLButtonElement>('[data-action="create-conversation"]:not([disabled])')?.click();
  const runCreated = await waitForUi(() =>
    state.manager.conversations.some((conversation) => !existingConversationIds.has(conversation.id))
  );
  const conversationId = state.manager.conversations.find(
    (conversation) => !existingConversationIds.has(conversation.id),
  )?.id ?? "";
  if (runCreated && conversationId) {
    await waitForUi(() => state.manager.activeConversationId === conversationId);
  }

  root.querySelector<HTMLElement>('[data-action="run-drawer-toggle"]')?.click();
  await settleUi();
  const drawerOpened = root.querySelector(".run-drawer") !== null;
  root.querySelector<HTMLElement>('[data-action="run-drawer-toggle"]')?.click();
  await settleUi();

  // The catalog this window actually loaded, read before anything is added to it, and every entry
  // selected in turn through the rendered picker. A default that did not validate is simply not here.
  const catalogPipelineIds = activePanel().pipelines.map((pipeline) => pipeline.id);
  // What the picker actually offers, read off the rendered options while the listbox is open
  // rather than off the state that produced them: a catalog held in state and never drawn is not a
  // catalog a person can use.
  root.querySelector<HTMLElement>('[data-action="pipeline-picker-toggle"]:not([disabled])')?.click();
  await settleUi();
  const renderedPipelineIds: string[] = [];
  for (const filter of Array.from(root.querySelectorAll<HTMLElement>('[data-action="pipeline-picker-filter"]'))) {
    filter.click();
    await settleUi();
    root.querySelectorAll<HTMLElement>('[data-action="pipeline-picker-select"]').forEach((option) => {
      const pipelineId = option.dataset.pipelineId;
      if (pipelineId && !renderedPipelineIds.includes(pipelineId)) renderedPipelineIds.push(pipelineId);
    });
  }
  let everyCatalogPipelineSelectable = catalogPipelineIds.length > 0;
  for (const pipelineId of catalogPipelineIds) {
    // A disabled picker button is a control the person cannot touch, so the scenario waits for it
    // the way they would rather than forcing a selection through it.
    if (!await waitForUi(() =>
      root.querySelector<HTMLButtonElement>('[data-action="pipeline-picker-toggle"]')?.disabled === false
    )) {
      everyCatalogPipelineSelectable = false;
      break;
    }
    if (!state.pipelinePickerOpen) {
      root.querySelector<HTMLElement>('[data-action="pipeline-picker-toggle"]')?.click();
      await settleUi();
    }
    const pipeline = activePanel().pipelines.find((candidate) => candidate.id === pipelineId);
    const category = pipeline ? pipelineCategory(pipeline) : "common";
    root.querySelector<HTMLElement>(`[data-action="pipeline-picker-filter"][data-pipeline-filter="${category}"]`)?.click();
    await settleUi();
    const option = root.querySelector<HTMLElement>(`[data-action="pipeline-picker-select"][data-pipeline-id="${pipelineId}"]`);
    if (!option) {
      everyCatalogPipelineSelectable = false;
      break;
    }
    option.click();
    // The runtime's own answer. The pending entry is cleared on `failed` exactly as on
    // `completed`, and the optimistic write happens before the message is even posted, so
    // neither of those is evidence that the selection was accepted.
    if (!await waitForUi(() =>
      activePanel().selectedPipelineId === pipelineId && pendingPipelineSelection(activeId()) === undefined
    )) {
      everyCatalogPipelineSelectable = false;
      break;
    }
  }
  await settleUi();

// Pipeline editing is reached through the composer's settings panel, and a modal editor opened
// over that panel dismisses it: a click inside the editor is a click outside the panel. A person
// coming back to Edit therefore opens Settings again first, and waits for the control to be
// offered rather than pressing at whatever moment the render happens to reach.
const openPipelineEditorThroughSettings = async (): Promise<void> => {
  if (!state.composerSettingsOpen) {
    root.querySelector<HTMLElement>('[data-action="composer-settings-toggle"]')?.click();
    await settleUi();
  }
  await waitForUi(() =>
    root.querySelector<HTMLButtonElement>('[data-action="pipeline-edit"]')?.disabled === false
  );
  root.querySelector<HTMLElement>('[data-action="pipeline-edit"]:not([disabled])')?.click();
  await settleUi();
};

  // Pipeline editing lives inside the composer's settings panel now, so it is opened the way a
  // person would before the New-pipeline control can be reached.
  root.querySelector<HTMLElement>('[data-action="composer-settings-toggle"]')?.click();
  await settleUi();
  root.querySelector<HTMLElement>('[data-action="pipeline-new"]:not([disabled])')?.click();
  await settleUi();
  const newDraftDeleteHidden =
    root.querySelector(".pipeline-editor") !== null &&
    root.querySelector('[data-action="pipeline-delete"]') === null;
  root.querySelector<HTMLButtonElement>('[data-action="editor-mode"][data-mode="json"]:not([disabled])')?.click();
  await settleUi();
  const raw = root.querySelector<HTMLTextAreaElement>("#pipeline-raw");
  if (raw) {
    raw.value = JSON.stringify(message.pipeline, null, 2);
    raw.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await settleUi();
  let pendingOperationCloseLocked = false;
  const createSave = root.querySelector<HTMLButtonElement>('[data-action="pipeline-save"]:not([disabled])');
  if (createSave) {
    createSave.click();
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    pendingOperationCloseLocked =
      root.querySelector(".pipeline-editor") !== null && state.dialog === undefined;
  }
  const pipelineCreated = await waitForUi(() =>
    root.querySelector(".pipeline-editor") === null &&
    activePanel().selectedPipelineDefinition?.id === message.pipeline.id
  );

  await openPipelineEditorThroughSettings();
  const editorOpened = root.querySelector(".pipeline-editor") !== null;
  const sourcePipelineIdLocked =
    root.querySelector<HTMLInputElement>('[data-editor-meta="id"]')?.disabled === true;
  let editorSaved = false;
  if (editorOpened) {
    const description = root.querySelector<HTMLTextAreaElement>('[data-editor-meta="description"]');
    if (description) {
      description.value = `${description.value} UI verified`.trim();
      description.dispatchEvent(new Event("input", { bubbles: true }));
    }
    root.querySelector<HTMLButtonElement>('[data-action="pipeline-save"]:not([disabled])')?.click();
    editorSaved = await waitForUi(() => root.querySelector(".pipeline-editor") === null);
  }

  // Structured -> JSON -> Structured in the real editor. The JSON view is where a malformed value
  // is repaired, so a round trip that cannot complete is a trap, not a validation.
  let editorModeRoundTrip = false;
  let editorJsonEditSurvived = false;
  let invalidJsonKeepsTabsUsable = false;
  let invalidJsonKeepsText = false;
  let invalidJsonErrorLines = -1;
  const editedDescription = "Edited through the JSON view";
  await openPipelineEditorThroughSettings();
  if (root.querySelector(".pipeline-editor") !== null) {
    root.querySelector<HTMLButtonElement>('[data-action="editor-mode"][data-mode="json"]:not([disabled])')?.click();
    const reachedJson = await waitForUi(() => root.querySelector("#pipeline-raw") !== null);
    // An edit made in the JSON view, so the switch back proves the structured form reflects it
    // rather than proving only that two buttons can be clicked.
    const editable = root.querySelector<HTMLTextAreaElement>("#pipeline-raw");
    if (editable) {
      editable.value = JSON.stringify(
        { ...message.pipeline, description: editedDescription },
        null,
        2,
      );
      editable.dispatchEvent(new Event("input", { bubbles: true }));
      await settleUi();
    }
    root.querySelector<HTMLButtonElement>('[data-action="editor-mode"][data-mode="form"]:not([disabled])')?.click();
    const reachedForm = await waitForUi(() => root.querySelector("#pipeline-raw") === null);
    editorModeRoundTrip = reachedJson && reachedForm;
    editorJsonEditSurvived = await waitForUi(() =>
      root.querySelector<HTMLTextAreaElement>('[data-editor-meta="description"]')?.value === editedDescription
    );

    // Unparsable JSON is where a malformed definition is repaired, so it has to stay a place the
    // person can work in: the text they typed still there, both tabs still usable, nothing laid
    // over them, and one concise line rather than a dumped validator list.
    root.querySelector<HTMLButtonElement>('[data-action="editor-mode"][data-mode="json"]:not([disabled])')?.click();
    await waitForUi(() => root.querySelector("#pipeline-raw") !== null);
    const malformed = root.querySelector<HTMLTextAreaElement>("#pipeline-raw");
    if (malformed) {
      malformed.value = "{ this is not json";
      malformed.dispatchEvent(new Event("input", { bubbles: true }));
      await settleUi();
      // The next thing a person does with a buffer they are repairing: try to leave it. That is
      // where the parse happens, so it is where the error has to appear — and where the editor
      // must refuse the switch rather than losing the text or sealing the tabs.
      root.querySelector<HTMLButtonElement>('[data-action="editor-mode"][data-mode="form"]')?.click();
      await settleUi();
      const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-action="editor-mode"]'));
      invalidJsonKeepsTabsUsable = tabs.length > 0 &&
        tabs.every((tab) => tab.disabled !== true) &&
        root.querySelector(".app-dialog-backdrop") === null;
      invalidJsonKeepsText = root.querySelector<HTMLTextAreaElement>("#pipeline-raw")?.value === "{ this is not json";
      invalidJsonKeepsTabsUsable = invalidJsonKeepsTabsUsable && root.querySelector("#pipeline-raw") !== null;
      invalidJsonErrorLines = root.querySelectorAll(".editor-errors li, .editor-errors p").length;
    }
    root.querySelector<HTMLButtonElement>('[data-action="pipeline-editor-close"]:not([disabled])')?.click();
    await settleUi();
    root.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]:not([disabled])')?.click();
    await waitForUi(() => root.querySelector(".pipeline-editor") === null);
  }

  const prompt = root.querySelector<HTMLTextAreaElement>("#composer-prompt");
  // The pipeline editing above was reached through the settings panel; it is closed again so the
  // "hidden until requested" check reads a composer at rest rather than one still holding the
  // panel open from an earlier step.
  if (state.composerSettingsOpen) {
    root.querySelector<HTMLElement>('[data-action="composer-settings-toggle"]')?.click();
    await settleUi();
  }
  // Read before the panel is opened: the run options are not on screen until the person asks for
  // them. Driving `#pipeline-iterations` without opening it found nothing at all and left the
  // iteration count reporting whatever the default already was.
  const advancedOptionsHiddenByDefault = root.querySelector("#pipeline-iterations") === null;
  root.querySelector<HTMLElement>('[data-action="composer-settings-toggle"]')?.click();
  await settleUi();
  const iterations = root.querySelector<HTMLInputElement>("#pipeline-iterations");
  if (prompt) {
    prompt.value = message.prompt;
    prompt.dispatchEvent(new Event("input", { bubbles: true }));
  }
  if (iterations) {
    iterations.value = String(message.iterationCount);
    iterations.dispatchEvent(new Event("input", { bubbles: true }));
  }
  await settleUi();
  let submitted = false;
  let interactionAnswered = false;
  if (message.submit) {
    const button = root.querySelector<HTMLButtonElement>('[data-action="submit-message"]');
    const pendingBefore = state.pendingRuns.size;
    if (button && !composerSubmitBlocked(button)) {
      button.click();
    }
    submitted = state.pendingRuns.size > pendingBefore;
    if (submitted && await waitForUi(() => root.querySelector(".interaction-card") !== null)) {
      const card = root.querySelector<HTMLElement>(".interaction-card");
      const option = card?.querySelector<HTMLInputElement>("[data-interaction-option]");
      if (card && option) {
        option.checked = true;
        option.dispatchEvent(new Event("change", { bubbles: true }));
        await settleUi();
        card.querySelector<HTMLButtonElement>('[data-action="interaction-submit"]:not([disabled])')?.click();
        interactionAnswered = await waitForUi(() => !card.isConnected);
      }
    }
  }
  const requiresBrowserBridge = message.pipeline.agents.some(
    (agent) => browserProviderForAdapterType(agent.adapter) !== undefined,
  );
  if (requiresBrowserBridge) {
    await waitForUi(() => Boolean(activePanel().browserBridge.endpoint));
  }
  const tabStripHitRegions = await auditRunTabStrip();
  vscode.postMessage({
    type: "humanE2e.uiResult",
    requestId: message.requestId,
    conversationId,
    runCreated,
    pipelineCreated,
    drawerOpened,
    newDraftDeleteHidden,
    sourcePipelineIdLocked,
    pendingOperationCloseLocked,
    editorOpened,
    editorSaved,
    interactionAnswered,
    submitted,
    iterationCount: activeDraft().iterationCount,
    catalogPipelineIds,
    renderedPipelineIds,
    everyCatalogPipelineSelectable,
    editorModeRoundTrip,
    editorJsonEditSurvived,
    invalidJsonKeepsTabsUsable,
    invalidJsonKeepsText,
    invalidJsonErrorLines,
    advancedOptionsHiddenByDefault,
    tabStripHitRegions,
    globalAlertCount: root.querySelectorAll(".global-error").length,
    browserEndpoint: activePanel().browserBridge.endpoint,
    pairingToken: activePanel().browserBridge.pairingToken,
  });
};

// EX-UI-04. The run tab strip as the pointer and the keyboard meet it, in the real renderer at the
// panel's own width. The width itself is not simulated here: the strip's narrow rules are viewport
// media queries and a webview cannot resize its own viewport, so an element-width override would
// prove nothing while looking like it did. Every width is covered by `npm run test:webview-layout`,
// which drives the same bundle in a browser it can actually resize; this asserts the invariants
// hold in the host that ships.
//
// Elements are re-read after every interaction: a click re-renders the panel, so a node captured
// before it is detached, and asserting on a detached node reports the render rather than the run.
type TabStripAudit = {
  width: number;
  menuHit: boolean;
  newHit: boolean;
  overlap: boolean;
  menuOpensWithoutRun: boolean;
  menuFocusable: boolean;
};

const auditRunTabStrip = async (): Promise<TabStripAudit[]> => {
  const selectedMenu = (): HTMLElement | null =>
    root.querySelector<HTMLElement>(".run-tab.selected .run-action-menu > summary");
  const createButton = (): HTMLElement | null => root.querySelector<HTMLElement>(".run-tab-new");
  const menu = selectedMenu();
  const create = createButton();
  const width = document.documentElement.clientWidth;
  if (!menu || !create) {
    return [{ width, menuHit: false, newHit: false, overlap: true, menuOpensWithoutRun: false, menuFocusable: false }];
  }
  const hitsItself = (element: HTMLElement): boolean => {
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return hit === element || element.contains(hit);
  };
  const menuBox = menu.getBoundingClientRect();
  const createBox = create.getBoundingClientRect();
  const overlap =
    Math.min(menuBox.right, createBox.right) - Math.max(menuBox.left, createBox.left) > 0 &&
    Math.min(menuBox.bottom, createBox.bottom) - Math.max(menuBox.top, createBox.top) > 0;
  const menuHit = hitsItself(menu);
  const newHit = hitsItself(create);
  menu.focus();
  const menuFocusable = document.activeElement === menu;
  const runsBefore = state.manager.conversations.length;
  menu.click();
  await settleUi();
  const opened = selectedMenu()?.closest<HTMLDetailsElement>("details")?.open === true;
  const menuOpensWithoutRun = opened && state.manager.conversations.length === runsBefore;
  if (opened) {
    selectedMenu()?.click();
    await settleUi();
  }
  return [{ width, menuHit, newHit, overlap, menuOpensWithoutRun, menuFocusable }];
};

const openRunDrawerForHumanE2e = async (): Promise<boolean> => {
  if (!state.runDrawerOpen) {
    root.querySelector<HTMLElement>('[data-action="run-drawer-toggle"]')?.click();
    await settleUi();
  }
  return root.querySelector(".run-drawer") !== null;
};

const runHumanE2eUiAction = async (
  message: Extract<ExtensionMessage, { type: "humanE2e.uiAction" }>,
): Promise<void> => {
  let completed = false;
  const targetId = message.targetId ?? "";
  if (message.action === "selectRun" && targetId) {
    if (await openRunDrawerForHumanE2e()) {
      const selector = `[data-action="select-conversation"][data-conversation="${CSS.escape(targetId)}"]`;
      root.querySelector<HTMLElement>(selector)?.click();
      completed = await waitForUi(() => state.manager.activeConversationId === targetId);
    }
  } else if (message.action === "resumeWorkflow" && targetId) {
    if (state.manager.activeConversationId !== targetId) {
      if (await openRunDrawerForHumanE2e()) {
        const selector = `[data-action="select-conversation"][data-conversation="${CSS.escape(targetId)}"]`;
        root.querySelector<HTMLElement>(selector)?.click();
        await waitForUi(() => state.manager.activeConversationId === targetId);
      }
    }
    const resume = root.querySelector<HTMLButtonElement>('[data-action="workflow-resume"]');
    if (resume && !resume.disabled) {
      resume.click();
      completed = true;
    }
  } else if (["archiveRun", "unarchiveRun", "deleteRun"].includes(message.action) && targetId) {
    if (await openRunDrawerForHumanE2e()) {
      if (message.action === "unarchiveRun") {
        const showArchived = document.getElementById("show-archived") as HTMLInputElement | null;
        if (showArchived && !showArchived.checked) {
          showArchived.checked = true;
          showArchived.dispatchEvent(new Event("change", { bubbles: true }));
          await settleUi();
        }
      }
      const selector = `[data-action="select-conversation"][data-conversation="${CSS.escape(targetId)}"]`;
      const select = root.querySelector<HTMLElement>(selector);
      const item = select?.closest<HTMLElement>(".run-drawer-item");
      const actionName = message.action === "archiveRun"
        ? "run-archive"
        : message.action === "unarchiveRun"
          ? "run-unarchive"
          : "run-delete";
      const menu = item?.querySelector<HTMLDetailsElement>(".run-action-menu");
      const action = item?.querySelector<HTMLButtonElement>(`[data-action="${actionName}"]`);
      if (menu && action) {
        menu.querySelector<HTMLElement>("summary")?.click();
        action.click();
        await settleUi();
        if (message.action !== "unarchiveRun") {
          root.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]')?.click();
        }
        completed = await waitForUi(() => {
          const conversation = state.manager.conversations.find((item) => item.id === targetId);
          if (message.action === "deleteRun") return conversation === undefined;
          return conversation?.archived === (message.action === "archiveRun");
        });
      }
    }
  } else if (message.action === "startTodo") {
    const button = root.querySelector<HTMLButtonElement>('[data-action="orchestration-start"]');
    if (button && !button.disabled) {
      button.click();
      completed = await waitForUi(
        () => state.manager.orchestration.active && Boolean(state.manager.orchestration.runId),
        20_000,
      );
    }
  } else if (message.action === "stopTodo") {
    const button = root.querySelector<HTMLButtonElement>('[data-action="orchestration-stop"]');
    if (button && !button.disabled) {
      button.click();
      await settleUi();
      root.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]')?.click();
      completed = await waitForUi(
        () => !state.manager.orchestration.active && state.manager.orchestration.status === "stopped",
        20_000,
      );
    }
  } else if (message.action === "resumeTodo") {
    const button = root.querySelector<HTMLButtonElement>('[data-action="orchestration-resume"]');
    if (button && !button.disabled) {
      button.click();
      completed = await waitForUi(() => state.manager.orchestration.active, 20_000);
    }
  } else if (message.action === "abandonTodo") {
    const button = root.querySelector<HTMLButtonElement>('[data-action="orchestration-abandon"]');
    if (button && !button.disabled) {
      button.click();
      await settleUi();
      root.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]')?.click();
      completed = await waitForUi(
        () => !state.manager.orchestration.active && state.manager.orchestration.runId === undefined,
        20_000,
      );
    }
  } else if (message.action === "cleanupTodo" && targetId) {
    const selector = `[data-action="orchestration-cleanup"][data-run-id="${CSS.escape(targetId)}"]`;
    const button = root.querySelector<HTMLButtonElement>(selector);
    if (button && !button.disabled) {
      button.click();
      await settleUi();
      root.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]')?.click();
      completed = await waitForUi(
        () => !state.manager.orchestration.retainedRuns.some((run) => run.runId === targetId),
        20_000,
      );
    }
  } else if (message.action === "discoverBridge") {
    if (!state.inspectorOpen) {
      root.querySelector<HTMLButtonElement>('[data-action="inspector-toggle"]')?.click();
      await settleUi();
    }
    const button = root.querySelector<HTMLButtonElement>('[data-action="bridge-discover"]');
    if (button && !button.disabled) {
      button.click();
      completed = true;
    }
  } else if (message.action === "selectBrowserSession" && targetId) {
    await waitForUi(
      () => activePanel().browserBridge.sessions.some((session) => session.id === targetId),
      10_000,
    );
    const select = root.querySelector<HTMLSelectElement>('[data-action="browser-session"]:not([disabled])');
    if (select) {
      select.value = targetId;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      completed = await waitForUi(() =>
        Object.values(activePanel().agents).some((agent) =>
          browserProviderForAdapterType(agent.adapterType) !== undefined &&
          agent.sessionId === targetId
        )
      );
    }
  } else if (message.action === "submitPreparedRun") {
    const button = root.querySelector<HTMLButtonElement>('[data-action="submit-message"]');
    const pendingBefore = state.pendingRuns.size;
    if (button && !composerSubmitBlocked(button)) {
      button.click();
      completed = await waitForUi(() => state.pendingRuns.size > pendingBefore);
    }
  }
  vscode.postMessage({
    type: "humanE2e.uiResult",
    requestId: message.requestId,
    action: message.action,
    completed,
  });
};

window.addEventListener("message", (event: MessageEvent<ExtensionMessage>) => {
  const message = event.data;
  if (!message || typeof message !== "object") return;
  if (message.type === "humanE2e.uiRun") {
    void runHumanE2eUiScenario(message);
  } else if (message.type === "humanE2e.uiAction") {
    void runHumanE2eUiAction(message);
  } else if (message.type === "manager.snapshot") {
    state.hydrated = true;
    const previousManager = state.manager;
    state.manager = message.state;
    const selected = message.state.conversations.find((conversation) => conversation.id === message.state.activeConversationId);
    if (previousManager.activeConversationId !== message.state.activeConversationId &&
      selected?.preparedDraft && selected.workflowStatus === "idle" && !selected.running && !selected.archived) {
      state.roomView = "chat";
    }
    if (message.state.orchestration.status !== undefined) orchestrationStartPending = false;
    announceManagerTransition(previousManager, message.state);
    pruneResultSelections(message.state.conversations);
    const conversationIds = new Set(message.state.conversations.map((conversation) => conversation.id));
    Array.from(state.scrollPositions.keys()).forEach((key) => {
      if (!conversationIds.has(key.split(":", 1)[0] ?? "")) state.scrollPositions.delete(key);
    });
    for (const conversation of message.state.conversations) {
      const draft = state.drafts.get(conversation.id);
      const panel = state.panels.get(conversation.id);
      if (draft && (!panel || runPhaseOf(panel) !== "running")) {
        draft.iterationCount = conversation.iterationCount;
      }
    }
    const openInteractionRefs = new Set(message.state.interactions.map((interaction) => interaction.interactionRef));
    Array.from(state.pendingInteractions).forEach((interactionRef) => {
      if (!openInteractionRefs.has(interactionRef)) state.pendingInteractions.delete(interactionRef);
    });
    const secretRefs = new Set(message.state.interactions.filter((interaction) => interaction.secret).map((interaction) => interaction.interactionRef));
    Array.from(state.secretDrafts.keys()).forEach((interactionRef) => {
      if (!secretRefs.has(interactionRef)) state.secretDrafts.delete(interactionRef);
    });
    Array.from(state.pausedSecretInteractions).forEach((interactionRef) => {
      if (!secretRefs.has(interactionRef)) state.pausedSecretInteractions.delete(interactionRef);
    });
    delete state.managerError;
    scheduleRender();
  } else if (message.type === "manager.runDiff") {
    const target = resultSelection(message.conversationId, message.runId);
    target.diff = {
      files: message.files,
      bytes: JSON.stringify(message.files).length,
      ...(message.truncated === undefined ? {} : { truncated: message.truncated }),
    };
    evictResultSelections(selectionKey(message.conversationId, message.runId));
    scheduleRender();
  } else if (message.type === "manager.historyResults") {
    if (message.requestId === state.historySearchRequestId) {
      state.historyMatches = new Set(message.conversationIds);
      state.historyResultQuery = state.historySearchQuery ?? "";
      state.historyResultsTruncated = message.truncated === true;
      scheduleRender();
    }
  } else if (message.type === "manager.focus") {
    vscode.postMessage({ type: "conversation.select", conversationId: message.conversationId });
    state.manager.activeConversationId = message.conversationId;
    setOptionalProperty(state.manager, "focusedInteractionRef", message.interactionRef);
    scheduleRender();
    requestAnimationFrame(() => {
      if (!message.interactionRef) return;
      const element = document.getElementById(`interaction-${message.interactionRef}`);
      element?.scrollIntoView({ block: "center" });
      element?.querySelector<HTMLElement>("button, input, textarea")?.focus();
    });
  } else if (message.type === "manager.focusDirection") {
    state.roomView = "direction";
    if (message.section === "initiative") {
      state.disclosureStates.set(`${activeId()}:direction-initiative`, true);
    }
    scheduleRender();
    requestAnimationFrame(() => {
      const nextAction = longitudinalState().direction.nextAction.kind;
      const selector = message.section === "initiative"
        ? ".direction-initiative"
        : message.section === "findings" && nextAction === "reconcileFindings"
          ? ".direction-reconciliation"
        : message.section === "findings" && nextAction === "reviewRegressions"
          ? ".finding-regressed"
        : `[data-direction-section="${message.section}"]`;
      const element = document.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>(`[data-direction-section="${message.section}"]`);
      element?.scrollIntoView({ block: "center" });
    });
  } else if (message.type === "manager.restoreState") {
    restoreHostState(message.state);
  } else if (message.type === "conversation.message") {
    applyRuntimeMessage(message.conversationId, message.message);
  } else if (message.type === "manager.error") {
    orchestrationStartPending = false;
    state.hydrated = true;
    state.pendingInteractions.clear();
    state.pendingApprovals.clear();
    state.managerError = message.message;
    scheduleRender();
  }
  restorePersistedEditor();
});

const refreshVisibleCountdowns = (): void => {
  const now = Date.now();
  root.querySelectorAll<HTMLElement>("[data-deadline]").forEach((element) => {
    const deadline = Date.parse(element.dataset.deadline ?? "");
    element.textContent = Number.isFinite(deadline) ? formatDuration(Math.max(0, deadline - now)) : "";
  });
  // The host never tells the panel a deadline passed; it resolves the row and the interaction
  // stops appearing in the next snapshot. Until then the card must say what is about to happen.
  root.querySelectorAll<HTMLElement>("[data-deadline-passed]").forEach((element) => {
    const deadline = Date.parse(element.dataset.deadlinePassed ?? "");
    element.hidden = !Number.isFinite(deadline) || deadline > now;
  });
  // The same tick notices a catalogue operation the host has stopped answering, so the editor
  // offers its way out without the panel keeping a second timer.
  if (editorOperationStalled() && root.querySelector(".editor-stalled") === null) {
    scheduleRender();
  }
};

setInterval(refreshVisibleCountdowns, 1000);

window.addEventListener("beforeunload", () => {
  state.drafts.forEach((draft, conversationId) => {
    rememberDraftLocally(conversationId, draft.prompt);
    draft.pendingAttachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
  });
  rememberEditorLocally();
  flushDraftSave();
});

render();
installActionListeners();
vscode.postMessage({ type: "manager.ready" });
