import type { RunSettingsSnapshot } from "../runtime/settingsSnapshot";
import type { WorkspaceWriteScope } from "../adapters/types";
import type { PipelineReadiness, ReadinessStatus } from "../readiness/model";
import { providerDisplayName } from "../pipeline/providerNames";
import { pipelineDefinitionHash } from "../pipeline/identity";
import { extensionVersion } from "../version";
import { buildOutboundContext, readOnlyPermissionModes } from "./outboundContext";
import { repositoryPolicyRefusals } from "../policy/repositoryPolicy";
import {
  MANAGED_PROJECT_CHECKS_COMMAND,
  MANAGED_WORKSPACE_INTEGRITY_COMMAND,
} from "../orchestrator/verificationPolicy";
import { verifierDescriptorId } from "../orchestrator/verifierRegistry";
import type { RepositoryPolicy } from "../policy/repositoryPolicy";
import type { OutboundContextManifest } from "./outboundContext";
import type {
  HumanGateMode,
  PipelineDefinition,
  RoleDefinition,
} from "../pipeline/types";

export type ExecutionSafetyLevel = "review" | "interactive" | "managed" | "orchestration";

export type ExecutionAssurance =
  | "readOnly"
  | "unverified"
  | "modelReviewed"
  | "controllerVerified"
  | "isolatedApplicable";

/*
 * One place derives what a controller check claims, so a badge can never outrun what the
 * check runs. A contract is written before the run, so it names what is declared; naming a
 * repository verifier as having passed belongs to the result, against an exact candidate.
 */
export const controllerCheckDescription = (command: string): string => {
  if (command === MANAGED_WORKSPACE_INTEGRITY_COMMAND) return "workspace integrity";
  if (command === MANAGED_PROJECT_CHECKS_COMMAND) return "integrity, syntax and types";
  const id = verifierDescriptorId(command);
  return id === undefined ? command : `repository verifier "${id}"`;
};

export const controllerCheckSummary = (verification: readonly string[]): string => {
  const described = [...new Set(verification.map(controllerCheckDescription))];
  return described.length === 0 ? "no declared check" : described.join(", ");
};

export const declaresRepositoryVerifier = (verification: readonly string[]): boolean =>
  verification.some((command) => verifierDescriptorId(command) !== undefined);

const fixedAssuranceLabels: Record<ExecutionAssurance, string> = {
  readOnly: "Read-only",
  unverified: "Unverified",
  modelReviewed: "Model-reviewed",
  controllerVerified: "Controller-checked",
  isolatedApplicable: "Controller-checked, isolated and applicable",
};

export const assuranceLabel = (
  assurance: ExecutionAssurance,
  verification: readonly string[] = [],
): string =>
  assurance === "controllerVerified" || assurance === "isolatedApplicable"
    ? `${fixedAssuranceLabels[assurance]}: ${controllerCheckSummary(verification)}`
    : fixedAssuranceLabels[assurance];

const noRepositorySuiteSentence = (verification: readonly string[]): string =>
  declaresRepositoryVerifier(verification)
    ? " A declared repository verifier does not run: Bachata refuses every repository descriptor before any process starts."
    : " No repository test suite is declared for this run, so none runs.";

export const assuranceStatement = (
  assurance: ExecutionAssurance,
  verification: readonly string[] = [],
): string => {
  if (assurance === "readOnly") return "Nothing in the repository is written.";
  if (assurance === "unverified") {
    return "This run can write, and neither a second model nor the controller checks the result.";
  }
  if (assurance === "modelReviewed") {
    return "A second model challenges the work. Bachata runs no check of its own, so nothing here is proven.";
  }
  const ran = `Bachata runs ${controllerCheckSummary(verification)} itself and records the result.${noRepositorySuiteSentence(verification)}`;
  return assurance === "isolatedApplicable"
    ? `${ran} The work stays in a retained worktree and reaches your branch only through an apply you choose.`
    : `${ran} Changes land in your selected workspace, and Bachata does not roll them back.`;
};

export const UNREPORTED = "unreported";

export type ExecutionContractProvider = {
  agentId: string;
  name: string;
  adapter: string;
  adapterLabel: string;
  model?: string;
  modelSource: "configured" | "unreported";
  runtimeVersion?: string;
  runtimeVersionSource: "detected" | "unreported";
  roles: string[];
  status: ReadinessStatus;
  detail?: string;
};

export type ExecutionContractProvenance = {
  extensionVersion: string;
  pipelineHash: string;
  runSettings?: RunSettingsSnapshot;
};

export type ExecutionContractRole = {
  id: string;
  name: string;
  managed: boolean;
  optional: boolean;
  readOnly: boolean;
  writeScope: WorkspaceWriteScope;
  writablePaths: string[];
  readablePaths: string[];
  protectedPaths: string[];
  commitPolicy: "never" | "allow";
  verification: string[];
  candidateAgentIds: string[];
};

export type ExecutionContractScope = {
  workingDirectory?: string;
  writeScope: WorkspaceWriteScope;
  writablePaths: string[];
  readablePaths: string[];
  protectedPaths: string[];
};

export type ExecutionContractLimits = {
  iterations: number;
  maxIterations: number;
  iterationMode: "fixed" | "untilClean";
  requiredCleanPasses?: number;
  agentTurnTimeoutMs?: number;
  managedTaskTimeoutMs?: number;
  browserOperationTimeoutMs?: number;
  maxRevisionCycles?: number;
  checklistRetries?: number;
  checklistConcurrency?: number;
  maxParticipantTurns?: number;
  participantTurnsBounded: boolean;
  consensusSteps: ExecutionContractConsensusStep[];
  executesChecklist: boolean;
};

export type ExecutionContractConsensusStep = {
  stepId: string;
  stepName: string;
  maxRounds: number;
  roundLimitRetryable: boolean;
};

export type ExecutionContractGate = {
  stepId: string;
  stepName: string;
  gate: HumanGateMode;
};

export const readinessStatusLabels: Record<ReadinessStatus, string> = {
  ready: "ready",
  blocked: "blocked",
  needsSetup: "needs setup",
  unsupported: "not supported here",
};

export const writeScopeLabels: Record<"task" | "configured" | "workspace" | "readOnly", string> = {
  readOnly: "no repository writes",
  task: "isolated task worktree",
  configured: "configured working directory",
  workspace: "workspace files",
};

export const humanGateLabels: Record<HumanGateMode, string> = {
  none: "no human decision",
  before: "before the step runs",
  after: "after the step runs",
  both: "before and after the step runs",
};

export type ExecutionContract = {
  pipelineId: string;
  pipelineName: string;
  safetyLevel: ExecutionSafetyLevel;
  providers: ExecutionContractProvider[];
  roles: ExecutionContractRole[];
  scope: ExecutionContractScope;
  commitPolicy: "never" | "allow";
  verification: string[];
  verificationResources: string[];
  humanGates: ExecutionContractGate[];
  limits: ExecutionContractLimits;
  fallbacks: string[];
  completion: string[];
  policyRefusals: string[];
  blockers: string[];
  outboundContext: OutboundContextManifest[];
  provenance: ExecutionContractProvenance;
  assurance: ExecutionAssurance;
  assuranceLabel: string;
  assuranceStatement: string;
};

export type ExecutionContractInput = {
  pipeline: PipelineDefinition;
  readiness?: PipelineReadiness;
  workingDirectory?: string;
  iterations?: number;
  maxIterations: number;
  iterationMode?: "fixed" | "untilClean";
  requiredCleanPasses?: number;
  agentTurnTimeoutMs?: number;
  managedTaskTimeoutMs?: number;
  browserOperationTimeoutMs?: number;
  attachments?: Array<{ name: string; mimeType: string; size: number }>;
  promptBytes?: number;
  handoffMaxBytes?: number;
  continuationMaxBytes?: number;
  repositoryPolicy?: RepositoryPolicy;
  runSettings?: RunSettingsSnapshot;
  repositoryPolicyErrors?: string[];
  providerRuntimeVersions?: Record<string, string>;
};

const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));


const enabledSteps = (pipeline: PipelineDefinition) =>
  (pipeline.steps ?? []).filter((step) => step.enabled);

const checklistSteps = (pipeline: PipelineDefinition) =>
  enabledSteps(pipeline).flatMap((step) => step.type === "executeChecklist" ? [step] : []);

const roleWrites = (role: RoleDefinition): boolean =>
  role.readOnly !== true &&
  (role.managed === true || role.writeScope !== undefined || role.commitMode !== undefined);

export const executionSafetyLevel = (pipeline: PipelineDefinition): ExecutionSafetyLevel => {
  if (checklistSteps(pipeline).length > 0) return "orchestration";
  if (pipeline.managedPolicy) return "managed";
  if ((pipeline.roles ?? []).some((role) => role.managed === true)) return "managed";
  const writingRole = (pipeline.roles ?? []).some(roleWrites);
  const writingAgent = (pipeline.agents ?? []).some(
    (agent) => agent.permissionMode === undefined || !readOnlyPermissionModes.has(agent.permissionMode),
  );
  const writingStep = enabledSteps(pipeline).some(
    (step) => (step.type === "agent" || step.type === "checklist") &&
      Object.values(step.permissionModes ?? {}).some((mode) => !readOnlyPermissionModes.has(mode)),
  );
  return writingRole || writingAgent || writingStep ? "interactive" : "review";
};

export const PROPOSED_FINDING_SET_SHAPE = "proposedModelFindingSet";
export const RULED_FINDING_SET_SHAPE = "ruledModelFindingSet";

export const producesModelFindings = (pipeline: PipelineDefinition): boolean =>
  enabledSteps(pipeline).some((step) => {
    if (step.type !== "agent") return false;
    if (step.output?.shape === PROPOSED_FINDING_SET_SHAPE) return true;
    return step.consensus === true &&
      step.consensusConfig?.candidateShape === RULED_FINDING_SET_SHAPE;
  });

export const executionAssurance = (input: {
  safetyLevel: ExecutionSafetyLevel;
  writeScope: WorkspaceWriteScope;
  verification: string[];
  crossChecked: boolean;
}): ExecutionAssurance => {
  if (input.safetyLevel === "review" || input.writeScope === "readOnly") return "readOnly";
  if (input.verification.length > 0) {
    return input.safetyLevel === "orchestration" ? "isolatedApplicable" : "controllerVerified";
  }
  return input.crossChecked ? "modelReviewed" : "unverified";
};

const writeScopeRank: Record<WorkspaceWriteScope, number> = {
  readOnly: 0,
  task: 1,
  configured: 2,
  workspace: 3,
};

const widestWriteScope = (values: WorkspaceWriteScope[]): WorkspaceWriteScope =>
  values.reduce<WorkspaceWriteScope>(
    (result, value) => writeScopeRank[value] > writeScopeRank[result] ? value : result,
    "readOnly",
  );

const effectiveVerificationCommands = (
  policy: PipelineDefinition["managedPolicy"],
  role?: RoleDefinition,
): string[] => {
  const checks = policy?.verificationChecks ?? role?.verificationChecks ?? [];
  return unique(checks.map((check) => check.command));
};

const contractRoles = (
  pipeline: PipelineDefinition,
  defaultWriteScope: WorkspaceWriteScope,
): ExecutionContractRole[] => {
  const policy = pipeline.managedPolicy;
  return (pipeline.roles ?? []).map((role) => ({
    id: role.id,
    name: role.name,
    managed: role.managed === true,
    optional: role.managedOptional === true,
    readOnly: role.readOnly === true,
    writeScope: role.readOnly === true
      ? "readOnly"
      : policy?.writeScope ?? role.writeScope ?? defaultWriteScope,
    writablePaths: unique(policy?.allowedPaths ?? role.allowedPaths ?? []),
    readablePaths: unique(policy?.readPaths ?? role.readPaths ?? []),
    protectedPaths: unique(policy?.protectedPaths ?? role.protectedPaths ?? []),
    commitPolicy: policy?.commitMode ?? role.commitMode ?? "never",
    verification: effectiveVerificationCommands(policy, role),
    candidateAgentIds: role.candidateAgentIds ?? [],
  }));
};

const agentRoles = (pipeline: PipelineDefinition, agentId: string): string[] => {
  const assigned = enabledSteps(pipeline).flatMap((step) =>
    step.type === "assignRoles"
      ? step.roleAssignments.filter((assignment) => assignment.agentId === agentId).map((assignment) => assignment.role)
      : [],
  );
  const candidates = (pipeline.roles ?? [])
    .filter((role) => role.candidateAgentIds?.includes(agentId))
    .map((role) => role.id);
  return unique([...assigned, ...candidates]);
};

const findingFor = (
  readiness: PipelineReadiness | undefined,
  agentId: string,
): { status: ReadinessStatus; detail?: string } | undefined => {
  const finding = readiness?.findings.find(
    (candidate) => candidate.id === `adapter.${agentId}` || candidate.id === `bridge.${agentId}`,
  );
  return finding ? { status: finding.status, detail: finding.detail } : undefined;
};

const completionCriteria = (
  pipeline: PipelineDefinition,
  limits: ExecutionContractLimits,
  verification: string[],
  gates: ExecutionContractGate[],
): string[] => {
  const criteria = [`Every enabled step of ${pipeline.name} completes`];
  if (limits.iterationMode === "untilClean") {
    criteria.push(
      `${String(limits.requiredCleanPasses ?? 2)} consecutive iterations leave the workspace unchanged`,
    );
  } else if (limits.iterations > 1) {
    criteria.push(`${String(limits.iterations)} iterations run unless a step fails`);
  }
  if (verification.length > 0) {
    criteria.push(`Controller verification passes: ${verification.join(", ")}`);
  }
  if ((pipeline.roles ?? []).some((role) => role.managedRole === "lead")) {
    criteria.push("The managed reviewer accepts the worker result");
  }
  if (gates.length > 0) {
    criteria.push("Every human gate is answered");
  }
  return criteria;
};

const fallbackDescriptions = (pipeline: PipelineDefinition): string[] => {
  const roles = pipeline.roles ?? [];
  const byRole = roles.flatMap((role) => {
    const candidates = role.candidateAgentIds ?? [];
    if (candidates.length === 0) return [];
    return [`${role.name}: ${candidates.join(" → ")}`];
  });
  const managedOptional = roles
    .filter((role) => role.managedOptional === true)
    .map((role) => `${role.name} is optional; execution continues without it`);
  return [...byRole, ...managedOptional];
};

export const buildExecutionContract = (input: ExecutionContractInput): ExecutionContract => {
  const { pipeline } = input;
  const policy = pipeline.managedPolicy;
  const checklists = checklistSteps(pipeline);
  const safetyLevel = executionSafetyLevel(pipeline);
  const consensusSteps = enabledSteps(pipeline).flatMap((step) =>
    step.type === "agent" && step.consensus ? [step] : []);
  const consensusStepLimits: ExecutionContractConsensusStep[] = consensusSteps.map((step) => ({
    stepId: step.id,
    stepName: step.name,
    maxRounds: step.consensusConfig?.maxRounds ?? 1,
    roundLimitRetryable: (step.consensusConfig?.onMaxRounds ?? "humanGate") === "humanGate",
  }));
  const consensusRoundsExtendable = consensusSteps.length > 0;
  const turnsPerIteration = enabledSteps(pipeline).reduce((total, step) => {
    if (step.type === "agent") {
      const rounds = step.consensus ? step.consensusConfig?.maxRounds ?? 1 : 1;
      return total + step.participants.length * rounds;
    }
    if (step.type === "checklist") {
      return total + step.participants.length;
    }
    return total;
  }, 0);
  const iterations = Math.max(1, Math.min(input.maxIterations, input.iterations ?? 1));
  // The controller-owned revision loop is implemented for managed browser turns only. A
  // pipeline whose agents are all local declares a limit nothing enforces, so the contract
  // neither reports it nor budgets turns for it.
  const revisionsRunnable = pipeline.agents.some((agent) => agent.adapter.endsWith("-browser"));
  const declaredRevisionCycles = revisionsRunnable ? policy?.maxRevisionCycles : undefined;
  const revisionMultiplier = 1 + Math.max(0, declaredRevisionCycles ?? 0);
  const participantTurnsBounded = checklists.length === 0 && !consensusRoundsExtendable;
  const limits: ExecutionContractLimits = {
    iterations,
    maxIterations: input.maxIterations,
    iterationMode: input.iterationMode ?? "fixed",
    ...(input.iterationMode === "untilClean"
      ? { requiredCleanPasses: input.requiredCleanPasses ?? 2 }
      : {}),
    ...(input.agentTurnTimeoutMs === undefined ? {} : { agentTurnTimeoutMs: input.agentTurnTimeoutMs }),
    ...(input.managedTaskTimeoutMs === undefined || safetyLevel === "review"
      ? {}
      : { managedTaskTimeoutMs: input.managedTaskTimeoutMs }),
    ...(input.browserOperationTimeoutMs === undefined ||
      !pipeline.agents.some((agent) => agent.adapter.endsWith("-browser"))
      ? {}
      : { browserOperationTimeoutMs: input.browserOperationTimeoutMs }),
    ...(declaredRevisionCycles === undefined ? {} : { maxRevisionCycles: declaredRevisionCycles }),
    ...(checklists[0]?.retries === undefined ? {} : { checklistRetries: checklists[0].retries }),
    ...(checklists[0]?.maxConcurrency === undefined
      ? {}
      : { checklistConcurrency: checklists[0].maxConcurrency }),
    ...(turnsPerIteration === 0
      ? {}
      : { maxParticipantTurns: turnsPerIteration * iterations * revisionMultiplier }),
    participantTurnsBounded,
    consensusSteps: consensusStepLimits,
    executesChecklist: checklists.length > 0,
  };
  const roleVerification = (pipeline.roles ?? []).length > 0
    ? (pipeline.roles ?? []).flatMap((role) => effectiveVerificationCommands(policy, role))
    : effectiveVerificationCommands(policy);
  const verification = unique([
    ...roleVerification,
    ...checklists.flatMap((step) => step.checks),
  ]);

  const humanGates = enabledSteps(pipeline)
    .filter((step) => step.humanGate !== "none")
    .map((step) => ({ stepId: step.id, stepName: step.name, gate: step.humanGate }));
  const providers = pipeline.agents.map((agent) => {
    const finding = findingFor(input.readiness, agent.id);
    return {
      agentId: agent.id,
      name: agent.name,
      adapter: agent.adapter,
      adapterLabel: providerDisplayName(agent.adapter),
      ...(agent.model === undefined ? {} : { model: agent.model }),
      modelSource: agent.model === undefined ? "unreported" as const : "configured" as const,
      ...(input.providerRuntimeVersions?.[agent.adapter] === undefined
        ? {}
        : { runtimeVersion: input.providerRuntimeVersions[agent.adapter] }),
      runtimeVersionSource: input.providerRuntimeVersions?.[agent.adapter] === undefined
        ? "unreported" as const
        : "detected" as const,
      roles: agentRoles(pipeline, agent.id),
      status: finding?.status ?? "needsSetup",
      ...(finding?.detail === undefined ? {} : { detail: finding.detail }),
    };
  });
  const defaultWriteScope: WorkspaceWriteScope = policy?.writeScope ??
    (safetyLevel === "review" ? "readOnly" : "workspace");
  const roles = contractRoles(pipeline, defaultWriteScope);
  const writingRoles = roles.filter((role) => !role.readOnly);
  const participantWrites = pipeline.agents.some(
    (agent) => agent.permissionMode === undefined ||
      !readOnlyPermissionModes.has(agent.permissionMode),
  ) || enabledSteps(pipeline).some(
    (step) => (step.type === "agent" || step.type === "checklist") &&
      Object.values(step.permissionModes ?? {}).some((mode) => !readOnlyPermissionModes.has(mode)),
  );
  const scopeContributions: WorkspaceWriteScope[] = [
    ...writingRoles.map((role) => role.writeScope),
    ...(checklists.length > 0 ? ["task" as WorkspaceWriteScope] : []),
    ...(participantWrites && !policy && !roles.some((role) => role.managed)
      ? [defaultWriteScope]
      : []),
  ];
  const aggregateWriteScope = scopeContributions.length > 0
    ? widestWriteScope(scopeContributions)
    : defaultWriteScope;
  const scope = {
    ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
    writeScope: aggregateWriteScope,
    writablePaths: unique([
      ...(policy?.allowedPaths ?? []),
      ...roles.flatMap((role) => role.writablePaths),
      ...checklists.flatMap((step) => step.allowedPaths),
    ]),
    readablePaths: unique([
      ...(policy?.readPaths ?? []),
      ...roles.flatMap((role) => role.readablePaths),
    ]),
    protectedPaths: unique([
      ...(policy?.protectedPaths ?? []),
      ...roles.flatMap((role) => role.protectedPaths),
    ]),
  };
  const commitPolicy: "never" | "allow" = policy?.commitMode === "allow" ||
    roles.some((role) => role.commitPolicy === "allow")
    ? "allow"
    : "never";
  const assurance = executionAssurance({
    safetyLevel,
    writeScope: aggregateWriteScope,
    verification,
    crossChecked: enabledSteps(pipeline).some(
      (step) => step.type === "agent" && step.consensus,
    ),
  });
  const policyRefusals = [
    ...(input.repositoryPolicyErrors ?? []),
    ...repositoryPolicyRefusals(input.repositoryPolicy, {
      pipelineId: pipeline.id,
      writeScope: aggregateWriteScope,
      commitPolicy,
      verification,
      protectedPaths: scope.protectedPaths,
      humanGateCount: humanGates.length,
    }),
  ];
  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    safetyLevel,
    providers,
    roles,
    scope,
    commitPolicy,
    verification,
    verificationResources: unique(checklists.flatMap((step) => step.checkResources ?? [])),
    humanGates,
    limits,
    fallbacks: fallbackDescriptions(pipeline),
    completion: completionCriteria(pipeline, limits, verification, humanGates),
    policyRefusals,
    blockers: [
      ...(input.readiness?.findings ?? [])
        .filter((finding) => finding.status !== "ready")
        .map((finding) => `${finding.label}: ${finding.detail}`),
      ...policyRefusals,
    ],
    outboundContext: buildOutboundContext({
      pipeline,
      ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
      readablePaths: scope.readablePaths,
      writablePaths: scope.writablePaths,
      writeScope: scope.writeScope,
      protectedPaths: scope.protectedPaths,
      attachments: input.attachments ?? [],
      promptBytes: input.promptBytes ?? 0,
      ...(input.handoffMaxBytes === undefined ? {} : { handoffMaxBytes: input.handoffMaxBytes }),
      ...(input.continuationMaxBytes === undefined ? {} : { continuationMaxBytes: input.continuationMaxBytes }),
    }),
    provenance: {
      extensionVersion,
      pipelineHash: pipelineDefinitionHash(pipeline),
      ...(input.runSettings === undefined ? {} : { runSettings: input.runSettings }),
    },
    assurance,
    assuranceLabel: assuranceLabel(assurance, verification),
    assuranceStatement: assuranceStatement(assurance, verification),
  };
};
