/**
 * Execution rendering: participants, rulings, workflow stages, results, evidence and
 * verification.
 *
 * Concatenated after the direction renderers. Everything here reads a run's projected result
 * and renders it; nothing here decides a disposition.
 */

const decisionCandidateKey = (value: JsonValue): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(decisionCandidateKey).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${decisionCandidateKey(value[key] as JsonValue)}`).join(",")}}`;
};

const decisionParticipantState = (
  record: Record<string, JsonValue>,
  decision: Record<string, JsonValue>,
): { label: string; accepted: boolean } => {
  if (record.valid !== true) return { label: localize("Invalid output"), accepted: false };
  const resolution = jsonRecord(decision.humanResolution);
  if (resolution?.selectedParticipant === record.agentId) return { label: localize("Selected conclusion"), accepted: true };
  const agreed = resolution === undefined &&
    (decision.status === "accepted" || decision.status === "ruled") &&
    record.accepted === true && record.candidate !== undefined && decision.candidate !== undefined &&
    decisionCandidateKey(record.candidate) === decisionCandidateKey(decision.candidate);
  return agreed ? { label: localize("Agreed"), accepted: true }
    : { label: record.accepted === true ? localize("Supports own conclusion") : localize("Participant conclusion"), accepted: false };
};

const decisionParticipantHtml = (
  participant: JsonValue,
  panel: PanelState | undefined,
  decision: Record<string, JsonValue>,
): string => {
  const record = jsonRecord(participant);
  const agentId = jsonString(record?.agentId);
  if (!record || !agentId) return "";
  const status = decisionParticipantState(record, decision);
  return `<button class="ruling-participant" data-action="focus-agent-output" data-agent="${escapeAttribute(agentId)}"><span>${escapeHtml(participantName(panel, agentId))}</span><small>${escapeHtml(status.label)}</small></button>`;
};

const resultFieldLabels: Record<string, string> = {
  findings: localize("Findings"),
  subject: localize("Subject"),
  title: localize("Title"),
  message: localize("Message"),
  statement: localize("Statement"),
  severity: localize("Severity"),
  disposition: localize("Disposition"),
  evidence: localize("Evidence"),
  challenges: localize("Challenges"),
  location: localize("Location"),
  file: localize("File"),
  startLine: localize("Start line"),
  endLine: localize("End line"),
  summary: localize("Summary"),
  accepted: localize("Accepted"),
  objections: localize("Objections"),
  unresolvedRisks: localize("Unresolved risks"),
  tradeOffs: localize("Trade-offs"),
  validationErrors: localize("Validation errors"),
  participants: localize("Participants"),
  recommendation: localize("Recommendation"),
  details: localize("Details"),
  proposed: localize("Proposed"),
  information: localize("Information"),
  warning: localize("Warning"),
  error: localize("Error"),
  unresolved: localize("Unresolved"),
  rejected: localize("Rejected"),
  deferred: localize("Deferred"),
  superseded: localize("Superseded"),
  resolved: localize("Resolved"),
  reason: localize("Reason"),
  rationale: localize("Rationale"),
  conclusion: localize("Conclusion"),
  risks: localize("Risks"),
  candidate: localize("Candidate"),
};

const resultFieldLabel = (key: string): string => {
  if (resultFieldLabels[key] !== undefined) return resultFieldLabels[key];
  const label = key.replace(/([a-z])([A-Z])/gu, "$1 $2").replaceAll("_", " ");
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const participantName = (panel: PanelState | undefined, agentId: string): string =>
  panel?.agents[agentId]?.name ?? panel?.selectedPipelineDefinition?.agents.find((agent) => agent.id === agentId)?.name ?? localize("Participant");

const structuredRuling = (text: string | undefined): JsonValue | undefined => {
  if (!text || !/^[\s]*[\[{]/u.test(text)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? value as JsonValue : undefined;
  } catch {
    return undefined;
  }
};

const resultSummaryText = (summary: string | undefined): string | undefined => {
  const value = structuredRuling(summary);
  if (value === undefined) return summary;
  const record = jsonRecord(value);
  return jsonString(record?.summary) ?? jsonString(record?.title) ?? localize("Review the recorded conclusion.");
};

const resultRulingHtml = (ruling: string, findings?: RunResultCenter["findings"]): string => {
  const value = structuredRuling(ruling);
  return value === undefined ? `<div class="markdown">${renderMarkdown(ruling)}</div>` : readableResultHtml(value, 0, findings);
};

const normalizedResultFinding = (value: Record<string, JsonValue>, findings?: RunResultCenter["findings"]): NonNullable<RunResultCenter["findings"]>[number] | undefined =>
  findings?.find((finding) => finding.id === value.id && finding.subject === value.subject && finding.message === value.message);

const readableResultHtml = (value: JsonValue, depth = 0, findings?: RunResultCenter["findings"]): string => {
  if (value === null || value === "") return "";
  if (typeof value === "string") return `<div class="markdown">${renderMarkdown(value)}</div>`;
  if (typeof value !== "object") return `<p>${escapeHtml(typeof value === "boolean" ? value ? localize("Yes") : localize("No") : String(value))}</p>`;
  if (depth >= 12) return `<p class="muted">${escapeHtml(localize("Further nested content is available in the participant message."))}</p>`;
  if (Array.isArray(value)) {
    const items = value.map((item) => readableResultHtml(item, depth + 1, findings)).filter(Boolean);
    return items.length > 0 ? `<ul class="result-items${value.every((item) => typeof item !== "object") ? " result-items-text" : ""}">${items.map((item) => `<li>${item}</li>`).join("")}</ul>` : "";
  }
  const hidden = /(^id$|(?:Id|Ids|Ref|Refs|Hash|Digest)$|^(?:createdAt|updatedAt|recordedAt|resolvedAt|provenance)$)/u;
  const normalized = normalizedResultFinding(value, findings);
  const displayed = normalized ? { ...value, ...normalized } : value;
  const entries = Object.entries(displayed).filter(([key]) => !hidden.test(key));
  const subject = jsonString(value.subject) ?? jsonString(value.title);
  const statement = jsonString(value.message) ?? jsonString(value.statement);
  if (subject && statement) {
    const disposition = normalized?.disposition ?? jsonString(value.disposition);
    const metadata = [jsonString(value.severity) ? resultFieldLabel(jsonString(value.severity) as string) : undefined,
      disposition ? normalized ? resultFieldLabel(disposition) : localize("Provider claim: {0}", resultFieldLabel(disposition)) : undefined].filter(Boolean).join(" · ");
    const additional = entries.filter(([key]) => !["subject", "title", "message", "statement", "severity", "disposition"].includes(key));
    return `<article class="result-finding"><header><strong>${escapeHtml(subject)}</strong>${metadata ? `<small>${escapeHtml(metadata)}</small>` : ""}</header><div class="markdown">${renderMarkdown(statement)}</div>${additional.map(([key, item]) => {
      const content = readableResultHtml(item, depth + 1, findings);
      return content ? `<section class="result-field"><h5>${escapeHtml(resultFieldLabel(key))}</h5>${content}</section>` : "";
    }).join("")}</article>`;
  }
  return `<div class="structured-result">${entries.map(([key, item]) => {
    const content = readableResultHtml(item, depth + 1, findings);
    return content ? `<section class="result-field"><h5>${escapeHtml(resultFieldLabel(key))}</h5>${content}</section>` : "";
  }).join("")}</div>`;
};

const participantColumnHtml = (
  participant: JsonValue,
  panel: PanelState | undefined,
  decision: Record<string, JsonValue>,
  findings?: RunResultCenter["findings"],
): string => {
  const record = jsonRecord(participant);
  const agentId = jsonString(record?.agentId);
  if (!record || !agentId) return "";
  const agentName = participantName(panel, agentId);
  const status = decisionParticipantState(record, decision);
  const objections = Array.isArray(record.objections)
    ? record.objections.filter((value): value is string => typeof value === "string")
    : [];
  const risks = Array.isArray(record.unresolvedRisks)
    ? record.unresolvedRisks.filter((value): value is string => typeof value === "string")
    : [];
  const validationErrors = Array.isArray(record.validationErrors)
    ? record.validationErrors.filter((value): value is string => typeof value === "string")
    : [];
  const candidate = record.candidate;
  const stepId = jsonString(decision.stepId);
  const stepName = panel?.selectedPipelineDefinition?.steps.find((step) => step.id === stepId)?.name;
  const answer = panel?.transcript?.slice().reverse().find((entry) => entry.agentId === agentId &&
    (entry.kind === "answer" || entry.kind === "interrupted") &&
    (entry.step === stepId || (stepName !== undefined && entry.step === stepName)));
  const incomplete = candidate === undefined || candidate === null || /\[[^\]]*not shown\]/u.test(JSON.stringify(candidate));
  const messageLink = answer && incomplete ? `<button class="text-button" data-action="focus-agent-output" data-agent="${escapeAttribute(agentId)}" data-message-id="${escapeAttribute(answer.id)}">${escapeHtml(localize("Open participant message"))}</button>` : "";
  const output = candidate === undefined || candidate === null
    ? `<p class="muted">${escapeHtml(localize("This saved preview does not include the conclusion."))}</p>`
    : typeof candidate === "string"
      ? `<div class="markdown">${renderMarkdown(candidate)}</div>`
      : readableResultHtml(candidate, 0, findings);
  return `<section class="compare-column ${status.accepted ? "accepted" : ""}">
    <header><strong>${escapeHtml(agentName)}</strong><small>${escapeHtml(status.label)}</small></header>
    ${output}
    ${messageLink}
    ${objections.length > 0 ? `<h5>${escapeHtml(localize("Objections raised"))}</h5><ul class="ruling-list">${objections.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : ""}
    ${risks.length > 0 ? `<h5>${escapeHtml(localize("Risks reported"))}</h5><ul class="ruling-list risks">${risks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul>` : ""}
    ${validationErrors.length > 0 ? `<h5>${escapeHtml(localize("Validation errors"))}</h5><ul class="ruling-list">${validationErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
  </section>`;
};

const finalRulingHtml = (
  event: WorkflowEventSummary,
  panel: PanelState | undefined,
  findings?: RunResultCenter["findings"],
): string | undefined => {
  if (event.type !== "decision.published") {
    return undefined;
  }
  const payload = jsonRecord(event.payload);
  if (!payload) {
    return undefined;
  }
  const ruledBy = jsonString(payload.ruledBy);
  const decisionStatus = jsonString(payload.status);
  const humanResolution = jsonRecord(payload.humanResolution);
  const resolvedByHuman = humanResolution !== undefined;
  const unresolved = decisionStatus === "pending" || decisionStatus === "resolved";
  const rationale = jsonString(humanResolution?.rationale);
  const selectedParticipant = jsonString(humanResolution?.selectedParticipant);
  const selectedParticipantName = selectedParticipant ? participantName(panel, selectedParticipant) : undefined;
  const leadName = ruledBy ? participantName(panel, ruledBy) : undefined;
  const decisionLabel = resolvedByHuman ? localize("Your decision") : decisionStatus === "pending" ? localize("Unresolved review") : ruledBy ? localize("Lead’s final ruling") : localize("Consensus decision");
  const candidate = payload.candidate;
  const participants = Array.isArray(payload.participants) ? payload.participants : [];
  const objections = Array.isArray(payload.objections) ? payload.objections : [];
  const unresolvedRisks = Array.isArray(payload.unresolvedRisks)
    ? payload.unresolvedRisks.filter((risk): risk is string => typeof risk === "string")
    : [];
  const objectionItems = objections.flatMap((value) => {
    const objection = jsonRecord(value);
    const agentId = jsonString(objection?.agentId);
    const text = jsonString(objection?.text);
    if (!agentId || !text) {
      return [];
    }
    const agentName = participantName(panel, agentId);
    const aligned = objection?.accepted === true;
    const disposition = unresolved ? localize("Unresolved") : aligned ? localize("Aligned") : resolvedByHuman ? localize("Not resolved") : localize("Overruled");
    return [`<li><span><strong>${escapeHtml(agentName)}</strong> ${escapeHtml(text)}</span><small class="ruling-disposition ${unresolved || (resolvedByHuman && !aligned) ? "unresolved" : aligned ? "accepted" : "overruled"}">${escapeHtml(disposition)}</small></li>`];
  }).join("");
  const participantItems = participants.map((participant) => decisionParticipantHtml(participant, panel, payload)).join("");
  const selectedResult = candidate === undefined || unresolved ? "" : readableResultHtml(candidate, 0, findings);
  const comparison = participants.length > 0
    ? `<div class="compare-grid">${participants.map((participant) => participantColumnHtml(participant, panel, payload, decisionStatus === "resolved" ? unresolvedParticipantFindings(participant, findings) : undefined)).join("")}</div>`
    : "";
  return `<article class="final-ruling-card"${event.createdAt ? ` title="${escapeAttribute(formatDateTime(event.createdAt))}"` : ""}>
    <div class="ruling-heading"><div><span class="decision-label">${escapeHtml(decisionLabel)}</span><h3>${escapeHtml(decisionStatus === "pending" ? localize("Participant conclusions") : decisionStatus === "resolved" ? localize("Finished with unresolved findings") : selectedParticipantName ? localize("Accepted {0}’s conclusion", selectedParticipantName) : localize("Final decision"))}</h3></div></div>
    ${leadName && !resolvedByHuman ? `<dl class="ruling-meta"><dt>${escapeHtml(localize("Lead"))}</dt><dd>${escapeHtml(leadName)}</dd></dl>` : ""}
    ${rationale ? `<section class="human-resolution"><h4>${escapeHtml(localize("Rationale"))}</h4><div class="markdown">${renderMarkdown(rationale)}</div></section>` : ""}
    ${selectedResult}
    ${unresolved ? comparison : participantItems ? `<section><h4>${escapeHtml(localize("Participant outputs"))}</h4><div class="ruling-participants">${participantItems}</div></section>` : ""}
    ${!unresolved && comparison ? `<details class="ruling-compare" ${disclosureAttributes(`ruling:${String(event.id)}:compare`)}><summary>${escapeHtml(localize("Compare participant conclusions"))}</summary>${comparison}</details>` : ""}
    ${!unresolved && objectionItems ? `<section><h4>${escapeHtml(localize("Objections"))}</h4><ul class="ruling-list">${objectionItems}</ul></section>` : ""}
    ${!unresolved && unresolvedRisks.length > 0 ? `<section><h4>${escapeHtml(localize("Unresolved risks"))}</h4><ul class="ruling-list risks">${unresolvedRisks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul></section>` : ""}
  </article>`;
};

const interactionIsOpen = (interaction: InteractionSummary): boolean =>
  interaction.status === "pending" || interaction.status === "paused";

const gateInteraction = (conversationId: string, panel: PanelState): InteractionSummary | undefined =>
  state.manager.interactions.find((interaction) => interaction.conversationId === conversationId &&
    interaction.kind === "humanGate" && interactionIsOpen(interaction) &&
    (!interaction.humanGate || (interaction.humanGate.stepId === panel.pendingGate?.stepId &&
      interaction.humanGate.reason === panel.pendingGate.reason &&
      interaction.humanGate.round === panel.pendingGate.round)));

const disagreementEventForGate = (
  conversationId: string,
  gate: InteractionSummary["humanGate"],
): WorkflowEventSummary | undefined => {
  if (!gate || (gate.reason !== "maxConsensusRounds" && gate.reason !== "invalidConsensus")) return undefined;
  const events = currentAttempt(state.manager.eventsByConversation[conversationId] ?? []).events;
  const event = [...events]
    .reverse()
    .find((candidate) => candidate.type === "decision.published" && eventStepId(candidate) === gate.stepId);
  const payload = jsonRecord(event?.payload);
  return event && jsonString(payload?.status) === "pending" &&
    (gate.decisionRound === undefined || payload?.round === gate.decisionRound) ? event : undefined;
};

const disagreementEventFor = (interaction: InteractionSummary): WorkflowEventSummary | undefined =>
  interaction.kind !== "humanGate" || !interactionIsOpen(interaction) ? undefined
    : disagreementEventForGate(interaction.conversationId, interaction.humanGate ?? state.panels.get(interaction.conversationId)?.pendingGate);

const disagreementSummaryHtml = (interaction: InteractionSummary): string => {
  const event = disagreementEventFor(interaction);
  return event ? finalRulingHtml(event, state.panels.get(interaction.conversationId)) ?? "" : "";
};

/**
 * The pipeline summary: one row per enabled step, with the state the recorded events prove.
 *
 * A flat event stream answers "what happened" and not "where is this run", which is the question
 * a reader has while a pipeline is executing and the first one they ask when it stops. The rows
 * are derived, never stored: the immutable pipeline definition says which steps exist and in what
 * order, and the recorded events say which of them started, which one the run was in when it
 * ended, and how it ended. Nothing is inferred beyond that — a step with no recorded event is
 * `waiting`, not `skipped`, because the run never said.
 */
type PipelineStepState = "waiting" | "running" | "completed" | "failed" | "interrupted" | "notRun";

const pipelineStepStateLabel: Record<PipelineStepState, string> = {
  waiting: localize("Waiting"),
  running: localize("Running"),
  completed: localize("Completed"),
  failed: localize("Failed"),
  interrupted: localize("Interrupted"),
  notRun: localize("Not run"),
};

const pipelineStepStateIcon: Record<PipelineStepState, string> = {
  waiting: "circle-outline",
  running: "loading codicon-modifier-spin",
  completed: "pass-filled",
  failed: "error",
  interrupted: "debug-pause",
  notRun: "circle-slash",
};

type PipelineStepRow = {
  id: string;
  name: string;
  position: number;
  state: PipelineStepState;
  events: WorkflowEventSummary[];
  startedAt?: string;
  lastEventAt?: string;
};

// The step an event belongs to. The panel does not receive payloads, so the identifier travels as
// its own field; reading it out of a payload that was stripped before the message was sent is why
// the summary showed every step waiting however far the run had got.
const eventStepId = (event: WorkflowEventSummary): string | undefined =>
  event.stepId ?? jsonString(jsonRecord(event.payload)?.stepId);

/** The events belonging to the newest attempt, and the revision that attempt executed. */
const currentAttempt = (
  events: readonly WorkflowEventSummary[],
): { events: readonly WorkflowEventSummary[]; steps?: readonly { id: string; name: string }[] } => {
  // A restart opens a new attempt; a resume continues the one it interrupted, and keeps the steps
  // that attempt had already completed.
  const boundary = events.reduce<number>(
    (found, event, index) =>
      event.type === "run.started" || event.type === "run.restarted" ? index : found,
    -1,
  );
  if (boundary < 0) return { events };
  const opening = events[boundary];
  return {
    events: events.slice(boundary),
    ...(opening?.attempt === undefined ? {} : { steps: opening.attempt.steps }),
  };
};

/** Event types that end the run as a whole, and what they make the step it stopped in. */
const terminalRunEventState: Record<string, PipelineStepState> = {
  "run.failed": "failed",
  "run.restart.failed": "failed",
  "iteration.failed": "failed",
  "run.resume.failed": "interrupted",
  "iteration.resume.failed": "interrupted",
  "run.interrupted": "interrupted",
  "iteration.interrupted": "interrupted",
  "run.completed": "completed",
  "iteration.completed": "completed",
};

const pipelineStepRows = (
  steps: readonly { id: string; name: string; enabled?: boolean }[],
  events: readonly WorkflowEventSummary[],
): PipelineStepRow[] => {
  const attempt = currentAttempt(events);
  // The revision the attempt recorded, where it recorded one. The selected definition is only the
  // fallback: a restart replays the revision it failed on, which the catalog may no longer hold.
  const enabled = attempt.steps ?? steps.filter((step) => step.enabled !== false);
  const rows = new Map<string, PipelineStepRow>(
    enabled.map((step, index) => [step.id, {
      id: step.id,
      name: step.name,
      position: index + 1,
      state: "waiting" as PipelineStepState,
      events: [],
    }]),
  );
  let active: PipelineStepRow | undefined;
  attempt.events.forEach((event) => {
    const stepId = eventStepId(event);
    const row = stepId === undefined ? undefined : rows.get(stepId);
    if (row) {
      // A step the attempt has moved past is finished, even if the run was interrupted while it was
      // the open one: the resume that followed started a later step, which is the run saying so.
      if (active && active !== row && (active.state === "running" || active.state === "interrupted")) {
        active.state = "completed";
      }
      if (row.state === "waiting" || event.type === "step.started") row.state = "running";
      row.startedAt ??= event.createdAt;
      active = row;
      // Only an event that names its step joins that step's activity. A run-level event belongs to
      // the run, and filing it under whichever step happened to be open put "the run failed" inside
      // a step that may never have been the one that failed.
      row.events.push(event);
      row.lastEventAt = event.createdAt;
    }
    const terminal = terminalRunEventState[event.type];
    if (terminal !== undefined && active?.state === "running") {
      active.state = terminal;
      if (terminal === "completed") {
        rows.forEach((candidate) => {
          if (candidate.state === "running") candidate.state = "completed";
        });
      }
    }
  });
  const lastRunEvent = [...attempt.events].reverse().find((event) =>
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.interrupted" || event.type === "run.resumed",
  );
  if (lastRunEvent?.type === "run.completed") {
    rows.forEach((row) => {
      if (row.state === "waiting") row.state = "notRun";
    });
  }
  return Array.from(rows.values());
};

const unresolvedParticipantFindings = (participant: JsonValue, findings?: RunResultCenter["findings"]): RunResultCenter["findings"] => {
  const agentId = jsonString(jsonRecord(participant)?.agentId);
  return agentId ? findings?.filter((finding) => finding.id.startsWith(`${agentId}:`) && finding.provenance.participantIds.includes(agentId))
    .map((finding) => ({ ...finding, id: finding.id.slice(agentId.length + 1) })) : undefined;
};

const resultDecisionEvent = (conversationId: string): WorkflowEventSummary | undefined => {
  const result = state.manager.resultsByConversation?.[conversationId];
  if (!result) return undefined;
  const event = [...currentAttempt(state.manager.eventsByConversation[conversationId] ?? []).events]
    .reverse().find((item) => item.type === "decision.published");
  const saved = jsonRecord(result.finalDecision);
  if (saved) return {
    id: result.finalDecisionEventId ?? event?.id ?? 0,
    type: "decision.published",
    createdAt: event?.createdAt ?? jsonString(jsonRecord(saved.humanResolution)?.resolvedAt) ?? "",
    payload: saved,
  };
  const payload = jsonRecord(event?.payload);
  if (!result.finalRuling || !event || !payload || payload.status === "pending") return undefined;
  if (result.finalDecisionEventId !== undefined) return event.id === result.finalDecisionEventId ? event : undefined;
  const candidate = payload.candidate;
  const candidateText = typeof candidate === "string" ? candidate : candidate === undefined ? undefined : JSON.stringify(candidate);
  return candidateText === result.finalRuling ||
    (result.rulingProvenance?.kind === "humanResolution" && jsonRecord(payload.humanResolution)) ? event : undefined;
};

const findingContentKey = (finding: { subject?: unknown; message?: unknown; evidence?: unknown; challenges?: unknown; disposition?: unknown; severity?: unknown; location?: unknown }): string =>
  JSON.stringify([finding.subject, finding.message, finding.evidence ?? [], finding.challenges ?? [], finding.disposition ?? "proposed", finding.severity, finding.location]);

const pipelineStepRowHtml = (
  row: PipelineStepRow,
): string => {
  const timing = row.startedAt === undefined ? "" : ` title="${escapeAttribute(localize("Started {0}", formatDateTime(row.startedAt)))}"`;
  // The row's own heading is the step name. An activity entry that repeats it says nothing the
  // reader has not just read, so the step's own start event contributes its timestamp and its
  // technical detail through the rows below rather than a line restating the name.
  return `<li class="pipeline-step pipeline-step-${escapeAttribute(row.state)}">
    <div class="pipeline-step-summary"${timing}>
        <span class="pipeline-step-position" aria-hidden="true">${String(row.position)}</span>
        <span class="pipeline-step-name">${escapeHtml(row.name)}</span>
        <span class="pipeline-step-state"><i class="codicon codicon-${escapeAttribute(pipelineStepStateIcon[row.state])}" aria-hidden="true"></i> ${escapeHtml(pipelineStepStateLabel[row.state])}</span>
    </div>
  </li>`;
};

const pipelineSummaryHtml = (conversationId: string): string => {
  const events = state.manager.eventsByConversation[conversationId] ?? [];
  const panel = state.panels.get(conversationId);
  const steps = panel?.selectedPipelineDefinition?.steps ?? [];
  if (steps.length === 0) return "";
  const rows = pipelineStepRows(steps, events);
  return `<section class="pipeline-summary">
    <header><h2>${escapeHtml(localize("Pipeline"))}</h2></header>
    <ol class="pipeline-step-list">${rows.map((row) => pipelineStepRowHtml(row)).join("")}</ol>
  </section>`;
};

const workflowHtml = (conversationId: string): string => {
  const events = state.manager.eventsByConversation[conversationId] ?? [];
  if (events.length === 0) {
    return "";
  }
  const panel = state.panels.get(conversationId);
  const embeddedEvents = new Set(state.manager.interactions
    .filter((interaction) => interaction.conversationId === conversationId)
    .map(disagreementEventFor)
    .filter((event): event is WorkflowEventSummary => event !== undefined)
    .map((event) => event.id));
  const fallbackDecision = disagreementEventForGate(conversationId, panel?.pendingGate);
  if (fallbackDecision) embeddedEvents.add(fallbackDecision.id);
  const resultDecision = resultDecisionEvent(conversationId);
  if (resultDecision && panel && !["running", "waiting"].includes(runPhaseOf(panel))) embeddedEvents.add(resultDecision.id);
  const latestDecisions = new Map<string, WorkflowEventSummary>();
  currentAttempt(events).events.forEach((event) => {
    if (event.type === "decision.published") latestDecisions.set(eventStepId(event) ?? String(event.id), event);
  });
  const rulings = Array.from(latestDecisions.values())
    .filter((event) => !embeddedEvents.has(event.id))
    .map((event) => finalRulingHtml(event, panel))
    .filter((html): html is string => html !== undefined)
    .join("");
  return `${pipelineSummaryHtml(conversationId)}${rulings}`;
};

/**
 * The two decision cards the execution column shows: the human gate the run is stopped on,
 * and the approvals a participant is waiting for.
 */
// `stop` reaches a gate from a provider that halts the run outright and has no entry in the
// shared label map, so without this it prints as the bare enum value.
const extraGateActionLabels: Record<string, string> = {
  stop: localize("Stop the run"),
};

const haltingGateActions = new Set<string>(["cancel", "stop"]);

// The arbiter is whichever participant the step names; the pipeline editor lets that change, so
// the button names the participant rather than a fixed agent.
const gateArbiterName = (panel: PanelState, gate: PendingHumanGate): string | undefined => {
  const step = panel.selectedPipelineDefinition?.steps.find((item) => item.id === gate.stepId);
  const arbiter = step?.type === "agent" ? step.consensusConfig?.arbiter : undefined;
  if (arbiter === undefined) return undefined;
  return panel.agents[arbiter]?.name
    ?? panel.selectedPipelineDefinition?.agents.find((agent) => agent.id === arbiter)?.name
    ?? arbiter;
};

const gateChoiceLabel = (action: HumanGateAction, arbiter?: string): string =>
  action === "retry" ? localize("Request one more round")
    : action === "requestArbiterRuling" && arbiter !== undefined
    ? localize("Ask {0} to rule", arbiter)
    : extraGateActionLabels[action] ?? gateActionLabel(action);

// `reason` is the runtime's enum; only one gate site supplies `detail`, so the card needs a
// sentence for each value rather than printing the bare identifier.
const gateReasonSentence: Record<PendingHumanGate["reason"], string> = {
  beforeStep: localize("This step is about to run. Decide whether it should."),
  afterStep: localize("This step has finished. Decide what happens next."),
  invalidConsensus: localize("The last consensus round did not produce a valid answer."),
  maxConsensusRounds: localize("The participants reached the round limit without agreeing."),
};

const gateDraftKey = (conversationId: string, panel: PanelState): string | undefined => {
  const gate = panel.pendingGate;
  if (!gate) return undefined;
  const opening = currentAttempt(state.manager.eventsByConversation[conversationId] ?? []).events
    .find((event) => event.type === "run.started" || event.type === "run.restarted");
  return `${JSON.stringify(conversationId)}:${JSON.stringify([opening?.id, gate.stepId, gate.reason, gate.round, gate.decisionRound])}`;
};

const rememberGateDraft = (conversationId: string, panel: PanelState, text: string): void => {
  const key = gateDraftKey(conversationId, panel);
  const prefix = `${JSON.stringify(conversationId)}:`;
  for (const existing of state.gateDrafts.keys()) {
    if (existing.startsWith(prefix) && existing !== key) state.gateDrafts.delete(existing);
  }
  if (key) state.gateDrafts.set(key, text);
};

const gateHtml = (panel: PanelState, conversationId = activeId()): string => {
  const gate = panel.pendingGate;
  if (!gate) {
    return "";
  }
  const arbiter = gateArbiterName(panel, gate);
  const choices = gate.allowedActions.filter((action) => action !== "rollback" && action !== "acceptParticipant");
  const disagreement = gate.reason === "maxConsensusRounds" || gate.reason === "invalidConsensus";
  const conclusionChoices = gate.allowedActions.includes("acceptParticipant")
    ? (gate.conclusionOptions ?? []).map((participant) => `<button data-action="gate" data-gate-action="acceptParticipant" data-participant="${escapeAttribute(participant.agentId)}">${escapeHtml(localize("Accept {0}’s conclusion", participant.label))}</button>`).join("")
    : "";
  const decision = disagreementEventForGate(conversationId, gate);
  const draft = state.gateDrafts.get(gateDraftKey(conversationId, panel) ?? "") ?? "";
  const expected = choices.includes("continue") ? "continue" : choices.find((action) => !haltingGateActions.has(action));
  const rollback = gate.allowedActions.includes("rollback")
    ? `<div class="decision-rollback"><label for="rollback-target">${escapeHtml(localize("Return to step"))}</label><select id="rollback-target">${gate.rollbackTargets.map((target) => `<option value="${escapeAttribute(target.id)}">${escapeHtml(target.name)}</option>`).join("")}</select><button data-action="gate" data-gate-action="rollback">${escapeHtml(gateChoiceLabel("rollback"))}</button></div>`
    : "";
  return `<article class="decision-card" id="pending-gate" tabindex="-1">
    <div class="decision-label">${escapeHtml(localize("Your decision"))}</div><h2>${escapeHtml(gate.stepName)}</h2><p>${escapeHtml(gate.detail ?? gateReasonSentence[gate.reason] ?? gate.reason)}</p>
    ${decision ? finalRulingHtml(decision, panel) ?? "" : ""}
    ${disagreement ? `<label for="gate-rationale">${escapeHtml(localize("Rationale or review instructions"))}</label><textarea id="gate-rationale" placeholder="${escapeAttribute(localize("Record your decision or guide one more round…"))}">${escapeHtml(draft)}</textarea>` : ""}
    <div class="decision-actions">
      ${conclusionChoices}
      ${choices.map((action) => `<button${haltingGateActions.has(action) && !disagreement ? ` class="danger"` : action === expected ? ` class="primary"` : ""} data-action="gate" data-gate-action="${action}">${escapeHtml(action === "cancel" && disagreement ? localize("Leave for later") : gateChoiceLabel(action, arbiter))}</button>`).join("")}
    </div>
    ${rollback}
  </article>`;
};

const approvalKindLabel = (kind: PendingApproval["kind"]): string => {
  const labels: Record<PendingApproval["kind"], string> = {
    command: localize("Run a command"),
    fileChange: localize("Change files"),
    permissions: localize("Extra permissions"),
    browserAction: localize("Browser workspace action"),
  };
  return labels[kind] ?? localize("Approval");
};

const approvalScopeLabel: Record<PendingApproval["kind"], string> = {
  command: localize("command"),
  fileChange: localize("file change"),
  permissions: localize("permission request"),
  browserAction: localize("browser action"),
};

const browserActionRiskLabel: Record<string, string> = {
  readOnly: localize("read-only"),
  mutating: localize("file-changing"),
  destructive: localize("destructive"),
};

const browserActionPhrase = (
  kind: string,
  action: { [key: string]: JsonValue },
): string | undefined => {
  const target = jsonString(action.path);
  const query = jsonString(action.query);
  if (kind === "workspace.read") return localize("read {0}", target ?? localize("a workspace file"));
  if (kind === "workspace.list") return localize("list {0}", target ?? localize("your workspace"));
  if (kind === "workspace.search") {
    return query === undefined ? localize("search {0}", target ?? localize("your workspace")) : localize("search {0} for {1}", target ?? localize("your workspace"), query);
  }
  if (kind === "workspace.write") return localize("write to {0}", target ?? localize("a workspace file"));
  if (kind === "workspace.applyPatch") return localize("apply a patch to {0}", target ?? localize("your workspace"));
  if (kind === "workspace.delete") return localize("delete {0}", target ?? localize("a workspace path"));
  if (kind === "shell.run") return localize("run a shell command in your workspace");
  return undefined;
};

const browserActionSentence = (agentName: string, action: JsonValue): string | undefined => {
  const record = jsonRecord(action);
  const kind = jsonString(record?.kind);
  const phrase = record === undefined || kind === undefined
    ? undefined
    : browserActionPhrase(kind, record);
  if (phrase === undefined) {
    return undefined;
  }
  const risk = jsonString(record?.risk);
  const classification = risk === undefined ? undefined : browserActionRiskLabel[risk];
  return localize("{0} wants to {1}.", agentName, phrase) + (classification === undefined ? "" : " " + localize("Bachata classified this as a {0} action.", classification));
};

// A command is a shell block, a changed file is a path, and a browser action is a sentence:
// the body of an approval has to say which of them the reader is authorising.
const approvalBodyHtml = (approval: PendingApproval, agentName: string): string => {
  const command = approval.command === undefined || approval.command.trim().length === 0
    ? undefined
    : approval.command;
  if (approval.kind === "fileChange") {
    return command === undefined ? "" : `<p class="path-line">${escapeHtml(command)}</p>`;
  }
  const shell = approval.kind === "command" ||
    jsonString(jsonRecord(approval.browserAction)?.kind) === "shell.run";
  const detail = command === undefined
    ? ""
    : shell
      ? codeBlockHtml(command, "bash")
      : `<p>${escapeHtml(command)}</p>`;
  const sentence = approval.browserAction === undefined
    ? undefined
    : browserActionSentence(agentName, approval.browserAction);
  return sentence === undefined
    ? detail
    : `<p>${escapeHtml(sentence)}</p>${shell ? detail : ""}`;
};

const sessionWideChoice = (choiceId: string): boolean =>
  choiceId.toLowerCase().includes("session");

/**
 * S16. Which approval choice, if any, is emphasised.
 *
 * Refusal used to be drawn as the primary action on every card, so a read-only workspace search
 * arrived with a recommendation to deny it. Bachata does not have a view on how a request should
 * be answered; only stopping the run keeps its colour, because that ends more than this request.
 */
const approvalChoiceClass = (choiceId: string): string =>
  choiceId.toLowerCase() === "stop" ? "danger" : "";

const approvalsHtml = (panel: PanelState): string =>
  panel.approvals
    .map((approval) => {
      const agent = panel.agents[approval.agentId];
      const agentName = agent?.name ?? approval.agentId;
      const pending = state.pendingApprovals.has(approvalKey(approval.agentId, approval.requestId));
      const sessionChoice = approval.choices.find((choice) => sessionWideChoice(choice.id));
      const sessionCoverage = sessionChoice === undefined
        ? undefined
        : localize("“{0}” covers every later {1} from {2} in this run, without asking again.", sessionChoice.label, approvalScopeLabel[approval.kind], agentName);
      return `<article class="decision-card approval-card ${pending ? "pending" : ""}" id="approval-${escapeAttribute(approvalKey(approval.agentId, approval.requestId))}" tabindex="-1">
        <div class="decision-label">${escapeHtml(localize("Approval requested by {0}", agentName))}</div>
        <h2>${escapeHtml(approvalKindLabel(approval.kind))}</h2>
        ${approval.reason ? `<p class="approval-reason">${escapeHtml(approval.reason)}</p>` : ""}
        ${approvalBodyHtml(approval, agentName)}
        ${approval.cwd ? `<p class="path-line">${escapeHtml(localize("Working directory: {0}", approval.cwd))}</p>` : ""}
        ${approval.browserAction === undefined ? "" : jsonDetailsHtml(localize("Detected action"), approval.browserAction, `approval:${approval.agentId}:${approval.requestId}`)}
        <div class="decision-actions">${pending ? `<span class="pending-label">${escapeHtml(localize("Submitting…"))}</span>` : ""}${approval.choices.map((choice) => {
          const emphasis = approvalChoiceClass(choice.id);
          const coverage = sessionCoverage !== undefined && sessionWideChoice(choice.id)
            ? ` title="${escapeAttribute(sessionCoverage)}"`
            : "";
          return `<button${emphasis ? ` class="${emphasis}"` : ""} data-action="approval" data-agent="${escapeAttribute(approval.agentId)}" data-request="${escapeAttribute(approval.requestId)}" data-choice="${escapeAttribute(choice.id)}"${coverage} ${pending ? "disabled" : ""}>${escapeHtml(choice.label)}</button>`;
        }).join("")}</div>
        ${sessionCoverage === undefined ? "" : `<p class="muted">${escapeHtml(sessionCoverage)}</p>`}
      </article>`;
    })
    .join("");

const modelReviewedResult = (result: RunResultCenter): boolean =>
  result.rulingProvenance?.kind === "unanimousConsensus" ||
  result.rulingProvenance?.kind === "arbiterRuling" ||
  result.rulingProvenance?.kind === "singleProvider" ||
  (result.consensusRuling === true && (result.providers ?? []).length > 1);

const verificationPassed = (result: RunResultCenter): boolean =>
  result.checks.length > 0 && result.checks.every((check) =>
    check.status === "passed" && check.stale !== true);

// The webview bundle is concatenated rather than module-linked, so it cannot import the
// controller's derivation. tests/claimDerivation.test.cjs asserts the two agree, which is
// what keeps a badge here from outliving a change to what a check runs.
const controllerCheckDescription = (command: string): string => {
  if (command === "bachata:workspace-integrity") return localize("workspace integrity");
  if (command === "bachata:project-checks") return localize("integrity, syntax and types");
  return command.startsWith("bachata:verifier:")
    ? localize("repository verifier \"{0}\"", command.slice("bachata:verifier:".length))
    : command;
};

const controllerCheckSummary = (commands: string[]): string => {
  const described = [...new Set(commands.map(controllerCheckDescription))];
  return described.length === 0 ? localize("no declared check") : described.join(", ");
};

// Only checks that actually passed against a current candidate may name themselves in a
// claim; a stale or failed check is evidence about a candidate that no longer exists.
const passedCheckSummary = (result: RunResultCenter): string =>
  controllerCheckSummary(
    result.checks
      .filter((check) => check.status === "passed" && check.stale !== true)
      .map((check) => check.command),
  );

const assessmentStatusLine = (result: RunResultCenter): string => {
  if (result.status === "interrupted") return localize("Stopped before a final assessment");
  const outcome = result.finalAssessment?.outcome ?? "notApplicable";
  const modelReviewed = modelReviewedResult(result);
  if (outcome === "verificationFailed") {
    return localize("Verification failed · controller-recorded");
  }
  if (outcome === "notApplicable") {
    return localize("Not applicable");
  }
  // A run that died before consensus is not an assessment. Reading "Inconclusive · 0 findings"
  // there told the reader the participants had looked and could not decide, when in fact nobody
  // ever answered.
  if (outcome === "failedBeforeRuling") {
    return localize("Failed before final ruling");
  }
  if (outcome === "inconclusive") {
    const assurance = verificationPassed(result)
      ? [localize("controller-checked: {0}", passedCheckSummary(result))]
      : result.checks.length > 0
        ? [localize("controller-recorded")]
        : [];
    if (modelReviewed) assurance.push(localize("model-reviewed"));
    return [localize("Inconclusive"), ...assurance].join(" · ");
  }
  if (verificationPassed(result)) {
    return [
      localize("Controller-checked: {0}", passedCheckSummary(result)),
      ...(modelReviewed ? [localize("model-reviewed")] : []),
    ].join(" · ");
  }
  if (modelReviewed) {
    return result.checks.length === 0
      ? localize("Completed · model-reviewed · unverified")
      : localize("Completed · model-reviewed");
  }
  return (result.providers ?? []).length === 1
    ? localize("Completed · single provider · unverified")
    : localize("Completed · unverified");
};

const verificationStateLine = (result: RunResultCenter): string => {
  if (result.expectations?.verification === false) {
    return localize("Not applicable: this pipeline declares no controller-owned verification.");
  }
  if (result.checks.length === 0) {
    return localize("Expected but missing: no verification check is recorded.");
  }
  const failed = result.checks.filter((check) => check.status === "failed" || check.status === "timedOut");
  const cancelled = result.checks.filter((check) => check.status === "cancelled");
  const total = result.checks.length === 1 ? localize("1 check") : localize("{0} checks", result.checks.length);
  if (failed.length > 0) {
    return localize("{0}, {1} did not pass: {2}.", total, failed.length, failed.map((check) => check.command).join(", "));
  }
  if (cancelled.length > 0) {
    return localize("{0}, {1} cancelled: {2}.", total, cancelled.length, cancelled.map((check) => check.command).join(", "));
  }
  return localize("{0}, all passed.", total);
};

const verificationCurrencyLine = (result: RunResultCenter): string => {
  const provenance = result.verificationProvenance;
  if (!provenance) return "";
  const timing = ` title="${escapeAttribute(formatDateTime(provenance.recordedAt))}"`;
  return provenance.source === "recheck"
    ? `<p class="muted result-verification-currency" data-verification-source="recheck"${timing}>${escapeHtml(localize("Current verification: rerun of the approved checks. It replaces the original run's verification."))}</p>`
    : `<p class="muted result-verification-currency" data-verification-source="run"${timing}>${escapeHtml(localize("Current verification: recorded by the original run."))}</p>`;
};

const verificationDetailsHtml = (check: RunResultCenter["checks"][number]): string => {
  const details = [
    check.exitCode === undefined ? undefined : [localize("Exit status"), String(check.exitCode)],
    check.workingDirectory === undefined ? undefined : [localize("Working directory"), check.workingDirectory],
  ].filter((entry): entry is [string, string] => entry !== undefined);
  return details.length === 0
    ? ""
    : `<dl class="result-check-details">${details.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
};

const recommendedNextAction = (result: RunResultCenter): string => {
  if (result.status === "interrupted") return localize("Review the recorded progress, then use the recovery controls to continue.");
  if (result.applyBlockedReason) {
    return localize("Do not apply. {0}. Rerun the approved checks, or fix the cause and run again.", result.applyBlockedReason.replace(/[.!?]\s*$/u, ""));
  }
  const outcome = result.finalAssessment?.outcome;
  if (outcome === "verificationFailed") {
    return localize("Do not apply. Read the failing verification, then fix the cause and run again.");
  }
  if (outcome === "failedBeforeRuling") {
    return localize("Do not apply: no final ruling was produced. Fix the failure below, then run again.");
  }
  if (outcome === "inconclusive") {
    return localize("Read the evidence gaps and unresolved risks below before you decide. Rerun the approved checks if you want the evidence proven again.");
  }
  if (outcome === "notApplicable") {
    return localize("This run has not produced a final result yet.");
  }
  return result.retainedWorktree && result.retainedRunId
    ? localize("Review the diff, then apply the work you want. Bachata stages it and commits nothing.")
    : localize("Review the findings below. This run has nothing to apply.");
};

type RulingParticipantIdentity = { agentId: string; provider?: string; adapter?: string; model?: string };

const rulingParticipantLabel = (participant: RulingParticipantIdentity, result: RunResultCenter): string => {
  const name = result.providers?.find((provider) => provider.agentId === participant.agentId)?.name ?? participant.provider ?? localize("Participant");
  const qualifiers = [participant.adapter, participant.model].filter((value): value is string => !!value);
  return qualifiers.length === 0 ? name : `${name} (${qualifiers.join(" · ")})`;
};

const rulingProvenanceLabel = (result: RunResultCenter): string | undefined => {
  const provenance = result.rulingProvenance;
  if (!provenance) {
    const name = result.providers?.find((provider) => provider.agentId === result.rulingBy || provider.name.toLowerCase() === result.rulingBy?.toLowerCase())?.name;
    return name ? localize("Ruled by {0}", name) : undefined;
  }
  const identity = (participant: RulingParticipantIdentity): string => rulingParticipantLabel(participant, result);
  const labels = provenance.participants.map(identity);
  if (provenance.kind === "unanimousConsensus") return localize("Unanimous consensus of {0}", labels.join(", "));
  if (provenance.kind === "arbiterRuling") {
    const arbiter = provenance.participants.find((participant) => participant.agentId === provenance.ruledBy);
    return localize("Arbiter ruling by {0}", arbiter ? identity(arbiter) : localize("Participant"));
  }
  if (provenance.kind === "singleProvider") return localize("Single provider result from {0}", labels[0] ?? localize("Participant"));
  if (provenance.kind === "humanResolution") return localize("Human resolution by {0}", String(provenance.resolvedBy));
  return labels.length > 0 ? localize("Controller verification over {0}", labels.join(", ")) : localize("Controller verification");
};

const outcomeIcon: Record<string, string> = {
  interrupted: "debug-stop",
  completed: "pass",
  verificationFailed: "error",
  inconclusive: "question",
  failedBeforeRuling: "error",
  notApplicable: "circle-slash",
};

// What stopped a run that never reached a ruling: the participant, the provider and model it was
// actually running on, the step, and the provider's own words. Every part the run did not record
// is left out rather than guessed at.
type PreflightRecord = {
  reason: string;
  folder?: string;
  detail?: string;
  participants: Array<{ participant: string; step: string }>;
};

const preflightRecordOf = (entry: TranscriptEntry): PreflightRecord | undefined => {
  if (entry.eventType !== "workflow.preflightFailed") return undefined;
  const record = jsonRecord(entry.data);
  const reason = jsonString(record?.reason);
  if (record === undefined || reason === undefined) return undefined;
  const folder = jsonString(record.folder);
  const detail = jsonString(record.detail);
  const listed = record.participants;
  const participants = (Array.isArray(listed) ? listed : []).flatMap((item) => {
    const participant = jsonRecord(item);
    const name = jsonString(participant?.participant);
    const step = jsonString(participant?.step);
    return name === undefined || step === undefined ? [] : [{ participant: name, step }];
  });
  return {
    reason,
    ...(folder === undefined ? {} : { folder }),
    ...(detail === undefined ? {} : { detail }),
    participants,
  };
};

const latestPreflightRecord = (panel: PanelState, error?: string): PreflightRecord | undefined => {
  const entry = [...panel.transcript]
    .reverse()
    .find((candidate) => candidate.eventType === "workflow.preflightFailed" && (error === undefined || candidate.text === error));
  return entry === undefined ? undefined : preflightRecordOf(entry);
};

const preflightActionsHtml = (record: PreflightRecord): string =>
  record.reason === "noFolder" || record.reason === "notGitWorktree"
    ? `<div class="compact-actions"><button data-action="working-directory">${escapeHtml(localize("Choose folder"))}</button></div>`
    : "";

const detailRow = (label: string, value: string | undefined): Array<[string, string]> =>
  value === undefined ? [] : [[label, value]];

const preflightDetailsHtml = (record: PreflightRecord, key: string): string => {
  const rows: Array<[string, string]> = [
    ...detailRow(localize("Folder"), record.folder),
    ...detailRow(localize("Git"), record.detail),
    ...record.participants.flatMap((entry) => detailRow(entry.participant, localize("Not started · {0}", entry.step))),
  ];
  return rows.length === 0
    ? ""
    : `<details class="info-disclosure preflight-details" ${disclosureAttributes(key)}><summary><i class="codicon codicon-info" aria-hidden="true"></i> ${escapeHtml(localize("Project details"))}</summary><dl class="result-decision-grid">${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl></details>`;
};

const runFailureHtml = (result: RunResultCenter, panel: PanelState): string => {
  const failure = result.finalAssessment?.failure;
  if (!failure) return "";
  const preflight = latestPreflightRecord(panel, failure.error);
  if (preflight !== undefined) {
    return `<section class="result-failure" data-run-failure="true">
    <h3>${escapeHtml(localize("Why no participant started"))}</h3>
    <p class="result-failure-cause">${escapeHtml(failure.error)}</p>
    ${preflightActionsHtml(preflight)}
    ${preflightDetailsHtml(preflight, "result-preflight")}
  </section>`;
  }
  const rows: Array<[string, string]> = [
    ...(failure.participant ?? failure.agentId
      ? [[localize("Participant"), failure.participant ?? participantName(panel, failure.agentId ?? "")] as [string, string]]
      : []),
    ...(failure.provider ?? failure.adapter
      ? [[localize("Provider"), failure.provider ?? failure.adapter] as [string, string]]
      : []),
    [localize("Model"), failure.model ?? localize("not recorded")],
    ...(failure.step === undefined ? [] : [[localize("Step"), failure.step] as [string, string]]),

  ];
  // The assessment line above already says the run failed before a ruling. This section says where
  // and on what, so repeating the verdict as its heading spent a line saying nothing new.
  return `<section class="result-failure" data-run-failure="true">
    <p class="result-failure-cause">${escapeHtml(failure.error)}</p>
    <details class="info-disclosure"><summary><i class="codicon codicon-info" aria-hidden="true"></i> ${escapeHtml(localize("Provider and step details"))}</summary><dl class="result-decision-grid">${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl></details>
  </section>`;
};

const resultDecisionSummaryHtml = (result: RunResultCenter, panel: PanelState, coveredFindings: ReadonlySet<string> = new Set()): string => {
  const outcome = result.status === "interrupted"
    ? "interrupted"
    : result.finalAssessment?.outcome ?? "notApplicable";
  const scope = result.changedFiles.length > 0
    ? result.changedFiles.length === 1 ? localize("1 changed file") : localize("{0} changed files", result.changedFiles.length)
    : result.expectations?.changedFiles === false
      ? localize("No write authority: this run changed nothing by contract")
      : localize("No changed file is recorded");
  const risk = result.unresolvedRisks.length > 0
    ? result.unresolvedRisks.length === 1 ? localize("1 unresolved risk") : localize("{0} unresolved risks", result.unresolvedRisks.length)
    : localize("No unresolved risk is recorded");
  const gaps = result.evidenceGaps.length > 0
    ? ", " + (result.evidenceGaps.length === 1 ? localize("1 evidence gap") : localize("{0} evidence gaps", result.evidenceGaps.length))
    : "";
  const providers = result.finalAssessment?.producedBy ?? result.providers ?? [];
  const findings = result.findings ?? [];
  const shownFindings = findings.filter((finding) => !coveredFindings.has(findingContentKey(finding)));
  const actionable = findings.filter((finding) => finding.disposition === "accepted").length;
  const unresolved = findings.filter((finding) => finding.disposition === "unresolved").length;
  const findingDetails = shownFindings.length === 0
    ? ""
    : `<ul class="result-finding-list">${shownFindings.map((finding) => {
        const location = finding.location === undefined
          ? ""
          : ` · ${finding.location.file}${finding.location.startLine === undefined ? "" : `:${String(finding.location.startLine)}${finding.location.endLine === undefined ? "" : `-${String(finding.location.endLine)}`}`}`;
        const evidence = finding.evidence.length > 0
          ? `<p><strong>${escapeHtml(localize("Evidence"))}</strong> ${escapeHtml(finding.evidence.join("; "))}</p>`
          : `<p class="muted">${escapeHtml(localize("No confirmation evidence was recorded."))}</p>`;
        const challenges = finding.challenges.length > 0
          ? `<p><strong>${escapeHtml(localize("Challenges"))}</strong> ${escapeHtml(finding.challenges.join("; "))}</p>`
          : `<p class="muted">${escapeHtml(localize("No challenge was recorded."))}</p>`;
        return `<li class="finding-${escapeAttribute(finding.disposition)}"><strong>${escapeHtml(finding.subject)}</strong><small>${escapeHtml(`${labelFor(lifecycleStateLabel, finding.disposition)}${location}`)}</small><p>${escapeHtml(finding.message)}</p>${evidence}${challenges}</li>`;
      }).join("")}</ul>`;
  return `<section class="result-decision outcome-${escapeAttribute(outcome)}" data-outcome="${escapeAttribute(outcome)}" aria-label="${escapeAttribute(localize("Run assessment"))}">
    <p class="result-assessment-status${result.finalAssessment?.failure ? " sr-only" : ""}"><strong><i class="codicon codicon-${escapeAttribute(outcomeIcon[outcome] ?? "circle-outline")}" aria-hidden="true"></i> ${escapeHtml(assessmentStatusLine(result))}</strong></p>
    <!-- EX-UI-01. The next safe action is what the reader came for, so it is beside the outcome
         rather than at the bottom of a collapsed disclosure of assessment detail. -->
    <p class="result-next-action">${escapeHtml(recommendedNextAction(result))}</p>
    ${runFailureHtml(result, panel)}
    ${actionable + unresolved > 0 ? `<p class="result-finding-summary"><strong>${escapeHtml(localize("Findings · {0} actionable · {1} need human", actionable, unresolved))}</strong></p>` : ""}
    ${findingDetails === "" ? "" : actionable + unresolved > 0 ? findingDetails : `<details class="info-disclosure result-finding-details"><summary><i class="codicon codicon-info" aria-hidden="true"></i> ${escapeHtml(localize("Finding details"))}</summary>${findingDetails}</details>`}
    <details class="info-disclosure result-assessment-details"><summary><i class="codicon codicon-info" aria-hidden="true"></i> ${escapeHtml(localize("Assessment details"))}</summary>
    <dl class="result-decision-grid">
      <dt>${escapeHtml(localize("Summary"))}</dt><dd>${escapeHtml(resultSummaryText(result.finalAssessment?.summary) ?? localize("No final assessment was recorded"))}</dd>
      <dt>${escapeHtml(localize("Changed scope"))}</dt><dd>${escapeHtml(scope)}</dd>
      <dt>${escapeHtml(localize("Verification"))}</dt><dd>${escapeHtml(verificationStateLine(result))}</dd>
      <dt>${escapeHtml(localize("Remaining risk"))}</dt><dd>${escapeHtml(`${risk}${gaps}`)}</dd>
      <dt>${escapeHtml(localize("Produced by"))}</dt><dd>${providers.length > 0 ? escapeHtml(providers.map((provider) => provider.model ? `${provider.name} (${provider.adapter} · ${provider.model})` : `${provider.name} (${provider.adapter})`).join(", ")) : escapeHtml(localize("No provider provenance was recorded"))}</dd>
    </dl>
    ${verificationCurrencyLine(result)}
    </details>
  </section>`;
};

const hunkPickerHtml = (conversationId: string, runId: string): string => {
  const entry = resultSelection(conversationId, runId);
  const loaded = entry.diff;
  if (!loaded) {
    return `<div class="result-hunks"><button data-action="orchestration-diff" data-run-id="${escapeAttribute(runId)}" data-conversation="${escapeAttribute(conversationId)}">${escapeHtml(localize("Select hunks"))}</button><p class="muted">${escapeHtml(localize("Load this run's authoritative diff to apply or export individual hunks."))}</p></div>`;
  }
  const files = entry.files;
  const hunks = entry.hunks;
  if (loaded.files.length === 0) {
    return `<div class="result-hunks">${loaded.truncated ? `<p class="muted result-hunks-truncated" ${liveRegionAttributes(`result-hunks-truncated:${runId}`, "status", loaded.truncated)}>${escapeHtml(loaded.truncated)}</p><button data-action="orchestration-diff" data-run-id="${escapeAttribute(runId)}" data-conversation="${escapeAttribute(conversationId)}">${escapeHtml(localize("Reload diff"))}</button>` : `<p class="muted">${escapeHtml(localize("This run's diff contains no file."))}</p>`}</div>`;
  }
  const rows = loaded.files.map((file) => {
    const selectedIndexes = hunks.get(file.path) ?? new Set<number>();
    const wholeFile = files.has(file.path);
    const reason = file.binary
      ? localize("binary")
      : file.renamed
        ? localize("renamed")
        : file.modeChanged
          ? localize("permissions also change")
          : file.hunks.length === 0
            ? localize("no text hunk")
            : undefined;
    const body = file.wholeFileOnly
      ? `<p class="muted">${escapeHtml(localize("Whole file only ({0}). Select the file above to include it.", reason ?? localize("not splittable")))}</p>`
      : `<ul class="result-hunk-list">${file.hunks.map((hunk) => `<li><label><input type="checkbox" data-action="result-hunk-select" data-conversation="${escapeAttribute(conversationId)}" data-run-id="${escapeAttribute(runId)}" data-path="${escapeAttribute(file.path)}" data-hunk="${String(hunk.index)}" ${wholeFile ? "disabled" : ""} ${selectedIndexes.has(hunk.index) ? "checked" : ""} aria-label="${escapeAttribute(localize("Select hunk {0} of {1}", hunk.index + 1, file.path))}"><span class="result-hunk-header">${escapeHtml(hunk.header)}</span><small>+${String(hunk.added)} −${String(hunk.removed)}</small></label><pre class="result-hunk-preview">${escapeHtml(hunk.preview)}</pre></li>`).join("")}</ul>${wholeFile ? `<p class="muted">${escapeHtml(localize("The whole file is selected, so its hunks are covered."))}</p>` : ""}`;
    return `<details class="result-hunk-file" ${disclosureAttributes(`result-hunks:${conversationId}:${file.path}`)}><summary>${escapeHtml(file.path)}<small>${file.wholeFileOnly ? escapeHtml(reason ?? localize("whole file only")) : escapeHtml(file.hunks.length === 1 ? localize("1 hunk") : localize("{0} hunks", file.hunks.length))}</small></summary>${body}</details>`;
  }).join("");
  return `<div class="result-hunks"><div class="compact-actions"><button data-action="orchestration-diff" data-run-id="${escapeAttribute(runId)}" data-conversation="${escapeAttribute(conversationId)}">${escapeHtml(localize("Reload diff"))}</button><button data-action="result-hunks-clear" data-conversation="${escapeAttribute(conversationId)}" data-run-id="${escapeAttribute(runId)}">${escapeHtml(localize("Clear hunk selection"))}</button></div>${loaded.truncated ? `<p class="muted result-hunks-truncated" ${liveRegionAttributes(`result-hunks-truncated:${runId}`, "status", loaded.truncated)}>${escapeHtml(loaded.truncated)}</p>` : ""}${rows}</div>`;
};

const evidenceStateLabel: Record<string, string> = {
  recorded: localize("Recorded"),
  notApplicable: localize("Not applicable"),
  missing: localize("Expected but missing"),
};

const evidenceStateIcon: Record<string, string> = {
  recorded: "pass",
  notApplicable: "circle-slash",
  missing: "warning",
};

// Finishing and proving are different claims, and the header is the first thing read about a
// run, so a run that stopped without proving its work does not headline as completed. With no
// assessment recorded the lifecycle label is the only honest thing to state.
const resultHeadlineLabel = (result: RunResultCenter, stopProvenance?: string): string => {
  if (result.status !== "completed") {
    return localRunStatusLabel(bachataWebviewBehavior.runStatusPresentation(
      bachataWebviewBehavior.runPhase(false, result.status),
      stopProvenance,
    ).label);
  }
  const outcome = result.finalAssessment?.outcome;
  if (outcome === "verificationFailed") return localize("Finished, not proven");
  if (outcome === "inconclusive") return localize("Finished, inconclusive");
  return statusLabel(result.status);
};

/**
 * The phase a room is in, decided once from the live run, and the way back into a run that ended,
 * decided once from that phase and how the checkpoint's own run ended. A live run offers no way
 * back into anything, and a checkpoint whose ending does not match the phase offers nothing.
 *
 */
const runPhaseOf = (panel: PanelState): RunPhase =>
  bachataWebviewBehavior.runPhase(panel.running, panel.workflowStatus);

const runRecoveryOf = (panel: PanelState, phase: RunPhase): RunRecovery | undefined => {
  const recovery = bachataWebviewBehavior.runRecovery(phase, panel.resumableWorkflow);
  if (!recovery || recovery.step === "none") return recovery;
  return { ...recovery, label: recovery.step === "resume" ? localize("Resume stopped step") : localize("Retry failed step") };
};

const recoveryPositionText = (panel: PanelState, recovery: RunRecovery): string => {
  const record = panel.resumableWorkflow;
  if (!record) return "";
  if (recovery.step === "none") {
    return localize("Could not start step {0} of {1}", record.nextStepIndex + 1, record.totalSteps) + (record.stepName ? ` · ${record.stepName}` : "");
  }
  return (recovery.step === "resume" ? localize("Stopped at step {0} of {1}", record.nextStepIndex + 1, record.totalSteps) : localize("Failed at step {0} of {1}", record.nextStepIndex + 1, record.totalSteps)) + (record.stepName ? ` · ${record.stepName}` : "");
};

const recoveryActionsHtml = (panel: PanelState, recovery: RunRecovery | undefined): string => {
  if (!panel.resumableWorkflow || !recovery) return "";
  return recovery.label === undefined
    ? `<button class="primary" data-action="workflow-restart">${escapeHtml(localize("Restart pipeline"))}</button>`
    : `<button class="primary" data-action="workflow-resume" aria-label="${escapeAttribute(`${recovery.label}: ${recoveryPositionText(panel, recovery)}`)}">${escapeHtml(recovery.label)}</button>`;
};

const recoverySecondaryActionsHtml = (panel: PanelState, recovery: RunRecovery | undefined): string => {
  if (!panel.resumableWorkflow || !recovery) return "";
  return `${recovery.label === undefined ? "" : `<button data-action="workflow-restart">${escapeHtml(localize("Restart pipeline"))}</button>`}<button class="danger" data-action="workflow-discard">${escapeHtml(localize("Discard recovery checkpoint"))}</button>`;
};

const selectedWorkLabel = (fileCount: number, hunkCount: number): string => {
  if (hunkCount === 0) return fileCount === 1 ? localize("1 selected file") : localize("{0} selected files", fileCount);
  if (fileCount === 0) return hunkCount === 1 ? localize("1 selected hunk") : localize("{0} selected hunks", hunkCount);
  if (hunkCount === 1) return fileCount === 1 ? localize("1 selected hunk and 1 file") : localize("1 selected hunk and {0} files", fileCount);
  return fileCount === 1 ? localize("{0} selected hunks and 1 file", hunkCount) : localize("{0} selected hunks and {1} files", hunkCount, fileCount);
};

const resultApplyLabel = (fileCount: number, hunkCount: number, override: boolean): string => {
  if (fileCount === 0 && hunkCount === 0) return override ? localize("Apply to current branch despite an inconclusive result") : localize("Apply to current branch");
  const selection = selectedWorkLabel(fileCount, hunkCount);
  return override ? localize("Apply {0} despite an inconclusive result", selection) : localize("Apply {0}", selection);
};

const resultCenterHtml = (conversationId: string, panel: PanelState): string => {
  const result = state.manager.resultsByConversation?.[conversationId];
  if (!result) return "";
  const phase = runPhaseOf(panel);
  if (phase === "running" || phase === "waiting") return "";
  const recovery = runRecoveryOf(panel, phase);
  const decisionEvent = resultDecisionEvent(conversationId);
  const decisionPayload = jsonRecord(decisionEvent?.payload);
  const structured = structuredRuling(result.finalRuling);
  const canonicalCandidate = result.finalDecision !== undefined || jsonRecord(decisionPayload?.humanResolution)
    ? decisionPayload?.candidate : structured ?? result.finalRuling ?? decisionPayload?.candidate;
  const candidateSources = decisionPayload?.status === "resolved"
    ? (Array.isArray(decisionPayload.participants) ? decisionPayload.participants : []).map((participant) => ({
        candidate: jsonRecord(jsonRecord(participant)?.candidate), findings: unresolvedParticipantFindings(participant, result.findings),
      }))
    : [{ candidate: jsonRecord(canonicalCandidate), findings: result.findings }];
  const coveredFindings = new Set(candidateSources.flatMap(({ candidate, findings }) =>
    (Array.isArray(candidate?.findings) ? candidate.findings : []).flatMap((value) => {
      const finding = jsonRecord(value);
      const normalized = finding ? normalizedResultFinding(finding, findings) : undefined;
      return normalized ? [findingContentKey(normalized)] : [];
    })));

  const resultRunId = result.retainedRunId;
  const selection = new Set(selectedResultPaths(conversationId, resultRunId));
  const hunkCount = selectedHunkReferences(conversationId, resultRunId).length;
  const files = result.changedFiles.length > 0
    ? `<ul class="result-files">${result.changedFiles.map((file) => `<li><label class="result-file-select"><input type="checkbox" data-action="result-file-select" data-conversation="${escapeAttribute(conversationId)}" data-run-id="${escapeAttribute(resultRunId ?? "")}" data-path="${escapeAttribute(file)}" ${selection.has(file) ? "checked" : ""} aria-label="${escapeAttribute(localize("Select {0} for apply", file))}"></label><button data-action="result-reveal-file" data-path="${escapeAttribute(file)}">${escapeHtml(file)}</button>&nbsp;<button class="result-file-changes" data-action="result-open-changes" data-path="${escapeAttribute(file)}" title="${escapeAttribute(localize("Open changes in the diff editor"))}">${escapeHtml(localize("Changes"))}</button></li>`).join("")}</ul><p class="muted result-selection-summary">${escapeHtml(selection.size === 0 && hunkCount === 0 ? localize("No file or hunk is selected: apply and patch export cover the whole run.") : hunkCount === 0 ? localize("{0} of {1} files selected: apply and patch export cover only those.", selection.size, result.changedFiles.length) : hunkCount === 1 ? localize("{0} of {1} files and 1 hunk selected: apply and patch export cover only those.", selection.size, result.changedFiles.length) : localize("{0} of {1} files and {2} hunks selected: apply and patch export cover only those.", selection.size, result.changedFiles.length, hunkCount))}</p>`
    : result.expectations?.changedFiles === false
      ? `<p class="muted">${escapeHtml(localize("Not applicable: this contract grants no write authority."))}</p>`
      : `<p class="muted">${escapeHtml(localize("No changed files were recorded."))}</p>`;
  const checks = result.checks.length > 0
    ? `<ul class="result-checks">${result.checks.map((check) => `<li class="status-${escapeAttribute(check.status === "passed" ? "completed" : "error")}"><span>${escapeHtml(check.command)}</span><strong>${escapeHtml(labelFor(checkStatusLabel, check.status))}</strong>${verificationDetailsHtml(check)}</li>`).join("")}</ul>`
    : result.expectations?.verification === false
      ? `<p class="muted">${escapeHtml(localize("Not applicable: this pipeline declares no controller-owned verification."))}</p>`
      : `<p class="muted">${escapeHtml(localize("No verification evidence was recorded."))}</p>`;
  // The failure section above states the error that stopped the run, in full, with the
  // participant and model behind it. Printing the same sentence again under "Unresolved risks"
  // reads as a second problem. The record still carries it; the result states it once.
  const failureError = result.finalAssessment?.failure?.error;
  const visibleRisks = result.unresolvedRisks.filter((risk) => risk !== failureError);
  const risks = visibleRisks.length > 0
    ? `<ul class="ruling-list risks">${visibleRisks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul>`
    : result.unresolvedRisks.length > 0
      ? `<p class="muted">${escapeHtml(localize("The only unresolved risk recorded is the failure stated above."))}</p>`
      : `<p class="muted">${escapeHtml(localize("No unresolved risks were recorded."))}</p>`;
  const recovered = (result.recoveredErrors ?? []).length > 0
    ? `<section><h3>${escapeHtml(localize("Recovered errors"))}</h3><ul class="ruling-list">${result.recoveredErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></section>`
    : "";
  const evidenceEntries = result.evidence ?? [];
  const gaps = evidenceEntries.length > 0
    ? `<div class="result-gaps evidence-ledger"><strong>${escapeHtml(localize("Evidence"))}</strong><ul>${evidenceEntries.map((item) => `<li class="evidence-${escapeAttribute(item.state)}"><span class="evidence-state"><i class="codicon codicon-${escapeAttribute(evidenceStateIcon[item.state] ?? "circle-outline")}" aria-hidden="true"></i> ${escapeHtml(evidenceStateLabel[item.state] ?? item.state)}</span><span><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.detail)}</span></li>`).join("")}</ul></div>`
    : result.evidenceGaps.length > 0
      ? `<div class="result-gaps"><strong>${escapeHtml(localize("Evidence gaps"))}</strong><ul>${result.evidenceGaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("")}</ul></div>`
      : "";
  const orchestrationRunId = resultRunId;
  const handoff = result.retainedWorktree && orchestrationRunId
    ? `<section class="result-handoff">
      <h3>${escapeHtml(localize("Inspect and apply"))}</h3>
      <p class="muted">${escapeHtml(localize("This run's retained work is in a Git worktree. Nothing has been applied to your branch and nothing has been committed."))}</p>
      <ol class="handoff-steps">
        <li><strong>${escapeHtml(localize("Review the final diff."))}</strong> ${escapeHtml(localize("Open each changed file above, or export the patch."))}</li>
        <li><strong>${escapeHtml(localize("Check the evidence."))}</strong> ${escapeHtml(localize("Checks recorded: {0}. Unresolved risks: {1}. Evidence gaps: {2}.", result.checks.length, result.unresolvedRisks.length, result.evidenceGaps.length))} ${escapeHtml(rulingProvenanceLabel(result) ? localize("{0}.", rulingProvenanceLabel(result) ?? "") : localize("No ruling provenance was recorded."))}</li>
        <li>${escapeHtml(localize("Rerun the approved checks if you want them proven again right now."))}</li>
        <li><strong>${escapeHtml(localize("Apply."))}</strong> ${escapeHtml(localize("Bachata stages the work on your current branch and creates no commit. On conflict the working tree is restored and this worktree is kept."))}</li>
      </ol>
      <div class="compact-actions">
        <button data-action="orchestration-recheck" data-run-id="${escapeAttribute(orchestrationRunId)}" data-conversation="${escapeAttribute(conversationId)}">${escapeHtml(localize("Rerun approved checks"))}</button>
        <button data-action="orchestration-patch" data-run-id="${escapeAttribute(orchestrationRunId)}" data-conversation="${escapeAttribute(conversationId)}">${escapeHtml(selection.size > 0 || hunkCount > 0 ? localize("Export patch (selected)") : localize("Export patch"))}</button>
        <button${result.applyOverrideReason ? "" : ` class="primary"`} data-action="orchestration-apply" data-run-id="${escapeAttribute(orchestrationRunId)}" data-conversation="${escapeAttribute(conversationId)}"${result.applyBlockedReason ? ` disabled title="${escapeAttribute(result.applyBlockedReason)}"` : ""}>${escapeHtml(resultApplyLabel(selection.size, hunkCount, Boolean(result.applyOverrideReason)))}</button>
      </div>
      ${result.applyBlockedReason ? `<p class="result-apply-blocked" ${liveRegionAttributes(`result-apply:${conversationId}`, "status", `blocked:${result.applyBlockedReason}`)}>${escapeHtml(localize("Apply is disabled: {0}. Rerun the approved checks to prove the work again.", result.applyBlockedReason))}</p>` : result.applyOverrideReason ? `<p class="result-apply-override" ${liveRegionAttributes(`result-apply:${conversationId}`, "status", `override:${result.applyOverrideReason}`)}>${escapeHtml(localize("This run is inconclusive: {0}. Applying it is an explicit override; Bachata does not consider this work proven.", result.applyOverrideReason))}</p>` : ""}
      ${hunkPickerHtml(conversationId, orchestrationRunId)}
    </section>`
    : "";
  const fileSection = result.changedFiles.length > 0 || result.diffSummary || result.expectations?.changedFiles === true
    ? `<section><h3>${escapeHtml(localize("Changed files"))}</h3>${files}${result.diffSummary ? `<pre>${escapeHtml(result.diffSummary)}</pre>` : ""}</section>` : "";
  const checkSection = result.checks.length > 0 || result.expectations?.verification === true
    ? `<section><h3>${escapeHtml(localize("Verification"))}</h3>${checks}${verificationCurrencyLine(result)}</section>` : "";
  const rulingSection = decisionEvent
    ? finalRulingHtml(canonicalCandidate === undefined ? decisionEvent : { ...decisionEvent, payload: { ...decisionPayload, candidate: canonicalCandidate } }, panel, result.findings) ?? ""
    : result.finalRuling ? `<section><h3>${escapeHtml(localize("Final ruling"))}</h3>${resultRulingHtml(result.finalRuling, result.findings)}${rulingProvenanceLabel(result) ? `<p class="muted">${escapeHtml(rulingProvenanceLabel(result) ?? "")}</p>` : ""}</section>`
      : result.expectations?.finalRuling === true && !result.finalAssessment?.failure ? `<section><h3>${escapeHtml(localize("Final ruling"))}</h3><p class="muted">${escapeHtml(localize("No final ruling was recorded."))}</p></section>` : "";
  const evidenceSectionsHtml = `${rulingSection}${fileSection || checkSection ? `<div class="result-grid">${fileSection}${checkSection}</div>` : ""}${visibleRisks.length > 0 ? `<section><h3>${escapeHtml(localize("Unresolved risks"))}</h3>${risks}</section>` : ""}`;
  return `<section class="result-center">
    <header><div><span class="decision-label">${escapeHtml(localize("Run result"))}</span><h2>${escapeHtml(resultHeadlineLabel(result, panel.resumableWorkflow?.outcome))}</h2>${recovery ? `<p class="result-recovery-position">${escapeHtml(recoveryPositionText(panel, recovery))}</p>` : ""}</div><div class="compact-actions">${recoveryActionsHtml(panel, recovery)}${result.retainedWorktree && orchestrationRunId ? `<button data-action="orchestration-reveal" data-run-id="${escapeAttribute(orchestrationRunId)}" data-conversation="${escapeAttribute(conversationId)}">${escapeHtml(localize("Reveal worktree"))}</button>` : ""}<details class="header-action-menu wide-trigger" ${disclosureAttributes(`result-export:${conversationId}`)}><summary aria-label="${escapeAttribute(localize("Run result actions"))}" title="${escapeAttribute(localize("Run result actions"))}">${escapeHtml(localize("More"))}</summary><div>${recoverySecondaryActionsHtml(panel, recovery)}<button data-action="result-publish-findings">${escapeHtml(localize("Publish findings to Problems"))}</button><button data-action="result-source-control">${escapeHtml(localize("Open Source Control"))}</button><button data-action="run-bundle-export" data-format="bundle" data-conversation="${escapeAttribute(conversationId)}">${escapeHtml(localize("Run bundle (JSON)"))}</button><button data-action="run-bundle-export" data-format="markdown" data-conversation="${escapeAttribute(conversationId)}">${escapeHtml(localize("Evidence report (Markdown)"))}</button><button data-action="run-bundle-export" data-format="sarif" data-conversation="${escapeAttribute(conversationId)}">${escapeHtml(localize("Evidence findings (SARIF)"))}</button></div></details></div></header>
    ${resultDecisionSummaryHtml(result, panel, coveredFindings)}
    ${evidenceSectionsHtml}
    ${recovered}
    ${result.retainedWorktree ? `<details class="info-disclosure" ${disclosureAttributes(`result-worktree:${conversationId}`)}><summary>${escapeHtml(localize("Recovery worktree"))}</summary><p class="result-worktree">${escapeHtml(result.retainedWorktree)}</p></details>` : ""}
    ${gaps ? `<details class="info-disclosure" ${disclosureAttributes(`result-evidence:${conversationId}`)}><summary>${escapeHtml(localize("Evidence ledger"))}</summary>${gaps}</details>` : ""}
    ${handoff}
  </section>`;
};

const childRunsHtml = (conversationId: string): string => {
  const children = childConversationsFor(conversationId);
  if (children.length === 0) {
    return "";
  }
  return `<section class="child-runs"><h2>${escapeHtml(localize("Task runs"))}</h2>${children.map((child) => {
    const { status, label } = conversationStatus(child);
    return `<button class="child-run status-${escapeAttribute(status)}" data-action="select-conversation" data-conversation="${escapeAttribute(child.id)}"><span class="room-presence status-${escapeAttribute(status)}"></span><span><strong>${escapeHtml(runTabLabel(child))}</strong></span><small>${escapeHtml(label)}</small></button>`;
  }).join("")}</section>`;
};

/**
 * What an interaction card will accept, and what it is still waiting for.
 *
 * These predicates answer for the decision cards this module already draws, and main.ts is a
 * bootstrap rather than an implementation container.
 */
const optionValue = (option: unknown): { id: string; label: string; description?: string } | undefined => {
  if (!option || typeof option !== "object" || Array.isArray(option)) {
    return undefined;
  }
  const value = option as Record<string, unknown>;
  if (typeof value.id !== "string") {
    return undefined;
  }
  return {
    id: value.id,
    label: typeof value.label === "string" ? value.label : value.id,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  };
};

const interactionDraftText = (interaction: InteractionSummary): string =>
  interaction.secret
    ? state.secretDrafts.get(interaction.interactionRef) ?? ""
    : interaction.freeText;

const interactionCanSubmit = (
  interaction: InteractionSummary,
  selected = interaction.selected,
  freeText = interactionDraftText(interaction),
): boolean => {
  if (state.pendingInteractions.has(interaction.interactionRef)) {
    return false;
  }
  const optionIds = new Set(
    interaction.options
      .map(optionValue)
      .filter((item): item is NonNullable<ReturnType<typeof optionValue>> => Boolean(item))
      .map((option) => option.id),
  );
  const validSelected = Array.from(new Set(selected)).filter((id) => optionIds.has(id));
  if (interaction.kind === "executionChecklist") {
    return true;
  }
  if (interaction.kind === "permission" || interaction.kind === "humanGate") {
    return validSelected.length === 1;
  }
  if (interaction.secret) {
    return freeText.trim().length > 0;
  }
  return validSelected.length > 0 || (interaction.allowFreeText && freeText.trim().length > 0);
};

/**
 * A disabled control that does not say what it is waiting for is a dead end, and `disabled` also
 * takes the button out of the tab order, so the reason has to travel with the button itself.
 */
const interactionSubmitBlockedReason = (
  interaction: InteractionSummary,
  selected = interaction.selected,
  freeText = interactionDraftText(interaction),
): string | undefined => {
  if (interactionCanSubmit(interaction, selected, freeText)) {
    return undefined;
  }
  if (state.pendingInteractions.has(interaction.interactionRef)) {
    return localize("This answer is being submitted.");
  }
  if (interaction.secret) {
    return localize("Enter the requested value to submit.");
  }
  if (interaction.kind === "permission" || interaction.kind === "humanGate") {
    return localize("Choose one option to submit.");
  }
  return interaction.allowFreeText
    ? localize("Choose an option, or write a reply, to submit.")
    : localize("Choose an option to submit.");
};

const interactionSubmitLabel = (interaction: InteractionSummary, selected = interaction.selected): string => {
  if (interaction.kind === "executionChecklist" && selected.length === 0) return localize("Continue with none");
  if (interaction.kind !== "humanGate") return localize("Submit");
  const action = selected[0];
  const disagreement = interaction.humanGate?.reason === "maxConsensusRounds" ||
    interaction.options.some((option) => optionValue(option)?.id === "acceptUnresolved");
  return action === "acceptUnresolved" || action?.startsWith("acceptParticipant:") ? localize("Save decision and finish")
    : action === "retry" ? disagreement ? localize("Request one more round") : localize("Retry step")
      : action === "cancel" ? disagreement ? localize("Leave for later") : localize("Stop run") : localize("Confirm decision");
};

const interactionTextPresentation = (interaction: InteractionSummary, selected = interaction.selected): { label: string; placeholder: string } => {
  const resolution = interaction.kind === "humanGate" && (interaction.humanGate?.reason === "maxConsensusRounds" ||
    interaction.options.some((option) => optionValue(option)?.id === "acceptUnresolved"));
  return resolution
    ? selected[0] === "retry" ? { label: localize("Review instructions"), placeholder: localize("Guide the next review round…") }
      : { label: localize("Decision rationale"), placeholder: localize("Decision rationale…") }
    : { label: localize("Additional instructions"), placeholder: localize("Additional instructions…") };
};
