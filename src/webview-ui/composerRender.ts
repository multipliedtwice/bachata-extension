/**
 * The composer: the rounded input surface, the rich pipeline picker, the settings panel and the
 * run-details contract. Concatenated with the other renderers and composed by roomRender, which
 * places the composer at the foot of the chat view.
 */

const runContractHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const contract = panel.executionContract;
  if (!contract) return "";
  const limits = [
    draft.iterationMode === "untilClean"
      ? `Iterations: until clean ×${String(draft.requiredCleanPasses)}, at most ${String(draft.iterationCount)}`
      : `Iterations: ${String(draft.iterationCount)} (maximum ${String(contract.limits.maxIterations)})`,
    ...(contract.limits.agentTurnTimeoutMs === undefined
      ? []
      : [`Provider turn limit: ${durationLabel(contract.limits.agentTurnTimeoutMs)}`]),
    ...(contract.limits.managedTaskTimeoutMs === undefined
      ? []
      : [`Managed task limit: ${durationLabel(contract.limits.managedTaskTimeoutMs)}`]),
    ...(contract.limits.browserOperationTimeoutMs === undefined
      ? []
      : [`Browser operation limit: ${durationLabel(contract.limits.browserOperationTimeoutMs)}`]),
    ...(contract.limits.maxRevisionCycles === undefined
      ? []
      : [`Revision cycles: ${String(contract.limits.maxRevisionCycles)}`]),
    ...(contract.limits.checklistRetries === undefined
      ? []
      : [`Task retries: ${String(contract.limits.checklistRetries)}`]),
    ...(contract.limits.checklistConcurrency === undefined
      ? []
      : [`Task concurrency: ${String(contract.limits.checklistConcurrency)}`]),
    ...(contract.limits.consensusSteps ?? []).map((step) =>
      `Consensus rounds, ${step.stepName}: at most ${String(step.maxRounds)} before a human decision. Retrying an invalid round grants one more${step.roundLimitRetryable ? `, and retrying at the round limit grants another ${String(step.maxRounds)}` : "; at the round limit this step does not offer a retry"}`),
    ...(contract.limits.maxParticipantTurns === undefined
      ? []
      : [contract.limits.participantTurnsBounded === false
          ? `Participant turns: at most ${String(contract.limits.maxParticipantTurns)} without a further human decision${contract.limits.executesChecklist ? "; each checklist task adds one bounded sub-run" : ""}`
          : `Participant turns: at most ${String(contract.limits.maxParticipantTurns)} for the whole run`]),
  ];
  const provenance = [
    ...(contract.provenance === undefined
      ? []
      : [
          `Extension version: ${contract.provenance.extensionVersion}`,
          `Pipeline hash: ${contract.provenance.pipelineHash.slice(0, 12)}…`,
        ]),
    ...contract.providers.map((provider) =>
      `${provider.name}: ${provider.model ? `model ${provider.model}` : "model not reported"}, ${provider.runtimeVersion ? `runtime ${provider.runtimeVersion}` : "runtime not detected"}`),
  ];
  const scope = [
    `Working directory: ${contract.scope.workingDirectory ?? "not selected"}`,
    `Writes: ${writeScopeLabels[contract.scope.writeScope]}`,
    ...(contract.scope.writablePaths.length > 0
      ? [`Writable paths: ${contract.scope.writablePaths.join(", ")}`]
      : []),
    ...(contract.scope.readablePaths.length > 0
      ? [`Readable paths: ${contract.scope.readablePaths.join(", ")}`]
      : []),
    ...(contract.scope.protectedPaths.length > 0
      ? [`Protected paths: ${contract.scope.protectedPaths.join(", ")}`]
      : []),
    `Commits: ${contract.commitPolicy === "allow" ? "the controller may create commits" : "no commits are created"}`,
  ];
  const providers = contract.providers.map((provider) => {
    const roles = provider.roles.length > 0 ? ` · ${provider.roles.join(", ")}` : "";
    const model = provider.model === undefined ? " · model not reported" : ` · model ${provider.model}`;
    return `${provider.name} · ${provider.adapterLabel ?? provider.adapter}${model}${roles} · ${contractStatusLabels[provider.status]}`;
  });
  const gates = contract.humanGates.map((gate) => `${gate.stepName} · ${contractGateLabels[gate.gate] ?? gate.gate}`);
  const roles = (contract.roles ?? []).map((role) => [
    `${role.name}${role.managed ? " · managed" : ""}${role.optional ? " · optional" : ""}`,
    role.readOnly ? "read-only" : `writes ${writeScopeLabels[role.writeScope]}`,
    ...(role.writablePaths.length > 0 ? [`paths ${role.writablePaths.join(", ")}`] : []),
    role.commitPolicy === "allow" ? "commits allowed" : "no commits",
    ...(role.verification.length > 0 ? [`checks ${role.verification.join(", ")}`] : []),
  ].join(" · "));
  const outbound = (contract.outboundContext ?? []).length === 0
    ? ""
    : `<section class="contract-outbound"><h3>What each provider receives</h3>${(contract.outboundContext ?? []).map((manifest) => `<details ${disclosureAttributes(`composer:outbound:${manifest.agentId}`)}>
      <summary>${escapeHtml(manifest.name)} · ${escapeHtml(manifest.adapterLabel)}</summary>
      <p class="muted">${escapeHtml(manifest.transport)}</p>
      <ul class="contract-list">${manifest.entries.map((entry) => `<li><strong>${escapeHtml(entry.label)}</strong> · ${escapeHtml(entry.detail)}${entry.exact ? "" : ` <span class="contract-inexact">selected at run time</span>`}</li>`).join("")}</ul>
      <h4>Never sent</h4>${contractList(manifest.exclusions, "")}
      <h4>Redaction</h4>${contractList(manifest.redactions, "")}
    </details>`).join("")}</section>`;
  const acknowledgement = panel.contractAcknowledgement;
  // EX-UI-02. What changed is evidence and belongs inside the contract; asking for the
  // acknowledgement is an action and belongs beside Send, where it is what holds the run. Both
  // used to be drawn twice inside this one footer, with two buttons that do the same thing.
  const authorityDiffHtml = acknowledgement && acknowledgement.diff.changes.length > 0
    ? `<section class="contract-authority-diff"><h3>Authority change since you last acknowledged this contract</h3><ul class="contract-list">${acknowledgement.diff.changes.map((change) => `<li class="${change.expands ? "authority-expanded" : "authority-narrowed"}"><strong>${escapeHtml(change.label)}</strong> ${escapeHtml(change.expands ? "widened" : "changed")} from ${escapeHtml(authorityChangeValue(change.label, change.from))} to ${escapeHtml(authorityChangeValue(change.label, change.to))}</li>`).join("")}</ul></section>`
    : "";
  // A policy refusal is already stated under its own heading; the blockers list repeats it only
  // because the host folds refusals into blockers, so it is filtered back out here.
  const refusals = new Set(contract.policyRefusals ?? []);
  const unresolved = contract.blockers.filter((blocker) => !refusals.has(blocker));
  // Inside the settings panel this is evidence a reader opens on request, not the first thing an
  // empty room shows; it stays closed unless the host asks for it after an authority change.
  const openByDefault = acknowledgement?.open ?? false;
  return `<details class="run-contract" ${disclosureAttributes("composer:contract", openByDefault)}>
    <summary><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i><h2 class="contract-kicker">Run details</h2><span class="contract-badge">${escapeHtml(safetyLevelLabels[contract.safetyLevel])}</span>${contract.assuranceLabel ? `<span class="contract-assurance">${escapeHtml(contract.assuranceLabel)}</span>` : ""}<span class="contract-pipeline" title="${escapeAttribute(contract.pipelineName)}">${escapeHtml(contract.pipelineName)}</span>${contract.blockers.length > 0 ? `<span class="contract-blockers">${String(contract.blockers.length)} unresolved</span>` : ""}</summary>
    <div class="contract-grid">
      ${contract.assuranceStatement ? `<section class="contract-assurance-statement"><h3>Assurance</h3><p>${escapeHtml(contract.assuranceStatement)}</p></section>` : ""}
      <section><h3>Providers</h3>${contractList(providers, "No providers are declared.")}</section>
      <section><h3>Scope and commits</h3>${contractList(scope, "No scope was resolved.")}</section>
      <section><h3>Role authority</h3>${contractList(roles, "This pipeline declares no roles; every provider runs with the scope above.")}</section>
      <section><h3>Verification</h3>${contractList(contract.verification, "No controller verification runs.")}${contract.verificationResources.length > 0 ? `<p class="muted">Shared resources: ${escapeHtml(contract.verificationResources.join(", "))}</p>` : ""}</section>
      <section><h3>Run limits</h3>${contractList(limits, "No limits were resolved.")}</section>
      <section><h3>Human decisions</h3>${contractList(gates, "No human gate interrupts this run.")}</section>
      <section><h3>Fallback</h3>${contractList(contract.fallbacks, "No provider fallback is declared.")}</section>
      <section><h3>Completion</h3>${contractList(contract.completion, "No completion criteria were resolved.")}</section>
      <section><h3>Provenance</h3>${contractList(provenance, "No provenance was resolved.")}</section>
      ${outbound}
      ${authorityDiffHtml}
      ${refusals.size > 0 ? `<section class="contract-policy-refusals"><h3>Repository policy refuses this run</h3>${contractList(contract.policyRefusals ?? [], "")}<p class="muted">Change the pipeline, or edit the repository policy file, before this run can start.</p></section>` : ""}
      ${unresolved.length > 0 ? `<section><h3>Unresolved before running</h3>${contractList(unresolved, "")}</section>` : ""}
    </div>
  </details>`;
};

// One place a pipeline is chosen, whether by pointer or by keyboard. The optimistic pending write
// and the runtime message it awaits are the same the native select used, so switching, locking and
// acknowledgement behave exactly as before.
const selectPipeline = (pipelineId: string): void => {
  const conversationId = activeId();
  const panel = activePanel();
  // Choosing the pipeline that is already selected is not a switch, so it neither posts nor locks —
  // the native select never fired for an unchanged value either.
  if (panel.selectedPipelineId === pipelineId &&
      panel.selectedPipelineHash === panel.pipelines.find((pipeline) => pipeline.id === pipelineId)?.hash &&
      pendingPipelineSelection(conversationId) === undefined) {
    return;
  }
  const id = requestId();
  state.pendingPipelineSelections.set(id, { conversationId, pipelineId });
  postRuntime({ type: "pipeline.select", pipelineId, requestId: id }, conversationId);
  scheduleRender();
};

const openPipelinePicker = (): void => {
  const panel = activePanel();
  if (!panel.pipelineMutable || pendingPipelineSelection() !== undefined || panel.pipelines.length === 0) {
    return;
  }
  state.pipelinePickerOpen = true;
  const activeId = panel.selectedPipelineId ?? panel.pipelines[0]?.id;
  if (activeId !== undefined) {
    state.pipelinePickerActiveId = activeId;
  }
  scheduleRender();
  requestAnimationFrame(() => document.getElementById("pipeline-picker-button")?.focus());
};

const closePipelinePicker = (restoreFocus = true): void => {
  if (!state.pipelinePickerOpen) {
    return;
  }
  state.pipelinePickerOpen = false;
  delete state.pipelinePickerActiveId;
  scheduleRender();
  if (restoreFocus) {
    requestAnimationFrame(() => document.getElementById("pipeline-picker-button")?.focus());
  }
};

const movePipelinePickerActive = (key: string): void => {
  const ids = activePanel().pipelines.map((pipeline) => pipeline.id);
  if (ids.length === 0) {
    return;
  }
  const current = state.pipelinePickerActiveId ?? activePanel().selectedPipelineId ?? ids[0];
  const index = Math.max(0, ids.indexOf(current ?? ""));
  const next = key === "ArrowDown"
    ? Math.min(ids.length - 1, index + 1)
    : key === "ArrowUp"
      ? Math.max(0, index - 1)
      : key === "Home"
        ? 0
        : ids.length - 1;
  const nextId = ids[next];
  if (nextId !== undefined) {
    state.pipelinePickerActiveId = nextId;
  }
  scheduleRender();
  requestAnimationFrame(() => document.getElementById("pipeline-picker-button")?.focus());
};

const commitPipelinePickerActive = (): void => {
  const pipelineId = state.pipelinePickerActiveId;
  closePipelinePicker();
  if (pipelineId) {
    selectPipeline(pipelineId);
  }
};

const PIPELINE_PICKER_LIST_ID = "pipeline-picker-list";

const pipelineOptionDomId = (pipelineId: string): string => `pipeline-option-${pipelineId}`;

// After a keyboard move and after any background re-render, the active option is brought back into
// the listbox's own scroll so the highlighted row is never below the fold.
const scrollPickerActiveOptionIntoView = (): void => {
  if (!state.pipelinePickerOpen || !state.pipelinePickerActiveId) {
    return;
  }
  document.getElementById(pipelineOptionDomId(state.pipelinePickerActiveId))?.scrollIntoView({ block: "nearest" });
};

// The pipeline that is currently selected has its full definition on hand; every other pipeline
// carries its shape on the summary the host now sends. Older fixtures without the summary fields
// fall back to the definition for the selected pipeline and simply omit the rest.
const pipelineDefinitionFor = (pipeline: PipelineSummary, panel: PanelState): PipelineDefinition | undefined =>
  panel.selectedPipelineId === pipeline.id ? panel.selectedPipelineDefinition : undefined;

const pipelineParticipantNames = (pipeline: PipelineSummary, panel: PanelState): string[] =>
  pipeline.participantNames ?? pipelineDefinitionFor(pipeline, panel)?.agents.map((agent) => agent.name) ?? [];

const pipelineParticipantCount = (pipeline: PipelineSummary, panel: PanelState): number | undefined => {
  const names = pipelineParticipantNames(pipeline, panel);
  return names.length > 0 ? names.length : pipeline.participantCount ?? pipelineDefinitionFor(pipeline, panel)?.agents.length;
};

const pipelineStepCount = (pipeline: PipelineSummary, panel: PanelState): number | undefined =>
  pipeline.stepCount ?? pipelineDefinitionFor(pipeline, panel)?.steps.filter((step) => step.enabled).length;

const pipelinePickerOpenState = (panel: PanelState, conversationId: string): boolean =>
  state.pipelinePickerOpen &&
  panel.pipelineMutable &&
  pendingPipelineSelection(conversationId) === undefined &&
  panel.pipelines.length > 0;

// The rich pipeline picker. At rest the trigger is compact — the pipeline name and a chevron.
// Participant names and the step count are drawn only in the open listbox, so a pipeline reads as a
// configurable sequence there without crowding the closed composer.
const pipelinePickerHtml = (panel: PanelState): string => {
  const conversationId = activeId();
  const selection = pendingPipelineSelection(conversationId);
  const disabled = !panel.pipelineMutable || selection !== undefined;
  const selectedId = selection?.pipelineId ?? panel.selectedPipelineId;
  const selected = panel.pipelines.find((pipeline) => pipeline.id === selectedId);
  const label = selected?.name ?? (state.panels.has(conversationId) ? "No pipeline available" : "Loading pipelines…");
  const title = selection
    ? `Switching to ${selection.pipelineId}…`
    : panel.pipelineMutationReason ?? "Choose the pipeline this run uses";
  const open = pipelinePickerOpenState(panel, conversationId);
  const activeOptionId = state.pipelinePickerActiveId ?? selectedId;
  const button = `<button id="pipeline-picker-button" data-action="pipeline-picker-toggle" class="pipeline-picker-button" role="combobox" aria-haspopup="listbox" aria-label="Pipeline" ${expandedControlAttributes(open, PIPELINE_PICKER_LIST_ID)}${open && activeOptionId ? ` aria-activedescendant="${escapeAttribute(pipelineOptionDomId(activeOptionId))}"` : ""} ${disabled ? "disabled" : ""} title="${escapeAttribute(title)}"><span class="pipeline-picker-name">${escapeHtml(label)}</span><i class="codicon codicon-chevron-down pipeline-picker-caret" aria-hidden="true"></i></button>`;
  const list = open
    ? `<div class="pipeline-picker-popover"><div id="${PIPELINE_PICKER_LIST_ID}" role="listbox" aria-label="Pipeline" tabindex="-1">${panel.pipelines.map((pipeline) => {
        const steps = pipelineStepCount(pipeline, panel);
        const names = pipelineParticipantNames(pipeline, panel);
        const count = pipelineParticipantCount(pipeline, panel);
        const shape = [
          steps === undefined ? undefined : countLabel(steps, "step"),
          count === undefined ? undefined : countLabel(count, "participant"),
        ].filter((part) => part !== undefined).join(" · ");
        const isSelected = pipeline.id === selectedId;
        const isActive = pipeline.id === activeOptionId;
        return `<div id="${escapeAttribute(pipelineOptionDomId(pipeline.id))}" role="option" class="pipeline-picker-option${isActive ? " active" : ""}${isSelected ? " selected" : ""}" data-action="pipeline-picker-select" data-pipeline-id="${escapeAttribute(pipeline.id)}" aria-selected="${isSelected ? "true" : "false"}"><span class="pipeline-picker-option-head"><span class="pipeline-picker-option-name">${escapeHtml(pipeline.name)}</span>${isSelected ? `<i class="codicon codicon-check" aria-hidden="true"></i>` : ""}</span>${shape ? `<span class="pipeline-picker-option-meta">${escapeHtml(shape)}</span>` : ""}${names.length > 0 ? `<span class="pipeline-picker-option-participants">${escapeHtml(names.join(", "))}</span>` : ""}${pipeline.description ? `<span class="pipeline-picker-option-desc">${escapeHtml(pipeline.description)}</span>` : ""}</div>`;
      }).join("")}</div></div>`
    : "";
  return `<div class="pipeline-picker" data-pipeline-picker>${button}${list}</div>`;
};

// Assignments separate the pipeline's responsibilities from the providers that carry them. A slot
// keeps its role, its instructions and its place in the sequence; only which agent answers for it
// changes, and only for this conversation's next run. The saved pipeline is never touched.
//
// Every row here is resolved by the host from the same role binding execution uses, so the reader
// can never point a control at a participant no enabled step runs.
const AGENTS_POPOVER_ID = "agents-popover";

const agentsAssignmentLockReason = (panel: PanelState): string | undefined =>
  panel.agentAssignments.lockReason;

const agentsAssignable = (panel: PanelState): boolean =>
  panel.agentAssignments.slots.length > 0;

const openAgentsPicker = (): void => {
  const panel = activePanel();
  if (!agentsAssignable(panel)) {
    return;
  }
  state.agentsPickerOpen = true;
  scheduleRender();
  requestAnimationFrame(() => document.getElementById("agents-picker-button")?.focus());
};

const closeAgentsPicker = (restoreFocus = true): void => {
  if (!state.agentsPickerOpen) {
    return;
  }
  state.agentsPickerOpen = false;
  delete state.agentsBrowserFor;
  scheduleRender();
  if (restoreFocus) {
    requestAnimationFrame(() => document.getElementById("agents-picker-button")?.focus());
  }
};

// The browser adapter a bridge session's provider implies, so the session — not a fixed vendor —
// decides which adapter answers for a Browser Bridge slot.
const browserAdapterForProvider = (provider: BrowserSession["provider"]): string =>
  provider === "chatgpt" ? "chatgpt-browser" : provider === "claude" ? "claude-browser" : "generic-browser";

const adapterAssignmentLabels: Record<string, string> = {
  "codex-app-server": "Codex CLI",
  "claude-code": "Claude CLI",
  "zai-glm": "Z.AI GLM CLI",
  "chatgpt-browser": "ChatGPT · Browser Bridge",
  "claude-browser": "Claude · Browser Bridge",
  "generic-browser": "Browser Bridge",
};

const assignedAdapterLabel = (adapter: string): string =>
  adapterAssignmentLabels[adapter] ?? adapter;

const isBrowserAssignment = (adapter: string): boolean => adapter.endsWith("-browser");

// A radio inside a slot's group. Exactly one carries tabindex 0, so the group is one tab stop and
// the arrow keys move within it; moving focus does not assign, because assigning restarts a
// provider and that is not what an arrow key should cost.
// Each choice carries a stable id so the render's own focus-return path finds it again: an
// assignment replaces this whole popover, and without an id the reader's focus lands on the body
// after every change they make.
const agentsChoiceHtml = (input: {
  id: string;
  checked: boolean;
  label: string;
  attributes: string;
  disabled: boolean;
  title?: string;
}): string =>
  `<button type="button" id="${escapeAttribute(input.id)}" role="radio" aria-checked="${input.checked ? "true" : "false"}" tabindex="${input.checked ? "0" : "-1"}" class="agents-choice${input.checked ? " selected" : ""}" ${input.attributes}${input.disabled ? " disabled" : ""}${input.title ? ` title="${escapeAttribute(input.title)}"` : ""}>${escapeHtml(input.label)}</button>`;

const agentSlotSessionsHtml = (slot: AgentAssignmentSlot, panel: PanelState): string => {
  const sessions = panel.browserBridge.sessions;
  if (sessions.length === 0) {
    return `<p class="agents-session-empty">No browser conversations are connected. Open the Inspector to connect the Browser Bridge.</p>`;
  }
  const options = sessions.map((session) => {
    const adapter = browserAdapterForProvider(session.provider);
    const selected = slot.browserSessionId === session.id && slot.assignedAdapter === adapter;
    const disabled = session.status !== "ready";
    return `<button type="button" role="option" id="agents-session-${escapeAttribute(slot.agentId)}-${escapeAttribute(session.id)}" class="agents-session-option${selected ? " selected" : ""}" data-action="agents-session" data-agent="${escapeAttribute(slot.agentId)}" data-adapter="${escapeAttribute(adapter)}" data-session="${escapeAttribute(session.id)}" aria-selected="${selected ? "true" : "false"}"${disabled ? " disabled" : ""}><span class="agents-session-name">${escapeHtml(browserProviderName(session.provider))} · ${escapeHtml(session.title ?? session.conversationUrl)}</span><span class="agents-session-meta">${escapeHtml(browserSessionCapabilityLabel(session))}</span></button>`;
  });
  return `<div class="agents-session-list" role="listbox" aria-label="Browser conversation for ${escapeAttribute(slot.responsibility)}">${options.join("")}</div>`;
};

const agentSlotHtml = (slot: AgentAssignmentSlot, panel: PanelState, locked: boolean): string => {
  const isBrowser = isBrowserAssignment(slot.assignedAdapter);
  const showSessions = isBrowser || state.agentsBrowserFor === slot.agentId;
  const cliChoices = panel.agentAssignments.assignableAdapters
    .filter((adapter) => !isBrowserAssignment(adapter) && adapter !== slot.defaultAdapter)
    .map((adapter) =>
      agentsChoiceHtml({
        id: `agents-choice-${slot.agentId}-${adapter}`,
        checked: slot.overridden && slot.assignedAdapter === adapter,
        label: assignedAdapterLabel(adapter),
        attributes: `data-action="agents-assign" data-agent="${escapeAttribute(slot.agentId)}" data-adapter="${escapeAttribute(adapter)}"`,
        disabled: locked,
      }),
    )
    .join("");
  const defaultChoice = agentsChoiceHtml({
    id: `agents-choice-${slot.agentId}-default`,
    checked: !slot.overridden,
    label: `Default · ${assignedAdapterLabel(slot.defaultAdapter)}`,
    attributes: `data-action="agents-assign" data-agent="${escapeAttribute(slot.agentId)}"`,
    disabled: locked,
    title: "Use the provider this pipeline ships with",
  });
  const browserChoice = panel.agentAssignments.assignableAdapters.some(isBrowserAssignment)
    ? agentsChoiceHtml({
        id: `agents-choice-${slot.agentId}-browser`,
        checked: isBrowser && slot.overridden,
        label: "Browser Bridge",
        attributes: `data-action="agents-browser-toggle" data-agent="${escapeAttribute(slot.agentId)}" aria-expanded="${showSessions ? "true" : "false"}"`,
        disabled: locked,
        title: "Bind a conversation from any supported website",
      })
    : "";
  const actual = isBrowser && slot.browserSessionId === undefined
    ? `${assignedAdapterLabel(slot.assignedAdapter)} · no conversation bound`
    : assignedAdapterLabel(slot.assignedAdapter);
  const agentState = panel.agents[slot.agentId];
  const statusError = agentState?.error
    ? `<p class="agents-slot-error">${escapeHtml(agentState.error)}</p>`
    : "";
  return `<article class="agents-slot" data-agent-slot="${escapeAttribute(slot.agentId)}">
    <div class="agents-slot-head">
      <div class="agents-slot-title"><strong>${escapeHtml(slot.responsibility)}</strong><small>${escapeHtml(slot.overridden ? "reassigned" : "pipeline default")}</small></div>
      <span class="agents-slot-actual">${escapeHtml(actual)}</span>
    </div>
    <div class="agents-choices" role="radiogroup" aria-label="Provider for ${escapeAttribute(slot.responsibility)}">${defaultChoice}${cliChoices}${browserChoice}</div>
    ${showSessions && !locked ? agentSlotSessionsHtml(slot, panel) : ""}
    ${statusError}
  </article>`;
};

const agentsPickerHtml = (panel: PanelState): string => {
  const assignments = panel.agentAssignments;
  const lockReason = agentsAssignmentLockReason(panel);
  const hasPipeline = agentsAssignable(panel);
  const overrides = assignments.slots.filter((slot) => slot.overridden).length;
  const open = state.agentsPickerOpen && hasPipeline;
  const disabled = !hasPipeline;
  const title = lockReason ?? (hasPipeline ? "Assign a provider to each role" : "Select a pipeline to assign providers");
  const label = overrides > 0 ? `Agents · ${String(overrides)} reassigned` : "Agents";
  const button = `<button id="agents-picker-button" data-action="agents-picker-toggle" class="agents-picker-button${overrides > 0 ? " has-overrides" : ""}" aria-haspopup="dialog" aria-label="${escapeAttribute(label)}" ${expandedControlAttributes(open, AGENTS_POPOVER_ID)}${disabled ? " disabled" : ""} title="${escapeAttribute(title)}"><i class="codicon codicon-organization" aria-hidden="true"></i><span class="agents-picker-label">${escapeHtml(label)}</span></button>`;
  if (!open) {
    return `<div class="agents-picker" data-agents-picker>${button}</div>`;
  }
  const locked = lockReason !== undefined;
  const popover = `<div class="agents-popover" id="${AGENTS_POPOVER_ID}" role="dialog" aria-label="Agent assignments">
    <div class="agents-popover-head"><div><h2>Agents</h2><p>Assign a provider to each role for this conversation's next run. The saved pipeline is unchanged.</p></div>${overrides > 0 && !locked ? `<button type="button" class="agents-reset-all" data-action="agents-reset-all">Reset to defaults</button>` : ""}</div>
    ${locked ? `<p class="agents-locked">${escapeHtml(lockReason)}</p>` : ""}
    ${assignments.constraint ? `<p class="agents-constraint">${escapeHtml(assignments.constraint)}</p>` : ""}
    <div class="agents-slot-list">${assignments.slots.map((slot) => agentSlotHtml(slot, panel, locked)).join("")}</div>
  </div>`;
  return `<div class="agents-picker" data-agents-picker>${button}${popover}</div>`;
};

// The one panel behind the composer's settings control: how to edit the pipeline, the options that
// apply to this run, and the run details. Run options are labelled as run-local so nobody reads
// them as edits to the saved pipeline.
const composerSettingsPanelHtml = (panel: PanelState, draft: ConversationDraft): string => {
  if (!state.composerSettingsOpen) {
    return "";
  }
  const selection = pendingPipelineSelection(activeId());
  const pipelineControlsDisabled = !panel.pipelineMutable || selection !== undefined;
  const editTitle = selection
    ? `Switching to ${selection.pipelineId}…`
    : panel.pipelineMutationReason ?? "Edit the selected pipeline";
  const running = panel.running && draft.delivery === "immediate";
  const advancedControls = `<div class="composer-advanced" id="composer-advanced"><label class="iteration-control"><span>Max iterations</span><input id="pipeline-iterations" type="number" min="1" max="${String(state.manager.maxPipelineIterations)}" value="${String(draft.iterationCount)}" ${running ? "disabled" : ""}></label>
        <label class="iteration-control"><span>Mode</span><select id="pipeline-iteration-mode" ${running ? "disabled" : ""}><option value="fixed" ${draft.iterationMode === "fixed" ? "selected" : ""}>Fixed</option><option value="untilClean" ${draft.iterationMode === "untilClean" ? "selected" : ""}>Until clean</option></select></label>
        ${draft.iterationMode === "untilClean" ? `<label class="iteration-control"><span>Clean passes</span><input id="pipeline-clean-passes" type="number" min="1" max="10" value="${String(draft.requiredCleanPasses)}" ${running ? "disabled" : ""}></label>` : ""}
        <label class="delivery-control"><span>Delivery</span><select id="message-delivery"><option value="immediate" ${draft.delivery === "immediate" ? "selected" : ""}>Run now</option><option value="queue" ${draft.delivery === "queue" ? "selected" : ""}>Queue</option><option value="interrupt" ${draft.delivery === "interrupt" ? "selected" : ""}>Interrupt current run</option></select></label></div>`;
  return `<div class="composer-settings" id="composer-settings">
    <section class="composer-settings-section">
      <h3>Pipeline</h3>
      <div class="compact-actions">
        <button data-action="pipeline-edit" ${pipelineControlsDisabled ? "disabled" : ""} title="${escapeAttribute(editTitle)}">Edit pipeline</button>
        <button data-action="pipeline-new" ${pipelineControlsDisabled ? "disabled" : ""} title="${escapeAttribute(selection ? editTitle : panel.pipelineMutationReason ?? "Create a pipeline")}">New pipeline</button>
        <button data-action="pipeline-fork" ${panel.selectedPipelineDefinition && !pipelineControlsDisabled ? "" : "disabled"} title="Duplicate the selected pipeline to edit a copy">Fork selected</button>
      </div>
    </section>
    <section class="composer-settings-section">
      <h3>Run options</h3>
      <p class="composer-settings-hint">These apply to this run only. They do not change the saved pipeline.</p>
      ${advancedControls}
    </section>
    ${runContractHtml(panel, draft)}
  </div>`;
};

const composerHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const conversationId = activeId();
  const blockers = sendBlockers(conversationId, panel, draft);
  const canSubmit = blockers.length === 0;
  const selection = pendingPipelineSelection(conversationId);
  const waitingForResources = conversationById(conversationId)?.waitingForResources === true;
  const sendLabel = draft.delivery === "queue" ? "Queue" : draft.delivery === "interrupt" ? "Interrupt and send" : "Send";
  const deliveryLabel = draft.delivery === "queue" ? "queued" : draft.delivery === "interrupt" ? "interrupt" : "";
  const optionChips: string[] = [];
  if (draft.iterationCount !== 1) {
    optionChips.push(`${String(draft.iterationCount)}×`);
  }
  if (draft.iterationMode !== "fixed") {
    optionChips.push(draft.requiredCleanPasses > 1 ? `until clean ×${String(draft.requiredCleanPasses)}` : "until clean");
  }
  if (deliveryLabel) {
    optionChips.push(deliveryLabel);
  }
  const settingsLabel = optionChips.length > 0
    ? `Pipeline settings and run options · ${optionChips.join(" · ")}`
    : "Pipeline settings and run options";
  const interruptLabel = waitingForResources ? "Cancel wait" : "Stop";
  const stopButton = panel.running || waitingForResources
    ? `<button data-action="interrupt-run" class="icon-button composer-stop" aria-label="${escapeAttribute(interruptLabel)}" title="${escapeAttribute(interruptLabel)}"><i class="codicon codicon-stop-circle" aria-hidden="true"></i></button>`
    : "";
  // One rounded surface holds the attachments, the borderless prompt and the compact toolbar; the
  // send control is an arrow icon carrying its Send/Queue/Interrupt name for assistive tech.
  return `<footer class="composer">
    <div class="composer-surface">
      ${attachmentStripHtml(panel, draft)}
      <textarea id="composer-prompt" aria-label="Run input" placeholder="Describe the job for the selected pipeline…">${escapeHtml(draft.prompt)}</textarea>
      <div class="composer-toolbar">
        <button data-action="attachment-pick" class="icon-button" aria-label="Attach image, text, log, or specification" title="Attach image, text, log, or specification"><i class="codicon codicon-add" aria-hidden="true"></i></button>
        <input id="attachment-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,application/json,.txt,.log,.md,.json" multiple hidden>
        ${pipelinePickerHtml(panel)}
        ${agentsPickerHtml(panel)}
        <button data-action="composer-settings-toggle" class="icon-button composer-settings-button${state.composerSettingsOpen ? " open" : ""}${optionChips.length > 0 ? " has-chips" : ""}" title="${escapeAttribute(settingsLabel)}" aria-label="${escapeAttribute(settingsLabel)}" ${expandedControlAttributes(state.composerSettingsOpen, "composer-settings")}><i class="codicon codicon-settings-gear" aria-hidden="true"></i></button>
        <div class="composer-send">
          ${stopButton}
          <button class="send-button icon-send" data-action="submit-message" data-delivery="${escapeAttribute(draft.delivery)}" title="${escapeAttribute(`${sendLabel} · ${submitShortcutLabel}`)}" aria-label="${escapeAttribute(sendLabel)}" aria-keyshortcuts="Control+Enter Meta+Enter" ${composerSubmitStateAttributes(canSubmit, blockers)}><i class="codicon codicon-arrow-up" aria-hidden="true"></i></button>
        </div>
      </div>
    </div>
    ${composerSettingsPanelHtml(panel, draft)}
    ${canSubmit ? "" : sendBlockersHtml(blockers)}
    ${waitingForResources && canSubmit ? `<small class="composer-note">Waiting for shared capacity. No provider or verification command has started.</small>` : selection ? `<small class="composer-note">Switching pipeline. Editing and creating pipelines are locked until the selected pipeline is ready.</small>` : panel.pipelineMutationReason ? `<small class="composer-note">${escapeHtml(panel.pipelineMutationReason)}</small>` : ""}
  </footer>`;
};
