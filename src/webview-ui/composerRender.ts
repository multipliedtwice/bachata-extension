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
      ? localize("Iterations: until clean ×{0}, at most {1}", String(draft.requiredCleanPasses), String(draft.iterationCount))
      : localize("Iterations: {0} (maximum {1})", String(draft.iterationCount), String(contract.limits.maxIterations)),
    ...(contract.limits.agentTurnTimeoutMs === undefined
      ? []
      : [localize("Provider turn limit: {0}", durationLabel(contract.limits.agentTurnTimeoutMs))]),
    ...(contract.limits.managedTaskTimeoutMs === undefined
      ? []
      : [localize("Managed task limit: {0}", durationLabel(contract.limits.managedTaskTimeoutMs))]),
    ...(contract.limits.browserOperationTimeoutMs === undefined
      ? []
      : [localize("Browser operation limit: {0}", durationLabel(contract.limits.browserOperationTimeoutMs))]),
    ...(contract.limits.maxRevisionCycles === undefined
      ? []
      : [localize("Revision cycles: {0}", String(contract.limits.maxRevisionCycles))]),
    ...(contract.limits.checklistRetries === undefined
      ? []
      : [localize("Task retries: {0}", String(contract.limits.checklistRetries))]),
    ...(contract.limits.checklistConcurrency === undefined
      ? []
      : [localize("Task concurrency: {0}", String(contract.limits.checklistConcurrency))]),
    ...(contract.limits.consensusSteps ?? []).map((step) => [
      localize("Consensus rounds, {0}: at most {1} before a human decision.", step.stepName, step.maxRounds),
      step.roundLimitRetryable
        ? (step.retryRounds ?? 1) === 1
          ? localize("Each requested review adds {0} round, including at the round limit", step.retryRounds ?? 1)
          : localize("Each requested review adds {0} rounds, including at the round limit", step.retryRounds ?? 1)
        : (step.retryRounds ?? 1) === 1
          ? localize("Each requested review adds {0} round; at the round limit this step does not offer a retry", step.retryRounds ?? 1)
          : localize("Each requested review adds {0} rounds; at the round limit this step does not offer a retry", step.retryRounds ?? 1),
    ].join(" ")),
    ...(contract.limits.maxParticipantTurns === undefined
      ? []
      : [contract.limits.participantTurnsBounded === false
          ? contract.limits.executesChecklist
            ? localize("Participant turns: at most {0} without a further human decision; each checklist task adds one bounded sub-run", contract.limits.maxParticipantTurns)
            : localize("Participant turns: at most {0} without a further human decision", contract.limits.maxParticipantTurns)
          : localize("Participant turns: at most {0} for the whole run", String(contract.limits.maxParticipantTurns))]),
  ];
  const provenance = [
    ...(contract.provenance === undefined
      ? []
      : [
          localize("Extension version: {0}", contract.provenance.extensionVersion),
          localize("Pipeline hash: {0}…", contract.provenance.pipelineHash.slice(0, 12)),
        ]),
    ...contract.providers.map((provider) =>
      `${provider.name}: ${provider.model ? localize("model {0}", provider.model) : localize("model not reported")}, ${provider.runtimeVersion ? localize("runtime {0}", provider.runtimeVersion) : localize("runtime not detected")}`),
  ];
  const scope = [
    localize("Working directory: {0}", contract.scope.workingDirectory ?? localize("not selected")),
    localize("Writes: {0}", writeScopeLabels[contract.scope.writeScope]),
    ...(contract.scope.writablePaths.length > 0
      ? [localize("Writable paths: {0}", contract.scope.writablePaths.join(", "))]
      : []),
    ...(contract.scope.readablePaths.length > 0
      ? [localize("Readable paths: {0}", contract.scope.readablePaths.join(", "))]
      : []),
    ...(contract.scope.protectedPaths.length > 0
      ? [localize("Protected paths: {0}", contract.scope.protectedPaths.join(", "))]
      : []),
    localize("Commits: {0}", contract.commitPolicy === "allow" ? localize("the controller may create commits") : localize("no commits are created")),
  ];
  const providers = contract.providers.map((provider) => {
    const roles = provider.roles.length > 0 ? ` · ${provider.roles.join(", ")}` : "";
    const model = ` · ${provider.model === undefined ? localize("model not reported") : localize("model {0}", provider.model)}`;
    return `${provider.name} · ${provider.adapterLabel ?? provider.adapter}${model}${roles} · ${contractStatusLabels[provider.status]}`;
  });
  const gates = contract.humanGates.map((gate) => `${gate.stepName} · ${contractGateLabels[gate.gate] ?? gate.gate}`);
  const roles = (contract.roles ?? []).map((role) => [
    [role.name, ...(role.managed ? [localize("managed")] : []), ...(role.optional ? [localize("optional")] : [])].join(" · "),
    role.readOnly ? localize("read-only") : localize("writes {0}", writeScopeLabels[role.writeScope]),
    ...(role.writablePaths.length > 0 ? [localize("paths {0}", role.writablePaths.join(", "))] : []),
    role.commitPolicy === "allow" ? localize("commits allowed") : localize("no commits"),
    ...(role.verification.length > 0 ? [localize("checks {0}", role.verification.join(", "))] : []),
  ].join(" · "));
  const outbound = (contract.outboundContext ?? []).length === 0
    ? ""
    : `<section class="contract-outbound"><h3>${escapeHtml(localize("What each provider receives"))}</h3>${(contract.outboundContext ?? []).map((manifest) => `<details ${disclosureAttributes(`composer:outbound:${manifest.agentId}`)}>
      <summary>${escapeHtml(manifest.name)} · ${escapeHtml(manifest.adapterLabel)}</summary>
      <p class="muted">${escapeHtml(manifest.transport)}</p>
      <ul class="contract-list">${manifest.entries.map((entry) => `<li><strong>${escapeHtml(entry.label)}</strong> · ${escapeHtml(entry.detail)}${entry.exact ? "" : ` <span class="contract-inexact">${escapeHtml(localize("selected at run time"))}</span>`}</li>`).join("")}</ul>
      <h4>${escapeHtml(localize("Never sent"))}</h4>${contractList(manifest.exclusions, "")}
      <h4>${escapeHtml(localize("Redaction"))}</h4>${contractList(manifest.redactions, "")}
    </details>`).join("")}</section>`;
  // A policy refusal is already stated under its own heading; the blockers list repeats it only
  // because the host folds refusals into blockers, so it is filtered back out here.
  const refusals = new Set(contract.policyRefusals ?? []);
  const unresolved = contract.blockers.filter((blocker) => !refusals.has(blocker));
  // Inside the settings panel this is evidence a reader opens on request, not the first thing an
  // empty room shows. Run details describe what the run may do; reading them is never a gate.
  const openByDefault = false;
  return `<details class="run-contract" ${disclosureAttributes("composer:contract", openByDefault)}>
    <summary><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i><h2 class="contract-kicker">${escapeHtml(localize("Run details"))}</h2><span class="contract-badge">${escapeHtml(safetyLevelLabels[contract.safetyLevel])}</span>${contract.assuranceLabel ? `<span class="contract-assurance">${escapeHtml(contract.assuranceLabel)}</span>` : ""}<span class="contract-pipeline" title="${escapeAttribute(contract.pipelineName)}">${escapeHtml(contract.pipelineName)}</span>${contract.blockers.length > 0 ? `<span class="contract-blockers">${escapeHtml(localize("{0} unresolved", contract.blockers.length))}</span>` : ""}</summary>
    <div class="contract-grid">
      ${contract.assuranceStatement ? `<section class="contract-assurance-statement"><h3>${escapeHtml(localize("Assurance"))}</h3><p>${escapeHtml(contract.assuranceStatement)}</p></section>` : ""}
      <section><h3>${escapeHtml(localize("Providers"))}</h3>${contractList(providers, localize("No providers are declared."))}</section>
      <section><h3>${escapeHtml(localize("Scope and commits"))}</h3>${contractList(scope, localize("No scope was resolved."))}</section>
      <section><h3>${escapeHtml(localize("Role authority"))}</h3>${contractList(roles, localize("This pipeline declares no roles; every provider runs with the scope above."))}</section>
      <section><h3>${escapeHtml(localize("Verification"))}</h3>${contractList(contract.verification, localize("No controller verification runs."))}${contract.verificationResources.length > 0 ? `<p class="muted">${escapeHtml(localize("Shared resources: {0}", contract.verificationResources.join(", ")))}</p>` : ""}</section>
      <section><h3>${escapeHtml(localize("Run limits"))}</h3>${contractList(limits, localize("No limits were resolved."))}</section>
      <section><h3>${escapeHtml(localize("Human decisions"))}</h3>${contractList(gates, localize("No human gate interrupts this run."))}</section>
      <section><h3>${escapeHtml(localize("Fallback"))}</h3>${contractList(contract.fallbacks, localize("No provider fallback is declared."))}</section>
      <section><h3>${escapeHtml(localize("Completion"))}</h3>${contractList(contract.completion, localize("No completion criteria were resolved."))}</section>
      <section><h3>${escapeHtml(localize("Provenance"))}</h3>${contractList(provenance, localize("No provenance was resolved."))}</section>
      ${outbound}
      ${refusals.size > 0 ? `<section class="contract-policy-refusals"><h3>${escapeHtml(localize("Repository policy refuses this run"))}</h3>${contractList(contract.policyRefusals ?? [], "")}<p class="muted">${escapeHtml(localize("Change the pipeline, or edit the repository policy file, before this run can start."))}</p></section>` : ""}
      ${unresolved.length > 0 ? `<section><h3>${escapeHtml(localize("Unresolved before running"))}</h3>${contractList(unresolved, "")}</section>` : ""}
    </div>
  </details>`;
};

// One place a pipeline is chosen, whether by pointer or by keyboard. The optimistic pending write
// and the runtime message it awaits are the same the native select used, so switching and locking
// behave exactly as before.
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

const pipelineCategory = (pipeline: PipelineSummary): Exclude<PipelinePickerFilter, "all"> => {
  if (pipeline.pickerCategory === "common" || pipeline.pickerCategory === "specialized" ||
      pipeline.pickerCategory === "internal" ||
      pipeline.pickerCategory === "custom") {
    return pipeline.pickerCategory;
  }
  if (pipeline.editable) return "custom";
  return pipeline.prominentOrder === undefined ? "specialized" : "common";
};

const pipelineFilterLabel = (filter: PipelinePickerFilter): string => ({
  all: localize("All"),
  common: localize("Common"),
  specialized: localize("Specialized"),
  internal: localize("Internal"),
  custom: localize("Custom"),
})[filter];

const pipelineCategoryOrder: Record<Exclude<PipelinePickerFilter, "all">, number> = {
  common: 0,
  specialized: 1,
  internal: 2,
  custom: 3,
};

const pipelinePickerFilters = (panel: PanelState): PipelinePickerFilter[] => {
  const categories = (["common", "specialized", "internal", "custom"] as const)
    .filter((category) => panel.pipelines.some((pipeline) => pipelineCategory(pipeline) === category));
  return categories.includes("custom") ? ["all", ...categories] : categories;
};

const effectivePipelinePickerFilter = (panel: PanelState): PipelinePickerFilter => {
  const filters = pipelinePickerFilters(panel);
  if (filters.includes(state.pipelinePickerFilter)) return state.pipelinePickerFilter;
  if (filters.includes("common")) return "common";
  return filters[0] ?? "common";
};

const pipelinePickerPriority = (pipeline: PipelineSummary): number => {
  if (pipeline.participantCount === 1) return 2;
  return (pipeline.participantCount ?? 0) >= 2 && pipeline.writesCode === true ? 0 : 1;
};

const pipelinePickerEntries = (panel: PanelState): PipelineSummary[] => {
  const filter = effectivePipelinePickerFilter(panel);
  const query = state.pipelinePickerQuery.trim().toLocaleLowerCase();
  return panel.pipelines
    .filter((pipeline) => filter === "all" || pipelineCategory(pipeline) === filter)
    .filter((pipeline) => query.length === 0 || [
      pipeline.id,
      pipeline.name,
      pipeline.description ?? "",
      ...(pipeline.participantNames ?? []),
    ].some((value) => value.toLocaleLowerCase().includes(query)))
    .sort((left, right) => {
      const priorityDifference = pipelinePickerPriority(left) - pipelinePickerPriority(right);
      const categoryDifference = pipelineCategoryOrder[pipelineCategory(left)] -
        pipelineCategoryOrder[pipelineCategory(right)];
      return priorityDifference || categoryDifference ||
        (left.prominentOrder ?? Number.MAX_SAFE_INTEGER) - (right.prominentOrder ?? Number.MAX_SAFE_INTEGER) ||
        left.name.localeCompare(right.name);
    });
};

const reconcilePipelinePickerActive = (): void => {
  const panel = activePanel();
  const entries = pipelinePickerEntries(panel);
  if (entries.some((pipeline) => pipeline.id === state.pipelinePickerActiveId)) return;
  const nextId = entries.find((pipeline) => pipeline.id === panel.selectedPipelineId)?.id ?? entries[0]?.id;
  setOptionalProperty(state, "pipelinePickerActiveId", nextId);
};

const rememberPipelinePickerFilter = (filter: PipelinePickerFilter): void => {
  state.pipelinePickerFilter = filter;
  vscode.setState?.({ ...(vscode.getState?.() ?? {}), pipelinePickerFilter: filter });
};

const setPipelinePickerFilter = (filter: string): void => {
  if (filter !== "all" && filter !== "common" && filter !== "specialized" &&
      filter !== "internal" && filter !== "custom") return;
  if (!pipelinePickerFilters(activePanel()).includes(filter)) return;
  rememberPipelinePickerFilter(filter);
  reconcilePipelinePickerActive();
  scheduleRender();
  focusAfterRender(() => document.querySelector<HTMLElement>(`[data-action="pipeline-picker-filter"][data-pipeline-filter="${filter}"]`)?.focus({ preventScroll: true }));
};

const setPipelinePickerQuery = (query: string): void => {
  state.pipelinePickerQuery = query;
  reconcilePipelinePickerActive();
  scheduleRender();
  focusAfterRender(() => {
    document.getElementById("pipeline-picker-search")?.focus({ preventScroll: true });
    scrollPickerActiveOptionIntoView();
  });
};

const openPipelinePicker = (): void => {
  const panel = activePanel();
  if (!panel.pipelineMutable || pendingPipelineSelection() !== undefined || panel.pipelines.length === 0) {
    return;
  }
  state.pipelinePickerOpen = true;
  rememberPipelinePickerFilter(effectivePipelinePickerFilter(panel));
  const activeId = panel.selectedPipelineId ?? pipelinePickerEntries(panel)[0]?.id;
  const entries = pipelinePickerEntries(panel);
  setOptionalProperty(state, "pipelinePickerActiveId", entries.some((pipeline) => pipeline.id === activeId)
    ? activeId
    : entries[0]?.id);
  scheduleRender();
  focusAfterRender(() => {
    document.getElementById("pipeline-picker-search")?.focus({ preventScroll: true });
    scrollPickerActiveOptionIntoView();
  });
};

const closePipelinePicker = (restoreFocus = true): void => {
  if (!state.pipelinePickerOpen) {
    return;
  }
  state.pipelinePickerOpen = false;
  state.pipelinePickerQuery = "";
  delete state.pipelinePickerActiveId;
  scheduleRender();
  if (restoreFocus) {
    focusAfterRender(() => document.getElementById("pipeline-picker-button")?.focus());
  }
};

const movePipelinePickerActive = (key: string): void => {
  const ids = pipelinePickerEntries(activePanel()).map((pipeline) => pipeline.id);
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
  focusAfterRender(() => {
    document.getElementById("pipeline-picker-search")?.focus({ preventScroll: true });
    scrollPickerActiveOptionIntoView();
  });
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

const selectedPipelineSummary = (panel: PanelState): PipelineSummary | undefined => {
  const selectedId = pendingPipelineSelection(activeId())?.pipelineId ?? panel.selectedPipelineId;
  return panel.pipelines.find((pipeline) => pipeline.id === selectedId);
};

const pipelinePromptPlaceholder = (panel: PanelState): string => {
  const pipeline = selectedPipelineSummary(panel);
  if (!pipeline) return localize("Describe the job for the selected pipeline…");
  return pipeline.presentation?.promptPlaceholder ?? localize("Describe the outcome for {0}…", pipeline.name);
};

const pipelineSplashHtml = (panel: PanelState): string => {
  const pipeline = selectedPipelineSummary(panel);
  if (!pipeline) {
    return `<section class="conversation-intro pipeline-intro"><div class="pipeline-intro-icon" aria-hidden="true"><i class="codicon codicon-symbol-method"></i></div><h2>${escapeHtml(localize("Choose a pipeline"))}</h2><p>${escapeHtml(localize("Choose the work below, then describe the outcome you want."))}</p></section>`;
  }
  const stepCount = pipelineStepCount(pipeline, panel);
  const participantCount = pipelineParticipantCount(pipeline, panel);
  const summary = [
    stepCount === undefined ? undefined : stepCount === 1 ? localize("{0} step", stepCount) : localize("{0} steps", stepCount),
    participantCount === undefined ? undefined : participantCount === 1 ? localize("{0} participant", participantCount) : localize("{0} participants", participantCount),
  ].filter((item): item is string => item !== undefined).join(" · ");
  const icon = pipeline.presentation?.icon ?? (pipeline.editable ? "symbol-method" : "search");
  return `<section class="conversation-intro pipeline-intro" data-intro-pipeline-id="${escapeAttribute(pipeline.id)}">
    <div class="pipeline-intro-icon" aria-hidden="true"><i class="codicon codicon-${escapeAttribute(icon)}"></i></div>
    <h2>${escapeHtml(pipeline.name)}</h2>
    ${pipeline.description ? `<p class="pipeline-intro-description">${escapeHtml(pipeline.description)}</p>` : ""}
    ${summary ? `<p class="pipeline-intro-meta">${escapeHtml(summary)}</p>` : ""}
  </section>`;
};

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
  const label = selected?.name ?? (state.panels.has(conversationId)
    ? localize("No pipeline available")
    : state.manager.readOnly
      ? localize("Pipeline unavailable")
      : localize("Loading pipelines…"));
  const title = selection
    ? localize("Switching to {0}…", selected?.name ?? localize("selected pipeline"))
    : panel.pipelineMutationReason ?? localize("Choose the pipeline this run uses");
  const open = pipelinePickerOpenState(panel, conversationId);
  const filter = effectivePipelinePickerFilter(panel);
  const entries = pipelinePickerEntries(panel);
  const filters = pipelinePickerFilters(panel);
  const activeOptionId = state.pipelinePickerActiveId ?? selectedId;
  const button = `<button id="pipeline-picker-button" data-action="pipeline-picker-toggle" class="pipeline-picker-button" role="combobox" aria-haspopup="listbox" aria-label="${escapeAttribute(localize("Pipeline"))}" ${expandedControlAttributes(open, PIPELINE_PICKER_LIST_ID)}${open && activeOptionId ? ` aria-activedescendant="${escapeAttribute(pipelineOptionDomId(activeOptionId))}"` : ""} ${disabled ? "disabled" : ""}${selection ? ' aria-busy="true"' : ""} title="${escapeAttribute(title)}"><span class="pipeline-picker-name">${escapeHtml(label)}</span><i class="codicon ${selection ? "codicon-loading codicon-modifier-spin" : "codicon-chevron-down"} pipeline-picker-caret" aria-hidden="true"></i></button>`;
  const list = open
    ? `<div class="pipeline-picker-popover"><div class="pipeline-picker-header"><p class="pipeline-picker-guidance">${escapeHtml(localize("Choose the work here. Choose providers in Agents."))}</p><label class="pipeline-picker-search" for="pipeline-picker-search"><i class="codicon codicon-search" aria-hidden="true"></i><input id="pipeline-picker-search" type="search" value="${escapeAttribute(state.pipelinePickerQuery)}" placeholder="${escapeAttribute(localize("Search pipelines"))}" aria-label="${escapeAttribute(localize("Search pipelines"))}" aria-controls="${PIPELINE_PICKER_LIST_ID}"${activeOptionId ? ` aria-activedescendant="${escapeAttribute(pipelineOptionDomId(activeOptionId))}"` : ""}></label><div class="pipeline-picker-filters" role="group" aria-label="${escapeAttribute(localize("Pipeline categories"))}">${filters.map((candidate) => `<button type="button" data-action="pipeline-picker-filter" data-pipeline-filter="${candidate}" aria-pressed="${candidate === filter ? "true" : "false"}">${escapeHtml(pipelineFilterLabel(candidate))}</button>`).join("")}</div></div><div id="${PIPELINE_PICKER_LIST_ID}" class="pipeline-picker-list" role="listbox" aria-label="${escapeAttribute(localize("Pipeline"))}" tabindex="-1">${entries.map((pipeline) => {
        const steps = pipelineStepCount(pipeline, panel);
        const count = pipelineParticipantCount(pipeline, panel);
        const shape = [
          steps === undefined ? undefined : countLabel(steps, "step"),
          count === undefined ? undefined : countLabel(count, "participant"),
        ].filter((part) => part !== undefined).join(" · ");
        const isSelected = pipeline.id === selectedId;
        const isActive = pipeline.id === activeOptionId;
        return `<div id="${escapeAttribute(pipelineOptionDomId(pipeline.id))}" role="option" class="pipeline-picker-option" data-active="${isActive ? "true" : "false"}" data-action="pipeline-picker-select" data-pipeline-id="${escapeAttribute(pipeline.id)}" aria-selected="${isSelected ? "true" : "false"}"><span class="pipeline-picker-option-head"><span class="pipeline-picker-option-name">${escapeHtml(pipeline.name)}</span>${isSelected ? `<i class="codicon codicon-check" aria-hidden="true"></i>` : ""}</span>${shape ? `<span class="pipeline-picker-option-meta">${escapeHtml(shape)}</span>` : ""}${pipeline.description ? `<span class="pipeline-picker-option-desc">${escapeHtml(pipeline.description)}</span>` : ""}</div>`;
      }).join("") || `<p class="pipeline-picker-empty" role="status">${escapeHtml(localize("No pipelines found"))}</p>`}</div></div>`
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
  conversationById(activeId())?.archived
    ? localize("Archived runs keep their original providers and models.")
    : panel.agentAssignments.lockReason;

const agentsModelLockReason = (panel: PanelState): string | undefined =>
  conversationById(activeId())?.archived
    ? localize("Archived runs keep their original providers and models.")
    : panel.agentAssignments.modelLockReason;

const agentsAssignable = (panel: PanelState): boolean =>
  panel.agentAssignments.slots.length > 0;

const openAgentsPicker = (focusAgentId?: string): void => {
  const panel = activePanel();
  if (!agentsAssignable(panel)) {
    return;
  }
  state.roomView = "chat";
  state.agentsPickerOpen = true;
  if (focusAgentId !== undefined) {
    state.agentsModelMenuFor = focusAgentId;
    delete state.agentsModelActive;
  }
  discoverVisibleAgentModels(panel);
  focusAfterRender(() => {
    const requestedModel = focusAgentId === undefined
      ? undefined
      : document.getElementById(agentModelInputId(focusAgentId)) ?? document.getElementById(agentModelChipId(focusAgentId));
    (requestedModel ?? document.getElementById("agents-picker-button"))?.focus();
  });
};

const closeAgentsPicker = (restoreFocus = true): void => {
  if (!state.agentsPickerOpen) {
    return;
  }
  state.agentsPickerOpen = false;
  delete state.agentsBrowserFor;
  delete state.agentsModelMenuFor;
  delete state.agentsModelActive;
  scheduleRender();
  if (restoreFocus) {
    focusAfterRender(() => document.getElementById("agents-picker-button")?.focus());
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

const requestedAgentModelCatalogs = new Set<string>();

const discoverVisibleAgentModels = (panel: PanelState = activePanel()): void => {
  if (!state.agentsPickerOpen || conversationById(activeId())?.archived) return;
  for (const slot of panel.agentAssignments.slots) {
    if (isBrowserAssignment(slot.assignedAdapter)) continue;
    const catalog = panel.agentAssignments.adapterModels?.[slot.assignedAdapter];
    if (catalog && catalog.status !== "unknown") continue;
    const key = `${activeId()}:${slot.assignedAdapter}`;
    if (requestedAgentModelCatalogs.has(key)) continue;
    requestedAgentModelCatalogs.add(key);
    postRuntime({ type: "agents.model.discover", agentId: slot.agentId });
  }
};

const agentModelInputId = (agentId: string): string => `agents-model-input-${agentId}`;
const agentModelChipId = (agentId: string): string => `agents-model-chip-${agentId}`;
const agentModelMenuId = (agentId: string): string => `agents-model-menu-${agentId}`;
const agentModelListId = (agentId: string): string => `agents-model-list-${agentId}`;
const agentModelOptionId = (agentId: string, index: number): string => `agents-model-option-${agentId}-${String(index)}`;

const focusAgentModelMenu = (agentId: string): void => {
  focusAfterRender(() => {
    const menu = document.getElementById(agentModelMenuId(agentId));
    const target = document.getElementById(agentModelInputId(agentId))
      ?? menu?.querySelector<HTMLElement>('[role="option"]')
      ?? menu?.querySelector<HTMLElement>("button");
    target?.focus({ preventScroll: true });
    document.getElementById(agentModelOptionId(agentId, state.agentsModelActive ?? 0))?.scrollIntoView({ block: "nearest" });
  });
};

const openAgentModelMenu = (agentId: string): void => {
  state.agentsModelMenuFor = agentId;
  delete state.agentsModelActive;
  delete state.agentsModelDrafts[agentId];
  scheduleRender();
  focusAgentModelMenu(agentId);
};

const closeAgentModelMenu = (restoreFocus = true): void => {
  const agentId = state.agentsModelMenuFor;
  if (agentId === undefined) return;
  delete state.agentsModelMenuFor;
  delete state.agentsModelActive;
  delete state.agentsModelDrafts[agentId];
  scheduleRender();
  if (restoreFocus) focusAfterRender(() => document.getElementById(agentModelChipId(agentId))?.focus());
};

const toggleAgentModelMenu = (agentId: string): void => {
  if (state.agentsModelMenuFor === agentId) closeAgentModelMenu();
  else openAgentModelMenu(agentId);
};

const setAgentModelDraft = (agentId: string, value: string): void => {
  state.agentsModelDrafts[agentId] = value;
  state.agentsModelActive = 0;
  scheduleRender();
  focusAgentModelMenu(agentId);
};

const agentModelOptionElements = (agentId: string): HTMLElement[] =>
  Array.from(document.getElementById(agentModelListId(agentId))?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);

const moveAgentModelActive = (key: string): void => {
  const agentId = state.agentsModelMenuFor;
  if (agentId === undefined) return;
  const options = agentModelOptionElements(agentId);
  if (options.length === 0) return;
  const current = options.findIndex((option) => option.dataset.active === "true");
  const index = current < 0 ? 0 : current;
  state.agentsModelActive = key === "ArrowDown" ? Math.min(options.length - 1, index + 1) : Math.max(0, index - 1);
  scheduleRender();
  focusAgentModelMenu(agentId);
};

const commitAgentModelActive = (): void => {
  const agentId = state.agentsModelMenuFor;
  if (agentId === undefined) return;
  agentModelOptionElements(agentId).find((option) => option.dataset.active === "true")?.click();
};

const handleAgentSelectionChange = (target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean => {
  const providerAgentId = target.dataset.agentsProviderFor;
  if (!providerAgentId) return false;
  const panel = activePanel();
  if (agentsAssignmentLockReason(panel) !== undefined || target.disabled) return true;
  delete state.agentsModelDrafts[providerAgentId];
  if (target.value === "browser") {
    state.agentsBrowserFor = providerAgentId;
    state.agentsModelMenuFor = providerAgentId;
    delete state.agentsModelActive;
    if (!panel.browserBridge.connected) state.agentsBridgeOpen = true;
    postRuntime({ type: "bridge.discover" });
    scheduleRender();
  } else {
    delete state.agentsBrowserFor;
    if (state.agentsModelMenuFor === providerAgentId) delete state.agentsModelMenuFor;
    postRuntime({ type: "agents.assign", agentId: providerAgentId, ...(target.value ? { adapter: target.value } : {}) });
  }
  return true;
};

const capitalized = (value: string): string => value.slice(0, 1).toUpperCase() + value.slice(1);

const agentModelView = (slot: AgentAssignmentSlot, panel: PanelState) => {
  const catalog = panel.agentAssignments.adapterModels?.[slot.assignedAdapter];
  const status = catalog?.status ?? "unknown";
  const listed = catalog?.models ?? [];
  const defaultModel = slot.assignedAdapter === slot.defaultAdapter ? slot.defaultModel : undefined;
  const reportedDefault = listed.find((model) => model.isDefault);
  const selectedModel = listed.find((model) => model.id === slot.assignedModel)
    ?? (slot.assignedModel === undefined && defaultModel !== undefined
      ? listed.find((model) => model.id === defaultModel)
      : undefined)
    ?? reportedDefault;
  const advertisedEfforts = selectedModel?.reasoningEfforts ?? [];
  const efforts = slot.assignedAdapter === "claude-code" && advertisedEfforts.length === 0
    ? ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, description: id }))
    : advertisedEfforts;
  return {
    catalog,
    status,
    listed,
    defaultModel,
    defaultModelLabel: defaultModel ?? reportedDefault?.label,
    efforts,
    defaultEffort: slot.defaultReasoningEffort ?? selectedModel?.defaultReasoningEffort,
  };
};

type AgentModelView = ReturnType<typeof agentModelView>;

type AgentModelOption = {
  kind: "default" | "listed" | "custom";
  model?: string;
  label: string;
  meta?: string;
};

const sameModelName = (label: string, id: string): boolean => {
  const plain = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/gu, "");
  return plain(label) === plain(id);
};

const agentModelOptions = (slot: AgentAssignmentSlot, view: AgentModelView, draft: string): AgentModelOption[] => {
  const typed = draft.trim();
  const query = typed.toLowerCase();
  const matches = (text: string): boolean => query === "" || text.toLowerCase().includes(query);
  const defaultLabel = view.defaultModelLabel === undefined
    ? localize("Provider default")
    : view.defaultModel !== undefined
      ? localize("Pipeline default · {0}", view.defaultModelLabel)
      : localize("Provider default · {0}", view.defaultModelLabel);
  const listed: AgentModelOption[] = view.listed
    .filter((model) => matches(model.id) || matches(model.label))
    .map((model) => ({ kind: "listed", model: model.id, label: model.label, ...(sameModelName(model.label, model.id) ? {} : { meta: model.id }) }));
  const assigned = slot.assignedModel;
  const unlisted: AgentModelOption[] = assigned !== undefined && !view.listed.some((model) => model.id === assigned) && matches(assigned)
    ? [{ kind: "listed", model: assigned, label: assigned, ...(view.status === "listed" ? { meta: localize("not listed") } : {}) }]
    : [];
  const custom: AgentModelOption[] = typed !== "" && typed !== assigned && !view.listed.some((model) => model.id === typed)
    ? [{ kind: "custom", model: typed, label: localize("Use “{0}”", typed), meta: localize("model ID") }]
    : [];
  return [...(query === "" ? [{ kind: "default" as const, label: defaultLabel }] : []), ...listed, ...unlisted, ...custom];
};

const agentModelChipLabel = (slot: AgentAssignmentSlot, view: AgentModelView): string => {
  const model = slot.assignedModel === undefined
    ? view.defaultModelLabel ?? localize("Default model")
    : view.listed.find((entry) => entry.id === slot.assignedModel)?.label ?? slot.assignedModel;
  if (view.efforts.length === 0) return model;
  const effort = slot.assignedReasoningEffort ?? view.defaultEffort;
  return `${effort === undefined ? localize("Default") : capitalized(effort)} · ${model}`;
};

const agentEffortHtml = (slot: AgentAssignmentSlot, view: AgentModelView, locked: boolean): string => {
  if (view.efforts.length === 0) return "";
  const chosen = slot.assignedReasoningEffort;
  const shown = chosen ?? view.defaultEffort;
  const shownIndex = view.efforts.findIndex((effort) => effort.id === shown);
  const focusIndex = Math.max(0, view.efforts.findIndex((effort) => effort.id === chosen), chosen === undefined ? shownIndex : -1);
  const disabled = locked ? " disabled" : "";
  const stops = view.efforts.map((effort, index) => `<button type="button" role="radio" class="agents-effort-stop" data-action="agents-effort" data-agent="${escapeAttribute(slot.agentId)}" data-effort="${escapeAttribute(effort.id)}" data-reached="${shownIndex >= index ? "true" : "false"}" data-thumb="${shownIndex === index ? "true" : "false"}" aria-checked="${chosen === effort.id ? "true" : "false"}" aria-label="${escapeAttribute(capitalized(effort.id))}" title="${escapeAttribute(effort.description === effort.id ? capitalized(effort.id) : `${capitalized(effort.id)} · ${effort.description}`)}" tabindex="${index === focusIndex ? "0" : "-1"}"${disabled}></button>`).join("");
  const resetTitle = view.defaultEffort === undefined ? localize("Use the provider default") : localize("Use the default · {0}", capitalized(view.defaultEffort));
  return `<div class="agents-effort">
    <div class="agents-effort-head"><span>${escapeHtml(localize("Thinking effort"))}</span><strong>${escapeHtml(shown === undefined ? localize("Default") : capitalized(shown))}${chosen === undefined ? ` · ${escapeHtml(localize("default"))}` : ""}</strong><button type="button" class="icon-button agents-effort-reset" data-action="agents-effort" data-agent="${escapeAttribute(slot.agentId)}" aria-pressed="${chosen === undefined ? "true" : "false"}" aria-label="${escapeAttribute(resetTitle)}" title="${escapeAttribute(resetTitle)}"${disabled}><i class="codicon codicon-discard" aria-hidden="true"></i></button></div>
    <div class="agents-effort-stops" role="radiogroup" aria-label="${escapeAttribute(localize("Thinking effort for {0}", slot.responsibility))}" data-stops="${String(view.efforts.length)}">${stops}</div>
  </div>`;
};

const agentModelMenuHtml = (slot: AgentAssignmentSlot, view: AgentModelView, locked: boolean): string => {
  const agentId = slot.agentId;
  const draft = state.agentsModelDrafts[agentId] ?? "";
  const options = agentModelOptions(slot, view, draft);
  const selectedIndex = options.findIndex((option) =>
    option.kind === "default" ? slot.assignedModel === undefined : option.kind === "listed" && option.model === slot.assignedModel);
  const active = Math.min(state.agentsModelActive ?? Math.max(0, selectedIndex), Math.max(0, options.length - 1));
  const detail = view.status === "discovering"
    ? localize("Loading models…")
    : view.status === "unknown"
      ? localize("Models have not been loaded.")
      : view.status === "unsupported"
        ? localize("Model list unavailable. Type a model ID accepted by this provider.")
        : view.listed.length === 0
          ? localize("No models reported. Type a model ID accepted by this provider.")
          : slot.assignedModel !== undefined && !view.listed.some((model) => model.id === slot.assignedModel)
            ? localize("The selected model is not in this provider’s current list.")
            : "";
  const detailId = `agents-model-detail-${agentId}`;
  const archived = conversationById(activeId())?.archived === true;
  const refresh = `<button type="button" class="icon-button agents-model-check" data-action="agents-model-discover" data-agent="${escapeAttribute(agentId)}" aria-label="${escapeAttribute(localize("Refresh models for {0}", slot.responsibility))}" title="${escapeAttribute(localize("Refresh provider models"))}"${view.status === "discovering" || archived || locked ? " disabled" : ""}${view.status === "discovering" ? ' aria-busy="true"' : ""}><i class="codicon codicon-refresh" aria-hidden="true"></i></button>`;
  const input = `<input type="text" id="${escapeAttribute(agentModelInputId(agentId))}" class="agents-model-input" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${escapeAttribute(agentModelListId(agentId))}"${options.length > 0 ? ` aria-activedescendant="${escapeAttribute(agentModelOptionId(agentId, active))}"` : ""} aria-label="${escapeAttribute(localize("Model for {0}", slot.responsibility))}"${detail ? ` aria-describedby="${escapeAttribute(detailId)}"` : ""} data-agents-model-for="${escapeAttribute(agentId)}" value="${escapeAttribute(draft)}" placeholder="${escapeAttribute(localize("Search or type a model ID"))}" title="${escapeAttribute(localize("Use a model ID accepted by your installed provider"))}" spellcheck="false" autocomplete="off"${locked ? " disabled" : ""}>`;
  const optionHtml = options.map((option, index) => {
    const selected = index === selectedIndex;
    return `<div role="option" id="${escapeAttribute(agentModelOptionId(agentId, index))}" class="agents-model-option" data-action="agents-model" data-agent="${escapeAttribute(agentId)}"${option.model === undefined ? "" : ` data-model="${escapeAttribute(option.model)}"`} data-kind="${option.kind}" data-active="${index === active ? "true" : "false"}" aria-selected="${selected ? "true" : "false"}"><span class="agents-model-option-name">${escapeHtml(option.label)}</span>${option.meta ? `<span class="agents-model-option-meta">${escapeHtml(option.meta)}</span>` : ""}${selected ? `<i class="codicon codicon-check" aria-hidden="true"></i>` : ""}</div>`;
  }).join("");
  return `<div class="agents-model-menu" id="${escapeAttribute(agentModelMenuId(agentId))}" role="group" aria-label="${escapeAttribute(localize("Model and thinking effort for {0}", slot.responsibility))}">
    ${agentEffortHtml(slot, view, locked)}
    <div class="agents-model-search"><i class="codicon codicon-search" aria-hidden="true"></i>${input}${refresh}</div>
    ${detail ? `<p id="${escapeAttribute(detailId)}" class="agents-model-detail"${view.catalog?.detail ? ` title="${escapeAttribute(view.catalog.detail)}"` : ""}${view.status === "discovering" ? ` ${liveRegionAttributes(`agents:model:${agentId}`, "status", detail)}` : ""}>${escapeHtml(detail)}</p>` : ""}
    <div class="agents-model-list" id="${escapeAttribute(agentModelListId(agentId))}" role="listbox" aria-label="${escapeAttribute(localize("Models for {0}", slot.responsibility))}">${optionHtml || `<p class="agents-model-empty" role="status">${escapeHtml(localize("No matching models"))}</p>`}</div>
  </div>`;
};

const agentBrowserChipLabel = (slot: AgentAssignmentSlot, panel: PanelState): string => {
  const session = panel.browserBridge.sessions.find((entry) =>
    entry.id === slot.browserSessionId && browserAdapterForProvider(entry.provider) === slot.assignedAdapter);
  return session ? `${browserProviderName(session.provider)} · ${session.title ?? session.conversationUrl}` : localize("Choose a conversation");
};

const agentBrowserMenuHtml = (slot: AgentAssignmentSlot, panel: PanelState): string => {
  const sessions = panel.browserBridge.sessions;
  const body = sessions.length === 0
    ? `<p class="agents-model-empty">${escapeHtml(panel.browserBridge.connected
      ? localize("Open a ChatGPT or Claude conversation in your browser, then choose it here.")
      : localize("Connect Browser Bridge first. Its status is at the top of this panel."))}</p><div class="compact-actions"><button type="button" data-action="bridge-discover">${escapeHtml(localize("Find browser"))}</button></div>`
    : `<div class="agents-session-list" role="listbox" aria-label="${escapeAttribute(localize("Browser conversation for {0}", slot.responsibility))}">${sessions.map((session) => {
      const adapter = browserAdapterForProvider(session.provider);
      const selected = slot.browserSessionId === session.id && slot.assignedAdapter === adapter;
      return `<button type="button" role="option" id="agents-session-${escapeAttribute(slot.agentId)}-${escapeAttribute(session.id)}" class="agents-session-option" data-action="agents-session" data-agent="${escapeAttribute(slot.agentId)}" data-adapter="${escapeAttribute(adapter)}" data-session="${escapeAttribute(session.id)}" aria-selected="${selected ? "true" : "false"}"${session.status !== "ready" ? " disabled" : ""}><span class="agents-session-name">${escapeHtml(browserProviderName(session.provider))} · ${escapeHtml(session.title ?? session.conversationUrl)}</span><span class="agents-session-meta">${escapeHtml(browserSessionCapabilityLabel(session))}</span></button>`;
    }).join("")}</div>`;
  return `<div class="agents-model-menu is-browser" id="${escapeAttribute(agentModelMenuId(slot.agentId))}" role="group" aria-label="${escapeAttribute(localize("Browser conversation for {0}", slot.responsibility))}">${body}<p class="agents-model-note">${escapeHtml(localize("Choose the model in the connected browser conversation."))}</p></div>`;
};

const agentSlotHtml = (
  slot: AgentAssignmentSlot,
  panel: PanelState,
  providerLocked: boolean,
  modelLocked: boolean,
): string => {
  const isBrowser = isBrowserAssignment(slot.assignedAdapter);
  const browserMode = isBrowser || state.agentsBrowserFor === slot.agentId;
  const selectedValue = state.agentsBrowserFor === slot.agentId || (isBrowser && slot.overridden) ? "browser" : slot.overridden ? slot.assignedAdapter : "";
  const providerOptions = [
    `<option value=""${selectedValue === "" ? " selected" : ""}>${escapeHtml(localize("Default · {0}", assignedAdapterLabel(slot.defaultAdapter)))}</option>`,
    ...panel.agentAssignments.assignableAdapters
      .filter((adapter) => !isBrowserAssignment(adapter) && adapter !== slot.defaultAdapter)
      .map((adapter) => {
        const discovered = panel.agentAssignments.availableAdapters.includes(adapter);
        const pending = !discovered && panel.agentAssignments.discovering;
        const label = pending ? localize("{0} · checking…", assignedAdapterLabel(adapter)) : discovered ? assignedAdapterLabel(adapter) : localize("{0} · not found", assignedAdapterLabel(adapter));
        const unavailable = discovered || pending ? "" : ` title="${escapeAttribute(localize("{0} was not found on this machine", assignedAdapterLabel(adapter)))}"`;
        return `<option value="${escapeAttribute(adapter)}"${selectedValue === adapter ? " selected" : ""}${unavailable}>${escapeHtml(label)}</option>`;
      }),
    ...(panel.agentAssignments.assignableAdapters.some(isBrowserAssignment) ? [`<option value="browser"${selectedValue === "browser" ? " selected" : ""}>Browser Bridge</option>`] : []),
  ].join("");
  const view = browserMode ? undefined : agentModelView(slot, panel);
  const menuLocked = browserMode ? providerLocked : modelLocked;
  const open = state.agentsModelMenuFor === slot.agentId && !menuLocked;
  const chipLabel = view === undefined ? agentBrowserChipLabel(slot, panel) : agentModelChipLabel(slot, view);
  const chipName = view === undefined
    ? localize("Browser conversation for {0}", slot.responsibility)
    : localize("Model and thinking effort for {0}", slot.responsibility);
  const chip = `<button type="button" id="${escapeAttribute(agentModelChipId(slot.agentId))}" class="agents-model-chip" data-action="agents-model-menu" data-agent="${escapeAttribute(slot.agentId)}"${view === undefined ? ' data-browser="true"' : ""} aria-haspopup="true" ${expandedControlAttributes(open, agentModelMenuId(slot.agentId))} aria-label="${escapeAttribute(`${chipName}: ${chipLabel}`)}" title="${escapeAttribute(chipName)}"${menuLocked ? " disabled" : ""}><span class="agents-model-chip-label">${escapeHtml(chipLabel)}</span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>`;
  const menu = !open ? "" : view === undefined ? agentBrowserMenuHtml(slot, panel) : agentModelMenuHtml(slot, view, modelLocked);
  const agentState = panel.agents[slot.agentId];
  const statusError = agentState?.error ? `<p class="agents-slot-error">${escapeHtml(agentState.error)}</p>` : "";
  return `<article class="agents-slot" data-agent-slot="${escapeAttribute(slot.agentId)}">
    <div class="agents-slot-head"><strong>${escapeHtml(slot.responsibility)}</strong></div>
    <div class="agents-slot-row">
      <select id="agents-provider-${escapeAttribute(slot.agentId)}" class="agents-provider-select" data-agents-provider-for="${escapeAttribute(slot.agentId)}" aria-label="${escapeAttribute(localize("Provider for {0}", slot.responsibility))}" title="${escapeAttribute(localize("Provider"))}"${providerLocked ? " disabled" : ""}>${providerOptions}</select>
      ${chip}
    </div>
    ${menu}${statusError}
  </article>`;
};

const agentsBridgeNeeded = (panel: PanelState): boolean =>
  state.agentsBrowserFor !== undefined || panel.agentAssignments.slots.some((slot) => isBrowserAssignment(slot.assignedAdapter));

const agentsBridgeChipHtml = (bridge: BrowserBridgeStatus): string => {
  const display = browserBridgeDisplay(bridge);
  const pairing = Boolean(bridge.pairingToken) && !bridge.connected;
  const chipState = pairing ? "pairing" : display.state;
  const label = display.state === "connected"
    ? localize("Bridge connected")
    : pairing
      ? localize("Pair Bridge")
      : display.state === "connecting"
        ? localize("Bridge connecting…")
        : localize("Bridge offline");
  return `<button type="button" id="agents-bridge-chip" class="agents-bridge-chip" data-action="agents-bridge-toggle" data-bridge-state="${escapeAttribute(chipState)}" ${expandedControlAttributes(state.agentsBridgeOpen === true, "agents-bridge-panel")} title="${escapeAttribute(localize("Browser Bridge status and pairing"))}"><i class="codicon codicon-circle-filled agents-bridge-dot" aria-hidden="true"></i><span>${escapeHtml(label)}</span></button>`;
};

const agentsBridgePanelHtml = (panel: PanelState): string => {
  const bridge = panel.browserBridge;
  const presentation = browserBridgePresentation(bridge, "agents:bridge");
  const pairing = Boolean(bridge.pairingToken) && !bridge.connected;
  const instruction = pairing
    ? localize("Pair the Bachata Browser Bridge extension using this token.")
    : bridge.connected
      ? localize("Choose each browser agent's conversation from its selector below.")
      : "";
  const actions = bridge.enabled
    ? `<div class="compact-actions">${pairing ? `<button type="button" data-action="bridge-copy-token">${escapeHtml(localize("Copy pairing token"))}</button>` : ""}<button type="button" data-action="bridge-discover">${escapeHtml(localize("Find browser"))}</button><button type="button" data-action="bridge-reset"${runConfigurationLocked(panel) ? " disabled" : ""}>${escapeHtml(localize("Reset pairing"))}</button></div>`
    : "";
  return `<section id="agents-bridge-panel" class="agents-bridge-setup" aria-label="${escapeAttribute(localize("Browser Bridge"))}"><h3>${escapeHtml(bridge.connected ? localize("Browser Bridge") : localize("Connect Browser Bridge"))}</h3><p class="muted">${presentation.statusHtml}</p>${presentation.reasonHtml}${instruction ? `<p>${escapeHtml(instruction)}</p>` : ""}${actions}</section>`;
};

// Local interpretation is a property of the machine, not of a role, so it reads as its own section
// under the responsibilities rather than as a fourth provider choice inside each of them.
const localInterpreterHtml = (panel: PanelState, locked: boolean): string => {
  const local = panel.localInterpreter;
  if (!local.enabled && local.status === "disabled") {
    return "";
  }
  const stateClass = local.status === "ready"
    ? " is-ready"
    : local.status === "unverified" || local.discovering
      ? " is-pending"
      : " is-blocked";
  const chosen = local.model;
  // Changing the model re-resolves the configuration the bridge is already healing with, so the
  // override is refused for exactly as long as reassignment is: while a run holds it.
  const options = local.availableModels.map((model) => {
    const selected = model.id === chosen;
    return `<button type="button" role="option" class="agents-session-option" data-action="local-model-select" data-model="${escapeAttribute(model.id)}" aria-selected="${selected ? "true" : "false"}"${locked ? " disabled" : ""}><span class="agents-session-name">${escapeHtml(model.id)}</span><span class="agents-session-meta">${escapeHtml(model.backend)} · ${escapeHtml(model.availability)}</span></button>`;
  });
  const automatic = `<button type="button" role="option" class="agents-session-option" data-action="local-model-select" aria-selected="${local.explicit ? "false" : "true"}"${locked ? " disabled" : ""}><span class="agents-session-name">${escapeHtml(localize("Choose automatically"))}</span><span class="agents-session-meta">${escapeHtml(localize("checked against the interpreter contract"))}</span></button>`;
  const list = options.length > 0
    ? `<div class="agents-session-list" role="listbox" aria-label="${escapeAttribute(localize("Local interpreter model"))}">${automatic}${options.join("")}</div>`
    : "";
  return `<section class="agents-local${stateClass}">
    <div class="agents-slot-head">
      <div class="agents-slot-title"><strong>${escapeHtml(localize("Local interpreter"))}</strong><small>${escapeHtml(local.status === "serverUnavailable" || local.status === "noSuitableModel" || local.status === "configuredModelUnavailable" ? localize("unavailable") : local.explicit ? localize("your choice") : localize("automatic"))}</small></div>
      <span class="agents-slot-actual">${escapeHtml(local.backendLabel ?? (local.discovering ? localize("checking…") : localize("not available")))}</span>
    </div>
    <p class="agents-constraint"${local.discovering ? ` ${liveRegionAttributes("agents:local", "status", local.detail)}` : ""}>${escapeHtml(local.detail)}</p>
    ${list}
  </section>`;
};

const agentsPickerHtml = (panel: PanelState): string => {
  const assignments = panel.agentAssignments;
  const lockReason = agentsAssignmentLockReason(panel);
  const modelLockReason = agentsModelLockReason(panel);
  const hasPipeline = agentsAssignable(panel);
  const overrides = assignments.slots.filter((slot) => slot.overridden).length;
  const open = state.agentsPickerOpen && hasPipeline;
  const disabled = !hasPipeline;
  const title = lockReason !== undefined && modelLockReason === undefined
    ? localize("Change models for the next turn")
    : lockReason ?? modelLockReason ?? (hasPipeline ? localize("Assign a provider to each role") : localize("Select a pipeline to assign providers"));
  const label = assignments.discovering
    ? localize("Discovering agents…")
    : overrides > 0
      ? localize("Agents · {0} reassigned", String(overrides))
      : localize("Agents");
  const button = `<button id="agents-picker-button" data-action="agents-picker-toggle" class="icon-button agents-picker-button" aria-haspopup="dialog" aria-label="${escapeAttribute(label)}" ${expandedControlAttributes(open, AGENTS_POPOVER_ID)}${disabled ? " disabled" : ""} title="${escapeAttribute(title)}"><i class="codicon codicon-organization" aria-hidden="true"></i><span class="agents-picker-label">${escapeHtml(label)}</span></button>`;
  if (!open) {
    return `<div class="agents-picker" data-agents-picker>${button}</div>`;
  }
  const providerLocked = lockReason !== undefined;
  const modelLocked = modelLockReason !== undefined;
  const historicalLock = providerLocked && (panel.resumableWorkflow !== undefined || /reset this run/iu.test(lockReason ?? ""));
  const modelChangeOnResume = historicalLock && !modelLocked;
  const lockText = modelChangeOnResume
    ? localize("Providers stay fixed for this run. Model and thinking effort changes apply when you resume.")
    : historicalLock
      ? localize("This run keeps its original providers and models.")
      : lockReason ?? modelLockReason ?? "";
  const interpreter = localInterpreterHtml(panel, providerLocked);
  const bridgeNeeded = agentsBridgeNeeded(panel);
  const popover = `<div class="agents-popover" id="${AGENTS_POPOVER_ID}" role="dialog" aria-label="${escapeAttribute(localize("Agent assignments"))}">
    <div class="agents-popover-head"><h2>${escapeHtml(localize("Agents"))}</h2><div class="agents-head-actions">${bridgeNeeded ? agentsBridgeChipHtml(panel.browserBridge) : ""}${overrides > 0 && !providerLocked ? `<button type="button" class="agents-reset-all" data-action="agents-reset-all">${escapeHtml(localize("Reset to defaults"))}</button>` : ""}<button type="button" class="icon-button agents-close" data-action="agents-picker-toggle" aria-label="${escapeAttribute(localize("Close agent assignments"))}"><i class="codicon codicon-close" aria-hidden="true"></i></button></div></div>
    ${bridgeNeeded && state.agentsBridgeOpen === true ? agentsBridgePanelHtml(panel) : ""}
    ${providerLocked || modelLocked ? `<div class="agents-locked"><span>${escapeHtml(lockText)}</span>${historicalLock && modelLocked ? `<button type="button" data-action="create-conversation">${escapeHtml(localize("New run"))}</button>` : ""}</div>` : ""}
    ${assignments.discovering ? `<p class="agents-constraint" ${liveRegionAttributes("agents:discovery", "status", "discovering")}>${escapeHtml(localize("Discovering agents on this machine…"))}</p>` : ""}
    ${assignments.constraint ? `<p class="agents-constraint">${escapeHtml(assignments.constraint)}</p>` : ""}
    <div class="agents-slot-list">${assignments.slots.map((slot) => agentSlotHtml(slot, panel, providerLocked, modelLocked)).join("")}</div>
    ${interpreter ? `<details class="agents-slot-settings" ${disclosureAttributes("agents:local-settings")}><summary>${escapeHtml(localize("Local interpreter settings"))}</summary>${interpreter}</details>` : ""}
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
  const selected = panel.pipelines.find((pipeline) => pipeline.id === selection?.pipelineId);
  const pipelineControlsDisabled = !panel.pipelineMutable || selection !== undefined;
  const editTitle = selection
    ? localize("Switching to {0}…", selected?.name ?? localize("selected pipeline"))
    : panel.pipelineMutationReason ?? localize("Edit the selected pipeline");
  const running = runPhaseOf(panel) === "running" && draft.delivery === "immediate";
  const advancedControls = `<div class="composer-advanced" id="composer-advanced"><label class="iteration-control"><span>${escapeHtml(localize("Max iterations"))}</span><input id="pipeline-iterations" type="number" min="1" max="${String(state.manager.maxPipelineIterations)}" value="${String(draft.iterationCount)}" ${running ? "disabled" : ""}></label>
        <label class="iteration-control"><span>${escapeHtml(localize("Mode"))}</span><select id="pipeline-iteration-mode" ${running ? "disabled" : ""}><option value="fixed" ${draft.iterationMode === "fixed" ? "selected" : ""}>${escapeHtml(localize("Fixed"))}</option><option value="untilClean" ${draft.iterationMode === "untilClean" ? "selected" : ""}>${escapeHtml(localize("Until clean"))}</option></select></label>
        ${draft.iterationMode === "untilClean" ? `<label class="iteration-control"><span>${escapeHtml(localize("Clean passes"))}</span><input id="pipeline-clean-passes" type="number" min="1" max="10" value="${String(draft.requiredCleanPasses)}" ${running ? "disabled" : ""}></label>` : ""}
        <label class="delivery-control"><span>${escapeHtml(localize("Delivery"))}</span><select id="message-delivery"><option value="immediate" ${draft.delivery === "immediate" ? "selected" : ""}>${escapeHtml(localize("Run now"))}</option><option value="queue" ${draft.delivery === "queue" ? "selected" : ""}>${escapeHtml(localize("Queue"))}</option><option value="interrupt" ${draft.delivery === "interrupt" ? "selected" : ""}>${escapeHtml(localize("Interrupt current run"))}</option></select></label></div>`;
  return `<div class="composer-settings" id="composer-settings" role="dialog" aria-label="${escapeAttribute(localize("Pipeline settings and run options"))}"><div class="composer-settings-head"><h2>${escapeHtml(localize("Run settings"))}</h2><button class="icon-button" data-action="composer-settings-toggle" aria-label="${escapeAttribute(localize("Close run settings"))}">×</button></div>
    <section class="composer-settings-section">
      <h3>${escapeHtml(localize("Pipeline"))}</h3>
      <div class="compact-actions">
        <button data-action="pipeline-edit" ${pipelineControlsDisabled ? "disabled" : ""} title="${escapeAttribute(editTitle)}">${escapeHtml(localize("Edit pipeline"))}</button>
        <button data-action="pipeline-new" ${pipelineControlsDisabled ? "disabled" : ""} title="${escapeAttribute(selection ? editTitle : panel.pipelineMutationReason ?? localize("Create a pipeline"))}">${escapeHtml(localize("New pipeline"))}</button>
        <button data-action="pipeline-fork" ${panel.selectedPipelineDefinition && !pipelineControlsDisabled ? "" : "disabled"} title="${escapeAttribute(localize("Duplicate the selected pipeline to edit a copy"))}">${escapeHtml(localize("Fork selected"))}</button>
      </div>
    </section>
    <section class="composer-settings-section">
      <h3>${escapeHtml(localize("Run options"))}</h3>
      <p class="composer-settings-hint">${escapeHtml(localize("These apply to this run only. They do not change the saved pipeline."))}</p>
      ${advancedControls}
    </section>
    ${runContractHtml(panel, draft)}
  </div>`;
};

const composerPrimaryActionHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const waiting = conversationById(activeId())?.waitingForResources === true;
  const pending = pendingInterrupts.has(activeId());
  if ((runPhaseOf(panel) === "running" || waiting) && draft.prompt.trim().length === 0 && draft.selectedAttachmentIds.size === 0 && draft.pendingAttachments.size === 0) {
    const label = waiting ? localize("Cancel wait") : localize("Stop");
    return `<button data-action="interrupt-run" class="icon-button send-button icon-send composer-stop" aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}"${pending ? ' disabled aria-busy="true"' : ""}><i class="codicon codicon-stop-circle" aria-hidden="true"></i></button>${pending ? `<span class="sr-only" role="status">${escapeHtml(localize("Stopping…"))}</span>` : ""}`;
  }
  const blockers = sendBlockers(activeId(), panel, draft);
  const label = draft.delivery === "queue" ? localize("Queue") : draft.delivery === "interrupt" ? localize("Interrupt and send") : localize("Send");
  const title = blockers.length > 0 ? localize("{0} unavailable · {1}", label, sendRequirementsDescription(blockers)) : `${label} · ${submitShortcutLabel}`;
  return `<button class="icon-button send-button icon-send" data-action="submit-message" data-delivery="${escapeAttribute(draft.delivery)}" title="${escapeAttribute(title)}" aria-label="${escapeAttribute(label)}" aria-keyshortcuts="Control+Enter Meta+Enter" ${composerSubmitStateAttributes(blockers.length === 0 && !pending, blockers)}${pending ? ' disabled aria-busy="true"' : ""}><i class="codicon codicon-arrow-up" aria-hidden="true"></i></button>`;
};

const composerHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const deliveryLabel = draft.delivery === "queue" ? localize("queued") : draft.delivery === "interrupt" ? localize("interrupt") : "";
  const optionChips: string[] = [];
  if (draft.iterationCount !== 1) {
    optionChips.push(`${String(draft.iterationCount)}×`);
  }
  if (draft.iterationMode !== "fixed") {
    optionChips.push(draft.requiredCleanPasses > 1 ? localize("until clean ×{0}", String(draft.requiredCleanPasses)) : localize("until clean"));
  }
  if (deliveryLabel) {
    optionChips.push(deliveryLabel);
  }
  const settingsLabel = optionChips.length > 0
    ? localize("Pipeline settings and run options · {0}", optionChips.join(" · "))
    : localize("Pipeline settings and run options");
  // The active run options are named where they take effect, not only inside the settings control's
  // hover title: iteration count, until-clean and a queued or interrupting delivery each read as a
  // pill on the surface. The gear already carries the same list as its accessible name, so the row
  // is hidden from assistive tech to avoid a second reading of it.
  const optionChipsHtml = optionChips.length > 0
    ? `<div class="composer-chips" aria-hidden="true">${optionChips.map((chip) => `<span class="composer-chip">${escapeHtml(chip)}</span>`).join("")}</div>`
    : "";
  // Why Send is refused, stated on the surface for readers who cannot hover the button's title.
  // Quiet blockers stay unspoken here because the field, its placeholder and the room already say
  // them; the send button still carries the full list in its accessible description.
  const blockers = sendBlockers(activeId(), panel, draft);
  const visibleBlockers = blockers.filter((blocker) => blocker.quiet !== true);
  const firstBlocker = visibleBlockers[0];
  const blockerNoteHtml = firstBlocker
    ? `<div class="composer-blockers"><i class="codicon codicon-warning" aria-hidden="true"></i><span>${escapeHtml(firstBlocker.requirement)}</span>${firstBlocker.action ? `<button type="button" ${firstBlocker.action.attributes}>${escapeHtml(firstBlocker.action.label)}</button>` : ""}${visibleBlockers.length > 1 ? `<button type="button" data-action="run-requirements" data-conversation="${escapeAttribute(activeId())}">${escapeHtml(localize("{0} more", String(visibleBlockers.length - 1)))}</button>` : ""}</div>`
    : "";
  // One rounded surface holds the attachments, the borderless prompt and the compact toolbar; the
  // send control is an arrow icon carrying its Send/Queue/Interrupt name for assistive tech.
  return `<footer class="composer">
    <div class="composer-surface">
      ${attachmentStripHtml(panel, draft)}
      <textarea id="composer-prompt" maxlength="${String(BACHATA_TEXT_LIMITS.preparedDraftUnits)}" aria-label="${escapeAttribute(localize("Run input"))}" placeholder="${escapeAttribute(pipelinePromptPlaceholder(panel))}">${escapeHtml(draft.prompt)}</textarea>
      ${optionChipsHtml}
      ${blockerNoteHtml}
      <div class="composer-toolbar">
        <button data-action="attachment-pick" class="icon-button" aria-label="${escapeAttribute(localize("Attach image, text, log, or specification"))}" title="${escapeAttribute(localize("Attach image, text, log, or specification"))}"><i class="codicon codicon-add" aria-hidden="true"></i></button>
        <input id="attachment-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,application/json,.txt,.log,.md,.json" multiple hidden>
        ${pipelinePickerHtml(panel)}
        ${agentsPickerHtml(panel)}
        <button data-action="composer-settings-toggle" class="icon-button composer-settings-button${optionChips.length > 0 ? " has-chips" : ""}" title="${escapeAttribute(settingsLabel)}" aria-label="${escapeAttribute(settingsLabel)}" ${expandedControlAttributes(state.composerSettingsOpen, "composer-settings")}><i class="codicon codicon-settings-gear" aria-hidden="true"></i></button>
        <div class="composer-send">
          ${composerPrimaryActionHtml(panel, draft)}
        </div>
      </div>
    </div>
    ${composerSettingsPanelHtml(panel, draft)}
  </footer>`;
};
