/**
 * Direction and semantic-history rendering.
 *
 * Concatenated after render.ts and before main.ts (tsconfig.webview.json, module: none,
 * outFile), so it uses the shared primitives directly. Everything here is a pure function of
 * the records it is given: it reads no webview state, which is what lets these renderers be
 * asserted on their own rather than only through a booted webview.
 */

const labelFor = (labels: Record<string, string>, value: string): string =>
  labels[value] ?? value;

// Reasons arrive as finished sentences, so the joined line carries exactly one terminal stop
// rather than repeating whatever the writer already ended with.
const sentenceJoin = (items: string[]): string =>
  items
    .map((item) => item.replace(/\s*\.+$/u, "").trim())
    .filter((item) => item.length > 0)
    .join("; ");

const lifecycleStateLabel: Record<string, string> = {
  proposed: "Proposed",
  accepted: "Accepted",
  rejected: "Rejected",
  deferred: "Deferred",
  superseded: "Superseded",
  unresolved: "Unresolved",
};

const checkStatusLabel: Record<string, string> = {
  passed: "Passed",
  failed: "Failed",
  timedOut: "Timed out",
  cancelled: "Cancelled",
};

const cycleCompletionLabel: Record<string, string> = {
  open: "Open",
  completed: "Completed",
  abandoned: "Abandoned",
};

const cycleTypeLabel: Record<string, string> = {
  framing: "Framing",
  research: "Research",
  planning: "Planning",
  execution: "Execution",
  validation: "Validation",
  review: "Review",
  debugging: "Debugging",
  custom: "Custom",
};

const initiativeStatusLabel: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  completed: "Completed",
  abandoned: "Abandoned",
};

const directionSectionHtml = (
  key: string,
  label: string,
  content: string,
  defaultOpen = false,
  className = "",
): string => {
  if (!content) return "";
  const open = state.disclosureStates.get(`${activeId()}:${key}`) ?? defaultOpen;
  const panelId = `direction-panel-${key}`;
  return `<section class="direction-secondary ${escapeAttribute(className)}"><h3><button class="direction-secondary-toggle" data-action="direction-section-toggle" data-section="${escapeAttribute(key)}" aria-expanded="${String(open)}" aria-controls="${escapeAttribute(panelId)}">${escapeHtml(label)}<i class="codicon codicon-chevron-${open ? "down" : "right"}" aria-hidden="true"></i></button></h3><div id="${escapeAttribute(panelId)}" class="direction-secondary-content"${open ? "" : " hidden"}>${content}</div></section>`;
};

const directionFindingRecords = (): DirectionFinding[] => {
  const longitudinal = longitudinalState();
  const view = longitudinal.direction;
  return [...new Map([
    ...(view.findingHistory ?? []),
    ...view.outstandingAcceptedFindings,
    ...view.unresolvedFindings,
    ...(view.findingsNeedingRuling ?? []),
    ...(view.latestChange?.newMaterial ?? []),
    ...(view.latestChange?.repeated ?? []),
    ...(view.latestChange?.regressed ?? []),
    ...(view.latestChange?.reopened ?? []),
    ...(view.latestChange?.resolved ?? []),
    ...(view.latestChange?.notObserved ?? []),
    ...longitudinal.findings,
  ].map((record) => [record.identity, record])).values()];
};

const directionDecisionRecords = (): DirectionDecision[] => {
  const longitudinal = longitudinalState();
  return [...new Map([
    ...(longitudinal.direction.decisionHistory ?? []),
    ...longitudinal.direction.decisionsNeedingHuman,
    ...longitudinal.decisions,
  ].map((record) => [record.id, record])).values()];
};

const directionRecordOptions = (
  target: "finding" | "decision" | "artifact" | "externalEvidence",
  excludedId: string,
): Array<{ id: string; label: string }> => {
  const longitudinal = longitudinalState();
  const records = target === "finding"
    ? directionFindingRecords().map((item) => ({ id: item.identity, label: `${item.subject}${item.location ? ` · ${item.location.file}${item.location.startLine === undefined ? "" : `:${String(item.location.startLine)}`}` : ""}`, state: item.state }))
    : target === "decision"
      ? directionDecisionRecords().filter((item) => !item.supersededById).map((item) => ({ id: item.id, label: `${item.subject} · revision ${String(item.revision ?? 1)}`, state: item.state }))
      : target === "artifact"
        ? [...new Map([...longitudinal.direction.acceptedArtifacts, ...longitudinal.direction.proposedArtifacts, ...longitudinal.artifacts].map((item) => [item.id, item])).values()].map((item) => ({ id: item.id, label: `${item.title} · revision ${String(item.revision)}`, state: item.state }))
        : (longitudinal.externalEvidence ?? []).filter((item) => !item.supersededById).map((item) => ({ id: item.id, label: `${item.source.title} · revision ${String(item.revision)}`, state: item.state }));
  return records.filter((item) => item.id !== excludedId && item.state !== "superseded").map((item) => ({
    id: item.id,
    label: `${item.label} · ${target === "finding" ? findingStateLabel[item.state as LongitudinalFindingState] : labelFor(lifecycleStateLabel, item.state)}`,
  }));
};

const directionMergeOptions = (excludedId: string): Array<{ id: string; label: string }> => {
  const findings = directionFindingRecords();
  const source = findings.find((item) => item.identity === excludedId);
  const aliases = new Set((longitudinalState().findingAliases ?? []).map((item) => item.aliasIdentity));
  const eligible = new Set(findings.filter((item) =>
    !aliases.has(item.identity) &&
    !(source?.humanResolution && item.humanResolution && source.humanResolution.action !== item.humanResolution.action),
  ).map((item) => item.identity));
  return directionRecordOptions("finding", excludedId).filter((item) => eligible.has(item.id));
};

const directionFindingTitle = (identity: string | undefined): string =>
  directionFindingRecords().find((item) => item.identity === identity)?.subject ?? "Earlier finding";

const directionDecisionTitle = (id: string | undefined): string =>
  directionDecisionRecords().find((item) => item.id === id)?.subject ?? "Earlier decision";

const directionEvidenceListHtml = (label: string, items: string[]): string =>
  items.length === 0 ? "" : `<div class="direction-evidence-group"><h4>${escapeHtml(label)}</h4><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;

const matchScoreLabel = (score: number): string => {
  const percent = Math.max(0, Math.min(100, Math.round(score)));
  const strength = percent >= 85 ? "strong match" : percent >= 65 ? "possible match" : "weak match";
  return `${strength}, ${String(percent)}%`;
};

const resolutionHistoryHtml = (
  entries: LongitudinalHumanResolution[] | undefined,
): string => {
  const history = entries ?? [];
  if (history.length === 0) return "";
  return `<ol class="direction-resolution-history">${history.map((entry) => `<li><small>${escapeHtml(`${entry.action} by ${entry.resolvedBy}${entry.reason ? `: ${entry.reason}` : ""}`)}</small></li>`).join("")}</ol>`;
};

const historyFindingHtml = (finding: DirectionFinding): string => {
  const location = finding.location
    ? '<button data-action="reveal-finding" data-file="' + escapeAttribute(finding.location.file) + '"' + (finding.location.startLine === undefined ? "" : ' data-line="' + escapeAttribute(String(finding.location.startLine)) + '"') + '>Open file</button>'
    : "";
  const evidence = directionEvidenceListHtml("Evidence", finding.evidence) + directionEvidenceListHtml("Challenges", finding.challenges);
  return '<li class="direction-history-record finding-' + escapeAttribute(finding.state) + '"><div><strong>' + escapeHtml(finding.subject) + '</strong><small>' + escapeHtml(findingStateLabel[finding.state] + (finding.fixState ? " · " + findingFixStateLabel[finding.fixState] : "") + (finding.occurrences > 1 ? " · seen " + String(finding.occurrences) + "×" : "")) + '</small></div><p>' + escapeHtml(finding.message) + '</p>' + (finding.humanResolution?.reason ? '<p class="muted">' + escapeHtml(finding.humanResolution.reason) + '</p>' : "") + directionSectionHtml("finding-history-" + finding.identity, "Evidence and history", evidence + resolutionHistoryHtml(finding.resolutionHistory)) + '<div class="compact-actions">' + producingRunHtml(finding.lastRunRef) + location + resolutionActionsHtml("finding", finding.identity, finding.subject, finding.state) + '</div></li>';
};

const historyDecisionHtml = (decision: DirectionDecision): string => {
  const chain = [
    decision.supersedesId ? "Replaces: " + directionDecisionTitle(decision.supersedesId) : undefined,
    decision.supersededById ? "Replaced by: " + directionDecisionTitle(decision.supersededById) : undefined,
  ].filter((item) => item !== undefined).join(" · ");
  const details = directionEvidenceListHtml("Evidence", decision.evidence) + resolutionHistoryHtml(decision.resolutionHistory);
  return '<li class="direction-history-record decision-' + escapeAttribute(decision.state) + '"><div><strong>' + escapeHtml(decision.subject) + '</strong><small>' + escapeHtml(labelFor(lifecycleStateLabel, decision.state) + " · revision " + String(decision.revision ?? 1) + (chain ? " · " + chain : "")) + '</small></div><p>' + escapeHtml(decision.question) + '</p>' + (decision.humanResolution?.reason ? '<p class="muted">' + escapeHtml(decision.humanResolution.reason) + '</p>' : "") + directionEvidenceListHtml("Options", decision.options ?? []) + (decision.recommendation ? '<p>Recommendation: ' + escapeHtml(decision.recommendation) + '</p>' : "") + (decision.tradeOffs.length > 0 ? '<p class="muted">Trade-offs: ' + escapeHtml(decision.tradeOffs.join("; ")) + '</p>' : "") + directionSectionHtml("decision-history-" + decision.id, "Evidence and history", details) + (decision.reopenReason ? '<p class="muted">Reopened: ' + escapeHtml(decision.reopenReason) + '</p>' : "") + '<div class="compact-actions">' + producingRunHtml(decision.producedByRunRef) + resolutionActionsHtml("decision", decision.id, decision.subject, decision.state) + '</div></li>';
};

const resolutionActionLabel: Record<string, string> = {
  accept: "Accept",
  reject: "Reject",
  defer: "Defer",
  supersede: "Supersede",
  reopen: "Reopen",
};

// "Defer" and "Supersede" are the two verbs a first reader cannot guess, so the button states
// what it does rather than leaving the definition to the dialog that follows the click.
const resolutionActionHint: Record<string, string> = {
  accept: "Accept this record and act on it.",
  reject: "Reject this record; nothing acts on it.",
  defer: "Leave this record open and do not act on it this round.",
  supersede: "Replace this record with a newer one.",
  reopen: "Reopen this record for another round.",
};

const resolutionActionsHtml = (
  target: "finding" | "decision" | "artifact" | "externalEvidence",
  id: string,
  subject: string,
  state?: string,
  acceptHint?: string,
): string =>
  ((): string => {
    const matrix = longitudinalState().resolutionMatrix;
    const allowed: string[] = state === undefined || matrix === undefined
      ? ["accept", "reject", "defer", "supersede", "reopen"]
      : matrix[target]?.[state] ?? [];
    const visible = target === "finding" && state === "accepted"
      ? allowed.filter((action) => action !== "accept")
      : allowed;
    if (visible.length === 0) return "";
    return `<div class="compact-actions resolution-actions">${visible
      .map((action) => {
        const label = resolutionActionLabel[action] ?? action;
        const hint = action === "accept" && acceptHint ? acceptHint : resolutionActionHint[action];
        const unavailable = action === "supersede" && directionRecordOptions(target, id).length === 0;
        return `<button data-action="resolve-record" data-target="${target}" data-record="${escapeAttribute(id)}" data-resolution="${escapeAttribute(action)}" aria-label="${escapeAttribute(`${label}: ${subject}`)}"${disabledWithReason(unavailable ? "No replacement record is available." : undefined)}${unavailable || hint === undefined ? "" : ` title="${escapeAttribute(hint)}"`}>${escapeHtml(label)}</button>`;
      })
      .join("")}</div>`;
  })();

// A fix can only start against a finding that still stands. The round resolved it, the human
// rejected it, it is still waiting on that ruling, or a fix is already running: none of those is
// something to start a fix on. The screen's one primary is the next action, so this is ordinary.
const fixableFindingStates: ReadonlyArray<LongitudinalFindingState> = [
  "new", "repeated", "accepted", "regressed", "reopened",
];

const canStartFix = (finding: DirectionFinding): boolean =>
  finding.actionable &&
  fixableFindingStates.includes(finding.state) &&
  finding.fixState !== "fixRunning" &&
  finding.fixState !== "verified";

const directionFindingHtml = (finding: DirectionFinding, resolvable: boolean): string => {
  const evidence = directionEvidenceListHtml("Evidence", finding.evidence) + directionEvidenceListHtml("Challenges", finding.challenges);
  const location = findingLocationLabel(finding);
  return '<li class="direction-finding finding-' + escapeAttribute(finding.state) + '"><div><strong>' + escapeHtml(finding.subject) + '</strong><small>' + escapeHtml(findingStateLabel[finding.state] + (location.endsWith(finding.subject) ? "" : location) + (finding.occurrences > 1 ? " · seen " + String(finding.occurrences) + "×" : "")) + '</small></div><p>' + renderInline(finding.message) + '</p>' + directionSectionHtml("finding-evidence-" + finding.identity, "Evidence", evidence) + (finding.materialDelta.length > 0 ? '<p class="muted">New since last round: ' + escapeHtml(finding.materialDelta.join("; ")) + '</p>' : "") + (finding.humanResolution?.reason ? '<p class="muted">' + escapeHtml(finding.humanResolution.reason) + '</p>' : "") + (finding.fixState ? '<p class="muted">' + escapeHtml(findingFixStateLabel[finding.fixState]) + '</p>' : "") + (resolvable ? resolutionActionsHtml("finding", finding.identity, finding.subject, finding.state) : "") + '<div class="compact-actions">' + (canStartFix(finding) ? '<button data-action="finding-start-fix" data-record="' + escapeAttribute(finding.identity) + '" aria-label="Fix ' + escapeAttribute(finding.subject) + '">Fix finding</button>' : "") + '<button data-action="finding-merge" data-record="' + escapeAttribute(finding.identity) + '"' + disabledWithReason(directionMergeOptions(finding.identity).length === 0 ? "No compatible finding to merge into." : undefined) + '>Merge into…</button>' + producingRunHtml(finding.lastRunRef) + '</div></li>';
};

const directionDecisionHtml = (decision: DirectionDecision): string =>
  '<li class="direction-decision decision-' + escapeAttribute(decision.state) + '"><div><strong>' + escapeHtml(decision.subject) + '</strong><small>' + escapeHtml(labelFor(lifecycleStateLabel, decision.state) + (decision.affectedScope.length > 0 ? " · " + decision.affectedScope.join(", ") : "")) + '</small></div><p>' + escapeHtml(decision.question) + '</p>' + (decision.recommendation ? '<p>Recommendation: ' + escapeHtml(decision.recommendation) + '</p>' : "") + directionEvidenceListHtml("Options", decision.options ?? []) + (decision.tradeOffs.length > 0 ? '<p class="muted">Trade-offs: ' + escapeHtml(decision.tradeOffs.join("; ")) + '</p>' : "") + directionSectionHtml("decision-evidence-" + decision.id, "Evidence", directionEvidenceListHtml("Evidence", decision.evidence)) + (decision.reopenReason ? '<p class="muted">Reopened: ' + escapeHtml(decision.reopenReason) + '</p>' : "") + ((decision.materialEvidenceDelta ?? []).length > 0 ? '<p class="muted">New evidence: ' + escapeHtml((decision.materialEvidenceDelta ?? []).join("; ")) + '</p>' : "") + resolutionActionsHtml("decision", decision.id, decision.subject, decision.state) + producingRunHtml(decision.producedByRunRef) + '</li>';

const findingListHtml = (
  label: string,
  findings: DirectionFinding[],
  resolvable = false,
): string =>
  findings.length === 0
    ? ""
    : `<section class="direction-group"><h4>${escapeHtml(`${label} (${String(findings.length)})`)}</h4><ul>${findings.map((finding) => directionFindingHtml(finding, resolvable)).join("")}</ul></section>`;

const initiativeStatusOptions = ["active", "paused", "completed", "abandoned"];

const initiativeSwitcherHtml = (): string => {
  const longitudinal = longitudinalState();
  const initiatives = longitudinal.initiatives ?? [];
  const currentId = longitudinal.initiative?.id;
  const options = initiatives
    .map((item) => `<option value="${escapeAttribute(item.id)}"${item.id === currentId ? " selected" : ""}>${escapeHtml(`${item.title} · ${labelFor(initiativeStatusLabel, item.status)}`)}</option>`)
    .join("");
  return `<section><h4>Manage initiatives</h4>${initiatives.length === 0
    ? `<p class="muted">No initiative is recorded for this repository yet.</p>`
    : `<div class="initiative-controls"><div class="initiative-control"><label class="field"><span>Active initiative</span><select id="initiative-switch">${options}</select></label><button data-action="initiative-switch"${initiatives.length < 2 ? " disabled" : ""}>Switch</button></div><div class="initiative-control"><label class="field"><span>Status</span><select id="initiative-status">${initiativeStatusOptions.map((status) => `<option value="${status}"${longitudinal.initiative?.status === status ? " selected" : ""}>${escapeHtml(labelFor(initiativeStatusLabel, status))}</option>`).join("")}</select></label><button data-action="initiative-status">Set status</button></div></div>`}<div class="compact-actions"><button data-action="initiative-new">New initiative</button><button data-action="initiative-export"${disabledWithReason(currentId === undefined ? "There is no initiative to export." : undefined)}>Export</button><button data-action="initiative-import">Import</button></div></section>`;
};

const initiativeFormHtml = (): string => {
  const initiative = longitudinalState().initiative;
  return `<form class="direction-initiative-form" data-action="noop"><label class="field"><span>Title</span><input id="initiative-title" maxlength="200" aria-describedby="initiative-title-error" value="${escapeAttribute(initiative?.title ?? "")}"></label><div class="field-error error" id="initiative-title-error"></div><label class="field"><span>Goal</span><textarea id="initiative-goal" rows="2" maxlength="2000" aria-describedby="initiative-goal-error">${escapeHtml(initiative?.goal ?? "")}</textarea></label><div class="field-error error" id="initiative-goal-error"></div><label class="field"><span>Desired outcome</span><textarea id="initiative-outcome" rows="2" maxlength="2000">${escapeHtml(initiative?.desiredOutcome ?? "")}</textarea></label><label class="field"><span>Scope (one per line)</span><textarea id="initiative-scope" rows="2">${escapeHtml((initiative?.scope ?? []).join("\n"))}</textarea></label><label class="field"><span>Constraints (one per line)</span><textarea id="initiative-constraints" rows="2">${escapeHtml((initiative?.constraints ?? []).join("\n"))}</textarea></label><label class="field"><span>Acceptance criteria (one per line)</span><textarea id="initiative-criteria" rows="2">${escapeHtml((initiative?.acceptanceCriteria ?? []).join("\n"))}</textarea></label><div class="compact-actions"><button type="button" class="primary" data-action="initiative-save">${initiative ? "Update initiative" : "State the goal"}</button></div></form>`;
};

const cycleTypeOptions = [
  "framing", "research", "planning", "execution", "validation", "review", "debugging", "custom",
];

const EMPTY_SATURATION: DirectionSaturation = {
  saturated: false,
  quietFreshReviews: 0,
  quietReviewSignal: 2,
  signalReached: false,
  reasons: [],
};

const EMPTY_LONGITUDINAL_STATE: LongitudinalState = {
  cycles: [],
  artifacts: [],
  externalEvidence: [],
  staleExternalEvidenceIds: [],
  decisions: [],
  findings: [],
  saturation: EMPTY_SATURATION,
  direction: {
    acceptanceCriteria: [],
    constraints: [],
    acceptedArtifacts: [],
    proposedArtifacts: [],
    decisionsNeedingHuman: [],
    outstandingAcceptedFindings: [],
    unresolvedFindings: [],
    saturation: EMPTY_SATURATION,
    saturationDisclaimer: "",
    nextAction: {
      kind: "defineInitiative",
      label: "State what this work is trying to achieve",
      detail: "Bachata has no recorded goal, desired outcome, or acceptance criteria for this repository.",
    },
  },
};

const NOTIFICATION_MODE_LABELS: Array<{ value: NotificationMode; label: string }> = [
  { value: "off", label: "Off" },
  { value: "decisions", label: "Decisions only" },
  { value: "material", label: "Material events" },
  { value: "all", label: "All" },
];

const notificationActionLabel: Record<"inspect" | "discard" | "restore", string> = {
  inspect: "Inspect",
  discard: "Discard",
  restore: "Restore",
};

const notificationCenterState = (): NotificationCenterState =>
  state.manager.notifications ?? { mode: "material", unread: 0, events: [] };

/**
 * Whether direction has anything to say yet.
 *
 * Before a cycle exists there is no goal, no accepted direction, no decision waiting for a human
 * and no outstanding accepted finding. The banner then read "No goal is recorded · No accepted
 * direction · 0 decisions for you · 0 accepted findings outstanding", which is four ways of
 * saying nothing, above every idle room.
 */
const hasDirectionState = (): boolean => {
  const view = longitudinalState().direction;
  return view.goal !== undefined ||
    view.acceptedDirection !== undefined ||
    view.decisionsNeedingHuman.length > 0 ||
    view.outstandingAcceptedFindings.length > 0 ||
    view.unresolvedFindings.length > 0 ||
    (view.findingsNeedingRuling ?? []).length > 0;
};

const directionBannerHtml = (): string => {
  const view = longitudinalState().direction;
  const pending = view.decisionsNeedingHuman.length + (view.findingsNeedingRuling ?? []).length;
  if (pending === 0) return "";
  const summary = countLabel(pending, "project decision") + " to resolve";
  return '<section class="direction-banner" ' + liveRegionAttributes("direction-banner", "status", summary) + '><strong>' + escapeHtml(summary) + '</strong><button data-action="room-view" data-view="direction">Review direction</button></section>';
};

const directionBaselineLabel = (baseline: DirectionBaseline | string): string =>
  typeof baseline === "string"
    ? "Recorded repository state"
    : (baseline.branch ?? "Recorded repository state") + (baseline.dirty ? " · includes uncommitted changes" : "");

const findingFixStateLabel: Record<
  "awaitingFix" | "fixRunning" | "fixApplied" | "verified",
  string
> = {
  awaitingFix: "Pipeline accepted; no fix has started",
  fixRunning: "A bounded fix is running for this finding",
  fixApplied: "A fix was applied; a fresh review has not confirmed it yet",
  verified: "Not observed in a fresh review: model non-observation, not a deterministic check",
};

const directionMergesHtml = (): string => {
  const aliases = longitudinalState().findingAliases ?? [];
  if (aliases.length === 0) return "";
  const content = '<ul class="direction-merges">' + aliases.map((alias) =>
    '<li><strong>' + escapeHtml(directionFindingTitle(alias.aliasIdentity)) + '</strong><small>Merged into ' + escapeHtml(directionFindingTitle(alias.canonicalIdentity)) + '</small><p>' + escapeHtml(alias.reason) + '</p><button data-action="finding-unmerge" data-record="' + escapeAttribute(alias.aliasIdentity) + '" title="Keeps future findings separate; existing shared history is preserved.">Undo merge</button></li>',
  ).join("") + '</ul>';
  return directionSectionHtml("direction-merges", "Merged findings (" + String(aliases.length) + ")", content);
};

const reconciliationKindLabel: Record<
  "ambiguous" | "split" | "conflict",
  string
> = {
  ambiguous: "Ambiguous match",
  split: "Two findings map to one earlier finding",
  conflict: "Matches a finding you rejected",
};


const externalEvidenceRelationLabel: Record<string, string> = {
  supports: "supports",
  contradicts: "contradicts",
  qualifies: "qualifies",
};

const externalEvidenceTargetLabel = (target: DirectionExternalEvidence["target"]): string => {
  const longitudinal = longitudinalState();
  return target.kind === "artifact"
    ? [...longitudinal.artifacts, ...longitudinal.direction.acceptedArtifacts, ...longitudinal.direction.proposedArtifacts].find((item) => item.id === target.artifactId)?.title ?? "Earlier artifact"
    : target.kind === "decision"
      ? directionDecisionTitle(target.decisionId)
      : target.kind === "finding"
        ? directionFindingTitle(target.identity)
        : "this initiative";
};

const directionExternalEvidenceHtml = (record: DirectionExternalEvidence, stale: boolean): string => {
  const verification = record.verification;
  const provenance = verification
    ? '<p>' + escapeHtml(verification.requirement) + '</p><p class="muted">' + escapeHtml(verification.kind + " · " + verification.verifier + " · " + verification.environment) + '</p>'
    : "";
  return '<li class="direction-evidence evidence-' + escapeAttribute(record.state) + '"><div><strong>' + escapeHtml(record.source.title) + '</strong><small>' + escapeHtml((externalEvidenceRelationLabel[record.relation] ?? record.relation) + " " + externalEvidenceTargetLabel(record.target) + " · " + labelFor(lifecycleStateLabel, record.state)) + '</small></div><p>' + escapeHtml(record.claim) + '</p>' + (verification ? '<p>Verification: ' + escapeHtml(verification.outcome) + '</p>' + directionSectionHtml("verification-" + record.id, "Verification details", provenance) : "") + '<p class="muted" title="' + escapeAttribute("Retrieved " + formatDateTime(record.source.retrievedAt)) + '">' + escapeHtml(record.source.uri) + '</p>' + (stale ? '<p class="direction-drift">Outdated source. Refresh or replace it before relying on it.</p>' : "") + directionEvidenceListHtml("Challenges", record.challenges.map((challenge) => challenge.text)) + (record.humanResolution?.reason ? '<p class="muted">' + escapeHtml(record.humanResolution.reason) + '</p>' : "") + resolutionActionsHtml("externalEvidence", record.id, record.source.title, record.state, verification ? "Resolve the linked finding only when repository state and scope still match." : undefined) + '</li>';
};

const directionExternalEvidenceSectionHtml = (): string => {
  const longitudinal = longitudinalState();
  const records = (longitudinal.externalEvidence ?? []).filter((record) => record.supersededById === undefined);
  if (records.length === 0) return "";
  const stale = new Set(longitudinal.staleExternalEvidenceIds ?? []);
  return '<section><h3>External evidence</h3><ul class="direction-evidence-list">' + records.map((record) => directionExternalEvidenceHtml(record, stale.has(record.id))).join("") + '</ul></section>';
};

const directionReconciliationHtml = (view: DirectionSummary): string => {
  const questions = view.reconciliationQuestions ?? [];
  if (questions.length === 0) return "";
  return '<section class="direction-reconciliation" data-direction-section="findings"><h3>Possible duplicate findings</h3><ul>' + questions.map((item) =>
    '<li><div><strong>' + escapeHtml(item.subject) + '</strong><small>' + escapeHtml(reconciliationKindLabel[item.kind]) + '</small></div><p>' + escapeHtml(item.detail) + '</p>' + (item.candidates.length === 0 ? "" : '<ul class="direction-reconciliation-candidates">' + item.candidates.map((candidate) => '<li><span>' + escapeHtml(candidate.subject) + '</span><small>' + escapeHtml(matchScoreLabel(candidate.score)) + '</small><button data-action="finding-merge" data-record="' + escapeAttribute(item.freshIdentity) + '" data-candidate="' + escapeAttribute(candidate.identity) + '" aria-label="Merge ' + escapeAttribute(item.subject) + ' into ' + escapeAttribute(candidate.subject) + '">Merge into this</button></li>').join("") + '</ul>') + '</li>',
  ).join("") + '</ul></section>';
};

const directionCandidateHtml = (view: DirectionSummary): string => {
  const baseline = view.baseline;
  const drift = view.baselineDrift ?? [];
  const verification = view.verification;
  if (!baseline && !verification && !view.currentBaseline) return "";
  const candidate = baseline ? '<p>' + escapeHtml(directionBaselineLabel(baseline)) + '</p>' : "";
  const driftHtml = drift.length === 0
    ? (baseline ? '<p class="muted">Repository unchanged since this cycle started.</p>' : "")
    : '<p class="direction-drift">Repository changed. Refresh the baseline and checks before relying on this cycle.</p>';
  const checks = !verification
    ? '<p class="muted">No checks recorded.</p>'
    : verification.checks.length === 0
      ? '<p class="muted">' + (verification.expected ? "Required checks were not recorded." : "No checks recorded.") + '</p>'
      : '<ul class="direction-checks">' + verification.checks.map((check) => '<li><code>' + escapeHtml(check.command) + '</code><small>' + escapeHtml(labelFor(checkStatusLabel, check.status) + (check.stale === true || drift.length > 0 ? " · stale" : "")) + '</small></li>').join("") + '</ul>';
  return candidate + driftHtml + checks + '<button data-action="cycle-rebaseline">Refresh baseline</button>';
};

const directionArtifactHtml = (artifact: DirectionArtifact): string =>
  '<li><strong>' + escapeHtml(artifact.title) + '</strong><small>' + escapeHtml(artifact.type + " · revision " + String(artifact.revision) + " · " + labelFor(lifecycleStateLabel, artifact.state)) + '</small>' + (artifact.body ? '<div class="markdown direction-artifact-body">' + renderMarkdown(artifact.body) + '</div>' : "") + directionSectionHtml("artifact-evidence-" + artifact.id, "Evidence", directionEvidenceListHtml("Evidence", artifact.evidence ?? [])) + producingRunHtml(artifact.producedByRunRef) + resolutionActionsHtml("artifact", artifact.id, artifact.title, artifact.state) + '</li>';

const nextActionButtonLabels: Record<string, string> = {
  defineInitiative: "Define the goal",
  resolveDecisions: "Resolve decisions",
  reviewRegressions: "Review regressions",
  ruleOnFindings: "Rule on findings",
  reconcileFindings: "Reconcile findings",
  fixAcceptedFindings: "Fix accepted findings",
  rebaseline: "Rebaseline cycle",
  runRequiredChecks: "Run checks",
  freshReview: "Start fresh review",
  closeCycle: "Close cycle",
  startCycle: "Start cycle",
};

const nextActionButtonLabel = (nextAction: { kind: string; label: string }): string =>
  nextActionButtonLabels[nextAction.kind] ?? nextAction.label;

const directionSupportHtml = (): string => {
  const accepted = (longitudinalState().direction.decisionHistory ?? [])
    .filter((decision) => decision.state === "accepted");
  if (accepted.length === 0) return "";
  return `<fieldset class="direction-support"><legend>Which accepted decisions support this direction?</legend>${accepted.map((decision) => `<label class="check-field"><input type="checkbox" data-direction-support="${escapeAttribute(decision.id)}"> ${escapeHtml(decision.subject)}</label>`).join("")}</fieldset>`;
};

const directionRevisionsHtml = (
  revisions: Array<{
    revision: number;
    text: string;
    author: string;
    recordedAt: string;
    rationale?: string;
    supportingDecisionIds?: string[];
    evidence?: string[];
  }>,
): string => revisions.length === 0 ? "" : '<section><h4>Direction revisions</h4><ol class="direction-revision-list">' + [...revisions].reverse().map((entry) =>
  '<li title="' + escapeAttribute(formatDateTime(entry.recordedAt)) + '"><small>' + escapeHtml("Revision " + String(entry.revision) + " · " + entry.author) + '</small><p>' + escapeHtml(entry.text) + '</p>' + (entry.rationale ? '<p class="muted">' + escapeHtml(entry.rationale) + '</p>' : "") + ((entry.supportingDecisionIds ?? []).length > 0 ? '<p class="muted">Supported by: ' + escapeHtml((entry.supportingDecisionIds ?? []).map(directionDecisionTitle).join("; ")) + '</p>' : "") + directionEvidenceListHtml("Evidence", entry.evidence ?? []) + '</li>',
).join("") + '</ol></section>';

const semanticHistoryHtml = (): string => {
  const longitudinal = longitudinalState();
  const view = longitudinal.direction;
  const decisions = view.decisionHistory ?? [];
  const findings = view.findingHistory ?? [];
  const query = state.historyFilter.trim().toLowerCase();
  const matches = (haystack: string[]): boolean => query.length === 0 || haystack.some((item) => item.toLowerCase().includes(query));
  const shownFindings = findings.filter((entry) => matches([entry.subject, entry.message, entry.state]));
  const shownDecisions = decisions.filter((entry) => matches([entry.subject, entry.question, entry.state]));
  const records = decisions.length + findings.length === 0 ? "" :
    '<label class="field"><span>Search history</span><input id="history-filter" data-action="history-filter" value="' + escapeAttribute(state.historyFilter) + '" placeholder="Subject, message, or state"></label>' +
    (decisions.length === 0 ? "" : '<section class="direction-group"><h4>Decisions (' + String(shownDecisions.length) + ')</h4>' + (shownDecisions.length === 0 ? '<p class="muted">No matching decisions.</p>' : '<ul>' + shownDecisions.map(historyDecisionHtml).join("") + '</ul>') + '</section>') +
    (findings.length === 0 ? "" : '<section class="direction-group"><h4>Findings (' + String(shownFindings.length) + ')</h4>' + (shownFindings.length === 0 ? '<p class="muted">No matching findings.</p>' : '<ul>' + shownFindings.map(historyFindingHtml).join("") + '</ul>') + '</section>');
  const cycles = longitudinal.cycles.length === 0 ? "" :
    '<section><h4>Cycles</h4><ul class="direction-cycles">' + longitudinal.cycles.map((item) => '<li><strong>' + escapeHtml("Cycle " + String(item.sequence) + " · " + labelFor(cycleTypeLabel, item.type)) + '</strong><small>' + escapeHtml(labelFor(cycleCompletionLabel, item.completion) + " · " + countLabel(item.runRefs.length, "run")) + '</small>' + (item.nextCycleTrigger ? '<p class="muted">' + escapeHtml(item.nextCycleTrigger) + '</p>' : "") + '</li>').join("") + '</ul></section>';
  const retiredArtifacts = longitudinal.artifacts.filter((item) => item.state === "superseded" || item.state === "rejected" || item.state === "deferred");
  const artifacts = retiredArtifacts.length === 0 ? "" : '<section><h4>Earlier artifacts</h4><ul class="direction-artifacts">' + retiredArtifacts.map(directionArtifactHtml).join("") + '</ul></section>';
  return directionSectionHtml("direction-semantic-history", "History", records + directionRevisionsHtml(view.directionRevisions ?? []) + cycles + artifacts, false, "direction-semantic-history");
};

const directionHtml = (): string => {
  const longitudinal = longitudinalState();
  const view = longitudinal.direction;
  const cycle = view.currentCycle;
  const artifactRecords = new Map(longitudinal.artifacts.map((item) => [item.id, item]));
  const accepted = (view.acceptedArtifacts ?? []).map((item) => artifactRecords.get(item.id) ?? item).filter((item) => item.state === "accepted");
  const proposed = (view.proposedArtifacts ?? []).map((item) => artifactRecords.get(item.id) ?? item).filter((item) => item.state === "proposed");
  const pendingFindings = view.findingsNeedingRuling ?? [];
  const shownFindingIds = new Set([...pendingFindings, ...view.outstandingAcceptedFindings, ...view.unresolvedFindings].map((item) => item.identity));
  const comparison = view.latestChange;
  const changes = comparison ? [
    findingListHtml("New findings", comparison.newMaterial.filter((item) => !shownFindingIds.has(item.identity))),
    findingListHtml("Regressions", comparison.regressed.filter((item) => !shownFindingIds.has(item.identity))),
    findingListHtml("Reopened", comparison.reopened.filter((item) => !shownFindingIds.has(item.identity))),
    findingListHtml("Resolved", comparison.resolved),
    findingListHtml("Not observed this round", (comparison.notObserved ?? []).filter((item) => !shownFindingIds.has(item.identity))),
    comparison.decisionChanges.length === 0 ? "" : '<section><h4>Decision changes</h4><ul>' + comparison.decisionChanges.map((item) => '<li><strong>' + escapeHtml(item.subject) + '</strong><small>' + escapeHtml((item.from === undefined ? "New" : labelFor(lifecycleStateLabel, item.from)) + " → " + labelFor(lifecycleStateLabel, item.to)) + '</small>' + (item.reason ? '<p class="muted">' + escapeHtml(item.reason) + '</p>' : "") + '</li>').join("") + '</ul></section>',
  ].join("") : "";
  const goalDetails = (view.desiredOutcome ? '<p>' + escapeHtml(view.desiredOutcome) + '</p>' : "") +
    directionEvidenceListHtml("Acceptance criteria", view.acceptanceCriteria) +
    (view.constraints.length > 0 ? '<p class="muted">Constraints: ' + escapeHtml(view.constraints.join("; ")) + '</p>' : "");
  const directionEdit = '<label class="field"><span>Accepted direction</span><textarea id="initiative-direction" rows="2" maxlength="4000" aria-describedby="initiative-direction-error">' + escapeHtml(view.acceptedDirection ?? "") + '</textarea></label><div class="field-error error" id="initiative-direction-error"></div><label class="field"><span>Rationale (optional)</span><input id="initiative-direction-rationale" maxlength="500" value="' + escapeAttribute(state.directionRationale) + '"></label>' + directionSupportHtml() + '<label class="field"><span>Evidence, one per line (optional)</span><textarea id="initiative-direction-evidence" rows="2">' + escapeHtml(state.directionEvidence) + '</textarea></label><button data-action="initiative-direction-save"' + disabledWithReason(view.goal === undefined ? "Record a goal before accepting a direction." : undefined) + '>Save direction</button>';
  const review = cycle ? '<section><h3>Review progress</h3><p class="muted">' + escapeHtml("Cycle " + String(cycle.sequence) + " · " + labelFor(cycleTypeLabel, cycle.type) + " · " + labelFor(cycleCompletionLabel, cycle.completion)) + '</p>' +
    (changes || (comparison ? '<p class="muted">No additional material changes.</p>' : "")) +
    '<p class="' + (view.saturation.saturated ? "direction-saturated" : "direction-quiet-reviews") + '" title="' + escapeAttribute(view.saturationDisclaimer || "Repeated reviews without new findings do not prove correctness.") + '">' + escapeHtml(view.quietReviewStatement || String(view.saturation.quietFreshReviews) + " fresh reviews found no material change.") + '</p>' +
    (view.saturation.reasons.length > 0 ? '<p class="muted">' + escapeHtml(sentenceJoin(view.saturation.reasons)) + '</p>' : "") +
    '<div class="compact-actions"><button data-action="review-fresh">Fresh review</button><select id="cycle-type" aria-label="Next cycle type">' + cycleTypeOptions.map((option) => '<option value="' + option + '"' + (cycle.type === option ? " selected" : "") + '>' + escapeHtml(labelFor(cycleTypeLabel, option)) + '</option>').join("") + '</select><button data-action="cycle-start">New cycle</button><button data-action="cycle-close"' + disabledWithReason(cycle.completion !== "open" ? "No open cycle to close." : undefined) + '>Close cycle</button></div></section>' : "";
  const attention = (view.decisionsNeedingHuman.length > 0 ? '<section data-direction-section="decisions"><h3>Decisions to resolve</h3><ul>' + view.decisionsNeedingHuman.map(directionDecisionHtml).join("") + '</ul></section>' : "") +
    (pendingFindings.length > 0 ? '<section data-direction-section="findings"><h3>Findings to resolve</h3><ul>' + pendingFindings.map((item) => directionFindingHtml(item, true)).join("") + '</ul></section>' : "") +
    directionReconciliationHtml(view) +
    findingListHtml("Accepted findings to fix", view.outstandingAcceptedFindings, true) +
    findingListHtml("Open findings", view.unresolvedFindings.filter((item) => !pendingFindings.some((pending) => pending.identity === item.identity)), true);
  const artifacts = accepted.length + proposed.length === 0 ? "" : '<section><h3>Artifacts</h3>' +
    (proposed.length > 0 ? '<h4>Proposed</h4><ul class="direction-artifacts proposed">' + proposed.map(directionArtifactHtml).join("") + '</ul>' : "") +
    (accepted.length > 0 ? '<h4>Accepted</h4><ul class="direction-artifacts accepted">' + accepted.map(directionArtifactHtml).join("") + '</ul>' : "") + '</section>';
  const stale = (longitudinal.staleRuns ?? []).length === 0 ? "" : '<section class="direction-stale"><h3>Outdated checks</h3><p>' + escapeHtml(countLabel((longitudinal.staleRuns ?? []).length, "run") + " checked an earlier repository state.") + '</p><div class="compact-actions">' + (longitudinal.staleRuns ?? []).map((item, index) => '<button data-action="open-producing-run" data-run="' + escapeAttribute(item.runRef) + '" title="' + escapeAttribute(formatDateTime(item.recordedAt)) + '">Review earlier run ' + String(index + 1) + '</button>').join("") + '</div></section>';
  const failures = (longitudinal.validationErrors ?? []).length === 0 ? "" : '<section class="direction-failures" role="alert"><h3>Some changes could not be saved</h3><ul>' + (longitudinal.validationErrors ?? []).map((item) => '<li>' + escapeHtml(item) + '</li>').join("") + '</ul></section>';
  return '<section class="direction-center"><header><div><span class="decision-label">Project direction</span><h2>' + escapeHtml(view.goal ?? "Define the goal") + '</h2></div></header>' +
    (view.goal ? '<section class="direction-next"><button class="primary" data-action="direction-next-action" title="' + escapeAttribute(view.nextAction.detail ?? "") + '">' + escapeHtml(nextActionButtonLabel(view.nextAction)) + '</button></section>' : "") +
    failures + attention +
    (view.acceptedDirection ? '<section><h3>Accepted direction</h3><p>' + escapeHtml(view.acceptedDirection) + '</p></section>' : "") +
    goalDetails + review + stale + artifacts + directionExternalEvidenceSectionHtml() +
    directionSectionHtml("direction-candidate", "Repository and checks", directionCandidateHtml(view), (view.baselineDrift ?? []).length > 0) +
    (view.goal ? directionSectionHtml("direction-edit", view.acceptedDirection ? "Edit direction" : "Set direction", directionEdit, false, "direction-edit") : "") +
    directionSectionHtml("direction-initiative", view.goal ? "Initiative settings" : "Initiative", initiativeFormHtml() + initiativeSwitcherHtml(), view.goal === undefined, "direction-initiative") +
    directionMergesHtml() + semanticHistoryHtml() + '</section>';
};
