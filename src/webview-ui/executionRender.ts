/**
 * Execution rendering: participants, rulings, workflow stages, results, evidence and
 * verification.
 *
 * Concatenated after the direction renderers. Everything here reads a run's projected result
 * and renders it; nothing here decides a disposition.
 */

const decisionParticipantHtml = (
  participant: JsonValue,
  panel: PanelState | undefined,
): string => {
  const record = jsonRecord(participant);
  const agentId = jsonString(record?.agentId);
  if (!record || !agentId) {
    return "";
  }
  const agentName = panel?.agents[agentId]?.name ?? agentId;
  const valid = record.valid === true;
  const accepted = record.accepted === true;
  const status = !valid ? "Invalid output" : accepted ? "Accepted candidate" : "Different candidate";
  return `<button class="ruling-participant" data-action="focus-agent-output" data-agent="${escapeAttribute(agentId)}"><span>${escapeHtml(agentName)}</span><small>${escapeHtml(status)}</small></button>`;
};

const participantColumnHtml = (
  participant: JsonValue,
  panel: PanelState | undefined,
  eventId: number,
): string => {
  const record = jsonRecord(participant);
  const agentId = jsonString(record?.agentId);
  if (!record || !agentId) return "";
  const agentName = panel?.agents[agentId]?.name ?? agentId;
  const valid = record.valid === true;
  const accepted = record.accepted === true;
  const objections = Array.isArray(record.objections)
    ? record.objections.filter((value): value is string => typeof value === "string")
    : [];
  const risks = Array.isArray(record.unresolvedRisks)
    ? record.unresolvedRisks.filter((value): value is string => typeof value === "string")
    : [];
  const validationErrors = Array.isArray(record.validationErrors)
    ? record.validationErrors.filter((value): value is string => typeof value === "string")
    : [];
  const hash = jsonString(record.candidateHash);
  const candidate = record.candidate;
  const output = candidate === undefined || candidate === null
    ? `<p class="muted">No output was published.</p>`
    : typeof candidate === "string"
      ? `<div class="markdown">${renderMarkdown(candidate)}</div>`
      : jsonDetailsHtml("Output", candidate, `compare:${String(eventId)}:${agentId}`);
  return `<section class="compare-column ${accepted ? "accepted" : ""}">
    <header><strong>${escapeHtml(agentName)}</strong><small>${escapeHtml(!valid ? "Invalid output" : accepted ? "Accepted candidate" : "Different candidate")}</small>${hash ? `<code title="Candidate hash">${escapeHtml(hash.slice(0, 12))}</code>` : ""}</header>
    ${output}
    ${objections.length > 0 ? `<h5>Objections raised</h5><ul class="ruling-list">${objections.map((text) => `<li>${escapeHtml(text)}</li>`).join("")}</ul>` : `<p class="muted">Raised no objection.</p>`}
    ${risks.length > 0 ? `<h5>Risks reported</h5><ul class="ruling-list risks">${risks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul>` : ""}
    ${validationErrors.length > 0 ? `<h5>Validation errors</h5><ul class="ruling-list">${validationErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>` : ""}
  </section>`;
};

type RulingSummary = {
  id: number;
  createdAt: string;
  lead?: string;
  candidateId?: string;
  objections: number;
  overruled: number;
  risks: string[];
};

const rulingSummary = (
  event: WorkflowEventSummary,
  panel: PanelState | undefined,
): RulingSummary | undefined => {
  if (event.type !== "decision.published") return undefined;
  const payload = jsonRecord(event.payload);
  if (!payload) return undefined;
  const objections = Array.isArray(payload.objections) ? payload.objections : [];
  const ruledBy = jsonString(payload.ruledBy);
  const summaryCandidateId = jsonString(payload.candidateId);
  return {
    id: event.id,
    createdAt: event.createdAt,
    ...(ruledBy ? { lead: panel?.agents[ruledBy]?.name ?? ruledBy } : {}),
    ...(summaryCandidateId === undefined ? {} : { candidateId: summaryCandidateId }),
    objections: objections.length,
    overruled: objections.filter((value) => jsonRecord(value)?.accepted !== true).length,
    risks: Array.isArray(payload.unresolvedRisks)
      ? payload.unresolvedRisks.filter((risk): risk is string => typeof risk === "string")
      : [],
  };
};

const rulingTraceHtml = (
  events: WorkflowEventSummary[],
  panel: PanelState | undefined,
): string => {
  const summaries = events
    .map((event) => rulingSummary(event, panel))
    .filter((summary): summary is RulingSummary => summary !== undefined);
  if (summaries.length < 2) return "";
  const rows = summaries.map((summary, index) => {
    const previous = summaries[index - 1];
    const added = previous ? summary.risks.filter((risk) => !previous.risks.includes(risk)) : [];
    const resolved = previous ? previous.risks.filter((risk) => !summary.risks.includes(risk)) : [];
    const change = !previous
      ? "first ruling"
      : [
          added.length > 0 ? `${String(added.length)} new risk${added.length === 1 ? "" : "s"}` : "",
          resolved.length > 0 ? `${String(resolved.length)} resolved` : "",
        ].filter(Boolean).join(", ") || "no change in risks";
    return `<tr><td>${String(index + 1)}</td><td>${escapeHtml(formatDateTime(summary.createdAt))}</td><td>${escapeHtml(summary.lead ?? "Consensus")}</td><td>${escapeHtml(summary.candidateId ?? "not assigned")}</td><td>${String(summary.objections)} (${String(summary.overruled)} overruled)</td><td>${String(summary.risks.length)}</td><td>${escapeHtml(change)}</td></tr>`;
  }).join("");
  return `<section class="ruling-trace"><h2>Iteration comparison</h2><table><thead><tr><th>#</th><th>Ruled</th><th>Lead</th><th>Candidate</th><th>Objections</th><th>Risks</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table></section>`;
};

const finalRulingHtml = (
  event: WorkflowEventSummary,
  panel: PanelState | undefined,
): string | undefined => {
  if (event.type !== "decision.published") {
    return undefined;
  }
  const payload = jsonRecord(event.payload);
  if (!payload) {
    return undefined;
  }
  const ruledBy = jsonString(payload.ruledBy);
  const leadName = ruledBy ? panel?.agents[ruledBy]?.name ?? ruledBy : undefined;
  const decisionLabel = ruledBy ? "Lead’s Final Ruling" : "Consensus Decision";
  const candidateId = jsonString(payload.candidateId);
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
    const agentName = panel?.agents[agentId]?.name ?? agentId;
    const aligned = objection?.accepted === true;
    return [`<li><span><strong>${escapeHtml(agentName)}</strong> ${escapeHtml(text)}</span><small class="ruling-disposition ${aligned ? "accepted" : "overruled"}">${aligned ? "Aligned" : "Overruled"}</small></li>`];
  }).join("");
  const participantItems = participants.map((participant) => decisionParticipantHtml(participant, panel)).join("");
  const selectedResult = candidate === undefined
    ? `<p class="muted">No selected result was published.</p>`
    : typeof candidate === "string"
      ? `<div class="markdown ruling-result">${renderMarkdown(candidate)}</div>`
      : jsonDetailsHtml("Selected result", candidate, `ruling:${event.id}:selected`);
  return `<article class="final-ruling-card">
    <div class="ruling-heading"><div><span class="decision-label">${decisionLabel}</span><h3>${escapeHtml(event.title ?? "Final decision")}</h3></div><small>${escapeHtml(formatDateTime(event.createdAt))}</small></div>
    <dl class="ruling-meta"><dt>Lead</dt><dd>${escapeHtml(leadName ?? "Consensus")}</dd><dt>Candidate</dt><dd>${escapeHtml(candidateId ?? "Not assigned")}</dd></dl>
    ${selectedResult}
    ${participantItems ? `<section><h4>Participant outputs</h4><div class="ruling-participants">${participantItems}</div></section>` : ""}
    ${participants.length > 1 ? `<details class="ruling-compare" ${disclosureAttributes(`ruling:${String(event.id)}:compare`)}><summary>Compare ${String(participants.length)} participant outputs side by side</summary><div class="compare-grid">${participants.map((participant) => participantColumnHtml(participant, panel, event.id)).join("")}</div></details>` : ""}
    ${objectionItems ? `<section><h4>Objections</h4><ul class="ruling-list">${objectionItems}</ul></section>` : `<p class="muted">No objections were recorded.</p>`}
    ${unresolvedRisks.length > 0 ? `<section><h4>Unresolved risks</h4><ul class="ruling-list risks">${unresolvedRisks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul></section>` : `<p class="muted">No unresolved risks were recorded.</p>`}
  </article>`;
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
type PipelineStepState = "waiting" | "running" | "completed" | "failed" | "interrupted";

const pipelineStepStateLabel: Record<PipelineStepState, string> = {
  waiting: "Waiting",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
};

const pipelineStepStateIcon: Record<PipelineStepState, string> = {
  waiting: "circle-outline",
  running: "loading codicon-modifier-spin",
  completed: "pass-filled",
  failed: "error",
  interrupted: "debug-pause",
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
  return Array.from(rows.values());
};

const pipelineStepRowHtml = (
  conversationId: string,
  row: PipelineStepRow,
): string => {
  const timing = row.startedAt === undefined
    ? `<small class="pipeline-step-timing muted">Not started</small>`
    // Only recorded timestamps are shown. A step whose own events span no measurable time gets a
    // start time and nothing else rather than a duration nobody recorded.
    : `<small class="pipeline-step-timing">Started ${escapeHtml(formatDateTime(row.startedAt))}</small>`;
  // The row's own heading is the step name. An activity entry that repeats it says nothing the
  // reader has not just read, so the step's own start event contributes its timestamp and its
  // technical detail through the rows below rather than a line restating the name.
  const activity = row.events.filter((event) => (event.title ?? event.type) !== row.name);
  const activityHtml = activity.length === 0
    ? `<p class="muted">No activity was recorded for this step.</p>`
    : `<ul class="pipeline-step-activity">${activity.map((event) => `<li class="status-${escapeAttribute(event.status ?? "idle")}"><strong>${escapeHtml(event.title ?? event.type)}</strong><small>${escapeHtml(event.type)} · ${escapeHtml(formatDateTime(event.createdAt))}</small>${event.payload === undefined ? "" : jsonDetailsHtml("Technical detail", event.payload, `pipeline-step:${conversationId}:${row.id}:${String(event.id)}`)}</li>`).join("")}</ul>`;
  return `<li class="pipeline-step pipeline-step-${escapeAttribute(row.state)}">
    <details ${disclosureAttributes(`pipeline-step:${conversationId}:${row.id}`)}>
      <summary>
        <span class="pipeline-step-position" aria-hidden="true">${String(row.position)}</span>
        <span class="pipeline-step-name">${escapeHtml(row.name)}</span>
        <span class="pipeline-step-state"><i class="codicon codicon-${escapeAttribute(pipelineStepStateIcon[row.state])}" aria-hidden="true"></i> ${escapeHtml(pipelineStepStateLabel[row.state])}</span>
        ${timing}
      </summary>
      <div class="pipeline-step-body">${activityHtml}</div>
    </details>
  </li>`;
};

const pipelineSummaryHtml = (conversationId: string): string => {
  const events = state.manager.eventsByConversation[conversationId] ?? [];
  const panel = state.panels.get(conversationId);
  const steps = panel?.selectedPipelineDefinition?.steps ?? [];
  if (steps.length === 0) return "";
  const rows = pipelineStepRows(steps, events);
  const counts = rows.reduce<Record<PipelineStepState, number>>((totals, row) => ({
    ...totals,
    [row.state]: totals[row.state] + 1,
  }), { waiting: 0, running: 0, completed: 0, failed: 0, interrupted: 0 });
  const headline = (["running", "failed", "interrupted", "completed", "waiting"] as PipelineStepState[])
    .filter((stateName) => counts[stateName] > 0)
    .map((stateName) => `${String(counts[stateName])} ${pipelineStepStateLabel[stateName].toLowerCase()}`)
    .join(" · ");
  return `<section class="pipeline-summary">
    <header><h2>Pipeline</h2><p class="pipeline-summary-counts">${escapeHtml(`${String(rows.length)} step${rows.length === 1 ? "" : "s"} · ${headline}`)}</p></header>
    <ol class="pipeline-step-list">${rows.map((row) => pipelineStepRowHtml(conversationId, row)).join("")}</ol>
  </section>`;
};

const workflowHtml = (conversationId: string): string => {
  const events = state.manager.eventsByConversation[conversationId] ?? [];
  if (events.length === 0) {
    return "";
  }
  const panel = state.panels.get(conversationId);
  // EX-UI-01. A failed step says so where it is, and says what happens next, rather than leaving
  // the reader to match a banner at the top of the window against a dot in this list.
  const failureDetail = (payload: unknown): string | undefined => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const record = payload as Record<string, unknown>;
    const value = record.error ?? record.message ?? record.reason;
    return typeof value === "string" && value.trim().length > 0 ? value : undefined;
  };
  const failureNote = (event: { status?: string; payload?: unknown }): string =>
    event.status !== "failed"
      ? ""
      : `<p class="workflow-event-failure">${escapeHtml(failureDetail(event.payload) ?? "This step failed.")} <span class="muted">The run stopped here; nothing was resent.</span></p>`;
  // EX-UI-03. The compact summary answers "where is this run"; the flat stream answers "what
  // exactly was recorded". Only the first is a question a reader has on arrival, so the stream
  // moves behind a disclosure rather than being the page.
  const rulings = events
    .map((event) => finalRulingHtml(event, panel))
    .filter((html): html is string => html !== undefined)
    .join("");
  // The history keeps what each attempt recorded, not only that it happened. The detail is the
  // bounded, redacted projection the manager sent, and it stays behind its own closed disclosure
  // so the stream still reads as a list rather than as a dump.
  const stream = events.map((event) => `<article class="workflow-event status-${escapeAttribute(event.status ?? "idle")}">
    <span class="workflow-dot"></span>
    <div><strong>${escapeHtml(event.title ?? event.type)}</strong><small>${escapeHtml(event.type)} · ${escapeHtml(formatDateTime(event.createdAt))}</small>${failureNote(event)}${event.payload === undefined ? "" : jsonDetailsHtml("Technical detail", event.payload, `workflow-event:${conversationId}:${String(event.id)}`)}</div>
  </article>`).join("");
  return `${rulingTraceHtml(events, panel)}${pipelineSummaryHtml(conversationId)}${rulings}<details class="info-disclosure workflow-timeline" ${disclosureAttributes(`workflow-events:${conversationId}`)}><summary><i class="codicon codicon-info" aria-hidden="true"></i> Raw event history · ${String(events.length)} recorded</summary><div class="workflow-timeline-body">${stream}</div></details>`;
};

/**
 * The two decision cards the execution column shows: the human gate the run is stopped on,
 * and the approvals a participant is waiting for.
 */
// `stop` reaches a gate from a provider that halts the run outright and has no entry in the
// shared label map, so without this it prints as the bare enum value.
const extraGateActionLabels: Record<string, string> = {
  stop: "Stop the run",
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
  action === "requestArbiterRuling" && arbiter !== undefined
    ? `Ask ${arbiter} to rule`
    : extraGateActionLabels[action] ?? gateActionLabel(action);

// `reason` is the runtime's enum; only one gate site supplies `detail`, so the card needs a
// sentence for each value rather than printing the bare identifier.
const gateReasonSentence: Record<PendingHumanGate["reason"], string> = {
  beforeStep: "This step is about to run. Decide whether it should.",
  afterStep: "This step has finished. Decide what happens next.",
  invalidConsensus: "The last consensus round did not produce a valid answer.",
  maxConsensusRounds: "The participants reached the round limit without agreeing.",
};

const gateHtml = (panel: PanelState): string => {
  const gate = panel.pendingGate;
  if (!gate) {
    return "";
  }
  const arbiter = gateArbiterName(panel, gate);
  const choices = gate.allowedActions.filter((action) => action !== "rollback");
  const expected = choices.includes("continue") ? "continue" : choices.find((action) => !haltingGateActions.has(action));
  const rollback = gate.allowedActions.includes("rollback")
    ? `<div class="decision-rollback"><label for="rollback-target">Return to step</label><select id="rollback-target">${gate.rollbackTargets.map((target) => `<option value="${escapeAttribute(target.id)}">${escapeHtml(target.name)}</option>`).join("")}</select><button data-action="gate" data-gate-action="rollback">${escapeHtml(gateChoiceLabel("rollback"))}</button></div>`
    : "";
  return `<article class="decision-card" id="pending-gate" tabindex="-1">
    <div class="decision-label">Your decision</div><h2>${escapeHtml(gate.stepName)}</h2><p>${escapeHtml(gate.detail ?? gateReasonSentence[gate.reason] ?? gate.reason)}</p>
    <div class="decision-actions">
      ${choices.map((action) => `<button${haltingGateActions.has(action) ? ` class="danger"` : action === expected ? ` class="primary"` : ""} data-action="gate" data-gate-action="${action}">${escapeHtml(gateChoiceLabel(action, arbiter))}</button>`).join("")}
    </div>
    ${rollback}
  </article>`;
};

const approvalKindLabel = (kind: PendingApproval["kind"]): string => {
  const labels: Record<PendingApproval["kind"], string> = {
    command: "Run a command",
    fileChange: "Change files",
    permissions: "Extra permissions",
    browserAction: "Browser workspace action",
  };
  return labels[kind] ?? "Approval";
};

const approvalScopeLabel: Record<PendingApproval["kind"], string> = {
  command: "command",
  fileChange: "file change",
  permissions: "permission request",
  browserAction: "browser action",
};

const browserActionRiskLabel: Record<string, string> = {
  readOnly: "read-only",
  mutating: "file-changing",
  destructive: "destructive",
};

const browserActionPhrase = (
  kind: string,
  action: { [key: string]: JsonValue },
): string | undefined => {
  const target = jsonString(action.path);
  const query = jsonString(action.query);
  if (kind === "workspace.read") return `read ${target ?? "a workspace file"}`;
  if (kind === "workspace.list") return `list ${target ?? "your workspace"}`;
  if (kind === "workspace.search") {
    return `search ${target ?? "your workspace"}${query === undefined ? "" : ` for ${query}`}`;
  }
  if (kind === "workspace.write") return `write to ${target ?? "a workspace file"}`;
  if (kind === "workspace.applyPatch") return `apply a patch to ${target ?? "your workspace"}`;
  if (kind === "workspace.delete") return `delete ${target ?? "a workspace path"}`;
  if (kind === "shell.run") return "run a shell command in your workspace";
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
  return `${agentName} wants to ${phrase}.${classification === undefined ? "" : ` Bachata classified this as a ${classification} action.`}`;
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
        : `“${sessionChoice.label}” covers every later ${approvalScopeLabel[approval.kind]} from ${agentName} in this run, without asking again.`;
      return `<article class="decision-card approval-card ${pending ? "pending" : ""}" id="approval-${escapeAttribute(approvalKey(approval.agentId, approval.requestId))}" tabindex="-1">
        <div class="decision-label">Approval requested by ${escapeHtml(agentName)}</div>
        <h2>${escapeHtml(approvalKindLabel(approval.kind))}</h2>
        ${approval.reason ? `<p class="approval-reason">${escapeHtml(approval.reason)}</p>` : ""}
        ${approvalBodyHtml(approval, agentName)}
        ${approval.cwd ? `<p class="path-line">Working directory: ${escapeHtml(approval.cwd)}</p>` : ""}
        ${approval.browserAction === undefined ? "" : jsonDetailsHtml("Detected action", approval.browserAction, `approval:${approval.agentId}:${approval.requestId}`)}
        <div class="decision-actions">${pending ? `<span class="pending-label">Submitting…</span>` : ""}${approval.choices.map((choice) => {
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
  if (command === "bachata:workspace-integrity") return "workspace integrity";
  if (command === "bachata:project-checks") return "integrity, syntax and types";
  return command.startsWith("bachata:verifier:")
    ? `repository verifier "${command.slice("bachata:verifier:".length)}"`
    : command;
};

const controllerCheckSummary = (commands: string[]): string => {
  const described = [...new Set(commands.map(controllerCheckDescription))];
  return described.length === 0 ? "no declared check" : described.join(", ");
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
  if (result.status === "interrupted") return "Stopped before a final assessment";
  const outcome = result.finalAssessment?.outcome ?? "notApplicable";
  const modelReviewed = modelReviewedResult(result);
  if (outcome === "verificationFailed") {
    return "Verification failed · controller-recorded";
  }
  if (outcome === "notApplicable") {
    return "Not applicable";
  }
  // A run that died before consensus is not an assessment. Reading "Inconclusive · 0 findings"
  // there told the reader the participants had looked and could not decide, when in fact nobody
  // ever answered.
  if (outcome === "failedBeforeRuling") {
    return "Failed before final ruling";
  }
  if (outcome === "inconclusive") {
    const assurance = verificationPassed(result)
      ? [`controller-checked: ${passedCheckSummary(result)}`]
      : result.checks.length > 0
        ? ["controller-recorded"]
        : [];
    if (modelReviewed) assurance.push("model-reviewed");
    return ["Inconclusive", ...assurance].join(" · ");
  }
  if (verificationPassed(result)) {
    return [
      `Controller-checked: ${passedCheckSummary(result)}`,
      ...(modelReviewed ? ["model-reviewed"] : []),
    ].join(" · ");
  }
  if (modelReviewed) {
    return result.checks.length === 0
      ? "Completed · model-reviewed · unverified"
      : "Completed · model-reviewed";
  }
  return (result.providers ?? []).length === 1
    ? "Completed · single provider · unverified"
    : "Completed · unverified";
};

const verificationStateLine = (result: RunResultCenter): string => {
  if (result.expectations?.verification === false) {
    return "Not applicable: this pipeline declares no controller-owned verification.";
  }
  if (result.checks.length === 0) {
    return "Expected but missing: no verification check is recorded.";
  }
  const failed = result.checks.filter((check) => check.status === "failed" || check.status === "timedOut");
  const cancelled = result.checks.filter((check) => check.status === "cancelled");
  const total = `${String(result.checks.length)} check${result.checks.length === 1 ? "" : "s"}`;
  if (failed.length > 0) {
    return `${total}, ${String(failed.length)} did not pass: ${failed.map((check) => check.command).join(", ")}.`;
  }
  if (cancelled.length > 0) {
    return `${total}, ${String(cancelled.length)} cancelled: ${cancelled.map((check) => check.command).join(", ")}.`;
  }
  return `${total}, all passed.`;
};

const verificationCurrencyLine = (result: RunResultCenter): string => {
  const provenance = result.verificationProvenance;
  if (!provenance) return "";
  const when = escapeHtml(formatDateTime(provenance.recordedAt));
  return provenance.source === "recheck"
    ? `<p class="muted result-verification-currency" data-verification-source="recheck">Current verification: rerun of the approved checks, recorded ${when}. It replaces the original run's verification.</p>`
    : `<p class="muted result-verification-currency" data-verification-source="run">Current verification: recorded by the original run at ${when}.</p>`;
};

const verificationDetailsHtml = (check: RunResultCenter["checks"][number]): string => {
  const details = [
    check.exitCode === undefined ? undefined : ["Exit status", String(check.exitCode)],
    check.workingDirectory === undefined ? undefined : ["Working directory", check.workingDirectory],
    check.candidateTree === undefined ? undefined : ["Candidate tree", check.candidateTree],
    check.outputReference === undefined ? undefined : ["Output reference", check.outputReference],
  ].filter((entry): entry is [string, string] => entry !== undefined);
  return details.length === 0
    ? ""
    : `<dl class="result-check-details">${details.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
};

const recommendedNextAction = (result: RunResultCenter): string => {
  if (result.status === "interrupted") return "Review the recorded progress, then use the recovery controls to continue.";
  if (result.applyBlockedReason) {
    return `Do not apply. ${result.applyBlockedReason.replace(/[.!?]\s*$/u, "")}. Rerun the approved checks, or fix the cause and run again.`;
  }
  const outcome = result.finalAssessment?.outcome;
  if (outcome === "verificationFailed") {
    return "Do not apply. Read the failing verification, then fix the cause and run again.";
  }
  if (outcome === "failedBeforeRuling") {
    return "Do not apply: no final ruling was produced. Fix the failure below, then run again.";
  }
  if (outcome === "inconclusive") {
    return "Read the evidence gaps and unresolved risks below before you decide. Rerun the approved checks if you want the evidence proven again.";
  }
  if (outcome === "notApplicable") {
    return "This run has not produced a final result yet.";
  }
  return result.retainedWorktree && result.retainedRunId
    ? "Review the diff, then apply the work you want. Bachata stages it and commits nothing."
    : "Review the findings below. This run has nothing to apply.";
};

type RulingParticipantIdentity = { agentId: string; provider?: string; adapter?: string; model?: string };

const rulingParticipantLabel = (participant: RulingParticipantIdentity): string => {
  const name = participant.provider ?? participant.agentId;
  const qualifiers = [participant.adapter, participant.model].filter((value): value is string => !!value);
  return qualifiers.length === 0 ? name : `${name} (${qualifiers.join(" · ")})`;
};

const rulingProvenanceLabel = (result: RunResultCenter): string | undefined => {
  const provenance = result.rulingProvenance;
  if (!provenance) return result.rulingBy ? `Ruled by ${result.rulingBy}` : undefined;
  const identity = rulingParticipantLabel;
  const labels = provenance.participants.map(identity);
  if (provenance.kind === "unanimousConsensus") return `Unanimous consensus of ${labels.join(", ")}`;
  if (provenance.kind === "arbiterRuling") {
    const arbiter = provenance.participants.find((participant) => participant.agentId === provenance.ruledBy);
    return `Arbiter ruling by ${arbiter ? identity(arbiter) : String(provenance.ruledBy)}`;
  }
  if (provenance.kind === "singleProvider") return `Single provider result from ${labels[0]}`;
  if (provenance.kind === "humanResolution") return `Human resolution by ${String(provenance.resolvedBy)}`;
  return labels.length > 0 ? `Controller verification over ${labels.join(", ")}` : "Controller verification";
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
    ? `<div class="compact-actions"><button data-action="working-directory">Choose folder</button></div>`
    : "";

const detailRow = (label: string, value: string | undefined): Array<[string, string]> =>
  value === undefined ? [] : [[label, value]];

const preflightDetailsHtml = (record: PreflightRecord, key: string): string => {
  const rows: Array<[string, string]> = [
    ...detailRow("Folder", record.folder),
    ...detailRow("Git", record.detail),
    ...record.participants.flatMap((entry) => detailRow(entry.participant, `Not started · ${entry.step}`)),
  ];
  return rows.length === 0
    ? ""
    : `<details class="info-disclosure preflight-details" ${disclosureAttributes(key)}><summary><i class="codicon codicon-info" aria-hidden="true"></i> Project details</summary><dl class="result-decision-grid">${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl></details>`;
};

const runFailureHtml = (result: RunResultCenter, panel: PanelState): string => {
  const failure = result.finalAssessment?.failure;
  if (!failure) return "";
  const preflight = latestPreflightRecord(panel, failure.error);
  if (preflight !== undefined) {
    return `<section class="result-failure" data-run-failure="true">
    <h3>Why no participant started</h3>
    <p class="result-failure-cause">${escapeHtml(failure.error)}</p>
    ${preflightActionsHtml(preflight)}
    ${preflightDetailsHtml(preflight, "result-preflight")}
  </section>`;
  }
  const rows: Array<[string, string]> = [
    ...(failure.participant ?? failure.agentId
      ? [["Participant", failure.participant ?? failure.agentId] as [string, string]]
      : []),
    ...(failure.provider ?? failure.adapter
      ? [["Provider", failure.provider ?? failure.adapter] as [string, string]]
      : []),
    ["Model", failure.model ?? "not recorded"],
    ...(failure.step === undefined ? [] : [["Step", failure.step] as [string, string]]),

  ];
  // The assessment line above already says the run failed before a ruling. This section says where
  // and on what, so repeating the verdict as its heading spent a line saying nothing new.
  return `<section class="result-failure" data-run-failure="true">
    <p class="result-failure-cause">${escapeHtml(failure.error)}</p>
    <details class="info-disclosure"><summary><i class="codicon codicon-info" aria-hidden="true"></i> Provider and step details</summary><dl class="result-decision-grid">${rows.map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl></details>
  </section>`;
};

const resultDecisionSummaryHtml = (result: RunResultCenter, panel: PanelState): string => {
  const outcome = result.status === "interrupted"
    ? "interrupted"
    : result.finalAssessment?.outcome ?? "notApplicable";
  const scope = result.changedFiles.length > 0
    ? `${String(result.changedFiles.length)} changed file${result.changedFiles.length === 1 ? "" : "s"}`
    : result.expectations?.changedFiles === false
      ? "No write authority: this run changed nothing by contract"
      : "No changed file is recorded";
  const risk = result.unresolvedRisks.length > 0
    ? `${String(result.unresolvedRisks.length)} unresolved risk${result.unresolvedRisks.length === 1 ? "" : "s"}`
    : "No unresolved risk is recorded";
  const gaps = result.evidenceGaps.length > 0
    ? `, ${String(result.evidenceGaps.length)} evidence gap${result.evidenceGaps.length === 1 ? "" : "s"}`
    : "";
  const providers = result.finalAssessment?.producedBy ?? [];
  const findings = result.findings ?? [];
  const actionable = findings.filter((finding) => finding.disposition === "accepted").length;
  const unresolved = findings.filter((finding) => finding.disposition === "unresolved").length;
  const findingDetails = findings.length === 0
    ? `<p class="muted">No typed model findings were recorded.</p>`
    : `<ul class="result-finding-list">${findings.map((finding) => {
        const location = finding.location === undefined
          ? ""
          : ` · ${finding.location.file}${finding.location.startLine === undefined ? "" : `:${String(finding.location.startLine)}${finding.location.endLine === undefined ? "" : `-${String(finding.location.endLine)}`}`}`;
        const evidence = finding.evidence.length > 0
          ? `<p><strong>Evidence</strong> ${escapeHtml(finding.evidence.join("; "))}</p>`
          : `<p class="muted">No confirmation evidence was recorded.</p>`;
        const challenges = finding.challenges.length > 0
          ? `<p><strong>Challenges</strong> ${escapeHtml(finding.challenges.join("; "))}</p>`
          : `<p class="muted">No challenge was recorded.</p>`;
        return `<li class="finding-${escapeAttribute(finding.disposition)}"><strong>${escapeHtml(finding.subject)}</strong><small>${escapeHtml(`${labelFor(lifecycleStateLabel, finding.disposition)}${location}`)}</small><p>${escapeHtml(finding.message)}</p>${evidence}${challenges}<p class="muted">Decision ${escapeHtml(finding.provenance.stepId)} · ${escapeHtml(finding.provenance.participantIds.join(", "))}${finding.provenance.ruledBy ? ` · ruled by ${escapeHtml(finding.provenance.ruledBy)}` : ""}</p></li>`;
      }).join("")}</ul>`;
  return `<section class="result-decision outcome-${escapeAttribute(outcome)}" data-outcome="${escapeAttribute(outcome)}" aria-label="Run assessment">
    <p class="result-assessment-status${result.finalAssessment?.failure ? " sr-only" : ""}"><strong><i class="codicon codicon-${escapeAttribute(outcomeIcon[outcome] ?? "circle-outline")}" aria-hidden="true"></i> ${escapeHtml(assessmentStatusLine(result))}</strong></p>
    <!-- EX-UI-01. The next safe action is what the reader came for, so it is beside the outcome
         rather than at the bottom of a collapsed disclosure of assessment detail. -->
    <p class="result-next-action">${escapeHtml(recommendedNextAction(result))}</p>
    ${runFailureHtml(result, panel)}
    ${actionable + unresolved > 0 ? `<p class="result-finding-summary"><strong>Findings · ${String(actionable)} actionable · ${String(unresolved)} need human</strong></p>` : ""}
    ${actionable + unresolved > 0 ? findingDetails : findings.length === 0 ? "" : `<details class="info-disclosure result-finding-details"><summary><i class="codicon codicon-info" aria-hidden="true"></i> Finding details</summary>${findingDetails}</details>`}
    <details class="info-disclosure result-assessment-details"><summary><i class="codicon codicon-info" aria-hidden="true"></i> Assessment details</summary>
    <dl class="result-decision-grid">
      <dt>Summary</dt><dd>${escapeHtml(result.finalAssessment?.summary ?? "No final assessment was recorded")}</dd>
      <dt>Changed scope</dt><dd>${escapeHtml(scope)}</dd>
      <dt>Verification</dt><dd>${escapeHtml(verificationStateLine(result))}</dd>
      <dt>Remaining risk</dt><dd>${escapeHtml(`${risk}${gaps}`)}</dd>
      <dt>Produced by</dt><dd>${providers.length > 0 ? escapeHtml(providers.map((provider) => provider.model ? `${provider.name} (${provider.adapter} · ${provider.model})` : `${provider.name} (${provider.adapter})`).join(", ")) : "No provider provenance was recorded"}</dd>
    </dl>
    ${verificationCurrencyLine(result)}
    </details>
  </section>`;
};

const hunkPickerHtml = (conversationId: string, runId: string): string => {
  const entry = resultSelection(conversationId, runId);
  const loaded = entry.diff;
  if (!loaded) {
    return `<div class="result-hunks"><button data-action="orchestration-diff" data-run-id="${escapeAttribute(runId)}" data-conversation="${escapeAttribute(conversationId)}">Select hunks</button><p class="muted">Load this run's authoritative diff to apply or export individual hunks.</p></div>`;
  }
  const files = entry.files;
  const hunks = entry.hunks;
  if (loaded.files.length === 0) {
    return `<div class="result-hunks">${loaded.truncated ? `<p class="muted result-hunks-truncated" ${liveRegionAttributes(`result-hunks-truncated:${runId}`, "status", loaded.truncated)}>${escapeHtml(loaded.truncated)}</p><button data-action="orchestration-diff" data-run-id="${escapeAttribute(runId)}" data-conversation="${escapeAttribute(conversationId)}">Reload diff</button>` : `<p class="muted">This run's diff contains no file.</p>`}</div>`;
  }
  const rows = loaded.files.map((file) => {
    const selectedIndexes = hunks.get(file.path) ?? new Set<number>();
    const wholeFile = files.has(file.path);
    const reason = file.binary
      ? "binary"
      : file.renamed
        ? "renamed"
        : file.modeChanged
          ? "permissions also change"
          : file.hunks.length === 0
            ? "no text hunk"
            : undefined;
    const body = file.wholeFileOnly
      ? `<p class="muted">Whole file only (${escapeHtml(reason ?? "not splittable")}). Select the file above to include it.</p>`
      : `<ul class="result-hunk-list">${file.hunks.map((hunk) => `<li><label><input type="checkbox" data-action="result-hunk-select" data-conversation="${escapeAttribute(conversationId)}" data-run-id="${escapeAttribute(runId)}" data-path="${escapeAttribute(file.path)}" data-hunk="${String(hunk.index)}" ${wholeFile ? "disabled" : ""} ${selectedIndexes.has(hunk.index) ? "checked" : ""} aria-label="Select hunk ${String(hunk.index + 1)} of ${escapeAttribute(file.path)}"><span class="result-hunk-header">${escapeHtml(hunk.header)}</span><small>+${String(hunk.added)} −${String(hunk.removed)}</small></label><pre class="result-hunk-preview">${escapeHtml(hunk.preview)}</pre></li>`).join("")}</ul>${wholeFile ? `<p class="muted">The whole file is selected, so its hunks are covered.</p>` : ""}`;
    return `<details class="result-hunk-file" ${disclosureAttributes(`result-hunks:${conversationId}:${file.path}`)}><summary>${escapeHtml(file.path)}<small>${file.wholeFileOnly ? escapeHtml(reason ?? "whole file only") : `${String(file.hunks.length)} hunk${file.hunks.length === 1 ? "" : "s"}`}</small></summary>${body}</details>`;
  }).join("");
  return `<div class="result-hunks"><div class="compact-actions"><button data-action="orchestration-diff" data-run-id="${escapeAttribute(runId)}" data-conversation="${escapeAttribute(conversationId)}">Reload diff</button><button data-action="result-hunks-clear" data-conversation="${escapeAttribute(conversationId)}" data-run-id="${escapeAttribute(runId)}">Clear hunk selection</button></div>${loaded.truncated ? `<p class="muted result-hunks-truncated" ${liveRegionAttributes(`result-hunks-truncated:${runId}`, "status", loaded.truncated)}>${escapeHtml(loaded.truncated)}</p>` : ""}${rows}</div>`;
};

const evidenceStateLabel: Record<string, string> = {
  recorded: "Recorded",
  notApplicable: "Not applicable",
  missing: "Expected but missing",
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
    return bachataWebviewBehavior.runStatusPresentation(
      bachataWebviewBehavior.runPhase(false, result.status),
      stopProvenance,
    ).label;
  }
  const outcome = result.finalAssessment?.outcome;
  if (outcome === "verificationFailed") return "Finished, not proven";
  if (outcome === "inconclusive") return "Finished, inconclusive";
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

const runRecoveryOf = (panel: PanelState, phase: RunPhase): RunRecovery | undefined =>
  bachataWebviewBehavior.runRecovery(phase, panel.resumableWorkflow);

const recoveryPositionText = (panel: PanelState, recovery: RunRecovery): string => {
  const record = panel.resumableWorkflow;
  if (!record) return "";
  if (recovery.step === "none") {
    return `Could not start step ${String(record.nextStepIndex + 1)} of ${String(record.totalSteps)}${record.stepName ? ` · ${record.stepName}` : ""}`;
  }
  return `${recovery.step === "resume" ? "Stopped at" : "Failed at"} step ${String(record.nextStepIndex + 1)} of ${String(record.totalSteps)}${record.stepName ? ` · ${record.stepName}` : ""}`;
};

const recoveryActionsHtml = (panel: PanelState, recovery: RunRecovery | undefined): string => {
  if (!panel.resumableWorkflow || !recovery) return "";
  return recovery.label === undefined
    ? `<button class="primary" data-action="workflow-restart">Restart pipeline</button>`
    : `<button class="primary" data-action="workflow-resume" aria-label="${escapeAttribute(`${recovery.label}: ${recoveryPositionText(panel, recovery)}`)}">${escapeHtml(recovery.label)}</button>`;
};

const recoverySecondaryActionsHtml = (panel: PanelState, recovery: RunRecovery | undefined): string => {
  if (!panel.resumableWorkflow || !recovery) return "";
  return `${recovery.label === undefined ? "" : `<button data-action="workflow-restart">Restart pipeline</button>`}<button class="danger" data-action="workflow-discard">Discard recovery checkpoint</button>`;
};

const resultCenterHtml = (conversationId: string, panel: PanelState): string => {
  const result = state.manager.resultsByConversation?.[conversationId];
  if (!result) return "";
  const phase = runPhaseOf(panel);
  if (phase === "running" || phase === "waiting") return "";
  const recovery = runRecoveryOf(panel, phase);
  const resultRunId = result.retainedRunId;
  const selection = new Set(selectedResultPaths(conversationId, resultRunId));
  const hunkCount = selectedHunkReferences(conversationId, resultRunId).length;
  const files = result.changedFiles.length > 0
    ? `<ul class="result-files">${result.changedFiles.map((file) => `<li><label class="result-file-select"><input type="checkbox" data-action="result-file-select" data-conversation="${escapeAttribute(conversationId)}" data-run-id="${escapeAttribute(resultRunId ?? "")}" data-path="${escapeAttribute(file)}" ${selection.has(file) ? "checked" : ""} aria-label="Select ${escapeAttribute(file)} for apply"></label><button data-action="result-reveal-file" data-path="${escapeAttribute(file)}">${escapeHtml(file)}</button>&nbsp;<button class="result-file-changes" data-action="result-open-changes" data-path="${escapeAttribute(file)}" title="Open changes in the diff editor">Changes</button></li>`).join("")}</ul><p class="muted result-selection-summary">${selection.size === 0 && hunkCount === 0 ? "No file or hunk is selected: apply and patch export cover the whole run." : `${String(selection.size)} of ${String(result.changedFiles.length)} files${hunkCount > 0 ? ` and ${String(hunkCount)} hunk${hunkCount === 1 ? "" : "s"}` : ""} selected: apply and patch export cover only those.`}</p>`
    : result.expectations?.changedFiles === false
      ? `<p class="muted">Not applicable: this contract grants no write authority.</p>`
      : `<p class="muted">No changed files were recorded.</p>`;
  const checks = result.checks.length > 0
    ? `<ul class="result-checks">${result.checks.map((check) => `<li class="status-${escapeAttribute(check.status === "passed" ? "completed" : "error")}"><span>${escapeHtml(check.command)}</span><strong>${escapeHtml(labelFor(checkStatusLabel, check.status))}</strong>${verificationDetailsHtml(check)}</li>`).join("")}</ul>`
    : result.expectations?.verification === false
      ? `<p class="muted">Not applicable: this pipeline declares no controller-owned verification.</p>`
      : `<p class="muted">No verification evidence was recorded.</p>`;
  // The failure section above states the error that stopped the run, in full, with the
  // participant and model behind it. Printing the same sentence again under "Unresolved risks"
  // reads as a second problem. The record still carries it; the result states it once.
  const failureError = result.finalAssessment?.failure?.error;
  const visibleRisks = result.unresolvedRisks.filter((risk) => risk !== failureError);
  const risks = visibleRisks.length > 0
    ? `<ul class="ruling-list risks">${visibleRisks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul>`
    : result.unresolvedRisks.length > 0
      ? `<p class="muted">The only unresolved risk recorded is the failure stated above.</p>`
      : `<p class="muted">No unresolved risks were recorded.</p>`;
  const recovered = (result.recoveredErrors ?? []).length > 0
    ? `<section><h3>Recovered errors</h3><ul class="ruling-list">${result.recoveredErrors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul></section>`
    : "";
  const evidenceEntries = result.evidence ?? [];
  const gaps = evidenceEntries.length > 0
    ? `<div class="result-gaps evidence-ledger"><strong>Evidence</strong><ul>${evidenceEntries.map((item) => `<li class="evidence-${escapeAttribute(item.state)}"><span class="evidence-state"><i class="codicon codicon-${escapeAttribute(evidenceStateIcon[item.state] ?? "circle-outline")}" aria-hidden="true"></i> ${escapeHtml(evidenceStateLabel[item.state] ?? item.state)}</span><span><strong>${escapeHtml(item.label)}</strong> — ${escapeHtml(item.detail)}</span></li>`).join("")}</ul></div>`
    : result.evidenceGaps.length > 0
      ? `<div class="result-gaps"><strong>Evidence gaps</strong><ul>${result.evidenceGaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join("")}</ul></div>`
      : "";
  const orchestrationRunId = resultRunId;
  const handoff = result.retainedWorktree && orchestrationRunId
    ? `<section class="result-handoff">
      <h3>Inspect and apply</h3>
      <p class="muted">This run's retained work is in a Git worktree. Nothing has been applied to your branch and nothing has been committed.</p>
      <ol class="handoff-steps">
        <li><strong>Review the final diff.</strong> Open each changed file above, or export the patch.</li>
        <li><strong>Check the evidence.</strong> ${String(result.checks.length)} check${result.checks.length === 1 ? "" : "s"} recorded, ${String(result.unresolvedRisks.length)} unresolved risk${result.unresolvedRisks.length === 1 ? "" : "s"}, ${String(result.evidenceGaps.length)} evidence gap${result.evidenceGaps.length === 1 ? "" : "s"}.${rulingProvenanceLabel(result) ? ` ${escapeHtml(rulingProvenanceLabel(result) ?? "")}.` : " No ruling provenance was recorded."}</li>
        <li><strong>Rerun the approved checks</strong> if you want them proven again right now.</li>
        <li><strong>Apply.</strong> Bachata stages the work on your current branch and creates no commit. On conflict the working tree is restored and this worktree is kept.</li>
      </ol>
      <div class="compact-actions">
        <button data-action="orchestration-recheck" data-run-id="${escapeAttribute(orchestrationRunId)}" data-conversation="${escapeAttribute(conversationId)}">Rerun approved checks</button>
        <button data-action="orchestration-patch" data-run-id="${escapeAttribute(orchestrationRunId)}" data-conversation="${escapeAttribute(conversationId)}">Export patch${selection.size > 0 || hunkCount > 0 ? " (selected)" : ""}</button>
        <button${result.applyOverrideReason ? "" : ` class="primary"`} data-action="orchestration-apply" data-run-id="${escapeAttribute(orchestrationRunId)}" data-conversation="${escapeAttribute(conversationId)}"${result.applyBlockedReason ? ` disabled title="${escapeAttribute(result.applyBlockedReason)}"` : ""}>${hunkCount > 0 ? `Apply ${String(hunkCount)} selected hunk${hunkCount === 1 ? "" : "s"}${selection.size > 0 ? ` and ${String(selection.size)} file${selection.size === 1 ? "" : "s"}` : ""}` : selection.size > 0 ? `Apply ${String(selection.size)} selected file${selection.size === 1 ? "" : "s"}` : "Apply to current branch"}${result.applyOverrideReason ? " despite an inconclusive result" : ""}</button>
      </div>
      ${result.applyBlockedReason ? `<p class="result-apply-blocked" ${liveRegionAttributes(`result-apply:${conversationId}`, "status", `blocked:${result.applyBlockedReason}`)}>Apply is disabled: ${escapeHtml(result.applyBlockedReason)}. Rerun the approved checks to prove the work again.</p>` : result.applyOverrideReason ? `<p class="result-apply-override" ${liveRegionAttributes(`result-apply:${conversationId}`, "status", `override:${result.applyOverrideReason}`)}>This run is inconclusive: ${escapeHtml(result.applyOverrideReason)}. Applying it is an explicit override; Bachata does not consider this work proven.</p>` : ""}
      ${hunkPickerHtml(conversationId, orchestrationRunId)}
    </section>`
    : "";
  // A run that stopped before any participant answered has no changed files, no verification, no
  // ruling and no risks — four headings whose whole content is "nothing was recorded". Stated once
  // behind a disclosure they are still available and no longer bury the failure above them.
  const evidenceSections = `<div class="result-grid"><section><h3>Changed files</h3>${files}${result.diffSummary ? `<pre>${escapeHtml(result.diffSummary)}</pre>` : ""}</section><section><h3>Verification</h3>${checks}${verificationCurrencyLine(result)}</section></div>
    <section><h3>Final ruling</h3>${result.finalRuling ? `<div class="markdown">${renderMarkdown(result.finalRuling)}</div>${rulingProvenanceLabel(result) ? `<p class="muted">${escapeHtml(rulingProvenanceLabel(result) ?? "")}</p>` : ""}` : result.expectations?.finalRuling === false ? `<p class="muted">Not applicable: this pipeline declares no consensus or checklist ruling.</p>` : `<p class="muted">No final ruling was recorded.</p>`}${(result.providers ?? []).length > 0 ? `<p class="muted">Providers: ${escapeHtml((result.providers ?? []).map((provider) => provider.model ? `${provider.name} (${provider.adapter} · ${provider.model})` : `${provider.name} (${provider.adapter})`).join(", "))}</p>` : ""}</section>
    <section><h3>Unresolved risks</h3>${risks}</section>`;
  const nothingRecorded =
    result.changedFiles.length === 0 &&
    result.checks.length === 0 &&
    result.finalRuling === undefined &&
    visibleRisks.length === 0;
  const evidenceSectionsHtml = nothingRecorded
    ? `<details class="info-disclosure result-empty-sections" ${disclosureAttributes(`result-empty:${conversationId}`)}><summary><i class="codicon codicon-info" aria-hidden="true"></i> Evidence details · nothing recorded</summary><div class="result-empty-body">${evidenceSections}</div></details>`
    : evidenceSections;
  return `<section class="result-center">
    <header><div><span class="decision-label">Run result</span><h2>${escapeHtml(resultHeadlineLabel(result, panel.resumableWorkflow?.outcome))}</h2>${recovery ? `<p class="result-recovery-position">${escapeHtml(recoveryPositionText(panel, recovery))}</p>` : ""}</div><div class="compact-actions">${recoveryActionsHtml(panel, recovery)}${result.retainedWorktree && orchestrationRunId ? `<button data-action="orchestration-reveal" data-run-id="${escapeAttribute(orchestrationRunId)}" data-conversation="${escapeAttribute(conversationId)}">Reveal worktree</button>` : ""}<details class="header-action-menu wide-trigger" ${disclosureAttributes(`result-export:${conversationId}`)}><summary aria-label="Run result actions" title="Run result actions">More</summary><div>${recoverySecondaryActionsHtml(panel, recovery)}<button data-action="result-publish-findings">Publish findings to Problems</button><button data-action="result-source-control">Open Source Control</button><button data-action="run-bundle-export" data-format="bundle" data-conversation="${escapeAttribute(conversationId)}">Run bundle (JSON)</button><button data-action="run-bundle-export" data-format="markdown" data-conversation="${escapeAttribute(conversationId)}">Evidence report (Markdown)</button><button data-action="run-bundle-export" data-format="sarif" data-conversation="${escapeAttribute(conversationId)}">Evidence findings (SARIF)</button></div></details></div></header>
    ${resultDecisionSummaryHtml(result, panel)}
    ${evidenceSectionsHtml}
    ${recovered}
    ${result.retainedWorktree ? `<details class="info-disclosure" ${disclosureAttributes(`result-worktree:${conversationId}`)}><summary>Recovery worktree</summary><p class="result-worktree">${escapeHtml(result.retainedWorktree)}</p></details>` : ""}
    ${gaps ? `<details class="info-disclosure" ${disclosureAttributes(`result-evidence:${conversationId}`)}><summary>Evidence ledger</summary>${gaps}</details>` : ""}
    ${handoff}
  </section>`;
};

const childRunsHtml = (conversationId: string): string => {
  const children = childConversationsFor(conversationId);
  if (children.length === 0) {
    return "";
  }
  return `<section class="child-runs"><h2>Task runs</h2>${children.map((child) => {
    const { status, label } = conversationStatus(child);
    const task = child.orchestrationTaskId ? `<small>${escapeHtml(child.orchestrationTaskId)}</small>` : "";
    return `<button class="child-run status-${escapeAttribute(status)}" data-action="select-conversation" data-conversation="${escapeAttribute(child.id)}"><span class="room-presence status-${escapeAttribute(status)}"></span><span><strong>${escapeHtml(child.title)}</strong>${task}</span><small>${escapeHtml(label)}</small></button>`;
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
    return "This answer is being submitted.";
  }
  if (interaction.secret) {
    return "Enter the requested value to submit.";
  }
  if (interaction.kind === "permission" || interaction.kind === "humanGate") {
    return "Choose one option to submit.";
  }
  return interaction.allowFreeText
    ? "Choose an option, or write a reply, to submit."
    : "Choose an option to submit.";
};

const interactionSubmitLabel = (interaction: InteractionSummary): string =>
  interaction.kind === "executionChecklist" && interaction.selected.length === 0
    ? "Continue with none"
    : "Submit";
