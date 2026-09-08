
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
          throw new Error("must be a JSON object");
        }
        step.output.schema = schema as JsonValue;
      } catch (error) {
        errors.push(`${step.name} output schema ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    if (state.editorSourcePipelineId && pipeline.id !== state.editorSourcePipelineId) {
      errors.push(`Pipeline ID is locked while editing ${state.editorSourcePipelineName ?? state.editorSourcePipelineId}. Create a new pipeline to use another ID.`);
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
      throw new Error("Pipeline JSON must be an object");
    }
    const pipeline = parsed as PipelineDefinition;
    if (state.editorSourcePipelineId && pipeline.id !== state.editorSourcePipelineId) {
      throw new Error(`Pipeline ID is locked while editing ${state.editorSourcePipelineName ?? state.editorSourcePipelineId}. Create a new pipeline to use another ID.`);
    }
    return pipeline;
  } catch (error) {
    state.editorErrors = [error instanceof Error ? error.message : String(error)];
    scheduleRender();
    return undefined;
  }
};

const editorIsDirty = (): boolean => state.editorOpen && editorFingerprint() !== state.editorOriginalRaw;

const dialogReturnFocusSelector = (): string | undefined =>
  bachataWebviewBehavior.focusReturnSelector(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

const restoreDialogFocus = (selector: string | undefined): void => {
  requestAnimationFrame(() => {
    // A dialog dismissed over a still-open editor or drawer must return focus inside that layer.
    // The page behind it is under a backdrop, so a control focused there takes the ring where
    // nobody can see it and the next Tab is yanked back by the trap.
    const layer = state.editorOpen
      ? root.querySelector<HTMLElement>(".pipeline-editor")
      : state.runDrawerOpen
        ? root.querySelector<HTMLElement>(".run-drawer")
        : null;
    const scope = layer ?? root;
    const target = selector ? scope.querySelector<HTMLElement>(selector) : undefined;
    // A menu item is inside a <details> the dismissal closed; the summary is what can take focus.
    const collapsed = target?.closest<HTMLDetailsElement>("details:not([open])") ?? null;
    const reachable = collapsed ? collapsed.querySelector<HTMLElement>("summary") ?? target : target;
    (reachable
      ?? (layer ? reachableControls(layer)[0] : undefined)
      ?? root.querySelector<HTMLElement>('[data-action="pipeline-edit"]')
      ?? document.getElementById("composer-prompt")
      ?? root.querySelector<HTMLElement>('[data-action="run-drawer-toggle"]'))?.focus();
  });
};

const openDialog = (dialog: AppDialog): void => {
  const returnFocusSelector = dialogReturnFocusSelector();
  setOptionalProperty(state, "dialogReturnFocusSelector", returnFocusSelector);
  state.dialog = dialog;
  scheduleRender();
  requestAnimationFrame(() => {
    const input = document.getElementById("app-dialog-input") as HTMLInputElement | null;
    const confirm = root.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]');
    const cancel = root.querySelector<HTMLButtonElement>('[data-dialog-default="cancel"]');
    const danger = "danger" in dialog && dialog.danger;
    const initialFocus = bachataWebviewBehavior.dialogInitialFocus(Boolean(input), danger);
    (initialFocus === "input" ? input : initialFocus === "cancel" ? cancel : confirm)?.focus();
    input?.select();
  });
};

const closeDialog = (): void => {
  const selector = state.dialogReturnFocusSelector;
  delete state.dialog;
  delete state.dialogReturnFocusSelector;
  state.fieldErrors.delete("app-dialog-input");
  state.fieldErrors.delete("app-dialog-delta");
  scheduleRender();
  restoreDialogFocus(selector);
};

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
      title: "Discard pipeline changes?",
      message: "Unsaved pipeline changes will be lost.",
      confirmLabel: "Discard changes",
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
  `<details class="activity-details" ${disclosureAttributes(`json:${key}`)}><summary><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i>${escapeHtml(title)}</summary>${codeBlockHtml(safeJson(value), "json")}</details>`;

const statusLabel = (status: WorkflowStatus): string => {
  const labels: Record<WorkflowStatus, string> = {
    idle: "Ready",
    running: "Working",
    paused: "Waiting for you",
    completed: "Completed",
    interrupted: "Interrupted",
    error: "Needs attention",
  };
  return labels[status] ?? status;
};

const gateActionLabel = (action: HumanGateAction): string => {
  const labels: Record<HumanGateAction, string> = {
    continue: "Continue",
    skip: "Skip",
    cancel: "Cancel",
    retry: "Retry",
    discardStep: "Discard results",
    rerunStep: "Rerun step",
    repeatConsensus: "Discuss again",
    requestArbiterRuling: "Ask the arbiter to rule",
    rollback: "Return to step",
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

const browserActionCard = (panel: PanelState, entry: TranscriptEntry): string => {
  const agent = entry.agentId ? panel.agents[entry.agentId] : undefined;
  const data = entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : undefined;
  const actionValue = data && "action" in data ? data.action : entry.data;
  const resultValue = data && "result" in data ? data.result : undefined;
  const title = entry.eventType === "browser.action.detected" ? "Action detected" : "Action result";
  return `<article class="action-card ${entry.eventType === "browser.action.result" ? "result" : "detected"}">
    <div class="activity-kicker">${escapeHtml(agent?.name ?? entry.agentId ?? "Browser agent")} · ${escapeHtml(title)}</div>
    <div class="action-summary">${renderMarkdown(entry.text)}</div>
    ${actionValue === undefined ? "" : jsonDetailsHtml("Action", actionValue, `${entry.id}:action`)}
    ${resultValue === undefined ? "" : jsonDetailsHtml("Result", resultValue, `${entry.id}:result`)}
    <time>${escapeHtml(messageTime(entry.createdAt))}</time>
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
  return `<section class="browser-assets"><div class="browser-assets-heading">Files and artifacts</div>${assets
    .map((asset) => {
      const provider = browserProviderName(asset.provider);
      const source = asset.sourceElement === "artifactPane" ? "artifact pane" : "assistant reply";
      const size = asset.size === undefined ? "" : ` · ${escapeHtml(formatBytes(asset.size))}`;
      const actions = readOnly
        ? `<span class="browser-asset-unavailable">Unarchive to save or open</span>`
        : `${asset.downloadAvailable
          ? `<button data-action="browser-asset-save" data-asset-id="${escapeAttribute(asset.id)}">Save to workspace…</button>`
          : `<span class="browser-asset-unavailable">Provider-only content</span>`}<button data-action="browser-asset-reveal" data-asset-id="${escapeAttribute(asset.id)}">Open in provider…</button>`;
      return `<article class="browser-asset"><div class="browser-asset-main"><strong>${escapeHtml(asset.name)}</strong><span>${escapeHtml(provider)} · ${escapeHtml(asset.kind)} · ${escapeHtml(source)}${size}</span>${asset.mimeType ? `<small>${escapeHtml(asset.mimeType)}</small>` : ""}${asset.sourceOrigin ? `<span class="browser-asset-source">Source link: ${escapeHtml(asset.sourceOrigin)}</span>` : ""}</div><div class="browser-asset-actions">${actions}</div>${asset.previewText ? `<details class="browser-asset-preview" ${disclosureAttributes(`asset:${entry.id}:${asset.id}`)}><summary>Preview</summary>${codeBlockHtml(asset.previewText, "plain")}</details>` : ""}</article>`;
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
  if (entry.eventType === "user.message") {
    return `<article class="message-row user-row" data-entry="${escapeAttribute(entry.id)}">
      <div class="message user-message"><div class="message-author">You</div><div class="message-text markdown">${renderMarkdown(entry.text)}</div><time>${escapeHtml(messageTime(entry.createdAt))}</time></div>
    </article>`;
  }
  if (entry.agentId && ["answer", "interrupted", "error"].includes(entry.kind)) {
    const agent = panel.agents[entry.agentId];
    const side = agentSide(panel, entry.agentId);
    const fallback = entry.kind === "interrupted" ? "Interrupted" : "";
    return `<article class="message-row agent-row ${side}" data-entry="${escapeAttribute(entry.id)}" data-agent-id="${escapeAttribute(entry.agentId)}">
      ${avatarHtml(entry.agentId, agent?.name ?? entry.agentId, "agent-avatar")}
      <div class="message agent-message ${entry.kind === "error" ? "message-error" : ""}">
        <div class="message-author">${escapeHtml(agent?.name ?? entry.agentId)}</div>
        <div class="message-text markdown">${entry.eventType === "provider.recovery" ? "" : renderMarkdown(entry.text || fallback)}</div>
        ${entry.eventType === "provider.recovery" ? providerRecoveryHtml(entry) : ""}
        ${entry.eventType === "browser.response" ? capturedAssetsHtml(entry, readOnly) : ""}
        ${entry.eventType !== "provider.recovery" && (entry.step || entry.data !== undefined) ? jsonDetailsHtml(entry.step ? `Activity · ${entry.step}` : "Activity", entry.data ?? null, `${entry.id}:activity`) : ""}
        <time>${escapeHtml(messageTime(entry.createdAt))}</time>
      </div>
    </article>`;
  }
  const exactPrompt = entry.eventType === "agent.prompt";
  return `<article class="system-message ${entry.kind === "error" ? "system-error" : ""} ${exactPrompt ? "exact-prompt" : ""}" data-entry="${escapeAttribute(entry.id)}">
    <div class="activity-kicker">${escapeHtml(eventLabel(entry))}${entry.step ? ` · ${escapeHtml(entry.step)}` : ""}</div>
    ${exactPrompt ? `<details ${disclosureAttributes(`prompt:${entry.id}`)}><summary>Exact prompt</summary><div class="markdown exact-prompt-body">${renderMarkdown(entry.text)}</div></details>` : `<div class="markdown">${renderMarkdown(entry.text)}</div>`}
    ${entry.data === undefined ? "" : jsonDetailsHtml("Structured data", entry.data, `${entry.id}:structured`)}
    <time>${escapeHtml(messageTime(entry.createdAt))}</time>
  </article>`;
};

const liveMessagesHtml = (panel: PanelState): string =>
  Object.values(panel.agents)
    .filter((agent) => agent.status === "running")
    .map((agent) => {
      const side = agentSide(panel, agent.id);
      return `<article class="message-row agent-row ${side} live-message" data-agent-id="${escapeAttribute(agent.id)}">
        ${avatarHtml(agent.id, agent.name, "agent-avatar")}
        <div class="message agent-message"><div class="message-author">${escapeHtml(agent.name)} <span class="typing">working</span></div><div class="message-text markdown" data-live-agent-output="${escapeAttribute(agent.id)}">${renderMarkdown(agent.output || "…")}</div></div>
      </article>`;
    })
    .join("");

const queueAudience = (panel: PanelState, message: QueuedMessage): string => {
  const names = message.recipients.map((agentId) => panel.agents[agentId]?.name ?? agentId);
  const mode = message.mode === "review" ? "review, read-only" : "implementation, may write";
  return names.length === 0 ? `Recipients chosen by the pipeline · ${mode}` : `To ${listText(names, ", ")} · ${mode}`;
};

const queueHtml = (panel: PanelState): string => {
  if (panel.queuedMessages.length === 0 && !panel.resumableWorkflow) {
    return "";
  }
  const recovery = panel.resumableWorkflow
    ? `<article class="recovery-card"><div><strong>Recoverable pipeline</strong><span>${escapeHtml(panel.resumableWorkflow.pipelineName)} · step ${String(panel.resumableWorkflow.nextStepIndex + 1)} of ${String(panel.resumableWorkflow.totalSteps)}</span></div><div class="compact-actions"><button data-action="workflow-resume">Resume from checkpoint</button><button data-action="workflow-discard">Discard</button></div></article>`
    : "";
  const queued = panel.queuedMessages
    .map((message, index) => {
      const headline = message.kind === "pipeline"
        ? `Pipeline${(message.iterationCount ?? 1) > 1 ? ` · ${String(message.iterationCount)} iterations` : ""}`
        : "Direct message";
      // A queue of identical "Cancel" buttons names nothing, and the prompt is clamped to three
      // lines, so the control says which message it drops and the prompt keeps its full text.
      return `<article class="queue-item"><span class="queue-index">${String(index + 1)}</span><div><strong>${escapeHtml(headline)}</strong><small>${escapeHtml(queueAudience(panel, message))}</small><p class="queue-prompt" title="${escapeAttribute(message.prompt)}">${escapeHtml(message.prompt)}</p>${message.blockedReason ? `<p ${liveRegionAttributes(`queue-blocked:${message.id}`, "alert", message.blockedReason)}>${escapeHtml(message.blockedReason)}</p>` : ""}<small>Queued ${escapeHtml(formatDateTime(message.createdAt))}</small></div><button data-action="queue-cancel" data-message-id="${escapeAttribute(message.id)}" aria-label="Cancel queued message ${String(index + 1)}, ${escapeAttribute(headline)}">Cancel</button></article>`;
    })
    .join("");
  const queueBlocked = Boolean(panel.queuedMessages[0]?.blockedReason);
  return `<section class="queue-panel">${recovery}${panel.queuedMessages.length > 0 ? `<div class="queue-heading"><strong>Queued messages</strong>${panel.queuePaused && !queueBlocked ? `<button data-action="queue-resume">Resume queue</button>` : ""}</div>${queued}` : ""}</section>`;
};

const attachmentStripHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const pending = Array.from(draft.pendingAttachments.values())
    .map((attachment) => `<div class="attachment-chip pending"><img src="${escapeAttribute(attachment.previewUrl)}" alt=""><span>${escapeHtml(attachment.name)}</span><small>uploading</small></div>`)
    .join("");
  const stored = panel.attachments
    .map((attachment) => {
      const inputId = `attachment-${attachment.id}`;
      const preview = attachment.previewUri
        ? `<img src="${escapeAttribute(attachment.previewUri)}" alt="Preview of ${escapeAttribute(attachment.name)}">`
        : "";
      return `<div class="attachment-chip" title="${escapeAttribute(attachment.name)}"><input id="${escapeAttribute(inputId)}" type="checkbox" data-action="attachment-select" data-attachment-id="${escapeAttribute(attachment.id)}" aria-label="Include ${escapeAttribute(attachment.name)} in this message" ${draft.selectedAttachmentIds.has(attachment.id) ? "checked" : ""}><label for="${escapeAttribute(inputId)}">${preview}<span>${escapeHtml(attachment.name)}</span><small>${escapeHtml(formatBytes(attachment.size))}</small></label><button type="button" data-action="attachment-remove" data-attachment-id="${escapeAttribute(attachment.id)}" aria-label="Remove attachment ${escapeAttribute(attachment.name)}">×</button></div>`;
    })
    .join("");
  return pending || stored ? `<div class="attachment-strip-shell"><div class="attachment-strip">${pending}${stored}</div></div>` : "";
};

const runActionsMenuHtml = (conversation: ConversationSummary): string =>
  `<details class="run-action-menu" ${disclosureAttributes(`run-menu:${conversation.id}`)}><summary data-action="run-menu-toggle" aria-label="Actions for ${escapeAttribute(conversation.title)}">•••</summary><div class="run-action-menu-items">
    ${conversation.archived ? "" : `<button data-action="run-rename" data-conversation="${escapeAttribute(conversation.id)}">Rename</button>`}
    <button data-action="run-duplicate" data-conversation="${escapeAttribute(conversation.id)}">Duplicate</button>
    <button data-action="${conversation.archived ? "run-unarchive" : "run-archive"}" data-conversation="${escapeAttribute(conversation.id)}">${conversation.archived ? "Unarchive" : "Archive"}</button>
    <button class="danger" data-action="run-delete" data-conversation="${escapeAttribute(conversation.id)}">Delete</button>
  </div></details>`;

const conversationStatus = (conversation: ConversationSummary): { status: string; label: string } => {
  if (state.manager.interactions.some((interaction) => interaction.conversationId === conversation.id)) {
    return { status: "paused", label: "Waiting for you" };
  }
  if (conversation.waitingForResources) {
    return { status: "paused", label: "Waiting for capacity" };
  }
  if (conversation.running) {
    return { status: "running", label: statusLabel("running") };
  }
  return { status: conversation.workflowStatus, label: statusLabel(conversation.workflowStatus) };
};

const runStatusIcon = (status: string): string => {
  const icons: Record<string, string> = {
    running: "sync codicon-modifier-spin",
    paused: "clock",
    error: "error",
    interrupted: "debug-pause",
    completed: "pass",
    idle: "circle-outline",
    archived: "archive",
  };
  return icons[status] ?? "circle-outline";
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
    conversation.title,
    panel?.activeStep ? `${label} · ${panel.activeStep}` : label,
    pipeline ? `Pipeline: ${pipeline}` : undefined,
    ...(participants.length > 0
      ? [
        participants.length === 1 ? "Participant:" : "Participants:",
        ...participants.slice(0, 6).map((entry) => `  ${entry}`),
        ...(participants.length > 6 ? [`  +${String(participants.length - 6)} more`] : []),
      ]
      : []),
    conversation.iterationCount > 1 ? `Iteration ${String(conversation.activeIteration)} of ${String(conversation.iterationCount)}` : undefined,
    childCount > 0 ? `${String(childCount)} task run${childCount === 1 ? "" : "s"}` : undefined,
    `Updated ${relativeTime(conversation.updatedAt)}`,
  ].filter((line) => line !== undefined).join("\n");
};

const tabsHtml = (): string => {
  const active = activeConversation();
  const selectedRootId = active ? rootConversationFor(active).id : activeId();
  // An open archived run keeps its tab, so the strip still says where the reader is.
  const runs = rootRuns().filter((conversation) => !conversation.archived || conversation.id === selectedRootId);
  const archivedCount = rootRuns().filter((conversation) => conversation.archived).length;
  return `<nav class="run-tabs" aria-label="Bachata runs">
    <div class="run-tabs-brand">Bachata</div>
    <button class="run-tab-all" data-action="run-drawer-toggle" aria-label="Browse all runs" ${expandedControlAttributes(state.runDrawerOpen, "run-drawer")}>Runs${archivedCount > 0 ? `<small>${String(archivedCount)} archived</small>` : ""}</button>
    <div class="run-tabs-strip"><div class="run-tabs-scroll">${runs.map((conversation) => {
      const selected = conversation.id === selectedRootId;
      const { status, label } = conversation.archived ? { status: "archived", label: "Archived" } : conversationStatus(conversation);
      return `<div class="run-tab ${selected ? "selected" : ""} ${conversation.archived ? "archived" : ""}">
        <button class="run-tab-select" data-action="select-conversation" data-conversation="${escapeAttribute(conversation.id)}" title="${escapeAttribute(runTabTooltip(conversation, label))}" ${selected ? 'aria-current="page"' : ""}>
          <i class="codicon codicon-${escapeAttribute(runStatusIcon(status))} run-tab-status status-${escapeAttribute(status)}" aria-hidden="true"></i>
          <span>${escapeHtml(conversation.title)}</span>
          <span class="sr-only">${escapeHtml(label)}</span>
          ${conversation.iterationCount > 1 ? `<small>${String(conversation.activeIteration)}/${String(conversation.iterationCount)}</small>` : ""}
          ${conversation.unread > 0 ? `<span class="unread">${String(conversation.unread)}<span class="sr-only"> unread message${conversation.unread === 1 ? "" : "s"}</span></span>` : ""}
        </button>
        ${runActionsMenuHtml(conversation)}
      </div>`;
    }).join("")}</div></div>
    <button class="run-tab-new" data-action="create-conversation" aria-label="New run" title="New run"><i class="codicon codicon-add" aria-hidden="true"></i></button>
  </nav>`;
};

const runDrawerHtml = (): string => {
  if (!state.runDrawerOpen) {
    return "";
  }
  const query = state.roomSearch.trim().toLowerCase();
  const runs = rootRuns().filter((conversation) => {
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
    ? "No matching runs."
    : `${countLabel(runs.length, "run")}${state.roomSearch ? (runs.length === 1 ? " matches the search" : " match the search") : ""}.`;
  return `<div class="run-drawer-backdrop" data-action="run-drawer-backdrop"><aside class="run-drawer" id="run-drawer" role="dialog" aria-modal="true" aria-label="All runs">
    <header><div><h2>All runs</h2><p>Search active runs and recover archived runs.</p></div><button data-action="run-drawer-toggle" aria-label="Close all runs">×</button></header>
    <label class="sr-only" for="run-search">Search runs</label>
    <input id="run-search" class="room-search" value="${escapeAttribute(state.roomSearch)}" placeholder="Search runs, prompts, task IDs…" autofocus>
    <label class="archive-toggle"><input id="show-archived" type="checkbox" ${state.showArchived ? "checked" : ""}> Show archived runs</label>
    ${state.historyResultsTruncated && state.historyResultQuery ? `<p class="search-truncated">Search stopped at its evidence budget. Some older transcripts and events were not scanned.</p>` : ""}
    <p class="sr-only" ${liveRegionAttributes("run-drawer-count", "status", runCount)}>${escapeHtml(runCount)}</p>
    <div class="run-drawer-list">${runs.length === 0 ? `<p class="empty-list" aria-hidden="true">No matching runs.</p>` : runs.map((conversation) => {
      const { status, label } = conversationStatus(conversation);
      const childCount = state.manager.conversations.filter((candidate) => candidate.parentConversationId === conversation.id).length;
      const selected = selectedRootId === conversation.id;
      return `<article class="run-drawer-item ${selected ? "selected" : ""} ${conversation.archived ? "archived" : ""}">
        <button class="run-drawer-select" data-action="select-conversation" data-conversation="${escapeAttribute(conversation.id)}" title="${escapeAttribute(conversation.runRef)}" ${selected ? 'aria-current="true"' : ""}>
          <span class="room-presence status-${escapeAttribute(status)}"></span>
          <span><strong>${escapeHtml(conversation.title)}</strong><small>${escapeHtml(label)}${childCount > 0 ? ` · ${String(childCount)} task run${childCount === 1 ? "" : "s"}` : ""}</small></span>
          <time title="${escapeAttribute(formatDateTime(conversation.updatedAt))}">${escapeHtml(relativeTime(conversation.updatedAt))}</time>
        </button>
        ${runActionsMenuHtml(conversation)}
      </article>`;
    }).join("")}</div>
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
          : conversation.running
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
  return `<section class="recent-activity"><div class="section-heading"><div><strong>Recent activity</strong><small>Waiting, failed, and recently updated work</small></div><button data-action="run-drawer-open">All runs</button></div>${items.map((conversation) => {
    const { status, label } = conversationStatus(conversation);
    return `<button class="recent-activity-item" data-action="select-conversation" data-conversation="${escapeAttribute(conversation.id)}"><span class="room-presence status-${escapeAttribute(status)}"></span><span><strong>${escapeHtml(conversation.title)}</strong><small>${escapeHtml(label)}${conversation.orchestrationTaskId ? ` · ${escapeHtml(conversation.orchestrationTaskId)}` : ""}</small></span><time title="${escapeAttribute(formatDateTime(conversation.updatedAt))}">${escapeHtml(relativeTime(conversation.updatedAt))}</time></button>`;
  }).join("")}</section>`;
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
  pending: "Pending",
  queued: "Queued",
  running: "Working",
  stopping: "Stopping",
  stopped: "Stopped",
  completed: "Completed",
  blocked: "Blocked",
  failed: "Failed",
  abandoning: "Abandoning",
  cleanupPending: "Cleanup needed",
  abandoned: "Abandoned",
  skipped: "Skipped",
};

const orchestrationStatusLabel = (status: string): string =>
  orchestrationStatusLabels[status] ?? status;

const agentStatusLabels: Record<AgentStatus, string> = {
  unknown: "Unknown",
  available: "Available",
  idle: "Idle",
  running: "Working",
  interrupted: "Interrupted",
  error: "Failed",
};

const hasOrchestrationState = (): boolean => {
  const orchestration = state.manager.orchestration;
  return orchestration.runId !== undefined ||
    orchestration.active ||
    orchestration.tasks.length > 0 ||
    (orchestration.retainedRuns ?? []).length > 0;
};

const orchestrationStartButtonHtml = `<button data-action="orchestration-start">Run TODO.md</button>`;

const orchestrationHtml = (): string => {
  if (!hasOrchestrationState()) {
    return "";
  }
  const orchestration = state.manager.orchestration;
  const run = orchestration.runId !== undefined;
  const active = orchestration.active;
  const controls = orchestration.status === "abandoning"
    ? `<button class="danger" data-action="orchestration-abandon" ${active ? "disabled" : ""}>Retry Git cleanup</button>`
    : active
      ? `<button data-action="orchestration-stop">Stop and interrupt active work</button><button class="danger" data-action="orchestration-abandon">Abandon Git resources</button>`
      : run && ["stopped", "failed", "blocked"].includes(orchestration.status ?? "")
        ? `<button class="primary" data-action="orchestration-resume">Resume TODO run</button><button class="danger" data-action="orchestration-abandon">Abandon Git resources</button>`
        : `<button class="primary" data-action="orchestration-start">Run TODO.md</button>`;
  const tasks = orchestration.tasks.length === 0 ? "" : `<div class="orchestration-tasks">${orchestration.tasks.map((task) => `<button data-action="${task.conversationId ? "select-conversation" : "noop"}" ${task.conversationId ? `data-conversation="${escapeAttribute(task.conversationId)}"` : "disabled"} class="orchestration-task status-${escapeAttribute(task.status)}" title="${escapeAttribute(task.id)}"><span class="room-presence status-${escapeAttribute(task.status)}"></span><span><strong>${escapeHtml(task.title)}</strong><small>${escapeHtml(orchestrationStatusLabel(task.status))} · attempt ${String(task.attempts)}</small>${task.lastError ? `<small class="error">${escapeHtml(task.lastError)}</small>` : ""}${(task.blockers ?? []).length === 0 ? "" : `<small class="blocker">Blocked by: ${escapeHtml(listText(task.blockers, " · "))}</small>`}${task.summary ? `<small>${renderInline(task.summary)}</small>` : ""}</span></button>`).join("")}</div>`;
  const retainedRuns = orchestration.retainedRuns ?? [];
  const retained = retainedRuns.length === 0
    ? ""
    : `<section class="retained-runs"><div class="retained-runs-heading"><strong>Retained TODO runs</strong><small>Integration worktrees remain until cleanup completes.</small></div>${retainedRuns.map((item) => {
      const cleanupPending = item.status === "cleanupPending";
      const disabled = active;
      const disabledTitle = active
        ? 'title="Wait for the active TODO operation to finish"'
        : "";
      return `<article class="retained-run">
      <div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.integrationBranch)}</small><span class="path-line">${escapeHtml(item.integrationWorktree)}</span><small>${String(item.taskCount)} task${item.taskCount === 1 ? "" : "s"} · ${cleanupPending ? "cleanup pending" : `completed ${escapeHtml(formatDateTime(item.updatedAt))}`}</small></div>
      <div class="compact-actions"><button data-action="orchestration-reveal" data-run-id="${escapeAttribute(item.runId)}" ${cleanupPending ? 'disabled title="The retained path may already be removed"' : ""}>Reveal worktree</button><button class="danger" data-action="orchestration-cleanup" data-run-id="${escapeAttribute(item.runId)}" data-run-title="${escapeAttribute(item.title)}" data-run-branch="${escapeAttribute(item.integrationBranch)}" data-cleanup-pending="${cleanupPending ? "true" : "false"}" ${disabled ? `disabled ${disabledTitle}` : ""}>${cleanupPending ? "Retry cleanup" : "Clean up Git resources"}</button></div>
    </article>`;
    }).join("")}</section>`;
  const idle = !active && !run && orchestration.tasks.length === 0 && retainedRuns.length === 0;
  const done = orchestration.tasks.filter((task) => task.status === "completed").length;
  const progress = orchestration.tasks.length > 0 ? ` · ${String(done)} of ${String(orchestration.tasks.length)} tasks done` : "";
  return `<details class="orchestration-card" ${disclosureAttributes("orchestration", !idle)}><summary class="section-heading"><div><strong>${escapeHtml(orchestration.title ?? "TODO orchestration")}</strong><small>${escapeHtml(orchestration.status === undefined ? "No active TODO run" : orchestrationStatusLabel(orchestration.status))}${progress}${orchestration.integrationBranch ? ` · ${escapeHtml(orchestration.integrationBranch)}` : ""}</small></div><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary><div class="orchestration-body"><div class="compact-actions">${controls}</div>${tasks}${retained}</div></details>`;
};

const participantsHtml = (panel: PanelState, readOnly = false): string => {
  const sessions = panel.browserBridge.sessions;
  return Object.values(panel.agents)
    .map((agent) => {
      const provider = browserProviderForAdapterType(agent.adapterType);
      const providerSessions = provider ? sessions.filter((session) => session.provider === provider) : [];
      const browserSelect = provider
        ? `<label class="field"><span>Browser conversation</span><select data-action="browser-session" data-agent="${escapeAttribute(agent.id)}" ${panel.running || readOnly ? "disabled" : ""}><option value="">Not bound</option>${providerSessions.map((session) => `<option value="${escapeAttribute(session.id)}" ${agent.sessionId === session.id ? "selected" : ""} ${session.status !== "ready" ? "disabled" : ""}>${escapeHtml(session.title ?? session.conversationUrl)} · ${escapeHtml(browserSessionCapabilityLabel(session))}</option>`).join("")}</select></label>`
        : "";
      const roles = Object.entries(panel.roles).filter(([, id]) => id === agent.id).map(([role]) => role).join(", ");
      return `<article class="participant-card"><div class="participant-heading">${avatarHtml(agent.id, agent.name, "participant-avatar")}<div><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.adapterType)}</small></div><span class="agent-status status-${escapeAttribute(agent.status)}">${escapeHtml(agentStatusLabels[agent.status] ?? agent.status)}</span></div>${agent.error ? `<p class="error">${escapeHtml(agent.error)}</p>` : ""}${browserSelect}<details class="participant-more" ${disclosureAttributes(`participant:${agent.id}`)}><summary>Details</summary><dl><dt>Version</dt><dd>${escapeHtml(agent.version ?? "Not reported")}</dd><dt>Session</dt><dd>${escapeHtml(agent.sessionId ?? "Not bound")}</dd><dt>Roles</dt><dd>${escapeHtml(roles || "None")}</dd></dl><button data-action="session-reset" data-agent="${escapeAttribute(agent.id)}" ${panel.running || readOnly ? "disabled" : ""}>Reset session</button></details></article>`;
    })
    .join("");
};

const browserSessionCapabilityLabel = (session: BrowserSession): string => {
  // First match only, as before: one caveat is what fits beside a tab's title in a picker.
  const status = labelFor(browserSessionStatusLabel, session.status);
  if (session.provider !== "generic" || !session.capabilities) return status;
  if (session.capabilities.conversationState === "uncertain") return `${status} · unverified history`;
  if (session.capabilities.completion === "manualOnly") return `${status} · you mark answers complete`;
  if (session.capabilities.submission !== "verifiedSend") return `${status} · unverified send`;
  if (session.capabilities.interruption !== "confirmed") return `${status} · cannot be interrupted`;
  return `${status} · fully automatic`;
};

const browserBindingsHtml = (panel: PanelState, readOnly = false): string => {
  const sessions = panel.browserBridge.sessions;
  const browserAgents = Object.values(panel.agents).filter((agent) =>
    browserProviderForAdapterType(agent.adapterType) !== undefined,
  );
  if (browserAgents.length === 0) {
    return "";
  }
  const unbound = browserAgents.filter((agent) => !agent.sessionId).length;
  const lockedReason = readOnly ? "This run is archived, so its bindings are read-only."
    : panel.running ? "Bindings are locked while this run is in flight. Stop the run to bind a different tab." : "";
  return `<details class="browser-binding-bar" ${disclosureAttributes("browser-bindings", unbound > 0)}><summary><div><strong>Browser conversations</strong><small>Select the provider tab used by each participant.${lockedReason ? ` ${escapeHtml(lockedReason)}` : ""}</small></div><span class="binding-count">${unbound > 0 ? `${String(unbound)} not bound` : "all bound"}</span><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary><div class="browser-binding-controls">${browserAgents.map((agent) => {
    const provider = browserProviderForAdapterType(agent.adapterType);
    const providerSessions = sessions.filter((session) => session.provider === provider);
    const selectId = `browser-session-${agent.id}`;
    return `<div class="browser-binding-row"><label for="${escapeAttribute(selectId)}"><span>${escapeHtml(agent.name)}</span></label><select id="${escapeAttribute(selectId)}" data-action="browser-session" data-agent="${escapeAttribute(agent.id)}" ${lockedReason ? `disabled title="${escapeAttribute(lockedReason)}"` : ""}><option value="">Not bound</option>${providerSessions.map((session) => `<option value="${escapeAttribute(session.id)}" ${agent.sessionId === session.id ? "selected" : ""} ${session.status !== "ready" ? "disabled" : ""}>${escapeHtml(session.title ?? session.conversationUrl)} · ${escapeHtml(browserSessionCapabilityLabel(session))}</option>`).join("")}</select></div>`;
  }).join("")}</div></details>`;
};

const pipelineInspectorHtml = (panel: PanelState, _readOnly = false): string => {
  const pipeline = panel.selectedPipelineDefinition;
  if (!pipeline) {
    return `<p class="muted">No pipeline selected.</p>`;
  }
  const stepPreview = (step: PipelineStep, index: number): string => {
    let details: string;
    if (step.type === "assignRoles") {
      details = `<p>${escapeHtml(step.roleAssignments.map((item) => `${item.role} → ${item.agentId}`).join(", "))}</p>`;
    } else if (step.type === "executeChecklist") {
      details = `<p>Input: ${escapeHtml(step.inputName)} · pipeline: ${escapeHtml(step.pipelineId)}</p><p>Allowed paths: ${escapeHtml(listText(step.allowedPaths, ", "))}</p>${step.checks.length > 0 ? `<div class="markdown">${renderMarkdown(step.checks.map((check) => `- ${check}`).join("\n"))}</div>` : `<p>No checks: ${step.allowNoChecks === true ? "explicitly allowed" : "not allowed"}</p>`}`;
    } else {
      details = `<p>Participants: ${escapeHtml(listText(step.participants, ", "))}</p><div class="markdown">${renderMarkdown(step.promptTemplate)}</div>`;
    }
    return `<article class="prompt-preview"><strong>${String(index + 1)}. ${escapeHtml(step.name)}</strong><small>${escapeHtml(step.type)}</small>${details}</article>`;
  };
  return `<section class="pipeline-inspector"><div class="section-heading"><div><strong>${escapeHtml(pipeline.name)}</strong><small>${escapeHtml(pipeline.id)}</small></div></div>${panel.pipelineMutationReason ? `<p class="muted">${escapeHtml(panel.pipelineMutationReason)}</p>` : ""}${pipeline.description ? `<p>${escapeHtml(pipeline.description)}</p>` : ""}<details ${disclosureAttributes(`pipeline:${pipeline.id}:steps`)}><summary>Steps and exact prompts</summary>${pipeline.steps.map(stepPreview).join("")}</details>${jsonDetailsHtml("Pipeline JSON", pipeline, `pipeline:${pipeline.id}:json`)}</section>`;
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
  const policies = panel.browserActionPolicies;
  return `<aside class="inspector" aria-label="Run inspector"><div class="inspector-header"><h2 id="inspector-title" tabindex="-1">Inspector</h2><button data-action="inspector-toggle" aria-label="Close inspector">×</button></div><div class="inspector-scroll"><section><h3>Participants</h3>${participantsHtml(panel, readOnly)}</section><section><details class="inspector-section" ${disclosureAttributes("inspector:pipeline")}><summary>Pipeline<i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary>${pipelineInspectorHtml(panel, readOnly)}</details></section><section><details class="inspector-section" ${disclosureAttributes("inspector:bridge")}><summary>Browser Bridge<i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary><dl class="bridge-details"><dt>Status</dt><dd>${bridge.connected ? "connected" : "disconnected"}</dd><dt>Endpoint</dt><dd>${escapeHtml(bridge.endpoint ?? "not started")}</dd><dt>Sessions</dt><dd>${String(bridge.sessions.length)}</dd></dl>${bridge.error ? `<p class="error">${escapeHtml(bridge.error)}</p>` : ""}<div class="compact-actions"><button data-action="bridge-discover" ${readOnly ? "disabled" : ""}>Discover</button><button data-action="bridge-reset" ${readOnly ? "disabled" : ""}>Reset pairing</button></div><details class="bridge-advanced" ${disclosureAttributes("inspector:bridge:advanced")}><summary>Pairing and local action policies</summary><dl class="bridge-details"><dt>Pairing token</dt><dd>${bridge.pairingToken ? `<span class="pairing-token">${escapeHtml(bridge.pairingToken)}</span><button data-action="bridge-copy-token">Copy token</button>` : "hidden or paired"}</dd><dt>Workspace reads</dt><dd>${escapeHtml(labelFor(browserActionPolicyLabel, policies.readOnly))}</dd><dt>File changes</dt><dd>${escapeHtml(labelFor(browserActionPolicyLabel, policies.mutation))}</dd><dt>Destructive changes</dt><dd>${escapeHtml(labelFor(browserActionPolicyLabel, policies.destructive))}</dd><dt>Shell commands</dt><dd>${escapeHtml(labelFor(browserActionPolicyLabel, policies.shell))}</dd></dl><p class="muted">Browser-requested local actions follow these approval policies. Workspace reads require approval by default.</p></details>${bridge.sessions.map((session) => `<article class="browser-session"><strong>${escapeHtml(browserProviderName(session.provider))}</strong><span>${escapeHtml(session.title ?? session.conversationUrl)}</span><small>${escapeHtml(labelFor(browserSessionStatusLabel, session.status))} · tab ${String(session.tabId)} · ${escapeHtml(session.conversationIdentity)}</small></article>`).join("")}</details></section><section><details class="inspector-section" ${disclosureAttributes("inspector:workspace")}><summary>Workspace<i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary><dl class="bridge-details"><dt>Trusted</dt><dd>${panel.trusted ? "yes" : "no"}</dd><dt>Working directory</dt><dd>${escapeHtml(panel.workingDirectory ?? "not selected")}</dd><dt>Task</dt><dd>${escapeHtml(panel.taskId)}</dd><dt>Transcript</dt><dd>${String(panel.transcriptTotal)} entries</dd></dl></details></section></div></aside>`;
};

// The read-only sweep still disables outright; the composer's own blockers no longer do.
const composerSubmitBlocked = (button: HTMLButtonElement): boolean =>
  button.disabled || button.getAttribute("aria-disabled") === "true";

const refreshComposerSubmitState = (): void => {
  const conversationId = activeId();
  const button = root.querySelector<HTMLButtonElement>('[data-action="submit-message"]');
  if (!button) {
    return;
  }
  const canSubmit = composerCanSubmit(
    conversationId,
    state.panels.get(conversationId) ?? emptyPanel(),
    draftFor(conversationId),
  );
  // Typing a prompt resolves the "run input is empty" blocker, and the block that states it has to
  // go with it: a blocker still on screen after it has been cleared is a false instruction. The
  // full render is scheduled only when the blocker set crosses between empty and non-empty, so a
  // keystroke inside either state still costs nothing.
  const changed = (button.getAttribute("aria-disabled") === "true") === canSubmit;
  if (canSubmit) {
    button.removeAttribute("aria-disabled");
    button.removeAttribute("aria-describedby");
  } else {
    button.setAttribute("aria-disabled", "true");
    button.setAttribute("aria-describedby", "composer-blockers");
  }
  if (changed) {
    scheduleRender();
  }
};

const safetyLevelLabels: Record<ExecutionContract["safetyLevel"], string> = {
  review: "Review · read-only",
  interactive: "Interactive implementation · you approve actions",
  managed: "Managed implementation · controller-owned scope and verification",
  orchestration: "TODO orchestration · isolated unattended execution",
};

const writeScopeLabels: Record<ExecutionContract["scope"]["writeScope"], string> = {
  readOnly: "no repository writes",
  task: "isolated task worktree",
  configured: "configured working directory",
  workspace: "workspace files",
};

const contractStatusLabels: Record<ExecutionContract["providers"][number]["status"], string> = {
  ready: "ready", blocked: "blocked", needsSetup: "needs setup", unsupported: "not supported here",
};

const contractGateLabels: Record<string, string> = {
  none: "no human decision", both: "before and after the step runs",
  before: "before the step runs", beforeStep: "before the step runs",
  after: "after the step runs", afterStep: "after the step runs",
  invalidConsensus: "when a consensus round is invalid", maxConsensusRounds: "at the consensus round limit",
};

const writeScopeText = (value: string): string =>
  value === "readOnly" || value === "task" || value === "configured" || value === "workspace"
    ? writeScopeLabels[value]
    : value;

const authorityChangeValue = (label: string, value: string): string =>
  label === "Write scope" ? writeScopeText(value)
    : label === "Commit authority" ? (value === "allow" ? "commits allowed" : value === "never" ? "no commits" : value)
      : value;


const contractList = (values: string[], empty: string): string => values.length > 0
  ? `<ul class="contract-list">${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`
  : `<p class="muted">${escapeHtml(empty)}</p>`;

const runContractHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const contract = panel.executionContract;
  if (!contract) return "";
  const limits = [
    draft.iterationMode === "untilClean"
      ? `Iterations: until clean ×${String(draft.requiredCleanPasses)}, at most ${String(draft.iterationCount)}`
      : `Iterations: ${String(draft.iterationCount)} (maximum ${String(contract.limits.maxIterations)})`,
    ...(contract.limits.agentTurnTimeoutMs === undefined
      ? []
      : [`Provider turn limit: ${durationLabel(contract.limits.agentTurnTimeoutMs)}`]),
    ...(contract.limits.managedTaskTimeoutMs === undefined
      ? []
      : [`Managed task limit: ${durationLabel(contract.limits.managedTaskTimeoutMs)}`]),
    ...(contract.limits.browserOperationTimeoutMs === undefined
      ? []
      : [`Browser operation limit: ${durationLabel(contract.limits.browserOperationTimeoutMs)}`]),
    ...(contract.limits.maxRevisionCycles === undefined
      ? []
      : [`Revision cycles: ${String(contract.limits.maxRevisionCycles)}`]),
    ...(contract.limits.checklistRetries === undefined
      ? []
      : [`Task retries: ${String(contract.limits.checklistRetries)}`]),
    ...(contract.limits.checklistConcurrency === undefined
      ? []
      : [`Task concurrency: ${String(contract.limits.checklistConcurrency)}`]),
    ...(contract.limits.consensusSteps ?? []).map((step) =>
      `Consensus rounds, ${step.stepName}: at most ${String(step.maxRounds)} before a human decision. Retrying an invalid round grants one more${step.roundLimitRetryable ? `, and retrying at the round limit grants another ${String(step.maxRounds)}` : "; at the round limit this step does not offer a retry"}`),
    ...(contract.limits.maxParticipantTurns === undefined
      ? []
      : [contract.limits.participantTurnsBounded === false
          ? `Participant turns: at most ${String(contract.limits.maxParticipantTurns)} without a further human decision${contract.limits.executesChecklist ? "; each checklist task adds one bounded sub-run" : ""}`
          : `Participant turns: at most ${String(contract.limits.maxParticipantTurns)} for the whole run`]),
  ];
  const provenance = [
    ...(contract.provenance === undefined
      ? []
      : [
          `Extension version: ${contract.provenance.extensionVersion}`,
          `Pipeline hash: ${contract.provenance.pipelineHash.slice(0, 12)}…`,
        ]),
    ...contract.providers.map((provider) =>
      `${provider.name}: ${provider.model ? `model ${provider.model}` : "model not reported"}, ${provider.runtimeVersion ? `runtime ${provider.runtimeVersion}` : "runtime not detected"}`),
  ];
  const scope = [
    `Working directory: ${contract.scope.workingDirectory ?? "not selected"}`,
    `Writes: ${writeScopeLabels[contract.scope.writeScope]}`,
    ...(contract.scope.writablePaths.length > 0
      ? [`Writable paths: ${contract.scope.writablePaths.join(", ")}`]
      : []),
    ...(contract.scope.readablePaths.length > 0
      ? [`Readable paths: ${contract.scope.readablePaths.join(", ")}`]
      : []),
    ...(contract.scope.protectedPaths.length > 0
      ? [`Protected paths: ${contract.scope.protectedPaths.join(", ")}`]
      : []),
    `Commits: ${contract.commitPolicy === "allow" ? "the controller may create commits" : "no commits are created"}`,
  ];
  const providers = contract.providers.map((provider) => {
    const roles = provider.roles.length > 0 ? ` · ${provider.roles.join(", ")}` : "";
    const model = provider.model === undefined ? " · model not reported" : ` · model ${provider.model}`;
    return `${provider.name} · ${provider.adapterLabel ?? provider.adapter}${model}${roles} · ${contractStatusLabels[provider.status]}`;
  });
  const gates = contract.humanGates.map((gate) => `${gate.stepName} · ${contractGateLabels[gate.gate] ?? gate.gate}`);
  const roles = (contract.roles ?? []).map((role) => [
    `${role.name}${role.managed ? " · managed" : ""}${role.optional ? " · optional" : ""}`,
    role.readOnly ? "read-only" : `writes ${writeScopeLabels[role.writeScope]}`,
    ...(role.writablePaths.length > 0 ? [`paths ${role.writablePaths.join(", ")}`] : []),
    role.commitPolicy === "allow" ? "commits allowed" : "no commits",
    ...(role.verification.length > 0 ? [`checks ${role.verification.join(", ")}`] : []),
  ].join(" · "));
  const outbound = (contract.outboundContext ?? []).length === 0
    ? ""
    : `<section class="contract-outbound"><h3>What each provider receives</h3>${(contract.outboundContext ?? []).map((manifest) => `<details ${disclosureAttributes(`composer:outbound:${manifest.agentId}`)}>
      <summary>${escapeHtml(manifest.name)} · ${escapeHtml(manifest.adapterLabel)}</summary>
      <p class="muted">${escapeHtml(manifest.transport)}</p>
      <ul class="contract-list">${manifest.entries.map((entry) => `<li><strong>${escapeHtml(entry.label)}</strong> · ${escapeHtml(entry.detail)}${entry.exact ? "" : ` <span class="contract-inexact">selected at run time</span>`}</li>`).join("")}</ul>
      <h4>Never sent</h4>${contractList(manifest.exclusions, "")}
      <h4>Redaction</h4>${contractList(manifest.redactions, "")}
    </details>`).join("")}</section>`;
  const acknowledgement = panel.contractAcknowledgement;
  // EX-UI-02. What changed is evidence and belongs inside the contract; asking for the
  // acknowledgement is an action and belongs beside Send, where it is what holds the run. Both
  // used to be drawn twice inside this one footer, with two buttons that do the same thing.
  const authorityDiffHtml = acknowledgement && acknowledgement.diff.changes.length > 0
    ? `<section class="contract-authority-diff"><h3>Authority change since you last acknowledged this contract</h3><ul class="contract-list">${acknowledgement.diff.changes.map((change) => `<li class="${change.expands ? "authority-expanded" : "authority-narrowed"}"><strong>${escapeHtml(change.label)}</strong> ${escapeHtml(change.expands ? "widened" : "changed")} from ${escapeHtml(authorityChangeValue(change.label, change.from))} to ${escapeHtml(authorityChangeValue(change.label, change.to))}</li>`).join("")}</ul></section>`
    : "";
  // A policy refusal is already stated under its own heading; the blockers list repeats it only
  // because the host folds refusals into blockers, so it is filtered back out here.
  const refusals = new Set(contract.policyRefusals ?? []);
  const unresolved = contract.blockers.filter((blocker) => !refusals.has(blocker));
  // Open while the room is empty and the contract is what there is to read; once a run has
  // started, the transcript is, and a closed card gives it the height back.
  const openByDefault = acknowledgement?.open ?? panel.transcript.length === 0;
  return `<details class="run-contract" ${disclosureAttributes("composer:contract", openByDefault)}>
    <summary><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i><h2 class="contract-kicker">Run contract</h2><span class="contract-badge">${escapeHtml(safetyLevelLabels[contract.safetyLevel])}</span>${contract.assuranceLabel ? `<span class="contract-assurance">${escapeHtml(contract.assuranceLabel)}</span>` : ""}<span class="contract-pipeline" title="${escapeAttribute(contract.pipelineName)}">${escapeHtml(contract.pipelineName)}</span>${contract.blockers.length > 0 ? `<span class="contract-blockers">${String(contract.blockers.length)} unresolved</span>` : ""}</summary>
    <div class="contract-grid">
      ${contract.assuranceStatement ? `<section class="contract-assurance-statement"><h3>Assurance</h3><p>${escapeHtml(contract.assuranceStatement)}</p></section>` : ""}
      <section><h3>Providers</h3>${contractList(providers, "No providers are declared.")}</section>
      <section><h3>Scope and commits</h3>${contractList(scope, "No scope was resolved.")}</section>
      <section><h3>Role authority</h3>${contractList(roles, "This pipeline declares no roles; every provider runs with the scope above.")}</section>
      <section><h3>Verification</h3>${contractList(contract.verification, "No controller verification runs.")}${contract.verificationResources.length > 0 ? `<p class="muted">Shared resources: ${escapeHtml(contract.verificationResources.join(", "))}</p>` : ""}</section>
      <section><h3>Run limits</h3>${contractList(limits, "No limits were resolved.")}</section>
      <section><h3>Human decisions</h3>${contractList(gates, "No human gate interrupts this run.")}</section>
      <section><h3>Fallback</h3>${contractList(contract.fallbacks, "No provider fallback is declared.")}</section>
      <section><h3>Completion</h3>${contractList(contract.completion, "No completion criteria were resolved.")}</section>
      <section><h3>Provenance</h3>${contractList(provenance, "No provenance was resolved.")}</section>
      ${outbound}
      ${authorityDiffHtml}
      ${refusals.size > 0 ? `<section class="contract-policy-refusals"><h3>Repository policy refuses this run</h3>${contractList(contract.policyRefusals ?? [], "")}<p class="muted">Change the pipeline, or edit the repository policy file, before this run can start.</p></section>` : ""}
      ${unresolved.length > 0 ? `<section><h3>Unresolved before running</h3>${contractList(unresolved, "")}</section>` : ""}
    </div>
  </details>`;
};

const composerHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const conversationId = activeId();
  const blockers = sendBlockers(conversationId, panel, draft);
  const canSubmit = blockers.length === 0;
  const selection = pendingPipelineSelection(conversationId);
  const pipelineControlsDisabled = !panel.pipelineMutable || selection !== undefined;
  const pipelineControlTitle = selection
    ? `Switching to ${selection.pipelineId}…`
    : panel.pipelineMutationReason ?? "Select pipeline";
  const waitingForResources = conversationById(conversationId)?.waitingForResources === true;
  const sendLabel = draft.delivery === "queue" ? "Queue" : draft.delivery === "interrupt" ? "Interrupt and send" : "Send";
  const deliveryLabel = draft.delivery === "queue" ? "queued" : draft.delivery === "interrupt" ? "interrupt" : "";
  const optionChips: string[] = [];
  if (draft.iterationCount !== 1) {
    optionChips.push(`${String(draft.iterationCount)}×`);
  }
  if (draft.iterationMode !== "fixed") {
    optionChips.push(draft.requiredCleanPasses > 1 ? `until clean ×${String(draft.requiredCleanPasses)}` : "until clean");
  }
  if (deliveryLabel) {
    optionChips.push(deliveryLabel);
  }
  const optionsLabel = optionChips.length > 0 ? `Options · ${optionChips.join(" · ")}` : "Options";
  const pipelineOptions = panel.pipelines.length > 0
    ? panel.pipelines.map((pipeline) => `<option value="${escapeAttribute(pipeline.id)}" ${(selection?.pipelineId ?? panel.selectedPipelineId) === pipeline.id ? "selected" : ""}>${escapeHtml(pipeline.name)}</option>`).join("")
    : `<option value="" disabled selected>${state.panels.has(conversationId) ? "No pipeline available" : "Loading pipelines…"}</option>`;
  const advancedControls = `<div class="composer-advanced" id="composer-advanced"><label class="iteration-control"><span>Max iterations</span><input id="pipeline-iterations" type="number" min="1" max="${String(state.manager.maxPipelineIterations)}" value="${String(draft.iterationCount)}" ${panel.running && draft.delivery === "immediate" ? "disabled" : ""}></label>
        <label class="iteration-control"><span>Mode</span><select id="pipeline-iteration-mode" ${panel.running && draft.delivery === "immediate" ? "disabled" : ""}><option value="fixed" ${draft.iterationMode === "fixed" ? "selected" : ""}>Fixed</option><option value="untilClean" ${draft.iterationMode === "untilClean" ? "selected" : ""}>Until clean</option></select></label>
        ${draft.iterationMode === "untilClean" ? `<label class="iteration-control"><span>Clean passes</span><input id="pipeline-clean-passes" type="number" min="1" max="10" value="${String(draft.requiredCleanPasses)}" ${panel.running && draft.delivery === "immediate" ? "disabled" : ""}></label>` : ""}
        <label class="delivery-control"><span>Delivery</span><select id="message-delivery"><option value="immediate" ${draft.delivery === "immediate" ? "selected" : ""}>Run now</option><option value="queue" ${draft.delivery === "queue" ? "selected" : ""}>Queue</option><option value="interrupt" ${draft.delivery === "interrupt" ? "selected" : ""}>Interrupt current run</option></select></label></div>`;
  return `<footer class="composer">
    ${runContractHtml(panel, draft)}
    ${attachmentStripHtml(panel, draft)}
    <textarea id="composer-prompt" aria-label="Run input" placeholder="Describe the job for the selected pipeline…">${escapeHtml(draft.prompt)}</textarea>
    <div class="composer-controls">
      <div class="composer-options">
        <button data-action="attachment-pick" class="icon-button" aria-label="Attach image, text, log, or specification" title="Attach image, text, log, or specification"><i class="codicon codicon-add" aria-hidden="true"></i></button>
        <input id="attachment-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,application/json,.txt,.log,.md,.json" multiple hidden>
        <select id="pipeline-select" aria-label="Pipeline" ${pipelineControlsDisabled ? "disabled" : ""} title="${escapeAttribute(pipelineControlTitle)}">${pipelineOptions}</select>
        <button data-action="pipeline-edit" class="icon-button quiet-control" ${pipelineControlsDisabled ? "disabled" : ""} title="${escapeAttribute(selection ? pipelineControlTitle : panel.pipelineMutationReason ?? "Edit pipeline")}" aria-label="Edit pipeline"><i class="codicon codicon-edit" aria-hidden="true"></i></button>
        <div class="composer-options-anchor">
          <button data-action="composer-options-toggle" class="${state.composerOptionsOpen ? "open" : ""} ${optionChips.length > 0 ? "has-chips" : ""}" title="Run options" ${expandedControlAttributes(state.composerOptionsOpen, "composer-advanced")}><i class="codicon codicon-settings-gear" aria-hidden="true"></i><span>${escapeHtml(optionsLabel)}</span></button>
        </div>
      </div>
      <div class="send-actions">
        <small class="composer-hint">${escapeHtml(submitShortcutLabel)} to send</small>
        ${panel.running || waitingForResources ? `<button data-action="interrupt-run">${waitingForResources ? "Cancel wait" : "Stop"}</button>` : ""}
        <button class="send-button" data-action="submit-message" data-delivery="${escapeAttribute(draft.delivery)}" title="${escapeAttribute(`${sendLabel} · ${submitShortcutLabel}`)}" aria-keyshortcuts="Control+Enter Meta+Enter" ${composerSubmitStateAttributes(canSubmit, blockers)}>${escapeHtml(sendLabel)}</button>
      </div>
    </div>
    ${state.composerOptionsOpen ? advancedControls : ""}
    ${canSubmit ? "" : sendBlockersHtml(blockers)}
    ${waitingForResources && canSubmit ? `<small class="composer-note">Waiting for shared capacity. No provider or verification command has started.</small>` : selection ? `<small class="composer-note">Switching pipeline. Editing and creating pipelines are locked until the selected pipeline is ready.</small>` : panel.pipelineMutationReason ? `<small class="composer-note">${escapeHtml(panel.pipelineMutationReason)}</small>` : ""}
  </footer>`;
};

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
  button.textContent = pending
    ? "Submitting…"
    : interaction.kind === "executionChecklist" && selected.length === 0
      ? "Continue with none"
      : "Submit";
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
  const freeText = interaction.allowFreeText
    ? interaction.secret
      ? `<label class="sr-only" for="${textId}">Secret response</label><input id="${textId}" class="interaction-text" type="password" data-interaction-secret="${escapeAttribute(interaction.interactionRef)}" value="${escapeAttribute(state.secretDrafts.get(interaction.interactionRef) ?? "")}" placeholder="Secret stays only in this webview until submitted" autocomplete="off" ${pending ? "disabled" : ""}>`
      : `<label class="sr-only" for="${textId}">Additional instructions</label><textarea id="${textId}" class="interaction-text" data-interaction-text="${escapeAttribute(interaction.interactionRef)}" placeholder="Additional instructions…" ${pending ? "disabled" : ""}>${escapeHtml(interaction.freeText)}</textarea>`
    : "";
  const timer = paused
    ? `<span class="interaction-timer paused">Paused${interaction.remainingMs !== undefined ? ` · ${formatDuration(interaction.remainingMs)}` : ""}</span>`
    : interaction.deadlineAt
      ? `<span class="interaction-timer"><span class="sr-only">Time remaining </span><span data-deadline="${escapeAttribute(interaction.deadlineAt)}"></span></span>`
      : "";
  const expiry = !paused && interaction.deadlineAt
    ? `<p class="interaction-expired" data-deadline-passed="${escapeAttribute(interaction.deadlineAt)}" hidden>Deadline passed. An answer still counts until Bachata resolves this. ${escapeHtml(interactionTimeoutConsequence(interaction.kind))}</p>`
    : "";
  const canSubmit = interactionCanSubmit(interaction);
  const submitBlockedReason = interactionSubmitBlockedReason(interaction);
  return `<article class="interaction-card ${pending ? "pending" : ""}" id="interaction-${escapeAttribute(interaction.interactionRef)}" data-interaction-ref="${escapeAttribute(interaction.interactionRef)}" tabindex="-1">
    <div class="interaction-heading"><div><strong>${escapeHtml(interaction.title ?? interaction.kind)}</strong></div>${timer}</div>
    <p id="${promptId}">${escapeHtml(interaction.prompt)}</p>
    ${expiry}
    ${controls ? `<div class="interaction-options" role="${multiple ? "group" : "radiogroup"}" aria-labelledby="${promptId}">${controls}</div>` : ""}
    ${freeText}
    <div class="interaction-actions">
      <button data-action="interaction-${paused ? "resume" : "pause"}" data-interaction-ref="${escapeAttribute(interaction.interactionRef)}" ${pending ? "disabled" : ""}>${paused ? "Resume" : "Pause"}</button>
      <button class="primary" data-action="interaction-submit" data-interaction-ref="${escapeAttribute(interaction.interactionRef)}"${submitBlockedReason === undefined ? "" : ` title="${escapeAttribute(submitBlockedReason)}"`} ${canSubmit ? "" : "disabled"}>${pending ? "Submitting…" : escapeHtml(interactionSubmitLabel(interaction))}</button>
    </div>
  </article>`;
};

const interactionsHtml = (conversationId: string): string =>
  state.manager.interactions
    .filter((interaction) => interaction.conversationId === conversationId)
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
    [managerError, conversationError].filter(
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
      `<div class="global-error" ${liveRegionAttributes(`global-error:${message}`, "alert", message)}>${escapeHtml(message)}<button class="global-error-dismiss" data-action="error-dismiss" data-error-message="${escapeAttribute(message)}" aria-label="Dismiss this failure" title="Dismiss this failure">×</button></div>`)
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

const render = (): void => {
  if (!state.hydrated) {
    root.innerHTML = `<div class="app-shell">${tabsHtml()}<div class="workspace-shell"><main class="room-empty" aria-busy="true"><p class="muted">Loading runs…</p></main></div></div>`;
    return;
  }
  beginLiveRegionPass();
  codeBlocks.clear();
  codeBlockSequence = 0;
  const scroll = document.getElementById("conversation-scroll");
  const distanceFromBottom = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight : 0;
  const scrollTopBefore = scroll ? scroll.scrollTop : 0;
  const control = captureControl();
  // Native toggle events can arrive after a scheduled render replaces their disclosure.
  root.querySelectorAll<HTMLDetailsElement>("details[data-disclosure-key]").forEach((disclosure) => {
    const key = disclosure.dataset.disclosureKey;
    if (key) recordDisclosure(key, disclosure.open);
  });
  try {
    root.innerHTML = `<div class="app-shell"><button class="skip-link" data-action="skip-to-composer">Skip to run input</button>${tabsHtml()}<div class="workspace-shell">${readOnlyBannerHtml(state.manager.readOnly)}${globalErrorsHtml()}${mainRoomHtml()}</div>${runDrawerHtml()}${pipelineEditorHtml()}${appDialogHtml()}</div>`;
    // A control the reader cannot use must say so before it is pressed, not after it refuses.
    applyReadOnlyControls(root, state.manager.readOnly);
    applyFieldErrors();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recovery = state.editorOpen && state.editorMode === "form"
      ? `<p>The pipeline editor could not draw this definition. Retry opens it as JSON so the draft can still be repaired.</p>`
      : state.editorOpen
        ? `<p>The pipeline editor could not draw this definition. Close it to return to the run.</p>`
        : "";
    // Retry redraws the same state, so it is the only escape hatch that can fail the same way
    // twice. Resetting the view drops the presentation state a failing render is most likely to
    // be drawing, and the output channel is where the reader reads the failure out of Bachata
    // rather than out of this banner.
    const actions = `<div class="compact-actions"><button class="primary" data-action="render-retry">Retry</button>${state.editorOpen ? `<button data-action="render-editor-close">Close pipeline editor</button>` : ""}<button data-action="render-reset">Reset this view</button><button data-action="render-open-output">Open the Bachata output</button></div>`;
    if (state.editorOpen && state.editorMode === "form") {
      state.editorMode = "json";
    }
    const tabs = ((): string => { try { return tabsHtml(); } catch { return ""; } })();
    root.innerHTML = `<div class="app-shell">${tabs}<main class="render-failure" ${liveRegionAttributes("render-failure", "alert", message)}><h1>Bachata could not render this view</h1><p>Bachata could not draw this view from the current state. The run itself is untouched, and every other run is still open in the list.</p>${recovery}${actions}<details class="render-failure-details"><summary>Technical details</summary><p>${escapeHtml(message)}</p></details></main></div>`;
    return;
  }
  // EX-UI-04. The strip scrolls horizontally when the runs outgrow it; the selected tab is kept in
  // view so its own action menu is a control the reader can reach rather than one clipped under
  // the New-run button at the strip's edge. Nearest on both axes: the page must not jump.
  root.querySelector<HTMLElement>(".run-tab.selected")
    ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  const nextScroll = document.getElementById("conversation-scroll");
  if (nextScroll) {
    // Replacing the tree reset the scroll position; putting it back is a restore, not a
    // scroll, so the stylesheet's smooth behaviour is switched off for the assignment.
    nextScroll.setAttribute("data-restoring", "");
    if ((nextScroll.getAttribute("class") ?? "").split(/\s+/u).includes("is-empty")) {
      nextScroll.scrollTop = 0;
    } else if (distanceFromBottom < 90) {
      nextScroll.scrollTop = nextScroll.scrollHeight;
    } else if (transcriptGrewAbove) {
      nextScroll.scrollTop = Math.max(0, nextScroll.scrollHeight - nextScroll.clientHeight - distanceFromBottom);
    } else {
      // A reader anchored above the live edge keeps the lines they are reading; new output
      // lands below them instead of pushing the view down by its own height.
      nextScroll.scrollTop = scrollTopBefore;
    }
    nextScroll.removeAttribute("data-restoring");
  }
  transcriptGrewAbove = false;
  settleCodeBlockFocus();
  restoreControl(control);
  rememberEditorLocally();
  focusEmptyComposer(control !== undefined);
  refreshVisibleCountdowns();
  revealSelectedTab();
  updateTabStripEdges();
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
      block.setAttribute("aria-label", block.dataset.codeRegion ?? "code block");
    } else {
      block.removeAttribute("tabindex");
      block.removeAttribute("role");
      block.removeAttribute("aria-label");
    }
  });
};

const scheduleRender = (): void => {
  if (composing) {
    deferredRender = true;
    return;
  }
  if (renderScheduled) {
    return;
  }
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
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
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read attachment"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      if (comma < 0) {
        reject(new Error("Attachment encoding failed"));
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
    state.errors.set(conversationId, "Archived runs are read-only");
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
      state.errors.set(conversationId, `Unsupported attachment type: ${file.type || file.name}`);
      continue;
    }
    if (file.size > panel.maxAttachmentBytes) {
      state.errors.set(conversationId, `${file.name} exceeds the ${formatBytes(panel.maxAttachmentBytes)} per-attachment limit`);
      continue;
    }
    if (reservedCount >= panel.maxAttachmentCount) {
      const skipped = selected.length - index;
      state.errors.set(
        conversationId,
        `Only ${String(panel.maxAttachmentCount)} attachments can be sent with one run. ${String(accepted)} added, ${String(skipped)} skipped, starting at ${file.name}. Remove an attachment before adding more.`,
      );
      break;
    }
    if (reservedBytes + file.size > panel.maxAttachmentTotalBytes) {
      const remaining = Math.max(0, panel.maxAttachmentTotalBytes - reservedBytes);
      state.errors.set(
        conversationId,
        `${file.name} exceeds the remaining attachment allowance (${formatBytes(remaining)} available)`,
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
  const panel = activePanel();
  const draft = activeDraft();
  const prompt = draft.prompt.trim();
  const blockers = sendBlockers(conversationId, panel, { ...draft, delivery });
  const [firstBlocker] = blockers;
  if (firstBlocker) {
    state.errors.set(
      conversationId,
      `Bachata did not send this run: ${firstBlocker.condition} ${firstBlocker.requirement}`,
    );
    scheduleRender();
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
    state.errors.set(conversationId, "Archived runs are read-only");
    scheduleRender();
    return;
  }
  if (!panel.pipelineMutable) {
    state.errors.set(activeId(), panel.pipelineMutationReason ?? "The pipeline cannot be changed right now");
    scheduleRender();
    return;
  }
  if (pendingPipelineSelection(conversationId)) {
    state.errors.set(conversationId, "Wait for the selected pipeline to finish switching before opening the editor");
    scheduleRender();
    return;
  }
  const selected = panel.pipelines.find((pipeline) => pipeline.id === panel.selectedPipelineId);
  let pipeline = fresh || !panel.selectedPipelineDefinition ? blankPipeline(panel) : clonePipeline(panel.selectedPipelineDefinition);
  if (!fresh && selected && !selected.editable) {
    const used = new Set(panel.pipelines.map((item) => item.id));
    pipeline.id = uniqueId(`${pipeline.id}-custom`, used);
    pipeline.name = `${pipeline.name} copy`;
  }
  state.editorConversationId = conversationId;
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
    if (open) {
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
const positionRunMenu = (summary: HTMLElement): void => {
  const details = summary.closest<HTMLDetailsElement>(transientMenuSelector);
  if (!details) {
    return;
  }
  root.querySelectorAll<HTMLDetailsElement>(".run-action-menu[open]").forEach((item) => {
    if (item !== details && details.matches(".run-action-menu")) {
      item.open = false;
    }
  });
  const place = (): void => {
    const items = details.querySelector<HTMLElement>(":scope > div");
    const measured = items?.getBoundingClientRect();
    const rect = summary.getBoundingClientRect();
    const width = Math.max(200, measured?.width ?? 0);
    const height = Math.max(164, measured?.height ?? 0);
    const left = Math.min(
      Math.max(8, window.innerWidth - width - 8),
      Math.max(8, rect.right - width),
    );
    const top = rect.bottom + height + 8 <= window.innerHeight
      ? rect.bottom + 4
      : Math.max(8, rect.top - height - 4);
    details.style.setProperty("--run-menu-left", `${String(left)}px`);
    details.style.setProperty("--run-menu-top", `${String(top)}px`);
  };
  place();
  requestAnimationFrame(place);
};

const renameConversation = (conversation: ConversationSummary): void => {
  openDialog({
    kind: "renameRun",
    title: "Rename run",
    message: "Use a concise title that distinguishes this run from the others.",
    confirmLabel: "Rename",
    conversationId: conversation.id,
    inputValue: conversation.title,
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

const dismissTransientMenus = (origin: Element | null): void => {
  // An item chosen from a menu changes what is behind it, so that menu is dismissed too.
  const chosen = origin?.closest<HTMLElement>("[data-action]") ?? null;
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
  if (
    state.composerOptionsOpen &&
    !origin?.closest(".composer-options-anchor, .composer-advanced") &&
    origin?.closest<HTMLElement>("[data-action]")?.dataset.action !== "composer-options-toggle"
  ) {
    state.composerOptionsOpen = false;
    scheduleRender();
  }
};

// Action dispatch and input handling are installed by installActionListeners() in
// actions.ts, which this bootstrap calls below.
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

document.addEventListener("keydown", (event) => {
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
  if (event.key === "Escape" && state.dialog) {
    event.preventDefault();
    closeDialog();
  } else if (event.key === "Escape" && state.editorOpen) {
    event.preventDefault();
    closePipelineEditor();
  } else if (event.key === "Escape" && state.runDrawerOpen) {
    event.preventDefault();
    setRunDrawerOpen(false);
  } else if (event.key === "Escape" && state.composerOptionsOpen) {
    event.preventDefault();
    state.composerOptionsOpen = false;
    scheduleRender();
    requestAnimationFrame(() => root.querySelector<HTMLElement>('[data-action="composer-options-toggle"]')?.focus());
  } else if (event.key === "Escape") {
    const open = Array.from(root.querySelectorAll<HTMLDetailsElement>(transientMenuSelector))
      .filter((menu) => menu.open);
    if (open.length > 0) {
      event.preventDefault();
      open.forEach((menu) => {
        menu.open = false;
      });
      (open[0]?.querySelector<HTMLElement>("summary"))?.focus();
    }
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
    if (disclosure.open && disclosure.matches(transientMenuSelector)) {
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
  // selected in turn through the real select. A default that did not validate is simply not here.
  const catalogPipelineIds = activePanel().pipelines.map((pipeline) => pipeline.id);
  // What the picker actually offers, read off the rendered options rather than off the state that
  // produced them: a catalog held in state and never drawn is not a catalog a person can use.
  const renderedPipelineIds = Array.from(
    root.querySelectorAll<HTMLOptionElement>("#pipeline-select option"),
  ).map((option) => option.value).filter((value) => value.length > 0);
  let everyCatalogPipelineSelectable = catalogPipelineIds.length > 0;
  for (const pipelineId of catalogPipelineIds) {
    // A natively disabled select is a control the person cannot touch, so the scenario waits for
    // it the way they would rather than dispatching through it.
    if (!await waitForUi(() =>
      root.querySelector<HTMLSelectElement>("#pipeline-select")?.disabled === false
    )) {
      everyCatalogPipelineSelectable = false;
      break;
    }
    const select = root.querySelector<HTMLSelectElement>("#pipeline-select");
    if (!select) {
      everyCatalogPipelineSelectable = false;
      break;
    }
    select.value = pipelineId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
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

  root.querySelector<HTMLElement>('[data-action="pipeline-edit"]:not([disabled])')?.click();
  await settleUi();
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
  root.querySelector<HTMLElement>('[data-action="pipeline-edit"]:not([disabled])')?.click();
  await settleUi();
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
  // Read before the disclosure is opened: the advanced run options are not on screen until the
  // person asks for them. Driving `#pipeline-iterations` without opening it found nothing at all
  // and left the iteration count reporting whatever the default already was.
  const advancedOptionsHiddenByDefault = root.querySelector("#pipeline-iterations") === null;
  root.querySelector<HTMLElement>('[data-action="composer-options-toggle"]')?.click();
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
    announceManagerTransition(previousManager, message.state);
    pruneResultSelections(message.state.conversations);
    for (const conversation of message.state.conversations) {
      const draft = state.drafts.get(conversation.id);
      if (draft && !state.panels.get(conversation.id)?.running) {
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
      const heading = message.section === "decisions"
        ? "Which decisions require human judgment?"
        : message.section === "findings"
          ? "Which findings need human judgment?"
          : "What are we trying to achieve?";
      const element = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"))
        .find((node) => node.textContent === heading);
      element?.scrollIntoView({ block: "center" });
    });
  } else if (message.type === "manager.restoreState") {
    restoreHostState(message.state);
  } else if (message.type === "conversation.message") {
    applyRuntimeMessage(message.conversationId, message.message);
  } else if (message.type === "manager.error") {
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
