/**
 * Shared render primitives for the webview.
 *
 * This file is concatenated ahead of main.ts by tsconfig.webview.json (module: none,
 * outFile), so these declarations are shared through the emitted script's scope rather than
 * through imports.
 *
 * Every string that reaches the DOM goes through the escaping here, so there is exactly one
 * place that decides how untrusted text is made safe. These are pure functions: they read no
 * webview state and hold none, which is what lets renderers be tested on their own.
 */

const escapeHtml = (value: string): string =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const escapeAttribute = escapeHtml;

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const formatBytes = (bytes: number): string => {
  const value = bytes;
  if (value < 1024) return localize("{0} B", formatNumber(value));
  if (value < 1024 * 1024) return localize("{0} KB", formatNumber(value / 1024, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  return localize("{0} MB", formatNumber(value / (1024 * 1024), { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
};

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(webviewLocale);
};

const padTwo = (value: number): string => String(value).padStart(2, "0");

/** Countdown form, for a deadline the reader is watching. */
const formatDuration = (milliseconds: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const tail = `${padTwo(minutes % 60)}:${padTwo(totalSeconds % 60)}`;
  return minutes < 60 ? tail : `${String(Math.floor(minutes / 60))}:${tail}`;
};

/** Coarse form, for a limit stated once in prose. */
const durationLabel = (milliseconds: number): string => {
  if (milliseconds < 60_000) return localize("{0}s", formatNumber(Math.round(milliseconds / 1000)));
  const minutes = Math.round(milliseconds / 60_000);
  return minutes < 60 ? localize("{0} min", formatNumber(minutes)) : localize("{0} h", formatNumber(Math.round(minutes / 60)));
};

const listText = (value: unknown, separator: string): string =>
  (Array.isArray(value) ? value : []).map((item) => String(item)).join(separator);

const verificationChecksText = (
  checks: Array<{ id: string; command: string }> | undefined,
): string =>
  (Array.isArray(checks) ? checks : [])
    .map((check) => `${check.id} = ${check.command}`)
    .join("\n");

const countLabel = (count: number, singular: string, plural = `${singular}s`): string => {
  const number = formatNumber(count);
  if (singular === "step") return count === 1 ? localize("{0} step", number) : localize("{0} steps", number);
  if (singular === "participant") return count === 1 ? localize("{0} participant", number) : localize("{0} participants", number);
  if (singular === "run") return count === 1 ? localize("{0} run", number) : localize("{0} runs", number);
  return localize("{0} {1}", number, count === 1 ? singular : plural);
};

/**
 * S6. Identifiers the bridge and the catalogue speak, said in words.
 *
 * These values cross the wire as enum members and used to reach the reader unchanged, so a
 * bound tab read "notAuthenticated" and a policy read "ask". The maps are the same shape the
 * webview already uses for workflow status and agent status; every member of each union is
 * present, so an unmapped value is a protocol change rather than a gap.
 */
const browserSessionStatusLabel: Record<string, string> = {
  disconnected: localize("Disconnected"),
  notAuthenticated: localize("Not signed in"),
  notReady: localize("Not ready"),
  ready: localize("Ready"),
  submitting: localize("Sending"),
  streaming: localize("Answering"),
  failed: localize("Failed"),
};

const browserActionPolicyLabel: Record<string, string> = {
  auto: localize("Allowed without asking"),
  ask: localize("Ask every time"),
  disabled: localize("Never allowed"),
};

/**
 * A pipeline's storage scope, said as a place rather than a key.
 *
 * `scopeKey` is not a closed set: only "builtin" is a literal, the other two shapes are a
 * prefix and an absolute path, so this reads the shape rather than indexing a map.
 */
const pipelineScopeLabel = (scopeKey: string, scopeRoot?: string): string => {
  if (scopeKey === "builtin") return localize("built-in");
  const folder = scopeRoot?.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  if (folder) return localize("workspace {0}", folder);
  return scopeKey.startsWith("workspace:") ? localize("this workspace") : localize("extension-local");
};

/**
 * S4. What Bachata does with a decision nobody answered in time.
 *
 * The webview is told a deadline but never told it passed: the host resolves the row and the
 * interaction simply stops appearing in the next snapshot, which can be a whole Lead turn
 * later. Until then an answer still wins the race, so this states the consequence without
 * claiming the decision is already closed. The wording is per kind because the host's fallback
 * is per kind, and it never promises a Lead, which the webview cannot know exists.
 */
const interactionTimeoutConsequence = (kind: string): string => {
  if (kind === "permission") return localize("If it resolves first, the request is denied.");
  if (kind === "humanGate") return localize("If it resolves first, the run stops here.");
  if (kind === "executionChecklist") return localize("If it resolves first, no task runs and the run stops here.");
  if (kind === "secret") return localize("If it resolves first, the run continues without it.");
  return localize("If it resolves first, the Lead answers instead when this workspace has one.");
};

// Generic judgement presentation: a surfaced record states what it rests on, or says nothing
// was supplied. Used by Direction and execution rendering alike, so it lives with the shared
// primitives rather than with either caller.
// "Evidence" is a mass noun and takes a singular verb, so the empty sentence is written per
// label rather than assembled from it. An unrecognised label falls back to a form that states
// the same thing without needing to agree with a number.
const emptyJudgementSentence: Record<string, string> = {
  evidence: localize("No evidence was supplied."),
  challenges: localize("No challenges were supplied."),
  options: localize("No options were supplied."),
};

const judgementEmptyText = (label: string): string =>
  emptyJudgementSentence[label.toLowerCase()] ?? localize("{0}: none supplied.", label);

const judgementEvidenceHtml = (label: string, items: string[]): string =>
  items.length === 0
    ? `<p class="muted">${escapeHtml(judgementEmptyText(label))}</p>`
    : `<details class="direction-evidence"><summary>${escapeHtml(localize("{0} ({1})", label, items.length))}</summary><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`;

const producingRunHtml = (runRef: string | undefined): string =>
  runRef === undefined
    ? ""
    : `<button data-action="open-producing-run" data-run="${escapeAttribute(runRef)}">${escapeHtml(localize("Open the run that produced this"))}</button>`;

const browserBridgeReasons = (): Record<string, string> => ({
  portUnavailable: localize("Another application is using the browser connection. Close that application to reconnect."),
  localWindowRequired: localize("Open this workspace in a local VS Code window to connect your browser."),
  browserUpdateRequired: localize("Update the Bachata Browser Bridge extension, then reconnect your browser."),
  pairingExpired: localize("Pairing has expired. Reset pairing and pair the browser again."),
  accessDenied: localize("Your computer denied permission to open the browser connection. Check your security settings."),
});

type BrowserBridgeDisplayState = "connecting" | "retrying" | "connected" | "blocked" | "disconnected";

const browserBridgeDisplay = (bridge: BrowserBridgeStatus): { state: BrowserBridgeDisplayState; reason?: string; message?: string } => {
  const reasons = browserBridgeReasons();
  const reason = !bridge.enabled ? "localWindowRequired" : bridge.connectionState === "blocked" ? bridge.blockedReason : undefined;
  const message = reason && Object.hasOwn(reasons, reason) ? reasons[reason] : undefined;
  const requestedState = !bridge.enabled ? "blocked"
    : bridge.connected ? "connected"
      : bridge.connectionState === "blocked" && !message ? "retrying"
        : bridge.connectionState ?? (bridge.error ? "retrying" : "connecting");
  const known: readonly BrowserBridgeDisplayState[] = ["connecting", "retrying", "connected", "blocked", "disconnected"];
  const state = known.find((entry) => entry === requestedState) ?? "retrying";
  return { state, ...(reason === undefined ? {} : { reason }), ...(message === undefined ? {} : { message }) };
};

const browserBridgePresentation = (bridge: BrowserBridgeStatus, scope: string) => {
  const labels: Record<BrowserBridgeDisplayState, string> = {
    connecting: localize("Connecting…"),
    retrying: localize("Browser unavailable — retrying"),
    connected: localize("Connected"),
    blocked: localize("Browser unavailable"),
    disconnected: localize("Disconnected"),
  };
  const { state, reason, message } = browserBridgeDisplay(bridge);
  return {
    statusHtml: `<span data-bridge-state="${escapeAttribute(state)}" ${liveRegionAttributes(`${scope}:status`, "status", labels[state])} aria-atomic="true">${escapeHtml(labels[state])}</span>`,
    reasonHtml: state === "blocked" && message ? `<p class="error" data-bridge-reason="${escapeAttribute(reason ?? "")}" ${liveRegionAttributes(`${scope}:reason`, "status", message)}>${escapeHtml(message)}</p>` : "",
  };
};

const productErrorMessage = (message: string | undefined): string | undefined => {
  if (!message) return undefined;
  const quarantine = message.match(/\bShared resource is quarantined:\s*([^;\n]*)/iu);
  if (quarantine) {
    const resources = quarantine[1]?.split(",").map((resource) => resource.trim().split(/\s/u)[0]);
    if (resources?.length && resources.every((resource) => resource === "browser-bridge:profile")) return undefined;
  }
  const localAgents = /\blocal-agents:global\b|Previous provider cleanup is unconfirmed/iu.test(message);
  const cleanupFailure = /Previous (?:provider|resource) cleanup is unconfirmed|(?:resources?|catalog|reservation)[^\n]{0,100}could (?:not be|neither be released nor) quarantined/iu.test(message);
  if (quarantine || cleanupFailure) {
    return localAgents
      ? localize("Local agents are unavailable because a previous operation did not stop cleanly.")
      : localize("This operation is unavailable because a previous operation did not stop cleanly.");
  }
  return message;
};
