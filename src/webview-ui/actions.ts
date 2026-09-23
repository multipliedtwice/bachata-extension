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
  const tabScroll = details.closest<HTMLElement>(".run-tabs-scroll");
  if (tabScroll) details.dataset.anchorScrollLeft = String(tabScroll.scrollLeft);
  else delete details.dataset.anchorScrollLeft;
  details.dataset.anchorViewport = `${String(window.innerWidth)}x${String(window.innerHeight)}`;
  if (tabScroll) details.dataset.anchorStripWidth = String(tabScroll.clientWidth);
  else delete details.dataset.anchorStripWidth;
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

const positionOpenRunMenus = (): void => {
  root.querySelectorAll<HTMLDetailsElement>(transientMenuSelector).forEach((menu) => {
    if (!menu.open) return;
    const summary = menu.querySelector<HTMLElement>("summary");
    if (summary) positionRunMenu(summary);
  });
};

/**
 * DOM action dispatch and the outbound protocol messages it sends.
 *
 * Installed by the bootstrap rather than at module load, so listener installation is an
 * explicit step in main.ts and the order stays readable.
 */

const closeActiveMenu = (): boolean => {
  const scope = state.editorOpen
    ? root.querySelector<HTMLElement>(".pipeline-editor")
    : state.runDrawerOpen
      ? root.querySelector<HTMLElement>(".run-drawer")
      : root;
  const menus = Array.from(scope?.querySelectorAll<HTMLDetailsElement>(transientMenuSelector) ?? [])
    .filter((menu) => menu.open);
  if (menus.length === 0) return false;
  menus.forEach((menu) => {
    menu.open = false;
    if (menu.dataset.disclosureKey) recordDisclosure(menu.dataset.disclosureKey, false);
  });
  menus[0]?.querySelector<HTMLElement>("summary")?.focus();
  return true;
};

const runActionRefusal = (conversation: ConversationSummary, action: string, family?: readonly ConversationSummary[]): string | undefined => {
  if (!["run-duplicate", "run-archive", "run-unarchive", "run-delete"].includes(action)) return undefined;
  const candidates = action === "run-duplicate" ? [conversation] : family ?? state.manager.conversations.filter(
    (candidate) => rootConversationFor(candidate).id === rootConversationFor(conversation).id,
  );
  const busy = candidates.find((candidate) => {
    const panel = state.panels.get(candidate.id);
    return candidate.running || candidate.waitingForResources || candidate.workflowStatus === "running" ||
      (panel !== undefined && runConfigurationLocked(panel, candidate.id));
  });
  if (!busy) return undefined;
  const paused = state.panels.get(busy.id)?.pendingGate !== undefined;
  const title = runTabLabel(busy);
  if (action === "run-duplicate") return paused
    ? localize("Resolve or leave the decision in “{0}” before duplicating it.", title)
    : localize("Stop “{0}” before duplicating it.", title);
  if (action === "run-delete") return paused
    ? localize("Resolve or leave the decision in “{0}” before deleting this run.", title)
    : localize("Stop “{0}” before deleting this run.", title);
  return paused
    ? localize("Resolve or leave the decision in “{0}” before changing its archive status.", title)
    : localize("Stop “{0}” before changing its archive status.", title);
};

const runActionAttributes = (conversation: ConversationSummary, action: string, family?: readonly ConversationSummary[]): string => {
  const refusal = runActionRefusal(conversation, action, family);
  return refusal ? ` aria-disabled="true" title="${escapeAttribute(refusal)}"` : "";
};

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
  const describedIds = (target.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((token) => token.length > 0);
  if (target.dataset.action === "submit-message") {
    explainSendRequirements(activeId(), sendBlockers(activeId(), activePanel(), {
      ...activeDraft(),
      delivery: composerDelivery(activePanel()),
    }));
    return true;
  }
  const described = describedIds
    .map(describedText)
    .find((text) => text.trim().length > 0);
  const reason = (target.getAttribute("aria-description") ?? described ?? target.getAttribute("title") ?? "").trim();
  announceStatus(reason.length > 0 ? reason : localize("This control is not available yet."));
  return true;
};

// A described-by target may carry a spoken form of itself; the rendered text runs its button
// labels into its sentences.
const describedText = (id: string): string => {
  const element = document.getElementById(id);
  if (!element) return "";
  return element.dataset.announcement ?? element.textContent ?? "";
};

const closeMenusWithin = (surface: HTMLElement | null): void => {
  root.querySelectorAll<HTMLDetailsElement>("details.header-action-menu[open], details.notification-center[open], details.run-action-menu[open]").forEach((menu) => {
    if (surface !== null && (!surface.contains(menu) || menu.contains(surface))) return;
    const restoreFocus = document.activeElement instanceof HTMLElement && menu.contains(document.activeElement);
    menu.open = false;
    if (menu.dataset.disclosureKey) recordDisclosure(menu.dataset.disclosureKey, false);
    if (restoreFocus) menu.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
  });
};

const bridgePairingCode = (endpoint: string | undefined, token: string): string => {
  if (!/^(?:[0-9]{4}|[A-Za-z0-9_-]{43})$/u.test(token)) return token;
  const match = /^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/bachata-browser-bridge-v9$/u.exec(endpoint ?? "");
  if (!match) return token;
  const port = Number.parseInt(match[1] ?? "", 10);
  if (port === 43_127) return token;
  return port <= 65_535 ? `v9.${String(port)}.${token}` : token;
};

const installActionListeners = (): void => {
// A fixed-position menu does not follow the surface it was opened from; scrolling that surface
// closes it, and the tab strip's edge fades follow its own scroll.
root.addEventListener("scroll", (event) => {
  const target = event.target instanceof HTMLElement ? event.target : null;
  if (target !== null && target.matches(".attachment-strip")) {
    updateAttachmentStripEdges();
  }
  if (target !== null && target.matches(".run-tabs-scroll")) {
    updateTabStripEdges();
    const restored = target.dataset.restoredScrollLeft === String(target.scrollLeft);
    delete target.dataset.restoredScrollLeft;
    if (restored) return;
    const anchored = Array.from(target.querySelectorAll<HTMLDetailsElement>(transientMenuSelector))
      .some((menu) => menu.open && menu.dataset.anchorScrollLeft === String(target.scrollLeft));
    if (anchored) return;
  }
  closeMenusWithin(target);
}, true);

window.addEventListener("resize", () => {
  const viewport = `${String(window.innerWidth)}x${String(window.innerHeight)}`;
  const movedMenu = Array.from(root.querySelectorAll<HTMLDetailsElement>(transientMenuSelector))
    .filter((menu) => menu.open)
    .some((menu) => {
      if (menu.dataset.anchorViewport !== viewport) return true;
      const scroll = menu.closest<HTMLElement>(".run-tabs-scroll");
      return scroll !== null && menu.dataset.anchorStripWidth !== String(scroll.clientWidth);
    });
  if (movedMenu) closeMenusWithin(root);
  updateRunTabStripLayout();
  const focused = document.activeElement instanceof HTMLElement
    ? document.activeElement.closest<HTMLElement>(".run-tab") : null;
  revealRunTab(focused ?? root.querySelector<HTMLElement>(".run-tab.selected"));
  updateTabStripEdges();
  updateAttachmentStripEdges();
});

// F12. Whether the inspector is a column or a sheet depends on the width, and so does what the
// sheet makes inert; a resize across the breakpoint redraws.
if (typeof window.matchMedia === "function") {
  window.matchMedia("(max-width: 900px)").addEventListener("change", () => scheduleRender());
}


/**
 * A disclosure the reader is opening is recorded now, not when the browser gets round to `toggle`.
 *
 * `toggle` is dispatched asynchronously. A render scheduled in the same frame — a snapshot
 * arriving, or a picker closing behind the click — rebuilds the panel from the recorded state,
 * which still says closed, and the menu the reader just opened is drawn shut. It reads as the
 * press having missed, and it happens only when a render lands in that window, which is why it
 * comes and goes. The click is the reader's intent, so the click is what records it; the `toggle`
 * that follows then finds the state already correct and does nothing.
 */
root.addEventListener("click", (event) => {
  if (event.target instanceof HTMLInputElement && event.target.id === "execution-context-mode"
    && executionContextControl(activePanel(), draftFor(activeId())).reason) {
    event.preventDefault();
    declineDisabledControl(event.target);
    return;
  }
  const summary = event.target instanceof Element ? event.target.closest("summary") : null;
  const details = summary?.parentElement instanceof HTMLDetailsElement
    ? summary.parentElement
    : undefined;
  const disclosureKey = details?.dataset.disclosureKey;
  // Read before the default action runs, so `open` is still what the reader is toggling away from.
  if (details && disclosureKey) {
    event.preventDefault();
    details.open = !details.open;
    recordDisclosure(disclosureKey, details.open);
  }
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
  dismissTransientMenus(event.target instanceof Element ? event.target : null);
  if (!target) return;
  const action = target.dataset.action;
  if (action === "noop" || action === "history-filter") return;
  if (declineDisabledControl(target)) return;
  if (target.dataset.runRequirementRemedy && state.dialog?.kind === "runRequirements") {
    if (state.dialog.conversationId !== activeId()) {
      announceStatus(localize("Open this run before resolving its requirements."));
      return;
    }
    closeDialog();
  }
  if (action === "run-requirements") {
    openRunRequirements(target.dataset.conversation ?? activeId());
    return;
  }
  if (["availability-check", "working-directory", "task-reset", "session-reset", "browser-session", "bridge-reset"].includes(action ?? "") && runConfigurationLocked(activePanel())) {
    announceStatus(localize("Finish the active operation before changing run configuration."));
    return;
  }
  if (
    state.pendingEditorOperation &&
    (action?.startsWith("editor-") === true ||
      ["pipeline-import", "pipeline-export", "pipeline-save", "pipeline-delete"].includes(action ?? "") ||
      (action === "pipeline-editor-close" && !editorOperationStalled()))
  ) {
    return;
  }
  if (["run-rename", "run-duplicate", "run-archive", "run-unarchive", "run-delete"].includes(action ?? "")) {
    const conversation = conversationFromTarget(target);
    const refusal = conversation && action ? runActionRefusal(conversation, action) : undefined;
    if (refusal) {
      announceStatus(refusal);
      return;
    }
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
  } else if (action === "workspace-ownership") {
    vscode.postMessage({ type: "workspace.ownership" });
  } else if (action === "error-dismiss") {
    const message = target.dataset.errorMessage;
    if (productErrorMessage(state.managerError) === message) delete state.managerError;
    if (productErrorMessage(state.errors.get(activeId())) === message) state.errors.delete(activeId());
    scheduleRender();
    // The control that was pressed is gone with the banner it dismissed. Focus stays on the
    // failures if another remains, and otherwise on the run this room is about.
    requestAnimationFrame(() => {
      (root.querySelector<HTMLElement>(".global-error-dismiss")
        ?? document.getElementById("composer-prompt"))?.focus();
    });
  } else if (action === "render-editor-close") {
    closePipelineEditor();
  } else if (action === "skip-to-composer") {
    (document.getElementById("composer-prompt") ?? root.querySelector<HTMLElement>(".conversation-column button, .conversation-column [tabindex]"))?.focus();
  } else if (action === "run-discard-pending") {
    Array.from(state.pendingRuns.entries())
      .filter(([, request]) => request.conversationId === activeId() && !request.accepted)
      .forEach(([id]) => state.pendingRuns.delete(id));
    announceStatus(localize("The pending submit was discarded. The run input is available again."));
    scheduleRender();
  } else if (action === "create-conversation") {
    vscode.postMessage({ type: "conversation.create" });
  } else if (action === "select-conversation" && target.dataset.conversation) {
    // A view chosen for one run is not a choice about the next; a run opens on its chat.
    state.roomView = "chat";
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
      if (descendants === 0 && isPristineRunDraft(conversation)) {
        vscode.postMessage({ type: "conversation.archive", conversationId: conversation.id, archived: true });
        return;
      }
      openDialog({
        kind: "archiveRun",
        title: localize("Archive run?"),
        message: descendants === 0
          ? localize("Archive “{0}”? The complete history can be restored from All runs.", runTabLabel(conversation))
          : descendants === 1
            ? localize("Archive “{0}” and {1} task run? The complete history can be restored from All runs.", runTabLabel(conversation), descendants)
            : localize("Archive “{0}” and {1} task runs? The complete history can be restored from All runs.", runTabLabel(conversation), descendants),
        confirmLabel: localize("Archive"),
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
      if (descendants === 0 && isPristineRunDraft(conversation)) {
        vscode.postMessage({ type: "conversation.close", conversationId: conversation.id });
        return;
      }
      openDialog({
        kind: "deleteRun",
        title: localize("Delete run permanently?"),
        message: descendants === 0
          ? localize("Permanently delete “{0}” and its local run metadata? This cannot be undone.", runTabLabel(conversation))
          : descendants === 1
            ? localize("Permanently delete “{0}” and {1} task run and their local run metadata? This cannot be undone.", runTabLabel(conversation), descendants)
            : localize("Permanently delete “{0}” and {1} task runs and their local run metadata? This cannot be undone.", runTabLabel(conversation), descendants),
        confirmLabel: localize("Delete permanently"),
        conversationId: conversation.id,
        danger: true,
      });
    }
  } else if (action === "rename-conversation") {
    const conversation = activeConversation();
    if (conversation) renameConversation(conversation);
  } else if (action === "orchestration-start") {
    if (orchestrationStartPending) return;
    orchestrationStartPending = true;
    announceStatus(localize("Starting TODO.md…"));
    scheduleRender();
    vscode.postMessage({ type: "orchestration.start" });
  } else if (action === "orchestration-resume") {
    vscode.postMessage({ type: "orchestration.resume" });
  } else if (action === "orchestration-stop") {
    openDialog({
      kind: "stopOrchestration",
      title: localize("Stop TODO run?"),
      message: localize("Active pairs and checks will be interrupted. Completed task histories and Git resources are retained for resume."),
      confirmLabel: localize("Stop run"),
    });
  } else if (action === "orchestration-abandon") {
    const orchestration = state.manager.orchestration;
    const details = [orchestration.integrationBranch, orchestration.integrationWorktree].filter(Boolean).join("\n");
    openDialog({
      kind: "abandonOrchestration",
      title: localize("Abandon TODO resources?"),
      message: details
        ? localize("Remove the extension-owned TODO branches and worktrees:\n{0}? Conversation histories are retained.", details)
        : localize("Remove the extension-owned TODO branches and worktrees? Conversation histories are retained."),
      confirmLabel: localize("Remove resources"),
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
    const format = target.dataset.format === "markdown" || target.dataset.format === "sarif" || target.dataset.format === "executionEvidence"
      ? target.dataset.format
      : "bundle";
    vscode.postMessage({
      type: "conversation.exportBundle",
      conversationId: target.dataset.conversation,
      format,
    });
  } else if (action === "result-details-toggle" && target.dataset.conversation) {
    const conversationId = target.dataset.conversation;
    if (conversationId !== activeId() || !state.manager.resultsByConversation?.[conversationId]) return;
    const open = !resultDetailsOpen(conversationId);
    state.disclosureStates.set(resultDetailsKey(conversationId), open);
    scheduleRender();
    focusAfterRender(() => root.querySelector<HTMLElement>('[data-action="result-details-toggle"]')?.focus());
  } else if (action === "result-copy" && target.dataset.conversation) {
    const conversationId = target.dataset.conversation;
    if (conversationId !== activeId() || !conversationById(conversationId)) {
      announceStatus(localize("This result is no longer selected. Open its run again."));
      return;
    }
    const text = copyableResultText(state.manager.resultsByConversation?.[conversationId]);
    if (!text) {
      announceStatus(localize("This run has no readable result to copy."));
      return;
    }
    void Promise.resolve().then(() => {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
      return navigator.clipboard.writeText(text);
    }).then(() => {
      target.textContent = localize("Copied");
      announceStatus(localize("Run result copied to the clipboard."));
      setTimeout(() => { target.textContent = localize("Copy result"); }, 1200);
    }, () => {
      announceStatus(localize("Copying the run result failed."));
    });
  } else if (action === "result-continue" && target.dataset.conversation) {
    const resultVersion = target.dataset.resultVersion ?? "";
    const refusal = resultContinuationRefusal(target.dataset.conversation, resultVersion);
    if (refusal) {
      announceStatus(refusal);
      return;
    }
    const result = state.manager.resultsByConversation[target.dataset.conversation];
    if (!result) {
      announceStatus(localize("This run has no result content to carry into implementation."));
      return;
    }
    const selected = resultContinuationSelection(target.dataset.conversation, result);
    vscode.postMessage({
      type: "conversation.continueFromResult",
      conversationId: target.dataset.conversation,
      resultVersion,
      ...((result.findings?.length ?? 0) > 0 ? { findingIds: Array.from(selected.findingIds) } : {}),
      ...(selected.pipelineId ? { pipelineId: selected.pipelineId } : {}),
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
      title: retry ? localize("Retry cleanup for {0}?", title) : localize("Clean up {0}?", title),
      message: branch
        ? localize("Remove the retained worktree and integration branch {0}? Conversation history remains available.", branch)
        : localize("Remove the retained worktree? Conversation history remains available."),
      confirmLabel: retry ? localize("Retry cleanup") : localize("Clean up Git resources"),
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
      { id: "initiative-title", value: title, message: localize("Give this initiative a title.") },
      { id: "initiative-goal", value: goal, message: localize("State the goal this initiative is working towards.") },
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
      { id: "initiative-direction", value: direction, message: localize("Write the direction you are accepting before recording it.") },
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
  } else if (action === "notification-settings") {
    openDialog({ kind: "notificationSettings", title: localize("Notifications"), message: "", confirmLabel: localize("Close") });
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
      title: localize("Merge this finding into another"),
      message: localize("Bachata folds later rounds of both findings into one history. Name the finding this one is the same defect as, and why."),
      confirmLabel: localize("Merge"),
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
      title: localize("Start a separate initiative"),
      message: localize("A new initiative keeps its own cycles, findings, decisions, and artifacts. The current one stays recorded."),
      confirmLabel: localize("Create"),
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
        title: resolution === "reopen" ? localize("Reopen with new evidence") : localize("Supersede with a replacement"),
        message: resolution === "reopen"
          ? localize("Bachata records why this was reopened and which material evidence changed. Both are required.")
          : localize("Bachata records the replacement this record is superseded by. The replacement must already exist in this initiative."),
        confirmLabel: resolution === "reopen" ? localize("Reopen") : localize("Supersede"),
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
  } else if (action === "direction-section-toggle" && target.dataset.section) {
    const key = `${activeId()}:${target.dataset.section}`;
    state.disclosureStates.set(key, !(state.disclosureStates.get(key) ?? false));
    scheduleRender();
  } else if (action === "room-view") {
    state.runDrawerOpen = false;
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
    if (target.dataset.focus !== "pending-decision") {
      focusAfterRender(() => {
        const content = root.querySelector<HTMLElement>(".conversation-scroll");
        if (content) {
          content.tabIndex = -1;
          content.focus();
        }
      });
    }
    if (target.dataset.focus === "pending-decision") {
      // "Review and continue" promised a decision; focus lands on it, not on the document body.
      focusAfterRender(() => {
        const decision = root.querySelector<HTMLElement>(".interaction-card, .decision-card, .approval-card");
        if (!decision) return;
        decision.tabIndex = -1;
        decision.scrollIntoView({ block: "start", behavior: conversationScrollBehavior() });
        decision.focus({ preventScroll: true });
      });
    }
  } else if (action === "jump-message") {
    const messageId = target.dataset.messageId;
    const content = root.querySelector<HTMLElement>(".conversation-scroll");
    const message = messageId ? content?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(messageId)}"]`) : null;
    if (message) revealConversationMessage(message);
  } else if (action === "jump-latest") {
    const content = root.querySelector<HTMLElement>(".conversation-scroll");
    if (content) {
      content.setAttribute("data-restoring", "");
      content.scrollTop = content.scrollHeight;
      content.removeAttribute("data-restoring");
      if (document.activeElement === target) {
        focusTransientControl(content);
      }
      rememberConversationScroll(content);
      refreshConversationNavigation();
    }
  } else if (action === "message-details") {
    const messageId = target.dataset.messageId;
    const panel = activePanel();
    const answerIndex = panel.transcript.findIndex((entry) => entry.id === messageId);
    const answer = answerIndex < 0 ? undefined : panel.transcript[answerIndex];
    const agentId = answer?.agentId ?? target.dataset.agent;
    const step = answer?.step ?? panel.activeStep;
    const prompt = agentId === undefined ? undefined : (answer ? panel.transcript.slice(0, answerIndex) : panel.transcript)
      .slice().reverse()
      .find((entry) => entry.kind === "prompt" && entry.agentId === agentId && (!step || entry.step === step));
    if (answer || agentId) {
      const agentName = agentId ? panel.agents[agentId]?.name ?? localize("Participant") : localize("Participant");
      openDialog({
        kind: "turnDetails",
        title: localize("{0} · prompt", agentName),
        message: prompt ? localize("Exact prompt used for this response.") : localize("No exact prompt was recorded for this response."),
        prompt: prompt?.text ?? "",
        ...(step ? { context: step } : {}),
        confirmLabel: localize("Close"),
      });
    }
  } else if (action === "inspector-toggle") {
    state.inspectorOpen = !state.inspectorOpen;
    scheduleRender();
    // Opened, the inspector is where the reader is going; closed, the control that opens it is
    // the nearest place to land. Either beats the document body.
    focusAfterRender(() => {
      (state.inspectorOpen
        ? document.getElementById("inspector-title")
        : root.querySelector<HTMLElement>(".header-action-menu > summary"))?.focus();
    });
  } else if (action === "composer-settings-toggle") {
    state.composerSettingsOpen = !state.composerSettingsOpen;
    focusAfterRender(() => {
      (state.composerSettingsOpen
        ? root.querySelector<HTMLElement>('[data-action="run-limit"][aria-checked="true"]')
        : root.querySelector<HTMLElement>(".composer-settings-button"))?.focus();
    });
  } else if (action === "pipeline-picker-toggle") {
    if (state.pipelinePickerOpen) closePipelinePicker();
    else openPipelinePicker();
  } else if (action === "pipeline-picker-filter" && target.dataset.pipelineFilter) {
    setPipelinePickerFilter(target.dataset.pipelineFilter);
  } else if (action === "pipeline-picker-new") {
    closePipelinePicker(false);
    openPipelineEditor(true);
  } else if (action === "pipeline-picker-select" && target.dataset.pipelineId) {
    const pipelineId = target.dataset.pipelineId;
    closePipelinePicker();
    selectPipeline(pipelineId);
  } else if (action === "pipeline-row-menu" && target.dataset.pipelineId) {
    const pipelineId = target.dataset.pipelineId;
    if (state.pipelineActionFor === pipelineId) delete state.pipelineActionFor;
    else state.pipelineActionFor = pipelineId;
    scheduleRender();
    focusAfterRender(() => root.querySelector<HTMLElement>(`[data-action="pipeline-row-menu"][data-pipeline-id="${CSS.escape(pipelineId)}"]`)?.focus());
  } else if (action?.startsWith("pipeline-row-") && target.dataset.pipelineId) {
    const pipeline = activePanel().pipelines.find((candidate) => candidate.id === target.dataset.pipelineId);
    if (!pipeline) return;
    closePipelinePicker(false);
    if (action === "pipeline-row-details") {
      openDialog({
        kind: "pipelineDetails",
        title: pipeline.name,
        message: "",
        confirmLabel: localize("Close"),
        pipeline,
      });
    } else if (action === "pipeline-row-edit" && pipeline.editable) {
      if (pipeline.id === activePanel().selectedPipelineId) openPipelineEditor(false);
      else selectPipeline(pipeline.id, "edit");
    } else if (action === "pipeline-row-fork") {
      startPipelineFork(pipeline.id);
    } else if (action === "pipeline-row-delete" && pipeline.editable) {
      openDialog({
        kind: "deletePipeline",
        title: localize("Delete {0}?", pipeline.name),
        message: localize("Remove the custom pipeline “{0}” ({1})? Existing run histories are retained.", pipeline.name, pipeline.id),
        confirmLabel: localize("Delete {0}", pipeline.name),
        pipelineId: pipeline.id,
        scopeKey: pipeline.scopeKey,
        expectedHash: pipeline.hash,
        danger: true,
      });
    }
  } else if (action === "agents-picker-toggle") {
    if (state.agentsPickerOpen) closeAgentsPicker();
    else openAgentsPicker();
  } else if (action === "recovery-change-model") {
    openAgentsPicker(target.dataset.agent);
  } else if (action === "agents-assign" && target.dataset.agent) {
    delete state.agentsBrowserFor;
    postRuntime({
      type: "agents.assign",
      agentId: target.dataset.agent,
      ...(target.dataset.adapter ? { adapter: target.dataset.adapter } : {}),
    });
  } else if (action === "agents-browser-toggle" && target.dataset.agent) {
    const agentId = target.dataset.agent;
    if (state.agentsBrowserFor === agentId) {
      delete state.agentsBrowserFor;
    } else {
      state.agentsBrowserFor = agentId;
      announceStatus(localize("Starting Browser Bridge discovery. Complete pairing in your browser if needed."));
      postRuntime({ type: "bridge.discover" });
    }
    scheduleRender();
  } else if (action === "agents-session" && target.dataset.agent && target.dataset.adapter) {
    postRuntime({
      type: "agents.assign",
      agentId: target.dataset.agent,
      adapter: target.dataset.adapter,
      ...(target.dataset.session ? { browserSessionId: target.dataset.session } : {}),
    });
  } else if (action === "agents-browser-new" && target.dataset.agent && target.dataset.adapter) {
    postRuntime({
      type: "agents.assign",
      agentId: target.dataset.agent,
      adapter: target.dataset.adapter,
    });
    closeAgentModelMenu();
  } else if (action === "agents-model-menu" && target.dataset.agent) {
    toggleAgentModelMenu(target.dataset.agent);
  } else if (action === "agents-model" && target.dataset.agent) {
    const conversationId = activeId();
    const agentId = target.dataset.agent;
    const slot = activePanel().agentAssignments.slots.find((candidate) => candidate.agentId === agentId);
    if (slot) {
      state.pendingAgentModels.set(pendingAgentModelKey(conversationId, agentId), {
        conversationId,
        agentId,
        adapter: slot.assignedAdapter,
        ...(target.dataset.model ? { model: target.dataset.model } : {}),
      });
    }
    // No model attribute means the reader chose the provider's own default, which clears theirs.
    postRuntime({
      type: "agents.model.select",
      agentId,
      ...(target.dataset.model ? { model: target.dataset.model } : {}),
    });
    closeAgentModelMenu();
  } else if (action === "agents-effort" && target.dataset.agent) {
    const agentId = target.dataset.agent;
    const effort = target.dataset.effort;
    postRuntime({ type: "agents.effort.select", agentId, ...(effort ? { reasoningEffort: effort } : {}) });
    focusAfterRender(() => document.getElementById(agentModelMenuId(agentId))
      ?.querySelector<HTMLElement>(effort ? `[data-action="agents-effort"][data-effort="${effort}"]` : ".agents-effort-reset")
      ?.focus());
  } else if (action === "run-limit" && target.dataset.iterations) {
    const count = Math.max(
      1,
      Math.min(state.manager.maxPipelineIterations, Math.trunc(Number(target.dataset.iterations) || 1)),
    );
    activeDraft().iterationCount = count;
    activeDraft().iterationMode = "fixed";
    activeDraft().requiredCleanPasses = 1;
    scheduleRender();
    focusAfterRender(() => root.querySelector<HTMLElement>(`[data-action="run-limit"][data-iterations="${String(count)}"]`)?.focus());
  } else if (action === "agents-bridge-toggle") {
    state.agentsBridgeOpen = state.agentsBridgeOpen !== true;
    scheduleRender();
    focusAfterRender(() => document.getElementById("agents-bridge-chip")?.focus());
  } else if (action === "agents-model-discover" && target.dataset.agent) {
    postRuntime({ type: "agents.model.discover", agentId: target.dataset.agent });
  } else if (action === "agents-model-search-toggle" && target.dataset.agent) {
    const agentId = target.dataset.agent;
    state.agentsModelDrafts[agentId] = "";
    state.agentsModelActive = 0;
    scheduleRender();
    focusAgentModelMenu(agentId);
  } else if (action === "local-model-select" && target.dataset.consumer) {
    postRuntime({
      type: "localModel.select",
      consumer: target.dataset.consumer,
      ...(target.dataset.model ? { model: target.dataset.model } : {}),
    });
  } else if (action === "local-model-enable" && target.dataset.consumer) {
    postRuntime({
      type: "localModel.enable",
      consumer: target.dataset.consumer,
      enabled: target.dataset.enabled === "true",
    });
  } else if (action === "availability-check") {
    if (!agentsAssignable(activePanel())) {
      announceStatus(localize("Select a pipeline with participants to check providers."));
      return;
    }
    state.roomView = "chat";
    state.inspectorOpen = false;
    state.composerSettingsOpen = false;
    state.pipelinePickerOpen = false;
    state.pipelinePickerQuery = "";
    state.agentsPickerOpen = true;
    announceStatus(localize("Checking providers…"));
    postRuntime({ type: "availability.check" });
    scheduleRender();
    focusAfterRender(() => document.getElementById("agents-picker-button")?.focus());
  }
  else if (action === "working-directory") postRuntime({ type: "workingDirectory.pick" });
  else if (action === "task-reset") openDialog({
    kind: "resetTask",
    title: localize("Reset run state?"),
    message: localize("Reset this run’s local-agent sessions, attachments, queue, and recoverable pipeline? Bound browser conversations remain connected."),
    confirmLabel: localize("Reset run"),
    danger: true,
  });
  else if (action === "transcript-export") postRuntime({ type: "transcript.export" });
  else if (action === "browser-asset-save" && target.dataset.assetId) postRuntime({ type: "browser.asset.save", assetId: target.dataset.assetId });
  else if (action === "browser-asset-reveal" && target.dataset.assetId) postRuntime({ type: "browser.asset.reveal", assetId: target.dataset.assetId });
  else if (action === "bridge-copy-token") {
    const bridge = activePanel().browserBridge;
    const token = bridge.pairingToken;
    if (token !== undefined) {
      void navigator.clipboard.writeText(bridgePairingCode(bridge.endpoint, token)).then(() => {
        target.textContent = localize("Copied");
        announceStatus(localize("Pairing code copied. Use Paste & connect in the Bridge popup."));
        setTimeout(() => { target.textContent = localize("Copy code"); }, 1200);
      }, () => {
        announceStatus(localize("Copying the pairing code failed."));
      });
    }
  } else if (action === "bridge-discover") postRuntime({ type: "bridge.discover" });
  else if (action === "bridge-reset") openDialog({
    kind: "resetBridge",
    title: localize("Reset pairing?"),
    message: localize("Replace the pairing token and disconnect the paired browser? Pair your browser again with the new token."),
    confirmLabel: localize("Reset pairing"),
    danger: true,
  });
  else if (action === "session-reset") postRuntime({ type: "session.reset", agentId: target.dataset.agent });
  else if (action === "load-older") postRuntime({ type: "transcript.loadOlder", beforeId: activePanel().transcript[0]?.id });
  else if (action === "attachment-pick") {
    const input = document.getElementById("attachment-input");
    if (input instanceof HTMLInputElement) {
      const conversationId = activeId();
      input.onchange = (changeEvent) => {
        changeEvent.stopPropagation();
        const files = input.files;
        if (files && files.length > 0) void addFiles(files, conversationId);
        input.value = "";
      };
      input.click();
    }
  }
  else if (action === "attachment-remove" && target.dataset.attachmentId) {
    event.preventDefault();
    event.stopPropagation();
    postRuntime({ type: "attachment.remove", attachmentId: target.dataset.attachmentId });
  } else if (action === "submit-message") submitMessage();
  else if (action === "interrupt-run") {
    if (pendingInterrupts.has(activeId())) return;
    pendingInterrupts.add(activeId());
    target.setAttribute("disabled", "");
    announceStatus(localize("Stopping…"));
    postRuntime({ type: "run.interrupt" });
    scheduleRender();
  }
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
    announceStatus(localize("Answer submitted. The run continues when the runtime accepts it."));
    requestAnimationFrame(() => document.getElementById(`interaction-${interactionRef}`)?.focus());
  } else if (action === "gate") {
    const gateAction = target.dataset.gateAction as HumanGateAction;
    const rollback = document.getElementById("rollback-target") as HTMLSelectElement | null;
    const rationale = (document.getElementById("gate-rationale") as HTMLTextAreaElement | null)?.value.trim();
    postRuntime({
      type: "run.gate",
      action: gateAction,
      ...(gateAction === "rollback" && rollback?.value ? { targetStepId: rollback.value } : {}),
      ...(gateAction === "acceptParticipant" && target.dataset.participant ? { selectedParticipant: target.dataset.participant } : {}),
      ...(rationale ? gateAction === "retry" ? { reviewInstructions: rationale } : { rationale } : {}),
    });
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
      announceStatus(localize("Approval submitted. The run continues when the runtime accepts it."));
      requestAnimationFrame(() => document.getElementById(`approval-${key}`)?.focus());
    }
  } else if (action === "focus-agent-output" && target.dataset.agent) {
    const agentId = target.dataset.agent;
    const messageId = target.dataset.messageId;
    state.roomView = "chat";
    scheduleRender();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const content = root.querySelector<HTMLElement>(".conversation-scroll");
        const outputs = Array.from(content?.querySelectorAll<HTMLElement>(".message-row[data-agent-id]") ?? [])
          .filter((element) => element.dataset.agentId === agentId);
        const output = messageId ? content?.querySelector<HTMLElement>(`[data-entry="${CSS.escape(messageId)}"]`) : outputs.at(-1);
        if (output) {
          revealConversationMessage(output);
        } else {
          announceStatus(localize("No transcript output is available for that participant."));
        }
      });
    });
  } else if (action === "queue-cancel" && target.dataset.messageId) postRuntime({ type: "queue.cancel", messageId: target.dataset.messageId });
  else if (action === "queue-resume") postRuntime({ type: "queue.resume" });
  else if (action === "workflow-resume") postRuntime({ type: "workflow.resume" });
  else if (action === "workflow-restart") postRuntime({ type: "workflow.restart" });
  else if (action === "workflow-discard") openDialog({
    kind: "discardWorkflow",
    title: localize("Discard the recovery checkpoint?"),
    message: localize("The recoverable pipeline and its checkpoint will be removed. The run's transcript is kept, but the pipeline cannot be resumed from where it stopped."),
    confirmLabel: localize("Discard checkpoint"),
    danger: true,
  });
  else if (action === "copy-code" && target.dataset.codeId) {
    const code = codeBlocks.get(target.dataset.codeId);
    if (code !== undefined) {
      void navigator.clipboard.writeText(code).then(() => {
        target.textContent = localize("Copied");
        announceStatus(localize("Code copied to the clipboard."));
        setTimeout(() => { target.textContent = localize("Copy"); }, 1200);
      }, () => {
        announceStatus(localize("Copying to the clipboard failed."));
      });
    }
  } else if (action === "pipeline-view") {
    const pipeline = activePanel().selectedPipelineDefinition;
    if (pipeline) openDialog({
      kind: "turnDetails",
      title: pipeline.name,
      message: "",
      prompt: pipeline.steps.filter((step) => step.enabled).map((step, index) =>
        `## ${String(index + 1)}. ${step.name}${"promptTemplate" in step ? `\n\n${step.promptTemplate}` : ""}`,
      ).join("\n\n"),
      confirmLabel: localize("Close"),
    });
  } else if (action === "pipeline-editor-close") {
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
        title: localize("Replace unsaved pipeline?"),
        message: localize("Replace the current draft with an imported pipeline? The imported pipeline is not saved until you choose Save and select."),
        confirmLabel: localize("Replace draft"),
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
      state.editorErrors = [localize("The pipeline storage scope is unavailable. Reopen the editor before saving.")];
      scheduleRender();
      return;
    }
    if (sourcePipelineId) {
      if (!expectedHash) {
        delete state.pendingEditorOperation;
        state.editorErrors = [localize("The pipeline revision is unavailable. Reopen the editor before saving.")];
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
    announceStatus(localize("Saving the pipeline. The editor closes when the save is accepted."));
    requestAnimationFrame(() => document.getElementById("pipeline-editor-title")?.focus());
  } else if (action === "pipeline-delete") {
    const pipelineId = state.editorSourcePipelineId;
    const pipelineName = state.editorSourcePipelineName ?? pipelineId;
    const expectedHash = state.editorSourcePipelineHash;
    const scopeKey = state.editorPipelineScopeKey;
    if (pipelineId && expectedHash && scopeKey) {
      openDialog({
        kind: "deletePipeline",
        title: localize("Delete {0}?", pipelineName ?? pipelineId),
        message: localize("Remove the custom pipeline “{0}” ({1})? Existing run histories are retained.", pipelineName ?? pipelineId, pipelineId),
        confirmLabel: localize("Delete {0}", pipelineName ?? pipelineId),
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
  if (target.id === "app-dialog-input" && state.dialog && "inputValue" in state.dialog) {
    state.dialog.inputValue = target.value;
    return;
  }
  if (target.id === "app-dialog-delta" && state.dialog && "deltaValue" in state.dialog) {
    state.dialog.deltaValue = target.value;
    return;
  }
  if (target.id === "gate-rationale") {
    rememberGateDraft(activeId(), activePanel(), target.value);
    return;
  }
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
  if (target.id === "pipeline-picker-search") {
    setPipelinePickerQuery(target.value);
    return;
  }
  if (target.id === "composer-prompt") {
    const wasEmpty = activeDraft().prompt.trim().length === 0;
    activeDraft().prompt = target.value;
    if (target.value.trim().length === 0) discardPreparedDraft(activeId());
    else scheduleDraftSave(activeId(), target.value);
    refreshComposerSubmitState();
    if (wasEmpty !== (target.value.trim().length === 0)) scheduleRender();
  } else if (target.id === "run-search") {
    state.roomSearch = target.value;
    queueHistorySearch();
    scheduleRender();
  } else if (target.dataset.agentsModelFor) {
    setAgentModelDraft(target.dataset.agentsModelFor, target.value);
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
  if (target.id === "execution-context-mode" && target instanceof HTMLInputElement) {
    setExecutionContext(target.checked);
    target.checked = executionContextControl(activePanel(), draftFor(activeId())).checked;
    return;
  }
  if (declineDisabledControl(target)) return;
  if (handleAgentSelectionChange(target)) return;
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
  if ((target.dataset.action === "result-finding-select" || target.dataset.action === "result-pipeline-select") && target.dataset.conversation) {
    const conversationId = target.dataset.conversation;
    const refusal = resultSelectionRefusal(conversationId, target.dataset.resultVersion ?? "");
    if (refusal) {
      announceStatus(refusal);
      scheduleRender();
      return;
    }
    const result = state.manager.resultsByConversation[conversationId];
    if (!result) {
      announceStatus(localize("This run has no result content to carry into implementation."));
      return;
    }
    const selected = resultContinuationSelection(conversationId, result);
    if (target.dataset.action === "result-finding-select" && target instanceof HTMLInputElement) {
      const finding = result.findings?.find((entry) => entry.id === target.dataset.findingId);
      if (!finding || finding.disposition === "rejected") {
        announceStatus(localize("This finding is not available for implementation."));
        return;
      }
      if (target.checked) selected.findingIds.add(finding.id);
      else selected.findingIds.delete(finding.id);
      selected.stale = false;
    } else if (target.dataset.action === "result-pipeline-select" && target instanceof HTMLSelectElement) {
      if (!result.continuation?.pipelines?.some((pipeline) => pipeline.id === target.value)) {
        announceStatus(localize("Choose an available write-capable pipeline for these findings."));
        return;
      }
      selected.pipelineId = target.value;
    }
    scheduleRender();
    return;
  }
  if (target.id === "app-dialog-input" && state.dialog && "inputValue" in state.dialog) {
    state.dialog.inputValue = target.value;
    clearFieldError(target.id);
    return;
  }
  if (
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
    scheduleRender();
  } else if (target.dataset.action === "browser-session" && target.dataset.agent) {
    if (runConfigurationLocked(activePanel())) {
      announceStatus(localize("Finish the active operation before changing run configuration."));
      scheduleRender();
      return;
    }
    postRuntime({ type: "browser.session.select", agentId: target.dataset.agent, sessionId: target.value || undefined });
  } else if (target.dataset.editorMeta !== undefined || target.dataset.editorPolicy !== undefined || target.dataset.editorAgent !== undefined || target.dataset.editorRole !== undefined || target.dataset.editorStep !== undefined) {
    updateEditorInput(target);
  }
});
};
