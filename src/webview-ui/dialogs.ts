/**
 * Dialog rendering and submission.
 *
 * Concatenated after the editor, since a dialog can confirm an editor operation. Focus
 * restoration stays with the dialog that took focus.
 */

const dialogReturnFocusSelector = (): string | undefined =>
  bachataWebviewBehavior.focusReturnSelector(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );

const restoreDialogFocus = (selector: string | undefined): void => {
  focusAfterRender(() => {
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
    // A dialog returns to its trigger. Reopen its menu first so that trigger is reachable.
    const collapsed = target?.closest<HTMLDetailsElement>("details:not([open])") ?? null;
    if (collapsed) {
      collapsed.open = true;
      if (collapsed.dataset.disclosureKey) state.disclosureStates.set(collapsed.dataset.disclosureKey, true);
      const summary = collapsed.querySelector<HTMLElement>("summary");
      if (summary) positionRunMenu(summary);
    }
    (target
      ?? (layer ? reachableControls(layer)[0] : undefined)
      // The pipeline edit control lives inside the settings panel and may be closed; the settings
      // control that opens it is always in the composer, so it is the stable landing place.
      ?? root.querySelector<HTMLElement>('[data-action="composer-settings-toggle"]')
      ?? document.getElementById("composer-prompt")
      ?? root.querySelector<HTMLElement>('[data-action="run-drawer-toggle"]'))?.focus();
  });
};

const isCloseOnlyDialog = (dialog: AppDialog): boolean =>
  ["turnDetails", "notificationSettings", "runRequirements"].includes(dialog.kind);

const openRunRequirements = (conversationId = activeId()): void => {
  openDialog({ kind: "runRequirements", conversationId, title: localize("Run requirements"), message: "", confirmLabel: localize("Close") });
};

const explainSendRequirements = (conversationId: string, blockers: SendBlocker[]): void => {
  announceStatus(sendRequirementsDescription(blockers));
  if (blockers.length === 1 && blockers[0]?.quiet && !draftFor(conversationId).prompt.trim()) {
    document.getElementById("composer-prompt")?.focus();
    return;
  }
  openRunRequirements(conversationId);
};

const openDialog = (dialog: AppDialog): void => {
  const returnFocusSelector = dialogReturnFocusSelector();
  setOptionalProperty(state, "dialogReturnFocusSelector", returnFocusSelector);
  state.dialog = dialog;
  scheduleRender();
  focusAfterRender(() => {
    const input = document.getElementById("app-dialog-input");
    const confirm = root.querySelector<HTMLButtonElement>('[data-action="dialog-confirm"]');
    const cancel = root.querySelector<HTMLButtonElement>('[data-dialog-default="cancel"]');
    const danger = "danger" in dialog && dialog.danger;
    const initialFocus = bachataWebviewBehavior.dialogInitialFocus(Boolean(input), danger);
    (isCloseOnlyDialog(dialog) ? cancel : initialFocus === "input" ? input : initialFocus === "cancel" ? cancel : confirm)?.focus();
    if (input instanceof HTMLInputElement) input.select();
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


const appDialogHtml = (): string => {
  const dialog = state.dialog;
  if (!dialog) {
    return "";
  }
  const recordOptions = dialog.kind === "mergeFinding"
    ? directionMergeOptions(dialog.absorbedIdentity)
    : dialog.kind === "resolveRecord" && dialog.mode === "supersede"
      ? directionRecordOptions(dialog.target, dialog.recordId)
      : [];
  const recordSelect = `<select id="app-dialog-input"${recordOptions.length === 0 ? " disabled" : ""}><option value="">${escapeHtml(recordOptions.length === 0 ? localize("No eligible records") : localize("Choose a record"))}</option>${recordOptions.map((item) => `<option value="${escapeAttribute(item.id)}"${"inputValue" in dialog && dialog.inputValue === item.id ? " selected" : ""}>${escapeHtml(item.label)}</option>`).join("")}</select>`;
  const input = dialog.kind === "renameRun"
    ? `<label class="field"><span>${escapeHtml(localize("Run title"))}</span><input id="app-dialog-input" value="${escapeAttribute(dialog.inputValue)}" maxlength="200"></label>`
    : dialog.kind === "resolveRecord"
      ? dialog.mode === "reopen"
        ? `<label class="field"><span>${escapeHtml(localize("Reason"))}</span><input id="app-dialog-input" value="${escapeAttribute(dialog.inputValue)}" maxlength="2000"></label><label class="field"><span>${escapeHtml(localize("Material evidence delta (one per line)"))}</span><textarea id="app-dialog-delta" rows="3">${escapeHtml(dialog.deltaValue ?? "")}</textarea></label>`
        : `<label class="field"><span>${escapeHtml(localize("Replacement"))}</span>${recordSelect}</label><label class="field"><span>${escapeHtml(localize("Reason (optional)"))}</span><textarea id="app-dialog-delta" rows="2">${escapeHtml(dialog.deltaValue ?? "")}</textarea></label>`
      : dialog.kind === "createInitiative"
        ? `<label class="field"><span>${escapeHtml(localize("Title"))}</span><input id="app-dialog-input" value="${escapeAttribute(dialog.inputValue)}" maxlength="200"></label><label class="field"><span>${escapeHtml(localize("Goal"))}</span><textarea id="app-dialog-delta" rows="2">${escapeHtml(dialog.deltaValue ?? "")}</textarea></label>`
      : dialog.kind === "mergeFinding"
        ? `<label class="field"><span>${escapeHtml(localize("Finding to keep"))}</span>${recordSelect}</label><label class="field"><span>${escapeHtml(localize("Why are these the same defect?"))}</span><textarea id="app-dialog-delta" rows="2">${escapeHtml(dialog.deltaValue ?? "")}</textarea></label>`
        : "";
  const turnDetails = dialog.kind === "turnDetails"
    ? `<div class="turn-details">${dialog.context ? `<p class="muted">${escapeHtml(dialog.context)}</p>` : ""}<div class="markdown">${renderMarkdown(dialog.prompt)}</div></div>`
    : "";
  const notificationSettings = dialog.kind === "notificationSettings" ? notificationModeControlHtml() : "";
  const requirements = dialog.kind === "runRequirements" ? runRequirementsHtml(dialog.conversationId) : "";
  const closeOnly = isCloseOnlyDialog(dialog);
  const unavailable = (dialog.kind === "mergeFinding" || dialog.kind === "resolveRecord" && dialog.mode === "supersede") && recordOptions.length === 0;
  const danger = "danger" in dialog && dialog.danger;
  // A refusal is held in the store and drawn from it, so a background render puts it back
  // instead of erasing it along with the flag on the field.
  const refusal = state.fieldErrors.get("app-dialog-input") ?? state.fieldErrors.get("app-dialog-delta") ?? "";
  const refusedField = state.fieldErrors.has("app-dialog-input") ? "app-dialog-input" : state.fieldErrors.has("app-dialog-delta") ? "app-dialog-delta" : undefined;
  const marked = refusedField === undefined
    ? input
    : input.replace(`id="${refusedField}"`, `id="${refusedField}" aria-invalid="true" aria-describedby="app-dialog-error"`);
  return `<div class="modal-backdrop app-dialog-backdrop" data-action="dialog-backdrop"><section class="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title"${dialog.message ? ' aria-describedby="app-dialog-message"' : ""}><header><h2 id="app-dialog-title">${escapeHtml(dialog.title)}</h2><button class="icon-button" data-action="dialog-cancel" aria-label="${escapeAttribute(localize("Close dialog"))}">×</button></header>${dialog.message ? `<p id="app-dialog-message">${escapeHtml(dialog.message)}</p>` : ""}${turnDetails}${notificationSettings}${requirements}${marked}<div class="error" id="app-dialog-error" role="alert">${escapeHtml(refusal)}</div><footer>${closeOnly ? `<button class="primary" data-action="dialog-cancel" data-dialog-default="cancel">${escapeHtml(localize("Close"))}</button>` : `<button data-action="dialog-cancel" data-dialog-default="cancel">${escapeHtml(localize("Cancel"))}</button><button class="${danger ? "danger" : "primary"}" data-action="dialog-confirm"${unavailable ? " disabled" : ""}>${escapeHtml(dialog.confirmLabel)}</button>`}</footer></section></div>`;
};

type ControlSnapshot = {
  id?: string;
  selector?: string;
  editorKind?: "meta" | "agent" | "role" | "step";
  editorIndex?: string;
  field?: string;
  selectionStart?: number | null;
  selectionEnd?: number | null;
  selectionDirection?: "forward" | "backward" | "none" | null;
  transientFocus?: boolean;
  scrollKey?: string;
  scrollTop: number;
  scrollLeft: number;
};

let composing = false;
let pointerActivationPending = false;
let deferredRender = false;
let transientFocusControl: HTMLElement | undefined;

const focusTransientControl = (element: HTMLElement): void => {
  if (!element.hasAttribute("tabindex")) {
    element.setAttribute("tabindex", "-1");
    element.dataset.transientFocus = "true";
  }
  element.focus({ preventScroll: true });
  if (element.dataset.transientFocus === "true") transientFocusControl = element;
};

document.addEventListener("focusin", (event) => {
  if (!transientFocusControl || transientFocusControl === event.target) return;
  transientFocusControl.removeAttribute("tabindex");
  delete transientFocusControl.dataset.transientFocus;
  transientFocusControl = undefined;
});

let editorScrollSession = 0;
let dialogScrollSequence = 0;
const dialogScrollIdentities = new WeakMap<AppDialog, number>();
const surfaceScrollPositions = new Map<string, { top: number; left: number }>();

const scrollSurfaceKeys = (): Array<{ selector: string; key: string }> => {
  const dialog = state.dialog;
  if (dialog && !dialogScrollIdentities.has(dialog)) dialogScrollIdentities.set(dialog, ++dialogScrollSequence);
  const dialogKey = dialog ? String(dialogScrollIdentities.get(dialog)) : "";
  const panel = activePanel();
  return [
    { selector: ".app-dialog", key: `dialog:${dialogKey}` },
    { selector: ".turn-details", key: `prompt:${dialogKey}` },
    { selector: ".run-drawer-list", key: JSON.stringify(["runs", state.roomSearch.trim().toLowerCase(), state.showArchived]) },
    { selector: ".agents-popover", key: JSON.stringify(["agents", activeId(), panel.pipelineScopeKey, panel.selectedPipelineId]) },
    { selector: ".composer-settings", key: JSON.stringify(["run-settings", activeId(), panel.pipelineScopeKey, panel.selectedPipelineId]) },
    { selector: ".pipeline-picker-list", key: JSON.stringify(["pipelines", activeId(), panel.pipelineScopeKey, panel.selectedPipelineId, state.pipelinePickerFilter, state.pipelinePickerQuery]) },
    { selector: ".editor-scroll", key: JSON.stringify(["editor", editorTargetId(), editorScrollSession, state.editorMode]) },
  ];
};

const captureDialogScroll = (): Array<{ key: string; top: number; left: number }> =>
  scrollSurfaceKeys().flatMap(({ selector }) => {
    const element = root.querySelector<HTMLElement>(selector);
    const key = element?.dataset.surfaceScrollKey;
    return element && key ? [{ key, top: element.scrollTop, left: element.scrollLeft }] : [];
  });

const restoreDialogScroll = (positions: ReturnType<typeof captureDialogScroll>): void => {
  positions.forEach(({ key, top, left }) => {
    surfaceScrollPositions.delete(key);
    surfaceScrollPositions.set(key, { top, left });
  });
  while (surfaceScrollPositions.size > 48) {
    const oldest = surfaceScrollPositions.keys().next().value;
    if (oldest === undefined) break;
    surfaceScrollPositions.delete(oldest);
  }
  scrollSurfaceKeys().forEach(({ selector, key }) => {
    const element = root.querySelector<HTMLElement>(selector);
    if (!element) return;
    element.dataset.surfaceScrollKey = key;
    const position = surfaceScrollPositions.get(key);
    if (position) {
      element.scrollTop = position.top;
      element.scrollLeft = position.left;
      element.dataset.scrollRestored = "true";
    }
  });
};

/**
 * Where the keyboard was, so a host message does not take it.
 *
 * render() replaces the whole tree, so a focused button, tab or disclosure lands on the body
 * unless it is found again afterwards. Any element the dialog return path can address by
 * selector is worth restoring, not only the three text controls that also carry a selection.
 */
const captureControl = (): ControlSnapshot | undefined => {
  const element = document.activeElement;
  if (!(element instanceof HTMLElement)) {
    return undefined;
  }
  const snapshot: ControlSnapshot = {
    ...(element.id ? { id: element.id } : {}),
    scrollTop: element.scrollTop,
    scrollLeft: element.scrollLeft,
  };
  setOptionalProperty(snapshot, "selector", bachataWebviewBehavior.focusReturnSelector(element));
  if (element.dataset.transientFocus === "true") snapshot.transientFocus = true;
  setOptionalProperty(snapshot, "scrollKey", element.closest<HTMLElement>(".conversation-scroll")?.dataset.scrollKey);
  const editorAttributes = ["meta", "agent", "role", "step"] as const;
  for (const kind of editorAttributes) {
    const index = element.dataset[`editor${kind.slice(0, 1).toUpperCase()}${kind.slice(1)}`];
    if (index !== undefined) {
      snapshot.editorKind = kind;
      snapshot.editorIndex = index;
      setOptionalProperty(snapshot, "field", element.dataset.field);
      break;
    }
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    snapshot.selectionStart = element.selectionStart;
    snapshot.selectionEnd = element.selectionEnd;
    snapshot.selectionDirection = element.selectionDirection;
  }
  return snapshot.id === undefined && snapshot.selector === undefined && snapshot.editorKind === undefined
    ? undefined
    : snapshot;
};

const findControl = (snapshot: ControlSnapshot): HTMLElement | undefined => {
  if (snapshot.id) {
    const byId = document.getElementById(snapshot.id);
    if (byId instanceof HTMLElement) {
      return byId;
    }
  }
  if (snapshot.selector) {
    const bySelector = root.querySelector<HTMLElement>(snapshot.selector);
    if (bySelector) {
      return bySelector;
    }
  }
  if (!snapshot.editorKind) {
    return undefined;
  }
  const attribute = `editor${snapshot.editorKind.slice(0, 1).toUpperCase()}${snapshot.editorKind.slice(1)}`;
  return Array.from(root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))
    .find((element) => element.dataset[attribute] === snapshot.editorIndex && element.dataset.field === snapshot.field);
};

const focusableControlSelector =
  "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, a[href], [tabindex]:not([tabindex='-1'])";

/**
 * The controls a Tab can actually reach.
 *
 * A run row ends in a collapsed action menu, so the last match of the selector above is a button
 * hidden inside a closed <details>. Counting it meant Tab never recognised the end of the modal
 * and focus escaped it.
 */
const reachableControls = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(focusableControlSelector)).filter((control) => {
    if (control.closest("[hidden], [inert]")) return false;
    const collapsed = control.closest("details:not([open])");
    return collapsed === null || (control.tagName === "SUMMARY" && control.parentElement === collapsed);
  });

/**
 * `openPopover` names the popover the reader is inside, when one is open.
 *
 * A render is not evidence that focus moved. Restoring the control that held focus before the
 * tree was replaced sends focus outside an open popover, and focus leaving a popover is exactly
 * what dismisses it, so the popover a person just opened closed itself in the next frame. The
 * popover owns focus while it is open and puts it on its own trigger.
 */
const restoreControl = (snapshot: ControlSnapshot | undefined, openPopover?: string): void => {
  if (!snapshot) {
    return;
  }
  const element = findControl(snapshot);
  if (!element) {
    return;
  }
  if (openPopover !== undefined && element.closest(openPopover) === null) {
    return;
  }
  if (snapshot.scrollKey !== undefined && element.closest<HTMLElement>(".conversation-scroll")?.dataset.scrollKey !== snapshot.scrollKey) {
    return;
  }
  // The render restores every scroll container deliberately just before this runs. A plain focus()
  // scrolls the control back into view and undoes that: a reader who had pressed anything inside
  // the transcript lost the live edge on every appended message, smoothly, because the pane
  // scrolls with `scroll-behavior: smooth`.
  if (snapshot.transientFocus) focusTransientControl(element);
  else element.focus({ preventScroll: true });
  if (!element.matches(".conversation-scroll")) {
    element.scrollTop = snapshot.scrollTop;
    element.scrollLeft = snapshot.scrollLeft;
  }
  if (
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
    snapshot.selectionStart !== undefined &&
    snapshot.selectionEnd !== undefined
  ) {
    try {
      element.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection ?? undefined);
    } catch {
      return;
    }
  }
};

const discardCodeBlocks = (container: ParentNode): void => {
  container.querySelectorAll<HTMLElement>("[data-code-id]").forEach((button) => {
    if (button.dataset.codeId) {
      codeBlocks.delete(button.dataset.codeId);
    }
  });
};

const updateLiveAgentOutput = (conversationId: string, agentId: string): boolean => {
  if (conversationId !== activeId()) {
    return false;
  }
  const output = Array.from(root.querySelectorAll<HTMLElement>("[data-live-agent-output]"))
    .find((element) => element.dataset.liveAgentOutput === agentId);
  const agent = state.panels.get(conversationId)?.agents[agentId];
  if (!output || !agent || agent.status !== "running") {
    return false;
  }
  const scroll = document.getElementById("conversation-scroll");
  const wasFollowing = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 90 : false;
  const codeBlockScroll = captureCodeBlockScroll();
  discardCodeBlocks(output);
  output.innerHTML = renderMarkdown(agent.output || "…");
  settleCodeBlockFocus();
  restoreCodeBlockScroll(codeBlockScroll);
  if (scroll && wasFollowing) {
    scroll.setAttribute("data-restoring", "");
    scroll.scrollTop = scroll.scrollHeight;
    scroll.removeAttribute("data-restoring");
  }
  refreshConversationNavigation();
  return true;
};

let composerAutofocusKey: string | undefined;
let revealedTabKey: string | undefined;

// F19. The strip fades at whichever edge it continues past, so a cut-off tab reads as
// "more this way" rather than as a broken tab.
const updateTabStripEdges = (): void => {
  const strip = root.querySelector<HTMLElement>(".run-tabs-strip");
  const scroll = strip?.querySelector<HTMLElement>(".run-tabs-scroll");
  if (!strip || !scroll) return;
  const start = scroll.scrollLeft > 1;
  const end = scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 1;
  if (start) strip.setAttribute("data-scroll-start", ""); else strip.removeAttribute("data-scroll-start");
  if (end) strip.setAttribute("data-scroll-end", ""); else strip.removeAttribute("data-scroll-end");
};

const revealSelectedTab = (): void => {
  const key = activeId();
  if (!key || revealedTabKey === key) {
    return;
  }
  revealedTabKey = key;
  root.querySelector<HTMLElement>(".run-tab.selected")?.scrollIntoView({ block: "nearest", inline: "nearest" });
};

const focusEmptyComposer = (restored: boolean): void => {
  if (restored || state.dialog || state.editorOpen || state.runDrawerOpen) {
    return;
  }
  const key = activeId();
  if (!key || composerAutofocusKey === key) {
    return;
  }
  const panel = state.panels.get(key);
  if (!panel || panel.transcript.length > 0) {
    return;
  }
  const textarea = document.getElementById("composer-prompt");
  if (!(textarea instanceof HTMLTextAreaElement) || textarea.value.length > 0) {
    return;
  }
  composerAutofocusKey = key;
  textarea.focus();
};

/**
 * Why the dialog refused, said where the reader is looking.
 *
 * A field marked invalid with no message is a control that appears to do nothing. The text is
 * written into the dialog's alert slot rather than through a render, because the values the
 * reader has typed are held by the live controls and a re-render would discard them.
 */
const rejectDialog = (field: "app-dialog-input" | "app-dialog-delta", message: string): void => {
  (["app-dialog-input", "app-dialog-delta"] as const).forEach((id) => {
    document.getElementById(id)?.setAttribute("aria-invalid", id === field ? "true" : "false");
    if (id === field) state.fieldErrors.set(id, message);
    else state.fieldErrors.delete(id);
  });
  const target = document.getElementById(field);
  target?.setAttribute("aria-describedby", "app-dialog-error");
  const slot = document.getElementById("app-dialog-error");
  if (slot) {
    slot.textContent = message;
  }
  target?.focus();
};

const confirmDialog = (): void => {
  const dialog = state.dialog;
  if (!dialog) {
    return;
  }
  if (dialog.kind === "renameRun") {
    const input = document.getElementById("app-dialog-input") as HTMLInputElement | null;
    const title = input?.value.trim() ?? "";
    if (!title) {
      rejectDialog("app-dialog-input", localize("Enter a title for this run."));
      return;
    }
    closeDialog();
    vscode.postMessage({ type: "conversation.rename", conversationId: dialog.conversationId, title });
    return;
  }
  if (dialog.kind === "createInitiative") {
    const input = document.getElementById("app-dialog-input") as HTMLInputElement | null;
    const extra = document.getElementById("app-dialog-delta") as HTMLTextAreaElement | null;
    const title = input?.value.trim() ?? "";
    const goal = (extra?.value ?? "").trim();
    if (!title) {
      rejectDialog("app-dialog-input", localize("Enter a title for this initiative."));
      return;
    }
    if (!goal) {
      rejectDialog("app-dialog-delta", localize("State what this initiative has to achieve."));
      return;
    }
    closeDialog();
    vscode.postMessage({ type: "initiative.create", title, goal });
    return;
  }
  if (dialog.kind === "mergeFinding") {
    const input = document.getElementById("app-dialog-input") as HTMLSelectElement | null;
    const extra = document.getElementById("app-dialog-delta") as HTMLTextAreaElement | null;
    const canonicalIdentity = input?.value.trim() ?? "";
    const reason = (extra?.value ?? "").trim();
    if (!directionMergeOptions(dialog.absorbedIdentity).some((item) => item.id === canonicalIdentity)) {
      rejectDialog("app-dialog-input", localize("Choose an available finding to keep."));
      return;
    }
    if (canonicalIdentity === dialog.absorbedIdentity) {
      rejectDialog("app-dialog-input", localize("Merge into a different finding: this is the finding being merged."));
      return;
    }
    if (!reason) {
      rejectDialog("app-dialog-delta", localize("Say why these two findings are the same defect."));
      return;
    }
    closeDialog();
    vscode.postMessage({
      type: "finding.merge",
      absorbedIdentity: dialog.absorbedIdentity,
      canonicalIdentity,
      reason,
    });
    return;
  }
  if (dialog.kind === "resolveRecord") {
    const input = document.getElementById("app-dialog-input") as HTMLInputElement | HTMLSelectElement | null;
    const extra = document.getElementById("app-dialog-delta") as HTMLTextAreaElement | null;
    const primary = input?.value.trim() ?? "";
    const secondary = (extra?.value ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (!primary) {
      rejectDialog(
        "app-dialog-input",
        dialog.mode === "reopen"
          ? localize("Give a reason for reopening this record.")
          : localize("Choose the record that replaces this one."),
      );
      return;
    }
    if (dialog.mode === "reopen" && secondary.length === 0) {
      rejectDialog("app-dialog-delta", localize("Reopening needs at least one line of new material evidence."));
      return;
    }
    if (dialog.mode === "supersede" && !directionRecordOptions(dialog.target, dialog.recordId).some((item) => item.id === primary)) {
      rejectDialog("app-dialog-input", localize("Choose an available replacement record."));
      return;
    }
    closeDialog();
    vscode.postMessage(
      dialog.mode === "reopen"
        ? {
            type: "resolution.apply",
            target: dialog.target,
            id: dialog.recordId,
            action: "reopen",
            reason: primary,
            materialEvidenceDelta: secondary,
          }
        : {
            type: "resolution.apply",
            target: dialog.target,
            id: dialog.recordId,
            action: "supersede",
            supersededById: primary,
            ...(secondary.length === 0 ? {} : { reason: secondary.join("; ") }),
          },
    );
    return;
  }
  if (dialog.kind === "discardEditor") {
    delete state.dialog;
    delete state.dialogReturnFocusSelector;
    discardPipelineEditor();
    return;
  }
  if (dialog.kind === "replaceEditorImport") {
    const returnFocusSelector = state.dialogReturnFocusSelector;
    delete state.dialog;
    delete state.dialogReturnFocusSelector;
    startPipelineImport(returnFocusSelector);
    return;
  }
  if (dialog.kind === "deletePipeline") {
    const returnFocusSelector = state.dialogReturnFocusSelector;
    delete state.dialog;
    delete state.dialogReturnFocusSelector;
    startPipelineDelete(
      dialog.pipelineId,
      dialog.scopeKey,
      dialog.expectedHash,
      returnFocusSelector,
    );
    return;
  }
  if (dialog.kind === "cleanupRetainedRun") {
    closeDialog();
    vscode.postMessage({ type: "orchestration.cleanup", runId: dialog.runId });
    return;
  }
  if (dialog.kind === "discardWorkflow") {
    closeDialog();
    postRuntime({ type: "workflow.discard" });
    return;
  }
  closeDialog();
  if (dialog.kind === "archiveRun") {
    vscode.postMessage({ type: "conversation.archive", conversationId: dialog.conversationId, archived: true });
  } else if (dialog.kind === "deleteRun") {
    vscode.postMessage({ type: "conversation.close", conversationId: dialog.conversationId });
  } else if (dialog.kind === "stopOrchestration") {
    vscode.postMessage({ type: "orchestration.stop" });
  } else if (dialog.kind === "abandonOrchestration") {
    vscode.postMessage({ type: "orchestration.abandon" });
  } else if (dialog.kind === "resetTask") {
    postRuntime({ type: "task.reset" });
  } else if (dialog.kind === "resetBridge") {
    postRuntime({ type: "bridge.reset" });
  }
};
