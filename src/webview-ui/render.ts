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
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
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
  if (milliseconds < 60_000) return `${String(Math.round(milliseconds / 1000))}s`;
  const minutes = Math.round(milliseconds / 60_000);
  return minutes < 60 ? `${String(minutes)} min` : `${String(Math.round(minutes / 60))} h`;
};

const listText = (value: unknown, separator: string): string =>
  (Array.isArray(value) ? value : []).map((item) => String(item)).join(separator);

const verificationChecksText = (
  checks: Array<{ id: string; command: string }> | undefined,
): string =>
  (Array.isArray(checks) ? checks : [])
    .map((check) => `${check.id} = ${check.command}`)
    .join("\n");

const countLabel = (count: number, singular: string, plural = `${singular}s`): string =>
  `${String(count)} ${count === 1 ? singular : plural}`;

/**
 * S6. Identifiers the bridge and the catalogue speak, said in words.
 *
 * These values cross the wire as enum members and used to reach the reader unchanged, so a
 * bound tab read "notAuthenticated" and a policy read "ask". The maps are the same shape the
 * webview already uses for workflow status and agent status; every member of each union is
 * present, so an unmapped value is a protocol change rather than a gap.
 */
const browserSessionStatusLabel: Record<string, string> = {
  disconnected: "Disconnected",
  notAuthenticated: "Not signed in",
  notReady: "Not ready",
  ready: "Ready",
  submitting: "Sending",
  streaming: "Answering",
  failed: "Failed",
};

const browserActionPolicyLabel: Record<string, string> = {
  auto: "Allowed without asking",
  ask: "Ask every time",
  disabled: "Never allowed",
};

/**
 * A pipeline's storage scope, said as a place rather than a key.
 *
 * `scopeKey` is not a closed set: only "builtin" is a literal, the other two shapes are a
 * prefix and an absolute path, so this reads the shape rather than indexing a map.
 */
const pipelineScopeLabel = (scopeKey: string, scopeRoot?: string): string => {
  if (scopeKey === "builtin") return "built-in";
  const folder = scopeRoot?.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);
  if (folder) return `workspace ${folder}`;
  return scopeKey.startsWith("workspace:") ? "this workspace" : "extension-local";
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
  if (kind === "permission") return "If it resolves first, the request is denied.";
  if (kind === "humanGate") return "If it resolves first, the run stops here.";
  if (kind === "executionChecklist") return "If it resolves first, no task runs and the run stops here.";
  if (kind === "secret") return "If it resolves first, the run continues without it.";
  return "If it resolves first, the Lead answers instead when this workspace has one.";
};

// Generic judgement presentation: a surfaced record states what it rests on, or says nothing
// was supplied. Used by Direction and execution rendering alike, so it lives with the shared
// primitives rather than with either caller.
// "Evidence" is a mass noun and takes a singular verb, so the empty sentence is written per
// label rather than assembled from it. An unrecognised label falls back to a form that states
// the same thing without needing to agree with a number.
const emptyJudgementSentence: Record<string, string> = {
  evidence: "No evidence was supplied.",
  challenges: "No challenges were supplied.",
  options: "No options were supplied.",
};

const judgementEmptyText = (label: string): string =>
  emptyJudgementSentence[label.toLowerCase()] ?? `${label}: none supplied.`;

const judgementEvidenceHtml = (label: string, items: string[]): string =>
  items.length === 0
    ? `<p class="muted">${escapeHtml(judgementEmptyText(label))}</p>`
    : `<details class="direction-evidence"><summary>${escapeHtml(`${label} (${String(items.length)})`)}</summary><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>`;

const producingRunHtml = (runRef: string | undefined): string =>
  runRef === undefined
    ? ""
    : `<button data-action="open-producing-run" data-run="${escapeAttribute(runRef)}">Open the run that produced this</button>`;
