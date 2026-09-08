/**
 * Dialog rendering and submission.
 *
 * Concatenated after the editor, since a dialog can confirm an editor operation. Focus
 * restoration stays with the dialog that took focus.
 */

const appDialogHtml = (): string => {
  const dialog = state.dialog;
  if (!dialog) {
    return "";
  }
  const input = dialog.kind === "renameRun"
    ? `<label class="field"><span>Run title</span><input id="app-dialog-input" value="${escapeAttribute(dialog.inputValue)}" maxlength="200"></label>`
    : dialog.kind === "resolveRecord"
      ? dialog.mode === "reopen"
        ? `<label class="field"><span>Reason</span><input id="app-dialog-input" value="${escapeAttribute(dialog.inputValue)}" maxlength="2000"></label><label class="field"><span>Material evidence delta (one per line)</span><textarea id="app-dialog-delta" rows="3"></textarea></label>`
        : `<label class="field"><span>Replacement record id</span><input id="app-dialog-input" value="${escapeAttribute(dialog.inputValue)}" maxlength="200"></label><label class="field"><span>Reason (optional)</span><textarea id="app-dialog-delta" rows="2"></textarea></label>`
      : dialog.kind === "createInitiative"
        ? `<label class="field"><span>Title</span><input id="app-dialog-input" value="${escapeAttribute(dialog.inputValue)}" maxlength="200"></label><label class="field"><span>Goal</span><textarea id="app-dialog-delta" rows="2"></textarea></label>`
      : dialog.kind === "mergeFinding"
        ? `<label class="field"><span>Merge into finding id</span><input id="app-dialog-input" value="${escapeAttribute(dialog.inputValue)}" maxlength="200"></label><label class="field"><span>Why are these the same defect?</span><textarea id="app-dialog-delta" rows="2"></textarea></label>`
        : "";
  const danger = "danger" in dialog && dialog.danger;
  // A refusal is held in the store and drawn from it, so a background render puts it back
  // instead of erasing it along with the flag on the field.
  const refusal = state.fieldErrors.get("app-dialog-input") ?? state.fieldErrors.get("app-dialog-delta") ?? "";
  const refusedField = state.fieldErrors.has("app-dialog-input") ? "app-dialog-input" : state.fieldErrors.has("app-dialog-delta") ? "app-dialog-delta" : undefined;
  const marked = refusedField === undefined
    ? input
    : input.replace(`id="${refusedField}"`, `id="${refusedField}" aria-invalid="true" aria-describedby="app-dialog-error"`);
  return `<div class="modal-backdrop app-dialog-backdrop" data-action="dialog-backdrop"><section class="app-dialog" role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" aria-describedby="app-dialog-message"><header><h2 id="app-dialog-title">${escapeHtml(dialog.title)}</h2><button data-action="dialog-cancel" aria-label="Close dialog">×</button></header><p id="app-dialog-message">${escapeHtml(dialog.message)}</p>${marked}<div class="error" id="app-dialog-error" role="alert">${escapeHtml(refusal)}</div><footer><button data-action="dialog-cancel" data-dialog-default="cancel">Cancel</button><button class="${danger ? "danger" : "primary"}" data-action="dialog-confirm">${escapeHtml(dialog.confirmLabel)}</button></footer></section></div>`;
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
  scrollTop: number;
  scrollLeft: number;
};

let composing = false;
let deferredRender = false;

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
    const collapsed = control.closest("details:not([open])");
    return collapsed === null || (control.tagName === "SUMMARY" && control.parentElement === collapsed);
  });

const restoreControl = (snapshot: ControlSnapshot | undefined): void => {
  if (!snapshot) {
    return;
  }
  const element = findControl(snapshot);
  if (!element) {
    return;
  }
  // The render restores every scroll container deliberately just before this runs. A plain focus()
  // scrolls the control back into view and undoes that: a reader who had pressed anything inside
  // the transcript lost the live edge on every appended message, smoothly, because the pane
  // scrolls with `scroll-behavior: smooth`.
  element.focus({ preventScroll: true });
  element.scrollTop = snapshot.scrollTop;
  element.scrollLeft = snapshot.scrollLeft;
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
  discardCodeBlocks(output);
  output.innerHTML = renderMarkdown(agent.output || "…");
  const scroll = document.getElementById("conversation-scroll");
  if (scroll) {
    const distanceFromBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
    if (distanceFromBottom < 90) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  }
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
      rejectDialog("app-dialog-input", "Enter a title for this run.");
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
      rejectDialog("app-dialog-input", "Enter a title for this initiative.");
      return;
    }
    if (!goal) {
      rejectDialog("app-dialog-delta", "State what this initiative has to achieve.");
      return;
    }
    closeDialog();
    vscode.postMessage({ type: "initiative.create", title, goal });
    return;
  }
  if (dialog.kind === "mergeFinding") {
    const input = document.getElementById("app-dialog-input") as HTMLInputElement | null;
    const extra = document.getElementById("app-dialog-delta") as HTMLTextAreaElement | null;
    const canonicalIdentity = input?.value.trim() ?? "";
    const reason = (extra?.value ?? "").trim();
    if (!canonicalIdentity) {
      rejectDialog("app-dialog-input", "Enter the id of the finding this one is merged into.");
      return;
    }
    if (canonicalIdentity === dialog.absorbedIdentity) {
      rejectDialog("app-dialog-input", "Merge into a different finding: this is the finding being merged.");
      return;
    }
    if (!reason) {
      rejectDialog("app-dialog-delta", "Say why these two findings are the same defect.");
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
    const input = document.getElementById("app-dialog-input") as HTMLInputElement | null;
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
          ? "Give a reason for reopening this record."
          : "Enter the id of the record that replaces this one.",
      );
      return;
    }
    if (dialog.mode === "reopen" && secondary.length === 0) {
      rejectDialog("app-dialog-delta", "Reopening needs at least one line of new material evidence.");
      return;
    }
    if (dialog.mode === "supersede" && primary === dialog.recordId) {
      rejectDialog("app-dialog-input", "Enter a different record id: a record cannot supersede itself.");
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
