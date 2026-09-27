/**
 * Notification and provider-history rendering.
 *
 * Concatenated after state.ts; reads notification state through the shared accessors.
 */

const notificationModeControlHtml = (): string => {
  const center = notificationCenterState();
  return `<label class="field"><span>${escapeHtml(localize("Notifications"))}</span><select id="notification-mode" aria-label="${escapeAttribute(localize("Notification mode"))}">${NOTIFICATION_MODE_LABELS.map((option) => `<option value="${option.value}"${center.mode === option.value ? " selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></label>`;
};

// Unread is a coloured left border in the stylesheet, which is not a distinction a reader who
// cannot see the colour can make. The entry states its level and its unread state in words.
const notificationLevelLabel: Record<"decision" | "material" | "routine", string> = {
  decision: localize("Decision"),
  material: localize("Material"),
  routine: localize("Routine"),
};

/*
 * EX-UI-02. Every row's action button says the same word — "Inspect" — so it has to be told apart
 * from its neighbours. It is described by the row's own sentence rather than relabelled with it:
 * an `aria-label` carrying the whole line made a screen reader read that line twice, once from the
 * paragraph and once from the button, which is the duplication this centre exists to avoid.
 */
const notificationContentsHtml = (center: NotificationCenterState, textIdPrefix: string): string => {
  const unread = center.unread;
  const list = center.events.length === 0
    ? `<p class="notification-empty">${escapeHtml(center.mode === "off" ? localize("Notifications are off.") : localize("No notifications."))}</p>`
    : `<ul class="notification-list">${center.events
        .map((entry) => `<li class="notification-${escapeAttribute(entry.level)}${entry.read ? "" : " unread"}">${entry.read ? "" : `<strong class="notification-unread-flag">${escapeHtml(localize("Unread"))}</strong>`}<span class="notification-level">${escapeHtml(notificationLevelLabel[entry.level])}</span><p id="${escapeAttribute(`${textIdPrefix}:${entry.id}`)}">${escapeHtml(entry.text)}</p><div class="compact-actions"><button data-action="notification-open" data-record="${escapeAttribute(entry.id)}" aria-describedby="${escapeAttribute(`${textIdPrefix}:${entry.id}`)}">${escapeHtml(notificationActionLabel[entry.action])}</button></div></li>`)
        .join("")}</ul>`;
  return `<div class="compact-actions"><button data-action="notification-read-all"${unread === 0 ? " disabled" : ""}>${escapeHtml(localize("Mark all read"))}</button><button data-action="notification-clear"${center.events.length === 0 ? " disabled" : ""}>${escapeHtml(localize("Clear"))}</button><button data-action="notification-settings">${escapeHtml(localize("Settings"))}</button></div>${list}`;
};

const notificationSummaryLabel = (center: NotificationCenterState): string =>
  center.mode === "off"
    ? localize("Notifications are off")
    : localize("Notifications, {0} unread", String(center.unread));

const compactNotificationsExpanded = (): boolean =>
  state.disclosureStates.get(`compact-notifications:${activeId()}`) === true;

const notificationBellHtml = (): string => {
  const center = notificationCenterState();
  const unread = center.unread;
  return `<details class="notification-center" ${disclosureAttributes("notification-center")}><summary class="icon-button" id="notification-button" aria-label="${escapeAttribute(notificationSummaryLabel(center))}" title="${escapeAttribute(localize("Notifications"))}"><i class="codicon codicon-bell" aria-hidden="true"></i>${unread > 0 ? `<span class="notification-unread" aria-hidden="true">${String(unread)}</span>` : ""}</summary><div class="notification-panel" role="region" aria-label="${escapeAttribute(localize("Notifications"))}">${notificationContentsHtml(center, "notification-text")}</div></details>`;
};

const compactNotificationActionHtml = (): string => {
  const center = notificationCenterState();
  return `<button class="run-menu-quick-action" data-action="run-menu-notifications-toggle" aria-label="${escapeAttribute(notificationSummaryLabel(center))}" title="${escapeAttribute(localize("Notifications"))}" aria-expanded="${compactNotificationsExpanded() ? "true" : "false"}" aria-controls="run-menu-notifications"><i class="codicon codicon-bell" aria-hidden="true"></i>${center.unread > 0 ? `<span class="notification-unread" aria-hidden="true">${String(center.unread)}</span>` : ""}</button>`;
};

const compactNotificationPanelHtml = (): string =>
  `<section id="run-menu-notifications" class="run-menu-notifications" role="region" aria-label="${escapeAttribute(localize("Notifications"))}"${compactNotificationsExpanded() ? "" : " hidden"}>${notificationContentsHtml(notificationCenterState(), "menu-notification-text")}</section>`;
