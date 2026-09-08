/**
 * Read-only presentation.
 *
 * A window that did not win workspace ownership renders the whole product and marks every
 * control that would change state unavailable, naming the window that owns the repository.
 * Refusal does not depend on this: the extension refuses the same mutations below the UI. This
 * is what stops a reader from trying in the first place.
 */

// Shared with the extension through the manager snapshot.
type ReadOnlyOwnership = {
  owned: false;
  reason: string;
  holderDescription?: string;
  holderLastSeenSecondsAgo?: number;
  retryCommand: string;
};

// Reading, navigating and inspecting stay live: they change nothing the writer owns.
const READ_ONLY_SAFE_ACTIONS = new Set([
  "select-conversation",
  "room-view",
  "run-drawer-open",
  "run-drawer-toggle",
  "run-drawer-backdrop",
  "run-menu-toggle",
  "inspector-toggle",
  "composer-options-toggle",
  "advanced-mode-open",
  "copy-code",
  "load-older",
  "open-producing-run",
  "reveal-finding",
  "focus-agent-output",
  "result-file-select",
  "result-hunk-select",
  "result-hunks-clear",
  "result-reveal-file",
  "result-open-changes",
  "result-source-control",
  "orchestration-reveal",
  "orchestration-diff",
  "render-retry",
  "render-reset",
  "render-open-output",
  "error-dismiss",
  "render-editor-close",
  "pipeline-editor-close",
  "dialog-cancel",
  "dialog-backdrop",
  "noop",
]);

const readOnlyHolder = (ownership: ReadOnlyOwnership): string =>
  ownership.holderDescription === undefined
    ? "Another Bachata window"
    : `Another Bachata window (${ownership.holderDescription})`;

// The one sentence a control's tooltip carries; the banner says the rest once.
const readOnlyReason = (ownership: ReadOnlyOwnership): string =>
  `${readOnlyHolder(ownership)} owns this repository's state, so this window can only read it.`;

const readOnlyExplanation = (ownership: ReadOnlyOwnership): string => {
  const seen = ownership.holderLastSeenSecondsAgo === undefined
    ? ""
    : ` It was active ${String(ownership.holderLastSeenSecondsAgo)}s ago.`;
  return `${readOnlyReason(ownership)}${seen} To take ownership, run the ${ownership.retryCommand} command from the Command Palette.`;
};

// A control the reader cannot use keeps its place in the tab order, so the reason it is dead is
// attached to every one of them by reference to this single element.
const READ_ONLY_EXPLANATION_ID = "read-only-explanation";

const readOnlyBannerHtml = (ownership: ReadOnlyOwnership | undefined): string => {
  if (ownership === undefined) return "";
  const explanation = readOnlyExplanation(ownership);
  return `<div class="read-only-banner" ${liveRegionAttributes("read-only-banner", "status", explanation)} data-read-only-banner="true"><strong>Read-only</strong><span id="${READ_ONLY_EXPLANATION_ID}">${escapeHtml(explanation)}</span></div>`;
};

const readOnlyControlAction = (control: HTMLElement): string | undefined => {
  const own = control.getAttribute("data-action");
  if (own) return own;
  const owner = typeof control.closest === "function"
    ? control.closest("[data-action]") as HTMLElement | null
    : null;
  return owner?.getAttribute("data-action") ?? undefined;
};

const applyReadOnlyControls = (
  container: ParentNode,
  ownership: ReadOnlyOwnership | undefined,
): number => {
  if (!ownership) return 0;
  const reason = readOnlyReason(ownership);
  let declined = 0;
  ["button", "input", "textarea", "select"].forEach((tag) => {
    container.querySelectorAll(tag).forEach((element) => {
      const control = element as HTMLElement;
      const action = readOnlyControlAction(control);
      if (action !== undefined && READ_ONLY_SAFE_ACTIONS.has(action)) return;
      if (control.getAttribute("aria-disabled") !== "true") declined += 1;
      // The `disabled` attribute would take the control out of the tab order and hide its title,
      // so a reader could neither reach it nor hear why it is dead. aria-disabled keeps it
      // reachable; the dispatcher is what refuses the action, and a text field refuses the edit
      // itself rather than taking text this window can never save.
      control.setAttribute("aria-disabled", "true");
      if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
        control.readOnly = true;
      }
      control.title = reason;
      const described = (control.getAttribute("aria-describedby") ?? "")
        .split(" ")
        .filter((token) => token.length > 0);
      // First, so a refusal reads the ownership reason before any blocker the composer lists.
      if (!described.includes(READ_ONLY_EXPLANATION_ID)) described.unshift(READ_ONLY_EXPLANATION_ID);
      control.setAttribute("aria-describedby", described.join(" "));
    });
  });
  return declined;
};
