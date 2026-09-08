/**
 * DOM action dispatch and the outbound protocol messages it sends.
 *
 * Installed by the bootstrap rather than at module load, so listener installation is an
 * explicit step in main.ts and the order stays readable.
 */

const clearFieldError = (fieldId: string): void => {
  if (!state.fieldErrors.delete(fieldId)) return;
  document.getElementById(fieldId)?.setAttribute("aria-invalid", "false");
  const slot = document.getElementById(fieldErrorSlotId(fieldId));
  if (slot) slot.textContent = "";
};

/**
 * Refusal feedback for the one form the webview owns.
 *
 * An aria-invalid flag on its own has no stylesheet rule and no announcement behind it, so a
 * refused save read as a dead button. Every refusal writes the reason into the element the field
 * points at, moves focus to the first offender, and says it out loud.
 *
 * The refusal is recorded in the store as well as written into the live DOM. A message that
 * lived only in the node took the reason and the aria-invalid flag with it the moment a
 * background snapshot re-rendered the form, leaving a form that looked accepted; applyFieldErrors
 * puts it back after every render. The write here stays immediate rather than going through a
 * render of its own, because the values the reader has typed are held by the live controls.
 */
const reportFieldErrors = (
  fields: Array<{ id: string; value: string; message: string }>,
): boolean => {
  fields.forEach((field) => {
    if (field.value.length === 0) {
      state.fieldErrors.set(field.id, field.message);
      document.getElementById(field.id)?.setAttribute("aria-invalid", "true");
      const slot = document.getElementById(fieldErrorSlotId(field.id));
      if (slot) slot.textContent = field.message;
    } else {
      clearFieldError(field.id);
    }
  });
  const failed = fields.filter((field) => field.value.length === 0);
  const first = failed[0];
  if (first === undefined) return false;
  document.getElementById(first.id)?.focus();
  announceStatus(failed.map((field) => field.message).join(" "));
  return true;
};

/**
 * The refusal behind aria-disabled.
 *
 * A control marked aria-disabled keeps its place in the tab order so the reader can reach it and
 * hear why it will not fire; nothing else stops it firing, so this does. The reason is already
 * on screen — it is what aria-describedby points at — and is repeated through the live region,
 * because a reader who pressed the control is not necessarily reading the thing beside it.
 */
const declineDisabledControl = (target: HTMLElement): boolean => {
  if (target.getAttribute("aria-disabled") !== "true") return false;
  const described = (target.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((token) => token.length > 0)
    .map(describedText)
    .find((text) => text.trim().length > 0);
  const reason = (described ?? target.getAttribute("title") ?? "").trim();
  announceStatus(reason.length > 0 ? reason : "This control is not available yet.");
  return true;
};

// A described-by target may carry a spoken form of itself; the rendered text runs its button
// labels into its sentences.
const describedText = (id: string): string => {
  const element = document.getElementById(id);
  if (!element) return "";
  return element.dataset.announcement ?? element.textContent ?? "";
};

const installActionListeners = (): void => {
// A fixed-position menu does not follow the surface it was opened from; scrolling that surface
// closes it, and the tab strip's edge fades follow its own scroll.
root.addEventListener("scroll", (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target !== null && target.matches(".run-tabs-scroll")) {
    updateTabStripEdges();
    return;
  }
  root.querySelectorAll<HTMLDetailsElement>("details.header-action-menu[open], details.notification-center[open], details.run-action-menu[open]").forEach((menu) => {
    if (target === null || !menu.contains(target)) menu.open = false;
  });
}, true);

// F12. Whether the inspector is a column or a sheet depends on the width, and so does what the
// sheet makes inert; a resize across the breakpoint redraws.
if (typeof window.matchMedia === "function") {
  window.matchMedia("(max-width: 900px)").addEventListener("change", () => scheduleRender());
}

root.addEventListener("click", (event) => {
  dismissTransientMenus(event.target instanceof Element ? event.target : null);
}, true);

// The initiative panel is a real form, so Enter in its title field submits it. Nothing in the
// webview navigates: the submission is refused and routed to the same save the button runs.
root.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target instanceof Element ? event.target.closest("form") : null;
  form?.querySelector<HTMLButtonElement>('[data-action="initiative-save"]')?.click();
});

root.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-action]") : null;
  if (!target) return;
  const action = target.dataset.action;
  if (action === "noop") return;
  if (declineDisabledControl(target)) return;
  if (
    state.pendingEditorOperation &&
    (action?.startsWith("editor-") === true ||
      ["pipeline-import", "pipeline-export", "pipeline-save", "pipeline-delete"].includes(action ?? "") ||
      (action === "pipeline-editor-close" && !editorOperationStalled()))
  ) {
    return;
  }
  if (["run-rename", "run-duplicate", "run-archive", "run-unarchive", "run-delete"].includes(action ?? "")) {
    const menu = target.closest<HTMLDetailsElement>(".run-action-menu");
    if (menu) {
      menu.open = false;
    }
  }
  if (action === "dialog-confirm") {
    confirmDialog();
  } else if (action === "dialog-cancel") {
    closeDialog();
  } else if (action === "dialog-backdrop") {
    if (event.target === target) closeDialog();
  } else if (action === "render-retry") {
    scheduleRender();
  } else if (action === "render-reset") {
    resetViewState();
  } else if (action === "render-open-output") {
    vscode.postMessage({ type: "diagnostics.revealOutput" });
  } else if (action === "error-dismiss") {
    const message = target.dataset.errorMessage;
    if (state.managerError === message) delete state.managerError;
    if (state.errors.get(activeId()) === message) state.errors.delete(activeId());
    scheduleRender();
    // The control that was pressed is gone with the banner it dismissed. Focus stays on the
    // failures if another remains, and otherwise on the run this room is about.
    requestAnimationFrame(() => {
      (root.querySelector<HTMLElement>(".global-error-dismiss")
        ?? root.querySelector<HTMLElement>('[data-action="rename-conversation"]'))?.focus();
    });
  } else if (action === "render-editor-close") {
    closePipelineEditor();
  } else if (action === "skip-to-composer") {
    (document.getElementById("composer-prompt") ?? root.querySelector<HTMLElement>(".conversation-column button, .conversation-column [tabindex]"))?.focus();
  } else if (action === "run-discard-pending") {
    Array.from(state.pendingRuns.entries())
      .filter(([, request]) => request.conversationId === activeId() && !request.accepted)
      .forEach(([id]) => state.pendingRuns.delete(id));
    announceStatus("The pending submit was discarded. The run input is available again.");
    scheduleRender();
  } else if (action === "create-conversation") {
    vscode.postMessage({ type: "conversation.create" });
  } else if (action === "select-conversation" && target.dataset.conversation) {
    // A view chosen for one run is not a choice about the next; a run opens on its chat.
    if (target.dataset.conversation !== state.manager.activeConversationId) state.roomView = "chat";
    state.manager.activeConversationId = target.dataset.conversation;
    vscode.postMessage({ type: "conversation.select", conversationId: target.dataset.conversation });
    // Closing through the drawer's own helper is what puts focus back on the control that
    // opened it; assigning the flag left focus on a button the re-render had destroyed.
    if (state.runDrawerOpen) setRunDrawerOpen(false);
    else scheduleRender();
  } else if (action === "run-drawer-toggle") {
    setRunDrawerOpen(!state.runDrawerOpen);
  } else if (action === "run-drawer-open") {
    setRunDrawerOpen(true);
  } else if (action === "run-drawer-backdrop") {
    if (event.target === target) {
      setRunDrawerOpen(false);
    }
  } else if (action === "run-menu-toggle") {
    positionRunMenu(target);
  } else if (action === "run-rename") {
    const conversation = conversationFromTarget(target);
    if (conversation) renameConversation(conversation);
  } else if (action === "run-duplicate") {
    const conversation = conversationFromTarget(target);
    if (conversation) vscode.postMessage({ type: "conversation.duplicate", conversationId: conversation.id });
  } else if (action === "run-archive") {
    const conversation = conversationFromTarget(target);
    if (conversation) {
      const descendants = state.manager.conversations.filter((candidate) => candidate.id !== conversation.id && rootConversationFor(candidate).id === conversation.id).length;
      const suffix = descendants > 0 ? ` and ${String(descendants)} task run${descendants === 1 ? "" : "s"}` : "";
      openDialog({
        kind: "archiveRun",
        title: "Archive run?",
        message: `Archive “${conversation.title}”${suffix}? The complete history can be restored from All runs.`,
        confirmLabel: "Archive",
        conversationId: conversation.id,
      });
    }
  } else if (action === "run-unarchive") {
    const conversation = conversationFromTarget(target);
    if (conversation) vscode.postMessage({ type: "conversation.archive", conversationId: conversation.id, archived: false });
  } else if (action === "run-delete") {
    const conversation = conversationFromTarget(target);
    if (conversation) {
      const descendants = state.manager.conversations.filter((candidate) => candidate.id !== conversation.id && rootConversationFor(candidate).id === conversation.id).length;
      const suffix = descendants > 0 ? ` and ${String(descendants)} task run${descendants === 1 ? "" : "s"}` : "";
      openDialog({
        kind: "deleteRun",
        title: "Delete run permanently?",
        message: `Permanently delete “${conversation.title}”${suffix} and ${suffix ? "their" : "its"} local run metadata? This cannot be undone.`,
        confirmLabel: "Delete permanently",
        conversationId: conversation.id,
        danger: true,
      });
    }
  } else if (action === "rename-conversation") {
    const conversation = activeConversation();
    if (conversation) renameConversation(conversation);
  } else if (action === "orchestration-start") {
    vscode.postMessage({ type: "orchestration.start" });
  } else if (action === "orchestration-resume") {
    vscode.postMessage({ type: "orchestration.resume" });
  } else if (action === "orchestration-stop") {
    openDialog({
      kind: "stopOrchestration",
      title: "Stop TODO run?",
      message: "Active pairs and checks will be interrupted. Completed task histories and Git resources are retained for resume.",
      confirmLabel: "Stop run",
    });
  } else if (action === "orchestration-abandon") {
    const orchestration = state.manager.orchestration;
    const details = [orchestration.integrationBranch, orchestration.integrationWorktree].filter(Boolean).join("\n");
    openDialog({
      kind: "abandonOrchestration",
      title: "Abandon TODO resources?",
      message: `Remove the extension-owned TODO branches and worktrees${details ? `:\n${details}` : ""}? Conversation histories are retained.`,
      confirmLabel: "Remove resources",
      danger: true,
    });
  } else if (action === "readiness-remediate" && target.dataset.remediation) {
    vscode.postMessage({
      type: "readiness.remediate",
      remediationId: target.dataset.remediation,
      ...(target.dataset.detail ? { detail: target.dataset.detail } : {}),
    });
  } else if (action === "recovery-doctor") {
    vscode.postMessage({ type: "recovery.doctor" });
  } else if (action === "recovery-setup") {
    vscode.postMessage({ type: "recovery.setup" });
  } else if (action === "recovery-setting" && target.dataset.setting) {
    vscode.postMessage({ type: "settings.open", setting: target.dataset.setting });
  } else if (action === "advanced-mode-open") {
    vscode.postMessage({ type: "settings.open", setting: "bachata.advancedMode" });
  } else if (
    (action === "orchestration-reveal" ||
      action === "orchestration-patch" ||
      action === "orchestration-apply" ||
      action === "orchestration-diff" ||
      action === "orchestration-recheck") &&
    target.dataset.runId
  ) {
    const type = action === "orchestration-reveal"
      ? "orchestration.reveal"
      : action === "orchestration-patch"
        ? "orchestration.patch"
        : action === "orchestration-apply"
          ? "orchestration.apply"
          : action === "orchestration-diff"
            ? "orchestration.diff"
            : "orchestration.recheck";
    const conversationId = target.dataset.conversation;
    if (type !== "orchestration.reveal" && !conversationId) {
      return;
    }
    const selectable = type === "orchestration.apply" || type === "orchestration.patch";
    const paths = conversationId && selectable
      ? selectedResultPaths(conversationId, target.dataset.runId)
      : [];
    const hunks = conversationId && selectable
      ? selectedHunkReferences(conversationId, target.dataset.runId)
      : [];
    vscode.postMessage({
      type,
      runId: target.dataset.runId,
      ...(conversationId ? { conversationId } : {}),
      ...(paths.length > 0 ? { paths } : {}),
      ...(hunks.length > 0 ? { hunks } : {}),
    });
  } else if (action === "run-bundle-export" && target.dataset.conversation) {
    const format = target.dataset.format === "markdown" || target.dataset.format === "sarif"
      ? target.dataset.format
      : "bundle";
    vscode.postMessage({
      type: "conversation.exportBundle",
      conversationId: target.dataset.conversation,
      format,
    });
  } else if (action === "result-hunks-clear" && target.dataset.conversation) {
    resultSelection(target.dataset.conversation, target.dataset.runId).hunks.clear();
    scheduleRender();
  } else if (action === "reveal-finding" && target.dataset.file) {
    vscode.postMessage({
      type: "conversation.revealFile",
      conversationId: activeId(),
      path: target.dataset.file,
    });
  } else if (action === "open-producing-run" && target.dataset.run) {
    vscode.postMessage({ type: "history.openRun", runRef: target.dataset.run });
  } else if (action === "result-reveal-file" && target.dataset.path) {
    vscode.postMessage({ type: "conversation.revealFile", conversationId: activeId(), path: target.dataset.path });
  } else if (action === "result-open-changes" && target.dataset.path) {
    vscode.postMessage({ type: "conversation.openChanges", conversationId: activeId(), path: target.dataset.path });
  } else if (action === "result-source-control") {
    vscode.postMessage({ type: "conversation.openSourceControl", conversationId: activeId() });
  } else if (action === "result-publish-findings") {
    vscode.postMessage({ type: "conversation.publishFindings", conversationId: activeId() });
  } else if (action === "orchestration-cleanup" && target.dataset.runId) {
    const title = target.dataset.runTitle ?? target.dataset.runId;
    const branch = target.dataset.runBranch;
    const retry = target.dataset.cleanupPending === "true";
    openDialog({
      kind: "cleanupRetainedRun",
      title: `${retry ? "Retry cleanup for" : "Clean up"} ${title}?`,
      message: `Remove the retained worktree${branch ? ` and integration branch ${branch}` : ""}? Conversation history remains available.`,
      confirmLabel: retry ? "Retry cleanup" : "Clean up Git resources",
      runId: target.dataset.runId,
      danger: true,
    });
  } else if (action === "initiative-save") {
    const lines = (id: string): string[] =>
      ((document.getElementById(id) as HTMLTextAreaElement | null)?.value ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const title = (document.getElementById("initiative-title") as HTMLInputElement | null)?.value.trim() ?? "";
    const goal = (document.getElementById("initiative-goal") as HTMLTextAreaElement | null)?.value.trim() ?? "";
    if (reportFieldErrors([
      { id: "initiative-title", value: title, message: "Give this initiative a title." },
      { id: "initiative-goal", value: goal, message: "State the goal this initiative is working towards." },
    ])) {
      return;
    }
    vscode.postMessage({
      type: "initiative.define",
      title,
      goal,
      desiredOutcome: (document.getElementById("initiative-outcome") as HTMLTextAreaElement | null)?.value.trim() ?? "",
      scope: lines("initiative-scope"),
      constraints: lines("initiative-constraints"),
      acceptanceCriteria: lines("initiative-criteria"),
    });
  } else if (action === "initiative-direction-save") {
    const direction = (document.getElementById("initiative-direction") as HTMLTextAreaElement | null)?.value.trim() ?? "";
    if (reportFieldErrors([
      { id: "initiative-direction", value: direction, message: "Write the direction you are accepting before recording it." },
    ])) {
      return;
    }
    const rationale = (document.getElementById("initiative-direction-rationale") as HTMLInputElement | null)?.value.trim() ?? "";
    const evidence = ((document.getElementById("initiative-direction-evidence") as HTMLTextAreaElement | null)?.value ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // Only the decisions the human ticked support this direction. Attaching every accepted
    // decision would record provenance nobody claimed.
    const supportingDecisionIds = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-direction-support]"),
    )
      .filter((input) => input.checked)
      .map((input) => input.dataset.directionSupport ?? "")
      .filter((id) => id.length > 0);
    vscode.postMessage({
      type: "initiative.setDirection",
      direction,
      ...(rationale.length === 0 ? {} : { rationale }),
      ...(supportingDecisionIds.length === 0 ? {} : { supportingDecisionIds }),
      ...(evidence.length === 0 ? {} : { evidence }),
    });
    state.directionRationale = "";
    state.directionEvidence = "";
  } else if (action === "cycle-start" || action === "review-fresh") {
    const cycleType = (document.getElementById("cycle-type") as HTMLSelectElement | null)?.value;
    vscode.postMessage(
      action === "cycle-start"
        ? { type: "cycle.start", cycleType: cycleType ?? "review" }
        : { type: "review.startFresh", cycleType: "review" },
    );
  } else if (action === "cycle-close") {
    vscode.postMessage({ type: "cycle.close" });
  } else if (action === "cycle-rebaseline") {
    vscode.postMessage({ type: "cycle.rebaseline" });
  } else if (action === "notification-open") {
    const id = target.dataset.record;
    if (!id) return;
    vscode.postMessage({ type: "notifications.open", id });
  } else if (action === "notification-read-all") {
    vscode.postMessage({ type: "notifications.markAllRead" });
  } else if (action === "notification-clear") {
    vscode.postMessage({ type: "notifications.clear" });
  } else if (action === "finding-merge") {
    const absorbedIdentity = target.dataset.record;
    if (!absorbedIdentity) return;
    openDialog({
      kind: "mergeFinding",
      title: "Merge this finding into another",
      message: "Bachata folds later rounds of both findings into one history. Name the finding this one is the same defect as, and why.",
      confirmLabel: "Merge",
      absorbedIdentity,
      inputValue: target.dataset.candidate ?? "",
    });
  } else if (action === "initiative-switch") {
    const initiativeId = (document.getElementById("initiative-switch") as HTMLSelectElement | null)?.value;
    if (!initiativeId) return;
    vscode.postMessage({ type: "initiative.switch", initiativeId });
  } else if (action === "initiative-status") {
    const initiativeId = longitudinalState().initiative?.id;
    const status = (document.getElementById("initiative-status") as HTMLSelectElement | null)?.value;
    if (!initiativeId || !status) return;
    vscode.postMessage({ type: "initiative.setStatus", initiativeId, status });
  } else if (action === "initiative-new") {
    openDialog({
      kind: "createInitiative",
      title: "Start a separate initiative",
      message: "A new initiative keeps its own cycles, findings, decisions, and artifacts. The current one stays recorded.",
      confirmLabel: "Create",
      inputValue: "",
    });
  } else if (action === "initiative-export") {
    vscode.postMessage({
      type: "initiative.export",
      ...(longitudinalState().initiative?.id === undefined
        ? {}
        : { initiativeId: longitudinalState().initiative?.id }),
    });
  } else if (action === "initiative-import") {
    vscode.postMessage({ type: "initiative.import" });
  } else if (action === "direction-next-action") {
    vscode.postMessage({ type: "direction.runNextAction" });
  } else if (action === "finding-start-fix") {
    const identity = target.dataset.record;
    if (!identity) return;
    vscode.postMessage({ type: "finding.startFix", identity });
  } else if (action === "finding-unmerge") {
    const aliasIdentity = target.dataset.record;
    if (!aliasIdentity) return;
    vscode.postMessage({ type: "finding.unmerge", aliasIdentity });
  } else if (action === "resolve-record") {
    const recordTarget = target.dataset.target;
    const recordId = target.dataset.record;
    const resolution = target.dataset.resolution;
    if (!recordTarget || !recordId || !resolution) return;
    if (resolution === "reopen" || resolution === "supersede") {
      openDialog({
        kind: "resolveRecord",
        title: resolution === "reopen" ? "Reopen with new evidence" : "Supersede with a replacement",
        message: resolution === "reopen"
          ? "Bachata records why this was reopened and which material evidence changed. Both are required."
          : "Bachata records the replacement this record is superseded by. The replacement must already exist in this initiative.",
        confirmLabel: resolution === "reopen" ? "Reopen" : "Supersede",
        target: recordTarget === "decision"
          ? "decision"
          : recordTarget === "artifact"
            ? "artifact"
            : recordTarget === "externalEvidence" ? "externalEvidence" : "finding",
        recordId,
        mode: resolution === "reopen" ? "reopen" : "supersede",
        inputValue: "",
      });
      return;
    }
    vscode.postMessage({
      type: "resolution.apply",
      target: recordTarget,
      id: recordId,
      action: resolution,
    });
  } else if (action === "room-view") {
    state.roomView = target.dataset.view === "execution"
      ? "execution"
      : target.dataset.view === "direction"
        ? "direction"
        : "chat";
    if (state.roomView === "execution") {
      const conversationId = activeId();
      if (conversationId) {
        vscode.postMessage({ type: "conversation.viewExecution", conversationId });
      }
    }
    scheduleRender();
    if (target.dataset.focus === "pending-decision") {
      // "Review and continue" promised a decision; focus lands on it, not on the document body.
      requestAnimationFrame(() => root.querySelector<HTMLElement>(".decision-card")?.focus());
    }
  } else if (action === "inspector-toggle") {
    state.inspectorOpen = !state.inspectorOpen;
    scheduleRender();
    // Opened, the inspector is where the reader is going; closed, the control that opens it is
    // the nearest place to land. Either beats the document body.
    requestAnimationFrame(() => {
      (state.inspectorOpen
        ? document.getElementById("inspector-title")
        : root.querySelector<HTMLElement>(".header-action-menu > summary"))?.focus();
    });
  } else if (action === "composer-options-toggle") {
    state.composerOptionsOpen = !state.composerOptionsOpen;
    scheduleRender();
  } else if (action === "availability-check") postRuntime({ type: "availability.check" });
  else if (action === "working-directory") postRuntime({ type: "workingDirectory.pick" });
  else if (action === "contract-acknowledge") {
    const fingerprint = target.dataset.fingerprint;
    if (fingerprint) postRuntime({ type: "contract.acknowledge", fingerprint });
  }
  else if (action === "task-reset") openDialog({
    kind: "resetTask",
    title: "Reset run state?",
    message: "Reset this run’s local-agent sessions, attachments, queue, and recoverable pipeline? Bound browser conversations remain connected.",
    confirmLabel: "Reset run",
    danger: true,
  });
  else if (action === "transcript-export") postRuntime({ type: "transcript.export" });
  else if (action === "browser-asset-save" && target.dataset.assetId) postRuntime({ type: "browser.asset.save", assetId: target.dataset.assetId });
  else if (action === "browser-asset-reveal" && target.dataset.assetId) postRuntime({ type: "browser.asset.reveal", assetId: target.dataset.assetId });
  else if (action === "bridge-copy-token") {
    // Only the token travels. The endpoint is canonical on the Bridge side, so a clipboard a
    // hostile process can write cannot redirect the pairing to a port of its choosing.
    const token = activePanel().browserBridge.pairingToken;
    if (token !== undefined) {
      void navigator.clipboard.writeText(token).then(() => {
        target.textContent = "Copied";
        announceStatus("Pairing token copied. Use Paste & Pair in the Bridge popup.");
        setTimeout(() => { target.textContent = "Copy token"; }, 1200);
      }, () => {
        announceStatus("Copying the pairing token failed.");
      });
    }
  } else if (action === "bridge-discover") postRuntime({ type: "bridge.discover" });
  else if (action === "bridge-reset") openDialog({
    kind: "resetBridge",
    title: "Reset Browser Bridge?",
    message: "Reset pairing and disconnect the current browser extension? A new pairing token will be required.",
    confirmLabel: "Reset bridge",
    danger: true,
  });
  else if (action === "session-reset") postRuntime({ type: "session.reset", agentId: target.dataset.agent });
  else if (action === "load-older") postRuntime({ type: "transcript.loadOlder", beforeId: activePanel().transcript[0]?.id });
  else if (action === "attachment-pick") document.getElementById("attachment-input")?.click();
  else if (action === "attachment-remove" && target.dataset.attachmentId) {
    event.preventDefault();
    event.stopPropagation();
    postRuntime({ type: "attachment.remove", attachmentId: target.dataset.attachmentId });
  } else if (action === "submit-message") submitMessage(activeDraft().delivery);
  else if (action === "interrupt-run") postRuntime({ type: "run.interrupt" });
  else if ((action === "interaction-pause" || action === "interaction-resume") && target.dataset.interactionRef) {
    const interactionRef = target.dataset.interactionRef;
    if (action === "interaction-pause") state.pausedSecretInteractions.add(interactionRef);
    else state.pausedSecretInteractions.delete(interactionRef);
    vscode.postMessage({ type: action === "interaction-pause" ? "interaction.pause" : "interaction.resume", interactionRef });
  } else if (action === "interaction-submit" && target.dataset.interactionRef) {
    const interactionRef = target.dataset.interactionRef;
    const selected = Array.from(root.querySelectorAll<HTMLInputElement>(`[data-interaction-option="${interactionRef}"]:checked`)).map((input) => input.value);
    const interaction = state.manager.interactions.find((item) => item.interactionRef === interactionRef);
    const text = interaction?.secret
      ? state.secretDrafts.get(interactionRef) ?? ""
      : root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#interaction-text-${interactionRef}`)?.value ?? "";
    if (!interaction || !interactionCanSubmit(interaction, selected, text)) {
      refreshInteractionSubmitState(interactionRef);
      return;
    }
    state.pendingInteractions.add(interactionRef);
    scheduleRender();
    vscode.postMessage({ type: "interaction.submit", interactionRef, selected, freeText: text });
    // The button that was pressed is disabled by the redraw; the card it belongs to keeps focus
    // where the reader is, and the status region says what happened.
    announceStatus("Answer submitted. The run continues when the runtime accepts it.");
    requestAnimationFrame(() => document.getElementById(`interaction-${interactionRef}`)?.focus());
  } else if (action === "gate") {
    const gateAction = target.dataset.gateAction as HumanGateAction;
    const rollback = document.getElementById("rollback-target") as HTMLSelectElement | null;
    postRuntime({ type: "run.gate", action: gateAction, ...(gateAction === "rollback" && rollback?.value ? { targetStepId: rollback.value } : {}) });
  } else if (action === "approval") {
    const agentId = target.dataset.agent;
    const requestIdValue = target.dataset.request;
    const choiceId = target.dataset.choice;
    if (agentId && requestIdValue && choiceId) {
      const key = approvalKey(agentId, requestIdValue);
      if (state.pendingApprovals.has(key)) {
        return;
      }
      state.pendingApprovals.add(key);
      scheduleRender();
      postRuntime({ type: "approval.respond", agentId, requestId: requestIdValue, choiceId });
      // The pressed button is redrawn disabled, so focus would fall to the body. The card is
      // what the reader is reading; the interaction cards already land there after a submit.
      announceStatus("Approval submitted. The run continues when the runtime accepts it.");
      requestAnimationFrame(() => document.getElementById(`approval-${key}`)?.focus());
    }
  } else if (action === "focus-agent-output" && target.dataset.agent) {
    const agentId = target.dataset.agent;
    state.roomView = "chat";
    scheduleRender();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const outputs = Array.from(root.querySelectorAll<HTMLElement>("[data-agent-id]"))
          .filter((element) => element.dataset.agentId === agentId);
        const output = outputs.at(-1);
        if (output) {
          output.tabIndex = -1;
          output.scrollIntoView({ block: "center" });
          output.focus();
        } else {
          announceStatus("No transcript output is available for that participant.");
        }
      });
    });
  } else if (action === "queue-cancel" && target.dataset.messageId) postRuntime({ type: "queue.cancel", messageId: target.dataset.messageId });
  else if (action === "queue-resume") postRuntime({ type: "queue.resume" });
  else if (action === "workflow-resume") postRuntime({ type: "workflow.resume" });
  else if (action === "workflow-discard") openDialog({
    kind: "discardWorkflow",
    title: "Discard the recovery checkpoint?",
    message: "The recoverable pipeline and its checkpoint will be removed. The run's transcript is kept, but the pipeline cannot be resumed from where it stopped.",
    confirmLabel: "Discard checkpoint",
    danger: true,
  });
  else if (action === "copy-code" && target.dataset.codeId) {
    const code = codeBlocks.get(target.dataset.codeId);
    if (code !== undefined) {
      void navigator.clipboard.writeText(code).then(() => {
        target.textContent = "Copied";
        announceStatus("Code copied to the clipboard.");
        setTimeout(() => { target.textContent = "Copy"; }, 1200);
      }, () => {
        announceStatus("Copying to the clipboard failed.");
      });
    }
  } else if (action === "pipeline-edit") openPipelineEditor(false);
  else if (action === "pipeline-new") openPipelineEditor(true);
  else if (action === "pipeline-fork") startPipelineFork();
  else if (action === "pipeline-editor-close") {
    closePipelineEditor();
  } else if (action === "editor-mode") {
    const nextMode = target.dataset.mode === "json" ? "json" : "form";
    if (nextMode === state.editorMode) return;
    if (nextMode === "json") {
      // JSON is where a malformed value is repaired, so reaching it is never refused for being
      // malformed. Whatever the read complained about stays on screen in the JSON view.
      const pipeline = parseEditorPipeline({ tolerant: true });
      if (!pipeline) return;
      state.editorDraft = clonePipeline(pipeline);
      state.editorRaw = safeJson(pipeline);
      state.editorMode = "json";
      scheduleRender();
    } else {
      const pipeline = parseEditorPipeline();
      if (!pipeline) return;
      const id = requestId();
      setEditorOperation("pipeline.validate", id);
      postRuntime({ type: "pipeline.validate", pipeline, requestId: id }, editorTargetId());
    }
  } else if (action === "editor-step-focus" && state.editorDraft) {
    const index = Number(target.dataset.index);
    const step = state.editorDraft.steps[index];
    if (!step) return;
    state.expandedEditorCards.add(editorCardKey("step", step.id));
    scheduleRender();
    requestAnimationFrame(() => {
      root.querySelector<HTMLElement>(`[data-drag-kind="step"][data-index="${String(index)}"]`)?.scrollIntoView({ block: "start" });
    });
  } else if (action === "editor-agent-add" && state.editorDraft) {
    const used = new Set(state.editorDraft.agents.map((agent) => agent.id));
    const agent = defaultAgent(state.editorDraft.agents.length, editorPanel().adapterTypes[0] ?? "codex-app-server");
    agent.id = uniqueId(agent.id, used);
    state.editorDraft.agents.push(agent);
    state.expandedEditorCards.add(editorCardKey("agent", agent.id));
    syncEditorRaw();
    scheduleRender();
  } else if (action?.startsWith("editor-agent-") && state.editorDraft) {
    const index = Number(target.dataset.index);
    const agent = state.editorDraft.agents[index];
    if (!agent) return;
    if (action === "editor-agent-remove") {
      removePipelineReference(state.editorDraft, agent.id, "agent");
      state.editorDraft.agents.splice(index, 1);
    }
    if (action === "editor-agent-duplicate") {
      const copy = structuredClone(agent);
      copy.id = uniqueId(`${copy.id}-copy`, new Set(state.editorDraft.agents.map((item) => item.id)));
      copy.name = `${copy.name} copy`;
      state.editorDraft.agents.splice(index + 1, 0, copy);
    }
    if (action === "editor-agent-up") moveItem(state.editorDraft.agents, index, index - 1);
    if (action === "editor-agent-down") moveItem(state.editorDraft.agents, index, index + 1);
    syncEditorRaw();
    scheduleRender();
  } else if (action === "editor-role-add" && state.editorDraft) {
    const roles = state.editorDraft.roles ?? (state.editorDraft.roles = []);
    const role = defaultRole(roles.length);
    role.id = uniqueId(role.id, new Set(roles.map((item) => item.id)));
    roles.push(role);
    state.expandedEditorCards.add(editorCardKey("role", role.id));
    syncEditorRaw();
    scheduleRender();
  } else if (action?.startsWith("editor-role-") && state.editorDraft) {
    const roles = state.editorDraft.roles ?? (state.editorDraft.roles = []);
    const index = Number(target.dataset.index);
    const role = roles[index];
    if (!role) return;
    if (action === "editor-role-remove") {
      removePipelineReference(state.editorDraft, role.id, "role");
      roles.splice(index, 1);
    }
    if (action === "editor-role-duplicate") {
      const copy = structuredClone(role);
      copy.id = uniqueId(`${copy.id}-copy`, new Set(roles.map((item) => item.id)));
      copy.name = `${copy.name} copy`;
      roles.splice(index + 1, 0, copy);
    }
    if (action === "editor-role-up") moveItem(roles, index, index - 1);
    if (action === "editor-role-down") moveItem(roles, index, index + 1);
    syncEditorRaw();
    scheduleRender();
  } else if (action === "editor-assignment-add" && state.editorDraft) {
    const step = state.editorDraft.steps[Number(target.dataset.stepIndex)];
    if (step?.type === "assignRoles") {
      const role = state.editorDraft.roles?.[0]?.id;
      const agentId = state.editorDraft.agents[0]?.id;
      if (role && agentId) step.roleAssignments.push({ role, agentId });
      syncEditorRaw();
      scheduleRender();
    }
  } else if (action === "editor-assignment-remove" && state.editorDraft) {
    const step = state.editorDraft.steps[Number(target.dataset.stepIndex)];
    if (step?.type === "assignRoles") {
      step.roleAssignments.splice(Number(target.dataset.assignmentIndex), 1);
      syncEditorRaw();
      scheduleRender();
    }
  } else if (action === "editor-step-add" && state.editorDraft) {
    const step = defaultAgentStep(state.editorDraft.steps.length, state.editorDraft.agents[0]?.id);
    step.id = uniqueId(step.id, new Set(state.editorDraft.steps.map((item) => item.id)));
    state.editorDraft.steps.push(step);
    state.expandedEditorCards.add(editorCardKey("step", step.id));
    syncEditorRaw();
    scheduleRender();
  } else if (action?.startsWith("editor-step-") && state.editorDraft) {
    const index = Number(target.dataset.index);
    const step = state.editorDraft.steps[index];
    if (!step) return;
    if (action === "editor-step-remove") {
      state.editorOutputSchemas.delete(step.id);
      state.editorDraft.steps.splice(index, 1);
    }
    if (action === "editor-step-duplicate") {
      const copy = structuredClone(step);
      copy.id = uniqueId(`${copy.id}-copy`, new Set(state.editorDraft.steps.map((item) => item.id)));
      copy.name = `${copy.name} copy`;
      state.editorDraft.steps.splice(index + 1, 0, copy);
      if (copy.type === "agent" && copy.output) {
        state.editorOutputSchemas.set(copy.id, state.editorOutputSchemas.get(step.id) ?? safeJson(copy.output.schema));
      }
    }
    if (action === "editor-step-up") moveItem(state.editorDraft.steps, index, index - 1);
    if (action === "editor-step-down") moveItem(state.editorDraft.steps, index, index + 1);
    syncEditorRaw();
    scheduleRender();
  } else if (action === "pipeline-import") {
    if (editorIsDirty()) {
      openDialog({
        kind: "replaceEditorImport",
        title: "Replace unsaved pipeline?",
        message: "Replace the current draft with an imported pipeline? The imported pipeline is not saved until you choose Save and select.",
        confirmLabel: "Replace draft",
        danger: true,
      });
    } else {
      startPipelineImport();
    }
  } else if (action === "pipeline-export") {
    const pipeline = parseEditorPipeline();
    if (!pipeline) return;
    const id = requestId();
    setEditorOperation("pipeline.export", id);
    postRuntime({ type: "pipeline.export", pipeline, requestId: id }, editorTargetId());
  } else if (action === "pipeline-save") {
    const pipeline = parseEditorPipeline();
    if (!pipeline) return;
    const id = requestId();
    setEditorOperation("pipeline.save", id);
    const sourcePipelineId = state.editorSourcePipelineId;
    const expectedHash = state.editorSourcePipelineHash;
    const scopeKey = state.editorPipelineScopeKey;
    if (!scopeKey) {
      delete state.pendingEditorOperation;
      state.editorErrors = ["The pipeline storage scope is unavailable. Reopen the editor before saving."];
      scheduleRender();
      return;
    }
    if (sourcePipelineId) {
      if (!expectedHash) {
        delete state.pendingEditorOperation;
        state.editorErrors = ["The pipeline revision is unavailable. Reopen the editor before saving."];
        scheduleRender();
        return;
      }
      postRuntime(
        {
          type: "pipeline.save",
          pipeline,
          mode: "update",
          scopeKey,
          sourcePipelineId,
          expectedHash,
          requestId: id,
        },
        editorTargetId(),
      );
    } else {
      postRuntime(
        { type: "pipeline.save", pipeline, mode: "create", scopeKey, requestId: id },
        editorTargetId(),
      );
    }
    // The Save button is disabled by the busy redraw, and disabling the focused control drops
    // focus to the document. The editor's own heading keeps the reader inside the dialog that is
    // still open, and the status region says the save is in flight.
    announceStatus("Saving the pipeline. The editor closes when the save is accepted.");
    requestAnimationFrame(() => document.getElementById("pipeline-editor-title")?.focus());
  } else if (action === "pipeline-delete") {
    const pipelineId = state.editorSourcePipelineId;
    const pipelineName = state.editorSourcePipelineName ?? pipelineId;
    const expectedHash = state.editorSourcePipelineHash;
    const scopeKey = state.editorPipelineScopeKey;
    if (pipelineId && expectedHash && scopeKey) {
      openDialog({
        kind: "deletePipeline",
        title: `Delete ${pipelineName}?`,
        message: `Remove the custom pipeline “${pipelineName}” (${pipelineId})? Existing run histories are retained.`,
        confirmLabel: `Delete ${pipelineName}`,
        pipelineId,
        scopeKey,
        expectedHash,
        danger: true,
      });
    }
  }
});

let historySearchTimer: ReturnType<typeof setTimeout> | undefined;

const queueHistorySearch = (): void => {
  if (historySearchTimer) clearTimeout(historySearchTimer);
  const query = state.roomSearch.trim().toLowerCase();
  if (!query) {
    state.historyMatches.clear();
    state.historyResultQuery = "";
    delete state.historySearchRequestId;
    delete state.historySearchQuery;
    state.historyResultsTruncated = false;
    return;
  }
  historySearchTimer = setTimeout(() => {
    const id = requestId();
    state.historySearchRequestId = id;
    state.historySearchQuery = query;
    vscode.postMessage({ type: "history.search", query, requestId: id });
  }, 200);
};

root.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) return;
  // A field this window may not save keeps its place in the tab order, so it can still be typed
  // into. Nothing it types is recorded, and the reason is said once, when it is committed.
  if (target.getAttribute("aria-disabled") === "true") return;
  if (
    state.pendingEditorOperation &&
    (target.id === "pipeline-raw" ||
      target.dataset.editorMeta !== undefined ||
      target.dataset.editorPolicy !== undefined ||
      target.dataset.editorAgent !== undefined ||
      target.dataset.editorRole !== undefined ||
      target.dataset.editorStep !== undefined)
  ) {
    return;
  }
  // A field the reader is repairing is no longer the field that was refused.
  if (target.id) clearFieldError(target.id);
  if (target.id === "initiative-direction-rationale") {
    state.directionRationale = target.value;
    return;
  }
  if (target.id === "initiative-direction-evidence") {
    state.directionEvidence = target.value;
    return;
  }
  if (target.id === "history-filter") {
    state.historyFilter = target.value;
    scheduleRender();
    return;
  }
  if (target.id === "composer-prompt") {
    activeDraft().prompt = target.value;
    if (target.value.trim().length === 0) discardPreparedDraft(activeId());
    else scheduleDraftSave(activeId(), target.value);
    refreshComposerSubmitState();
  } else if (target.id === "pipeline-iterations") activeDraft().iterationCount = Math.max(
    1,
    Math.min(
      state.manager.maxPipelineIterations,
      Math.trunc(Number(target.value) || state.manager.defaultPipelineIterations),
    ),
  );
  else if (target.id === "pipeline-iteration-mode") {
    activeDraft().iterationMode = target.value === "untilClean" ? "untilClean" : "fixed";
    scheduleRender();
  } else if (target.id === "pipeline-clean-passes") {
    activeDraft().requiredCleanPasses = Math.max(1, Math.min(10, Math.trunc(Number(target.value) || 2)));
  } else if (target.id === "run-search") {
    state.roomSearch = target.value;
    queueHistorySearch();
    scheduleRender();
  } else if (target.dataset.interactionText) {
    vscode.postMessage({ type: "interaction.update", interactionRef: target.dataset.interactionText, freeText: target.value });
    refreshInteractionSubmitState(target.dataset.interactionText);
  } else if (target.dataset.interactionSecret) {
    const interactionRef = target.dataset.interactionSecret;
    state.secretDrafts.set(interactionRef, target.value);
    if (!state.pausedSecretInteractions.has(interactionRef)) {
      state.pausedSecretInteractions.add(interactionRef);
      vscode.postMessage({ type: "interaction.pause", interactionRef });
    }
    refreshInteractionSubmitState(interactionRef);
  } else if (target.id === "pipeline-raw") {
    state.editorRaw = target.value;
    // Clearing the errors without a render left the banner describing text that had since been
    // edited, and left Save marked refused over JSON that now parsed. The state and what is on
    // screen have to move together.
    if (state.editorErrors.length > 0) {
      state.editorErrors = [];
      scheduleRender();
    }
  } else if (target.dataset.editorMeta !== undefined || target.dataset.editorPolicy !== undefined || target.dataset.editorAgent !== undefined || target.dataset.editorRole !== undefined || target.dataset.editorStep !== undefined) {
    updateEditorInput(target);
  }
});

root.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
  if (declineDisabledControl(target)) return;
  if (
    state.pendingEditorOperation &&
    (target.id === "pipeline-raw" ||
      target.dataset.editorMeta !== undefined ||
      target.dataset.editorPolicy !== undefined ||
      target.dataset.editorAgent !== undefined ||
      target.dataset.editorRole !== undefined ||
      target.dataset.editorStep !== undefined)
  ) {
    return;
  }
  if (target.id === "notification-mode" && target instanceof HTMLSelectElement) {
    vscode.postMessage({ type: "notifications.setMode", mode: target.value });
    return;
  }
  if (target.id === "pipeline-select") {
    const id = requestId();
    const conversationId = activeId();
    state.pendingPipelineSelections.set(id, { conversationId, pipelineId: target.value });
    postRuntime({ type: "pipeline.select", pipelineId: target.value, requestId: id }, conversationId);
    scheduleRender();
  } else if (
    target.dataset.action === "result-file-select" &&
    target instanceof HTMLInputElement &&
    target.dataset.conversation &&
    target.dataset.path
  ) {
    const selection = resultSelection(target.dataset.conversation, target.dataset.runId).files;
    if (target.checked) selection.add(target.dataset.path);
    else selection.delete(target.dataset.path);
    scheduleRender();
  } else if (
    target.dataset.action === "result-hunk-select" &&
    target instanceof HTMLInputElement &&
    target.dataset.conversation &&
    target.dataset.path &&
    target.dataset.hunk !== undefined
  ) {
    const index = Number(target.dataset.hunk);
    if (Number.isInteger(index) && index >= 0) {
      const selection = resultSelection(target.dataset.conversation, target.dataset.runId).hunks;
      const indexes = selection.get(target.dataset.path) ?? new Set<number>();
      if (target.checked) indexes.add(index);
      else indexes.delete(index);
      if (indexes.size === 0) selection.delete(target.dataset.path);
      else selection.set(target.dataset.path, indexes);
      scheduleRender();
    }
  } else if (target.id === "show-archived" && target instanceof HTMLInputElement) {
    state.showArchived = target.checked;
    scheduleRender();
  } else if (target.id === "message-delivery" && target instanceof HTMLSelectElement) {
    activeDraft().delivery = target.value as MessageDelivery;
    scheduleRender();
  } else if (target.dataset.interactionOption && target instanceof HTMLInputElement) {
    const interactionRef = target.dataset.interactionOption;
    const selected = Array.from(root.querySelectorAll<HTMLInputElement>(`[data-interaction-option="${interactionRef}"]:checked`)).map((input) => input.value);
    vscode.postMessage({ type: "interaction.update", interactionRef, selected });
    refreshInteractionSubmitState(interactionRef);
  } else if (target.id === "attachment-input" && target instanceof HTMLInputElement && target.files) {
    void addFiles(target.files);
    target.value = "";
  } else if (target.dataset.action === "attachment-select" && target instanceof HTMLInputElement && target.dataset.attachmentId) {
    if (target.checked) activeDraft().selectedAttachmentIds.add(target.dataset.attachmentId);
    else activeDraft().selectedAttachmentIds.delete(target.dataset.attachmentId);
  } else if (target.dataset.action === "browser-session" && target.dataset.agent) {
    postRuntime({ type: "browser.session.select", agentId: target.dataset.agent, sessionId: target.value || undefined });
  } else if (target.dataset.editorMeta !== undefined || target.dataset.editorPolicy !== undefined || target.dataset.editorAgent !== undefined || target.dataset.editorRole !== undefined || target.dataset.editorStep !== undefined) {
    updateEditorInput(target);
  }
});
};
