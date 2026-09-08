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

// A finding identity is a content hash, not a name. It stays visible because merges and the
// history filter are addressed by it, but it reads as metadata and keeps the full value in
// reach rather than spending a line on 26 characters of hex.
const shortIdentity = (identity: string): string =>
  identity.length > 12 ? `${identity.slice(0, 12)}\u2026` : identity;

const identityHtml = (identity: string): string =>
  `<small class="finding-identity muted" title="${escapeAttribute(`Finding identity ${identity}`)}">${escapeHtml(`ID ${shortIdentity(identity)}`)}</small>`;

const matchScoreLabel = (score: number): string => {
  const percent = Math.round(score * 100);
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
  const provenance = [
    finding.firstCycleId ? `first seen in cycle ${finding.firstCycleId}` : undefined,
    finding.lastCycleId ? `last seen in cycle ${finding.lastCycleId}` : undefined,
    finding.lastRunRef ? `run ${finding.lastRunRef}` : undefined,
  ].filter((item) => item !== undefined).join(" · ");
  const runLink = finding.lastRunRef
    ? `<button data-action="open-producing-run" data-run="${escapeAttribute(finding.lastRunRef)}" aria-label="Open the run that produced ${escapeAttribute(finding.subject)}">Open the run that produced this</button>`
    : "";
  const location = finding.location
    ? `<button data-action="reveal-finding" data-file="${escapeAttribute(finding.location.file)}"${finding.location.startLine === undefined ? "" : ` data-line="${escapeAttribute(String(finding.location.startLine))}"`}>Open ${escapeHtml(finding.location.file)}</button>`
    : "";
  return `<li class="direction-history-record finding-${escapeAttribute(finding.state)}"><div><strong>${escapeHtml(finding.subject)}</strong><small>${escapeHtml(`${findingStateLabel[finding.state]}${finding.fixState ? ` · ${findingFixStateLabel[finding.fixState]}` : ""} · seen ${String(finding.occurrences)}×${provenance ? ` · ${provenance}` : ""}`)}</small></div><p>${escapeHtml(finding.message)}</p>${finding.evidence.length > 0 ? `<details><summary>Evidence (${String(finding.evidence.length)})</summary><ul>${finding.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : `<p class="muted">No evidence was recorded.</p>`}${finding.challenges.length > 0 ? `<details><summary>Challenges (${String(finding.challenges.length)})</summary><ul>${finding.challenges.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : ""}${finding.humanResolution ? `<p class="muted">${escapeHtml(`${finding.humanResolution.action} by ${finding.humanResolution.resolvedBy}${finding.humanResolution.reason ? `: ${finding.humanResolution.reason}` : ""}`)}</p>` : ""}${resolutionHistoryHtml(finding.resolutionHistory)}<div class="compact-actions">${runLink}${location}${resolutionActionsHtml("finding", finding.identity, finding.subject, finding.state)}</div>${identityHtml(finding.identity)}</li>`;
};

const historyDecisionHtml = (decision: DirectionDecision): string => {
  const chain = [
    decision.supersedesId ? `supersedes ${decision.supersedesId}` : undefined,
    decision.supersededById ? `superseded by ${decision.supersededById}` : undefined,
  ].filter((item) => item !== undefined).join(" · ");
  const runLink = decision.producedByRunRef
    ? `<button data-action="open-producing-run" data-run="${escapeAttribute(decision.producedByRunRef)}" aria-label="Open the run that produced ${escapeAttribute(decision.subject)}">Open the run that produced this</button>`
    : "";
  return `<li class="direction-history-record decision-${escapeAttribute(decision.state)}"><div><strong>${escapeHtml(decision.subject)}</strong><small>${escapeHtml(`${labelFor(lifecycleStateLabel, decision.state)} · revision ${String(decision.revision ?? 1)}${decision.affectedScope.length > 0 ? ` · ${decision.affectedScope.join(", ")}` : ""}${chain ? ` · ${chain}` : ""}`)}</small></div><p>${escapeHtml(decision.question)}</p>${(decision.options ?? []).length > 0 ? `<details><summary>Options (${String((decision.options ?? []).length)})</summary><ul>${(decision.options ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : `<p class="muted">No options were supplied.</p>`}${decision.tradeOffs.length > 0 ? `<p class="muted">Trade-offs: ${escapeHtml(decision.tradeOffs.join("; "))}</p>` : ""}${decision.recommendation ? `<p class="muted">Recommendation: ${escapeHtml(decision.recommendation)}</p>` : `<p class="muted">No recommendation was supplied.</p>`}${decision.evidence.length > 0 ? `<details><summary>Evidence (${String(decision.evidence.length)})</summary><ul>${decision.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></details>` : `<p class="muted">No evidence was recorded.</p>`}${decision.reopenReason ? `<p class="muted">Reopened: ${escapeHtml(decision.reopenReason)}</p>` : ""}${decision.humanResolution ? `<p class="muted">${escapeHtml(`${decision.humanResolution.action} by ${decision.humanResolution.resolvedBy}${decision.humanResolution.reason ? `: ${decision.humanResolution.reason}` : ""}`)}</p>` : ""}${resolutionHistoryHtml(decision.resolutionHistory)}<div class="compact-actions">${runLink}${resolutionActionsHtml("decision", decision.id, decision.subject, decision.state)}</div></li>`;
};

// A surfaced judgment states what it rests on. Where the workflow supplied nothing, the
// card says so rather than looking complete.
// Provenance is chosen, never inferred: the accepted decisions offered here are ticked by
// the human, and evidence is what they wrote.

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
        const hint = resolutionActionHint[action];
        return `<button data-action="resolve-record" data-target="${target}" data-record="${escapeAttribute(id)}" data-resolution="${escapeAttribute(action)}" aria-label="${escapeAttribute(`${label}: ${subject}`)}"${hint === undefined ? "" : ` title="${escapeAttribute(hint)}"`}>${escapeHtml(label)}</button>`;
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

const directionFindingHtml = (finding: DirectionFinding, resolvable: boolean): string =>
  `<li class="direction-finding finding-${escapeAttribute(finding.state)}"><div><strong>${escapeHtml(finding.subject)}</strong><small>${escapeHtml(`${findingStateLabel[finding.state]}${findingLocationLabel(finding).endsWith(finding.subject) ? "" : findingLocationLabel(finding)} · seen ${String(finding.occurrences)}×`)}</small></div><p>${renderInline(finding.message)}</p>${judgementEvidenceHtml("Evidence", finding.evidence)}${judgementEvidenceHtml("Challenges", finding.challenges)}${producingRunHtml(finding.lastRunRef)}${finding.materialDelta.length > 0 ? `<p class="muted">New since last round: ${escapeHtml(finding.materialDelta.join("; "))}</p>` : ""}${finding.humanResolution ? `<p class="muted">${escapeHtml(`${finding.humanResolution.action} by ${finding.humanResolution.resolvedBy}${finding.humanResolution.reason ? `: ${finding.humanResolution.reason}` : ""}`)}</p>` : ""}${finding.fixState ? `<p class="muted">${escapeHtml(findingFixStateLabel[finding.fixState])}</p>` : ""}${resolvable ? resolutionActionsHtml("finding", finding.identity, finding.subject, finding.state) : ""}<div class="compact-actions">${canStartFix(finding) ? `<button data-action="finding-start-fix" data-record="${escapeAttribute(finding.identity)}" aria-label="Fix ${escapeAttribute(finding.subject)}">Fix this finding</button>` : ""}<button data-action="finding-merge" data-record="${escapeAttribute(finding.identity)}" aria-label="Merge ${escapeAttribute(finding.subject)} into another finding">Merge into…</button></div>${identityHtml(finding.identity)}</li>`;

const directionDecisionHtml = (decision: DirectionDecision): string =>
  `<li class="direction-decision decision-${escapeAttribute(decision.state)}"><div><strong>${escapeHtml(decision.subject)}</strong><small>${escapeHtml(labelFor(lifecycleStateLabel, decision.state))}${(decision.revision ?? 1) > 1 ? ` · revision ${String(decision.revision)}` : ""}${decision.affectedScope.length > 0 ? ` · ${escapeHtml(decision.affectedScope.join(", "))}` : ""}</small></div><p>${escapeHtml(decision.question)}</p>${decision.recommendation ? `<p class="muted">Recommendation: ${escapeHtml(decision.recommendation)}</p>` : `<p class="muted">No recommendation was supplied.</p>`}${judgementEvidenceHtml("Options", decision.options ?? [])}${decision.tradeOffs.length > 0 ? `<p class="muted">Trade-offs: ${escapeHtml(decision.tradeOffs.join("; "))}</p>` : ""}${judgementEvidenceHtml("Evidence", decision.evidence)}${producingRunHtml(decision.producedByRunRef)}${decision.affectedScope.length === 0 ? `<p class="muted">No affected scope was recorded.</p>` : ""}${decision.reopenReason ? `<p class="muted">Reopened: ${escapeHtml(decision.reopenReason)}</p>` : ""}${(decision.materialEvidenceDelta ?? []).length > 0 ? `<p class="muted">Material evidence delta: ${escapeHtml((decision.materialEvidenceDelta ?? []).join("; "))}</p>` : ""}${resolutionActionsHtml("decision", decision.id, decision.subject, decision.state)}</li>`;

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
  return `<section><h3>Which initiative is this?</h3>${initiatives.length === 0
    ? `<p class="muted">No initiative is recorded for this repository yet.</p>`
    : `<div class="compact-actions"><select id="initiative-switch" aria-label="Active initiative">${options}</select><button data-action="initiative-switch"${initiatives.length < 2 ? " disabled" : ""}>Switch</button><select id="initiative-status" aria-label="Initiative status">${initiativeStatusOptions.map((status) => `<option value="${status}"${longitudinal.initiative?.status === status ? " selected" : ""}>${escapeHtml(labelFor(initiativeStatusLabel, status))}</option>`).join("")}</select><button data-action="initiative-status">Set status</button></div>`}<div class="compact-actions"><button data-action="initiative-new">New initiative</button><button data-action="initiative-export"${disabledWithReason(currentId === undefined ? "There is no initiative to export." : undefined)}>Export</button><button data-action="initiative-import">Import</button></div><p class="muted">Initiative state is local to this workspace. Import creates separate initiative state and does not combine or synchronise it.</p></section>`;
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
  if (!hasDirectionState()) {
    return "";
  }
  const view = longitudinalState().direction;
  const pending = view.decisionsNeedingHuman.length;
  const outstanding = view.outstandingAcceptedFindings.length;
  const summary = `${view.goal ?? "No goal is recorded"} · ${view.acceptedDirection ?? "No accepted direction"} · ${String(pending)} decision${pending === 1 ? "" : "s"} for you · ${String(outstanding)} accepted finding${outstanding === 1 ? "" : "s"} outstanding`;
  return `<section class="direction-banner" ${liveRegionAttributes("direction-banner", "status", summary)}><div><strong>${escapeHtml(view.goal ?? "No goal is recorded")}</strong><small>${escapeHtml(`${view.acceptedDirection ?? "No accepted direction"} · ${String(pending)} decision${pending === 1 ? "" : "s"} for you · ${String(outstanding)} accepted finding${outstanding === 1 ? "" : "s"} outstanding`)}</small></div><div class="compact-actions"><button class="primary" data-action="direction-next-action">${escapeHtml(view.nextAction.label)}</button><button data-action="room-view" data-view="direction">Open direction</button></div></section>`;
};

const directionBaselineLabel = (baseline: DirectionBaseline | string): string => {
  if (typeof baseline === "string") return baseline.slice(0, 12) || "unborn";
  const commit = typeof baseline.commit === "string" ? baseline.commit.slice(0, 12) : "";
  return `${baseline.branch ?? "detached"}@${commit || "unborn"}${baseline.dirty ? " +uncommitted" : ""}`;
};

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
  return `<section><h3>Which findings are folded together?</h3><ul class="direction-merges">${aliases
    .map((alias) => `<li><div><strong>${escapeHtml(alias.aliasIdentity)}</strong><small>${escapeHtml(`merged into ${alias.canonicalIdentity} by ${alias.createdBy === "controller" ? "Bachata" : alias.createdBy}`)}</small></div><p>${escapeHtml(alias.reason)}</p><div class="compact-actions"><button data-action="finding-unmerge" data-record="${escapeAttribute(alias.aliasIdentity)}">Undo merge</button></div></li>`)
    .join("")}</ul><p class="muted">Bachata folds a clear match on its own and records why. Undoing a merge stops future rounds from folding the two together. It does not split the history they already share.</p></section>`;
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

const externalEvidenceTargetLabel = (
  target: DirectionExternalEvidence["target"],
): string =>
  target.kind === "artifact"
    ? `artifact ${target.artifactId ?? ""}`
    : target.kind === "decision"
      ? `decision ${target.decisionId ?? ""}`
      : target.kind === "finding"
        ? `finding ${target.identity ?? ""}`
        : "this initiative";

const directionExternalEvidenceHtml = (
  record: DirectionExternalEvidence,
  stale: boolean,
): string =>
  `<li class="direction-evidence evidence-${escapeAttribute(record.state)}"><div><strong>${escapeHtml(record.source.title)}</strong><small>${escapeHtml(`${externalEvidenceRelationLabel[record.relation] ?? record.relation} ${externalEvidenceTargetLabel(record.target)} · ${record.authority} · revision ${String(record.revision)} · ${labelFor(lifecycleStateLabel, record.state)}`)}</small></div><p>${escapeHtml(record.claim)}</p><p class="muted">${escapeHtml(`${record.source.uri} · retrieved ${formatDateTime(record.source.retrievedAt)} · digest ${record.source.contentDigest.slice(0, 12)}`)}</p>${stale ? `<p class="muted" ${liveRegionAttributes(`direction-evidence-stale:${record.id}`, "status", "stale")}>Past its freshness horizon. Retrieve it again or supersede it; Bachata will not treat it as current.</p>` : ""}${record.challenges.length > 0 ? `<ul class="direction-evidence-challenges">${record.challenges.map((challenge) => `<li>${escapeHtml(challenge.text)}<small>${escapeHtml(challenge.participantIds.join(", "))}</small></li>`).join("")}</ul>` : ""}${record.humanResolution ? `<p class="muted">${escapeHtml(`${record.humanResolution.action} by ${record.humanResolution.resolvedBy}${record.humanResolution.reason ? `: ${record.humanResolution.reason}` : ""}`)}</p>` : ""}${resolutionActionsHtml("externalEvidence", record.id, record.source.title, record.state)}</li>`;

const directionExternalEvidenceSectionHtml = (): string => {
  const longitudinal = longitudinalState();
  const records = (longitudinal.externalEvidence ?? [])
    .filter((record) => record.supersededById === undefined);
  const stale = new Set(longitudinal.staleExternalEvidenceIds ?? []);
  return `<section><h3>What evidence came from outside this repository?</h3>${records.length === 0
    ? `<p class="muted">No external evidence has been recorded. A claim this repository cannot settle belongs here, with its source and the date it was retrieved.</p>`
    : `<ul class="direction-evidence-list">${records
      .map((record) => directionExternalEvidenceHtml(record, stale.has(record.id)))
      .join("")}</ul>`}</section>`;
};

const directionReconciliationHtml = (view: DirectionSummary): string => {
  const questions = view.reconciliationQuestions ?? [];
  if (questions.length === 0) return "";
  return `<section class="direction-reconciliation"><h3>Which findings need an identity decision?</h3><ul>${questions
    .map((item) => `<li><div><strong>${escapeHtml(item.subject)}</strong><small>${escapeHtml(`${reconciliationKindLabel[item.kind]} · ${shortIdentity(item.freshIdentity)}`)}</small></div><p>${escapeHtml(item.detail)}</p>${item.candidates.length === 0 ? "" : `<ul class="direction-reconciliation-candidates">${item.candidates.map((candidate) => `<li><small>${escapeHtml(`${candidate.subject} · ${shortIdentity(candidate.identity)} · ${matchScoreLabel(candidate.score)}`)}</small><button data-action="finding-merge" data-record="${escapeAttribute(item.freshIdentity)}" data-candidate="${escapeAttribute(candidate.identity)}" aria-label="Merge ${escapeAttribute(item.subject)} into ${escapeAttribute(candidate.subject)}">Merge into this</button></li>`).join("")}</ul>`}</li>`)
    .join("")}</ul><p class="muted">Bachata merged every clear match on its own. These are the mappings it could not settle without you. Leaving them separate is a valid answer.</p></section>`;
};

const directionCandidateHtml = (view: DirectionSummary): string => {
  const baseline = view.baseline;
  const drift = view.baselineDrift ?? [];
  const verification = view.verification;
  const candidate = baseline === undefined
    ? `<p class="muted">This cycle has no recorded repository candidate. Start or rebaseline a cycle to bind one.</p>`
    : `<p>Candidate: <code>${escapeHtml(directionBaselineLabel(baseline))}</code></p>`;
  const driftHtml = drift.length === 0
    ? (baseline === undefined
        ? ""
        : `<p class="muted">The repository still matches this candidate.</p>`)
    : `<p class="direction-drift" ${liveRegionAttributes("direction-drift", "status", drift.join("; "))}>${escapeHtml(drift.join("; "))}</p>`;
  const checks = verification === undefined
    ? `<p class="muted">No check has been recorded against this cycle.</p>`
    : verification.checks.length === 0
      ? `<p class="muted">${escapeHtml(`Run ${verification.runRef} recorded no check${verification.expected ? ", although the pipeline expected verification" : ""}.`)}</p>`
      : `<ul class="direction-checks">${verification.checks.map((check) => `<li><code>${escapeHtml(check.command)}</code><small>${escapeHtml(`${labelFor(checkStatusLabel, check.status)}${check.stale === true || drift.length > 0 ? " · stale" : ""}`)}</small></li>`).join("")}</ul>`;
  return `<section><h3>Which repository state is this cycle about?</h3>${candidate}${driftHtml}${checks}<div class="compact-actions"><button data-action="cycle-rebaseline"${disabledWithReason(baseline === undefined && view.currentBaseline === undefined ? "No repository baseline has been recorded for this cycle yet." : undefined)}>Rebaseline this cycle</button></div></section>`;
};

const directionArtifactHtml = (artifact: DirectionArtifact): string =>
  `<li><strong>${escapeHtml(artifact.title)}</strong><small>${escapeHtml(`${artifact.type} · revision ${String(artifact.revision)} · ${labelFor(lifecycleStateLabel, artifact.state)}`)}</small>${artifact.body ? `<div class="markdown direction-artifact-body">${renderMarkdown(artifact.body)}</div>` : ""}${judgementEvidenceHtml("Evidence", artifact.evidence ?? [])}${producingRunHtml(artifact.producedByRunRef)}${resolutionActionsHtml("artifact", artifact.id, artifact.title, artifact.state)}</li>`;

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
): string => {
  if (revisions.length === 0) return "";
  const entryHtml = (entry: {
    revision: number;
    text: string;
    author: string;
    recordedAt: string;
    rationale?: string;
    supportingDecisionIds?: string[];
    evidence?: string[];
  }): string =>
    `<li><small>${escapeHtml(`Revision ${String(entry.revision)} · ${entry.author} · ${formatDateTime(entry.recordedAt)}`)}</small><p>${escapeHtml(entry.text)}</p>${entry.rationale ? `<p class="muted">${escapeHtml(entry.rationale)}</p>` : ""}${(entry.supportingDecisionIds ?? []).length > 0 ? `<p class="muted">${escapeHtml(`Supporting decisions: ${(entry.supportingDecisionIds ?? []).join(", ")}`)}</p>` : ""}${(entry.evidence ?? []).length > 0 ? `<ul class="direction-revision-evidence">${(entry.evidence ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}</li>`;
  const current = revisions[revisions.length - 1];
  // The empty check above proves there is a current revision.
  if (!current) return "";
  const prior = [...revisions].slice(0, -1).reverse();
  // The current revision's own provenance belongs beside it, not only in the history.
  const currentHtml = `<section class="direction-current-revision"><h4>Where this direction came from</h4><ol class="direction-revision-list">${entryHtml(current)}</ol></section>`;
  const priorHtml = prior.length === 0
    ? ""
    : `<details class="direction-revisions"><summary>${escapeHtml(`How this direction changed (${String(prior.length)} earlier revision${prior.length === 1 ? "" : "s"})`)}</summary><ol class="direction-revision-list">${prior.map(entryHtml).join("")}</ol></details>`;
  return `${currentHtml}${priorHtml}`;
};

const semanticHistoryHtml = (): string => {
  const view = longitudinalState().direction;
  const decisions = view.decisionHistory ?? [];
  const findings = view.findingHistory ?? [];
  const query = state.historyFilter.trim().toLowerCase();
  const matches = (haystack: string[]): boolean =>
    query.length === 0 || haystack.some((item) => item.toLowerCase().includes(query));
  const shownFindings = findings.filter((entry) =>
    matches([entry.subject, entry.message, entry.identity, entry.state]));
  const shownDecisions = decisions.filter((entry) =>
    matches([entry.subject, entry.question, entry.id, entry.state]));
  if (decisions.length === 0 && findings.length === 0) {
    return `<details class="direction-semantic-history" ${disclosureAttributes("direction-semantic-history", true)}><summary class="section-heading"><div><strong>History</strong><small>Nothing has been recorded yet</small></div><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary><p class="muted">Accepted, rejected, resolved, reopened, and superseded records appear here once a round has run.</p></details>`;
  }
  return `<details class="direction-semantic-history" ${disclosureAttributes("direction-semantic-history", true)}><summary class="section-heading"><div><strong>History</strong><small>${escapeHtml(`${String(decisions.length)} decision${decisions.length === 1 ? "" : "s"} · ${String(findings.length)} finding${findings.length === 1 ? "" : "s"}, including resolved, rejected and superseded`)}</small></div><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary><label class="field"><span>Filter this history</span><input id="history-filter" value="${escapeAttribute(state.historyFilter)}" placeholder="subject, message, or identity"></label><section class="direction-group"><h3>${escapeHtml(`Decisions (${String(shownDecisions.length)} of ${String(decisions.length)})`)}</h3>${shownDecisions.length === 0 ? `<p class="muted">No decision matches this filter.</p>` : `<ul>${shownDecisions.map(historyDecisionHtml).join("")}</ul>`}</section><section class="direction-group"><h3>${escapeHtml(`Findings (${String(shownFindings.length)} of ${String(findings.length)})`)}</h3>${shownFindings.length === 0 ? `<p class="muted">No finding matches this filter.</p>` : `<ul>${shownFindings.map(historyFindingHtml).join("")}</ul>`}</section></details>`;
};

const directionHtml = (): string => {
  const longitudinal = longitudinalState();
  const view = longitudinal.direction;
  const comparison = view.latestChange;
  const change = comparison === undefined
    ? `<p class="muted">No cycle round has been recorded yet.</p>`
    : `${findingListHtml("New material findings", comparison.newMaterial)}${findingListHtml("Regressions", comparison.regressed)}${findingListHtml("Reopened with new evidence", comparison.reopened)}${findingListHtml("Repeated", comparison.repeated)}${findingListHtml("Resolved", comparison.resolved)}${findingListHtml("Not observed this round (still open)", comparison.notObserved ?? [])}${comparison.decisionChanges.length > 0 ? `<section class="direction-group"><h4>Decision changes</h4><ul>${comparison.decisionChanges.map((item) => `<li><strong>${escapeHtml(item.subject)}</strong><small>${escapeHtml(`${item.from === undefined ? "New" : labelFor(lifecycleStateLabel, item.from)} → ${labelFor(lifecycleStateLabel, item.to)}`)}</small>${item.reason ? `<p class="muted">${escapeHtml(item.reason)}</p>` : ""}</li>`).join("")}</ul></section>` : ""}${comparison.newMaterial.length + comparison.regressed.length + comparison.reopened.length + comparison.repeated.length + comparison.resolved.length + (comparison.notObserved ?? []).length + comparison.decisionChanges.length === 0 ? `<p class="muted">The latest round added nothing material.</p>` : ""}`;
  const accepted = view.acceptedArtifacts ?? [];
  const proposed = view.proposedArtifacts ?? [];
  const cycle = view.currentCycle;
  const cycleControls = `<div class="compact-actions"><button data-action="review-fresh">Start fresh review</button><select id="cycle-type" aria-label="Next cycle type">${cycleTypeOptions.map((option) => `<option value="${option}"${cycle?.type === option ? " selected" : ""}>${escapeHtml(labelFor(cycleTypeLabel, option))}</option>`).join("")}</select><button data-action="cycle-start">Start cycle</button><button data-action="cycle-close"${disabledWithReason(cycle === undefined || cycle.completion !== "open" ? "No open cycle to close." : undefined)}>Close cycle</button></div>`;
  const saturationDisclaimer = view.saturationDisclaimer ||
    "Saturation means repeated fresh review stopped producing material findings. It is not a correctness proof. No review count is required, and you can close this cycle whenever you decide the evidence is enough.";
  const quietReviewStatement = view.quietReviewStatement ||
    `${String(view.saturation.quietFreshReviews)} of ${String(view.saturation.quietReviewSignal)} consecutive fresh reviews found no material change. Continue or close the cycle.`;
  const saturation = `<p class="${view.saturation.saturated ? "direction-saturated" : "direction-quiet-reviews"}" ${liveRegionAttributes("direction-saturation", "status", quietReviewStatement)}>${escapeHtml(quietReviewStatement)}</p>${view.saturation.saturated
    ? ""
    : `<p class="muted">Still open: ${escapeHtml(sentenceJoin(view.saturation.reasons) || "no fresh review has been recorded")}.</p>`}<p class="muted">${escapeHtml(saturationDisclaimer)}</p>`;
  return `<section class="direction-center">
    <header><div><span class="decision-label">Direction</span><h2>${escapeHtml(view.goal ?? "No goal is recorded")}</h2></div></header>
    <section class="direction-next" ${liveRegionAttributes("direction-next", "status", `${view.nextAction.label} ${view.nextAction.detail ?? ""}`)}><strong>${escapeHtml(view.nextAction.label)}</strong>${view.nextAction.detail ? `<p class="muted">${escapeHtml(view.nextAction.detail)}</p>` : ""}<div class="compact-actions"><button class="primary" data-action="direction-next-action">${escapeHtml(nextActionButtonLabel(view.nextAction))}</button></div></section>
    <div class="direction-grid">
      <section><h3>What are we trying to achieve?</h3>${view.goal ? `<p>${escapeHtml(view.goal)}</p>` : `<p class="muted">Bachata has no recorded goal for this repository.</p>`}${view.desiredOutcome ? `<p class="muted">Desired outcome: ${escapeHtml(view.desiredOutcome)}</p>` : ""}${view.acceptanceCriteria.length > 0 ? `<ul>${view.acceptanceCriteria.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : ""}${view.constraints.length > 0 ? `<p class="muted">Constraints: ${escapeHtml(view.constraints.join("; "))}</p>` : ""}</section>
      <section><h3>What direction is accepted?</h3>${view.acceptedDirection ? `<p>${escapeHtml(view.acceptedDirection)}</p>` : `<p class="muted">No direction has been accepted yet.</p>`}${directionRevisionsHtml(view.directionRevisions ?? [])}<label class="field"><span>Accepted direction</span><textarea id="initiative-direction" rows="2" maxlength="4000" aria-describedby="initiative-direction-error">${escapeHtml(view.acceptedDirection ?? "")}</textarea></label><div class="field-error error" id="initiative-direction-error"></div><label class="field"><span>Why is it changing? (optional)</span><input id="initiative-direction-rationale" maxlength="500" value="${escapeAttribute(state.directionRationale)}"></label>${directionSupportHtml()}<label class="field"><span>Evidence for this direction, one per line (optional)</span><textarea id="initiative-direction-evidence" rows="2">${escapeHtml(state.directionEvidence)}</textarea></label><div class="compact-actions"><button data-action="initiative-direction-save"${disabledWithReason(view.goal === undefined ? "Record a goal for this repository before accepting a direction." : undefined)}>Record accepted direction</button></div></section>
    </div>
    ${initiativeSwitcherHtml()}
    ${directionCandidateHtml(view)}
    <section><h3>What materially changed in the latest round?</h3>${cycle ? `<p class="muted">Cycle ${String(cycle.sequence)} · ${escapeHtml(labelFor(cycleTypeLabel, cycle.type))} · ${escapeHtml(labelFor(cycleCompletionLabel, cycle.completion))} · ${String(cycle.runCount)} run${cycle.runCount === 1 ? "" : "s"}</p>` : `<p class="muted">No cycle has been started.</p>`}${change}${cycleControls}${saturation}</section>
    ${(longitudinal.staleRuns ?? []).length > 0 ? `<section class="direction-stale" ${liveRegionAttributes("direction-stale", "status", (longitudinal.staleRuns ?? []).map((item) => item.runRef).join(", "))}><h3>Which runs finished against an earlier candidate?</h3><ul>${(longitudinal.staleRuns ?? []).map((item) => `<li><strong>${escapeHtml(item.runRef)}</strong><small>${escapeHtml(`recorded ${formatDateTime(item.recordedAt)}`)}</small></li>`).join("")}</ul><p class="muted">Bachata kept these runs as history. They changed nothing about the current candidate, and rerunning them against it is the only way to make them count.</p></section>` : ""}
    ${(longitudinal.validationErrors ?? []).length > 0 ? `<section class="direction-failures" ${liveRegionAttributes("direction-failures", "alert", (longitudinal.validationErrors ?? []).join(" "))}><h3>Bachata could not record some longitudinal state</h3><ul>${(longitudinal.validationErrors ?? []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>` : ""}
    <section><h3>Which artifacts are accepted?</h3>${accepted.length === 0 ? `<p class="muted">No artifact has been accepted yet.</p>` : `<ul class="direction-artifacts accepted">${accepted.map(directionArtifactHtml).join("")}</ul>`}${proposed.length > 0 ? `<h4>Proposed, waiting on you</h4><ul class="direction-artifacts proposed">${proposed.map(directionArtifactHtml).join("")}</ul>` : ""}</section>
    ${directionExternalEvidenceSectionHtml()}
    ${directionReconciliationHtml(view)}
    ${directionMergesHtml()}
    <section><h3>Which decisions require human judgment?</h3>${view.decisionsNeedingHuman.length === 0 ? `<p class="muted">No decision is waiting on you.</p>` : `<ul>${view.decisionsNeedingHuman.map(directionDecisionHtml).join("")}</ul>`}</section>
    <section><h3>Which findings need human judgment?</h3>${(view.findingsNeedingRuling ?? []).length === 0 ? `<p class="muted">No unresolved finding needs you.</p>` : `<ul>${(view.findingsNeedingRuling ?? []).map((finding) => directionFindingHtml(finding, true)).join("")}</ul>`}</section>
    <section><h3>Which accepted findings still need a fix?</h3>${view.outstandingAcceptedFindings.length === 0 ? `<p class="muted">No accepted finding is outstanding.</p>` : `<ul>${view.outstandingAcceptedFindings.map((finding) => directionFindingHtml(finding, true)).join("")}</ul>`}${findingListHtml("Still open, not yet actionable", view.unresolvedFindings, true)}</section>
    ${semanticHistoryHtml()}
    <details class="direction-initiative" ${disclosureAttributes("direction-initiative", view.goal === undefined)}><summary class="section-heading"><div><strong>Initiative</strong><small>Goal, scope, constraints, and acceptance criteria</small></div><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary>${initiativeFormHtml()}</details>
    <details class="direction-history" ${disclosureAttributes("direction-history", false)}><summary class="section-heading"><div><strong>Cycle history</strong><small>${countLabel(longitudinal.cycles.length, "cycle")} · ${countLabel(longitudinal.findings.length, "tracked finding")}</small></div><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i></summary><ul class="direction-cycles">${longitudinal.cycles.map((item) => `<li><strong>${escapeHtml(`Cycle ${String(item.sequence)} · ${labelFor(cycleTypeLabel, item.type)}`)}</strong><small>${escapeHtml(`${labelFor(cycleCompletionLabel, item.completion)} · ${countLabel(item.runRefs.length, "run")}${item.repositoryBaseline ? ` · baseline ${directionBaselineLabel(item.repositoryBaseline)}` : ""}`)}</small>${item.nextCycleTrigger ? `<p class="muted">${escapeHtml(item.nextCycleTrigger)}</p>` : ""}</li>`).join("")}</ul>${longitudinal.artifacts.length > 0 ? `<ul class="direction-artifacts">${longitudinal.artifacts.map((artifact) => `<li><strong>${escapeHtml(artifact.title)}</strong><small>${escapeHtml(`${artifact.type} · revision ${String(artifact.revision)} · ${labelFor(lifecycleStateLabel, artifact.state)}`)}</small>${resolutionActionsHtml("artifact", artifact.id, artifact.title, artifact.state)}</li>`).join("")}</ul>` : ""}</details>
  </section>`;
};
