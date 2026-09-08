/**
 * Incoming runtime-message state transitions.
 *
 * One place where a message from the extension host changes webview state, kept apart from
 * rendering so a transition can be read without reading markup.
 */

const applyRuntimeMessage = (conversationId: string, message: RuntimeMessage): void => {
  let panel = state.panels.get(conversationId) ?? emptyPanel();
  if (message.type === "state.snapshot") {
    panel = message.state;
    const draft = draftFor(conversationId);
    const ids = new Set(message.state.attachments.map((attachment) => attachment.id));
    draft.selectedAttachmentIds = new Set(Array.from(draft.selectedAttachmentIds).filter((id) => ids.has(id)));
    const approvalKeys = new Set(message.state.approvals.map((approval) => approvalKey(approval.agentId, approval.requestId)));
    Array.from(state.pendingApprovals).forEach((key) => {
      if (!approvalKeys.has(key)) state.pendingApprovals.delete(key);
    });
  } else if (message.type === "agent.reset") {
    const agent = panel.agents[message.agentId];
    if (agent) agent.output = "";
  } else if (message.type === "agent.delta") {
    const agent = panel.agents[message.agentId];
    if (agent) agent.output += message.text;
  } else if (message.type === "agent.replace") {
    const agent = panel.agents[message.agentId];
    if (agent) agent.output = message.text;
  } else if (message.type === "agent.patch") {
    const agent = panel.agents[message.agentId];
    if (agent) Object.assign(agent, message.patch);
  } else if (message.type === "transcript.append") {
    if (!panel.transcript.some((entry) => entry.id === message.entry.id)) {
      // Cap streamed growth at the larger of the configured window and the history the reader has
      // already loaded: a manually paged-in older window keeps its capacity, but a run streaming
      // more entries than that cannot grow the list without bound. Dropped entries stay counted in
      // the total, so "load older" remains offered.
      const cap = Math.max(panel.transcriptWindowSize, panel.transcript.length);
      panel.transcript.push(message.entry);
      panel.transcriptTotal += 1;
      while (panel.transcript.length > cap) {
        panel.transcript.shift();
      }
      panel.transcriptHasMore = panel.transcriptTotal > panel.transcript.length;
    }
  } else if (message.type === "transcript.prepend") {
    const ids = new Set(panel.transcript.map((entry) => entry.id));
    panel.transcript = [...message.entries.filter((entry) => !ids.has(entry.id)), ...panel.transcript];
    panel.transcriptTotal = message.total;
    panel.transcriptHasMore = message.hasMore;
    if (conversationId === activeId()) transcriptGrewAbove = true;
  } else if (message.type === "run.patch") {
    const previousRunning = panel.running;
    const previousWorkflowStatus = panel.workflowStatus;
    const hadPendingGate = Boolean(panel.pendingGate);
    panel.running = message.running;
    panel.workflowStatus = message.workflowStatus;
    setOptionalProperty(panel, "activeStep", message.activeStep);
    setOptionalProperty(panel, "activeStepId", message.activeStepId);
    setOptionalProperty(panel, "consensusRound", message.consensusRound);
    setOptionalProperty(panel, "pendingGate", message.pendingGate);
    if (message.roles) panel.roles = message.roles;
    if (conversationId === activeId()) {
      announceRunTransition(
        previousRunning,
        previousWorkflowStatus,
        message.running,
        message.workflowStatus,
      );
      if (!hadPendingGate && message.pendingGate) {
        announceStatus("A decision is required to continue the run.");
      }
    }
  } else if (message.type === "approval.add") {
    panel.approvals = panel.approvals.filter((item) => item.requestId !== message.approval.requestId || item.agentId !== message.approval.agentId);
    panel.approvals.push(message.approval);
    if (conversationId === activeId()) announceStatus("Approval is required to continue the run.");
  } else if (message.type === "approval.remove") {
    panel.approvals = panel.approvals.filter((item) => item.requestId !== message.requestId || item.agentId !== message.agentId);
    state.pendingApprovals.delete(approvalKey(message.agentId, message.requestId));
  } else if (message.type === "attachment.added") {
    panel.attachments.push(message.attachment);
    const draft = draftFor(conversationId);
    const pending = draft.pendingAttachments.get(message.clientId);
    if (pending) URL.revokeObjectURL(pending.previewUrl);
    draft.pendingAttachments.delete(message.clientId);
    draft.selectedAttachmentIds.add(message.attachment.id);
  } else if (message.type === "attachment.removed") {
    panel.attachments = panel.attachments.filter((attachment) => attachment.id !== message.attachmentId);
    draftFor(conversationId).selectedAttachmentIds.delete(message.attachmentId);
  } else if (message.type === "attachment.failed") {
    const draft = draftFor(conversationId);
    const pending = draft.pendingAttachments.get(message.clientId);
    if (pending) URL.revokeObjectURL(pending.previewUrl);
    draft.pendingAttachments.delete(message.clientId);
    state.errors.set(conversationId, message.message);
  } else if (message.type === "bridge.patch") {
    panel.browserBridge = message.status;
  } else if (message.type === "operation.result") {
    if (message.operation === "pipeline.run") {
      const pending = state.pendingRuns.get(message.requestId);
      if (pending) {
        if (message.status === "accepted") {
          pending.accepted = true;
          const draft = draftFor(pending.conversationId);
          if (draft.prompt.trim() === pending.prompt) {
            draft.prompt = "";
          }
          pending.attachmentIds.forEach((id) => draft.selectedAttachmentIds.delete(id));
          state.pendingRuns.delete(message.requestId);
          state.errors.delete(pending.conversationId);
        } else if (message.status === "failed" || message.status === "cancelled") {
          state.pendingRuns.delete(message.requestId);
          if (message.message) state.errors.set(pending.conversationId, message.message);
        }
      }
    } else if (message.operation === "pipeline.select") {
      state.pendingPipelineSelections.delete(message.requestId);
      if (message.status === "failed" && message.message) state.errors.set(conversationId, message.message);
      else if (message.status === "completed") state.errors.delete(conversationId);
    } else if (
      state.pendingEditorOperation?.requestId === message.requestId &&
      state.pendingEditorOperation.conversationId === conversationId
    ) {
      const pendingEditorOperation = state.pendingEditorOperation;
      delete state.pendingEditorOperation;
      if (message.status === "failed") {
        state.editorErrors = (message.message ?? "Pipeline operation failed").split(/\r?\n/).filter(Boolean);
        scheduleRender();
        restoreDialogFocus(pendingEditorOperation.returnFocusSelector);
      } else if (message.status === "cancelled") {
        if (message.message) state.editorErrors = [message.message];
        scheduleRender();
        restoreDialogFocus(pendingEditorOperation.returnFocusSelector);
      } else if (message.status === "completed") {
        state.editorErrors = [];
        if ((message.operation === "pipeline.validate" || message.operation === "pipeline.import" || message.operation === "pipeline.fork") && message.pipeline) {
          state.editorDraft = clonePipeline(message.pipeline);
          resetExpandedEditorCards(message.pipeline);
          state.editorOutputSchemas.clear();
          message.pipeline.steps.forEach((step) => {
            if (step.type === "agent" && step.output) state.editorOutputSchemas.set(step.id, safeJson(step.output.schema));
          });
          state.editorRaw = safeJson(message.pipeline);
          state.editorMode = "form";
          if (message.operation === "pipeline.import" || message.operation === "pipeline.fork") {
            delete state.editorSourcePipelineId;
            delete state.editorSourcePipelineName;
            delete state.editorSourcePipelineHash;
            state.editorOriginalRaw = "";
          }
        } else if (message.operation === "pipeline.save" || message.operation === "pipeline.delete") {
          closePipelineEditor(true);
        }
      }
    }
  } else if (message.type === "error") {
    panel.approvals.forEach((approval) => state.pendingApprovals.delete(approvalKey(approval.agentId, approval.requestId)));
    state.errors.set(conversationId, message.message);
  }
  state.panels.set(conversationId, panel);
  if (
    (message.type === "agent.delta" || message.type === "agent.replace" || message.type === "agent.reset") &&
    updateLiveAgentOutput(conversationId, message.agentId)
  ) {
    return;
  }
  scheduleRender();
};
