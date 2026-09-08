import {
  AgentCapabilities,
  AgentId,
  AgentRunResult,
  CodexApprovalPolicy,
  JsonValue,
  WorkspaceWriteScope,
} from "../adapters/types";
import { isProviderFailureError, providerFallbackFailureCodes } from "../adapters/providerFailure";
import { describeCapability } from "./capabilities";
import { resolveCandidateShape } from "./candidateShapes";
import {
  buildDecisionArtifact,
  parseDecisionParticipant,
  parseStepOutput,
} from "./output";
import { PipelineDependencySnapshot } from "./identity";
import { effectivePermissionMode, grantsNoWrite } from "./permissionModes";
import { gateMovement, managedTransition } from "./stepTransitions";
import { renderTemplate } from "./template";
import {
  AgentDefinition,
  AgentTurnStep,
  ChecklistStep,
  DecisionArtifact,
  ExecuteChecklistStep,
  ExecutionChecklistIssue,
  ExecutionChecklistValue,
  JsonOutputSchema,
  PipelineDefinition,
  PipelineStep,
  RoleDefinition,
  ManagedPipelinePolicy,
  StepOutputArtifact,
} from "./types";

export type PipelineAgentOptions = {
  permissionMode?: string | undefined;
  approvalPolicy?: CodexApprovalPolicy | undefined;
  model?: string | undefined;
  managed?: boolean | undefined;
  managedRole?: "worker" | "lead" | undefined;
  managedOptional?: boolean | undefined;
  participant?: string | undefined;
  roleId?: string | undefined;
  roleName?: string | undefined;
  readOnly?: boolean | undefined;
  writeScope?: WorkspaceWriteScope | undefined;
  readPaths?: string[] | undefined;
  allowedPaths?: string[] | undefined;
  protectedPaths?: string[] | undefined;
  commitMode?: "never" | "allow" | undefined;
  resourceId?: string | undefined;
  originalTask?: string | undefined;
  verificationChecks?: Array<{ id: string; command: string }> | undefined;
  maxRevisionCycles?: number | undefined;
};

export type PipelineExecutionStep = AgentTurnStep | ChecklistStep;

export type PipelineRunAgent = (
  agentId: AgentId,
  prompt: string,
  step: PipelineExecutionStep,
  options: PipelineAgentOptions,
  attachments: string[],
) => Promise<AgentRunResult>;

export type PipelineIntervention = {
  id: string;
  agentId: AgentId;
  prompt: string;
  answer: string;
  createdAt: string;
};

export type HumanGateReason =
  | "beforeStep"
  | "afterStep"
  | "invalidConsensus"
  | "maxConsensusRounds";

export type HumanGateAction =
  | "continue"
  | "skip"
  | "cancel"
  | "retry"
  | "discardStep"
  | "rerunStep"
  | "repeatConsensus"
  | "requestArbiterRuling"
  | "rollback";

export type HumanGateDecision = {
  action: HumanGateAction;
  targetStepId?: string;
  interventions?: PipelineIntervention[];
};

export type HumanGateRequest = {
  step: PipelineStep;
  reason: HumanGateReason;
  allowedActions: HumanGateAction[];
  rollbackTargets: Array<{ id: string; name: string }>;
  round?: number;
  detail?: string;
};

export type ExecutionChecklistRequest = {
  step: ChecklistStep;
  issues: ExecutionChecklistIssue[];
};

export type ExecutionChecklistDecision = {
  selectedIssueIds: string[];
  userNote: string;
  source: "user" | "timeout" | "cancel";
};

export type ExecuteChecklistRequest = {
  step: ExecuteChecklistStep;
  checklist: ExecutionChecklistValue;
  signal?: AbortSignal;
  allowedDirtyPaths?: string[];
  pipelineSnapshot?: PipelineDependencySnapshot;
};

export type ExecuteChecklistResult = {
  runRef: string;
  status: "completed" | "stopped" | "failed" | "blocked" | "abandoned";
  workingDirectory: string;
  integrationBranch?: string;
  error?: string;
};

export type PipelineRunCallbacks = {
  onStep: (step: PipelineStep, index: number, round?: number) => void;
  onRoles: (roles: Record<string, AgentId>) => void;
  onOutput?: ((artifact: StepOutputArtifact) => Promise<void> | void) | undefined;
  onDecision?: ((artifact: DecisionArtifact) => Promise<void> | void) | undefined;
  onCheckpoint?: ((state: PipelineResumeState) => Promise<void> | void) | undefined;
  waitForHumanGate: (
    request: HumanGateRequest,
  ) => Promise<HumanGateDecision>;
  waitForExecutionChecklist?: ((
    request: ExecutionChecklistRequest,
  ) => Promise<ExecutionChecklistDecision>) | undefined;
  executeChecklist?: ((request: ExecuteChecklistRequest) => Promise<ExecuteChecklistResult>) | undefined;
};

export type PipelineRunResult = {
  status: "completed" | "interrupted";
  roles: Record<string, AgentId>;
  answers: Record<string, Record<AgentId, string>>;
  outputs: Record<string, Record<AgentId, StepOutputArtifact>>;
  decisions: Record<string, DecisionArtifact[]>;
  workspaceChanged?: boolean;
  workspaceFingerprint?: string;
};

export type PipelineOrderedAnswers = {
  order: AgentId[];
  values: Record<AgentId, string>;
};

type OrderedRunResults = {
  order: AgentId[];
  values: Record<AgentId, AgentRunResult>;
  /**
   * EX-A5-R14. Which participant each result was produced for, recorded by the round that
   * produced it. A provider fallback changes the agent mid-step, so a map built before the round
   * names agents that did not run and misses the ones that did.
   */
  participants: Record<AgentId, string>;
};

export type PendingExecutionChecklist = {
  agentId: AgentId;
  answer: string;
  issues: ExecutionChecklistIssue[];
};

export type PipelineRunnerSnapshot = {
  roles: Record<string, AgentId>;
  answers: Record<string, Record<AgentId, string>>;
  latestAnswers: Record<AgentId, string>;
  previousStepAnswers: PipelineOrderedAnswers;
  latestInterventions: PipelineOrderedAnswers;
  outputs?: Record<string, Record<AgentId, StepOutputArtifact>> | undefined;
  decisions?: Record<string, DecisionArtifact[]> | undefined;
  namedOutputs?: Record<string, JsonValue> | undefined;
  pendingChecklists?: Record<string, PendingExecutionChecklist> | undefined;
};

export type PipelineResumeState = {
  version: 1;
  nextStepIndex: number;
  snapshot: PipelineRunnerSnapshot;
};

export type AdapterCapabilitiesByAgent = Record<AgentId, AgentCapabilities>;

const checklistSchema: JsonOutputSchema = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          title: { type: "string", minLength: 1, maxLength: 240 },
          details: { type: "string", minLength: 1, maxLength: 8000 },
          dependencies: {
            type: "array",
            maxItems: 100,
            items: { type: "string", minLength: 1, maxLength: 80 },
          },
          paths: {
            type: "array",
            minItems: 1,
            maxItems: 100,
            items: { type: "string", minLength: 1, maxLength: 1000 },
          },
        },
        required: ["id", "title", "details", "dependencies", "paths"],
        additionalProperties: false,
      },
    },
  },
  required: ["issues"],
  additionalProperties: false,
};

const checklistValueSchema: JsonOutputSchema = {
  type: "object",
  properties: {
    issues: checklistSchema.properties?.issues as JsonOutputSchema,
    selectedIssueIds: {
      type: "array",
      maxItems: 100,
      items: { type: "string", minLength: 1, maxLength: 80 },
    },
    userNote: { type: "string", maxLength: 20000 },
  },
  required: ["issues", "selectedIssueIds", "userNote"],
  additionalProperties: false,
};

export const executionChecklistValidationErrors = (
  issues: ExecutionChecklistIssue[],
): string[] => {
  const errors: string[] = [];
  const ids = new Set<string>();
  issues.forEach((issue, index) => {
    if (ids.has(issue.id)) {
      errors.push(`$.issues[${String(index)}].id duplicates ${issue.id}`);
    }
    ids.add(issue.id);
    if (new Set(issue.dependencies).size !== issue.dependencies.length) {
      errors.push(`$.issues[${String(index)}].dependencies contains duplicates`);
    }
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(issue.id)) {
      errors.push(`$.issues[${String(index)}].id must match ^[A-Za-z][A-Za-z0-9_-]{0,79}$`);
    }
    if (issue.paths.length === 0) {
      errors.push(`$.issues[${String(index)}].paths must not be empty`);
    }
    if (new Set(issue.paths).size !== issue.paths.length) {
      errors.push(`$.issues[${String(index)}].paths contains duplicates`);
    }
  });
  issues.forEach((issue, index) => {
    issue.dependencies.forEach((dependency) => {
      if (!ids.has(dependency)) {
        errors.push(
          `$.issues[${String(index)}].dependencies references unknown issue ${dependency}`,
        );
      }
      if (dependency === issue.id) {
        errors.push(
          `$.issues[${String(index)}].dependencies must not reference itself`,
        );
      }
    });
  });
  if (errors.length > 0) {
    return errors;
  }
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (issueId: string): void => {
    if (visited.has(issueId) || errors.length > 0) {
      return;
    }
    if (visiting.has(issueId)) {
      errors.push(`$.issues dependency cycle contains ${issueId}`);
      return;
    }
    visiting.add(issueId);
    byId.get(issueId)?.dependencies.forEach(visit);
    visiting.delete(issueId);
    visited.add(issueId);
  };
  issues.forEach((issue) => visit(issue.id));
  return errors;
};

const extractChecklistIssues = (
  artifact: StepOutputArtifact,
): ExecutionChecklistIssue[] => {
  if (artifact.validationErrors.length > 0) {
    return [];
  }
  const value = artifact.value as { issues?: unknown };
  if (!Array.isArray(value.issues)) {
    artifact.validationErrors.push("$.issues must be an array");
    return [];
  }
  const issues = value.issues as ExecutionChecklistIssue[];
  artifact.validationErrors.push(...executionChecklistValidationErrors(issues));
  return artifact.validationErrors.length === 0 ? issues : [];
};

const includeChecklistDependencies = (
  issues: ExecutionChecklistIssue[],
  selectedIssueIds: string[],
): string[] => {
  const selected = new Set(selectedIssueIds);
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const include = (issueId: string): void => {
    const issue = byId.get(issueId);
    if (!issue) {
      return;
    }
    issue.dependencies.forEach((dependency) => {
      if (!selected.has(dependency)) {
        selected.add(dependency);
        include(dependency);
      }
    });
  };
  [...selected].forEach(include);
  return issues.filter((issue) => selected.has(issue.id)).map((issue) => issue.id);
};

const emptyAnswers = (): PipelineOrderedAnswers => ({ order: [], values: {} });

const cloneOrderedAnswers = (
  answers: PipelineOrderedAnswers,
): PipelineOrderedAnswers => ({
  order: [...answers.order],
  values: { ...answers.values },
});

const cloneAnswers = (
  answers: Record<string, Record<AgentId, string>>,
): Record<string, Record<AgentId, string>> =>
  Object.fromEntries(
    Object.entries(answers).map(([stepId, values]) => [stepId, { ...values }]),
  );

const cloneOutputs = (
  outputs: Record<string, Record<AgentId, StepOutputArtifact>>,
): Record<string, Record<AgentId, StepOutputArtifact>> =>
  structuredClone(outputs);

const cloneDecisions = (
  decisions: Record<string, DecisionArtifact[]>,
): Record<string, DecisionArtifact[]> => structuredClone(decisions);

const resolveAgentId = (
  participant: string,
  agents: Set<string>,
  roles: Record<string, AgentId>,
): AgentId => {
  if (agents.has(participant)) {
    return participant;
  }
  const roleAgent = roles[participant];
  if (!roleAgent) {
    throw new Error(`Role ${participant} is not assigned`);
  }
  return roleAgent;
};

const resolveOption = <T>(
  values: Record<string, T> | undefined,
  participant: string,
  agentId: string,
): T | undefined => values?.[participant] ?? values?.[agentId];

const participantOptions = (
  participant: string,
  agentId: string,
  step: PipelineExecutionStep,
  definition: AgentDefinition,
  roleDefinition: RoleDefinition | undefined,
  originalTask: string,
  managedPolicy: ManagedPipelinePolicy | undefined,
  runtimeAllowedPaths?: string[],
  runtimeCommitMode?: "never" | "allow",
  runtimeWriteScope?: WorkspaceWriteScope,
): PipelineAgentOptions => {
  const requested =
    resolveOption(step.permissionModes, participant, agentId) ?? definition.permissionMode;
  const roleReadOnly = roleDefinition?.readOnly === true;
  const semanticReadOnly = grantsNoWrite({ requested, roleReadOnly });
  const permissionMode = effectivePermissionMode({
    adapter: definition.adapter,
    requested,
    roleReadOnly,
  });
  return {
    permissionMode,
    approvalPolicy:
      resolveOption(step.approvalPolicies, participant, agentId) ??
      definition.approvalPolicy,
    // A role's model wins over the agent's, so a Lead and a Worker can run on different
    // models without either agent being edited. Unset falls back to the provider default.
    model: roleDefinition?.model ?? definition.model,
    managed: roleDefinition?.managed ?? false,
    managedRole: roleDefinition?.managedRole,
    managedOptional: roleDefinition?.managedOptional,
    participant,
    roleId: roleDefinition?.id,
    roleName: roleDefinition?.name,
    readOnly: semanticReadOnly,
    writeScope: runtimeWriteScope ?? managedPolicy?.writeScope ?? roleDefinition?.writeScope,
    readPaths: managedPolicy?.readPaths
      ? [...managedPolicy.readPaths]
      : roleDefinition?.readPaths
        ? [...roleDefinition.readPaths]
        : undefined,
    allowedPaths: runtimeAllowedPaths
      ? [...runtimeAllowedPaths]
      : managedPolicy?.allowedPaths
        ? [...managedPolicy.allowedPaths]
        : roleDefinition?.allowedPaths
          ? [...roleDefinition.allowedPaths]
          : undefined,
    protectedPaths: managedPolicy?.protectedPaths
      ? [...managedPolicy.protectedPaths]
      : roleDefinition?.protectedPaths
        ? [...roleDefinition.protectedPaths]
        : undefined,
    commitMode: runtimeCommitMode === "never"
      ? "never"
      : managedPolicy?.commitMode ?? roleDefinition?.commitMode ?? "never",
    resourceId: definition.resourceId ?? roleDefinition?.resourceId,
    originalTask,
    verificationChecks: managedPolicy?.verificationChecks
      ? managedPolicy.verificationChecks.map((check) => ({ ...check }))
      : roleDefinition?.verificationChecks
        ? roleDefinition.verificationChecks.map((check) => ({ ...check }))
        : undefined,
    maxRevisionCycles: managedPolicy?.maxRevisionCycles,
  };
};

const orderedPeerAnswers = (
  answers: PipelineOrderedAnswers,
  currentAgentId: string,
): PipelineOrderedAnswers => ({
  order: answers.order.filter((agentId) => agentId !== currentAgentId),
  values: Object.fromEntries(
    answers.order
      .filter((agentId) => agentId !== currentAgentId)
      .map((agentId) => [agentId, answers.values[agentId] ?? ""]),
  ),
});

const rawAnswers = (answers: PipelineOrderedAnswers): string =>
  answers.order.map((agentId) => answers.values[agentId] ?? "").join("\n\n");

const taggedAnswers = (answers: PipelineOrderedAnswers): string =>
  answers.order
    .map((agentId) => `--- ${agentId} ---\n${answers.values[agentId] ?? ""}`)
    .join("\n\n");

const jsonAnswers = (answers: PipelineOrderedAnswers): string =>
  JSON.stringify(
    Object.fromEntries(
      answers.order.map((agentId) => [agentId, answers.values[agentId] ?? ""]),
    ),
  );

const createTemplateValues = (
  userPrompt: string,
  currentAgentId: string,
  currentParticipant: string,
  roleDefinition: RoleDefinition | undefined,
  latestAnswers: Record<string, string>,
  sourceAnswers: PipelineOrderedAnswers,
  latestInterventions: PipelineOrderedAnswers,
  roles: Record<string, AgentId>,
  namedOutputs: Record<string, JsonValue>,
): Record<string, string> => {
  const peers = orderedPeerAnswers(sourceAnswers, currentAgentId);
  const currentIntervention = latestInterventions.values[currentAgentId] ?? "";
  const values: Record<string, string> = {
    userPrompt,
    previousAnswer: latestAnswers[currentAgentId] ?? "",
    latestAgentAnswer: latestAnswers[currentAgentId] ?? "",
    previousStepAnswer: sourceAnswers.values[currentAgentId] ?? "",
    previousStepAnswers: rawAnswers(sourceAnswers),
    peerAnswer: peers.values[peers.order.at(0) ?? ""] ?? "",
    peerAnswers: rawAnswers(peers),
    peerAnswersTagged: taggedAnswers(peers),
    peerAnswersJson: jsonAnswers(peers),
    interventionAnswer: currentIntervention,
    interventionAnswers: rawAnswers(latestInterventions),
    interventionAnswersTagged: taggedAnswers(latestInterventions),
    currentAgentId,
    currentParticipant,
    roleId: roleDefinition?.id ?? "",
    roleName: roleDefinition?.name ?? "",
    roleInstructions: roleDefinition?.instructions ?? "",
    outputsJson: JSON.stringify(namedOutputs),
  };
  Object.entries(latestAnswers).forEach(([agentId, answer]) => {
    values[`answers.${agentId}`] = answer;
  });
  Object.entries(roles).forEach(([role, agentId]) => {
    values[`answers.${role}`] = latestAnswers[agentId] ?? "";
  });
  Object.entries(latestInterventions.values).forEach(([agentId, answer]) => {
    values[`interventions.${agentId}`] = answer;
  });
  Object.entries(roles).forEach(([role, agentId]) => {
    values[`interventions.${role}`] =
      latestInterventions.values[agentId] ?? "";
  });
  Object.entries(namedOutputs).forEach(([name, value]) => {
    values[`outputs.${name}`] = JSON.stringify(value);
  });
  return values;
};

const hasGate = (
  step: PipelineStep,
  timing: "before" | "after",
): boolean => step.humanGate === timing || step.humanGate === "both";

const gate = async (
  callbacks: PipelineRunCallbacks,
  request: HumanGateRequest,
): Promise<HumanGateDecision> => {
  const decision = await callbacks.waitForHumanGate(request);
  if (!request.allowedActions.includes(decision.action)) {
    throw new Error(
      `Action ${decision.action} is not allowed for ${request.reason} on step ${request.step.id}`,
    );
  }
  if (decision.action === "rollback") {
    if (
      !decision.targetStepId ||
      !request.rollbackTargets.some(
        (target) => target.id === decision.targetStepId,
      )
    ) {
      throw new Error("Rollback requires an allowed target step");
    }
  } else if (decision.targetStepId !== undefined) {
    throw new Error(`${decision.action} does not accept a target step`);
  }
  return decision;
};

/**
 * The result an ordered run recorded for an agent.
 *
 * `order` is built from the same round that filled `values`, so a name in one is always a
 * key in the other. Disagreement would mean the round produced a result set it cannot
 * describe, which is a failure rather than something to paper over per call site.
 */
const orderedResultFor = (
  results: OrderedRunResults,
  agentId: AgentId,
): AgentRunResult => {
  const value = results.values[agentId];
  if (!value) {
    throw new Error(`Ordered run results are missing agent ${agentId}`);
  }
  return value;
};

const orderedResultAnswers = (
  results: OrderedRunResults,
): PipelineOrderedAnswers => ({
  order: [...results.order],
  values: Object.fromEntries(
    results.order.flatMap((agentId) => {
      const value = results.values[agentId];
      // The order names only agents the results carry, so nothing is dropped here.
      return value === undefined ? [] : [[agentId, value.answer] as const];
    }),
  ),
});

const mergeOrderedAnswers = (
  first: PipelineOrderedAnswers,
  second: PipelineOrderedAnswers,
): PipelineOrderedAnswers => {
  const order = [...first.order];
  second.order.forEach((agentId) => {
    if (!order.includes(agentId)) {
      order.push(agentId);
    }
  });
  return {
    order,
    values: { ...first.values, ...second.values },
  };
};

const enabledRollbackTargets = (
  pipeline: PipelineDefinition,
  currentIndex: number,
  includeCurrent: boolean,
  availableSnapshots: ReadonlyMap<number, PipelineRunnerSnapshot>,
): Array<{ id: string; name: string }> =>
  pipeline.steps
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) =>
      step.enabled &&
      index < (includeCurrent ? currentIndex + 1 : currentIndex) &&
      availableSnapshots.has(index),
    )
    .map(({ step }) => ({ id: step.id, name: step.name }));

const findStepIndex = (pipeline: PipelineDefinition, stepId: string): number => {
  const index = pipeline.steps.findIndex((step) => step.id === stepId);
  if (index < 0) {
    throw new Error(`Unknown rollback step: ${stepId}`);
  }
  return index;
};

export const validatePipelineCapabilities = (
  pipeline: PipelineDefinition,
  capabilitiesByAgent: AdapterCapabilitiesByAgent,
  hasSelectedAttachments: boolean,
): string[] => {
  const errors: string[] = [];
  const agentIds = new Set(pipeline.agents.map((agent) => agent.id));
  const roleDefinitions = new Map(
    (pipeline.roles ?? []).map((role) => [role.id, role]),
  );
  const roles: Record<string, string> = {};

  for (const step of pipeline.steps) {
    if (!step.enabled) {
      continue;
    }
    if (step.type === "assignRoles") {
      step.roleAssignments.forEach((assignment) => {
        roles[assignment.role] = assignment.agentId;
      });
      continue;
    }
    if (step.type === "executeChecklist") {
      continue;
    }
    const executionStep: PipelineExecutionStep = step;
    const participants = executionStep.participants.map((participant) => ({
      participant,
      agentId: agentIds.has(participant) ? participant : roles[participant],
    }));
    participants.forEach(({ participant, agentId }) => {
      if (!agentId) {
        return;
      }
      const required = new Set(executionStep.requiredCapabilities ?? []);
      const roleDefinition = roleDefinitions.get(participant);
      roleDefinition?.requiredCapabilities?.forEach((capability) =>
        required.add(capability),
      );
      if (executionStep.attachments === "selected" && hasSelectedAttachments) {
        required.add("attachments");
      }
      const candidates = [...new Set([agentId, ...(roleDefinition?.candidateAgentIds ?? [])])];
      candidates.forEach((candidateId) => {
        const definition = pipeline.agents.find((agent) => agent.id === candidateId);
        const provider = definition
          ? `${definition.name} (${definition.adapter})`
          : `agent ${candidateId}`;
        const capabilities = capabilitiesByAgent[candidateId];
        if (!capabilities) {
          errors.push(
            `Step "${step.name}" cannot run: ${provider} reported no capabilities. Check that its provider is installed and available, then run Bachata: Doctor.`,
          );
          return;
        }
        required.forEach((capability) => {
          if (!capabilities[capability]) {
            errors.push(
              `Step "${step.name}" needs ${describeCapability(capability)} from ${provider}, which this provider does not offer here. Select a provider that supports it or remove the requirement from the step.`,
            );
          }
        });
      });
    });
  }
  return errors;
};

export const executePipeline = async (
  pipeline: PipelineDefinition,
  userPrompt: string,
  attachments: string[],
  runAgent: PipelineRunAgent,
  callbacks: PipelineRunCallbacks,
  signal?: AbortSignal,
  resumeState?: PipelineResumeState,
  executionPolicy?: { allowedPaths?: string[]; commitMode?: "never" | "allow"; writeScope?: WorkspaceWriteScope },
): Promise<PipelineRunResult> => {
  const agentDefinitions = new Map(
    pipeline.agents.map((definition) => [definition.id, definition]),
  );
  const roleDefinitions = new Map(
    (pipeline.roles ?? []).map((definition) => [definition.id, definition]),
  );
  const agentIds = new Set(agentDefinitions.keys());
  const managedRoleAt = (stepIndex: number): "worker" | "lead" | undefined => {
    const candidate = pipeline.steps[stepIndex];
    if (!candidate || candidate.type !== "agent" || candidate.participants.length !== 1) return undefined;
    const [participant] = candidate.participants;
    const role = participant === undefined ? undefined : roleDefinitions.get(participant);
    return role?.managed === true ? role.managedRole : undefined;
  };
  const managedBlockBounds = (stepIndex: number): { start: number; end: number } | undefined => {
    if (!managedRoleAt(stepIndex)) return undefined;
    let start = stepIndex;
    let end = stepIndex + 1;
    while (start > 0 && managedRoleAt(start - 1)) start -= 1;
    while (end < pipeline.steps.length && managedRoleAt(end)) end += 1;
    return { start, end };
  };
  const activeManagedBrowserBlocks = new Set<number>();
  let roles: Record<string, AgentId> = resumeState
    ? { ...resumeState.snapshot.roles }
    : {};
  let answers: Record<string, Record<AgentId, string>> = resumeState
    ? cloneAnswers(resumeState.snapshot.answers)
    : {};
  let outputs = resumeState?.snapshot.outputs
    ? cloneOutputs(resumeState.snapshot.outputs)
    : {};
  let decisions = resumeState?.snapshot.decisions
    ? cloneDecisions(resumeState.snapshot.decisions)
    : {};
  let namedOutputs: Record<string, JsonValue> = resumeState?.snapshot.namedOutputs
    ? structuredClone(resumeState.snapshot.namedOutputs)
    : {};
  let pendingChecklists: Record<string, PendingExecutionChecklist> = resumeState?.snapshot.pendingChecklists
    ? structuredClone(resumeState.snapshot.pendingChecklists)
    : {};
  let latestAnswers: Record<AgentId, string> = resumeState
    ? { ...resumeState.snapshot.latestAnswers }
    : {};
  let previousStepAnswers = resumeState
    ? cloneOrderedAnswers(resumeState.snapshot.previousStepAnswers)
    : emptyAnswers();
  let latestInterventions = resumeState
    ? cloneOrderedAnswers(resumeState.snapshot.latestInterventions)
    : emptyAnswers();
  const snapshots = new Map<number, PipelineRunnerSnapshot>();
  let index = resumeState?.nextStepIndex ?? 0;

  const result = (status: PipelineRunResult["status"]): PipelineRunResult => ({
    status,
    roles,
    answers,
    outputs,
    decisions,
  });

  const interrupted = (): boolean => signal?.aborted === true;

  const captureSnapshot = (): PipelineRunnerSnapshot => ({
    roles: { ...roles },
    answers: cloneAnswers(answers),
    latestAnswers: { ...latestAnswers },
    previousStepAnswers: cloneOrderedAnswers(previousStepAnswers),
    latestInterventions: cloneOrderedAnswers(latestInterventions),
    outputs: cloneOutputs(outputs),
    decisions: cloneDecisions(decisions),
    namedOutputs: structuredClone(namedOutputs),
    pendingChecklists: structuredClone(pendingChecklists),
  });

  const restoreSnapshot = (targetIndex: number): void => {
    const snapshot = snapshots.get(targetIndex);
    if (!snapshot) {
      throw new Error(`No rollback snapshot exists for step ${String(targetIndex)}`);
    }
    roles = { ...snapshot.roles };
    answers = cloneAnswers(snapshot.answers);
    latestAnswers = { ...snapshot.latestAnswers };
    previousStepAnswers = cloneOrderedAnswers(snapshot.previousStepAnswers);
    latestInterventions = cloneOrderedAnswers(snapshot.latestInterventions);
    outputs = cloneOutputs(snapshot.outputs ?? {});
    decisions = cloneDecisions(snapshot.decisions ?? {});
    namedOutputs = structuredClone(snapshot.namedOutputs ?? {});
    pendingChecklists = structuredClone(snapshot.pendingChecklists ?? {});
    Array.from(snapshots.keys()).forEach((snapshotIndex) => {
      if (snapshotIndex > targetIndex) {
        snapshots.delete(snapshotIndex);
      }
    });
    callbacks.onRoles({ ...roles });
  };

  const interventionAnswers = (
    interventions: PipelineIntervention[] | undefined,
  ): PipelineOrderedAnswers => {
    const value = emptyAnswers();
    (interventions ?? []).forEach((intervention) => {
      if (!value.order.includes(intervention.agentId)) {
        value.order.push(intervention.agentId);
      }
      value.values[intervention.agentId] = intervention.answer;
    });
    return value;
  };

  const applyInterventions = (
    stepId: string,
    interventions: PipelineIntervention[] | undefined,
  ): PipelineOrderedAnswers => {
    const ordered = interventionAnswers(interventions);
    if (ordered.order.length === 0) {
      return ordered;
    }
    Object.assign(latestAnswers, ordered.values);
    previousStepAnswers = cloneOrderedAnswers(ordered);
    latestInterventions = cloneOrderedAnswers(ordered);
    const key = `@intervention:${stepId}:${interventions?.at(-1)?.id ?? "unknown"}`;
    answers[key] = { ...ordered.values };
    return ordered;
  };

  const applyRollback = (
    stepId: string,
    interventions?: PipelineIntervention[],
  ): void => {
    const targetIndex = findStepIndex(pipeline, stepId);
    restoreSnapshot(targetIndex);
    applyInterventions(stepId, interventions);
    index = targetIndex;
  };

  while (index < pipeline.steps.length) {
    const step = pipeline.steps[index];
    // The loop condition already proves the step is there. Saying so once is what lets the
    // compiler keep the step-kind narrowing through the body, instead of re-widening the
    // union at every read.
    if (!step) {
      index += 1;
      continue;
    }
    if (!step.enabled) {
      index += 1;
      continue;
    }
    if (interrupted()) {
      return result("interrupted");
    }

    if (!snapshots.has(index)) {
      snapshots.set(index, captureSnapshot());
    }
    await callbacks.onCheckpoint?.({
      version: 1,
      nextStepIndex: index,
      snapshot: captureSnapshot(),
    });
    callbacks.onStep(step, index);

    if (hasGate(step, "before")) {
      const rollbackTargets = enabledRollbackTargets(pipeline, index, false, snapshots);
      const decision = await gate(callbacks, {
        step,
        reason: "beforeStep",
        allowedActions: [
          "continue",
          "skip",
          ...(rollbackTargets.length > 0
            ? (["rollback"] as HumanGateAction[])
            : []),
          "cancel",
        ],
        rollbackTargets,
      });
      // EX-AUD-12. What a gate answer does to the run is decided in `stepTransitions.ts`.
      const movement = gateMovement(decision, "before");
      if (movement.movement === "interrupt") {
        return result("interrupted");
      }
      if (movement.movement === "rollback") {
        applyRollback(movement.targetStepId, decision.interventions);
        continue;
      }
      applyInterventions(step.id, decision.interventions);
      if (movement.movement === "advance") {
        index += 1;
        continue;
      }
    }

    if (step.type === "assignRoles") {
      step.roleAssignments.forEach((assignment) => {
        roles[assignment.role] = assignment.agentId;
      });
      callbacks.onRoles({ ...roles });
      if (hasGate(step, "after")) {
        const decision = await gate(callbacks, {
          step,
          reason: "afterStep",
          allowedActions: ["continue", "rerunStep", "rollback", "cancel"],
          rollbackTargets: enabledRollbackTargets(pipeline, index, true, snapshots),
        });
        const movement = gateMovement(decision, "after");
        if (movement.movement === "interrupt") {
          return result("interrupted");
        }
        if (movement.movement === "rollback") {
          applyRollback(movement.targetStepId, decision.interventions);
          continue;
        }
        if (movement.movement === "repeat") {
          if (movement.restoreSnapshot) restoreSnapshot(index);
          applyInterventions(step.id, decision.interventions);
          continue;
        }
        applyInterventions(step.id, decision.interventions);
      }
      index += 1;
      continue;
    }

    if (step.type === "checklist") {
      const [participant] = step.participants;
      // The schema requires a checklist step to name its participant. Saying so once keeps
      // the rest of the branch working with a participant rather than a maybe-participant.
      if (participant === undefined) {
        throw new Error(`Checklist step ${step.id} names no participant`);
      }
      const agentId = resolveAgentId(participant, agentIds, roles);
      const definition = agentDefinitions.get(agentId);
      if (!definition) {
        throw new Error(`Unknown agent ${agentId}`);
      }
      const roleDefinition = roleDefinitions.get(participant);
      const prompt = renderTemplate(
        step.promptTemplate,
        createTemplateValues(
          userPrompt,
          agentId,
          participant,
          roleDefinition,
          latestAnswers,
          previousStepAnswers,
          latestInterventions,
          roles,
          namedOutputs,
        ),
      );
      const existingChecklist = pendingChecklists[step.id];
      let agentAnswer: string;
      let issues: ExecutionChecklistIssue[];
      if (existingChecklist) {
        if (existingChecklist.agentId !== agentId) {
          throw new Error(`Step ${step.id} pending checklist belongs to a different agent`);
        }
        const validationErrors = executionChecklistValidationErrors(existingChecklist.issues);
        if (validationErrors.length > 0) {
          throw new Error(
            `Step ${step.id} saved checklist is invalid\n${validationErrors.join("\n")}`,
          );
        }
        agentAnswer = existingChecklist.answer;
        issues = structuredClone(existingChecklist.issues);
      } else {
        const strictPrompt = [
          prompt,
          "Return JSON only.",
          "Shape: {\"issues\":[{\"id\":\"ISSUE-1\",\"title\":\"...\",\"details\":\"...\",\"dependencies\":[],\"paths\":[\"src/path\"]}]}",
          "Issue IDs must begin with a letter and contain only letters, numbers, underscore, or hyphen.",
          "Every issue must declare one or more repository-relative paths. Do not return shell commands.",
          "Use only confirmed work inside the original request. Do not invent new scope.",
        ].join("\n\n");
        const runAttachments = step.attachments === "selected" ? attachments : [];
        const agentResult = await runAgent(
          agentId,
          strictPrompt,
          step,
          participantOptions(participant, agentId, step, definition, roleDefinition, userPrompt, pipeline.managedPolicy),
          runAttachments,
        );
        if (agentResult.status === "interrupted") {
          return result("interrupted");
        }
        const issueArtifact = parseStepOutput(
          step.id,
          agentId,
          step.outputName,
          agentResult.answer,
          checklistSchema,
        );
        issues = extractChecklistIssues(issueArtifact);
        if (issueArtifact.validationErrors.length > 0) {
          throw new Error(
            `Step ${step.id} checklist is invalid\n${issueArtifact.validationErrors.join("\n")}`,
          );
        }
        agentAnswer = agentResult.answer;
        pendingChecklists[step.id] = {
          agentId,
          answer: agentAnswer,
          issues: structuredClone(issues),
        };
        await callbacks.onCheckpoint?.({
          version: 1,
          nextStepIndex: index,
          snapshot: captureSnapshot(),
        });
      }
      if (!callbacks.waitForExecutionChecklist) {
        throw new Error(`Step ${step.id} requires an execution checklist interaction`);
      }
      const checklistDecision = await callbacks.waitForExecutionChecklist({
        step,
        issues,
      });
      if (
        checklistDecision.source === "cancel" ||
        checklistDecision.source === "timeout"
      ) {
        return result("interrupted");
      }
      const issueIds = new Set(issues.map((issue) => issue.id));
      const selectedIssueIds = includeChecklistDependencies(
        issues,
        Array.from(new Set(checklistDecision.selectedIssueIds)),
      );
      const unknown = selectedIssueIds.filter((issueId) => !issueIds.has(issueId));
      if (unknown.length > 0) {
        throw new Error(`Checklist selected unknown issue ids: ${unknown.join(", ")}`);
      }
      const checklistValue: ExecutionChecklistValue = {
        issues,
        selectedIssueIds,
        userNote: checklistDecision.userNote,
      };
      delete pendingChecklists[step.id];
      const finalArtifact = parseStepOutput(
        step.id,
        agentId,
        step.outputName,
        JSON.stringify(checklistValue),
        checklistValueSchema,
      );
      if (finalArtifact.validationErrors.length > 0) {
        throw new Error(
          `Step ${step.id} checklist selection is invalid\n${finalArtifact.validationErrors.join("\n")}`,
        );
      }
      answers[step.id] = { [agentId]: agentAnswer };
      latestAnswers[agentId] = agentAnswer;
      previousStepAnswers = { order: [agentId], values: { [agentId]: agentAnswer } };
      latestInterventions = emptyAnswers();
      outputs[step.id] = { [agentId]: finalArtifact };
      namedOutputs[step.outputName] = finalArtifact.value;
      await callbacks.onOutput?.(finalArtifact);
      if (hasGate(step, "after")) {
        const decision = await gate(callbacks, {
          step,
          reason: "afterStep",
          allowedActions: ["continue", "rerunStep", "rollback", "cancel"],
          rollbackTargets: enabledRollbackTargets(pipeline, index, true, snapshots),
        });
        const movement = gateMovement(decision, "after");
        if (movement.movement === "interrupt") {
          return result("interrupted");
        }
        if (movement.movement === "rollback") {
          applyRollback(movement.targetStepId, decision.interventions);
          continue;
        }
        if (movement.movement === "repeat") {
          if (movement.restoreSnapshot) restoreSnapshot(index);
          applyInterventions(step.id, decision.interventions);
          continue;
        }
        applyInterventions(step.id, decision.interventions);
      }
      index += 1;
      continue;
    }

    if (step.type === "executeChecklist") {
      const value = namedOutputs[step.inputName];
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Step ${step.id} requires checklist output ${step.inputName}`);
      }
      const checklist = value as ExecutionChecklistValue;
      if (
        !Array.isArray(checklist.issues) ||
        !Array.isArray(checklist.selectedIssueIds) ||
        typeof checklist.userNote !== "string"
      ) {
        throw new Error(`Step ${step.id} received invalid checklist output ${step.inputName}`);
      }
      if (!callbacks.executeChecklist) {
        throw new Error(`Step ${step.id} requires checklist execution support`);
      }
      if (checklist.selectedIssueIds.length === 0) {
        answers[step.id] = {};
        latestInterventions = emptyAnswers();
        index += 1;
        continue;
      }
      const execution = await callbacks.executeChecklist({
        step,
        checklist,
        ...(signal === undefined ? {} : { signal }),
      });
      if (interrupted() || execution.status === "stopped") {
        return result("interrupted");
      }
      if (execution.status !== "completed") {
        throw new Error(
          `Step ${step.id} checklist execution ${execution.status}${execution.error ? `: ${execution.error}` : ""}`,
        );
      }
      answers[step.id] = {};
      latestInterventions = emptyAnswers();
      index += 1;
      continue;
    }

    const agentStep: AgentTurnStep = step;
    const participants = agentStep.participants.map((participant) => ({
      participant,
      agentId: resolveAgentId(participant, agentIds, roles),
    }));
    const resolvedAgentIds = participants.map(({ agentId }) => agentId);
    if (new Set(resolvedAgentIds).size !== resolvedAgentIds.length) {
      throw new Error(
        `Step ${step.id} resolves more than one participant to the same agent`,
      );
    }
    const runAttachments = agentStep.attachments === "selected" ? attachments : [];

    const runRound = async (
      sourceAnswers: PipelineOrderedAnswers,
      round?: number,
      selectedParticipants = participants,
    ): Promise<OrderedRunResults> => {
      callbacks.onStep(agentStep, index, round);
      const resultsByAgent: Record<AgentId, AgentRunResult> = {};
      const resultParticipants: Record<AgentId, string> = {};
      const resultOrder: AgentId[] = [];
      const claimedAgentIds = new Set<AgentId>();

      const executeParticipant = async (
        participant: string,
        agentId: string,
        currentRoundAnswers: PipelineOrderedAnswers,
      ): Promise<{ participant: string; agentId: AgentId; result: AgentRunResult }> => {
        const roleDefinition = roleDefinitions.get(participant);
        const preferredAdapters = roleDefinition?.preferredAdapters ?? [];
        const managedBoundsForParticipant = managedBlockBounds(index);
        const persistedManagedBrowserAssignment = managedBoundsForParticipant !== undefined
          && Array.from(
            { length: managedBoundsForParticipant.end - managedBoundsForParticipant.start },
            (_, offset) => managedBoundsForParticipant.start + offset,
          ).some((candidateIndex) => {
            const candidateStep = pipeline.steps[candidateIndex];
            if (!candidateStep || candidateStep.type !== "agent" || candidateStep.participants.length !== 1) return false;
            const [candidateParticipant] = candidateStep.participants;
            if (candidateParticipant === undefined) return false;
            const candidateRole = roleDefinitions.get(candidateParticipant);
            if (candidateRole?.managedRole !== "worker") return false;
            const assignedAgentId = roles[candidateParticipant];
            return assignedAgentId !== undefined
              && agentDefinitions.get(assignedAgentId)?.adapter.endsWith("-browser") === true;
          });
        const forceManagedBrowser = managedBoundsForParticipant !== undefined
          && (activeManagedBrowserBlocks.has(managedBoundsForParticipant.start) || persistedManagedBrowserAssignment);
        const candidates = [...new Set([agentId, ...(roleDefinition?.candidateAgentIds ?? [])])]
          .filter((candidateId) => {
            const definition = agentDefinitions.get(candidateId);
            return definition !== undefined
              && (!forceManagedBrowser || definition.adapter.endsWith("-browser"));
          })
          .sort((left, right) => {
            if (left === agentId) return -1;
            if (right === agentId) return 1;
            const leftAdapter = agentDefinitions.get(left)?.adapter ?? "";
            const rightAdapter = agentDefinitions.get(right)?.adapter ?? "";
            const leftRank = preferredAdapters.indexOf(leftAdapter);
            const rightRank = preferredAdapters.indexOf(rightAdapter);
            const normalizedLeft = leftRank < 0 ? Number.MAX_SAFE_INTEGER : leftRank;
            const normalizedRight = rightRank < 0 ? Number.MAX_SAFE_INTEGER : rightRank;
            return normalizedLeft - normalizedRight;
          });
        let lastFailure: unknown;
        for (const [candidateIndex, candidateId] of candidates.entries()) {
          if (claimedAgentIds.has(candidateId)) {
            continue;
          }
          const definition = agentDefinitions.get(candidateId);
          if (!definition) {
            continue;
          }
          const values = createTemplateValues(
            userPrompt,
            candidateId,
            participant,
            roleDefinition,
            latestAnswers,
            mergeOrderedAnswers(sourceAnswers, currentRoundAnswers),
            latestInterventions,
            roles,
            namedOutputs,
          );
          const renderedPrompt = renderTemplate(agentStep.promptTemplate, values);
          const prompt = roleDefinition
            ? [
                `Role: ${roleDefinition.name} (${roleDefinition.id})`,
                ...(agentStep.promptTemplate.includes("{{roleInstructions}}")
                  ? []
                  : [roleDefinition.instructions]),
                "Task:",
                renderedPrompt,
              ].join("\n\n")
            : renderedPrompt;
          claimedAgentIds.add(candidateId);
          try {
            const result = await runAgent(
              candidateId,
              prompt,
              step,
              participantOptions(
                participant,
                candidateId,
                agentStep,
                definition,
                roleDefinition,
                userPrompt,
                pipeline.managedPolicy,
                executionPolicy?.allowedPaths,
                executionPolicy?.commitMode,
                executionPolicy?.writeScope,
              ),
              runAttachments,
            );
            if (candidateId !== agentId && roleDefinition) {
              roles = { ...roles, [participant]: candidateId };
              callbacks.onRoles({ ...roles });
            }
            return { participant, agentId: candidateId, result };
          } catch (error) {
            claimedAgentIds.delete(candidateId);
            lastFailure = error;
            const failure = isProviderFailureError(error) ? error.failure : undefined;
            const hasAlternate = candidateIndex + 1 < candidates.length;
            if (!failure
              || !hasAlternate
              || failure.sideEffects !== "none"
              || !providerFallbackFailureCodes.has(failure.code)) {
              throw error;
            }
          }
        }
        throw lastFailure ?? new Error(`No runnable candidate is available for ${participant}`);
      };

      if (agentStep.parallel && selectedParticipants.length > 1) {
        const executions = await Promise.all(
          selectedParticipants.map(({ participant, agentId }) =>
            executeParticipant(participant, agentId, emptyAnswers()),
          ),
        );
        executions.forEach((execution) => {
          resultsByAgent[execution.agentId] = execution.result;
          resultParticipants[execution.agentId] = execution.participant;
          resultOrder.push(execution.agentId);
        });
      } else {
        const currentRoundAnswers = emptyAnswers();
        for (const { participant, agentId } of selectedParticipants) {
          const execution = await executeParticipant(
            participant,
            agentId,
            currentRoundAnswers,
          );
          resultsByAgent[execution.agentId] = execution.result;
          resultParticipants[execution.agentId] = execution.participant;
          resultOrder.push(execution.agentId);
          currentRoundAnswers.order.push(execution.agentId);
          currentRoundAnswers.values[execution.agentId] = execution.result.answer;
          if (execution.result.status === "interrupted") {
            break;
          }
        }
      }

      return {
        order: resultOrder,
        values: resultsByAgent,
        participants: resultParticipants,
      };
    };

    let stepResults: OrderedRunResults = { order: [], values: {}, participants: {} };

    if (agentStep.consensus) {
      const config = agentStep.consensusConfig;
      if (!config) {
        throw new Error(`Consensus step ${step.id} has no configuration`);
      }
      const decisionFields = {
        candidateField: config.candidateField ?? "answer",
        acceptedField: config.acceptedField ?? config.resultField ?? "consensus",
        acceptedValue: config.acceptedValue ?? true,
        ...(config.objectionsField === undefined
          ? {}
          : { objectionsField: config.objectionsField }),
        ...(config.risksField === undefined ? {} : { risksField: config.risksField }),
        ...(config.candidateShape === undefined
          ? {}
          : { candidateShape: config.candidateShape }),
      };
      const rulingIdentities = Object.fromEntries(
        [...agentDefinitions.values()].map((definition) => [
          definition.id,
          {
            agentId: definition.id,
            provider: definition.name,
            adapter: definition.adapter,
            ...(definition.model === undefined ? {} : { model: definition.model }),
          },
        ]),
      );
      const onMaxRounds = config.onMaxRounds ?? "humanGate";
      const runArbiter = async (
        sourceAnswers: PipelineOrderedAnswers,
        round: number,
      ): Promise<boolean> => {
        if (config.mode !== "arbiter" || !config.arbiter) {
          throw new Error(`Consensus step ${step.id} has no configured arbiter`);
        }
        // EX-G6-13. The participant list was resolved once, from the role map as it stood at the
        // start of the step. A provider fallback reassigns the role mid-step and this line
        // resolves the arbiter's agent from the updated map — so matching the two together
        // reported the arbiter that had just been reassigned as not being a participant at all,
        // and the step failed. The declared participant is what makes something the arbiter; the
        // agent that is running it now is what carries the ruling's provenance.
        const arbiterAgentId = resolveAgentId(config.arbiter, agentIds, roles);
        if (!participants.some((participant) => participant.participant === config.arbiter)) {
          throw new Error(`Arbiter ${config.arbiter} is not a participant in ${step.id}`);
        }
        stepResults = await runRound(sourceAnswers, round, [
          { participant: config.arbiter, agentId: arbiterAgentId },
        ]);
        // EX-A5-R14. Who ruled is whoever the round actually ran, not the agent it was asked to
        // run: a provider fallback inside the ruling itself substitutes a standby, and reading
        // the result back under the declared agent's name failed the whole step on a fallback it
        // had just performed correctly.
        const ruledBy = stepResults.order[0] ?? arbiterAgentId;
        if (stepResults.values[ruledBy]?.status === "interrupted") {
          return false;
        }
        const participantRecord = parseDecisionParticipant(
          ruledBy,
          orderedResultFor(stepResults, ruledBy).answer,
          decisionFields,
        );
        const artifact = buildDecisionArtifact({
          stepId: step.id,
          round,
          policy: "arbiter",
          participants: [participantRecord],
          ruledBy,
          identities: rulingIdentities,
        });
        decisions[step.id] = [...(decisions[step.id] ?? []), artifact];
        await callbacks.onDecision?.(artifact);
        if (artifact.status !== "ruled" && artifact.status !== "accepted") {
          throw new Error(
            `Arbiter ${config.arbiter} did not publish an accepted valid decision`,
          );
        }
        return true;
      };

      let round = 1;
      let roundLimit = config.maxRounds;
      let sourceAnswers = previousStepAnswers;
      let complete = false;

      while (!complete) {
        if (interrupted()) {
          return result("interrupted");
        }
        if (round > roundLimit) {
          if (onMaxRounds === "fail") {
            throw new Error(`Consensus step ${step.id} reached its maximum rounds`);
          }
          if (onMaxRounds === "requestArbiterRuling") {
            complete = await runArbiter(sourceAnswers, round);
            break;
          }
          const decision = await gate(callbacks, {
            step,
            reason: "maxConsensusRounds",
            allowedActions: [
              "retry",
              "discardStep",
              ...(config.mode === "arbiter"
                ? (["requestArbiterRuling"] as HumanGateAction[])
                : []),
              "cancel",
            ],
            rollbackTargets: enabledRollbackTargets(pipeline, index, false, snapshots),
            round,
          });
          if (decision.action === "cancel") {
            return result("interrupted");
          }
          const interventionSource = applyInterventions(
            step.id,
            decision.interventions,
          );
          if (interventionSource.order.length > 0) {
            sourceAnswers = interventionSource;
          }
          if (decision.action === "discardStep") {
            stepResults = { order: [], values: {}, participants: {} };
            break;
          }
          if (decision.action === "requestArbiterRuling") {
            complete = await runArbiter(sourceAnswers, round);
            break;
          }
          roundLimit += config.maxRounds;
        }

        stepResults = await runRound(sourceAnswers, round);
        if (
          stepResults.order.some(
            (agentId) => orderedResultFor(stepResults, agentId).status === "interrupted",
          )
        ) {
          return result("interrupted");
        }
        const participantRecords = stepResults.order.map((agentId) =>
          parseDecisionParticipant(
            agentId,
            orderedResultFor(stepResults, agentId).answer,
            decisionFields,
          ),
        );
        const artifact = buildDecisionArtifact({
          stepId: step.id,
          round,
          policy: config.mode,
          participants: participantRecords,
          identities: rulingIdentities,
        });
        decisions[step.id] = [...(decisions[step.id] ?? []), artifact];
        await callbacks.onDecision?.(artifact);
        const invalid = participantRecords.flatMap((participant) =>
          participant.validationErrors.map(
            (message) => `${participant.agentId}: ${message}`,
          ),
        );
        if (artifact.status === "accepted") {
          complete = true;
          break;
        }
        sourceAnswers = orderedResultAnswers(stepResults);
        if (config.mode === "arbiter") {
          complete = await runArbiter(sourceAnswers, round);
          if (complete) {
            break;
          }
        }
        if (invalid.length > 0) {
          const decision = await gate(callbacks, {
            step,
            reason: "invalidConsensus",
            allowedActions: ["retry", "discardStep", "cancel"],
            rollbackTargets: enabledRollbackTargets(pipeline, index, false, snapshots),
            round,
            detail: invalid.join("\n"),
          });
          if (decision.action === "cancel") {
            return result("interrupted");
          }
          const interventionSource = applyInterventions(
            step.id,
            decision.interventions,
          );
          if (decision.action === "discardStep") {
            stepResults = { order: [], values: {}, participants: {} };
            break;
          }
          if (interventionSource.order.length > 0) {
            sourceAnswers = interventionSource;
          }
          if (decision.action === "retry") {
            roundLimit += 1;
          }
        }
        round += 1;
      }
    } else {
      stepResults = await runRound(previousStepAnswers);
      if (
        stepResults.order.some(
          (agentId) => orderedResultFor(stepResults, agentId).status === "interrupted",
        )
      ) {
        return result("interrupted");
      }
    }

    const completedAnswers = orderedResultAnswers(stepResults);
    answers[step.id] = completedAnswers.values;
    Object.assign(latestAnswers, completedAnswers.values);
    if (completedAnswers.order.length > 0) {
      previousStepAnswers = completedAnswers;
    }
    latestInterventions = emptyAnswers();

    if (agentStep.output) {
      const stepOutputs: Record<AgentId, StepOutputArtifact> = {};
      const outputSchema = agentStep.output.schema ??
        resolveCandidateShape(agentStep.output.shape);
      if (outputSchema === undefined) {
        throw new Error(`Step ${step.id} output declares no schema or known shape`);
      }
      // The declared participant is preserved beside the agent that answered, so a promotion
      // naming a role still matches once the role has been resolved to an agent.
      // EX-A5-R14. Read from the round that ran, not from the list resolved before it: a
      // fallback agent appears in no pre-execution list, so its artifact carried no declared
      // role and nothing promoting by role could find it.
      const participantByAgentId = new Map([
        ...participants.map(({ participant, agentId }) => [agentId, participant] as const),
        ...Object.entries(stepResults.participants),
      ]);
      for (const agentId of completedAnswers.order) {
        const answer = completedAnswers.values[agentId];
        // As with the run results: the order is built from the answers it describes.
        if (answer === undefined) {
          throw new Error(`Ordered answers are missing agent ${agentId}`);
        }
        const artifact = parseStepOutput(
          step.id,
          agentId,
          agentStep.output.name,
          answer,
          outputSchema,
          participantByAgentId.get(agentId),
        );
        stepOutputs[agentId] = artifact;
        await callbacks.onOutput?.(artifact);
      }
      outputs[step.id] = stepOutputs;
      const invalid = Object.values(stepOutputs).flatMap((artifact) =>
        artifact.validationErrors.map(
          (message) => `${artifact.agentId}: ${message}`,
        ),
      );
      if (invalid.length > 0) {
        throw new Error(`Step ${step.id} output is invalid\n${invalid.join("\n")}`);
      }
      const values = Object.values(stepOutputs).map((artifact) => artifact.value);
      const [onlyValue] = values;
      namedOutputs[agentStep.output.name] =
        values.length === 1 && onlyValue !== undefined
          ? onlyValue
          : Object.fromEntries(
              Object.values(stepOutputs).map((artifact) => [
                artifact.agentId,
                artifact.value,
              ]),
            );
    }

    if (hasGate(step, "after")) {
      const allowedActions: HumanGateAction[] = [
        "continue",
        "rerunStep",
        ...(step.consensus
          ? (["repeatConsensus"] as HumanGateAction[])
          : []),
        "rollback",
        "cancel",
      ];
      const decision = await gate(callbacks, {
        step,
        reason: "afterStep",
        allowedActions,
        rollbackTargets: enabledRollbackTargets(pipeline, index, true, snapshots),
      });
      const movement = gateMovement(decision, "after");
      if (movement.movement === "interrupt") {
        return result("interrupted");
      }
      if (movement.movement === "rollback") {
        applyRollback(movement.targetStepId, decision.interventions);
        continue;
      }
      if (movement.movement === "repeat") {
        if (movement.restoreSnapshot) restoreSnapshot(index);
        applyInterventions(step.id, decision.interventions);
        continue;
      }
      applyInterventions(step.id, decision.interventions);
    }

    const managedResultState = stepResults.order
      .map((agentId) => stepResults.values[agentId]?.managedState)
      .find((value) => value !== undefined);
    const managedRole = managedRoleAt(index);
    const managedBounds = managedBlockBounds(index);
    if (managedResultState && managedRole && managedBounds) {
      const stepAnswers = answers[step.id] ?? {};
      if (Object.keys(stepAnswers).some((agentId) => agentDefinitions.get(agentId)?.adapter.endsWith("-browser") === true)) {
        activeManagedBrowserBlocks.add(managedBounds.start);
      }
    }
    // EX-AUD-12. Where a managed turn's result sends the run is decided in `stepTransitions.ts`.
    const managedMovement = managedTransition({
      ...(managedResultState ? { managedState: managedResultState.state } : {}),
      ...(managedRole ? { managedRole } : {}),
      ...(managedBounds ? { bounds: managedBounds } : {}),
      index,
      isEnabledWorkerStep: (candidate) =>
        pipeline.steps[candidate]?.enabled === true && managedRoleAt(candidate) === "worker",
    });
    if (managedMovement.movement === "fail") {
      throw new Error(`Managed Lead requested a revision in ${step.id}, but no enabled managed Worker step exists in the same managed block`);
    }
    if (managedMovement.movement === "jump") {
      index = managedMovement.index;
      continue;
    }

    index += 1;
  }

  await callbacks.onCheckpoint?.({
    version: 1,
    nextStepIndex: pipeline.steps.length,
    snapshot: captureSnapshot(),
  });
  return result("completed");
};
