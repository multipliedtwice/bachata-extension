/** Queue controls rendered above the composer. */
const queueAudience = (panel: PanelState, message: QueuedMessage): string => {
  const names = message.recipients.map((agentId) => panel.agents[agentId]?.name ?? agentId);
  const mode = message.mode === "review" ? localize("review, read-only") : localize("implementation, may write");
  return names.length === 0 ? localize("Recipients chosen by the pipeline · {0}", mode) : localize("To {0} · {1}", listText(names, ", "), mode);
};

let queueEditingId: string | undefined;
let queueEditingPrompt = "";

const queueHtml = (panel: PanelState): string => {
  if (panel.queuedMessages.length === 0) {
    return "";
  }
  const queued = panel.queuedMessages
    .map((message, index) => {
      const pipelineName = panel.selectedPipelineId === message.pipelineId
        ? panel.selectedPipelineDefinition?.name : undefined;
      const headline = message.kind === "pipeline"
        ? pipelineName ?? localize("Pipeline")
        : queueAudience(panel, message);
      const iterations = message.kind === "pipeline" && (message.iterationCount ?? 1) > 1
        ? localize("{0} iterations", message.iterationCount ?? 1) : "";
      const editing = queueEditingId === message.id;
      const prompt = editing
        ? `<textarea class="queue-edit-prompt" data-queue-edit-input="${escapeAttribute(message.id)}" maxlength="${String(BACHATA_TEXT_LIMITS.preparedDraftUnits)}" aria-label="${escapeAttribute(localize("Edit queued message"))}">${escapeHtml(queueEditingPrompt)}</textarea>`
        : `<p class="queue-prompt" title="${escapeAttribute(message.prompt)}">${escapeHtml(message.prompt)}</p>`;
      const controls = editing
        ? `<button data-action="queue-edit-save" data-message-id="${escapeAttribute(message.id)}">${escapeHtml(localize("Save"))}</button><button data-action="queue-edit-dismiss">${escapeHtml(localize("Cancel"))}</button>`
        : `${index > 0 ? `<button class="icon-button" data-action="queue-promote" data-message-id="${escapeAttribute(message.id)}" aria-label="${escapeAttribute(localize("Move ahead of other queued messages"))}" title="${escapeAttribute(localize("Move ahead of other queued messages"))}"><i class="codicon codicon-arrow-up" aria-hidden="true"></i></button>` : ""}<button class="queue-edit-button" data-action="queue-edit" data-message-id="${escapeAttribute(message.id)}" aria-label="${escapeAttribute(localize("Edit queued message"))}" title="${escapeAttribute(localize("Edit queued message"))}"><i class="codicon codicon-edit" aria-hidden="true"></i><span>${escapeHtml(localize("Edit"))}</span></button><button class="icon-button" data-action="queue-cancel" data-message-id="${escapeAttribute(message.id)}" aria-label="${escapeAttribute(localize("Cancel queued message {0}, {1}", index + 1, headline))}" title="${escapeAttribute(localize("Cancel"))}"><i class="codicon codicon-trash" aria-hidden="true"></i></button>`;
      const details = [headline, iterations, formatDateTime(message.createdAt)].filter(Boolean).join(" · ");
      return `<article class="queue-item${editing ? " is-editing" : ""}" title="${escapeAttribute(details)}"><i class="codicon codicon-reply queue-item-icon" aria-hidden="true"></i><div class="queue-copy">${prompt}${message.blockedReason ? `<p class="queue-blocked-reason" ${liveRegionAttributes(`queue-blocked:${message.id}`, "alert", message.blockedReason)}>${escapeHtml(message.blockedReason)}</p>` : ""}</div><div class="queue-actions">${controls}</div></article>`;
    })
    .join("");
  const queueBlocked = Boolean(panel.queuedMessages[0]?.blockedReason);
  return `<section class="queue-panel" aria-label="${escapeAttribute(localize("Queued messages"))}"><div class="queue-heading"><strong>${escapeHtml(localize("Queued messages"))} <span class="queue-count">${String(panel.queuedMessages.length)}</span></strong>${panel.queuePaused && !queueBlocked ? `<button data-action="queue-resume">${escapeHtml(localize("Resume queue"))}</button>` : ""}</div><div class="queue-list">${queued}</div></section>`;
};
