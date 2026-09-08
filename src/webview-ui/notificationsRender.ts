/**
 * Notification and provider-history rendering.
 *
 * Concatenated after state.ts; reads notification state through the shared accessors.
 */

/**
 * The notification mode control, which lives in the room's overflow menu.
 *
 * It used to live inside the bell panel, which is why the bell had to be rendered even with
 * nothing in it: hiding an empty bell would have deleted the only route to the setting. Moving
 * the control out is what makes hiding the empty bell disclosure rather than removal.
 */
const notificationModeControlHtml = (): string => {
  const center = notificationCenterState();
  return `<label class="field"><span>Notifications</span><select id="notification-mode" aria-label="Notification mode">${NOTIFICATION_MODE_LABELS.map((option) => `<option value="${option.value}"${center.mode === option.value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></label>`;
};

// Unread is a coloured left border in the stylesheet, which is not a distinction a reader who
// cannot see the colour can make. The entry states its level and its unread state in words.
const notificationLevelLabel: Record<"decision" | "material" | "routine", string> = {
  decision: "Decision",
  material: "Material",
  routine: "Routine",
};

/*
 * EX-UI-02. Every row's action button says the same word — "Inspect" — so it has to be told apart
 * from its neighbours. It is described by the row's own sentence rather than relabelled with it:
 * an `aria-label` carrying the whole line made a screen reader read that line twice, once from the
 * paragraph and once from the button, which is the duplication this centre exists to avoid.
 */
const notificationBellHtml = (): string => {
  const center = notificationCenterState();
  if (center.events.length === 0) {
    return "";
  }
  const unread = center.unread;
  const list = `<ul class="notification-list">${center.events
        .map((entry) => `<li class="notification-${escapeAttribute(entry.level)}${entry.read ? "" : " unread"}">${entry.read ? "" : `<strong class="notification-unread-flag">Unread</strong>`}<span class="notification-level">${escapeHtml(notificationLevelLabel[entry.level])}</span><p id="${escapeAttribute(`notification-text:${entry.id}`)}">${escapeHtml(entry.text)}</p><div class="compact-actions"><button data-action="notification-open" data-record="${escapeAttribute(entry.id)}" aria-describedby="${escapeAttribute(`notification-text:${entry.id}`)}">${escapeHtml(notificationActionLabel[entry.action])}</button></div></li>`)
        .join("")}</ul>`;
  return `<details class="notification-center" ${disclosureAttributes("notification-center")}><summary aria-label="${escapeAttribute(`Notifications, ${String(unread)} unread`)}" title="Notifications"><i class="codicon codicon-bell" aria-hidden="true"></i>${unread > 0 ? `<span class="notification-unread" aria-hidden="true">${String(unread)}</span>` : ""}</summary><div class="notification-panel"><div class="compact-actions"><button data-action="notification-read-all"${unread === 0 ? " disabled" : ""}>Mark all read</button><button data-action="notification-clear">Clear</button></div>${list}<p class="muted">Bachata writes these lines from recorded state. They cost no model tokens and never enter a reviewer prompt.</p></div></details>`;
};

const reconstructionLabel: Record<"available" | "unavailable" | "unknown", string> = {
  available: "reconstructable",
  unavailable: "unavailable",
  unknown: "unknown",
};

const providerHistoryHtml = (conversationId: string): string => {
  const locators = state.manager.conversationLocators?.[conversationId] ?? [];
  if (locators.length === 0) return "";
  return `<section class="provider-history"><h2>Where does this run's provider history live?</h2><ul>${locators
    .map((locator) => `<li><div><strong>${escapeHtml(`${locator.role} · ${locator.provider}`)}</strong><small>${escapeHtml(`${locator.adapter} · history ${reconstructionLabel[locator.reconstruction]} · last seen ${formatDateTime(locator.lastSeenAt)}`)}</small></div><p class="muted">${escapeHtml(locator.reconstructionDetail)}</p></li>`)
    .join("")}</ul><p class="muted">Bachata keeps a locator, compact typed outputs, and a bounded local transcript. It never stores a full provider transcript, and exports carry no session or conversation identity.</p></section>`;
};

const notificationBubbleHtml = (): string => {
  const center = notificationCenterState();
  const newest = center.events.find((entry) => !entry.read);
  if (center.mode === "off" || newest === undefined) return "";
  // EX-UI-02. The centre lists this event already. While it is open the bubble would be a second
  // copy of the same line on the same screen, so only one of the two speaks at a time.
  if (notificationCenterOpen()) return "";
  return `<div class="notification-bubble" ${liveRegionAttributes("notification-bubble", "status", newest.text)}><span>${escapeHtml(newest.text)}</span><button data-action="notification-open" data-record="${escapeAttribute(newest.id)}">${escapeHtml(notificationActionLabel[newest.action])}</button></div>`;
};
