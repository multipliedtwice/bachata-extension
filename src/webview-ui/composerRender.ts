/**
 * The composer: the rounded input surface, the rich pipeline picker and the settings panel.
 * Concatenated with the other renderers and composed by roomRender, which places the composer at
 * the foot of the chat view.
 */

// One place a pipeline is chosen, whether by pointer or by keyboard. The optimistic pending write
// and the runtime message it awaits are the same the native select used, so switching and locking
// behave exactly as before.
const selectPipeline = (pipelineId: string, nextAction?: "edit"): void => {
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
  state.pendingPipelineSelections.set(id, { conversationId, pipelineId, ...(nextAction ? { nextAction } : {}) });
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
  delete state.pipelineActionFor;
  reconcilePipelinePickerActive();
  scheduleRender();
  focusAfterRender(() => document.querySelector<HTMLElement>(`[data-action="pipeline-picker-filter"][data-pipeline-filter="${filter}"]`)?.focus({ preventScroll: true }));
};

const setPipelinePickerQuery = (query: string): void => {
  state.pipelinePickerQuery = query;
  delete state.pipelineActionFor;
  reconcilePipelinePickerActive();
  scheduleRender();
  focusAfterRender(() => {
    document.getElementById("pipeline-picker-search")?.focus({ preventScroll: true });
    scrollPickerActiveOptionIntoView();
  });
};

const openPipelinePicker = (): void => {
  const panel = activePanel();
  if (!panel.pipelineMutable || pendingPipelineSelection() !== undefined) {
    return;
  }
  state.pipelinePickerOpen = true;
  delete state.pipelineActionFor;
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
  delete state.pipelineActionFor;
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
  pendingPipelineSelection(conversationId) === undefined;

// The rich pipeline picker. At rest the trigger is compact — the pipeline name and a chevron.
// Participant names and the step count are drawn only in the open list, so a pipeline reads as a
// configurable sequence there without crowding the closed composer.
const pipelinePickerHtml = (panel: PanelState): string => {
  const conversationId = activeId();
  const selection = pendingPipelineSelection(conversationId);
  const disabled = !panel.pipelineMutable || selection !== undefined;
  const selectedId = selection?.pipelineId ?? panel.selectedPipelineId;
  const selected = panel.pipelines.find((pipeline) => pipeline.id === selectedId);
  const recorded = selected === undefined && panel.selectedPipelineRemoved === true && panel.selectedPipelineDefinition?.id === selectedId
    ? panel.selectedPipelineDefinition
    : undefined;
  const label = selected?.name ?? (recorded ? localize("{0} · removed", recorded.name) : state.panels.has(conversationId)
    ? localize("No pipeline available")
    : state.manager.readOnly
      ? localize("Pipeline unavailable")
      : localize("Loading pipelines…"));
  const title = selection
    ? localize("Switching to {0}…", selected?.name ?? localize("selected pipeline"))
    : recorded
      ? localize("{0} is no longer in the pipeline catalog. This run keeps its recorded copy.", recorded.name)
      : panel.pipelineMutationReason ?? localize("Choose the pipeline this run uses");
  const open = pipelinePickerOpenState(panel, conversationId);
  const filter = effectivePipelinePickerFilter(panel);
  const entries = pipelinePickerEntries(panel);
  const filters = pipelinePickerFilters(panel);
  const activeOptionId = state.pipelinePickerActiveId ?? selectedId;
  const button = `<button id="pipeline-picker-button" data-action="pipeline-picker-toggle" class="pipeline-picker-button" aria-haspopup="dialog" aria-label="${escapeAttribute(localize("Pipeline"))}" ${expandedControlAttributes(open, PIPELINE_PICKER_LIST_ID)} ${disabled ? "disabled" : ""}${selection ? ' aria-busy="true"' : ""} title="${escapeAttribute(title)}"><span class="pipeline-picker-name">${escapeHtml(label)}</span><i class="codicon ${selection ? "codicon-loading codicon-modifier-spin" : "codicon-chevron-down"} pipeline-picker-caret" aria-hidden="true"></i></button>`;
  const list = open
    ? `<div class="pipeline-picker-popover" role="dialog" aria-label="${escapeAttribute(localize("Choose pipeline"))}"><div class="pipeline-picker-header"><p class="pipeline-picker-guidance">${escapeHtml(localize("Choose the work here. Choose providers in Agents."))}</p><label class="pipeline-picker-search" for="pipeline-picker-search"><i class="codicon codicon-search" aria-hidden="true"></i><input id="pipeline-picker-search" type="search" value="${escapeAttribute(state.pipelinePickerQuery)}" placeholder="${escapeAttribute(localize("Search pipelines"))}" aria-label="${escapeAttribute(localize("Search pipelines"))}" aria-controls="${PIPELINE_PICKER_LIST_ID}"${activeOptionId ? ` aria-activedescendant="${escapeAttribute(pipelineOptionDomId(activeOptionId))}"` : ""}></label><div class="pipeline-picker-filters" role="group" aria-label="${escapeAttribute(localize("Pipeline categories"))}">${filters.map((candidate) => `<button type="button" data-action="pipeline-picker-filter" data-pipeline-filter="${candidate}" aria-pressed="${candidate === filter ? "true" : "false"}">${escapeHtml(pipelineFilterLabel(candidate))}</button>`).join("")}</div></div><div id="${PIPELINE_PICKER_LIST_ID}" class="pipeline-picker-list" role="list" aria-label="${escapeAttribute(localize("Pipelines"))}" tabindex="-1">${entries.map((pipeline) => {
        const steps = pipelineStepCount(pipeline, panel);
        const count = pipelineParticipantCount(pipeline, panel);
        const shape = [
          steps === undefined ? undefined : countLabel(steps, "step"),
          count === undefined ? undefined : countLabel(count, "participant"),
        ].filter((part) => part !== undefined).join(" · ");
        const isSelected = pipeline.id === selectedId;
        const isActive = pipeline.id === activeOptionId;
        const actions = [
          `<button type="button" data-action="pipeline-row-details" data-pipeline-id="${escapeAttribute(pipeline.id)}">${escapeHtml(localize("Details"))}</button>`,
          ...(pipeline.editable ? [`<button type="button" data-action="pipeline-row-edit" data-pipeline-id="${escapeAttribute(pipeline.id)}">${escapeHtml(localize("Edit"))}</button>`] : []),
          `<button type="button" data-action="pipeline-row-fork" data-pipeline-id="${escapeAttribute(pipeline.id)}">${escapeHtml(localize("Fork"))}</button>`,
          ...(pipeline.editable ? [`<button type="button" class="danger" data-action="pipeline-row-delete" data-pipeline-id="${escapeAttribute(pipeline.id)}">${escapeHtml(localize("Delete"))}</button>`] : []),
        ];
        const actionsOpen = state.pipelineActionFor === pipeline.id;
        return `<div class="pipeline-picker-row" role="listitem" data-active="${isActive ? "true" : "false"}" data-selected="${isSelected ? "true" : "false"}"><button id="${escapeAttribute(pipelineOptionDomId(pipeline.id))}" type="button" class="pipeline-picker-option" data-active="${isActive ? "true" : "false"}" data-action="pipeline-picker-select" data-pipeline-id="${escapeAttribute(pipeline.id)}" aria-pressed="${isSelected ? "true" : "false"}"><span class="pipeline-picker-option-head"><span class="pipeline-picker-option-name">${escapeHtml(pipeline.name)}</span></span>${shape ? `<span class="pipeline-picker-option-meta">${escapeHtml(shape)}</span>` : ""}${pipeline.description ? `<span class="pipeline-picker-option-desc" title="${escapeAttribute(pipeline.description)}">${escapeHtml(pipeline.description)}</span>` : ""}</button><button type="button" class="icon-button pipeline-picker-actions-toggle" data-action="pipeline-row-menu" data-pipeline-id="${escapeAttribute(pipeline.id)}" aria-label="${escapeAttribute(localize("Actions for {0}", pipeline.name))}" title="${escapeAttribute(localize("Actions for {0}", pipeline.name))}" ${expandedControlAttributes(actionsOpen, `pipeline-actions-${pipeline.id}`)}><i class="codicon codicon-ellipsis" aria-hidden="true"></i></button>${actionsOpen ? `<div id="${escapeAttribute(`pipeline-actions-${pipeline.id}`)}" class="pipeline-picker-actions" role="group" aria-label="${escapeAttribute(localize("Actions for {0}", pipeline.name))}">${actions.join("")}</div>` : ""}</div>`;
      }).join("") || `<p class="pipeline-picker-empty" role="status">${escapeHtml(localize("No pipelines found"))}</p>`}</div><div class="pipeline-picker-footer"><button type="button" data-action="pipeline-picker-new"><i class="codicon codicon-add" aria-hidden="true"></i>${escapeHtml(localize("Create pipeline"))}</button></div></div>`
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
const pendingAgentProviderKey = (conversationId: string, agentId: string): string => `${conversationId}\u0000${agentId}`;
const pendingAgentModelKey = (conversationId: string, agentId: string): string => `${conversationId}\u0000${agentId}`;

const focusAgentModelMenu = (agentId: string): void => {
  focusAfterRender(() => {
    const menu = document.getElementById(agentModelMenuId(agentId));
    const target = document.getElementById(agentModelInputId(agentId))
      ?? document.getElementById(agentModelOptionId(agentId, state.agentsModelActive ?? 0))
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
  const slot = panel.agentAssignments.slots.find((candidate) => candidate.agentId === providerAgentId);
  if (!slot) return true;
  const pendingKey = pendingAgentProviderKey(activeId(), providerAgentId);
  state.pendingAgentProviders.delete(pendingKey);
  state.pendingAgentModels.delete(pendingAgentModelKey(activeId(), providerAgentId));
  delete state.agentsModelDrafts[providerAgentId];
  if (target.value === "browser") {
    state.agentsBrowserFor = providerAgentId;
    state.agentsModelMenuFor = providerAgentId;
    delete state.agentsModelActive;
    if (!panel.browserBridge.connected) {
      state.agentsBridgeOpen = true;
      postRuntime({ type: "bridge.discover" });
    }
    // A committed native select can still own focus after its pointer sequence has ended. The
    // ordinary render guard then waits indefinitely for another focus event, leaving the provider
    // label changed while the Browser Bridge controls and Local models section stay stale.
    // Release the closed select, redraw, then return focus to its replacement.
    const providerControlId = target.id;
    target.blur();
    focusAfterRender(() => document.getElementById(providerControlId)?.focus({ preventScroll: true }));
  } else {
    delete state.agentsBrowserFor;
    if (state.agentsModelMenuFor === providerAgentId) delete state.agentsModelMenuFor;
    const adapter = target.value || slot.defaultAdapter;
    state.pendingAgentProviders.set(pendingKey, {
      conversationId: activeId(),
      agentId: providerAgentId,
      adapter,
      overridden: target.value !== "" && adapter !== slot.defaultAdapter,
    });
    const providerControlId = target.id;
    target.blur();
    focusAfterRender(() => document.getElementById(providerControlId)?.focus({ preventScroll: true }));
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
  const stops = view.efforts.map((effort, index) => `<button type="button" role="radio" class="discrete-slider-stop agents-effort-stop" data-action="agents-effort" data-agent="${escapeAttribute(slot.agentId)}" data-effort="${escapeAttribute(effort.id)}" data-reached="${shownIndex >= index ? "true" : "false"}" data-thumb="${shownIndex === index ? "true" : "false"}" aria-checked="${chosen === effort.id ? "true" : "false"}" aria-label="${escapeAttribute(capitalized(effort.id))}" title="${escapeAttribute(effort.description === effort.id ? capitalized(effort.id) : `${capitalized(effort.id)} · ${effort.description}`)}" tabindex="${index === focusIndex ? "0" : "-1"}"${disabled}></button>`).join("");
  const resetTitle = view.defaultEffort === undefined ? localize("Use the provider default") : localize("Use the default · {0}", capitalized(view.defaultEffort));
  return `<div class="agents-effort">
    <div class="agents-effort-head"><span>${escapeHtml(localize("Thinking effort"))}</span><strong>${escapeHtml(shown === undefined ? localize("Default") : capitalized(shown))}${chosen === undefined ? ` · ${escapeHtml(localize("default"))}` : ""}</strong><button type="button" class="icon-button agents-effort-reset" data-action="agents-effort" data-agent="${escapeAttribute(slot.agentId)}" aria-pressed="${chosen === undefined ? "true" : "false"}" aria-label="${escapeAttribute(resetTitle)}" title="${escapeAttribute(resetTitle)}"${disabled}><i class="codicon codicon-discard" aria-hidden="true"></i></button></div>
    <div class="discrete-slider-stops agents-effort-stops" role="radiogroup" aria-label="${escapeAttribute(localize("Thinking effort for {0}", slot.responsibility))}" data-stops="${String(view.efforts.length)}">${stops}</div>
  </div>`;
};

const agentModelMenuHtml = (slot: AgentAssignmentSlot, view: AgentModelView, locked: boolean): string => {
  const agentId = slot.agentId;
  const draft = state.agentsModelDrafts[agentId] ?? "";
  const assignedIsUnlisted = slot.assignedModel !== undefined && !view.listed.some((model) => model.id === slot.assignedModel);
  const showSearch = state.agentsModelDrafts[agentId] !== undefined || view.status !== "listed" || view.listed.length === 0 || assignedIsUnlisted;
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
  const search = `<button type="button" class="icon-button agents-model-search-toggle" data-action="agents-model-search-toggle" data-agent="${escapeAttribute(agentId)}" aria-label="${escapeAttribute(localize("Search or type a model ID"))}" title="${escapeAttribute(localize("Search models"))}"${locked ? " disabled" : ""}><i class="codicon codicon-search" aria-hidden="true"></i></button>`;
  const input = `<input type="text" id="${escapeAttribute(agentModelInputId(agentId))}" class="agents-model-input" role="combobox" aria-expanded="true" aria-autocomplete="list" aria-controls="${escapeAttribute(agentModelListId(agentId))}"${options.length > 0 ? ` aria-activedescendant="${escapeAttribute(agentModelOptionId(agentId, active))}"` : ""} aria-label="${escapeAttribute(localize("Model for {0}", slot.responsibility))}"${detail ? ` aria-describedby="${escapeAttribute(detailId)}"` : ""} data-agents-model-for="${escapeAttribute(agentId)}" value="${escapeAttribute(draft)}" placeholder="${escapeAttribute(localize("Search or type a model ID"))}" title="${escapeAttribute(localize("Use a model ID accepted by your installed provider"))}" spellcheck="false" autocomplete="off"${locked ? " disabled" : ""}>`;
  const optionHtml = options.map((option, index) => {
    const selected = index === selectedIndex;
    return `<div role="option" id="${escapeAttribute(agentModelOptionId(agentId, index))}" class="agents-model-option${option.meta ? " has-meta" : ""}" data-action="agents-model" data-agent="${escapeAttribute(agentId)}"${option.model === undefined ? "" : ` data-model="${escapeAttribute(option.model)}"`} data-kind="${option.kind}" data-active="${index === active ? "true" : "false"}" aria-selected="${selected ? "true" : "false"}" tabindex="${!showSearch && index === active ? "0" : "-1"}"><span class="agents-model-option-name">${escapeHtml(option.label)}</span>${option.meta ? `<span class="agents-model-option-meta">${escapeHtml(option.meta)}</span>` : ""}${selected ? `<i class="codicon codicon-check" aria-hidden="true"></i>` : ""}</div>`;
  }).join("");
  return `<div class="agents-model-menu" id="${escapeAttribute(agentModelMenuId(agentId))}" role="group" aria-label="${escapeAttribute(localize("Model and thinking effort for {0}", slot.responsibility))}">
    ${agentEffortHtml(slot, view, locked)}
    ${showSearch ? `<div class="agents-model-search"><i class="codicon codicon-search" aria-hidden="true"></i>${input}${refresh}</div>` : `<div class="agents-model-toolbar">${search}${refresh}</div>`}
    ${detail ? `<p id="${escapeAttribute(detailId)}" class="agents-model-detail"${view.catalog?.detail ? ` title="${escapeAttribute(view.catalog.detail)}"` : ""}${view.status === "discovering" ? ` ${liveRegionAttributes(`agents:model:${agentId}`, "status", detail)}` : ""}>${escapeHtml(detail)}</p>` : ""}
    <div class="agents-model-list" id="${escapeAttribute(agentModelListId(agentId))}" role="listbox" aria-label="${escapeAttribute(localize("Models for {0}", slot.responsibility))}">${optionHtml || `<p class="agents-model-empty" role="status">${escapeHtml(localize("No matching models"))}</p>`}</div>
  </div>`;
};

const agentBrowserChipLabel = (slot: AgentAssignmentSlot, panel: PanelState): string => {
  const session = panel.browserBridge.sessions.find((entry) =>
    entry.id === slot.browserSessionId && browserAdapterForProvider(entry.provider) === slot.assignedAdapter);
  return session ? browserSessionDisplayName(session) : localize("Choose a conversation");
};

const browserSessionDisplayName = (session: BrowserSession): string => {
  const title = session.title?.trim();
  if (session.provider === "generic") {
    if (title) return title;
    try {
      return new URL(session.conversationUrl).hostname;
    } catch {
      return session.conversationUrl;
    }
  }
  const provider = browserProviderName(session.provider);
  return !title || title.localeCompare(provider, undefined, { sensitivity: "accent" }) === 0
    ? provider
    : `${provider} · ${title}`;
};

const browserSessionIsProvisioningStart = (session: BrowserSession): boolean => {
  if (session.provider === "generic") return false;
  try {
    const path = new URL(session.conversationUrl).pathname.replace(/\/$/u, "") || "/";
    return path === "/" || (session.provider === "claude" && path === "/new");
  } catch {
    return false;
  }
};

const browserSessionOccupiedLocally = (agentId: string, session: BrowserSession, panel: PanelState): boolean =>
  Object.values(panel.agents).some((agent) => {
    if (agent.id === agentId || !agent.adapterType.endsWith("-browser")) return false;
    if (agent.sessionId === session.id) return true;
    const binding = agent.browserBinding;
    if (!binding || binding.provider !== session.provider || binding.conversationIdentity !== session.conversationIdentity) return false;
    if (session.provider === "generic") return binding.preferredTabId === session.tabId;
    try {
      const pathname = new URL(session.conversationUrl).pathname.replace(/\/$/, "") || "/";
      const provisional = pathname === "/" || (session.provider === "claude" && pathname === "/new");
      return !provisional || (binding.preferredTabId === session.tabId
        && (binding.provisionalDocumentToken === undefined || binding.provisionalDocumentToken === session.documentToken));
    } catch {
      return false;
    }
  });

const agentBrowserMenuHtml = (slot: AgentAssignmentSlot, panel: PanelState): string => {
  const sessions = panel.browserBridge.sessions;
  const provisioningProviders = new Set<BrowserSession["provider"]>();
  const options = sessions.flatMap((session) => {
    const adapter = browserAdapterForProvider(session.provider);
    if (session.status !== "ready") {
      if (!browserSessionIsProvisioningStart(session) || provisioningProviders.has(session.provider)) return [];
      provisioningProviders.add(session.provider);
      const provider = browserProviderName(session.provider);
      const selected = slot.browserSessionId === undefined && slot.assignedAdapter === adapter;
      return [`<button type="button" role="option" class="agents-session-option" data-action="agents-browser-new" data-agent="${escapeAttribute(slot.agentId)}" data-adapter="${escapeAttribute(adapter)}" aria-selected="${selected ? "true" : "false"}"><span class="agents-session-name">${escapeHtml(localize("New {0} conversation", provider))}</span><span class="agents-session-meta">${escapeHtml(localize("Opens automatically when this participant runs"))}</span></button>`];
    }
    const selected = slot.browserSessionId === session.id && slot.assignedAdapter === adapter;
    const occupied = browserSessionOccupiedLocally(slot.agentId, session, panel);
    return [`<button type="button" role="option" id="agents-session-${escapeAttribute(slot.agentId)}-${escapeAttribute(session.id)}" class="agents-session-option" data-action="agents-session" data-agent="${escapeAttribute(slot.agentId)}" data-adapter="${escapeAttribute(adapter)}" data-session="${escapeAttribute(session.id)}" aria-selected="${selected ? "true" : "false"}"${occupied ? " disabled" : ""}><span class="agents-session-name">${escapeHtml(browserSessionDisplayName(session))}</span><span class="agents-session-meta">${escapeHtml(occupied ? localize("In use by another participant") : browserSessionCapabilityLabel(session))}</span></button>`];
  });
  const body = panel.browserBridge.connected
    ? options.length > 0
      ? `<div class="agents-session-list" role="listbox" aria-label="${escapeAttribute(localize("Browser conversation for {0}", slot.responsibility))}">${options.join("")}</div>`
      : `<p class="agents-model-empty">${escapeHtml(localize("No browser AI conversation is ready. Open or bind one in Browser Bridge."))}</p>`
    : `<p class="agents-model-empty">${escapeHtml(localize("Connect Browser Bridge first. Its status is at the top of this panel."))}</p><div class="compact-actions"><button type="button" data-action="bridge-discover">${escapeHtml(localize("Find browser"))}</button></div>`;
  return `<div class="agents-model-menu is-browser" id="${escapeAttribute(agentModelMenuId(slot.agentId))}" role="group" aria-label="${escapeAttribute(localize("Browser conversation for {0}", slot.responsibility))}">${body}<p class="agents-model-note">${escapeHtml(localize("The selected website controls the model or mode."))}</p></div>`;
};

const agentSlotHtml = (
  slot: AgentAssignmentSlot,
  panel: PanelState,
  providerLocked: boolean,
  modelLocked: boolean,
): string => {
  const pendingProvider = state.pendingAgentProviders.get(pendingAgentProviderKey(activeId(), slot.agentId));
  const pendingModel = state.pendingAgentModels.get(pendingAgentModelKey(activeId(), slot.agentId));
  const displayedSlot = (() => {
    const providerSlot = (() => {
      if (!pendingProvider) return slot;
      const {
        assignedAdapter: _assignedAdapter,
        assignedModel: _assignedModel,
        assignedReasoningEffort: _assignedReasoningEffort,
        browserSessionId: _browserSessionId,
        overridden: _overridden,
        ...base
      } = slot;
      return {
        ...base,
        assignedAdapter: pendingProvider.adapter,
        overridden: pendingProvider.overridden,
      };
    })();
    if (pendingModel?.adapter !== providerSlot.assignedAdapter) return providerSlot;
    const { assignedModel: _assignedModel, assignedReasoningEffort: _assignedReasoningEffort, ...base } = providerSlot;
    return { ...base, ...(pendingModel.model === undefined ? {} : { assignedModel: pendingModel.model }) };
  })();
  const isBrowser = isBrowserAssignment(displayedSlot.assignedAdapter);
  const browserMode = isBrowser || state.agentsBrowserFor === slot.agentId;
  const selectedValue = state.agentsBrowserFor === slot.agentId || (isBrowser && displayedSlot.overridden) ? "browser" : displayedSlot.overridden ? displayedSlot.assignedAdapter : "";
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
  const view = browserMode ? undefined : agentModelView(displayedSlot, panel);
  const menuLocked = pendingProvider !== undefined || (browserMode ? providerLocked : modelLocked);
  const open = state.agentsModelMenuFor === slot.agentId && !menuLocked;
  const chipLabel = view === undefined ? agentBrowserChipLabel(slot, panel) : agentModelChipLabel(displayedSlot, view);
  const chipName = view === undefined
    ? localize("Browser conversation for {0}", slot.responsibility)
    : localize("Model and thinking effort for {0}", slot.responsibility);
  const chipTitle = pendingProvider === undefined ? chipName : localize("Changing provider…");
  const chip = `<button type="button" id="${escapeAttribute(agentModelChipId(slot.agentId))}" class="agents-model-chip" data-action="agents-model-menu" data-agent="${escapeAttribute(slot.agentId)}"${view === undefined ? ' data-browser="true"' : ""} aria-haspopup="true" ${expandedControlAttributes(open, agentModelMenuId(slot.agentId))} aria-label="${escapeAttribute(`${chipName}: ${chipLabel}`)}" title="${escapeAttribute(chipTitle)}"${menuLocked ? " disabled" : ""}><span class="agents-model-chip-label">${escapeHtml(chipLabel)}</span><i class="codicon codicon-chevron-down" aria-hidden="true"></i></button>`;
  const menu = !open ? "" : view === undefined ? agentBrowserMenuHtml(slot, panel) : agentModelMenuHtml(displayedSlot, view, modelLocked);
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
  state.agentsBrowserFor !== undefined || panel.agentAssignments.slots.some((slot) => {
    const pending = state.pendingAgentProviders.get(pendingAgentProviderKey(activeId(), slot.agentId));
    return isBrowserAssignment(pending?.adapter ?? slot.assignedAdapter);
  });

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
    ? localize("Pair the Bachata Browser Bridge extension using this code.")
    : bridge.connected
      ? localize("Choose each browser agent's conversation from its selector below.")
      : "";
  const actions = bridge.enabled
    ? `<div class="compact-actions">${pairing ? `<button type="button" data-action="bridge-copy-token">${escapeHtml(localize("Copy pairing code"))}</button>` : ""}${bridge.connected ? "" : `<button type="button" data-action="bridge-discover">${escapeHtml(localize("Find browser"))}</button>`}<button type="button" data-action="bridge-reset"${runConfigurationLocked(panel) ? " disabled" : ""}>${escapeHtml(localize("Reset pairing"))}</button></div>`
    : "";
  return `<section id="agents-bridge-panel" class="agents-bridge-setup" aria-label="${escapeAttribute(localize("Browser Bridge"))}"><h3>${escapeHtml(bridge.connected ? localize("Browser Bridge") : localize("Connect Browser Bridge"))}</h3><p class="muted">${presentation.statusHtml}</p>${presentation.reasonHtml}${instruction ? `<p>${escapeHtml(instruction)}</p>` : ""}${actions}</section>`;
};

// Local models are a property of the machine, not of a role, so they read as their own section
// under the responsibilities rather than as a fourth provider choice inside each of them. Each
// feature is shown, switched and pinned on its own: they have separate settings and separate checks.
const localModelCopy = (consumer: LocalModelConsumer): { title: string; purpose: string } =>
  consumer === "semanticInterpreter"
    ? {
        title: localize("Browser action interpreter"),
        purpose: localize("Classifies plain-language browser action requests with a local Ollama or LM Studio model."),
      }
    : {
        title: localize("Selector healing"),
        purpose: localize("Recovers page controls with a local Ollama or LM Studio model when saved selectors fail."),
      };

const LOCAL_MODEL_ORDER: LocalModelConsumer[] = ["semanticInterpreter", "selectorHealing"];

const localModelHtml = (consumer: LocalModelConsumer, local: LocalModelConsumerState, locked: boolean): string => {
  const copy = localModelCopy(consumer);
  const stateClass = !local.enabled
    ? ""
    : local.status === "ready"
      ? " is-ready"
      : local.status === "unverified" || local.discovering
        ? " is-pending"
        : " is-blocked";
  const unavailable = local.status === "serverUnavailable" || local.status === "noSuitableModel" || local.status === "configuredModelUnavailable";
  const badge = !local.enabled
    ? localize("off")
    : local.discovering
      ? localize("checking…")
      : unavailable
        ? localize("unavailable")
        : local.status === "unverified"
          ? localize("not checked")
          : local.explicit
            ? localize("your choice")
            : localize("automatic");
  const disabled = locked ? " disabled" : "";
  const toggle = `<button type="button" data-action="local-model-enable" data-consumer="${consumer}" data-enabled="${local.enabled ? "false" : "true"}" aria-label="${escapeAttribute(local.enabled ? localize("Turn off {0}", copy.title) : localize("Turn on {0}", copy.title))}"${disabled}>${escapeHtml(local.enabled ? localize("Turn off") : localize("Turn on"))}</button>`;
  const chosen = local.model;
  // Changing the model re-resolves the configuration the bridge is already healing with, so the
  // override is refused for exactly as long as reassignment is: while a run holds it.
  const options = local.availableModels.map((model) => {
    const selected = model.id === chosen;
    return `<button type="button" role="option" class="agents-session-option" data-action="local-model-select" data-consumer="${consumer}" data-model="${escapeAttribute(model.id)}" aria-selected="${selected ? "true" : "false"}"${disabled}><span class="agents-session-name">${escapeHtml(model.id)}</span><span class="agents-session-meta">${escapeHtml(model.backend)} · ${escapeHtml(model.availability)}</span></button>`;
  });
  const automatic = `<button type="button" role="option" class="agents-session-option" data-action="local-model-select" data-consumer="${consumer}" aria-selected="${local.explicit ? "false" : "true"}"${disabled}><span class="agents-session-name">${escapeHtml(localize("Choose automatically"))}</span><span class="agents-session-meta">${escapeHtml(localize("checked against this feature's contract"))}</span></button>`;
  const list = local.enabled && options.length > 0
    ? `<div class="agents-session-list" role="listbox" aria-label="${escapeAttribute(localize("{0} model", copy.title))}">${automatic}${options.join("")}</div>`
    : "";
  return `<section class="agents-local${stateClass}" data-local-model="${consumer}">
    <div class="agents-slot-head">
      <div class="agents-slot-title"><strong>${escapeHtml(copy.title)}</strong><small>${escapeHtml(badge)}</small></div>
      <span class="agents-slot-actual">${escapeHtml(!local.enabled || local.discovering ? "" : local.backendLabel ?? localize("not available"))}</span>
    </div>
    <p class="agents-constraint">${escapeHtml(copy.purpose)}</p>
    <p class="agents-constraint"${local.discovering ? ` ${liveRegionAttributes(`agents:local:${consumer}`, "status", local.detail)}` : ""}>${escapeHtml(local.detail)}</p>
    <div class="compact-actions">${toggle}</div>
    ${list}
  </section>`;
};

const localModelsHtml = (panel: PanelState, locked: boolean): string =>
  LOCAL_MODEL_ORDER.map((consumer) => localModelHtml(consumer, panel.localModels[consumer], locked)).join("");

const localModelsSummaryHtml = (panel: PanelState): string => {
  const enabled = LOCAL_MODEL_ORDER.map((consumer) => panel.localModels[consumer]).filter((local) => local.enabled);
  const state = enabled.length === 0
    ? "setup"
    : enabled.some((local) => local.discovering || local.status === "unverified")
      ? "pending"
      : enabled.some((local) => local.status !== "ready")
        ? "attention"
        : "ready";
  const label = state === "setup"
    ? localize("Set up")
    : state === "pending"
      ? localize("Checking…")
      : state === "attention"
        ? localize("Needs attention")
        : localize("Ready");
  return `<summary data-local-model-state="${state}">
    <span class="agents-local-settings-copy"><i class="codicon codicon-server-process" aria-hidden="true"></i><span><strong>${escapeHtml(localize("Local models"))}</strong><small>${escapeHtml(localize("Recommended for reliable browser control"))}</small></span></span>
    <span class="agents-local-settings-status">${escapeHtml(label)}</span><i class="codicon codicon-chevron-right agents-local-settings-chevron" aria-hidden="true"></i>
  </summary>`;
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
  const bridgeNeeded = agentsBridgeNeeded(panel);
  const localModels = bridgeNeeded ? localModelsHtml(panel, providerLocked) : "";
  const popover = `<div class="agents-popover" id="${AGENTS_POPOVER_ID}" role="dialog" aria-label="${escapeAttribute(localize("Agent assignments"))}">
    <div class="agents-popover-head"><h2>${escapeHtml(localize("Agents"))}</h2><div class="agents-head-actions">${bridgeNeeded ? agentsBridgeChipHtml(panel.browserBridge) : ""}<button type="button" class="icon-button agents-close" data-action="agents-picker-toggle" aria-label="${escapeAttribute(localize("Close agent assignments"))}"><i class="codicon codicon-close" aria-hidden="true"></i></button></div></div>
    ${bridgeNeeded && state.agentsBridgeOpen === true ? agentsBridgePanelHtml(panel) : ""}
    ${providerLocked || modelLocked ? `<div class="agents-locked"><span>${escapeHtml(lockText)}</span>${historicalLock && modelLocked ? `<button type="button" data-action="create-conversation">${escapeHtml(localize("New run"))}</button>` : ""}</div>` : ""}
    ${assignments.discovering ? `<p class="agents-constraint" ${liveRegionAttributes("agents:discovery", "status", "discovering")}>${escapeHtml(localize("Discovering agents on this machine…"))}</p>` : ""}
    ${assignments.constraint ? `<p class="agents-constraint">${escapeHtml(assignments.constraint)}</p>` : ""}
    <div class="agents-slot-list">${assignments.slots.map((slot) => agentSlotHtml(slot, panel, providerLocked, modelLocked)).join("")}</div>
    ${bridgeNeeded ? `<details class="agents-local-settings" ${disclosureAttributes("agents:local-settings")}>${localModelsSummaryHtml(panel)}${localModels}</details>` : ""}
  </div>`;
  return `<div class="agents-picker" data-agents-picker>${button}${popover}</div>`;
};

const composerDelivery = (panel: PanelState): MessageDelivery =>
  runPhaseOf(panel) === "running" || conversationById(activeId())?.waitingForResources === true
    ? "queue"
    : "immediate";

const iterationCountLabel = (count: number): string =>
  count === 1 ? localize("1 iteration") : localize("{0} iterations", String(count));

// Iterations are the only per-run option that belongs in the resting composer. Pipeline actions
// live with the pipelines, and an active run makes the next submission queue automatically.
const composerSettingsPanelHtml = (draft: ConversationDraft): string => {
  if (!state.composerSettingsOpen) {
    return "";
  }
  const maximum = state.manager.maxPipelineIterations;
  const label = iterationCountLabel(draft.iterationCount);
  const stops = Array.from({ length: maximum }, (_, index) => {
    const count = index + 1;
    const countLabel = iterationCountLabel(count);
    return `<button type="button" role="radio" class="discrete-slider-stop iteration-picker-stop" data-action="run-limit" data-iterations="${String(count)}" data-reached="${draft.iterationCount >= count ? "true" : "false"}" data-thumb="${draft.iterationCount === count ? "true" : "false"}" aria-checked="${draft.iterationCount === count ? "true" : "false"}" aria-label="${escapeAttribute(countLabel)}" title="${escapeAttribute(countLabel)}" tabindex="${draft.iterationCount === count ? "0" : "-1"}"></button>`;
  }).join("");
  return `<div class="composer-settings iteration-picker-popover" id="composer-settings" role="dialog" aria-label="${escapeAttribute(localize("Iterations"))}">
    <div class="iteration-picker-head"><strong>${escapeHtml(localize("Iterations"))}</strong><span id="pipeline-iterations-output">${escapeHtml(label)}</span></div>
    <div id="pipeline-iterations" class="discrete-slider-stops iteration-picker-stops" role="radiogroup" aria-label="${escapeAttribute(localize("Iterations"))}" data-stops="${String(maximum)}">${stops}</div>
    <div class="iteration-picker-scale" aria-hidden="true"><span>1</span><span>${String(maximum)}</span></div>
  </div>`;
};

const composerPrimaryActionHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const waiting = conversationById(activeId())?.waitingForResources === true;
  const pending = pendingInterrupts.has(activeId());
  if ((runPhaseOf(panel) === "running" || waiting) && draft.prompt.trim().length === 0 && draft.selectedAttachmentIds.size === 0 && draft.pendingAttachments.size === 0) {
    const label = waiting ? localize("Cancel wait") : localize("Stop");
    return `<button data-action="interrupt-run" class="icon-button send-button icon-send composer-stop" aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}"${pending ? ' disabled aria-busy="true"' : ""}><i class="codicon codicon-stop-circle" aria-hidden="true"></i></button>${pending ? `<span class="sr-only" role="status">${escapeHtml(localize("Stopping…"))}</span>` : ""}`;
  }
  const delivery = composerDelivery(panel);
  const blockers = sendBlockers(activeId(), panel, { ...draft, delivery });
  const label = delivery === "queue" ? localize("Queue") : localize("Send");
  const title = blockers.length > 0 ? localize("{0} unavailable · {1}", label, sendRequirementsDescription(blockers)) : `${label} · ${submitShortcutLabel}`;
  return `<button class="icon-button send-button icon-send" data-action="submit-message" data-delivery="${escapeAttribute(delivery)}" title="${escapeAttribute(title)}" aria-label="${escapeAttribute(label)}" aria-keyshortcuts="Control+Enter Meta+Enter" ${composerSubmitStateAttributes(blockers.length === 0 && !pending, blockers)}${pending ? ' disabled aria-busy="true"' : ""}><i class="codicon codicon-arrow-up" aria-hidden="true"></i></button>`;
};

const executionContextControl = (panel: PanelState, draft: ConversationDraft) => {
  const context = panel.executionContext;
  const pending = state.pendingExecutionContext;
  const conversation = conversationById(activeId());
  const unavailable = context?.unavailable ?? (!context?.pinned && (draft.selectedAttachmentIds.size > 0 || draft.pendingAttachments.size > 0) ? "attachments" : undefined);
  const reasons = {
    workflow: localize("Choose serial TODO Implementation."),
    providers: localize("Choose local Claude/Codex for every role."),
    workspace: localize("Choose a workspace folder."),
    attachments: localize("Remove attachments to use efficient context."),
  };
  const unavailableReason = unavailable ? reasons[unavailable] : undefined;
  const reason = !context ? localize("Loading context setting…")
    : context.pinned ? [localize("This run keeps its recorded mode. Start a new run to change it."), unavailableReason].filter(Boolean).join(" ")
    : unavailableReason !== undefined ? unavailableReason
    : context.locked || panel.operationActive || panel.running || state.manager.readOnly || conversation?.archived || conversation?.running || conversation?.waitingForResources
      ? localize("Context can be changed before a new run starts.")
      : pending ? localize("Saving context default…")
      : pendingPipelineSelection() ? localize("Wait for the pipeline selection.")
      : undefined;
  const mode = context?.pinned ? context.mode
    : pending?.conversationId === activeId() ? pending.mode : context?.mode;
  return { checked: mode === "localTodoStateV1" && (context?.pinned === true || !unavailable), reason };
};

const setExecutionContext = (checked: boolean): void => {
  const panel = activePanel();
  const context = panel.executionContext;
  const control = executionContextControl(panel, draftFor(activeId()));
  const mode = checked ? "localTodoStateV1" : "legacy";
  if (control.reason || !context || !panel.selectedPipelineId || !panel.selectedPipelineHash || mode === context.defaultMode) return;
  const id = requestId();
  state.pendingExecutionContext = { requestId: id, conversationId: activeId(), mode };
  postRuntime({ type: "executionContext.set", mode, expectedDefault: context.defaultMode,
    pipelineId: panel.selectedPipelineId, pipelineHash: panel.selectedPipelineHash,
    attachmentIds: Array.from(draftFor(activeId()).selectedAttachmentIds), requestId: id }, activeId());
  scheduleRender();
};

const executionContextHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const control = executionContextControl(panel, draft);
  const help = localize("Uses bounded state and fresh local Claude/Codex sessions for TODO Implementation. May reduce repeated context. Savings are not yet measured. Changes apply to new runs.");
  const savedDefault = !panel.executionContext?.pinned && panel.executionContext?.defaultMode === "localTodoStateV1" && !control.checked && !state.pendingExecutionContext
    ? localize("Saved default is on; unavailable for this setup.") : "";
  return `<div class="composer-context">
    <label class="composer-context-label" for="execution-context-mode"><input id="execution-context-mode" type="checkbox"${control.checked ? " checked" : ""} aria-disabled="${control.reason ? "true" : "false"}" aria-describedby="execution-context-reason execution-context-help"><span>${escapeHtml(localize("Efficient context"))}</span></label>
    <span class="composer-context-badge">${escapeHtml(localize("Experimental"))}</span>
    <p id="execution-context-help" class="composer-context-help">${escapeHtml(help)}</p>
    <p id="execution-context-reason" class="composer-context-reason" role="status">${escapeHtml([control.reason, savedDefault].filter(Boolean).join(" "))}</p>
  </div>`;
};

const composerHtml = (panel: PanelState, draft: ConversationDraft): string => {
  const iterationLabel = iterationCountLabel(draft.iterationCount);
  const settingsLabel = localize("Iterations · {0}", iterationLabel);
  // Why Send is refused, stated on the surface for readers who cannot hover the button's title.
  // Quiet blockers stay unspoken here because the field, its placeholder and the room already say
  // them; the send button still carries the full list in its accessible description.
  const blockers = sendBlockers(activeId(), panel, { ...draft, delivery: composerDelivery(panel) });
  const visibleBlockers = blockers.filter((blocker) => blocker.quiet !== true);
  const firstBlocker = visibleBlockers[0];
  const blockerNoteHtml = firstBlocker
    ? `<div class="composer-blockers"><i class="codicon codicon-warning" aria-hidden="true"></i><span${firstBlocker.conditionFirst === true ? ` title="${escapeAttribute(firstBlocker.requirement)}"` : ""}>${escapeHtml(firstBlocker.conditionFirst === true ? firstBlocker.condition : firstBlocker.requirement)}</span>${firstBlocker.action ? `<button type="button" ${firstBlocker.action.attributes}>${escapeHtml(firstBlocker.action.label)}</button>` : ""}${visibleBlockers.length > 1 ? `<button type="button" data-action="run-requirements" data-conversation="${escapeAttribute(activeId())}">${escapeHtml(localize("{0} more", String(visibleBlockers.length - 1)))}</button>` : ""}</div>`
    : "";
  // One rounded surface holds the attachments, the borderless prompt and the compact toolbar; the
  // send control is an arrow icon carrying its Send/Queue/Interrupt name for assistive tech.
  return `<footer class="composer">
    <div class="composer-surface">
      ${attachmentStripHtml(panel, draft)}
      <textarea id="composer-prompt" maxlength="${String(BACHATA_TEXT_LIMITS.preparedDraftUnits)}" aria-label="${escapeAttribute(localize("Run input"))}" placeholder="${escapeAttribute(pipelinePromptPlaceholder(panel))}">${escapeHtml(draft.prompt)}</textarea>
      ${blockerNoteHtml}
      ${executionContextHtml(panel, draft)}
      <div class="composer-toolbar">
        <button data-action="attachment-pick" class="icon-button composer-attachment-button" aria-label="${escapeAttribute(localize("Attach image, text, log, or specification"))}" title="${escapeAttribute(localize("Attach image, text, log, or specification"))}"><i class="codicon codicon-add" aria-hidden="true"></i></button>
        <input id="attachment-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif,text/plain,text/markdown,application/json,.txt,.log,.md,.json" multiple hidden>
        ${pipelinePickerHtml(panel)}
        ${agentsPickerHtml(panel)}
        <button data-action="composer-settings-toggle" class="icon-button composer-settings-button" title="${escapeAttribute(settingsLabel)}" aria-label="${escapeAttribute(settingsLabel)}" ${expandedControlAttributes(state.composerSettingsOpen, "composer-settings")}><i class="codicon codicon-refresh" aria-hidden="true"></i>${draft.iterationCount > 1 ? `<span class="iteration-picker-value" aria-hidden="true">${String(draft.iterationCount)}</span>` : ""}</button>
        <div class="composer-send">
          ${composerPrimaryActionHtml(panel, draft)}
        </div>
      </div>
    </div>
    ${composerSettingsPanelHtml(draft)}
  </footer>`;
};
