/**
 * Pipeline editor: rendering, draft transitions, and input parsing.
 *
 * Concatenated after state.ts, so it edits the shared editor draft directly. Rendering and
 * the input handling that mutates the draft live together because they are one concern: the
 * shape the editor shows and the shape it writes back must stay in step.
 */

const reorderAttributes = (kind: string, index: number, name: string, direction: "up" | "down"): string => {
  const label = escapeAttribute(`Move ${kind} ${String(index + 1)}, ${name}, ${direction}`);
  return `aria-label="${label}" title="${label}"`;
};

const codeSurfaceAttributes = `spellcheck="false" autocorrect="off" autocapitalize="off"`;

const editorAgentHtml = (agent: AgentDefinition, index: number, panel: PanelState): string => {
  const browserAdapter = browserAdapterTypes.has(agent.adapter);
  const adapterSpecific = browserAdapter
    ? `<p class="field span-all"><small>Browser adapters use the selected browser conversation/site configuration. Model, command, permission mode, and approval policy are controlled outside this agent definition.</small></p>`
    : `<label class="field"><span>Command</span><input data-editor-agent="${String(index)}" data-field="command" value="${escapeAttribute(agent.command ?? "")}"></label><label class="field"><span>Permission mode</span><input data-editor-agent="${String(index)}" data-field="permissionMode" value="${escapeAttribute(agent.permissionMode ?? "")}"></label><label class="field"><span>Approval policy</span><select data-editor-agent="${String(index)}" data-field="approvalPolicy"><option value="" ${agent.approvalPolicy ? "" : "selected"}>Adapter default</option><option value="onRequest" ${agent.approvalPolicy === "onRequest" ? "selected" : ""}>onRequest</option><option value="unlessTrusted" ${agent.approvalPolicy === "unlessTrusted" ? "selected" : ""}>unlessTrusted</option></select></label>`;
  return `<details class="editor-card" data-drag-kind="agent" data-index="${String(index)}" data-editor-card-key="${escapeAttribute(editorCardKey("agent", agent.id))}" ${editorCardOpen("agent", agent.id)}><summary class="editor-card-summary"><span class="drag-handle" draggable="true" data-drag-handle="agent" data-index="${String(index)}" aria-hidden="true">⋮⋮</span><strong>Agent ${String(index + 1)} · ${escapeHtml(agent.name)}</strong><small>${escapeHtml([agent.adapter, browserAdapter ? undefined : agent.model].filter(Boolean).join(" · "))}</small></summary><div class="editor-card-body"><div class="compact-actions editor-card-actions"><button data-action="editor-agent-duplicate" data-index="${String(index)}">Duplicate</button><button data-action="editor-agent-up" data-index="${String(index)}" ${reorderAttributes("agent", index, agent.name, "up")} ${index === 0 ? "disabled" : ""}>↑</button><button data-action="editor-agent-down" data-index="${String(index)}" ${reorderAttributes("agent", index, agent.name, "down")} ${index === (state.editorDraft?.agents.length ?? 0) - 1 ? "disabled" : ""}>↓</button><button data-action="editor-agent-remove" data-index="${String(index)}">Remove</button></div><div class="form-grid"><label class="field"><span>Name</span><input data-editor-agent="${String(index)}" data-field="name" value="${escapeAttribute(agent.name)}"></label><label class="field"><span>Adapter</span><select data-editor-agent="${String(index)}" data-field="adapter">${panel.adapterTypes.map((adapter) => `<option value="${escapeAttribute(adapter)}" ${agent.adapter === adapter ? "selected" : ""}>${escapeHtml(adapter)}</option>`).join("")}</select></label>${browserAdapter ? "" : `<label class="field span-all"><span>Model</span><input data-editor-agent="${String(index)}" data-field="model" value="${escapeAttribute(agent.model ?? "")}" placeholder="adapter default"></label>`}</div>${editorAdvancedHtml(agent.capabilities?.length ? ["capabilities"] : [], `<div class="form-grid"><label class="field"><span>Working directory</span><input data-editor-agent="${String(index)}" data-field="workingDirectory" value="${escapeAttribute(agent.workingDirectory ?? "")}"></label><label class="field"><span>Resource ID</span><input data-editor-agent="${String(index)}" data-field="resourceId" value="${escapeAttribute(agent.resourceId ?? "")}"></label><label class="field"><span>Capabilities, comma-separated</span><input placeholder="implement, review" data-editor-agent="${String(index)}" data-field="capabilities" value="${escapeAttribute(listText(agent.capabilities, ", "))}"></label>${adapterSpecific}</div>`)}</div></details>`;
};

const roleBinding = (roleId: string): { text: string; unbound: boolean } => {
  const pipeline = state.editorDraft;
  const steps = pipeline?.steps ?? [];
  const bindings = steps.flatMap((step, stepIndex) =>
    step.type === "assignRoles" && step.enabled
      ? (Array.isArray(step.roleAssignments) ? step.roleAssignments : [])
        .filter((assignment) => assignment.role === roleId)
        .map((assignment) => ({ stepIndex, agentId: assignment.agentId }))
      : [],
  );
  const usedBy = steps.filter((step) =>
    (step.type === "agent" || step.type === "checklist")
    && (Array.isArray(step.participants) ? step.participants : []).includes(roleId),
  );
  if (bindings.length > 0) {
    const names = bindings.map((binding) => {
      const agent = pipeline?.agents.find((candidate) => candidate.id === binding.agentId);
      return `${agent ? agent.name : binding.agentId} in step ${String(binding.stepIndex + 1)}`;
    });
    return { text: `Assigned to ${names.join(", ")}`, unbound: false };
  }
  if (usedBy.length === 0) {
    return { text: "Not used by any step", unbound: false };
  }
  return { text: "No agent assigned — add an “Assign roles” step", unbound: true };
};

const editorRoleHtml = (role: RoleDefinition, index: number): string =>
  `<details class="editor-card" data-drag-kind="role" data-index="${String(index)}" data-editor-card-key="${escapeAttribute(editorCardKey("role", role.id))}" ${editorCardOpen("role", role.id)}><summary class="editor-card-summary"><span class="drag-handle" draggable="true" data-drag-handle="role" data-index="${String(index)}" aria-hidden="true">⋮⋮</span><strong>Role ${String(index + 1)} · ${escapeHtml(role.name)}</strong><small class="${roleBinding(role.id).unbound ? "role-unbound" : ""}">${escapeHtml(roleBinding(role.id).text)}</small></summary><div class="editor-card-body"><div class="compact-actions editor-card-actions"><button data-action="editor-role-duplicate" data-index="${String(index)}">Duplicate</button><button data-action="editor-role-up" data-index="${String(index)}" ${reorderAttributes("role", index, role.name, "up")} ${index === 0 ? "disabled" : ""}>↑</button><button data-action="editor-role-down" data-index="${String(index)}" ${reorderAttributes("role", index, role.name, "down")} ${index === (state.editorDraft?.roles?.length ?? 0) - 1 ? "disabled" : ""}>↓</button><button data-action="editor-role-remove" data-index="${String(index)}">Remove</button></div><div class="form-grid"><label class="field"><span>Name</span><input data-editor-role="${String(index)}" data-field="name" value="${escapeAttribute(role.name)}"></label><label class="field"><span>Model</span><input data-editor-role="${String(index)}" data-field="model" value="${escapeAttribute(role.model ?? "")}" placeholder="agent or provider default"></label><label class="field span-all"><span>Instructions</span><textarea data-editor-role="${String(index)}" data-field="instructions">${escapeHtml(role.instructions)}</textarea></label></div>${editorAdvancedHtml([role.managed ? "managed" : "", role.readOnly ? "read only" : "", (role.allowedPaths?.length ?? 0) > 0 ? "scoped paths" : ""].filter(Boolean), `<div class="form-grid"><label class="field span-all"><span>Required capabilities, comma-separated</span><input data-editor-role="${String(index)}" data-field="requiredCapabilities" value="${escapeAttribute(listText(role.requiredCapabilities, ", "))}"></label><label class="field span-all"><span>Preferred adapters, comma-separated</span><input data-editor-role="${String(index)}" data-field="preferredAdapters" value="${escapeAttribute(listText(role.preferredAdapters, ", "))}"></label><label class="field span-all"><span>Candidate agents, comma-separated</span><input data-editor-role="${String(index)}" data-field="candidateAgentIds" value="${escapeAttribute(listText(role.candidateAgentIds, ", "))}"></label><label class="field"><span>Resource ID</span><input data-editor-role="${String(index)}" data-field="resourceId" value="${escapeAttribute(role.resourceId ?? "")}"></label><label class="field"><span>Managed role</span><select data-editor-role="${String(index)}" data-field="managedRole"><option value="" ${role.managedRole ? "" : "selected"}>None</option><option value="worker" ${role.managedRole === "worker" ? "selected" : ""}>Worker</option><option value="lead" ${role.managedRole === "lead" ? "selected" : ""}>Lead</option></select></label><label class="check-field"><input type="checkbox" data-editor-role="${String(index)}" data-field="readOnly" ${role.readOnly === true ? "checked" : ""}> Read only</label><label class="check-field"><input type="checkbox" data-editor-role="${String(index)}" data-field="managed" ${role.managed === true ? "checked" : ""}> Managed</label><label class="check-field"><input type="checkbox" data-editor-role="${String(index)}" data-field="managedOptional" ${role.managedOptional === true ? "checked" : ""}> Managed optional</label><label class="field"><span>Commit mode</span><select data-editor-role="${String(index)}" data-field="commitMode"><option value="" ${role.commitMode ? "" : "selected"}>Pipeline default</option><option value="never" ${role.commitMode === "never" ? "selected" : ""}>Never</option><option value="allow" ${role.commitMode === "allow" ? "selected" : ""}>Allow</option></select></label><label class="field span-all"><span>Read paths, one per line; empty means the workspace</span><textarea ${codeSurfaceAttributes} data-editor-role="${String(index)}" data-field="readPaths">${escapeHtml(listText(role.readPaths, "\n"))}</textarea></label><label class="field span-all"><span>Writable paths, one per line</span><textarea ${codeSurfaceAttributes} data-editor-role="${String(index)}" data-field="allowedPaths">${escapeHtml(listText(role.allowedPaths, "\n"))}</textarea></label><label class="field span-all"><span>Protected paths, one per line</span><textarea ${codeSurfaceAttributes} data-editor-role="${String(index)}" data-field="protectedPaths">${escapeHtml(listText(role.protectedPaths, "\n"))}</textarea></label><label class="field span-all"><span>Verification checks, one id = command per line</span><textarea ${codeSurfaceAttributes} data-editor-role="${String(index)}" data-field="verificationChecks">${escapeHtml(verificationChecksText(role.verificationChecks))}</textarea></label></div>`)}</div></details>`;

const participantChoices = (): Array<{ id: string; label: string }> => {
  const pipeline = state.editorDraft;
  if (!pipeline) {
    return [];
  }
  return [
    ...pipeline.agents.map((agent) => ({ id: agent.id, label: `${agent.name} · agent` })),
    ...(pipeline.roles ?? []).map((role) => ({ id: role.id, label: `${role.name} · role` })),
  ];
};

const participantOptionsHtml = (selected: string[]): string => {
  const chosen = Array.isArray(selected) ? selected : [];
  return participantChoices().map((choice) => `<option value="${escapeAttribute(choice.id)}" ${chosen.includes(choice.id) ? "selected" : ""}>${escapeHtml(choice.label)}</option>`).join("");
};

const participantChecksHtml = (index: number, selected: string[]): string => {
  const chosen = Array.isArray(selected) ? selected : [];
  const choices = participantChoices();
  if (choices.length === 0) {
    return `<p class="muted">This pipeline has no agents or roles yet.</p>`;
  }
  return `<div class="form-grid">${choices.map((choice) => `<label class="check-field"><input type="checkbox" data-editor-step="${String(index)}" data-field="participants" value="${escapeAttribute(choice.id)}" ${chosen.includes(choice.id) ? "checked" : ""}> ${escapeHtml(choice.label)}</label>`).join("")}</div>`;
};

const toggleParticipant = (current: string[], id: string, include: boolean): string[] => {
  if (!include) return current.filter((participant) => participant !== id);
  if (current.includes(id)) return current;
  const order = participantChoices().map((choice) => choice.id);
  const position = order.indexOf(id);
  const at = current.findIndex((participant) => order.indexOf(participant) > position);
  return at === -1 ? [...current, id] : [...current.slice(0, at), id, ...current.slice(at)];
};

const stepTypeLabel = (type: string): string => {
  const labels: Record<string, string> = {
    agent: "Agent turn",
    assignRoles: "Assign roles",
    checklist: "Prepare checklist",
    executeChecklist: "Execute checklist",
  };
  return labels[type] ?? `Unsupported type: ${type}`;
};

const humanGateLabel = (mode: string): string => {
  const labels: Record<string, string> = {
    none: "No gate",
    before: "Ask before the step",
    after: "Ask after the step",
    both: "Ask before and after",
  };
  return labels[mode] ?? mode;
};

const participantNames = (ids: string[]): string => {
  const pipeline = state.editorDraft;
  const named = (Array.isArray(ids) ? ids : []).map((id) => {
    const agent = pipeline?.agents.find((candidate) => candidate.id === id);
    if (agent) {
      return agent.name;
    }
    const role = pipeline?.roles?.find((candidate) => candidate.id === id);
    return role ? role.name : id;
  });
  return named.join(", ");
};

const stepSummaryDetail = (step: PipelineStep): string => {
  const parts = [stepTypeLabel(step.type)];
  if (step.type === "agent" || step.type === "checklist") {
    const names = participantNames(step.participants ?? []);
    if (names) {
      parts.push(names);
    }
  }
  if (step.humanGate && step.humanGate !== "none") {
    parts.push(humanGateLabel(step.humanGate).toLowerCase());
  }
  if (!step.enabled) {
    parts.push("disabled");
  }
  return parts.join(" · ");
};

const editorSectionHtml = (
  key: string,
  icon: string,
  title: string,
  summary: string,
  action: string,
  body: string,
): string =>
  `<details class="editor-section" data-editor-section="${escapeAttribute(key)}" ${state.collapsedEditorSections.has(key) ? "" : "open"}><summary class="editor-section-heading"><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i><h3><i class="codicon codicon-${icon}" aria-hidden="true"></i> ${escapeHtml(title)}</h3><small>${escapeHtml(summary)}</small></summary><div class="editor-section-body"><div class="editor-section-actions">${action}</div>${body}</div></details>`;

const editorAdvancedHtml = (markers: string[], body: string): string =>
  body.trim().length === 0
    ? ""
    : activePanel().advancedMode
      ? `<details class="editor-advanced"><summary><i class="codicon codicon-chevron-right disclosure-chevron" aria-hidden="true"></i><span>Advanced</span>${markers.length > 0 ? `<small>${escapeHtml(markers.join(" · "))}</small>` : ""}</summary><div class="editor-advanced-body">${body}</div></details>`
      : `<div class="editor-advanced-locked"><span>Advanced settings are hidden.${markers.length > 0 ? ` This step uses: ${escapeHtml(markers.join(" · "))}.` : ""}</span><button data-action="advanced-mode-open">Turn on advanced mode</button></div>`;

const stepAdvancedMarkers = (step: PipelineStep): string[] => {
  const markers: string[] = [];
  if (step.type === "agent") {
    if (step.parallel) {
      markers.push("parallel");
    }
    if (step.consensus) {
      markers.push("consensus");
    }
    if (step.output) {
      markers.push("typed output");
    }
  }
  if ((step.type === "agent" || step.type === "checklist") && step.attachments === "selected") {
    markers.push("attachments");
  }
  if ((step.type === "agent" || step.type === "checklist") && (step.permissionModes || step.approvalPolicies)) {
    markers.push("permissions");
  }
  if (step.type === "executeChecklist" && (step.retries !== undefined || step.maxConcurrency !== undefined)) {
    markers.push("task limits");
  }
  return markers;
};

const editorStepHtml = (step: PipelineStep, index: number): string => {
  const humanGateValues = step.type === "executeChecklist" ? ["none", "before"] : ["none", "before", "after", "both"];
  const common = `<div class="form-grid"><label class="field"><span>Name</span><input data-editor-step="${String(index)}" data-field="name" value="${escapeAttribute(step.name)}"></label><label class="check-field"><input type="checkbox" data-editor-step="${String(index)}" data-field="enabled" ${step.enabled ? "checked" : ""}> Step enabled</label><label class="field"><span>Type</span><select data-editor-step="${String(index)}" data-field="type">${["agent", "assignRoles", "checklist", "executeChecklist"].includes(step.type) ? "" : `<option value="${escapeAttribute(step.type)}" selected>${escapeHtml(stepTypeLabel(step.type))}</option>`}<option value="agent" ${step.type === "agent" ? "selected" : ""}>Agent turn</option><option value="assignRoles" ${step.type === "assignRoles" ? "selected" : ""}>Assign roles</option><option value="checklist" ${step.type === "checklist" ? "selected" : ""}>Prepare checklist</option><option value="executeChecklist" ${step.type === "executeChecklist" ? "selected" : ""}>Execute checklist</option></select></label><label class="field"><span>Human gate</span><select data-editor-step="${String(index)}" data-field="humanGate">${humanGateValues.map((value) => `<option value="${value}" ${step.humanGate === value ? "selected" : ""}>${escapeHtml(humanGateLabel(value))}</option>`).join("")}</select></label></div>`;
  let specific: string;
  if (step.type === "agent") {
    const consensus = step.consensusConfig;
    const consensusFields = step.consensus ? `<fieldset class="editor-subsection"><legend>Consensus</legend><p class="editor-subsection-note">Participants repeat the step until they agree. The field names below are the keys Bachata reads from each participant's structured answer.</p><div class="form-grid"><label class="field"><span>Mode</span><select data-editor-step="${String(index)}" data-field="consensusMode"><option value="unanimous" ${consensus?.mode !== "arbiter" ? "selected" : ""}>Unanimous</option><option value="arbiter" ${consensus?.mode === "arbiter" ? "selected" : ""}>Arbiter rules</option></select></label><label class="field"><span>Maximum rounds</span><input type="number" min="1" data-editor-step="${String(index)}" data-field="consensusMaxRounds" value="${String(consensus?.maxRounds ?? 10)}"></label>${consensus?.mode === "arbiter" ? `<label class="field"><span>Arbiter participant</span><select data-editor-step="${String(index)}" data-field="consensusArbiter"><option value="">Select participant</option>${step.participants.map((participant) => `<option value="${escapeAttribute(participant)}" ${consensus.arbiter === participant ? "selected" : ""}>${escapeHtml(participantNames([participant]))}</option>`).join("")}</select></label>` : ""}<label class="field"><span>At maximum rounds</span><select data-editor-step="${String(index)}" data-field="consensusOnMaxRounds"><option value="humanGate" ${consensus?.onMaxRounds === undefined || consensus.onMaxRounds === "humanGate" ? "selected" : ""}>Ask user</option><option value="fail" ${consensus?.onMaxRounds === "fail" ? "selected" : ""}>Fail</option>${consensus?.mode === "arbiter" ? `<option value="requestArbiterRuling" ${consensus.onMaxRounds === "requestArbiterRuling" ? "selected" : ""}>Request arbiter ruling</option>` : ""}</select></label><label class="field"><span>Candidate field</span><input data-editor-step="${String(index)}" data-field="consensusCandidateField" value="${escapeAttribute(consensus?.candidateField ?? "")}" placeholder="answer"></label><label class="field"><span>Accepted field</span><input data-editor-step="${String(index)}" data-field="consensusAcceptedField" value="${escapeAttribute(consensus?.acceptedField ?? "")}" placeholder="accepted"></label><label class="field"><span>Objections field</span><input data-editor-step="${String(index)}" data-field="consensusObjectionsField" value="${escapeAttribute(consensus?.objectionsField ?? "")}" placeholder="objections"></label><label class="field"><span>Risks field</span><input data-editor-step="${String(index)}" data-field="consensusRisksField" value="${escapeAttribute(consensus?.risksField ?? "")}" placeholder="unresolvedRisks"></label><label class="field"><span>Accepted value</span><select data-editor-step="${String(index)}" data-field="consensusAcceptedValue"><option value="true" ${consensus?.acceptedValue !== false ? "selected" : ""}>true</option><option value="false" ${consensus?.acceptedValue === false ? "selected" : ""}>false</option></select></label><label class="field"><span>Round result format</span><select data-editor-step="${String(index)}" data-field="consensusResultFormat"><option value="" ${consensus?.resultFormat ? "" : "selected"}>None</option><option value="json" ${consensus?.resultFormat === "json" ? "selected" : ""}>JSON</option></select></label>${consensus?.resultFormat === "json" ? `<label class="field"><span>Round result field</span><input data-editor-step="${String(index)}" data-field="consensusResultField" value="${escapeAttribute(consensus.resultField ?? "")}"></label>` : ""}</div></fieldset>` : "";
    const output = step.output;
    const outputFields = `<fieldset class="editor-subsection"><legend>Typed output</legend><label class="check-field"><input type="checkbox" data-editor-step="${String(index)}" data-field="outputEnabled" ${output ? "checked" : ""}> Validate a JSON output artifact</label>${output ? `<div class="form-grid"><label class="field"><span>Output name</span><input data-editor-step="${String(index)}" data-field="outputName" value="${escapeAttribute(output.name)}"></label><label class="field span-all"><span>JSON Schema</span><textarea class="schema-editor" ${codeSurfaceAttributes} data-editor-step="${String(index)}" data-field="outputSchema">${escapeHtml(state.editorOutputSchemas.get(step.id) ?? safeJson(output.schema))}</textarea></label></div>` : ""}</fieldset>`;
    specific = `<div class="form-grid"><fieldset class="editor-subsection span-all"><legend>Participants or roles</legend>${participantChecksHtml(index, step.participants)}</fieldset><label class="field span-all"><span>Prompt template</span><textarea rows="6" data-editor-step="${String(index)}" data-field="promptTemplate">${escapeHtml(step.promptTemplate ?? "")}</textarea></label></div>${editorAdvancedHtml(stepAdvancedMarkers(step), `<div class="form-grid"><label class="field"><span>Attachments</span><select data-editor-step="${String(index)}" data-field="attachments"><option value="none" ${step.attachments === "selected" ? "" : "selected"}>No attachments</option><option value="selected" ${step.attachments === "selected" ? "selected" : ""}>Attachments picked in the composer</option></select></label><label class="check-field"><input type="checkbox" data-editor-step="${String(index)}" data-field="parallel" ${step.parallel ? "checked" : ""}> Run participants in parallel</label><label class="check-field"><input type="checkbox" data-editor-step="${String(index)}" data-field="consensus" ${step.consensus ? "checked" : ""}> Require consensus</label><label class="field span-all"><span>Required capabilities, comma-separated</span><input placeholder="implement, review" data-editor-step="${String(index)}" data-field="requiredCapabilities" value="${escapeAttribute(listText(step.requiredCapabilities, ", "))}"></label><label class="field span-all"><span>Permission modes as participant=mode, comma-separated</span><input placeholder="lead=workspaceWrite, worker=plan" data-editor-step="${String(index)}" data-field="permissionModes" value="${escapeAttribute(assignmentText(step.permissionModes))}"></label><label class="field span-all"><span>Approval policies as participant=policy, comma-separated</span><input placeholder="lead=onRequest, worker=unlessTrusted" data-editor-step="${String(index)}" data-field="approvalPolicies" value="${escapeAttribute(assignmentText(step.approvalPolicies))}"></label></div>${consensusFields}${outputFields}`)}`;
  } else if (step.type === "checklist") {
    specific = `<div class="form-grid"><label class="field span-two"><span>Summarizer participant or role</span><select data-editor-step="${String(index)}" data-field="participants"><option value="">Select summarizer</option>${participantOptionsHtml(step.participants)}</select></label><label class="field"><span>Output name</span><input data-editor-step="${String(index)}" data-field="outputName" value="${escapeAttribute(step.outputName)}"></label><label class="field span-all"><span>Prompt template</span><textarea rows="6" data-editor-step="${String(index)}" data-field="promptTemplate">${escapeHtml(step.promptTemplate ?? "")}</textarea></label></div>${editorAdvancedHtml(stepAdvancedMarkers(step), `<div class="form-grid"><label class="field"><span>Timeout, ms</span><input type="number" min="1000" data-editor-step="${String(index)}" data-field="timeoutMs" value="${String(step.timeoutMs ?? "")}"></label><label class="field"><span>Attachments</span><select data-editor-step="${String(index)}" data-field="attachments"><option value="none" ${step.attachments === "selected" ? "" : "selected"}>No attachments</option><option value="selected" ${step.attachments === "selected" ? "selected" : ""}>Attachments picked in the composer</option></select></label><label class="field span-all"><span>Required capabilities, comma-separated</span><input placeholder="implement, review" data-editor-step="${String(index)}" data-field="requiredCapabilities" value="${escapeAttribute(listText(step.requiredCapabilities, ", "))}"></label><label class="field span-all"><span>Permission modes as participant=mode, comma-separated</span><input placeholder="lead=workspaceWrite, worker=plan" data-editor-step="${String(index)}" data-field="permissionModes" value="${escapeAttribute(assignmentText(step.permissionModes))}"></label><label class="field span-all"><span>Approval policies as participant=policy, comma-separated</span><input placeholder="lead=onRequest, worker=unlessTrusted" data-editor-step="${String(index)}" data-field="approvalPolicies" value="${escapeAttribute(assignmentText(step.approvalPolicies))}"></label></div>`)}`;
  } else if (step.type === "executeChecklist") {
    const currentPipelineId = state.editorDraft?.id;
    const taskPipelines = editorPanel().pipelines.filter(
      (pipeline) => pipeline.id !== currentPipelineId,
    );
    const selectedPipelineAvailable = taskPipelines.some(
      (pipeline) => pipeline.id === step.pipelineId,
    );
    const pipelineOptions = [
      ...(selectedPipelineAvailable || !step.pipelineId
        ? []
        : [`<option value="${escapeAttribute(step.pipelineId)}" selected disabled>Unavailable · ${escapeHtml(step.pipelineId)}</option>`]),
      ...taskPipelines.map((pipeline) => {
        const scope = pipelineScopeLabel(pipeline.scopeKey, pipeline.scopeRoot);
        const label = `${pipeline.name} · ${pipeline.id} · ${scope}`;
        return `<option value="${escapeAttribute(pipeline.id)}" title="${escapeAttribute(`Revision ${pipeline.hash.slice(0, 8)}`)}" ${pipeline.id === step.pipelineId ? "selected" : ""}>${escapeHtml(label)}</option>`;
      }),
    ].join("");
    specific = `<div class="form-grid"><label class="field"><span>Checklist output name</span><input data-editor-step="${String(index)}" data-field="inputName" value="${escapeAttribute(step.inputName)}"></label><label class="field"><span>Task pipeline</span><select data-editor-step="${String(index)}" data-field="pipelineId"><option value="">Select pipeline</option>${pipelineOptions}</select></label><label class="field span-all"><span>Final checks, one controller-owned command per line</span><textarea ${codeSurfaceAttributes} data-editor-step="${String(index)}" data-field="checks">${escapeHtml(listText(step.checks, "\n"))}</textarea></label></div>${editorAdvancedHtml(stepAdvancedMarkers(step), `<div class="form-grid"><label class="field"><span>Retries per task</span><input type="number" min="0" max="10" data-editor-step="${String(index)}" data-field="retries" value="${String(step.retries ?? "")}"></label><label class="field"><span>Maximum parallel pairs</span><input type="number" min="1" max="20" data-editor-step="${String(index)}" data-field="maxConcurrency" value="${String(step.maxConcurrency ?? "")}"></label><label class="field span-all"><span>Maximum allowed paths, one repository-relative path per line</span><textarea ${codeSurfaceAttributes} data-editor-step="${String(index)}" data-field="allowedPaths">${escapeHtml(listText(step.allowedPaths, "\n"))}</textarea></label><label class="field span-all"><span>Protected resources, one name per line; prefix machine-wide resources with global:</span><textarea ${codeSurfaceAttributes} data-editor-step="${String(index)}" data-field="checkResources">${escapeHtml(listText(step.checkResources, "\n"))}</textarea></label><label class="check-field span-all"><input type="checkbox" data-editor-step="${String(index)}" data-field="allowNoChecks" ${step.allowNoChecks === true ? "checked" : ""}> Explicitly allow execution without checks</label></div>`)}`;
  } else if (step.type === "assignRoles") {
    const roles = state.editorDraft?.roles ?? [];
    const agents = state.editorDraft?.agents ?? [];
    const assignments = (Array.isArray(step.roleAssignments) ? step.roleAssignments : []).map((assignment, assignmentIndex) => `<div class="role-assignment-row"><label class="field"><span>Role</span><select id="assignment-${String(index)}-${String(assignmentIndex)}-role" data-editor-step="${String(index)}" data-editor-assignment="${String(assignmentIndex)}" data-field="role"><option value="">Select role</option>${roles.map((role) => `<option value="${escapeAttribute(role.id)}" ${assignment.role === role.id ? "selected" : ""}>${escapeHtml(role.name)} · ${escapeHtml(role.id)}</option>`).join("")}</select></label><label class="field"><span>Agent</span><select id="assignment-${String(index)}-${String(assignmentIndex)}-agent" data-editor-step="${String(index)}" data-editor-assignment="${String(assignmentIndex)}" data-field="agentId"><option value="">Select agent</option>${agents.map((agent) => `<option value="${escapeAttribute(agent.id)}" ${assignment.agentId === agent.id ? "selected" : ""}>${escapeHtml(agent.name)} · ${escapeHtml(agent.id)}</option>`).join("")}</select></label><button data-action="editor-assignment-remove" data-step-index="${String(index)}" data-assignment-index="${String(assignmentIndex)}">Remove</button></div>`).join("");
    specific = `<fieldset class="editor-subsection"><legend>Role assignments</legend>${assignments || `<p class="muted">No role assignments.</p>`}<button data-action="editor-assignment-add" data-step-index="${String(index)}" ${roles.length === 0 || agents.length === 0 ? "disabled" : ""}>Add assignment</button></fieldset>${editorAdvancedHtml([], "")}`;
  } else {
    const unsupported: PipelineStep = step;
    specific = `<div class="editor-unsupported-step"><p>This step type is not supported by the structured editor. Switch to JSON to change it, or pick a supported type above.</p>${codeBlockHtml(safeJson(unsupported), "json")}</div>${editorAdvancedHtml([], "")}`;
  }
  const unboundRoles = (step.type === "agent" || step.type === "checklist")
    ? (Array.isArray(step.participants) ? step.participants : []).filter((participant) =>
      (state.editorDraft?.roles ?? []).some((role) => role.id === participant) && roleBinding(participant).unbound,
    )
    : [];
  const roleWarning = unboundRoles.length > 0
    ? `<p class="editor-step-warning">${escapeHtml(unboundRoles.map((id) => participantNames([id])).join(", "))} ${unboundRoles.length === 1 ? "is a role with no agent" : "are roles with no agent"}. Add an “Assign roles” step before this one, or pick an agent instead.</p>`
    : "";
  return `<details class="editor-card ${step.enabled ? "" : "step-disabled"}" data-drag-kind="step" data-index="${String(index)}" data-editor-card-key="${escapeAttribute(editorCardKey("step", step.id))}" ${editorCardOpen("step", step.id)}><summary class="editor-card-summary"><span class="drag-handle" draggable="true" data-drag-handle="step" data-index="${String(index)}" aria-hidden="true">⋮⋮</span><strong>Step ${String(index + 1)} · ${escapeHtml(step.name)}</strong><small>${escapeHtml(stepSummaryDetail(step))}</small></summary><div class="editor-card-body">${roleWarning}<div class="compact-actions editor-card-actions"><button data-action="editor-step-duplicate" data-index="${String(index)}">Duplicate</button><button data-action="editor-step-up" data-index="${String(index)}" ${reorderAttributes("step", index, step.name, "up")} ${index === 0 ? "disabled" : ""}>↑</button><button data-action="editor-step-down" data-index="${String(index)}" ${reorderAttributes("step", index, step.name, "down")} ${index === (state.editorDraft?.steps.length ?? 0) - 1 ? "disabled" : ""}>↓</button><button data-action="editor-step-remove" data-index="${String(index)}">Remove</button></div>${common}${specific}</div></details>`;
};

const guardrailDetails = (
  key: string,
  icon: string,
  label: string,
  stateText: string,
  body: string,
): string =>
  `<details class="guardrail" data-guardrail="${key}"><summary><i class="codicon codicon-${icon}" aria-hidden="true"></i><span class="guardrail-label">${escapeHtml(label)}</span><span class="guardrail-state">${escapeHtml(stateText)}</span><i class="codicon codicon-chevron-right guardrail-chevron" aria-hidden="true"></i></summary><div class="guardrail-body"><div class="form-grid">${body}</div></div></details>`;

/**
 * S7. What a pending catalogue operation is doing, in words.
 *
 * It used to read as a lowercase fragment of the protocol message ("save…"), and while it was
 * pending every control including Close was refused, so an operation the host never answered
 * left the editor stuck for the session. Close now abandons it; see closePipelineEditor.
 */
let editorOperationStartedAt = 0;
const EDITOR_OPERATION_STALL_MS = 10_000;

/**
 * Whether the host has gone quiet on the operation the editor is waiting for.
 *
 * Refusing to dismiss a pending operation is deliberate: a save in flight must not be thrown
 * away by a stray Escape, and `webviewDom` pins that. What was missing is the other end — an
 * operation the host never answers used to seal the editor for the rest of the session. The way
 * out appears only once the wait is plainly abnormal, so the ordinary refusal is untouched.
 *
 * Read from the clock rather than a timer, so nothing has to be cancelled on the many paths
 * that clear the operation, and so the panel keeps exactly one interval.
 */
const editorOperationStalled = (): boolean =>
  state.pendingEditorOperation !== undefined &&
  editorOperationStartedAt > 0 &&
  Date.now() - editorOperationStartedAt >= EDITOR_OPERATION_STALL_MS;

const editorOperationProgressLabel = (operation: PendingEditorOperation["operation"]): string => {
  const labels: Record<PendingEditorOperation["operation"], string> = {
    "pipeline.validate": "Checking…",
    "pipeline.save": "Saving…",
    "pipeline.delete": "Deleting…",
    "pipeline.import": "Importing…",
    "pipeline.fork": "Forking…",
    "pipeline.export": "Exporting…",
  };
  return labels[operation] ?? "Working…";
};

const pipelineEditorHtml = (): string => {
  if (!state.editorOpen || !state.editorDraft) {
    return "";
  }
  const panel = editorPanel();
  const targetConversation = conversationById(editorTargetId());
  const pipeline = state.editorDraft;
  const busy = state.pendingEditorOperation !== undefined;
  const idLocked = state.editorSourcePipelineId !== undefined;
  const policy = pipeline.managedPolicy ?? {};
  const readCount = (policy.readPaths ?? []).length;
  const writeCount = (policy.allowedPaths ?? []).length;
  const protectedCount = (policy.protectedPaths ?? []).length;
  const checksTextValue = verificationChecksText(policy.verificationChecks);
  const checkCount = checksTextValue.trim() === "" ? 0 : checksTextValue.trim().split("\n").length;
  const commitState =
    policy.commitMode === "never"
      ? "Never"
      : policy.commitMode === "allow"
        ? "Allowed"
        : "Pipeline default";
  const revisionState =
    policy.maxRevisionCycles === undefined
      ? ""
      : ` · up to ${String(policy.maxRevisionCycles)} revision ${policy.maxRevisionCycles === 1 ? "cycle" : "cycles"}`;
  const guardrailSummary = [
    writeCount === 0 ? "review only" : `${String(writeCount)} writable ${writeCount === 1 ? "path" : "paths"}`,
    protectedCount > 0 ? `${String(protectedCount)} protected` : "",
    commitState === "Never" ? "no commits" : commitState === "Allowed" ? "commits allowed" : "",
    checkCount > 0 ? `${String(checkCount)} ${checkCount === 1 ? "check" : "checks"}` : "no checks",
  ].filter(Boolean).join(" · ");
  const guardrailBody =
    guardrailDetails(
      "reads",
      "eye",
      "Can read",
      readCount === 0 ? "Whole workspace" : `${String(readCount)} scoped ${readCount === 1 ? "path" : "paths"}`,
      `<label class="field span-all"><span>Read paths, one per line; empty means the workspace</span><textarea ${codeSurfaceAttributes} data-editor-policy="readPaths">${escapeHtml(listText(policy.readPaths, "\n"))}</textarea></label>`,
    ) +
    guardrailDetails(
      "writes",
      "edit",
      "Can change",
      writeCount === 0 ? "Nothing — review only" : `${String(writeCount)} scoped ${writeCount === 1 ? "path" : "paths"}`,
      `<label class="field span-all"><span>Writable paths, one per line</span><textarea ${codeSurfaceAttributes} data-editor-policy="allowedPaths">${escapeHtml(listText(policy.allowedPaths, "\n"))}</textarea></label>`,
    ) +
    guardrailDetails(
      "protected",
      "lock",
      "Never touches",
      protectedCount === 0 ? "No extra protected paths" : `${String(protectedCount)} protected ${protectedCount === 1 ? "path" : "paths"}`,
      `<label class="field span-all"><span>Protected paths, one per line</span><textarea ${codeSurfaceAttributes} data-editor-policy="protectedPaths">${escapeHtml(listText(policy.protectedPaths, "\n"))}</textarea></label>`,
    ) +
    guardrailDetails(
      "commits",
      "git-commit",
      "Commits",
      `${commitState}${revisionState}`,
      `<label class="field"><span>Commit mode</span><select data-editor-policy="commitMode"><option value="" ${policy.commitMode ? "" : "selected"}>Default</option><option value="never" ${policy.commitMode === "never" ? "selected" : ""}>Never</option><option value="allow" ${policy.commitMode === "allow" ? "selected" : ""}>Allow</option></select></label><label class="field"><span>Maximum revision cycles</span><input type="number" min="0" max="2" data-editor-policy="maxRevisionCycles" value="${policy.maxRevisionCycles === undefined ? "" : String(policy.maxRevisionCycles)}"></label>`,
    ) +
    guardrailDetails(
      "checks",
      "check",
      "Runs checks",
      checkCount === 0 ? "None configured" : `${String(checkCount)} ${checkCount === 1 ? "command" : "commands"}`,
      `<label class="field span-all"><span>Verification checks, one id = command per line</span><textarea ${codeSurfaceAttributes} data-editor-policy="verificationChecks">${escapeHtml(checksTextValue)}</textarea></label>`,
    );
  const guardrails = editorSectionHtml("guardrails", "shield", "Guardrails", guardrailSummary, "", guardrailBody);
  const formHtml = (): string => `<div class="editor-scroll"><fieldset class="editor-control-group" ${busy ? "disabled" : ""}>${editorSectionHtml(
    "steps",
    "list-ordered",
    "Steps",
    pipeline.steps.length === 1 ? "1 step" : `${String(pipeline.steps.length)} steps`,
    `<button data-action="editor-step-add" ${busy ? "disabled" : ""}>Add step</button>`,
    `${pipeline.steps.length > 1 ? `<ol class="step-flow" aria-label="Step order">${pipeline.steps.map((step, stepIndex) => `<li><button class="step-flow-item ${step.enabled ? "" : "step-flow-disabled"}" data-action="editor-step-focus" data-index="${String(stepIndex)}" title="${escapeAttribute(stepSummaryDetail(step))}">${escapeHtml(step.name)}${step.humanGate && step.humanGate !== "none" ? `<i class="codicon codicon-person" aria-hidden="true"></i><span class="sr-only">${escapeHtml(humanGateLabel(step.humanGate))}</span>` : ""}</button></li>`).join("")}</ol>` : ""}${pipeline.steps.map(editorStepHtml).join("")}`,
  )}${editorSectionHtml(
    "details",
    "info",
    "Pipeline details",
    pipeline.description ? pipeline.description : "Name and description",
    "",
    `<div class="form-grid pipeline-meta"><label class="field span-all"><span>Name</span><input data-editor-meta="name" value="${escapeAttribute(pipeline.name)}" ${busy ? "disabled" : ""}><small>ID ${escapeHtml(pipeline.id)} · assigned automatically. Change it in JSON if you need an exact value.<input type="hidden" data-editor-meta="id" value="${escapeAttribute(pipeline.id)}" ${idLocked ? "disabled" : ""}></small></label><label class="field span-all"><span>Description</span><textarea data-editor-meta="description" ${busy ? "disabled" : ""} placeholder="What this pipeline is for">${escapeHtml(pipeline.description ?? "")}</textarea></label></div>`,
  )}${guardrails}${editorSectionHtml(
    "agents",
    "person",
    "Agents",
    pipeline.agents.map((agent) => agent.name).join(", ") || "None yet",
    `<button data-action="editor-agent-add" ${busy ? "disabled" : ""}>Add agent</button>`,
    pipeline.agents.map((agent, index) => editorAgentHtml(agent, index, panel)).join(""),
  )}${editorSectionHtml(
    "roles",
    "organization",
    "Roles",
    (pipeline.roles ?? []).length === 0
      ? "Not used — steps address agents directly"
      : (pipeline.roles ?? []).map((role) => `${role.name} — ${roleBinding(role.id).text.replace("No agent assigned — add an “Assign roles” step", "no agent")}`).join(" · "),
    `<button data-action="editor-role-add" ${busy ? "disabled" : ""}>Add role</button>`,
    (pipeline.roles ?? []).length === 0
      ? `<p class="editor-section-note">Roles let a step ask for a capability instead of naming an agent. Bachata then picks the agent that fits. Most pipelines do not need them.</p>`
      : (pipeline.roles ?? []).map(editorRoleHtml).join(""),
  )}</fieldset></div>`;
  const raw = `<div class="editor-scroll"><label class="field raw-editor"><span>Pipeline JSON</span><textarea id="pipeline-raw" ${codeSurfaceAttributes} ${busy ? "disabled" : ""}>${escapeHtml(state.editorRaw)}</textarea></label></div>`;
  const sourceSummary = state.editorSourcePipelineId
    ? panel.pipelines.find((item) => item.id === state.editorSourcePipelineId)
    : undefined;
  const errors = state.editorErrors.length > 0 ? `<div class="editor-errors" id="editor-errors" ${liveRegionAttributes("editor-errors", "alert", state.editorErrors.join("; "))}><strong>Pipeline needs attention</strong>${state.editorErrors.map((error) => `<p>${escapeHtml(error)}</p>`).join("")}</div>` : "";
  // Save refuses a pipeline that does not parse, so it says so the way the composer's Send does:
  // reachable, marked aria-disabled, pointing at the errors already on screen. Without this it
  // looked actionable and the click was a silent no-op.
  const saveBlocked = state.editorErrors.length > 0 && !busy && panel.pipelineMutable;
  const saveRefusal = saveBlocked ? ` aria-disabled="true" aria-describedby="editor-errors"` : "";
  const mutation = panel.pipelineMutationReason ? `<p class="editor-mutation-note">${escapeHtml(panel.pipelineMutationReason)}</p>` : "";
  const stalled = editorOperationStalled();
  const progress = state.pendingEditorOperation
    ? `<span class="editor-progress${stalled ? " editor-stalled" : ""}" role="status">${escapeHtml(stalled ? `${editorOperationProgressLabel(state.pendingEditorOperation.operation)} no reply yet. Cancel abandons it.` : editorOperationProgressLabel(state.pendingEditorOperation.operation))}</span>`
    : "";
  return `<div class="modal-backdrop"><section class="pipeline-editor" role="dialog" aria-modal="true" aria-labelledby="pipeline-editor-title"><header><div><h2 id="pipeline-editor-title" tabindex="-1">${escapeHtml(pipeline.name || "Pipeline editor")}</h2><p>${pipeline.steps.length === 1 ? "1 step" : `${String(pipeline.steps.length)} steps`} · ${pipeline.agents.length === 1 ? "1 agent" : `${String(pipeline.agents.length)} agents`}${targetConversation ? ` · used by “${escapeHtml(targetConversation.title)}”` : ""}. Expand any item to change it. JSON stays available for exact definitions.</p></div><button data-action="pipeline-editor-close" aria-label="Close pipeline editor" ${busy && !stalled ? "disabled" : ""}>×</button></header><div class="editor-tabs" role="group" aria-label="Pipeline editor mode"><button data-action="editor-mode" data-mode="form" class="${state.editorMode === "form" ? "selected" : ""}" aria-pressed="${state.editorMode === "form" ? "true" : "false"}" ${busy ? "disabled" : ""}>Structured</button><button data-action="editor-mode" data-mode="json" class="${state.editorMode === "json" ? "selected" : ""}" aria-pressed="${state.editorMode === "json" ? "true" : "false"}" ${busy ? "disabled" : ""}>JSON</button></div>${mutation}${errors}${state.editorMode === "form" ? formHtml() : raw}<footer><div class="compact-actions"><button data-action="pipeline-import" ${busy || !panel.pipelineMutable ? "disabled" : ""}>Import</button><button data-action="pipeline-export" ${busy ? "disabled" : ""}>Export draft</button>${sourceSummary?.editable ? `<button class="danger" data-action="pipeline-delete" ${busy || !panel.pipelineMutable ? "disabled" : ""}>Delete ${escapeHtml(sourceSummary.name)}</button>` : ""}</div><div class="compact-actions">${progress}<button data-action="pipeline-editor-close" ${busy && !stalled ? "disabled" : ""}>Cancel</button><button class="primary" data-action="pipeline-save" ${busy || !panel.pipelineMutable ? "disabled" : ""}${saveRefusal}>Save and select</button></div></footer></section></div>`;
};

const updateEditorInput = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): void => {
  const pipeline = state.editorDraft;
  if (!pipeline) return;
  state.editorErrors = [];
  const meta = element.dataset.editorMeta;
  if (meta) {
    if (meta === "id") pipeline.id = element.value;
    if (meta === "name") {
      const previousName = pipeline.name;
      pipeline.name = element.value;
      if (
        !state.editorSourcePipelineId &&
        (generatedPipelineIdPattern.test(pipeline.id) || pipeline.id === slugId(previousName))
      ) {
        pipeline.id = slugId(pipeline.name);
      }
    }
    if (meta === "description") pipeline.description = element.value;
    syncEditorRaw();
    return;
  }
  const policyField = element.dataset.editorPolicy as keyof ManagedPipelinePolicy | undefined;
  if (policyField) {
  const policy = pipeline.managedPolicy ?? {};
    if (policyField === "readPaths" || policyField === "allowedPaths" || policyField === "protectedPaths") {
      const values = element.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      if (values.length > 0) policy[policyField] = values;
      else delete policy[policyField];
    } else if (policyField === "verificationChecks") {
      const checks = parseVerificationChecks(element.value);
      if (checks) policy.verificationChecks = checks;
      else delete policy.verificationChecks;
    } else if (policyField === "commitMode") {
      if (element.value === "never" || element.value === "allow") policy.commitMode = element.value;
      else delete policy.commitMode;
    } else if (policyField === "maxRevisionCycles") {
      const value = Number(element.value);
      if (Number.isSafeInteger(value) && value >= 0 && value <= 2) policy.maxRevisionCycles = value;
      else delete policy.maxRevisionCycles;
    }
    if (Object.keys(policy).length > 0) pipeline.managedPolicy = policy;
    else delete pipeline.managedPolicy;
    syncEditorRaw();
    return;
  }
  const agentIndex = element.dataset.editorAgent;
  if (agentIndex !== undefined) {
    const agent = pipeline.agents[Number(agentIndex)];
    const field = element.dataset.field as keyof AgentDefinition | undefined;
    if (agent && field) {
      if (field === "name") {
        const previousName = agent.name;
        agent.name = element.value;
        if (idFollowsName(agent.id, previousName)) {
          const previous = agent.id;
          const used = new Set(pipeline.agents.filter((item) => item !== agent).map((item) => item.id));
          const next = uniqueId(slugId(agent.name), used);
          if (next !== previous) {
            agent.id = next;
            moveEditorCardKey("agent", previous, next);
            replacePipelineReference(pipeline, previous, next, "agent");
          }
        }
      } else if (field === "adapter") {
        agent.adapter = element.value;
        if (browserAdapterTypes.has(agent.adapter)) {
          delete agent.model;
          delete agent.command;
          delete agent.permissionMode;
          delete agent.approvalPolicy;
        }
        scheduleRender();
      } else if (field === "capabilities") {
        const values = controlValues(element);
        if (values.length > 0) agent.capabilities = values;
        else delete agent.capabilities;
      } else if (field === "approvalPolicy") {
        if (element.value === "onRequest" || element.value === "unlessTrusted") agent.approvalPolicy = element.value;
        else delete agent.approvalPolicy;
      } else {
        setOptionalString(agent as unknown as Record<string, unknown>, field, element.value);
      }
      syncEditorRaw();
    }
    return;
  }
  const roleIndex = element.dataset.editorRole;
  if (roleIndex !== undefined) {
    const role = (pipeline.roles ?? [])[Number(roleIndex)];
    const field = element.dataset.field as keyof RoleDefinition | undefined;
    if (role && field) {
      if (field === "name" || field === "instructions") {
        const previousName = role.name;
        role[field] = element.value;
        if (field === "name" && idFollowsName(role.id, previousName)) {
          const previous = role.id;
          const used = new Set((pipeline.roles ?? []).filter((item) => item !== role).map((item) => item.id));
          const next = uniqueId(slugId(role.name), used);
          if (next !== previous) {
            role.id = next;
            moveEditorCardKey("role", previous, next);
            replacePipelineReference(pipeline, previous, next, "role");
          }
        }
      } else if (field === "model") {
        const value = element.value.trim();
        if (value.length > 0) role.model = value;
        else delete role.model;
      } else if (field === "requiredCapabilities" || field === "preferredAdapters" || field === "candidateAgentIds") {
        const values = controlValues(element);
        if (values.length > 0) role[field] = values;
        else delete role[field];
      } else if (field === "readPaths" || field === "allowedPaths" || field === "protectedPaths") {
        const values = element.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
        if (values.length > 0) role[field] = values;
        else delete role[field];
      } else if (field === "readOnly" || field === "managed" || field === "managedOptional") {
        if (element instanceof HTMLInputElement && element.checked) role[field] = true;
        else delete role[field];
      } else if (field === "managedRole") {
        if (element.value === "worker" || element.value === "lead") role.managedRole = element.value;
        else delete role.managedRole;
      } else if (field === "commitMode") {
        if (element.value === "never" || element.value === "allow") role.commitMode = element.value;
        else delete role.commitMode;
      } else if (field === "verificationChecks") {
        const checks = parseVerificationChecks(element.value);
        if (checks) role.verificationChecks = checks;
        else delete role.verificationChecks;
      } else if (field === "resourceId") {
        setOptionalString(role as unknown as Record<string, unknown>, field, element.value);
      }
      syncEditorRaw();
    }
    return;
  }
  const stepIndex = element.dataset.editorStep;
  if (stepIndex === undefined) return;
  const index = Number(stepIndex);
  const step = pipeline.steps[index];
  const field = element.dataset.field;
  if (!step || !field) return;
  const checked = element instanceof HTMLInputElement && element.type === "checkbox" ? element.checked : undefined;
  let rerender = false;
  if (field === "name") {
    const previousName = step.name;
    step.name = element.value;
    if (idFollowsName(step.id, previousName)) {
      const previous = step.id;
      const used = new Set(pipeline.steps.filter((item) => item !== step).map((item) => item.id));
      const next = uniqueId(slugId(step.name), used);
      if (next !== previous) {
        step.id = next;
        moveEditorCardKey("step", previous, next);
        const schema = state.editorOutputSchemas.get(previous);
        if (schema !== undefined) {
          state.editorOutputSchemas.delete(previous);
          state.editorOutputSchemas.set(next, schema);
        }
      }
    }
  }
  else if (field === "enabled") step.enabled = Boolean(checked);
  else if (field === "humanGate") step.humanGate = element.value as PipelineStep["humanGate"];
  else if (field === "type" && element.value !== step.type) {
    const commonHumanGate = step.humanGate === "after" || step.humanGate === "both" ? "none" : step.humanGate;
    state.editorOutputSchemas.delete(step.id);
    pipeline.steps[index] = element.value === "assignRoles"
      ? { id: step.id, name: step.name, enabled: step.enabled, humanGate: step.humanGate, type: "assignRoles", roleAssignments: [] }
      : element.value === "checklist"
        ? { id: step.id, name: step.name, enabled: step.enabled, humanGate: step.humanGate, type: "checklist", participants: pipeline.agents[0] ? [pipeline.agents[0].id] : [], promptTemplate: "Convert the accepted findings into strict execution issues.", outputName: "executionChecklist", attachments: "none" }
        : element.value === "executeChecklist"
          ? { id: step.id, name: step.name, enabled: step.enabled, humanGate: commonHumanGate, type: "executeChecklist", inputName: "executionChecklist", pipelineId: "todo-implementation", allowedPaths: [], checks: [], checkResources: [], allowNoChecks: false, retries: 1, maxConcurrency: 2 }
          : defaultAgentStep(index, pipeline.agents[0]?.id);
    pipeline.steps[index].id = step.id;
    pipeline.steps[index].name = step.name;
    pipeline.steps[index].enabled = step.enabled;
    pipeline.steps[index].humanGate = pipeline.steps[index].type === "executeChecklist" ? commonHumanGate : step.humanGate;
    rerender = true;
  } else if (step.type === "agent") {
    const consensus = (): ConsensusConfig => {
      if (!step.consensusConfig) {
        step.consensusConfig = { mode: "unanimous", maxRounds: 10, acceptedValue: true, onMaxRounds: "humanGate" };
      }
      return step.consensusConfig;
    };
    if (field === "participants" && element instanceof HTMLInputElement) {
      step.participants = toggleParticipant(step.participants, element.value, element.checked);
      const [firstParticipant] = step.participants;
      if (step.consensusConfig?.mode === "arbiter" && !step.participants.includes(step.consensusConfig.arbiter ?? "")) {
        setOptionalProperty(step.consensusConfig, "arbiter", firstParticipant);
      }
      rerender = true;
    }
    else if (field === "promptTemplate") step.promptTemplate = element.value;
    else if (field === "parallel") step.parallel = Boolean(checked);
    else if (field === "attachments") step.attachments = element.value as "none" | "selected";
    else if (field === "requiredCapabilities") {
      const values = controlValues(element);
      if (values.length > 0) step.requiredCapabilities = values;
      else delete step.requiredCapabilities;
    } else if (field === "permissionModes") {
      const values = parseAssignments(element.value);
      if (values) step.permissionModes = values;
      else delete step.permissionModes;
    } else if (field === "approvalPolicies") {
      const values = parseAssignments(element.value) as Record<string, "onRequest" | "unlessTrusted"> | undefined;
      if (values) step.approvalPolicies = values;
      else delete step.approvalPolicies;
    } else if (field === "consensus") {
      step.consensus = Boolean(checked);
      if (step.consensus) consensus();
      else delete step.consensusConfig;
      rerender = true;
    } else if (field === "consensusMode") {
      const value = consensus();
      value.mode = element.value === "arbiter" ? "arbiter" : "unanimous";
      if (value.mode === "arbiter") {
        const arbiter = value.arbiter && step.participants.includes(value.arbiter)
          ? value.arbiter
          : step.participants[0];
        setOptionalProperty(value, "arbiter", arbiter);
      }
      else {
        delete value.arbiter;
        if (value.onMaxRounds === "requestArbiterRuling") value.onMaxRounds = "humanGate";
      }
      rerender = true;
    } else if (field === "consensusMaxRounds") consensus().maxRounds = Math.max(1, Math.trunc(Number(element.value) || 1));
    else if (field === "consensusArbiter") setOptionalString(consensus() as unknown as Record<string, unknown>, "arbiter", element.value);
    else if (field === "consensusOnMaxRounds") {
      const onMaxRounds = element.value as ConsensusConfig["onMaxRounds"];
      setOptionalProperty(consensus(), "onMaxRounds", onMaxRounds);
    }
    else if (field === "consensusCandidateField") setOptionalString(consensus() as unknown as Record<string, unknown>, "candidateField", element.value);
    else if (field === "consensusAcceptedField") setOptionalString(consensus() as unknown as Record<string, unknown>, "acceptedField", element.value);
    else if (field === "consensusObjectionsField") setOptionalString(consensus() as unknown as Record<string, unknown>, "objectionsField", element.value);
    else if (field === "consensusRisksField") setOptionalString(consensus() as unknown as Record<string, unknown>, "risksField", element.value);
    else if (field === "consensusAcceptedValue") consensus().acceptedValue = element.value !== "false";
    else if (field === "consensusResultFormat") {
      if (element.value === "json") consensus().resultFormat = "json";
      else {
        delete consensus().resultFormat;
        delete consensus().resultField;
      }
      rerender = true;
    } else if (field === "consensusResultField") setOptionalString(consensus() as unknown as Record<string, unknown>, "resultField", element.value);
    else if (field === "outputEnabled") {
      if (checked) {
        step.output = { name: `${step.id}Output`, format: "json", schema: { type: "object" } };
        state.editorOutputSchemas.set(step.id, safeJson(step.output.schema));
      } else {
        delete step.output;
        state.editorOutputSchemas.delete(step.id);
      }
      rerender = true;
    } else if (field === "outputName" && step.output) step.output.name = element.value;
    else if (field === "outputSchema" && step.output) {
      state.editorOutputSchemas.set(step.id, element.value);
      try {
        const parsed: unknown = JSON.parse(element.value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) step.output.schema = parsed as JsonValue;
      } catch {
        return;
      }
    }
  } else if (step.type === "checklist") {
    if (field === "participants") {
      step.participants = element.value ? [element.value] : [];
      rerender = true;
    } else if (field === "promptTemplate") step.promptTemplate = element.value;
    else if (field === "outputName") step.outputName = element.value;
    else if (field === "timeoutMs") {
      const value = Number(element.value);
      if (Number.isFinite(value) && value >= 1000) step.timeoutMs = value;
      else delete step.timeoutMs;
    } else if (field === "attachments") step.attachments = element.value as "none" | "selected";
    else if (field === "requiredCapabilities") {
      const values = controlValues(element);
      if (values.length > 0) step.requiredCapabilities = values;
      else delete step.requiredCapabilities;
    } else if (field === "permissionModes") {
      const values = parseAssignments(element.value);
      if (values) step.permissionModes = values;
      else delete step.permissionModes;
    } else if (field === "approvalPolicies") {
      const values = parseAssignments(element.value) as Record<string, "onRequest" | "unlessTrusted"> | undefined;
      if (values) step.approvalPolicies = values;
      else delete step.approvalPolicies;
    }
  } else if (step.type === "executeChecklist") {
    if (field === "inputName") step.inputName = element.value;
    else if (field === "pipelineId") step.pipelineId = element.value;
    else if (field === "allowedPaths") step.allowedPaths = element.value.split(/\r?\n/).filter((item) => item.length > 0);
    else if (field === "checks") step.checks = element.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    else if (field === "checkResources") step.checkResources = element.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    else if (field === "allowNoChecks") step.allowNoChecks = Boolean(checked);
    else if (field === "retries") {
      const value = Number(element.value);
      if (Number.isSafeInteger(value) && value >= 0 && value <= 10) step.retries = value;
      else delete step.retries;
    } else if (field === "maxConcurrency") {
      const value = Number(element.value);
      if (Number.isSafeInteger(value) && value >= 1 && value <= 20) step.maxConcurrency = value;
      else delete step.maxConcurrency;
    }
  } else if (step.type === "assignRoles") {
    const assignmentIndex = Number(element.dataset.editorAssignment);
    const assignment = step.roleAssignments[assignmentIndex];
    if (assignment && (field === "role" || field === "agentId")) assignment[field] = element.value;
  }
  syncEditorRaw();
  if (rerender) scheduleRender();
};
