/**
 * Notification and provider-history rendering.
 *
 * Concatenated after state.ts; reads notification state through the shared accessors.
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
  if (center.mode === "off" || center.events.length === 0) return "";
  const unread = center.unread;
  const list = `<ul class="notification-list">${center.events
        .map((entry) => `<li class="notification-${escapeAttribute(entry.level)}${entry.read ? "" : " unread"}">${entry.read ? "" : `<strong class="notification-unread-flag">Unread</strong>`}<span class="notification-level">${escapeHtml(notificationLevelLabel[entry.level])}</span><p id="${escapeAttribute(`notification-text:${entry.id}`)}">${escapeHtml(entry.text)}</p><div class="compact-actions"><button data-action="notification-open" data-record="${escapeAttribute(entry.id)}" aria-describedby="${escapeAttribute(`notification-text:${entry.id}`)}">${escapeHtml(notificationActionLabel[entry.action])}</button></div></li>`)
        .join("")}</ul>`;
  return `<details class="notification-center" ${disclosureAttributes("notification-center")}><summary id="notification-button" aria-label="${escapeAttribute(`Notifications, ${String(unread)} unread`)}" title="Notifications"><i class="codicon codicon-bell" aria-hidden="true"></i>${unread > 0 ? `<span class="notification-unread" aria-hidden="true">${String(unread)}</span>` : ""}</summary><div class="notification-panel" role="region" aria-label="Notifications"><div class="compact-actions"><button data-action="notification-read-all"${unread === 0 ? " disabled" : ""}>Mark all read</button><button data-action="notification-clear">Clear</button><button data-action="notification-settings">Settings</button></div>${list}</div></details>`;
};
