import { readTimeoutSetting } from "../state/timeoutBounds";
import { setOptionalProperty } from "../state/optionalProperty";
import { recoveryCheckpointIsUsable } from "./recoveryCheckpoint";
import {
  ActiveInputSlot,
  createInteractionQueue,
  promptWithDeadline,
  TimedInputResult,
} from "./interactionTransport";
import {
  AdapterTopology,
  bindBrowserAgents as bindBrowserAgentsIn,
  bindingFromSession,
  browserAgentBridgeStatus,
  buildAdapterTopology as buildTopology,
  disposeTopology as disposeAdapters,
  effectiveAgentDefinition,
  freshAgentsFrom,
  persistedAgentsFrom,
  providerEnvironmentRequest,
  releaseBrowserBindings as releaseBrowserBindingsFor,
  resetAgentsFrom,
} from "./adapterTopology";
import {
  verificationGateHolds,
  verificationIssues as verificationProblems,
} from "./verificationGate";
import {
  resetAgentProjection,
  TASK_RESET_ROLLBACK_INCOMPLETE,
  taskResetRollbackPlan,
} from "./resetTransition";
import {
  canStartQueuedMessage as queuedMessageMayStart,
  pipelineSnapshotHasCompleteTaskDependencies,
  QUEUE_FAILURE_MESSAGES,
  queueAdmissionProblem,
  queueDrainStep,
  queueFailureJoined,
  queueFailureReconciliation,
  queueFailureRecord,
  queueRemoval,
} from "./queueTransitions";
import {
  approvalChoices,
  approvalPrompt,
  approvalRecord,
  claudePermissionPrompt,
  claudePermissionRecord,
  claudePermissionVerdict,
  claudeUnansweredInput,
  claudeUserInputAnswer,
  claudeUserInputAsk,
  codexAutoResolutionMs,
  codexPickOutcome,
  codexQuestionInputBox,
  codexQuestionWidget,
  codexUnansweredInput,
  codexUnansweredPick,
  codexUserInputAnswer,
  codexUserInputAsk,
  codexUserInputCompleted,
  codexUserInputRequested,
  mcpElicitationCompleted,
  mcpElicitationRequested,
  mcpFieldValidation,
  mcpFieldValue,
  mcpFieldWidget,
  mcpUrlDecision,
  mcpUrlOutcome,
  pendingApprovalFrom,
} from "./providerInteraction";
import {
  hasDurableTaskState as durableTaskState,
  pipelineDeleteRefusal,
  pipelineMutationRefusal,
  pipelineSaveRefusal,
} from "./pipelineMutationPolicy";
import { createHash, randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

const atomicWriteText = async (filePath: string, content: string): Promise<void> => {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${String(process.pid)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
};

import { createAdapterRegistry } from "../adapters/registry";
import { isSupportedBrowserAttachmentPath } from "../adapters/browserProvider";
import { wrapAdapterWithProviderResource } from "../adapters/resourceWrappedAdapter";
import { isProviderFailureError } from "../adapters/providerFailure";
import { providerRecovery, providerRecoveryStatement } from "../adapters/providerRecovery";
import {
  browserAssetDestinationRefusal,
  browserAssetMaximumBytes,
  browserAssetRefusal,
  browserAssetSaveTitle,
  safeBrowserAssetName,
} from "./assetNaming";
import {
  sanitizedBrowserAction,
  sanitizedBrowserActionResult,
  toJsonValue,
} from "./browserActionRedaction";
import {
  browserActionBudgetRefusal,
  browserActionLimits,
  browserActionMutationContext,
  browserActionPolicySetting,
  browserActionPreApproval,
  browserActionRejection,
  managedBrowserActionPreApproval,
} from "./browserActionPolicy";
import { findCapturedAsset } from "./capturedAssetTranscript";
import { providerResourceBroker } from "./providerResourceBroker";
import {
  MANAGED_CONVERSATION_DEFAULT_BYTES,
  composeManagedRolloverPrompt,
  managedConversationMaxBytes,
  managedConversationRolloverRequired,
  managedFreshSessionKey,
  managedRolloverTaskId,
} from "../browser/managedConversationBudget";
import { mostSpecificPositiveNumber } from "./configurationScope";
import {
  gitProcessEnvironment,
  providerProcessEnvironment,
  providerScopedEnvironment,
} from "../process/safeEnvironment";
import {
  ZAI_ANTHROPIC_ENDPOINT,
  ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE,
  ZAI_TOKEN_TARGET_VARIABLE,
} from "../adapters/zaiProfile";
import { checkCommand } from "../process/checkCommand";
import { evaluateGitVersionSupport } from "../process/gitVersionSupport";
import { isPathInsideRoot } from "../process/pathBoundary";
import {
  ClaudePermissionRequest,
  ClaudePermissionResponse,
  ClaudeUserInputRequest,
  ClaudeUserInputResponse,
} from "../adapters/claudeHooks";
import {
  CodexApprovalRequest,
  CodexMcpElicitationRequest,
  CodexMcpElicitationResponse,
  CodexUserInputRequest,
  CodexUserInputResponse,
  probeCodexAppServer,
} from "../adapters/codexAppServer";
import {
  AgentAdapter,
  AgentApprovalRequest,
  AgentId,
  AgentRunResult,
  CodexApprovalPolicy,
  JsonValue,
  SendRequest,
  WorkspaceWriteScope,
} from "../adapters/types";
import { resolveWorkspaceWritePolicy } from "../adapters/workspacePolicyAudit";
import { type CodexWorkspaceScope } from "../adapters/codexWire";
import {
  captureRunSettings,
  parseRunSettings,
  pinnedRunSetting,
  type RunSettingRejection,
  type RunSettingsSnapshot,
  type SettingsReader,
} from "./settingsSnapshot";
import {
  AttachmentMetadata,
  createAttachmentStore,
} from "../attachments/attachmentStore";
import {
  BrowserBridgeServer,
  BrowserBridgeStatus,
  createBrowserBridgeServer,
} from "../browser/bridgeServer";
import { DEFAULT_BROWSER_BRIDGE_MAX_MESSAGE_BYTES } from "../browser/limits";
import { commitPolicyRefusesToolRequest } from "../browser/mutationPolicy";
import {
  BrowserActionCandidate,
  BrowserActionExecutionResult,
  describeBrowserAction,
  extractBrowserActions,
} from "../browser/actions";
import {
  BrowserConversationBinding,
  CapturedAsset,
  CapturedResponse,
  isCanonicalHttpOrigin,
} from "../browser/protocol";
import { renderCapturedAssetSummary } from "../browser/responseFormatting";
import { WorkspaceMutationRunner } from "../state/workspaceMutationFence";
import {
  checkpointAppliesTo,
  droppedRunSettings,
  droppedRunSettingsNotice,
  pipelineFailurePlan,
  pipelineTerminalPlan,
  resolvedRunConstraints,
  resumableWorkflowFrom,
  workspaceChangeFrom,
} from "./pipelineRunPlan";
import type { PersistedResumableWorkflow } from "./pipelineRunPlan";
import {
  requiresWritableHost,
  unsupportedWebviewMessage,
  webviewDispatchPlan,
} from "./webviewDispatch";
import {
  INTERVENTION_CONSENT,
  continueNeedsInterventionConsent,
  gateDecidedRecord,
  gateOpenedRecord,
  humanGateDecisionFromResponse,
  humanGateDecisionRefusal,
  humanGateInteractionAsk,
  humanGateResolution,
  pendingGateFrom,
} from "./humanGateDecision";
import {
  answeredByLead,
  approvalStillCurrent,
  collectInteractionAnswers,
  interactionDeadline,
  interactionRoute,
  mcpFieldOutcome,
} from "./interactionLifecycle";
import {
  pipelineFactIndexes,
  pipelineNameIndex,
  pipelineProviderIndex,
  providerReadinessFrom,
  providerVersionsAfter,
  requestedPipelineIds,
} from "../readiness/readinessReport";
import type { ProviderProbeOutcome } from "../readiness/readinessReport";
import {
  latestAgentOutputs,
  persistedHasDurableState,
  queueClaimStartupPlan,
  recoveryStartupPlan,
  selectedPipelinePlan,
  startupTaskDirty,
} from "./startupPlan";
import { chainSerially } from "../state/serialQueue";
import { createRuntimePersistence } from "./runtimePersistence";
import {
  capturedBrowserBinding,
  emptyTurnStream,
  turnDeadlineBreach,
  turnStreamOutcome,
  turnStreamStep,
  turnWorkspacePolicy,
} from "./turnStream";
import type { TurnDeadline } from "./turnStream";
import {
  captureManagedRepositoryBaseline,
  executeManagedBrowserControl,
  executeManagedBrowserEnvelope,
  isSupportedManagedContextAttachmentPath,
  ManagedBrowserTurnOptions,
  managedWorkspaceFingerprint,
  prepareManagedBrowserTurn,
  runManagedControllerVerification,
  resolveManagedReadPaths,
} from "../browser/managedTurn";
import {
  BrowserControlEnvelope,
  browserControlProtocolPrompt,
  extractBrowserControlEnvelopeFromCaptured,
} from "../browser/controlProtocol";
import {
  advanceManagedPair,
  computeManagedWorkspaceFingerprint,
  createManagedPairCheckpoint,
  ManagedPairCheckpoint,
  parseManagedPairCheckpoint,
  validateManagedCompletion,
} from "../orchestrator/managedPair";
import { interpretBrowserActions } from "../browser/semanticInterpreter";
import {
  executeBrowserAction,
  rejectedBrowserActionResult,
} from "../browser/workspaceActions";
import {
  createPipelineExecutionSnapshot,
  createPipelineSnapshot,
  parsePipelineSnapshot,
  pipelineDefinitionHash,
  pipelineSnapshotRootsEqual,
  pipelineSnapshotsEqual,
  PipelineDependencySnapshot,
  PipelineSnapshot,
} from "../pipeline/identity";
import {
  assertPipelineScopeSafe,
  finalizeCatalogDeleteIfAbsent,
  PipelineCatalogMutationRunner,
  PipelineScope,
  readCatalogText,
  reconcilePipelineCatalogArtifacts,
  removeCatalogTextIfUnchanged,
  resolvePipelineScope as resolveCanonicalPipelineScope,
  restoreCatalogDeleteIfAbsent,
  stageCatalogDeleteIfUnchanged,
  withPipelineCatalogFileLock,
  writeCatalogTextIfUnchanged,
} from "../pipeline/catalogStorage";
import { parseJsonResponse } from "../pipeline/output";
import { validatePipelineDefinition } from "../pipeline/schema";
import {
  addCustomPipelines,
  createPipelineValidator,
  PipelineCatalogMaps,
  planLegacyCustomPipelineMigration,
  readBuiltInPipelineCatalog,
  readCustomPipelineCatalog,
  resetPipelineCatalog,
} from "../pipeline/pipelineCatalog";
import {
  preflightResourceDependencies,
  resourceDependencyProvenance,
  roleMayUseDependency,
} from "../pipeline/resourceDependencies";
import type { ResourceAvailability } from "../pipeline/resourceDependencies";
import {
  executePipeline,
  ExecuteChecklistRequest,
  ExecuteChecklistResult,
  ExecutionChecklistDecision,
  ExecutionChecklistRequest,
  HumanGateDecision,
  HumanGateRequest,
  PipelineAgentOptions,
  PipelineIntervention,
  PendingExecutionChecklist,
  PipelineResumeState,
  PipelineRunResult,
  executionChecklistValidationErrors,
  validatePipelineCapabilities,
} from "../pipeline/runner";
import { iterationOutcome, iterationPlan } from "../pipeline/stepTransitions";
import type { ControllerEvidenceLine } from "./controllerVerification";
import {
  controllerVerificationAuthorizes,
  controllerVerificationEvidence,
  controllerVerificationOutcome,
  controllerVerificationPrompt,
  renderControllerVerificationEvidence,
  requiredControllerChecks,
} from "./controllerVerification";
import {
  managedLeadDecision,
  managedLeadReviewPrompt,
  managedWorkerRevisionPrompt,
} from "./managedLeadReview";
import { createManagedTaskState } from "./managedTaskState";
import {
  approvalIsStale,
  discardReturnsToIdle,
  resultIsStale,
  resumeRefusal,
  taskResetBaseline,
  taskResetClearedKeys,
} from "./recoveryTransition";
import {
  managedCheckpointSteps,
  managedNextPrompt,
  managedTurnContinues,
  managedTurnObjections,
} from "./managedTurn";
import {
  AgentDefinition,
  DecisionArtifact,
  ExecutionChecklistIssue,
  PipelineDefinition,
  PipelineStep,
  StepOutputArtifact,
} from "../pipeline/types";
import { forkPipelineDefinition } from "../pipeline/fork";
import {
  buildExecutionContract,
  executionSafetyLevel,
  type ExecutionContract,
  type ExecutionSafetyLevel,
} from "../contract/executionContract";
import { contractAcknowledgement } from "../contract/authority";
import type { ContractAuthority } from "../contract/authority";
import { loadRepositoryPolicy, REPOSITORY_POLICY_PATH } from "../policy/repositoryPolicy";
import type { RepositoryPolicy } from "../policy/repositoryPolicy";
import {
  AdapterReadiness,
  evaluateReadiness,
  PipelineReadiness,
} from "../readiness/model";
import { gitReadinessFrom } from "../readiness/gitReadiness";
import { guardrailSummary } from "../workflows/guardrails";
import type { GuardrailSummary } from "../workflows/guardrails";
import { redactFreeFormText, redactJsonValue, redactText } from "../security/redact";
import { unattendedPipelineSafetyErrors } from "../security/unattendedPipeline";
import { createTranscriptStore } from "../state/transcriptStore";
import {
  AgentPanelState,
  ExtensionToWebviewMessage,
  InteractionMode,
  MessageDelivery,
  PanelState,
  PendingApproval,
  PendingHumanGate,
  PipelineSummary,
  QueuedMessage,
  ResumableWorkflow,
  TranscriptEntry,
  WebviewToExtensionMessage,
  WorkflowStatus,
  isRuntimeOperation,
  parseTranscriptEntry,
  parseWebviewMessage,
} from "../webview/protocol";

export type RuntimeConfiguration = {
  pipelineId?: string;
  pipelineSnapshot?: PipelineSnapshot;
  workingDirectory?: string;
  preserveHistory?: boolean;
};

export type PipelineCatalogChange = {
  ownerId: string;
  scopeKey: string;
  pipelineId: string;
};

export type RuntimeInteractionOption = {
  id: string;
  label: string;
  description?: string | undefined;
};

export type RuntimeInteractionFallback = {
  type: "lead";
  originAgentId: string;
  title: string;
  prompt: string;
  options: RuntimeInteractionOption[];
  allowFreeText: boolean;
};

export type RuntimeInteractionRequest = {
  sourceKey: string;
  kind: "semanticQuestion" | "permission" | "humanGate" | "executionChecklist" | "secret" | "elicitation";
  title: string;
  prompt: string;
  options: RuntimeInteractionOption[];
  allowFreeText: boolean;
  secret: boolean;
  timeoutMs?: number | undefined;
  fallback?: RuntimeInteractionFallback | undefined;
  checklistItems?: ExecutionChecklistIssue[] | undefined;
};

export type RuntimeInteractionResponse = {
  selected: string[];
  freeText: string;
  source: "user" | "lead" | "timeout" | "cancel";
};

export type Runtime = {
  handleMessage: (message: unknown) => Promise<void>;
  attachWebview: (webview: RuntimeWebview) => vscode.Disposable;
  getState: () => PanelState;
  getSelectedPipelineSnapshot: () => PipelineSnapshot | undefined;
  pipelineRequiresInitiative: (pipelineId?: string) => boolean;
  loadTranscript: () => Promise<TranscriptEntry[]>;
  inspectReadiness: (pipelineIds?: string[]) => Promise<RuntimeReadinessReport>;
  refreshPipelines: (change?: PipelineCatalogChange) => Promise<void>;
  configure: (configuration: RuntimeConfiguration) => Promise<void>;
  getResourceDependencyProvenance: () => ReturnType<typeof resourceDependencyProvenance>;
  preflightPipeline: (
    prompt: string,
    attachmentIds?: string[],
    pipelineSnapshot?: PipelineSnapshot,
    options?: { requireCurrentCatalog?: boolean; composerAuthorized?: boolean },
  ) => Promise<PipelineSnapshot>;
  pipelineRunRefusal: () => string | undefined;
  resolvePipelineSnapshotInScope: (
    scopeRoot: string,
    pipelineId: string,
    options?: {
      requireCurrentCatalog?: boolean;
      unattended?: boolean;
      rejectChecklist?: boolean;
    },
  ) => Promise<PipelineSnapshot>;
  resolvePipelineSnapshot: (
    pipelineId: string,
    options?: {
      requireCurrentCatalog?: boolean;
      unattended?: boolean;
      rejectChecklist?: boolean;
    },
  ) => Promise<PipelineSnapshot>;
  resetSessions: () => Promise<void>;
  runPipeline: (
    prompt: string,
    attachmentIds?: string[],
    options?: {
      onAccepted?: () => Promise<void> | void;
      appendPrompt?: boolean;
      sourceQueueMessageId?: string;
      pipelineSnapshot?: PipelineSnapshot;
      requireCurrentCatalog?: boolean;
      allowedPaths?: string[];
      writeScope?: WorkspaceWriteScope;
      commitMode?: "never" | "allow";
      trackWorkspaceChanges?: boolean;
    },
  ) => Promise<PipelineRunResult>;
  resumePipeline: (options?: {
    onAccepted?: () => Promise<void> | void;
  }) => Promise<PipelineRunResult>;
  interrupt: () => Promise<void>;
  answerSemanticQuestionWithLead: (
    originAgentId: string,
    request: {
      title: string;
      prompt: string;
      options: RuntimeInteractionOption[];
      allowFreeText: boolean;
    },
  ) => Promise<RuntimeInteractionResponse>;
  isBusy: () => boolean;
  flush: () => Promise<void>;
  shutdownIdleProviders: () => Promise<void>;
  dispose: () => Promise<void>;
};

export type RuntimeReadinessReport = {
  selectedPipelineId?: string;
  pipelines: PipelineReadiness[];
  pipelineNames: Record<string, string>;
  pipelineProviders: Record<string, string[]>;
  disabledProviders: string[];
  preferredProvider: string;
  codexWorkspaceScope: CodexWorkspaceScope;
  pipelineSafetyLevels: Record<string, ExecutionSafetyLevel>;
  pipelineGuardrails: Record<string, GuardrailSummary>;
  workspaceRoots: string[];
  workingDirectory?: string;
  trusted: boolean;
  remoteName?: string;
  catalogError?: string;
  adapters: AdapterReadiness[];
  git: {
    available: boolean;
    detail: string;
    clean?: boolean;
    statusDetail?: string;
    dirtyPaths?: string[];
  };
  bridge: PanelState["browserBridge"];
};

export type RuntimeWebview = {
  postMessage: (message: ExtensionToWebviewMessage) => PromiseLike<boolean>;
};

export type RuntimeOptions = {
  ownerId?: string | undefined;
  storageKey?: string | undefined;
  legacyStorageKeys?: string[] | undefined;
  storageDirectory?: string | undefined;
  pipelineStorageDirectory?: string | undefined;
  pipelineScopeRoot?: string | undefined;
  bridge?: BrowserBridgeServer | undefined;
  startBridge?: boolean | undefined;
  closeBridge?: boolean | undefined;
  managedWorkingDirectoryRoot?: string | undefined;
  unattendedOrchestration?: boolean | undefined;
  recordedRunSettings?: RunSettingsSnapshot | undefined;
  rejectedRecordedRunSettings?: RunSettingRejection[] | undefined;
  assertWritable?: (() => void) | undefined;
  withWorkspaceMutation?: WorkspaceMutationRunner | undefined;
  withPipelineCatalogMutation?: PipelineCatalogMutationRunner | undefined;
  preflightChecklistExecution?: (request: {
    workingDirectory: string;
    allowedDirtyPaths: string[];
  }) => Promise<void>;
  observeResourceDependencies?: (
    dependencies: readonly { id: string; kind: string; name: string }[],
  ) => Promise<ResourceAvailability[]>;
  onPipelineCatalogChanged?: ((change: PipelineCatalogChange) => Promise<void> | void) | undefined;
  requestInteraction?: (
    request: RuntimeInteractionRequest,
  ) => Promise<RuntimeInteractionResponse>;
  executeChecklist?: ((request: ExecuteChecklistRequest) => Promise<ExecuteChecklistResult>) | undefined;
  getProviderChatTitle?: ((agentId: string) => string | undefined) | undefined;
  onPipelineStep?: ((event: {
    step: PipelineStep;
    index: number;
    round?: number | undefined;
  }) => void) | undefined;
  onPipelineOutput?: ((artifact: StepOutputArtifact) => void) | undefined;
  onPipelineDecision?: ((artifact: DecisionArtifact) => void) | undefined;
  onRolesChanged?: ((roles: Record<string, AgentId>) => void) | undefined;
  onAgentState?: ((agentId: string, state: AgentPanelState) => void) | undefined;
  executeQueuedPipeline?: (
    request: {
      queueMessageId: string;
      pipelineId: string;
      pipelineSnapshot: PipelineSnapshot;
      prompt: string;
      attachmentIds: string[];
      iterationCount: number;
      iterationMode?: "fixed" | "untilClean" | undefined;
      requiredCleanPasses?: number | undefined;
      composerAuthorized?: boolean | undefined;
    },
    onAccepted: () => Promise<void>,
  ) => Promise<void>;
  executeQueuedDirect?: (
    request: {
      queueMessageId: string;
      recipients: AgentId[];
      prompt: string;
      mode: InteractionMode;
      attachmentIds: string[];
    },
    onAccepted: () => Promise<void>,
  ) => Promise<void>;
};

type PersistedAgentState = Pick<AgentPanelState, "version" | "sessionId" | "browserBinding">;

type PersistedQueueStart = {
  messageId: string;
  claimedAt: string;
};

type PersistedRuntimeState = {
  taskId?: string | undefined;
  workingDirectory?: string | undefined;
  selectedPipelineId?: string | undefined;
  selectedPipelineSnapshot?: PipelineSnapshot | undefined;
  taskDirty: boolean;
  agents: Record<string, PersistedAgentState>;
  attachments: AttachmentMetadata[];
  queuedMessages: QueuedMessage[];
  queuePaused: boolean;
  queueStart?: PersistedQueueStart | undefined;
  resumableWorkflow?: PersistedResumableWorkflow | undefined;
  managedPairCheckpoints: ManagedPairCheckpoint[];
  legacyRecoveryWarning?: string | undefined;
  legacyTranscript: TranscriptEntry[];
};

type PersistedRuntimeValue = Omit<
  PersistedRuntimeState,
  "legacyTranscript" | "legacyRecoveryWarning"
>;
type PersistedRuntimePatch = Partial<PersistedRuntimeValue>;

type ApprovalResolver = {
  agentId: AgentId;
  taskId: string;
  operationOwnerId?: string | undefined;
  approval: PendingApproval;
  resolve: (choiceId: string) => void;
};

type GateResolver = {
  resolve: (decision: HumanGateDecision) => void;
};

const defaultStorageKey = "bachata.runtimeState.v5";
/**
 * PAIR-ID-01. A legacy key list is a record of what shipped, not of what the product is called.
 *
 * The `pair` to `bachata` rename rewrote these entries along with everything else, and that turned
 * a historical record into a list of names no shipped build ever wrote: a user upgrading from a
 * released version has `pair.runtimeState.v4` in workspace state and nothing named `bachata`
 * anything. `llmPipeline.runtimeState.v2` survived the rename untouched, which is the proof —
 * a name is on this list because a version once wrote it, not because it matches the current one.
 *
 * So both spellings are read, newest version first and the current spelling first within a
 * version. This decides nothing about the product's identity, which is PAIR-ID-01's to decide:
 * it is correct whichever name that question resolves to, because the versions below the active
 * one can never become the active name again.
 */
const defaultLegacyStorageKeys = [
  "bachata.runtimeState.v4",
  "pair.runtimeState.v4",
  "bachata.runtimeState.v3",
  "pair.runtimeState.v3",
  "llmPipeline.runtimeState.v2",
  "bachata.runtimeState.v2",
  "pair.runtimeState.v2",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

type McpFormField = {
  key: string;
  title: string;
  description?: string;
  type: "string" | "number" | "integer" | "boolean";
  required: boolean;
  secret: boolean;
  values?: Array<{ label: string; value: JsonValue }>;
  defaultValue?: JsonValue;
};

const primitiveJsonValue = (value: unknown): JsonValue | undefined =>
  value === null ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"
    ? value as JsonValue
    : undefined;

const parseMcpFormSchema = (
  value: JsonValue | undefined,
): McpFormField[] | undefined => {
  if (!isRecord(value) || value.type !== "object" || !isRecord(value.properties)) {
    return undefined;
  }
  const entries = Object.entries(value.properties);
  if (entries.length < 1 || entries.length > 20) {
    return undefined;
  }
  const required = new Set(
    Array.isArray(value.required)
      ? value.required.filter((item): item is string => typeof item === "string")
      : [],
  );
  const fields: McpFormField[] = [];
  for (const [key, rawProperty] of entries) {
    if (!key || !isRecord(rawProperty)) {
      return undefined;
    }
    const rawType = rawProperty.type;
    if (
      rawType !== "string" &&
      rawType !== "number" &&
      rawType !== "integer" &&
      rawType !== "boolean"
    ) {
      return undefined;
    }
    let values: Array<{ label: string; value: JsonValue }> | undefined;
    if (rawProperty.enum !== undefined) {
      if (!Array.isArray(rawProperty.enum) || rawProperty.enum.length < 1) {
        return undefined;
      }
      values = [];
      for (const rawValue of rawProperty.enum) {
        const parsed = primitiveJsonValue(rawValue);
        if (parsed === undefined) {
          return undefined;
        }
        values.push({ label: String(parsed), value: parsed });
      }
    }
    const defaultValue = primitiveJsonValue(rawProperty.default);
    fields.push({
      key,
      title:
        typeof rawProperty.title === "string" && rawProperty.title.trim()
          ? rawProperty.title.trim()
          : key,
      ...(typeof rawProperty.description === "string" && rawProperty.description.trim()
        ? { description: rawProperty.description.trim() }
        : {}),
      type: rawType,
      required: required.has(key),
      secret:
        rawProperty.format === "password" ||
        rawProperty.writeOnly === true ||
        rawProperty["x-secret"] === true,
      ...(values ? { values } : {}),
      ...(defaultValue === undefined ? {} : { defaultValue }),
    });
  }
  return fields;
};

const browserProviderForAdapterType = (
  adapterType: string,
): BrowserConversationBinding["provider"] | undefined => {
  if (adapterType === "chatgpt-browser") {
    return "chatgpt";
  }
  if (adapterType === "claude-browser") {
    return "claude";
  }
  if (adapterType === "generic-browser") {
    return "generic";
  }
  return undefined;
};

const browserProviderName = (
  provider: BrowserConversationBinding["provider"],
): string => provider === "chatgpt" ? "ChatGPT" : provider === "claude" ? "Claude" : "Generic";

const parseBrowserBinding = (
  value: unknown,
): BrowserConversationBinding | undefined => {
  if (
    !isRecord(value) ||
    (value.provider !== "chatgpt" && value.provider !== "claude" && value.provider !== "generic") ||
    typeof value.conversationUrl !== "string" ||
    !value.conversationUrl ||
    typeof value.conversationIdentity !== "string" ||
    !value.conversationIdentity ||
    (value.preferredTabId !== undefined && !Number.isInteger(value.preferredTabId))
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    conversationUrl: value.conversationUrl,
    conversationIdentity: value.conversationIdentity,
    ...(value.preferredTabId === undefined
      ? {}
      : { preferredTabId: Number(value.preferredTabId) }),
  };
};

const parsePersistedAgent = (
  value: unknown,
): PersistedAgentState | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    version: typeof value.version === "string" ? value.version : undefined,
    sessionId:
      typeof value.sessionId === "string" ? value.sessionId : undefined,
    browserBinding: parseBrowserBinding(value.browserBinding),
  };
};

const parsePersistedAttachment = (
  value: unknown,
): AttachmentMetadata | undefined => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.mimeType !== "string" ||
    typeof value.size !== "number" ||
    typeof value.relativePath !== "string"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
    relativePath: value.relativePath,
  };
};


const parseStringRecord = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.some(([, item]) => typeof item !== "string")) {
    return undefined;
  }
  return Object.fromEntries(entries) as Record<string, string>;
};

const parseOrderedAnswers = (
  value: unknown,
): PipelineResumeState["snapshot"]["previousStepAnswers"] | undefined => {
  if (
    !isRecord(value) ||
    !Array.isArray(value.order) ||
    value.order.some((item) => typeof item !== "string")
  ) {
    return undefined;
  }
  const values = parseStringRecord(value.values);
  if (!values) {
    return undefined;
  }
  return { order: [...value.order] as string[], values };
};


const parsePendingChecklists = (
  value: unknown,
): Record<string, PendingExecutionChecklist> | undefined => {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const result: Record<string, PendingExecutionChecklist> = {};
  for (const [stepId, pending] of Object.entries(value)) {
    if (
      !isRecord(pending) ||
      typeof pending.agentId !== "string" ||
      typeof pending.answer !== "string" ||
      !Array.isArray(pending.issues)
    ) {
      return undefined;
    }
    const issues: ExecutionChecklistIssue[] = [];
    for (const issue of pending.issues) {
      if (
        !isRecord(issue) ||
        typeof issue.id !== "string" ||
        typeof issue.title !== "string" ||
        typeof issue.details !== "string" ||
        !Array.isArray(issue.dependencies) ||
        issue.dependencies.some((item) => typeof item !== "string") ||
        !Array.isArray(issue.paths) ||
        issue.paths.some((item) => typeof item !== "string")
      ) {
        return undefined;
      }
      issues.push({
        id: issue.id,
        title: issue.title,
        details: issue.details,
        dependencies: [...issue.dependencies] as string[],
        paths: [...issue.paths] as string[],
      });
    }
    result[stepId] = {
      agentId: pending.agentId,
      answer: pending.answer,
      issues,
    };
    if (executionChecklistValidationErrors(issues).length > 0) {
      return undefined;
    }
  }
  return result;
};

const parsePipelineResumeState = (
  value: unknown,
): PipelineResumeState | undefined => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.nextStepIndex) ||
    Number(value.nextStepIndex) < 0 ||
    !isRecord(value.snapshot)
  ) {
    return undefined;
  }
  const roles = parseStringRecord(value.snapshot.roles);
  const previousStepAnswers = parseOrderedAnswers(
    value.snapshot.previousStepAnswers,
  );
  const latestAnswers = parseStringRecord(value.snapshot.latestAnswers) ??
    previousStepAnswers?.values;
  const latestInterventions = parseOrderedAnswers(
    value.snapshot.latestInterventions,
  );
  const pendingChecklists = parsePendingChecklists(value.snapshot.pendingChecklists);
  if (
    !roles ||
    !latestAnswers ||
    !previousStepAnswers ||
    !latestInterventions ||
    !pendingChecklists ||
    (value.snapshot.answers !== undefined && !isRecord(value.snapshot.answers))
  ) {
    return undefined;
  }
  const answers: Record<string, Record<string, string>> = {};
  for (const [stepId, answerValue] of Object.entries(value.snapshot.answers ?? {})) {
    const parsed = parseStringRecord(answerValue);
    if (!parsed) {
      return undefined;
    }
    answers[stepId] = parsed;
  }
  return {
    version: 1,
    nextStepIndex: Number(value.nextStepIndex),
    snapshot: {
      roles,
      answers,
      latestAnswers,
      previousStepAnswers,
      latestInterventions,
      outputs: isRecord(value.snapshot.outputs)
        ? value.snapshot.outputs as PipelineResumeState["snapshot"]["outputs"]
        : {},
      decisions: isRecord(value.snapshot.decisions)
        ? value.snapshot.decisions as PipelineResumeState["snapshot"]["decisions"]
        : {},
      namedOutputs: isRecord(value.snapshot.namedOutputs)
        ? value.snapshot.namedOutputs as PipelineResumeState["snapshot"]["namedOutputs"]
        : {},
      pendingChecklists,
    },
  };
};

const compactPipelineCheckpoint = (
  checkpoint: PipelineResumeState,
): PipelineResumeState => ({
  ...checkpoint,
  snapshot: {
    ...checkpoint.snapshot,
    answers: {},
    latestAnswers: { ...checkpoint.snapshot.previousStepAnswers.values },
  },
});

const parseQueuedMessage = (value: unknown): QueuedMessage | undefined => {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !new Set(["pipeline", "direct"]).has(String(value.kind)) ||
    typeof value.prompt !== "string" ||
    (value.pipelineId !== undefined && typeof value.pipelineId !== "string") ||
    (value.kind === "pipeline" && typeof value.pipelineId !== "string") ||
    !Array.isArray(value.recipients) ||
    value.recipients.some((item) => typeof item !== "string") ||
    !new Set(["review", "implementation"]).has(String(value.mode)) ||
    !Array.isArray(value.attachmentIds) ||
    value.attachmentIds.some((item) => typeof item !== "string") ||
    (value.allowedPaths !== undefined && (!Array.isArray(value.allowedPaths) || value.allowedPaths.some((item) => typeof item !== "string"))) ||
    (value.iterationCount !== undefined &&
      (typeof value.iterationCount !== "number" ||
        !Number.isSafeInteger(value.iterationCount) ||
        value.iterationCount < 1 ||
        value.iterationCount > 50)) ||
    (value.iterationMode !== undefined && value.iterationMode !== "fixed" && value.iterationMode !== "untilClean") ||
    (value.requiredCleanPasses !== undefined &&
      (typeof value.requiredCleanPasses !== "number" ||
        !Number.isSafeInteger(value.requiredCleanPasses) ||
        value.requiredCleanPasses < 1 ||
        value.requiredCleanPasses > 10)) ||
    (value.composerAuthorized !== undefined && typeof value.composerAuthorized !== "boolean") ||
    typeof value.createdAt !== "string"
  ) {
    return undefined;
  }
  const pipelineSnapshot = value.kind === "pipeline"
    ? parsePipelineSnapshot(value.pipelineSnapshot)
    : undefined;
  if (
    value.kind === "pipeline" &&
    value.pipelineSnapshot !== undefined &&
    (!pipelineSnapshot || pipelineSnapshot.definition.id !== value.pipelineId)
  ) {
    return undefined;
  }
  const blockedReason = value.kind === "pipeline" && !pipelineSnapshot
    ? "This queued request predates immutable pipeline snapshots. Cancel it and queue the request again."
    : value.kind === "pipeline" &&
        pipelineSnapshot &&
        !pipelineSnapshotHasCompleteTaskDependencies(pipelineSnapshot)
      ? "This queued request predates immutable task-pipeline snapshots. Cancel it and queue the request again."
      : value.kind === "pipeline" && value.composerAuthorized !== true
        ? "This queued request predates recorded run authorization, so Bachata cannot re-check its execution contract. Cancel it and queue the request again."
        : undefined;
  return {
    id: value.id,
    kind: value.kind as QueuedMessage["kind"],
    ...(typeof value.pipelineId === "string"
      ? { pipelineId: value.pipelineId }
      : {}),
    ...(pipelineSnapshot ? { pipelineSnapshot } : {}),
    ...(blockedReason ? { blockedReason } : {}),
    prompt: value.prompt,
    recipients: [...value.recipients] as string[],
    mode: value.mode as InteractionMode,
    attachmentIds: [...value.attachmentIds] as string[],
    ...(typeof value.iterationCount === "number" ? { iterationCount: value.iterationCount } : {}),
    ...(value.composerAuthorized === true ? { composerAuthorized: true } : {}),
    ...(value.iterationMode === "fixed" || value.iterationMode === "untilClean"
      ? { iterationMode: value.iterationMode }
      : {}),
    ...(typeof value.requiredCleanPasses === "number"
      ? { requiredCleanPasses: value.requiredCleanPasses }
      : {}),
    createdAt: value.createdAt,
  };
};

const parsePersistedQueueStart = (
  value: unknown,
): PersistedQueueStart | undefined => {
  if (
    !isRecord(value) ||
    typeof value.messageId !== "string" ||
    typeof value.claimedAt !== "string"
  ) {
    return undefined;
  }
  return {
    messageId: value.messageId,
    claimedAt: value.claimedAt,
  };
};

const parsePersistedResumableWorkflow = (
  value: unknown,
): PersistedResumableWorkflow | undefined => {
  if (
    !isRecord(value) ||
    typeof value.pipelineId !== "string" ||
    typeof value.pipelineName !== "string" ||
    typeof value.pipelineHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.pipelineHash) ||
    typeof value.userPrompt !== "string" ||
    !Array.isArray(value.attachmentIds) ||
    value.attachmentIds.some((item) => typeof item !== "string") ||
    (value.writeScope !== undefined && !["task", "configured", "workspace", "readOnly"].includes(String(value.writeScope))) ||
    (value.commitMode !== undefined && value.commitMode !== "never" && value.commitMode !== "allow") ||
    !Number.isSafeInteger(value.nextStepIndex) ||
    !Number.isSafeInteger(value.totalSteps) ||
    typeof value.updatedAt !== "string"
  ) {
    return undefined;
  }
  const persistedRunSettings = parseRunSettings(value.runSettings);
  const checkpoint = parsePipelineResumeState(value.checkpoint);
  const pipelineSnapshot = parsePipelineSnapshot(value.pipelineSnapshot);
  if (
    !checkpoint ||
    !pipelineSnapshot ||
    pipelineSnapshot.definition.id !== value.pipelineId ||
    pipelineSnapshot.definition.name !== value.pipelineName ||
    pipelineSnapshot.hash !== value.pipelineHash ||
    pipelineSnapshot.definition.steps.length !== value.totalSteps ||
    !pipelineSnapshotHasCompleteTaskDependencies(pipelineSnapshot)
  ) {
    return undefined;
  }
  return {
    pipelineId: value.pipelineId,
    pipelineName: value.pipelineName,
    pipelineHash: value.pipelineHash,
    userPrompt: value.userPrompt,
    attachmentIds: [...value.attachmentIds] as string[],
    nextStepIndex: Number(value.nextStepIndex),
    totalSteps: Number(value.totalSteps),
    updatedAt: value.updatedAt,
    checkpoint,
    pipelineSnapshot,
    ...(persistedRunSettings.snapshot === undefined
      ? {}
      : { runSettings: persistedRunSettings.snapshot }),
    ...(persistedRunSettings.rejected.length === 0
      ? {}
      : { rejectedRunSettings: persistedRunSettings.rejected }),
    ...(Array.isArray(value.allowedPaths) ? { allowedPaths: [...value.allowedPaths] as string[] } : {}),
    ...(["task", "configured", "workspace", "readOnly"].includes(String(value.writeScope))
      ? { writeScope: value.writeScope as WorkspaceWriteScope }
      : {}),
    ...(value.commitMode === "never" || value.commitMode === "allow" ? { commitMode: value.commitMode } : {}),
    ...(typeof value.sourceQueueMessageId === "string"
      ? { sourceQueueMessageId: value.sourceQueueMessageId }
      : {}),
  };
};

const parsePersistedRuntimeState = (
  value: unknown,
): PersistedRuntimeState | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const resumableWorkflow = parsePersistedResumableWorkflow(value.resumableWorkflow);
  const legacyRecoveryWarning = value.resumableWorkflow !== undefined && !resumableWorkflow
    ? "A saved workflow checkpoint could not be verified against an immutable pipeline snapshot and was not resumed. The previous prompt remains in history."
    : undefined;
  const managedPairCheckpoints = Array.isArray(value.managedPairCheckpoints)
    ? value.managedPairCheckpoints
        .map(parseManagedPairCheckpoint)
        .filter((item): item is ManagedPairCheckpoint => Boolean(item))
    : [];
  const agents: Record<string, PersistedAgentState> = {};
  if (isRecord(value.agents)) {
    Object.entries(value.agents).forEach(([agentId, item]) => {
      const parsed = parsePersistedAgent(item);
      if (parsed) {
        agents[agentId] = parsed;
      }
    });
  }
  return {
    taskId: typeof value.taskId === "string" && value.taskId ? value.taskId : undefined,
    workingDirectory:
      typeof value.workingDirectory === "string"
        ? value.workingDirectory
        : undefined,
    selectedPipelineId:
      typeof value.selectedPipelineId === "string"
        ? value.selectedPipelineId
        : undefined,
    selectedPipelineSnapshot: parsePipelineSnapshot(value.selectedPipelineSnapshot),
    taskDirty: value.taskDirty === true,
    agents,
    attachments: Array.isArray(value.attachments)
      ? value.attachments
          .map(parsePersistedAttachment)
          .filter((item): item is AttachmentMetadata => Boolean(item))
      : [],
    queuedMessages: Array.isArray(value.queuedMessages)
      ? value.queuedMessages
          .map(parseQueuedMessage)
          .filter((item): item is QueuedMessage => Boolean(item))
      : [],
    queuePaused: value.queuePaused === true,
    queueStart: parsePersistedQueueStart(value.queueStart),
    resumableWorkflow,
    managedPairCheckpoints,
    ...(legacyRecoveryWarning ? { legacyRecoveryWarning } : {}),
    legacyTranscript: Array.isArray(value.transcript)
      ? value.transcript
          .map(parseTranscriptEntry)
          .filter((item): item is TranscriptEntry => Boolean(item))
      : [],
  };
};

const getWorkspaceRoots = (): string[] =>
  vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];

const createEntry = (
  kind: TranscriptEntry["kind"],
  text: string,
  agentId?: AgentId,
  step?: string,
  eventType?: string,
  data?: JsonValue,
): TranscriptEntry => ({
  id: randomUUID(),
  kind,
  text,
  agentId,
  step,
  createdAt: new Date().toISOString(),
  eventType,
  data,
});

const createEventEntry = (
  eventType: string,
  text: string,
  data?: JsonValue,
  agentId?: AgentId,
  step?: string,
): TranscriptEntry =>
  createEntry("event", text, agentId, step, eventType, data);

const isInside = isPathInsideRoot;

const pipelineSummary = (
  pipeline: PipelineDefinition,
  editable: boolean,
  hash: string,
  scope: PipelineScope,
): PipelineSummary => ({
  id: pipeline.id,
  name: pipeline.name,
  ...(pipeline.description === undefined ? {} : { description: pipeline.description }),
  editable,
  hash,
  scopeKey: editable ? scope.key : "builtin",
  ...(editable && scope.root ? { scopeRoot: scope.root } : {}),
});

const resumableWorkflowSummary = (
  value: PersistedResumableWorkflow,
): ResumableWorkflow => ({
  pipelineId: value.pipelineId,
  pipelineName: value.pipelineName,
  pipelineHash: value.pipelineHash,
  userPrompt: value.userPrompt,
  attachmentIds: [...value.attachmentIds],
  nextStepIndex: value.nextStepIndex,
  totalSteps: value.totalSteps,
  updatedAt: value.updatedAt,
  ...(value.sourceQueueMessageId
    ? { sourceQueueMessageId: value.sourceQueueMessageId }
    : {}),
});

export const createRuntime = (
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  options: RuntimeOptions = {},
): Runtime => {
  const hostCallbacks = options;
  const withWorkspaceMutation: WorkspaceMutationRunner = options.withWorkspaceMutation ?? (async (operation) => {
    hostCallbacks.assertWritable?.();
    return operation();
  });
  const storageKey = options.storageKey ?? defaultStorageKey;
  const runtimeOwnerId = options.ownerId ?? storageKey;
  const legacyStorageKeys =
    options.legacyStorageKeys ??
    (options.storageKey ? [] : defaultLegacyStorageKeys);
  const currentPersistedValue = context.workspaceState.get<unknown>(storageKey);
  const legacyPersistedEntry = legacyStorageKeys
    .map((key) => ({ key, value: context.workspaceState.get<unknown>(key) }))
    .find((entry) => entry.value !== undefined);
  const persistedValue = currentPersistedValue ?? legacyPersistedEntry?.value;
  const persisted = parsePersistedRuntimeState(persistedValue);
  const storageDirectory =
    options.storageDirectory ??
    (context.storageUri ?? context.globalStorageUri).fsPath;
  const pipelineStorageDirectory =
    options.pipelineStorageDirectory ?? path.join(storageDirectory, "pipelines");
  const configuredPipelineScopeRoot = options.pipelineScopeRoot
    ? path.resolve(options.pipelineScopeRoot)
    : undefined;
  const resolvePipelineScope = (
    workingDirectory: string | undefined,
    workspaceRoots: string[],
  ): Promise<PipelineScope> => resolveCanonicalPipelineScope({
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    workspaceRoots,
    configuredRoot: configuredPipelineScopeRoot,
    extensionDirectory: pipelineStorageDirectory,
  });
  const initialWorkspaceRoots = getWorkspaceRoots();
  const initialWorkingDirectory = persisted?.workingDirectory ?? initialWorkspaceRoots.at(0);
  const initialPipelineDirectory = path.resolve(pipelineStorageDirectory);
  let activePipelineScope: PipelineScope = {
    key: `extension:${initialPipelineDirectory}`,
    directory: initialPipelineDirectory,
  };
  const logOutput = (message: string): void => output.appendLine(redactText(message));
  const initialConfiguration = vscode.workspace.getConfiguration("bachata");
  const transcriptStore = createTranscriptStore(storageDirectory, logOutput, {
    maxEntries: initialConfiguration.get<number>("transcriptMaxEntries", 2_000),
    maxFileBytes: initialConfiguration.get<number>("transcriptMaxFileBytes", 2 * 1024 * 1024),
    maxTextBytes: initialConfiguration.get<number>("transcriptPreviewBytes", 8 * 1024),
    maxDataBytes: initialConfiguration.get<number>("transcriptDataBytes", 16 * 1024),
    withMutation: withWorkspaceMutation,
  });
  const attachmentStore = createAttachmentStore(storageDirectory, {
    withMutation: withWorkspaceMutation,
  });
  const webviews = new Set<RuntimeWebview>();
  const pipelines = new Map<string, PipelineDefinition>();
  const builtInPipelines = new Map<string, PipelineDefinition>();
  // Published only when the whole preset directory has been read. Reading "loaded" off the map
  // size let a failed read leave a partial catalog behind and call it complete.
  let builtInPipelinesLoaded = false;
  const pipelineHashes = new Map<string, string>();
  const customPipelineIds = new Set<string>();
  const customPipelineFiles = new Map<string, string>();
  // The same four instances the catalog module refills; other closures here hold them directly,
  // so a reload must not replace them.
  const pipelineCatalog: PipelineCatalogMaps = {
    pipelines,
    hashes: pipelineHashes,
    customIds: customPipelineIds,
    customFiles: customPipelineFiles,
  };
  let pipelineCatalogError: string | undefined;
  const registry = createAdapterRegistry();
  const customPipelineStorageKey = "bachata.customPipelines.v1";
  let adapters: Record<string, AgentAdapter> = {};
  let definitions: Record<string, AgentDefinition> = {};
  const abortControllers = new Map<
    AgentId,
    { ownerId: string; taskId: string; controller: AbortController }
  >();
  const activeCompletions = new Map<
    AgentId,
    { ownerId: string; completion: Promise<void> }
  >();
  const agentReservations = new Map<AgentId, string>();
  const foregroundOperations = new Set<Promise<void>>();
  const foregroundControllers = new Set<AbortController>();
  const foregroundReservations = new Map<
    AgentId,
    {
      ownerId: string;
      controller: AbortController;
      completion: Promise<void>;
    }
  >();
  const approvalResolvers = new Map<string, ApprovalResolver>();
  const deltaBuffers = new Map<AgentId, string>();
  const deltaTimers = new Map<AgentId, NodeJS.Timeout>();
  const managedPairCheckpoints = new Map<string, ManagedPairCheckpoint>(
    (persisted?.managedPairCheckpoints ?? []).map((checkpoint) => [checkpoint.taskId, checkpoint]),
  );
  let workflowController: AbortController | undefined;
  let programmaticAutoProvisioning = false;
  const programmaticResetBindings = new Map<AgentId, BrowserConversationBinding>();
  const managedFreshSessionKeys = new Set<string>();
  // P3. The managed local review state of the task that is running: how many times a Lead has
  // sent it back to its Worker — one budget whether the cause was failing controller verification
  // or the Lead's own structured rejection, because a task sent back twice has been sent back
  // twice — and what a rejected Worker is owed on its next turn. It belongs to one task and is
  // discarded when the task changes or ends; `managedTaskState.ts` says why that is a shape and
  // not a rule.
  const managedTaskState = createManagedTaskState();
  let activeWorkflow: Promise<void> | undefined;
  let lastPipelineResult: PipelineRunResult | undefined;
  let workflowActive = false;
  let gateResolver: GateResolver | undefined;
  let gateDecisionActive = false;
  let pendingGateInterventions: PipelineIntervention[] = [];
  let checkingAvailability = false;
  let pickingWorkingDirectory = false;
  let disposed = false;
  let disposeOperation: Promise<void> | undefined;
  let workspaceChangeOperation: Promise<void> | undefined;
  let initializationError: Error | undefined;
  let mutationQueue = Promise.resolve();
  let queueTransitionQueue = Promise.resolve();
  const pipelineCatalogMutationRunner: PipelineCatalogMutationRunner =
    options.withPipelineCatalogMutation ?? (async (_catalogDirectory, operation) => operation());
  const withPipelineCatalogMutation = <T>(
    scope: PipelineScope,
    operation: () => Promise<T>,
  ): Promise<T> => pipelineCatalogMutationRunner(
    scope.directory,
    () => withPipelineCatalogFileLock(scope, operation, {
      timeoutMs: Math.max(
        1_000,
        readTimeoutSetting((settingKey, settingFallback) => initialConfiguration.get(settingKey, settingFallback), "pipelineCatalogFileLockTimeoutMs", 10_000),
      ),
      staleMs: Math.max(
        10_000,
        initialConfiguration.get<number>("pipelineCatalogFileLockStaleMs", 60_000),
      ),
    }),
  );
  let mutationActive = false;
  let activeForegroundOperations = 0;
  let attachmentUseCount = 0;
  let queueDraining = false;
  let queueDrainOperation: Promise<void> | undefined;
  let scheduleQueueDrain: () => void = () => undefined;
  const enqueueCodexInteraction = createInteractionQueue();
  let taskDirty = persisted?.taskDirty ?? false;
  let queueStartClaim = persisted?.queueStart;
  let selectedPipelineSnapshot = persisted?.selectedPipelineSnapshot;
  let readinessAdapterProbes: AdapterReadiness[] = [];
  let providerRuntimeVersions: Record<string, string> = {};
  let readinessGit: RuntimeReadinessReport["git"] = {
    available: false,
    detail: "Git has not been checked",
  };

  let resumableWorkflowData = persisted?.resumableWorkflow;

  const state: PanelState = {
    taskId: persisted?.taskId ?? randomUUID(),
    workspaceRoots: initialWorkspaceRoots,
    ...(initialWorkingDirectory === undefined
      ? {}
      : { workingDirectory: initialWorkingDirectory }),
    trusted: vscode.workspace.isTrusted,
    pipelines: [],
    readiness: {
      status: "needsSetup",
      findings: [],
    },
    pipelineScopeKey: activePipelineScope.key,
    ...(activePipelineScope.root === undefined
      ? {}
      : { pipelineScopeRoot: activePipelineScope.root }),
    pipelineMutable: true,
    advancedMode: false,
    browserActionPolicies: {
      readOnly: "ask",
      mutation: "ask",
      destructive: "ask",
      shell: "disabled",
    },
    adapterTypes: registry.types(),
    agents: {},
    roles: {},
    running: false,
    workflowStatus: resumableWorkflowData ? "interrupted" : "idle",
    transcript: [],
    transcriptTotal: 0,
    transcriptHasMore: false,
    transcriptWindowSize: Math.max(
      50,
      initialConfiguration.get<number>("transcriptWindowSize", 300),
    ),
    approvals: [],
    attachments: persisted?.attachments ?? [],
    maxAttachmentBytes: initialConfiguration.get<number>("maxAttachmentBytes", 20_971_520),
    maxAttachmentCount: initialConfiguration.get<number>("maxAttachmentCount", 20),
    maxAttachmentTotalBytes: initialConfiguration.get<number>("maxAttachmentTotalBytes", 52_428_800),
    queuedMessages: persisted?.queuedMessages ?? [],
    queuePaused: Boolean(persisted?.queuedMessages.length),
    ...(resumableWorkflowData
      ? { resumableWorkflow: resumableWorkflowSummary(resumableWorkflowData) }
      : {}),
    browserBridge: {
      enabled: vscode.env.remoteName === undefined,
      connected: false,
      sessions: [],
      ...(vscode.env.remoteName === undefined
        ? {}
        : { error: "Browser Bridge is disabled in remote VS Code workspaces" }),
    },
  };

  /**
   * The panel state for an agent that this runtime configured.
   *
   * Every caller below reaches an agent id through the configured set — a message names one
   * the panel is showing, or a loop walks the ids the runtime just installed. A miss means
   * the agent map and the id that reached it disagree, which is a failure rather than
   * something to work around at each of the two dozen call sites.
   */
  const agentStateFor = (agentId: string): AgentPanelState => {
    const agent = state.agents[agentId];
    if (!agent) {
      throw new Error(`Unknown agent ${agentId}`);
    }
    return agent;
  };

  /** The adapter for a configured agent, on the same terms. */
  const adapterFor = (agentId: string): AgentAdapter => {
    const adapter = adapters[agentId];
    if (!adapter) {
      throw new Error(`Unknown agent ${agentId}`);
    }
    return adapter;
  };


  // While a run holds a settings snapshot, every pinned setting resolves from it. This is the
  // one place the runtime reads configuration, so a continuation cannot pick up a live edit
  // the run never executed under. Authority settings are deliberately absent from the
  // snapshot's pinned values and therefore still resolve live.
  let activeRunSettings: RunSettingsSnapshot | undefined;

  const pinnedConfiguration = (
    live: vscode.WorkspaceConfiguration,
    snapshot: RunSettingsSnapshot,
  ): vscode.WorkspaceConfiguration => ({
    get: <T>(section: string, defaultValue?: T): T | undefined => {
      const pinned = pinnedRunSetting(snapshot, section);
      if (pinned !== undefined) return pinned as unknown as T;
      return defaultValue === undefined ? live.get<T>(section) : live.get<T>(section, defaultValue);
    },
    has: (section: string) => typeof live.has === "function" && live.has(section),
    // A scoped read asks which scope set a value, not what the effective value is. The snapshot
    // records effective values only, so answering a scoped read from it would report a manifest
    // default as a user setting and suppress the provider-specific fallback that depends on the
    // setting being unset. Scoped reads therefore always go live.
    inspect: <T>(section: string) =>
      typeof live.inspect === "function" ? live.inspect<T>(section) : undefined,
    update: (section, value, target, overrideInLanguage) =>
      live.update(section, value, target, overrideInLanguage),
  });

  const configuration = (): vscode.WorkspaceConfiguration => {
    const live = vscode.workspace.getConfiguration("bachata");
    return activeRunSettings ? pinnedConfiguration(live, activeRunSettings) : live;
  };

  const liveConfigurationReader: SettingsReader = <T>(key: string, fallback: T): T =>
    vscode.workspace.getConfiguration("bachata").get<T>(key, fallback);

  // A replayed run is created with the settings its source recorded, so its first run executes
  // on those values rather than on whatever the workspace holds now.
  let recordedRunSettings = options.recordedRunSettings;
  let rejectedRecordedRunSettings = options.rejectedRecordedRunSettings ?? [];

  // Only pinned values are ever restored. Authority controls, the recorded-only settings and
  // the secret-reference list always describe THIS run and are rebuilt from live settings, so a
  // snapshot that arrived from somewhere else can neither weaken a control nor make this run
  // record someone else's configuration as its own. A pinned key the snapshot omits falls back
  // to the live value, and parseRunSettings reports that omission.
  const beginRunSettings = (snapshot?: RunSettingsSnapshot): RunSettingsSnapshot => {
    const restored = snapshot ?? recordedRunSettings;
    recordedRunSettings = undefined;
    const live = captureRunSettings(liveConfigurationReader);
    activeRunSettings = restored === undefined
      ? live
      : { ...live, values: { ...live.values, ...restored.values } };
    return activeRunSettings;
  };

  const endRunSettings = (): void => {
    activeRunSettings = undefined;
  };

  // What the run is executing under, right now. Pinned values stay as the run started with them;
  // authority controls, recorded-only settings and the secret-reference list are re-read, so a
  // control the human changed mid-run is never published as though the run still held the old
  // one. Outside a run there is nothing pinned and this is simply the live settings.
  const effectiveRunSettings = (): RunSettingsSnapshot => {
    const live = captureRunSettings(liveConfigurationReader);
    return activeRunSettings === undefined
      ? live
      : { ...live, values: { ...activeRunSettings.values } };
  };

  const hasDurableTaskState = (): boolean =>
    durableTaskState({
      taskDirty,
      transcriptTotal: state.transcriptTotal,
      attachmentCount: state.attachments.length,
      queuedMessageCount: state.queuedMessages.length,
      queueStartClaimed: queueStartClaim !== undefined,
      recoveryCheckpointed: resumableWorkflowData !== undefined,
    });

  const pipelineMutationReason = (): string | undefined =>
    pipelineMutationRefusal({
      ...(pipelineCatalogError === undefined ? {} : { catalogError: pipelineCatalogError }),
      operationInFlight:
        workflowActive || anyAgentRunning() || activeForegroundOperations > 0,
      workflowStatus: state.workflowStatus,
      attachmentCount: state.attachments.length,
      durableTaskState: hasDurableTaskState(),
    });

  const policy = (
    value: string,
    fallback: "auto" | "ask" | "disabled",
  ): "auto" | "ask" | "disabled" =>
    value === "auto" || value === "ask" || value === "disabled" ? value : fallback;

  const refreshRuntimeLimits = (): void => {
    const config = configuration();
    state.maxAttachmentBytes = Math.max(65_536, config.get<number>("maxAttachmentBytes", 20_971_520));
    state.maxAttachmentCount = Math.max(1, config.get<number>("maxAttachmentCount", 20));
    state.maxAttachmentTotalBytes = Math.max(65_536, config.get<number>("maxAttachmentTotalBytes", 52_428_800));
    state.transcriptWindowSize = Math.max(
      50,
      config.get<number>("transcriptWindowSize", 300),
    );
    const mutationReason = pipelineMutationReason();
    state.pipelineMutable = mutationReason === undefined;
    setOptionalProperty(state, "pipelineMutationReason", mutationReason);
    state.advancedMode = config.get<boolean>("advancedMode", false) === true;
    state.browserActionPolicies = {
      readOnly: policy(config.get<string>("browserActionReadOnlyPolicy", "ask"), "ask"),
      mutation: policy(config.get<string>("browserActionMutationPolicy", "ask"), "ask"),
      destructive: policy(config.get<string>("browserActionDestructivePolicy", "ask"), "ask"),
      shell: "disabled",
    };
  };

  const post = (message: ExtensionToWebviewMessage): void => {
    webviews.forEach((webview) => {
      void webview.postMessage(message).then(undefined, (error: unknown) => {
        logOutput(
          `Failed to post webview message: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  };

  const postOperationResult = (
    requestId: string | undefined,
    operation: import("../webview/protocol").RuntimeOperation,
    status: import("../webview/protocol").RuntimeOperationStatus,
    values: { message?: string; pipeline?: PipelineDefinition } = {},
  ): void => {
    if (!requestId) {
      return;
    }
    post({ type: "operation.result", requestId, operation, status, ...values });
  };

  const emitSnapshot = (): void => {
    refreshRuntimeLimits();
    refreshReadiness();
    post({ type: "state.snapshot", state: structuredClone(state) });
  };

  const handleBridgeStatus = (status: BrowserBridgeStatus): void => {
    state.browserBridge = status;
    post({ type: "bridge.patch", status });
    Object.entries(state.agents).forEach(([agentId, agent]) => {
      if (!agent.adapterType.endsWith("-browser") || agent.status === "running") {
        return;
      }
      const provider = browserProviderForAdapterType(agent.adapterType);
      if (!provider) {
        return;
      }
      const providerSessions = status.sessions.filter(
        (session) => session.provider === provider,
      );
      let boundSession;
      let bindingError: string | undefined;
      if (agent.browserBinding) {
        try {
          boundSession = bridge.resolveBoundSession(
            `${runtimeOwnerId}:${agentId}`,
            agent.browserBinding,
            agent.sessionId,
          );
        } catch (error) {
          bindingError = error instanceof Error ? error.message : String(error);
        }
      } else if (agent.sessionId) {
        const exactSession = providerSessions.find(
          (session) => session.id === agent.sessionId,
        );
        if (exactSession) {
          try {
            agent.browserBinding = bridge.bindSession(
              `${runtimeOwnerId}:${agentId}`,
              exactSession.id,
            );
            boundSession = exactSession;
          } catch (error) {
            bindingError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      if (boundSession && boundSession.status === "ready") {
        agent.sessionId = boundSession.id;
        agent.browserBinding = bindingFromSession(boundSession);
      } else if (!boundSession) {
        delete agent.sessionId;
      }
      const readySessions = providerSessions.filter(
        (session) => session.status === "ready",
      );
      const { status: nextStatus, error } = browserAgentBridgeStatus({
        connected: status.connected,
        bridgeError: status.error,
        hasBinding: agent.browserBinding !== undefined,
        boundSessionStatus: boundSession?.status,
        bindingError,
        readySessionCount: readySessions.length,
        providerName: browserProviderName(provider),
      });
      const patch = {
        status: nextStatus,
        error,
        sessionId: agent.sessionId,
        browserBinding: agent.browserBinding,
      };
      agent.status = nextStatus;
      setOptionalProperty(agent, "error", error);
      setOptionalProperty(agent, "sessionId", agent.sessionId);
      setOptionalProperty(agent, "browserBinding", agent.browserBinding);
      post({ type: "agent.patch", agentId, patch });
    });
    refreshReadiness();
    schedulePersist();
  };

  const ownsBridge = options.bridge === undefined;
  const bridge =
    options.bridge ??
    createBrowserBridgeServer({
      enabled: state.browserBridge.enabled,
      secretStore: context.secrets,
      log: logOutput,
      maxMessageBytes: configuration().get<number>(
        "browserBridgeMaxMessageBytes",
        DEFAULT_BROWSER_BRIDGE_MAX_MESSAGE_BYTES,
      ),
      port: configuration().get<number>("browserBridgePort", 43127),
      localModelConfig: () => {
        const endpoint = configuration().get<string>("browserSelectorHealingEndpoint", "").trim();
        return {
          enabled: configuration().get<boolean>("browserSelectorHealingEnabled", false),
          backend: configuration().get<"auto" | "lmstudio" | "ollama">("browserSelectorHealingBackend", "auto"),
          ...(endpoint ? { endpoint } : {}),
          model: configuration().get<string>("browserSelectorHealingModel", "prism-ml/Bonsai-27B-mlx-1bit").trim() || "prism-ml/Bonsai-27B-mlx-1bit",
          timeoutMs: Math.max(1_000, readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "browserSelectorHealingTimeoutMs", 30_000)),
        };
      },
      onStatusChange: handleBridgeStatus,
    });
  const browserSelectorHealingConfigurationSubscription = ownsBridge
    ? vscode.workspace.onDidChangeConfiguration((event) => {
        const keys = [
          "bachata.browserSelectorHealingEnabled",
          "bachata.browserSelectorHealingBackend",
          "bachata.browserSelectorHealingEndpoint",
          "bachata.browserSelectorHealingModel",
          "bachata.browserSelectorHealingTimeoutMs",
        ];
        if (!keys.some((key) => event.affectsConfiguration(key))) return;
        try {
          bridge.refreshLocalModelConfig();
        } catch (error) {
          logOutput(`Failed to refresh Browser Bridge selector-healing configuration: ${error instanceof Error ? error.message : String(error)}`);
        }
      })
    : undefined;
  let bridgeStatusSubscription: { dispose: () => void } | undefined;

  const validatePipeline = createPipelineValidator((pipeline) =>
    registry.validatePipeline(pipeline)
  );

  const snapshotForPipeline = (pipeline: PipelineDefinition): PipelineSnapshot =>
    customPipelineIds.has(pipeline.id)
      ? createPipelineSnapshot(
          pipeline,
          activePipelineScope.key,
          activePipelineScope.root,
        )
      : createPipelineSnapshot(pipeline, "builtin");

  const refreshPipelineState = (): void => {
    state.pipelines = Array.from(pipelines.values()).map((pipeline) =>
      pipelineSummary(
        pipeline,
        customPipelineIds.has(pipeline.id),
        pipelineHashes.get(pipeline.id) ?? pipelineDefinitionHash(pipeline),
        activePipelineScope,
      ),
    );
    setOptionalProperty(state, "selectedPipelineId", selectedPipelineSnapshot?.definition.id);
    setOptionalProperty(
      state,
      "selectedPipelineDefinition",
      selectedPipelineSnapshot
        ? structuredClone(selectedPipelineSnapshot.definition)
        : undefined,
    );
    setOptionalProperty(state, "selectedPipelineHash", selectedPipelineSnapshot?.hash);
    state.pipelineScopeKey = activePipelineScope.key;
    setOptionalProperty(state, "pipelineScopeRoot", activePipelineScope.root);
  };

  const currentAdapterReadiness = (): AdapterReadiness[] => [
    ...readinessAdapterProbes,
    ...Object.entries(state.agents).map(([agentId, agent]) => ({
      agentId,
      type: agent.adapterType,
      available: ["available", "idle", "running"].includes(agent.status),
      capabilities: Object.entries(adapters[agentId]?.capabilities ?? {})
        .filter(([, enabled]) => enabled)
        .map(([capability]) => capability),
      ...(agent.error === undefined ? {} : { detail: agent.error }),
    })),
  ];

  const readinessAllowedDirtyPaths = (pipelineId?: string): string[] => {
    if (!pipelineId || !customPipelineIds.has(pipelineId)) return [];
    const pipeline = pipelines.get(pipelineId);
    const hasChecklistExecution = pipeline?.steps.some(
      (step) => step.enabled && step.type === "executeChecklist",
    );
    return hasChecklistExecution ? [".bachata/pipelines"] : [];
  };

  const disabledProviders = (): string[] =>
    configuration().get<string[]>("disabledProviders", []);

  const preferredProvider = (): string =>
    configuration().get<string>("preferredProvider", "auto");

  const configuredCodexWorkspaceScope = (): CodexWorkspaceScope =>
    configuration().get<CodexWorkspaceScope>("codexWorkspaceScope", "refuseNarrowedScope");

  const evaluatePipelineReadiness = (pipelineId?: string): PipelineReadiness =>
    evaluateReadiness({
      allowedDirtyPaths: readinessAllowedDirtyPaths(pipelineId),
      workspace: {
        trusted: state.trusted,
        roots: state.workspaceRoots,
        ...(readinessGit.detail === "Git has not been checked"
          ? {}
          : { gitAvailable: readinessGit.available }),
        gitDetail: readinessGit.detail,
        gitClean: readinessGit.clean,
        dirtyPaths: readinessGit.dirtyPaths,
      },
      adapters: currentAdapterReadiness(),
      bridge: state.browserBridge,
      remoteName: vscode.env.remoteName,
      selectedRoot: state.workingDirectory,
      catalogError: pipelineCatalogError,
      browserBindings: Object.fromEntries(
        Object.entries(state.agents).map(([agentId, agent]) => [agentId, agent.sessionId]),
      ),
      catalog: Array.from(pipelines.values()),
      selectedPipelineId: pipelineId,
      disabledProviders: disabledProviders(),
      codexWorkspaceScope: configuredCodexWorkspaceScope(),
    });

  let repositoryPolicy: RepositoryPolicy | undefined;
  let repositoryPolicyErrors: string[] = [];

  const refreshRepositoryPolicy = async (): Promise<void> => {
    if (state.workingDirectory === undefined) {
      repositoryPolicy = undefined;
      repositoryPolicyErrors = [];
      return;
    }
    const load = await loadRepositoryPolicy(state.workingDirectory);
    repositoryPolicy = load.policy;
    repositoryPolicyErrors = load.errors;
  };

  const currentExecutionContract = (): ExecutionContract | undefined => {
    const pipeline = state.selectedPipelineId
      ? pipelines.get(state.selectedPipelineId)
      : undefined;
    if (!pipeline) return undefined;
    const config = configuration();
    return buildExecutionContract({
      pipeline,
      readiness: state.readiness,
      ...(state.workingDirectory === undefined ? {} : { workingDirectory: state.workingDirectory }),
      maxIterations: Math.max(1, config.get<number>("maxPipelineIterations", 10)),
      iterations: Math.max(1, config.get<number>("defaultPipelineIterations", 1)),
      agentTurnTimeoutMs: readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "agentTurnTimeoutMs", 30 * 60_000),
      managedTaskTimeoutMs: readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "managedTaskTimeoutMs", 7_200_000),
      browserOperationTimeoutMs: readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "browserOperationTimeoutMs", 1_800_000),
      attachments: state.attachments.map((attachment) => ({
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      })),
      handoffMaxBytes: config.get<number>("browserHandoffTotalBudgetBytes", 262_144),
      continuationMaxBytes: config.get<number>("managedContinuationMaxBytes", 524_288),
      ...(repositoryPolicy === undefined ? {} : { repositoryPolicy }),
      ...(repositoryPolicyErrors.length === 0 ? {} : { repositoryPolicyErrors }),
      runSettings: effectiveRunSettings(),
      providerRuntimeVersions,
    });
  };

  let acknowledgedAuthority: ContractAuthority | undefined;

  const refreshContractAcknowledgement = (): void => {
    setOptionalProperty(
      state,
      "contractAcknowledgement",
      state.executionContract
        ? contractAcknowledgement(state.executionContract, acknowledgedAuthority)
        : undefined,
    );
  };

  const acknowledgeContractAuthority = (fingerprint: string): void => {
    const current = state.contractAcknowledgement;
    if (!current || current.fingerprint !== fingerprint) return;
    acknowledgedAuthority = current.authority;
    refreshContractAcknowledgement();
  };

  const refreshReadiness = (): void => {
    state.readiness = evaluatePipelineReadiness(state.selectedPipelineId);
    setOptionalProperty(state, "executionContract", currentExecutionContract());
    refreshContractAcknowledgement();
  };

  const pipelineFilePath = (directory: string, pipelineId: string): string =>
    path.join(directory, `${pipelineId}.pipeline.json`);

  const readScopedCustomCatalog = async (scope: PipelineScope) => {
    await assertPipelineScopeSafe(scope);
    await reconcilePipelineCatalogArtifacts(scope);
    return await readCustomPipelineCatalog({
      readDirectory: async () =>
        await readdir(scope.directory, { withFileTypes: true }).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return [];
          }
          throw error;
        }),
      resolveFile: (name) => path.join(scope.directory, name),
      readText: async (filePath) => await readCatalogText(scope, filePath),
      validate: validatePipeline,
      isBuiltIn: (pipelineId) => builtInPipelines.has(pipelineId),
    });
  };

  const loadCustomPipelineDirectory = async (scope: PipelineScope): Promise<void> => {
    const result = await readScopedCustomCatalog(scope);
    if (result.error) {
      pipelineCatalogError = result.error;
      logOutput(pipelineCatalogError);
      return;
    }
    pipelineCatalogError = undefined;
    addCustomPipelines(pipelineCatalog, result.loaded);
  };

  const resetPipelineMaps = (): void => {
    resetPipelineCatalog(pipelineCatalog, builtInPipelines);
  };

  const loadBuiltInPipelines = async (): Promise<void> => {
    if (builtInPipelinesLoaded) {
      return;
    }
    const directory = path.join(context.extensionUri.fsPath, "presets");
    const { loaded, quarantined } = await readBuiltInPipelineCatalog({
      readDirectory: () => readdir(directory, { withFileTypes: true }),
      readText: (name) => readFile(path.join(directory, name), "utf8"),
      validate: validatePipeline,
    });
    builtInPipelines.clear();
    loaded.forEach((pipeline, pipelineId) => {
      builtInPipelines.set(pipelineId, pipeline);
    });
    quarantined.forEach((problem) => {
      logOutput(`Quarantined built-in pipeline preset ${problem}`);
    });
    builtInPipelinesLoaded = true;
  };

  const migrateLegacyCustomPipelines = async (): Promise<void> => {
    const plan = planLegacyCustomPipelineMigration(
      context.workspaceState.get<unknown>(customPipelineStorageKey),
      validatePipeline,
      (pipelineId) => builtInPipelines.has(pipelineId),
    );
    if (plan === undefined) {
      return;
    }
    plan.ignored.forEach(logOutput);
    const legacyPipelines = plan.pipelines;
    const migrationScopes = await Promise.all([
      ...state.workspaceRoots.map((root) => resolvePipelineScope(root, [root])),
      resolveCanonicalPipelineScope({
        workspaceRoots: [],
        extensionDirectory: pipelineStorageDirectory,
      }),
    ]);
    const uniqueScopes = Array.from(
      new Map(migrationScopes.map((scope) => [scope.key, scope])).values(),
    );
    let migrationWriteFailed = false;
    for (const scope of uniqueScopes) {
      try {
        await withPipelineCatalogMutation(scope, async () => {
          await assertPipelineScopeSafe(scope);
          for (const pipeline of legacyPipelines) {
            const target = pipelineFilePath(scope.directory, pipeline.id);
            const existing = await readCatalogText(scope, target);
            if (existing !== undefined) {
              continue;
            }
            await withWorkspaceMutation(() =>
              writeCatalogTextIfUnchanged(
                scope,
                target,
                `${JSON.stringify(pipeline, null, 2)}\n`,
                undefined,
              )
            );
          }
        });
      } catch (error) {
        migrationWriteFailed = true;
        logOutput(
          `Could not migrate legacy custom pipelines to ${scope.directory}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (!migrationWriteFailed) {
      await withWorkspaceMutation(() =>
        Promise.resolve(context.workspaceState.update(customPipelineStorageKey, undefined))
      );
    }
  };

  const reloadPipelines = async (
    scope?: PipelineScope,
    migrateLegacy = false,
  ): Promise<void> => {
    await loadBuiltInPipelines();
    const targetScope = scope ?? await resolvePipelineScope(
      state.workingDirectory,
      state.workspaceRoots,
    );
    await assertPipelineScopeSafe(targetScope);
    if (migrateLegacy) {
      await migrateLegacyCustomPipelines();
    }
    activePipelineScope = targetScope;
    resetPipelineMaps();
    await loadCustomPipelineDirectory(targetScope);
    refreshPipelineState();
  };

  const loadPipelines = async (): Promise<void> => {
    activePipelineScope = await resolvePipelineScope(
      state.workingDirectory,
      state.workspaceRoots,
    );
    await reloadPipelines(activePipelineScope, true);
  };

  const requestCodexApproval = (
    agentId: string,
    request: CodexApprovalRequest | (AgentApprovalRequest & { grantRoot?: string }),
  ): Promise<string> =>
    (async () => {
      const route = interactionRoute({
        hasBroker: options.requestInteraction !== undefined,
        panelFallback: true,
        disposed,
        attachedViews: webviews.size,
      });
      if (route.route === "broker" && options.requestInteraction) {
        const response = await options.requestInteraction({
          sourceKey: `approval:${agentId}:${request.requestId}`,
          kind: "permission",
          title: `Permission requested by ${state.agents[agentId]?.name ?? agentId}`,
          prompt: approvalPrompt(request),
          options: approvalChoices(request.choices),
          allowFreeText: false,
          secret: false,
        });
        const decided = approvalRecord(request, response);
        await appendTranscript(
          createEventEntry(
            decided.eventType,
            decided.text,
            toJsonValue({
              requestId: request.requestId,
              kind: request.kind,
              choice: decided.choice,
            }),
            agentId,
          ),
        );
        return decided.choice;
      }
      if (route.route === "unavailable") {
        await appendTranscript(
          createEventEntry(
            "approval.cancelled",
            `Approval ${request.requestId} cancelled because no Bachata view is available.`,
            toJsonValue({ requestId: request.requestId, kind: request.kind }),
            agentId,
          ),
        );
        return "cancel";
      }
      const key = `${agentId}:${request.requestId}`;
      const activeOperation = abortControllers.get(agentId);
      const taskId = activeOperation?.taskId ?? state.taskId;
      const operationOwnerId = activeOperation?.ownerId;
      // EX-AUD-12. Whether this belongs to the task that is running now is decided in
      // `recoveryTransition.ts`.
      if (
        resultIsStale({
          operationTaskId: taskId,
          currentTaskId: state.taskId,
          ...(activeOperation?.controller.signal.aborted === undefined
            ? {}
            : { aborted: activeOperation.controller.signal.aborted }),
        })
      ) {
        return "cancel";
      }
      const previous = approvalResolvers.get(key);
      if (previous) {
        approvalResolvers.delete(key);
        removeApproval(agentId, request.requestId);
        previous.resolve("cancel");
      }
      const approval = pendingApprovalFrom(agentId, request);
      let resolveDecision: (choiceId: string) => void = () => undefined;
      const decision = new Promise<string>((resolve) => {
        resolveDecision = resolve;
      });
      const resolver: ApprovalResolver = {
        agentId,
        taskId,
        operationOwnerId,
        approval,
        resolve: resolveDecision,
      };
      approvalResolvers.set(key, resolver);
      state.approvals = state.approvals.filter(
        (item) =>
          item.agentId !== agentId || item.requestId !== request.requestId,
      );
      state.approvals.push(approval);
      post({ type: "approval.add", approval });
      const isCurrent = (): boolean =>
        approvalStillCurrent({
          registeredIsThisResolver: approvalResolvers.get(key) === resolver,
          operationTaskId: taskId,
          currentTaskId: state.taskId,
          operationOwnerId: operationOwnerId || undefined,
          activeOwnerId: abortControllers.get(agentId)?.ownerId,
          activeAborted: abortControllers.get(agentId)?.controller.signal.aborted,
          disposed,
        });
      const cancelCurrent = (): void => {
        if (approvalResolvers.get(key) !== resolver) {
          return;
        }
        approvalResolvers.delete(key);
        removeApproval(agentId, request.requestId);
        resolver.resolve("cancel");
      };
      try {
        if (previous) {
          await appendTranscript(
            createEventEntry(
              "approval.cancelled",
              `Approval ${request.requestId} was replaced.`,
              toJsonValue({ requestId: request.requestId, reason: "replaced" }),
              agentId,
            ),
          );
          if (!isCurrent()) {
            return decision;
          }
        }
        await appendTranscript(
          createEventEntry(
            "approval.requested",
            `Approval requested: ${request.kind}`,
            toJsonValue(approval),
            agentId,
          ),
        );
      } catch (error) {
        if (!isCurrent()) {
          return decision;
        }
        cancelCurrent();
        throw error;
      }
      if (!isCurrent()) {
        cancelCurrent();
      }
      return decision;
    })();

  let activeCodexInput:
    | { agentId: string; cancel: () => void }
    | undefined;

  const codexInputSlot: ActiveInputSlot = {
    claim: (agentId, cancel) => {
      activeCodexInput = { agentId, cancel };
    },
    release: (cancel) => {
      if (activeCodexInput?.cancel === cancel) {
        activeCodexInput = undefined;
      }
    },
  };

  const timedQuickPick = async <T extends vscode.QuickPickItem>(
    agentId: string,
    items: T[],
    options: { title: string; placeHolder: string },
    deadline: number | undefined,
  ): Promise<TimedInputResult<T>> =>
    await promptWithDeadline<T>({
      agentId,
      deadline,
      now: () => Date.now(),
      unbounded: async () =>
        await vscode.window.showQuickPick(items, { ...options, ignoreFocusOut: true }),
      createWidget: () => {
        const picker = vscode.window.createQuickPick<T>();
        picker.items = items;
        picker.title = options.title;
        picker.placeholder = options.placeHolder;
        picker.ignoreFocusOut = true;
        return {
          onAccept: (listener) => picker.onDidAccept(listener),
          onHide: (listener) => picker.onDidHide(listener),
          accepted: () => picker.selectedItems[0],
          show: () => { picker.show(); },
          hide: () => { picker.hide(); },
          dispose: () => { picker.dispose(); },
        };
      },
      slot: codexInputSlot,
      schedule: (delayMs, onDeadline) => setTimeout(onDeadline, delayMs),
      cancelSchedule: (handle) => { clearTimeout(handle as NodeJS.Timeout); },
    });

  const timedInputBox = async (
    agentId: string,
    options: {
      title: string;
      prompt: string;
      password: boolean;
    },
    deadline: number | undefined,
  ): Promise<TimedInputResult<string>> =>
    await promptWithDeadline<string>({
      agentId,
      deadline,
      now: () => Date.now(),
      unbounded: async () =>
        await vscode.window.showInputBox({ ...options, ignoreFocusOut: true }),
      createWidget: () => {
        const input = vscode.window.createInputBox();
        input.title = options.title;
        input.prompt = options.prompt;
        input.password = options.password;
        input.ignoreFocusOut = true;
        return {
          onAccept: (listener) => input.onDidAccept(listener),
          onHide: (listener) => input.onDidHide(listener),
          accepted: () => input.value,
          show: () => { input.show(); },
          hide: () => { input.hide(); },
          dispose: () => { input.dispose(); },
        };
      },
      slot: codexInputSlot,
      schedule: (delayMs, onDeadline) => setTimeout(onDeadline, delayMs),
      cancelSchedule: (handle) => { clearTimeout(handle as NodeJS.Timeout); },
    });

  const requestCodexUserInput = (
    agentId: string,
    request: CodexUserInputRequest,
  ): Promise<CodexUserInputResponse> =>
    enqueueCodexInteraction(async () => {
      const route = interactionRoute({
        hasBroker: options.requestInteraction !== undefined,
        panelFallback: true,
        disposed,
        attachedViews: webviews.size,
      });
      const broker = options.requestInteraction;
      if (route.route === "broker" && broker) {
        const requested = codexUserInputRequested(request);
        await appendTranscript(
          createEventEntry(
            "codex.userInput.requested",
            requested.text,
            toJsonValue(requested.detail),
            agentId,
          ),
        );
        const answers = await collectInteractionAnswers({
          questions: request.questions,
          keyOf: (question) => question.id,
          ask: async (question) => {
            const response = await broker(codexUserInputAsk(agentId, request, question));
            const answer = codexUserInputAnswer(response);
            if (answer === undefined) {
              const unanswered = codexUnansweredInput(response);
              await appendTranscript(
                createEventEntry(
                  unanswered.eventType,
                  unanswered.text,
                  toJsonValue({ requestId: request.requestId, questionId: question.id }),
                  agentId,
                ),
              );
              return undefined;
            }
            if (answeredByLead(response.source)) {
              await appendTranscript(
                createEventEntry(
                  "codex.userInput.answeredByLead",
                  "The configured Lead answered after the user fallback deadline.",
                  toJsonValue({ requestId: request.requestId, questionId: question.id }),
                  agentId,
                ),
              );
            }
            return { answers: [answer] };
          },
        });
        if (answers === undefined) {
          return { answers: {} };
        }
        await appendTranscript(
          createEventEntry(
            "codex.userInput.completed",
            "Codex input request was answered.",
            toJsonValue(codexUserInputCompleted(request, Object.keys(answers))),
            agentId,
          ),
        );
        return { answers };
      }
      if (route.route === "unavailable") {
        return { answers: {} };
      }
      const deadline = interactionDeadline({
        now: Date.now(),
        autoResolutionMs: codexAutoResolutionMs(request),
      });
      const panelRequested = codexUserInputRequested(request);
      await appendTranscript(
        createEventEntry(
          "codex.userInput.requested",
          panelRequested.text,
          toJsonValue(panelRequested.detail),
          agentId,
        ),
      );
      const answers = await collectInteractionAnswers({
        questions: request.questions,
        keyOf: (question) => question.id,
        ask: async (question) => {
        let answer: string | undefined;
        let timedOut = false;
        const widget = codexQuestionWidget(question);
        if (widget.kind === "pick") {
          const picked = codexPickOutcome(await timedQuickPick(
            agentId,
            widget.items,
            { title: widget.title, placeHolder: widget.placeHolder },
            deadline,
          ));
          if (picked.kind === "askOther") {
            const entered = await timedInputBox(agentId, codexQuestionInputBox(question), deadline);
            answer = entered.value;
            timedOut = entered.timedOut;
          } else if (picked.kind === "answer") {
            answer = picked.answer;
          } else {
            timedOut = picked.timedOut;
          }
        } else {
          const entered = await timedInputBox(
            agentId,
            { title: widget.title, prompt: widget.prompt, password: widget.password },
            deadline,
          );
          answer = entered.value;
          timedOut = entered.timedOut;
        }
        if (answer === undefined) {
          const unanswered = codexUnansweredPick(timedOut);
          await appendTranscript(
            createEventEntry(
              unanswered.eventType,
              unanswered.text,
              toJsonValue({ requestId: request.requestId }),
              agentId,
            ),
          );
          return undefined;
        }
        return { answers: [answer] };
        },
      });
      if (answers === undefined) {
        return { answers: {} };
      }
      await appendTranscript(
        createEventEntry(
          "codex.userInput.completed",
          "Codex input request was answered.",
          toJsonValue(codexUserInputCompleted(request, Object.keys(answers))),
          agentId,
        ),
      );
      return { answers };
    });

  const requestClaudeUserInput = async (
    agentId: string,
    request: ClaudeUserInputRequest,
  ): Promise<ClaudeUserInputResponse> => {
    const broker = options.requestInteraction;
    if (
      interactionRoute({
        hasBroker: broker !== undefined,
        panelFallback: false,
        disposed,
        attachedViews: webviews.size,
      }).route !== "broker" ||
      !broker
    ) {
      return { answers: {} };
    }
    await appendTranscript(
      createEventEntry(
        "claude.userInput.requested",
        `Claude requested ${String(request.questions.length)} input ${request.questions.length === 1 ? "answer" : "answers"}.`,
        toJsonValue({
          requestId: request.requestId,
          questionCount: request.questions.length,
        }),
        agentId,
      ),
    );
    const answers = await collectInteractionAnswers({
      questions: request.questions,
      keyOf: (question) => question.question,
      ask: async (question, index) => {
        const response = await broker(
          claudeUserInputAsk(agentId, request.requestId, index, question),
        );
        const answer = claudeUserInputAnswer(question, response);
        if (answer === undefined) {
          const unanswered = claudeUnansweredInput(response);
          await appendTranscript(
            createEventEntry(
              unanswered.eventType,
              unanswered.text,
              toJsonValue({ requestId: request.requestId, question: question.question }),
              agentId,
            ),
          );
          return undefined;
        }
        if (answeredByLead(response.source)) {
          await appendTranscript(
            createEventEntry(
              "claude.userInput.answeredByLead",
              "The configured Lead answered Claude after the user deadline.",
              toJsonValue({ requestId: request.requestId, question: question.question }),
              agentId,
            ),
          );
        }
        return answer;
      },
    });
    return { answers: answers ?? {} };
  };

  const requestClaudePermission = async (
    agentId: string,
    request: ClaudePermissionRequest,
  ): Promise<ClaudePermissionResponse> => {
    if (!options.requestInteraction) {
      return { behavior: "deny", message: "No Bachata permission broker is available" };
    }
    // A run whose commit mode is `never` refuses a commit command here, before the tool
    // runs. The post-run HEAD comparison in the adapter stays, but it can only report a
    // commit that already happened; this is the step that prevents one.
    if (commitPolicyRefusesToolRequest(request.commitMode, request.toolInput)) {
      await appendTranscript(
        createEventEntry(
          "claude.permission.decided",
          "Claude permission was denied: this run does not allow commits.",
          toJsonValue({
            requestId: request.requestId,
            toolName: request.toolName,
            allowed: false,
            source: "commitPolicy",
          }),
          agentId,
        ),
      );
      return {
        behavior: "deny",
        message: "This run's commit mode is never, so Bachata refused a commit command.",
      };
    }
    const response = await options.requestInteraction({
      sourceKey: `claude-permission:${agentId}:${request.requestId}`,
      kind: "permission",
      title: `Permission requested by ${state.agents[agentId]?.name ?? agentId}`,
      prompt: claudePermissionPrompt(request),
      options: [
        { id: "allow", label: "Allow" },
        { id: "reject", label: "Deny" },
      ],
      allowFreeText: false,
      secret: false,
    });
    const record = claudePermissionRecord(response);
    await appendTranscript(
      createEventEntry(
        record.eventType,
        record.text,
        toJsonValue({
          requestId: request.requestId,
          toolName: request.toolName,
          allowed: record.allowed,
          source: response.source,
        }),
        agentId,
      ),
    );
    return claudePermissionVerdict(response);
  };

  const requestCodexMcpElicitation = (
    agentId: string,
    request: CodexMcpElicitationRequest,
  ): Promise<CodexMcpElicitationResponse> =>
    enqueueCodexInteraction(async () => {
      if (
        interactionRoute({
          hasBroker: false,
          panelFallback: true,
          disposed,
          attachedViews: webviews.size,
        }).route === "unavailable"
      ) {
        return { action: "cancel", content: null };
      }
      const requested = mcpElicitationRequested(request);
      await appendTranscript(
        createEventEntry(
          "codex.mcpElicitation.requested",
          requested.text,
          toJsonValue(requested.detail),
          agentId,
        ),
      );
      if (request.mode === "url") {
        const url = request.url;
        let uri: vscode.Uri | undefined;
        const decision = mcpUrlDecision(url, (value) => {
          try {
            uri = vscode.Uri.parse(value, true);
            return uri.scheme;
          } catch {
            return undefined;
          }
        });
        if (decision.open !== true || uri === undefined || url === undefined) {
          return { action: "decline", content: null };
        }
        const target = uri;
        const choice = await vscode.window.showInformationMessage(
          request.message,
          { modal: true, detail: url },
          "Open",
          "Decline",
        );
        const outcome = mcpUrlOutcome(
          choice,
          choice === "Open" ? await vscode.env.openExternal(target) : false,
        );
        if (outcome.completed !== undefined) {
          await appendTranscript(
            createEventEntry(
              "codex.mcpElicitation.completed",
              outcome.completed,
              toJsonValue({ requestId: request.requestId, action: outcome.action }),
              agentId,
            ),
          );
        }
        return outcome.action === "accept"
          ? { action: "accept", content: {} }
          : { action: outcome.action, content: null };
      }
      const fields = parseMcpFormSchema(request.requestedSchema);
      if (!fields) {
        await appendTranscript(
          createEventEntry(
            "codex.mcpElicitation.declined",
            "MCP form schema is unsupported.",
            toJsonValue({ requestId: request.requestId }),
            agentId,
          ),
        );
        return { action: "decline", content: null };
      }
      const content: Record<string, JsonValue> = {};
      const secretFields: string[] = [];
      for (const field of fields) {
        let value: JsonValue | undefined;
        const widget = mcpFieldWidget(field, request.message);
        if (widget.kind === "pick") {
          const selected = await vscode.window.showQuickPick(widget.items, {
            title: widget.title,
            placeHolder: widget.placeHolder,
            ignoreFocusOut: true,
          });
          value = selected?.value;
        } else {
          const entered = await vscode.window.showInputBox({
            title: widget.title,
            prompt: widget.prompt,
            ...(widget.value === undefined ? {} : { value: widget.value }),
            password: widget.password,
            ignoreFocusOut: true,
            validateInput: (input) => mcpFieldValidation(field, input),
          });
          value = mcpFieldValue(field, entered);
        }
        const outcome = mcpFieldOutcome(field, value);
        if (outcome.kind === "skip") {
          continue;
        }
        if (outcome.kind === "cancel") {
          await appendTranscript(
            createEventEntry(
              "codex.mcpElicitation.cancelled",
              "MCP form input was cancelled.",
              toJsonValue({ requestId: request.requestId }),
              agentId,
            ),
          );
          return { action: "cancel", content: null };
        }
        content[field.key] = outcome.value;
        if (outcome.secret) {
          secretFields.push(field.key);
        }
      }
      await appendTranscript(
        createEventEntry(
          "codex.mcpElicitation.completed",
          "MCP form input was accepted.",
          toJsonValue(mcpElicitationCompleted(
            request.requestId,
            content,
            secretFields,
          )),
          agentId,
        ),
      );
      return { action: "accept", content };
    });

  const effectiveDefinition = (definition: AgentDefinition): AgentDefinition =>
    effectiveAgentDefinition(definition, (settingKey, fallback) =>
      configuration().get<string>(settingKey, fallback)
    );

  const currentTopology = (): AdapterTopology => ({
    adapters,
    definitions,
    agents: state.agents,
  });

  const browserBindingHost = {
    ownerIdFor: (agentId: string) => `${runtimeOwnerId}:${agentId}`,
    bindConversation: (ownerId: string, binding: BrowserConversationBinding) => {
      bridge.bindConversation(ownerId, binding);
    },
    bindSession: (ownerId: string, sessionId: string) => bridge.bindSession(ownerId, sessionId),
    releaseBinding: (ownerId: string) => {
      bridge.releaseBinding(ownerId);
    },
    resolveBoundSession: (
      ownerId: string,
      binding: BrowserConversationBinding,
      sessionId?: string,
    ) => bridge.resolveBoundSession(ownerId, binding, sessionId),
  };

  const bindBrowserAgents = (topology: AdapterTopology): void => {
    bindBrowserAgentsIn(topology, browserBindingHost);
  };

  const releaseBrowserBindings = (topology: AdapterTopology): void => {
    releaseBrowserBindingsFor(topology, browserBindingHost);
  };

  const disposeTopology = async (topology: AdapterTopology): Promise<unknown[]> =>
    await disposeAdapters(topology);

  const scopedProviderEnvironment = (
    adapterType: string,
    workingDirectory: string,
  ): NodeJS.ProcessEnv => {
    const config = configuration();
    return providerScopedEnvironment(
      providerEnvironmentRequest({
        adapterType,
        workingDirectory,
        sharedVariables: config.get<string[]>("providerEnvironmentVariables", []),
        zai: {
          variables: config.get<string[]>("zaiEnvironmentVariables", []),
          credentialSourceVariable: config
            .get<string>("zaiAuthTokenEnvironment", "ZAI_API_KEY")
            .trim(),
          baseUrl: config.get<string>("zaiBaseUrl", ZAI_ANTHROPIC_ENDPOINT).trim(),
        },
      })
    );
  };

  const adapterFactoryContext = (
    workingDirectory: string | undefined = state.workingDirectory,
  ) => {
    const config = configuration();
    return {
      bridge,
      browserOwnerId: runtimeOwnerId,
      log: logOutput,
      commandCheckTimeoutMs: readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "commandCheckTimeoutMs", 15_000),
      requestTimeoutMs: readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "codexRequestTimeoutMs", 30_000),
      turnTimeoutMs: readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "agentTurnTimeoutMs", 30 * 60_000),
      interruptGraceMs: readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "interruptGraceMs", 5_000),
      environment: providerProcessEnvironment(
        workingDirectory ?? state.workspaceRoots[0] ?? storageDirectory,
        config.get<string[]>("providerEnvironmentVariables", []),
      ),
      providerEnvironment: (adapterType: string) =>
        scopedProviderEnvironment(
          adapterType,
          workingDirectory ?? state.workspaceRoots[0] ?? storageDirectory,
        ),
      zaiModel: config.get<string>("zaiModel", "").trim(),
      codexWorkspaceScope: configuredCodexWorkspaceScope(),
      requestCodexApproval,
      requestCodexUserInput,
      requestCodexMcpElicitation,
      requestClaudeUserInput,
      requestClaudePermission,
    };
  };

  const buildAdapterTopology = async (
    pipeline: PipelineDefinition,
    persistedAgents: Record<string, PersistedAgentState> = {},
    workingDirectory: string | undefined = state.workingDirectory,
  ): Promise<AdapterTopology> => {
    const contextValue = adapterFactoryContext(workingDirectory);
    return await buildTopology(pipeline.agents, persistedAgents, {
      effectiveDefinition,
      createAdapter: (definition) => {
        const createdAdapter = registry.create(definition, contextValue);
        return definition.resourceId
          ? wrapAdapterWithProviderResource(createdAdapter, {
              resourceId: definition.resourceId,
              broker: providerResourceBroker,
            })
          : createdAdapter;
      },
      onCandidateFailure: async (candidate) => {
        const cleanupFailures = await disposeTopology(candidate);
        bindBrowserAgents(currentTopology());
        return cleanupFailures;
      },
    });
  };

  const installTopology = (topology: AdapterTopology): void => {
    adapters = topology.adapters;
    definitions = topology.definitions;
    state.agents = topology.agents;
  };

  const createAdaptersForPipeline = async (
    pipeline: PipelineDefinition,
    persistedAgents: Record<string, PersistedAgentState> = {},
  ): Promise<void> => {
    const previous = currentTopology();
    const candidate = await buildAdapterTopology(pipeline, persistedAgents);
    bindBrowserAgents(candidate);
    installTopology(candidate);
    const cleanupFailures = await disposeTopology(previous);
    bindBrowserAgents(candidate);
    cleanupFailures.forEach((error) => {
      logOutput(
        `Failed to dispose a replaced provider adapter: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  };

  const persistedAgentsFromState = (): Record<string, PersistedAgentState> =>
    persistedAgentsFrom(state.agents);

  const persistedAgentsFromTopology = (
    topology: AdapterTopology,
  ): Record<string, PersistedAgentState> => persistedAgentsFrom(topology.agents);

  const freshAgentsFromState = (): Record<string, PersistedAgentState> =>
    freshAgentsFrom(state.agents);

  const resetAgentsFromState = (): Record<string, PersistedAgentState> =>
    resetAgentsFrom(state.agents);

  const ensureAdaptersReady = async (): Promise<void> => {
    if (Object.keys(adapters).length > 0) {
      return;
    }
    const pipeline = selectedPipelineSnapshot?.definition;
    if (!pipeline) {
      throw new Error("No selected pipeline is available");
    }
    await createAdaptersForPipeline(pipeline, persistedAgentsFromState());
  };

  const persistedValueFromState = (): PersistedRuntimeValue => ({
    taskId: state.taskId,
    ...(state.workingDirectory === undefined ? {} : { workingDirectory: state.workingDirectory }),
    ...(selectedPipelineSnapshot?.definition.id === undefined ? {} : { selectedPipelineId: selectedPipelineSnapshot?.definition.id }),
    selectedPipelineSnapshot: selectedPipelineSnapshot
      ? structuredClone(selectedPipelineSnapshot)
      : undefined,
    taskDirty,
    agents: Object.fromEntries(
      Object.entries(state.agents).map(([agentId, agent]) => [
        agentId,
        {
          ...(agent.version === undefined ? {} : { version: agent.version }),
          ...(agent.sessionId === undefined ? {} : { sessionId: agent.sessionId }),
          ...(agent.browserBinding === undefined ? {} : { browserBinding: agent.browserBinding }),
        },
      ]),
    ),
    attachments: state.attachments,
    queuedMessages: state.queuedMessages,
    queuePaused: state.queuePaused,
    queueStart: queueStartClaim,
    resumableWorkflow: resumableWorkflowData,
    managedPairCheckpoints: Array.from(managedPairCheckpoints.values())
      .filter((checkpoint) => checkpoint.taskId === state.taskId)
      .map((checkpoint) => structuredClone(checkpoint)),
  });

  const inspectReadiness = async (pipelineIds?: string[]): Promise<RuntimeReadinessReport> => {
    await awaitInitialization();
    const config = configuration();
    const workingDirectory = state.workingDirectory ?? state.workspaceRoots[0] ?? storageDirectory;
    const timeoutMs = readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "commandCheckTimeoutMs", 15_000);
    const providerCandidates = [
      ["codex-app-server", config.get<string>("codexCommand", "codex")],
      ["claude-code", config.get<string>("claudeCommand", "claude")],
      ["zai-glm", config.get<string>("zaiCommand", "claude")],
    ] as const;
    const probeProvider = async (
      type: string,
      command: string,
    ): Promise<ProviderProbeOutcome> => {
      const environment = scopedProviderEnvironment(type, workingDirectory);
      if (type === "zai-glm" && environment[ZAI_TOKEN_TARGET_VARIABLE] === undefined) {
        return {
          outcome: "missingToken",
          tokenVariable: config
            .get<string>("zaiAuthTokenEnvironment", ZAI_DEFAULT_TOKEN_SOURCE_VARIABLE)
            .trim(),
          endpoint: config.get<string>("zaiBaseUrl", ZAI_ANTHROPIC_ENDPOINT).trim(),
        };
      }
      try {
        const version = type === "codex-app-server"
          ? await probeCodexAppServer({
              command,
              commandCheckTimeoutMs: timeoutMs,
              requestTimeoutMs: readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "codexRequestTimeoutMs", 30_000),
              interruptGraceMs: readTimeoutSetting((settingKey, settingFallback) => config.get(settingKey, settingFallback), "interruptGraceMs", 5_000),
              environment,
              workingDirectory,
              log: logOutput,
            })
          : await checkCommand(command, ["--version"], {
              workingDirectory,
              environment,
              timeoutMs,
            });
        return { outcome: "version", command, version };
      } catch (error) {
        return { outcome: "failed", command, error };
      }
    };
    const providerReadiness = await Promise.all(
      providerCandidates.map(async ([type, command]) =>
        providerReadinessFrom(type, await probeProvider(type, command)),
      ),
    );
    for (const [index, [type]] of providerCandidates.entries()) {
      providerRuntimeVersions = providerVersionsAfter(
        providerRuntimeVersions,
        type,
        providerReadiness[index]?.version,
      );
    }
    readinessAdapterProbes = providerReadiness.map((entry) => entry.readiness);
    try {
      const environment = gitProcessEnvironment(workingDirectory);
      const version = await checkCommand("git", ["--version"], {
        workingDirectory,
        environment,
        timeoutMs,
      });
      const support = evaluateGitVersionSupport(version);
      if (!support.supported) {
        // EX-3. What each probe outcome means is `readiness/gitReadiness.ts`'s; running Git is
        // this runtime's.
        readinessGit = gitReadinessFrom({
          outcome: "unsupported",
          requirementText: support.requirementText,
        });
      } else {
        try {
          const status = await checkCommand(
            "git",
            ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
            { workingDirectory, environment, timeoutMs, trim: false },
          );
          readinessGit = gitReadinessFrom({ outcome: "status", version, status });
        } catch (error) {
          readinessGit = gitReadinessFrom({ outcome: "statusFailed", error });
        }
      }
    } catch (error) {
      readinessGit = gitReadinessFrom({ outcome: "versionFailed", error });
    }
    refreshReadiness();
    const requested = requestedPipelineIds(pipelineIds, pipelines.keys());
    const maxIterations = Math.max(1, configuration().get<number>("maxPipelineIterations", 10));
    const pipelineFacts = requested.map((pipelineId) => {
      const readiness = evaluatePipelineReadiness(pipelineId);
      const pipeline = pipelines.get(pipelineId);
      if (!pipeline) return { pipelineId, readiness };
      return {
        pipelineId,
        readiness,
        safetyLevel: executionSafetyLevel(pipeline),
        guardrails: guardrailSummary(buildExecutionContract({
          pipeline,
          readiness,
          ...(state.workingDirectory === undefined ? {} : { workingDirectory: state.workingDirectory }),
          maxIterations,
          providerRuntimeVersions,
        })),
      };
    });
    const factIndexes = pipelineFactIndexes(pipelineFacts);
    return {
      ...(state.selectedPipelineId === undefined ? {} : { selectedPipelineId: state.selectedPipelineId }),
      pipelines: pipelineFacts.map((entry) => entry.readiness),
      pipelineNames: pipelineNameIndex(state.pipelines),
      pipelineProviders: pipelineProviderIndex(pipelines.values()),
      disabledProviders: disabledProviders(),
      preferredProvider: preferredProvider(),
      codexWorkspaceScope: configuredCodexWorkspaceScope(),
      pipelineSafetyLevels: factIndexes.safetyLevels,
      pipelineGuardrails: factIndexes.guardrails,
      workspaceRoots: [...state.workspaceRoots],
      ...(state.workingDirectory === undefined ? {} : { workingDirectory: state.workingDirectory }),
      trusted: state.trusted,
      ...(vscode.env.remoteName === undefined ? {} : { remoteName: vscode.env.remoteName }),
      ...(pipelineCatalogError === undefined ? {} : { catalogError: pipelineCatalogError }),
      adapters: structuredClone(readinessAdapterProbes),
      git: structuredClone(readinessGit),
      bridge: structuredClone(state.browserBridge),
    };
  };

  const patchRun = (
    running: boolean,
    workflowStatus: WorkflowStatus,
    values: {
      activeStep?: string;
      activeStepId?: string;
      consensusRound?: number;
      pendingGate?: PendingHumanGate;
      roles?: Record<string, AgentId>;
    } = {},
  ): void => {
    state.running = running;
    state.workflowStatus = workflowStatus;
    setOptionalProperty(state, "activeStep", values.activeStep);
    setOptionalProperty(state, "activeStepId", values.activeStepId);
    setOptionalProperty(state, "consensusRound", values.consensusRound);
    setOptionalProperty(state, "pendingGate", values.pendingGate);
    if (values.roles) {
      state.roles = values.roles;
    }
    post({
      type: "run.patch",
      running,
      workflowStatus,
      ...(values.activeStep === undefined ? {} : { activeStep: values.activeStep }),
      ...(values.activeStepId === undefined ? {} : { activeStepId: values.activeStepId }),
      ...(values.consensusRound === undefined ? {} : { consensusRound: values.consensusRound }),
      ...(values.pendingGate === undefined ? {} : { pendingGate: values.pendingGate }),
      ...(values.roles === undefined ? {} : { roles: values.roles }),
    });
  };

  const initializePromise = (async (): Promise<void> => {
    await loadPipelines();
    const persistedSnapshot = persisted?.selectedPipelineSnapshot;
    const currentPersistedDefinition = persistedSnapshot
      ? pipelines.get(persistedSnapshot.definition.id)
      : undefined;
    const currentPersistedSnapshot = currentPersistedDefinition
      ? snapshotForPipeline(currentPersistedDefinition)
      : undefined;
    const selectionPlan = selectedPipelinePlan({
      persistedSelectedId: persisted?.selectedPipelineId,
      persistedSnapshotPipelineId: persistedSnapshot?.definition.id,
      hasDurableState: persistedHasDurableState(persisted),
      persistedSnapshotMatchesCatalog: persistedSnapshot !== undefined &&
        pipelineSnapshotsEqual(currentPersistedSnapshot, persistedSnapshot),
      catalogIds: Array.from(pipelines.keys()),
      defaultPipelineId: "review-only",
    });
    if (selectionPlan.source === "persistedSnapshot" && persistedSnapshot) {
      selectedPipelineSnapshot = structuredClone(persistedSnapshot);
    } else {
      const selectedPipeline = selectionPlan.source === "catalog"
        ? pipelines.get(selectionPlan.pipelineId)
        : undefined;
      if (!selectedPipeline) {
        throw new Error("No selected pipeline is available");
      }
      selectedPipelineSnapshot = snapshotForPipeline(selectedPipeline);
    }
    refreshPipelineState();
    await createAdaptersForPipeline(
      selectedPipelineSnapshot.definition,
      persisted?.agents,
    );
    const transcriptWindowSize = Math.max(
      50,
      configuration().get<number>("transcriptWindowSize", 300),
    );
    let storedTranscript = await transcriptStore.loadRecent(transcriptWindowSize);
    if (storedTranscript.total === 0 && persisted?.legacyTranscript.length) {
      await transcriptStore.replace(persisted.legacyTranscript);
      storedTranscript = await transcriptStore.loadRecent(transcriptWindowSize);
    }
    if (persisted?.legacyRecoveryWarning) {
      await transcriptStore.append(
        createEventEntry(
          "workflow.recovery.blocked",
          persisted.legacyRecoveryWarning,
        ),
      );
      storedTranscript = await transcriptStore.loadRecent(transcriptWindowSize);
      logOutput(persisted.legacyRecoveryWarning);
    }
    state.transcript = storedTranscript.entries;
    state.transcriptTotal = storedTranscript.total;
    state.transcriptHasMore = storedTranscript.hasMore;
    delete state.transcriptError;
    const validAttachments: AttachmentMetadata[] = [];
    for (const attachment of state.attachments) {
      try {
        await (await attachmentStore.resolvePaths([attachment], [attachment.id]))
          .dispose();
        validAttachments.push(attachment);
      } catch (error) {
        logOutput(
          `Ignored missing attachment ${attachment.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    state.attachments = validAttachments;
    const availableAttachmentIds = new Set(
      state.attachments.map((attachment) => attachment.id),
    );
    const recoveryPlan = recoveryStartupPlan({
      hasRecovery: resumableWorkflowData !== undefined,
      usable: resumableWorkflowData !== undefined && recoveryCheckpointIsUsable({
        checkpoint: resumableWorkflowData,
        selectedSnapshot: selectedPipelineSnapshot,
        availableAttachmentIds,
      }),
      sourceQueueMessageId: resumableWorkflowData?.sourceQueueMessageId,
    });
    if (recoveryPlan.action === "discard") {
      logOutput("Ignored an invalid recoverable workflow checkpoint");
      resumableWorkflowData = undefined;
      delete state.resumableWorkflow;
      if (discardReturnsToIdle(state.workflowStatus)) {
        patchRun(false, "idle");
      }
    } else if (recoveryPlan.action === "adoptQueued") {
      const sourceQueueMessageId = recoveryPlan.sourceQueueMessageId;
      state.queuedMessages = state.queuedMessages.filter(
        (queued) => queued.id !== sourceQueueMessageId,
      );
      if (queueStartClaim?.messageId === sourceQueueMessageId) {
        queueStartClaim = undefined;
      }
    }
    const claimPlan = queueClaimStartupPlan({
      claimedMessageId: queueStartClaim?.messageId,
      queuedIds: state.queuedMessages.map((queued) => queued.id),
    });
    if (claimPlan.recovered) {
      logOutput(
        "Recovered a queued request whose execution had not been durably accepted",
      );
    }
    if (claimPlan.release) {
      queueStartClaim = undefined;
    }
    state.queuePaused = state.queuedMessages.length > 0;
    taskDirty = startupTaskDirty({
      persistedDirty: taskDirty,
      transcriptTotal: storedTranscript.total,
      attachmentCount: state.attachments.length,
      queuedCount: state.queuedMessages.length,
      hasRecovery: resumableWorkflowData !== undefined,
    });
    const restoredOutputs = latestAgentOutputs(state.transcript, Object.keys(state.agents));
    for (const [agentId, output] of Object.entries(restoredOutputs)) {
      agentStateFor(agentId).output = output;
    }
    if (options.startBridge ?? ownsBridge) {
      await bridge.start();
    }
    if (options.bridge && !bridgeStatusSubscription) {
      bridgeStatusSubscription = bridge.subscribeStatus(handleBridgeStatus);
    }
    await withWorkspaceMutation(async () => {
      await context.workspaceState.update(
        storageKey,
        structuredClone(persistedValueFromState()),
      );
      if (legacyPersistedEntry) {
        await Promise.all(
          legacyStorageKeys.map((key) =>
            key === storageKey
              ? Promise.resolve()
              : context.workspaceState.update(key, undefined),
          ),
        );
      }
    });
  })().catch((error) => {
    initializationError =
      error instanceof Error ? error : new Error(String(error));
    logOutput(`Failed to initialize Bachata: ${initializationError.message}`);
  });

  const awaitInitialization = async (): Promise<void> => {
    await initializePromise;
    if (initializationError) {
      throw initializationError;
    }
  };

  // EX-3. Serialisation, debounce cancellation and read-at-write-time are one rule, and they are
  // `runtimePersistence.ts`'s rule now. What stays here is what this runtime persists and where.
  const persistence = createRuntimePersistence<PersistedRuntimeValue>({
    snapshot: persistedValueFromState,
    write: async (value) => {
      await context.workspaceState.update(storageKey, value);
    },
    withMutation: withWorkspaceMutation,
    ...(hostCallbacks.assertWritable === undefined
      ? {}
      : { assertWritable: hostCallbacks.assertWritable.bind(hostCallbacks) }),
    log: logOutput,
  });

  const persistRuntimeValue = persistence.persistValue;
  const persistStatePatch = (
    patch: PersistedRuntimePatch,
    afterWrite?: () => void,
  ): Promise<void> => persistence.persistPatch(patch, afterWrite);
  const persistNow = persistence.persistNow;
  const schedulePersist = persistence.schedulePersist;

  let managedPairCheckpointPersistTail: Promise<void> = Promise.resolve();
  const setManagedPairCheckpoint = async (
    taskId: string,
    checkpoint: ManagedPairCheckpoint,
  ): Promise<void> => {
    const write = managedPairCheckpointPersistTail.then(async () => {
      const next = new Map(managedPairCheckpoints);
      next.set(taskId, checkpoint);
      await persistStatePatch({
        managedPairCheckpoints: Array.from(next.values()).sort((left, right) => left.taskId.localeCompare(right.taskId)),
      });
      managedPairCheckpoints.set(taskId, checkpoint);
    });
    managedPairCheckpointPersistTail = write.catch(() => undefined);
    await write;
  };

  const patchAgent = (
    agentId: string,
    patch: Partial<AgentPanelState>,
    persist = false,
  ): void => {
    const agent = state.agents[agentId];
    if (!agent) {
      return;
    }
    Object.assign(agent, patch);
    post({ type: "agent.patch", agentId, patch });
    options.onAgentState?.(agentId, structuredClone(agent));
    if (persist) {
      schedulePersist();
    }
  };

  const appendTranscript = async (entry: TranscriptEntry): Promise<void> => {
    hostCallbacks.assertWritable?.();
    const sanitizedEntry: TranscriptEntry = {
      ...entry,
      text:
        entry.kind === "error" || entry.kind === "event"
          ? redactText(entry.text)
          : redactFreeFormText(entry.text),
      ...(entry.data === undefined ? {} : { data: redactJsonValue(entry.data) }),
    };
    try {
      await transcriptStore.append(sanitizedEntry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.transcriptError = message;
      logOutput(`Failed to append transcript: ${message}`);
      emitSnapshot();
      throw new Error(`Transcript persistence failed: ${message}`);
    }
    delete state.transcriptError;
    state.transcriptTotal += 1;
    state.transcript.push(sanitizedEntry);
    if (sanitizedEntry.eventType === "user.message") {
      taskDirty = true;
      await persistNow();
    }
    const windowSize = state.transcriptWindowSize;
    while (state.transcript.length > windowSize) {
      state.transcript.shift();
    }
    state.transcriptHasMore = state.transcriptTotal > state.transcript.length;
    post({ type: "transcript.append", entry: sanitizedEntry });
  };

  const appendTranscriptAfterCommit = async (
    entry: TranscriptEntry,
    operation: string,
  ): Promise<void> => {
    try {
      await appendTranscript(entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.transcriptError = `${operation} committed, but its transcript audit entry could not be saved: ${message}`;
      emitSnapshot();
      logOutput(state.transcriptError);
    }
  };

  const flushDelta = (agentId: string): void => {
    const timer = deltaTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      deltaTimers.delete(agentId);
    }
    const text = deltaBuffers.get(agentId) ?? "";
    deltaBuffers.delete(agentId);
    if (text) {
      post({ type: "agent.delta", agentId, text });
    }
  };

  const queueDelta = (agentId: string, text: string): void => {
    agentStateFor(agentId).output += text;
    deltaBuffers.set(agentId, `${deltaBuffers.get(agentId) ?? ""}${text}`);
    if (deltaTimers.has(agentId)) {
      return;
    }
    const delay = configuration().get<number>("streamThrottleMs", 40);
    deltaTimers.set(
      agentId,
      setTimeout(() => flushDelta(agentId), Math.max(0, delay)),
    );
  };

  const replaceAgentOutput = (agentId: string, text: string): void => {
    flushDelta(agentId);
    agentStateFor(agentId).output = text;
    post({ type: "agent.replace", agentId, text });
  };

  const removeApproval = (agentId: string, requestId: string): void => {
    state.approvals = state.approvals.filter(
      (item) => item.agentId !== agentId || item.requestId !== requestId,
    );
    post({ type: "approval.remove", agentId, requestId });
  };

  const resolveApproval = async (
    agentId: string,
    requestId: string,
    choiceId: string,
  ): Promise<boolean> => {
    const key = `${agentId}:${requestId}`;
    const resolver = approvalResolvers.get(key);
    if (!resolver) {
      return false;
    }
    const activeOperation = abortControllers.get(agentId);
    if (
      approvalIsStale({
        resolverTaskId: resolver.taskId,
        currentTaskId: state.taskId,
        ...(resolver.operationOwnerId === undefined
          ? {}
          : { resolverOperationOwnerId: resolver.operationOwnerId }),
        ...(activeOperation?.ownerId === undefined
          ? {}
          : { activeOperationOwnerId: activeOperation.ownerId }),
      })
    ) {
      approvalResolvers.delete(key);
      removeApproval(agentId, requestId);
      resolver.resolve("cancel");
      return false;
    }
    const approval = resolver.approval;
    if (!approval.choices.some((choice) => choice.id === choiceId)) {
      throw new Error(`Choice ${choiceId} is not available for this approval`);
    }
    approvalResolvers.delete(key);
    removeApproval(agentId, requestId);
    resolver.resolve(choiceId);
    await appendTranscript(
      createEventEntry(
        "approval.decided",
        `Approval ${requestId}: ${choiceId}`,
        toJsonValue({ requestId, choiceId, kind: approval.kind }),
        agentId,
      ),
    );
    return true;
  };

  // Stopping an agent is the in-memory half, and it cannot fail: every pending approval is
  // resolved with "cancel" so the provider stops waiting. The audit entry is a separate write,
  // so a transcript store that is gone cannot stop a stop.
  const releasePendingApprovals = (agentId: string): ApprovalResolver[] => {
    const matching = Array.from(approvalResolvers.entries()).filter(
      ([, resolver]) => resolver.agentId === agentId,
    );
    matching.forEach(([key, resolver]) => {
      approvalResolvers.delete(key);
      removeApproval(agentId, resolver.approval.requestId);
      resolver.resolve("cancel");
    });
    return matching.map(([, resolver]) => resolver);
  };

  const cancelledApprovalEntry = (
    agentId: string,
    resolver: ApprovalResolver,
    reason: string,
  ): TranscriptEntry =>
    createEventEntry(
      "approval.cancelled",
      `Approval ${resolver.approval.requestId} cancelled.`,
      toJsonValue({ requestId: resolver.approval.requestId, reason }),
      agentId,
    );

  const recordCancelledApprovals = async (
    agentId: string,
    released: ApprovalResolver[],
    reason: string,
  ): Promise<void> => {
    await Promise.all(
      released.map((resolver) =>
        appendTranscriptAfterCommit(
          cancelledApprovalEntry(agentId, resolver, reason),
          "Approval cancellation",
        ),
      ),
    );
  };

  const cancelAgentApprovals = async (
    agentId: string,
    reason = "cancelled",
  ): Promise<void> => {
    const released = releasePendingApprovals(agentId);
    await Promise.all(
      released.map((resolver) =>
        appendTranscript(cancelledApprovalEntry(agentId, resolver, reason)),
      ),
    );
  };

  const cancelAllApprovals = async (reason = "cancelled"): Promise<void> => {
    const agentIds = new Set([
      ...Object.keys(state.agents),
      ...Array.from(approvalResolvers.values(), (resolver) => resolver.agentId),
    ]);
    for (const agentId of agentIds) {
      await cancelAgentApprovals(agentId, reason);
    }
  };

  const anyAgentRunning = (): boolean =>
    Object.values(state.agents).some((agent) => agent.status === "running");

  const isAllowedWorkspaceDirectory = async (candidate: string): Promise<boolean> => {
    if (configuration().get<boolean>("allowExternalWorkingDirectories", false)) {
      return true;
    }
    try {
      const resolvedCandidate = await realpath(candidate);
      const resolvedRoots = await Promise.allSettled(
        getWorkspaceRoots().map((root) => realpath(root)),
      );
      return resolvedRoots.some(
        (result) =>
          result.status === "fulfilled" &&
          isInside(result.value, resolvedCandidate),
      );
    } catch {
      return false;
    }
  };

  const resolveAllowedDirectory = async (candidate: string): Promise<string> => {
    const candidateStat = await stat(candidate);
    if (!candidateStat.isDirectory()) {
      throw new Error("The selected working path is not a directory");
    }
    const resolvedCandidate = await realpath(candidate);
    const allowExternal = configuration().get<boolean>(
      "allowExternalWorkingDirectories",
      false,
    );
    if (!allowExternal) {
      const resolvedRoots = await Promise.all(
        getWorkspaceRoots().map((root) => realpath(root)),
      );
      const managedRoot = options.managedWorkingDirectoryRoot
        ? await realpath(options.managedWorkingDirectoryRoot).catch(() => undefined)
        : undefined;
      const allowed =
        resolvedRoots.some((root) => isInside(root, resolvedCandidate)) ||
        (managedRoot !== undefined && isInside(managedRoot, resolvedCandidate));
      if (!allowed) {
        throw new Error("The working directory must stay inside the VS Code workspace or Bachata managed worktrees");
      }
    }
    return resolvedCandidate;
  };

  const requireWorkspace = async (): Promise<string> => {
    if (!vscode.workspace.isTrusted) {
      throw new Error("Trust the VS Code workspace before launching agents");
    }
    const workspaceRoots = getWorkspaceRoots();
    if (!state.workingDirectory && workspaceRoots.length > 1) {
      throw new Error("Select a working directory before starting a session in a multi-root workspace");
    }
    const candidate = state.workingDirectory ?? workspaceRoots.at(0);
    if (!candidate) {
      throw new Error("Open a VS Code workspace folder before starting a session");
    }
    const resolved = await resolveAllowedDirectory(candidate);
    if (resolved !== state.workingDirectory) {
      state.workingDirectory = resolved;
      emitSnapshot();
      schedulePersist();
    }
    return resolved;
  };


  const requireAgentWorkingDirectory = async (
    agentId: string,
  ): Promise<string> => {
    const base = await requireWorkspace();
    const configured = definitions[agentId]?.workingDirectory;
    if (!configured) {
      return base;
    }
    const candidate = path.isAbsolute(configured)
      ? configured
      : path.resolve(base, configured);
    return resolveAllowedDirectory(candidate);
  };

  const directOptions = (
    agentId: string,
    mode: InteractionMode,
  ): PipelineAgentOptions => {
    const definition = definitions[agentId];
    if (!definition) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const config = configuration();
    if (definition.adapter === "codex-app-server") {
      return {
        permissionMode:
          mode === "review"
            ? "readOnly"
            : config.get<string>(
                "codexImplementationPermissionMode",
                "workspaceWrite",
              ),
        approvalPolicy: config.get<CodexApprovalPolicy>(
          "codexApprovalPolicy",
          "onRequest",
        ),
        model: definition.model,
      };
    }
    if (definition.adapter === "claude-code" || definition.adapter === "zai-glm") {
      return {
        permissionMode:
          mode === "review"
            ? config.get<string>("claudeReviewPermissionMode", "plan")
            : config.get<string>(
                "claudeImplementationPermissionMode",
                "acceptEdits",
              ),
        model: definition.adapter === "zai-glm"
          ? definition.model ?? (config.get<string>("zaiModel", "").trim() || undefined)
          : definition.model,
      };
    }
    return { model: definition.model };
  };

  const reserveAgents = (agentIds: string[], ownerId: string): string[] => {
    const unique = Array.from(new Set(agentIds));
    unique.forEach((agentId) => {
      if (!adapters[agentId]) {
        throw new Error(`Unknown agent: ${agentId}`);
      }
      if (
        agentReservations.has(agentId) ||
        agentStateFor(agentId).status === "running"
      ) {
        throw new Error(`${agentId} is already running`);
      }
    });
    unique.forEach((agentId) => agentReservations.set(agentId, ownerId));
    return unique;
  };

  const releaseAgents = (agentIds: string[], ownerId: string): void => {
    agentIds.forEach((agentId) => {
      if (agentReservations.get(agentId) === ownerId) {
        agentReservations.delete(agentId);
      }
    });
  };

  type AdapterTurnResult = {
    result: AgentRunResult;
    capturedResponse?: CapturedResponse;
  };

  type BrowserActionRound = {
    response: CapturedResponse;
    actions: BrowserActionCandidate[];
    results: BrowserActionExecutionResult[];
  };

  const browserActionApproval = async (
    agentId: string,
    action: BrowserActionCandidate,
    workingDirectory: string,
  ): Promise<"approve" | "reject" | "stop"> => {
    const config = configuration();
    const riskPolicy = config.get<string>(
      browserActionPolicySetting(action.risk),
      "ask",
    );
    const preApproval = browserActionPreApproval({
      kind: action.kind,
      origin: action.origin,
      confidence: action.confidence,
      riskPolicy,
    });
    if (preApproval !== "ask") {
      return preApproval;
    }
    const choice = await requestCodexApproval(agentId, {
      requestId: action.id,
      kind: "browserAction",
      reason: `${action.risk} ${action.origin} browser action detected in the captured response`,
      command: redactText(action.command ?? describeBrowserAction(action)),
      cwd: workingDirectory,
      browserAction: sanitizedBrowserAction(action),
      choices: [
        { id: "approve", label: "Approve once" },
        { id: "reject", label: "Reject" },
        { id: "stop", label: "Reject and stop action loop" },
      ],
    });
    return choice === "approve" || choice === "stop" ? choice : "reject";
  };

  const managedBrowserActionApproval = async (
    agentId: string,
    action: BrowserActionCandidate,
    workingDirectory: string,
  ): Promise<"approve" | "reject" | "stop"> => {
    const managed = managedBrowserActionPreApproval({
      autoApprove: configuration().get<boolean>("managedBrowserAutoApprove", true),
      kind: action.kind,
      origin: action.origin,
      confidence: action.confidence,
    });
    if (managed === "approve") {
      return "approve";
    }
    return await browserActionApproval(agentId, action, workingDirectory);
  };

  const renderBrowserResultsPrompt = (
    round: number,
    response: CapturedResponse,
    actions: BrowserActionCandidate[],
    results: BrowserActionExecutionResult[],
    structuredTurnToken?: string,
  ): string => {
    const payload = actions.map((action) => ({
      action: {
        id: action.id,
        kind: action.kind,
        risk: action.risk,
        summary: redactText(describeBrowserAction(action)),
      },
      result: results.find((item) => item.actionId === action.id),
    }));
    return [
      "Bachata executed or rejected the local actions detected in your previous response.",
      "Continue the same task using only the results below. Do not claim an action succeeded unless its status is completed.",
      `Action round: ${String(round)}`,
      `Captured response request: ${response.requestId}`,
      ...(structuredTurnToken ? [`Structured action turn token: ${structuredTurnToken}`] : []),
      "Results:",
      JSON.stringify(payload, null, 2),
    ].join("\n\n");
  };

  const browserWorkspaceProtocolPrompt = (options: PipelineAgentOptions, structuredTurnToken: string): string => [
    "Bachata browser fallback workspace protocol:",
    `Structured action turn token: ${structuredTurnToken}`,
    "Every fenced bachata-action JSON object must include that exact turnToken. Stale, quoted, or mismatched action blocks are ignored.",
    "Use fenced JSON blocks with language bachata-action for local workspace operations.",
    `Read: {"turnToken":"${structuredTurnToken}","kind":"workspace.read","path":"relative/path.ts"}`,
    `Search: {"turnToken":"${structuredTurnToken}","kind":"workspace.search","path":"optional/subdir","query":"text"}`,
    `Write: {"turnToken":"${structuredTurnToken}","kind":"workspace.write","path":"relative/path.ts","content":"...","expectedFiles":[{"path":"relative/path.ts","sha256":"<sha256 from workspace.read>"}]}`,
    `Patch: {"turnToken":"${structuredTurnToken}","kind":"workspace.applyPatch","patch":"...","expectedFiles":[{"path":"relative/path.ts","sha256":"<sha256 from workspace.read>"}]}`,
    "Existing-file mutations require the complete workspace.read SHA-256. Arbitrary shell.run actions are disabled.",
    `Write scope: ${options.writeScope ?? ((options.allowedPaths ?? []).length > 0 ? "configured" : "workspace")}.`,
    `Allowed paths: ${(options.allowedPaths ?? []).length > 0 ? (options.allowedPaths ?? []).join(", ") : "none"}`,
    `Protected mutation paths: ${(options.protectedPaths ?? []).length > 0 ? (options.protectedPaths ?? []).join(", ") : "none"}`,
    `Read-only: ${options.readOnly === true ? "yes" : "no"}. Commit mode: ${options.commitMode ?? "never"}.`,
  ].join("\n");

  const renderAugmentedBrowserAnswer = (
    turns: string[],
    rounds: BrowserActionRound[],
    responses: Array<CapturedResponse | undefined>,
  ): string => {
    const sections: string[] = [];
    turns.forEach((turn, index) => {
      sections.push(
        index === 0
          ? `Browser response:\n${turn}`
          : `Browser continuation ${String(index)}:\n${turn}`,
      );
      const assetSummary = renderCapturedAssetSummary(
        responses[index]?.assets ?? [],
      );
      if (assetSummary) {
        sections.push(assetSummary);
      }
      const round = rounds[index];
      if (!round) {
        return;
      }
      sections.push(
        [
          `Local action results ${String(index + 1)}:`,
          ...round.actions.map((action) => {
            const result = round.results.find(
              (item) => item.actionId === action.id,
            );
            const output = [result?.stdout, result?.stderr]
              .filter((value): value is string => Boolean(value))
              .join("\n");
            return [
              `- ${action.kind}: ${redactText(describeBrowserAction(action))}`,
              `  status: ${result?.status ?? "skipped"}`,
              result?.exitCode === undefined
                ? undefined
                : `  exitCode: ${String(result.exitCode)}`,
              output ? `  output:\n${output}` : undefined,
            ]
              .filter((value): value is string => Boolean(value))
              .join("\n");
          }),
        ].join("\n"),
      );
    });
    return sections.join("\n\n");
  };

  const consume = async (
    agentId: string,
    prompt: string,
    step?: string,
    options: PipelineAgentOptions = directOptions(agentId, "review"),
    attachments: string[] = [],
    expectedTaskId?: string,
    operationOwnerId?: string,
  ): Promise<AgentRunResult> => {
    // A disabled provider is refused before the turn starts rather than at activation, so
    // disabling one provider never prevents the extension from starting or from running a
    // workflow bound to another.
    const disabledAdapter = definitions[agentId]?.adapter;
    if (disabledAdapter !== undefined && disabledProviders().includes(disabledAdapter)) {
      throw new Error(
        `${definitions[agentId]?.name ?? agentId} (${disabledAdapter}) is disabled in`
        + " bachata.disabledProviders. Remove it from that setting or choose a workflow that does"
        + " not bind it.",
      );
    }
    const ownerId = operationOwnerId ?? randomUUID();
    const ownsReservation = operationOwnerId === undefined;
    if (ownsReservation) {
      reserveAgents([agentId], ownerId);
    } else if (agentReservations.get(agentId) !== ownerId) {
      throw new Error(`${agentId} is not reserved for this operation`);
    }

    const adapter = adapters[agentId];
    if (!adapter) {
      releaseAgents([agentId], ownerId);
      throw new Error(`Unknown agent: ${agentId}`);
    }
    const roleResourceId = options.resourceId;
    const turnAdapter = roleResourceId && roleResourceId !== definitions[agentId]?.resourceId
      ? wrapAdapterWithProviderResource(adapter, {
          resourceId: roleResourceId,
          broker: providerResourceBroker,
        })
      : adapter;
    const managedLocalContextOnly =
      options.managed === true &&
      definitions[agentId]?.adapter.endsWith("-browser") === true &&
      attachments.length > 0 &&
      attachments.every(isSupportedManagedContextAttachmentPath);
    if (attachments.length > 0 && !adapter.capabilities.attachments && !managedLocalContextOnly) {
      releaseAgents([agentId], ownerId);
      throw new Error(`${agentStateFor(agentId).name} does not support attachments`);
    }

    const operationTaskId = expectedTaskId ?? state.taskId;
    const controller = new AbortController();
    let completeOperation: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => {
      completeOperation = resolve;
    });
    abortControllers.set(agentId, {
      ownerId,
      taskId: operationTaskId,
      controller,
    });
    activeCompletions.set(agentId, { ownerId, completion });
    const maxStoredResponseBytes = configuration().get<number>(
      "maxStoredResponseBytes",
      5_242_880,
    );
    let managedPairCheckpoint: ManagedPairCheckpoint | undefined;
    let managedDeadlineTimer: NodeJS.Timeout | undefined;
    let managedDeadlineExpired = false;
    let browserOperationDeadlineTimer: NodeJS.Timeout | undefined;
    let browserOperationDeadlineAt: number | undefined;
    let browserOperationDeadlineExpired = false;

    try {
      await ensureProgrammaticBrowserSession(agentId, controller.signal);
      const workingDirectory = await requireAgentWorkingDirectory(agentId);
      const semanticReadOnly = options.managedRole === "lead" || options.roleId === "lead"
        ? true
        : (options.readOnly ?? false);
      const resolvedWritePolicy = resolveWorkspaceWritePolicy({
        task: options.originalTask ?? prompt,
        workspaceRoot: workingDirectory,
        ...(options.writeScope === undefined ? {} : { writeScope: options.writeScope }),
        ...(options.allowedPaths === undefined ? {} : { allowedPaths: options.allowedPaths }),
        readOnly: semanticReadOnly,
        defaultScope: options.managed === true
          ? "task"
          : (options.allowedPaths?.length ? "configured" : "workspace"),
      });
      const automatedTurn = hostCallbacks.unattendedOrchestration === true
        || options.managed === true
        || options.participant !== undefined;
      const existingManagedCheckpoint = managedPairCheckpoints.get(operationTaskId);
      const useManagedBrowser = options.managed === true
        && definitions[agentId]?.adapter.endsWith("-browser") === true
        && !(options.managedOptional === true && options.managedRole === "lead" && !existingManagedCheckpoint);
      const configurationApi = configuration();
      const handoffBudgetSetting = typeof configurationApi.inspect === "function"
        ? configurationApi.inspect<number>("browserHandoffTotalBudgetBytes")
        : undefined;
      const explicitHandoffBudgetBytes = mostSpecificPositiveNumber(handoffBudgetSetting);
      const providerDefaultHandoffBudgetBytes = browserProviderForAdapterType(state.agents[agentId]?.adapterType ?? "") === "claude"
        ? 393_216
        : 262_144;
      // P3. Declared verification is controller-owned and adapter-agnostic. A managed turn that
      // declares checks prepares the same controller turn whichever adapter it runs on: the
      // browser loop drives actions with it, and a local turn uses it to run the checks the
      // pipeline declared. Without this, a preset whose Worker and Lead prefer local adapters
      // reached its Lead review with its declared checks never executed.
      const declaredControllerChecks = requiredControllerChecks(options.verificationChecks);
      const useLocalControllerVerification = options.managed === true
        && !useManagedBrowser
        && declaredControllerChecks.length > 0;
      const managedTurnOptions: ManagedBrowserTurnOptions | undefined =
        useManagedBrowser || useLocalControllerVerification
          ? {
              taskId: operationTaskId,
              originalTask: options.originalTask ?? prompt,
              role: options.managedRole ?? (options.roleId === "lead" ? "lead" : "worker"),
              roleSummary: [options.roleName, options.participant].filter(Boolean).join(" · "),
              workingDirectory,
              writeScope: resolvedWritePolicy.writeScope,
              readPaths: options.readPaths ?? [],
              allowedPaths: [...resolvedWritePolicy.allowedPaths],
              protectedPaths: options.protectedPaths ?? [],
              commitMode: "never",
              readOnly: semanticReadOnly,
              verificationChecks: options.verificationChecks ?? [],
              maxRevisionCycles: options.maxRevisionCycles ?? 1,
              deadlineAt: Date.now() + Math.min(
                28_800_000,
                Math.max(60_000, readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "managedTaskTimeoutMs", 7_200_000)),
              ),
              continuationMaxBytes: Math.min(
                1_048_576,
                Math.max(65_536, configuration().get<number>("managedContinuationMaxBytes", 524_288)),
              ),
              handoffTotalBudgetBytes: Math.min(
                512_000,
                Math.max(
                  16_384,
                  typeof explicitHandoffBudgetBytes === "number" ? explicitHandoffBudgetBytes : providerDefaultHandoffBudgetBytes,
                ),
              ),
              dependencyDepth: Math.min(
                5,
                Math.max(0, configuration().get<number>("browserContextDependencyDepth", 2)),
              ),
              promotionMaxBytes: Math.min(
                8 * 1024 * 1024,
                Math.max(
                  64 * 1024,
                  configuration().get<number>("browserContextPromotionMaxBytes", 768 * 1024),
                ),
              ),
              contextAttachments: attachments,
              signal: controller.signal,
              withWorkspaceMutation,
              executor: {
                timeoutMs: Math.max(
                  1_000,
                  readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "browserActionTimeoutMs", 120_000),
                ),
                terminateGraceMs: readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "interruptGraceMs", 5_000),
                maxOutputBytes: Math.max(
                  65_536,
                  configuration().get<number>("browserActionMaxOutputBytes", 1_048_576),
                ),
                maxReadBytes: Math.max(
                  65_536,
                  configuration().get<number>("browserActionMaxReadBytes", 1_048_576),
                ),
                maxSearchResults: Math.min(
                  10_000,
                  Math.max(
                    10,
                    configuration().get<number>("browserActionMaxSearchResults", 500),
                  ),
                ),
              },
              contextIndex: {
                maxInventoryFiles: Math.min(
                  1_000_000,
                  Math.max(
                    5_000,
                    configuration().get<number>("browserContextInventoryMaxFiles", 100_000),
                  ),
                ),
                inventoryTimeoutMs: Math.min(
                  120_000,
                  Math.max(
                    1_000,
                    readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "browserContextInventoryTimeoutMs", 30_000),
                  ),
                ),
                indexingTimeoutMs: Math.min(
                  120_000,
                  Math.max(
                    1_000,
                    readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "browserContextIndexTimeoutMs", 30_000),
                  ),
                ),
              },
              contextSearch: {
                maxFiles: Math.min(
                  100_000,
                  Math.max(
                    1,
                    configuration().get<number>("browserContextSearchMaxFiles", 5_000),
                  ),
                ),
                maxBytes: Math.min(
                  1_073_741_824,
                  Math.max(
                    1_048_576,
                    configuration().get<number>("browserContextSearchMaxBytes", 64 * 1024 * 1024),
                  ),
                ),
                maxFileBytes: Math.min(
                  134_217_728,
                  Math.max(
                    1_048_576,
                    configuration().get<number>("browserContextSearchMaxFileBytes", 8 * 1024 * 1024),
                  ),
                ),
                timeoutMs: Math.min(
                  120_000,
                  Math.max(
                    1_000,
                    readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "browserContextSearchTimeoutMs", 15_000),
                  ),
                ),
              },
            }
          : undefined;
      const managedBrowserOptions = useManagedBrowser ? managedTurnOptions : undefined;
      // P3. Controller verification judges what this turn changed, so the tree it started from is
      // captured before the turn runs. Without a baseline the workspace-integrity check cannot
      // tell the turn's own changes from what the working tree already had.
      const controllerVerificationBaseline = useLocalControllerVerification
        ? await captureManagedRepositoryBaseline(workingDirectory, controller.signal)
        : undefined;
      const controllerVerificationOptions = (base: ManagedBrowserTurnOptions): ManagedBrowserTurnOptions => ({
        ...base,
        ...(controllerVerificationBaseline === undefined
          ? {}
          : { repositoryBaseline: controllerVerificationBaseline }),
      });
      /**
       * P3. One controller verification pass.
       *
       * The declared checks are executed by the controller through the same code the browser turn
       * uses, and their results are bound to the fingerprint of the tree they judged. Extracted
       * because it now runs at two moments rather than one: before a Lead reviews, so the Lead
       * answers about results it was shown, and after a Worker finishes, so the Worker's own work
       * is what was checked.
       */
      const runControllerVerificationPass = async (
        base: ManagedBrowserTurnOptions,
      ): Promise<{
        authorized: boolean;
        issues: string[];
        evidence: ControllerEvidenceLine[];
        workspaceFingerprint: string;
      }> => {
        const controllerOptions = controllerVerificationOptions(base);
        const controllerTurn = await prepareManagedBrowserTurn(controllerOptions);
        const records = await runManagedControllerVerification(
          controllerTurn,
          controllerOptions,
          declaredControllerChecks.map((check) => check.id),
        );
        const authorization = controllerVerificationAuthorizes({
          required: declaredControllerChecks,
          records,
          workspaceFingerprint: controllerTurn.workspaceFingerprint,
        });
        const evidence = controllerVerificationEvidence({
          required: declaredControllerChecks,
          records,
          workspaceFingerprint: controllerTurn.workspaceFingerprint,
        });
        await appendTranscript(
          createEventEntry(
            "verification.controller",
            authorization.authorized
              ? "Controller verification passed for every declared check."
              : `Controller verification is not passing: ${authorization.issues.join(", ")}`,
            toJsonValue({
              workspaceFingerprint: controllerTurn.workspaceFingerprint,
              requiredVerificationIds: declaredControllerChecks.map((check) => check.id),
              issues: authorization.issues,
              evidence,
            }),
            agentId,
            step,
          ),
        );
        return {
          authorized: authorization.authorized,
          issues: authorization.issues,
          evidence,
          workspaceFingerprint: controllerTurn.workspaceFingerprint,
        };
      };
      // P3. A managed local Lead is verified before it answers, not after.
      //
      // The Lead's decision has to be bound to a candidate, and a candidate is a fingerprint: the
      // controller runs the declared checks over the tree, hands the Lead the results and the
      // fingerprint they belong to, and refuses any verdict that names a different one. Running
      // the pass afterwards could only tell the Lead what it should have known.
      const managedLeadReview = useLocalControllerVerification && managedTurnOptions?.role === "lead"
        ? await runControllerVerificationPass(managedTurnOptions)
        : undefined;
      // P3. What a Worker the Lead rejected is owed, consumed on the turn it is delivered to so a
      // later Worker turn in the same task cannot be handed a stale directive.
      const pendingLeadRevision = useLocalControllerVerification && managedTurnOptions?.role === "worker"
        ? managedTaskState.takeLeadRevision(operationTaskId)
        : undefined;
      if (definitions[agentId]?.adapter.endsWith("-browser") === true && !managedBrowserOptions) {
        const timeoutMs = Math.min(28_800_000, Math.max(10_000, readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "browserOperationTimeoutMs", 1_800_000)));
        browserOperationDeadlineAt = Date.now() + timeoutMs;
        browserOperationDeadlineTimer = setTimeout(() => {
          browserOperationDeadlineExpired = true;
          controller.abort();
          void adapter.interrupt().catch(() => undefined);
        }, timeoutMs);
      }
      const runtimeBrowserProvider = browserProviderForAdapterType(state.agents[agentId]?.adapterType ?? "");
      let runtimeBrowserSession = runtimeBrowserProvider
        ? bridge.resolveBoundSession(
            `${runtimeOwnerId}:${agentId}`,
            state.agents[agentId]?.browserBinding,
            state.agents[agentId]?.sessionId,
          )
        : undefined;
      if (!runtimeBrowserSession && runtimeBrowserProvider) {
        const readySessions = state.browserBridge.sessions.filter(
          (session) => session.provider === runtimeBrowserProvider && session.status === "ready",
        );
        if (readySessions.length === 1) runtimeBrowserSession = readySessions[0];
      }
      const requireAutonomousGenericCapabilities = (label: string): void => {
        if (runtimeBrowserProvider !== "generic") return;
        if (!runtimeBrowserSession || runtimeBrowserSession.provider !== "generic") {
          throw new Error(`${label} requires a selected ready generic browser conversation`);
        }
        const capabilities = runtimeBrowserSession.capabilities;
        if (!capabilities
          || capabilities.submission !== "verifiedSend"
          || capabilities.completion !== "verifiedLifecycle"
          || capabilities.interruption !== "confirmed"
          || capabilities.conversationState !== "confirmed") {
          throw new Error(`${label} requires a generic browser conversation with verified Send, verified completion lifecycle, confirmed interruption, and confirmed idle state`);
        }
      };
      if (hostCallbacks.unattendedOrchestration) {
        requireAutonomousGenericCapabilities("Unattended browser mode");
      }
      if (managedBrowserOptions) {
        requireAutonomousGenericCapabilities("Managed autonomous mode");
        const unsupportedAttachments = attachments.filter((attachment) =>
          !isSupportedBrowserAttachmentPath(attachment)
          && !isSupportedManagedContextAttachmentPath(attachment)
        );
        if (unsupportedAttachments.length > 0) {
          throw new Error(
            `Managed browser attachments must be supported images or text/code context: ${unsupportedAttachments
              .slice(0, 8)
              .map((attachment) => path.basename(attachment))
              .join(", ")}`,
          );
        }
      }
      let managedBrowserTurn: Awaited<ReturnType<typeof prepareManagedBrowserTurn>> | undefined;
      let managedTurnIsRevisionWorker = false;
      if (managedBrowserOptions) {
        managedBrowserOptions.readPaths = await resolveManagedReadPaths({
          workingDirectory: managedBrowserOptions.workingDirectory,
          originalTask: managedBrowserOptions.originalTask,
          writeScope: managedBrowserOptions.writeScope,
          ...(managedBrowserOptions.readPaths === undefined ? {} : { readPaths: managedBrowserOptions.readPaths }),
          allowedPaths: managedBrowserOptions.allowedPaths,
        });
        const seed = createManagedPairCheckpoint({
          taskId: operationTaskId,
          originalTask: managedBrowserOptions.originalTask,
          worktreePath: managedBrowserOptions.workingDirectory,
          writeScope: managedBrowserOptions.writeScope,
          readPaths: managedBrowserOptions.readPaths,
          allowedPaths: managedBrowserOptions.allowedPaths,
          ...(managedBrowserOptions.protectedPaths === undefined ? {} : { protectedPaths: managedBrowserOptions.protectedPaths }),
          commitMode: managedBrowserOptions.commitMode,
          maxRevisionCycles: managedBrowserOptions.maxRevisionCycles,
          verificationChecks: managedBrowserOptions.verificationChecks,
          deadlineAt: managedBrowserOptions.deadlineAt,
        });
        const existing = managedPairCheckpoints.get(operationTaskId);
        const freshWorkerStart = managedBrowserOptions.role === "worker"
          && (!existing
            || existing.taskHash !== seed.taskHash
            || existing.state === "FINALIZE"
            || existing.state === "BLOCKED"
            || existing.deadlineAt <= Date.now());
        const managedDeadlineAt = freshWorkerStart ? seed.deadlineAt : existing?.deadlineAt;
        if (!managedDeadlineAt) {
          throw new Error("Managed pair checkpoint is missing; restart from the Worker step");
        }
        managedBrowserOptions.deadlineAt = managedDeadlineAt;
        const managedRemainingMs = managedDeadlineAt - Date.now();
        if (managedRemainingMs <= 0) {
          throw new Error("Managed task deadline expired; restart from the Worker step");
        }
        managedDeadlineTimer = setTimeout(() => {
          managedDeadlineExpired = true;
          controller.abort();
        }, managedRemainingMs);
        const currentRepositoryBaseline = await captureManagedRepositoryBaseline(
          managedBrowserOptions.workingDirectory,
          controller.signal,
        );
        const currentWorkspaceFingerprint = computeManagedWorkspaceFingerprint({
          taskHash: seed.taskHash,
          repositoryBaseline: currentRepositoryBaseline,
        });
        if (freshWorkerStart) {
          managedPairCheckpoint = advanceManagedPair({
            ...seed,
            repositoryBaseline: currentRepositoryBaseline,
            workspaceFingerprint: currentWorkspaceFingerprint,
          }, { type: "prepared" });
        } else {
          if (!existing || existing.taskHash !== seed.taskHash) {
            throw new Error("Managed pair checkpoint is missing or does not match this task; restart from the Worker step");
          }
          if (!existing.repositoryBaseline || existing.workspaceFingerprint !== currentWorkspaceFingerprint) {
            if (managedBrowserOptions.role !== "worker") {
              throw new Error("Managed workspace changed after the Worker handoff; restart from the Worker step before Lead review");
            }
            managedPairCheckpoint = {
              ...existing,
              state: "WORKER_NEEDS_CONTEXT",
              workspaceRevision: existing.workspaceRevision + 1,
              workspaceFingerprint: currentWorkspaceFingerprint,
              repositoryBaseline: currentRepositoryBaseline,
              verification: [],
              unresolved: [...new Set([
                ...existing.unresolved,
                "Workspace state changed outside the managed controller; re-read current files and rerun verification.",
              ])],
            };
          } else {
            managedPairCheckpoint = {
              ...existing,
              repositoryBaseline: currentRepositoryBaseline,
              workspaceFingerprint: currentWorkspaceFingerprint,
              verification: existing.verification.filter(
                (record) => record.workspaceFingerprint === currentWorkspaceFingerprint,
              ),
            };
          }
        }
        const managedState = managedPairCheckpoint.state;
        if (managedBrowserOptions.role === "lead" && !managedState.startsWith("LEAD_")) {
          throw new Error(`Managed Lead cannot run while controller state is ${managedState}`);
        }
        if (managedBrowserOptions.role === "worker" && !managedState.startsWith("WORKER_")) {
          throw new Error(`Managed Worker cannot run while controller state is ${managedState}`);
        }
        managedTurnIsRevisionWorker = managedBrowserOptions.role === "worker" && managedPairCheckpoint.revisionCycles > 0;
        await setManagedPairCheckpoint(operationTaskId, managedPairCheckpoint);
        await ensureFreshManagedBrowserSession(agentId, operationTaskId, controller.signal);
        managedBrowserTurn = await prepareManagedBrowserTurn({
          ...managedBrowserOptions,
          taskHash: seed.taskHash,
          initialVerification: managedPairCheckpoint.verification,
          initialUnresolved: managedPairCheckpoint.unresolved,
          initialWorkspaceRevision: managedPairCheckpoint.workspaceRevision,
          initialChangedFiles: managedPairCheckpoint.changedFiles,
          initialDiff: managedPairCheckpoint.diffSummary,
          ...(managedPairCheckpoint.repositoryBaseline === undefined ? {} : { repositoryBaseline: managedPairCheckpoint.repositoryBaseline }),
        });
      }
      if (resultIsStale({ operationTaskId, currentTaskId: state.taskId, aborted: controller.signal.aborted })) {
        return { status: "interrupted", answer: "" };
      }
      patchAgent(agentId, { status: "running", error: undefined, output: "" });

      const sendTurn = async (
        turnPrompt: string,
        turnAttachments: string[],
        promptEventType: string,
      ): Promise<AdapterTurnResult> => {
        const managedDeadline = (): TurnDeadline => ({
          kind: "managed",
          at: managedBrowserOptions?.deadlineAt,
          expired: managedDeadlineExpired,
        });
        const browserDeadline = (): TurnDeadline => ({
          kind: "browserOperation",
          at: browserOperationDeadlineAt,
          expired: browserOperationDeadlineExpired,
        });
        const abortOnDeadline = (deadlines: readonly TurnDeadline[]): void => {
          const breach = turnDeadlineBreach(deadlines, Date.now());
          if (!breach) return;
          if (breach.kind === "managed") managedDeadlineExpired = true;
          else browserOperationDeadlineExpired = true;
          controller.abort();
          throw new Error(breach.message);
        };
        abortOnDeadline([managedDeadline(), browserDeadline()]);
        if (resultIsStale({ operationTaskId, currentTaskId: state.taskId, aborted: controller.signal.aborted })) {
          return {
            result: { status: "interrupted", answer: "" },
          };
        }
        agentStateFor(agentId).output = "";
        post({ type: "agent.reset", agentId });
        await appendTranscript(
          createEntry(
            "prompt",
            turnPrompt,
            agentId,
            step,
            promptEventType,
          ),
        );
        if (resultIsStale({ operationTaskId, currentTaskId: state.taskId, aborted: controller.signal.aborted })) {
          return { result: { status: "interrupted", answer: "" } };
        }
        abortOnDeadline([browserDeadline()]);
        const request: SendRequest = {
          sessionId: agentStateFor(agentId).sessionId,
          sessionName: hostCallbacks.getProviderChatTitle?.(agentId),
          browserBinding: agentStateFor(agentId).browserBinding,
          prompt: turnPrompt,
          workingDirectory,
          attachments: turnAttachments,
          permissionMode: options.permissionMode,
          approvalPolicy: options.approvalPolicy,
          model: options.model,
          workspacePolicy: turnWorkspacePolicy({
            readOnly: semanticReadOnly,
            writeScope: resolvedWritePolicy.writeScope,
            readPaths: options.readPaths,
            allowedPaths: resolvedWritePolicy.allowedPaths,
            protectedPaths: options.protectedPaths,
            automated: automatedTurn,
          }),
        };
        const streamLimits = { agentId, maxStoredResponseBytes };
        let stream = emptyTurnStream();
        for await (const event of turnAdapter.send(request, controller.signal)) {
          const advanced = turnStreamStep(stream, event, streamLimits);
          stream = advanced.state;
          const action = advanced.action;
          if (action.kind === "overflow") {
            controller.abort();
            await adapter.interrupt().catch(() => undefined);
            throw new Error(action.message);
          }
          if (action.kind === "failure") throw new Error(action.message);
          if (action.kind === "session") {
            patchAgent(agentId, { sessionId: action.sessionId }, true);
            continue;
          }
          if (action.kind === "append") {
            queueDelta(agentId, action.text);
            continue;
          }
          if (action.kind === "replace") {
            replaceAgentOutput(agentId, action.text);
            continue;
          }
          if (action.kind === "notice") {
            await appendTranscript(createEntry("status", action.message));
            continue;
          }
          if (action.kind === "captured") {
            const agent = agentStateFor(agentId);
            const browserBinding = capturedBrowserBinding({
              adapterType: agent.adapterType,
              response: action.response,
              preferredTabId: agent.browserBinding?.preferredTabId,
            });
            if (browserBinding) {
              bridge.bindConversation(`${runtimeOwnerId}:${agentId}`, browserBinding);
              patchAgent(
                agentId,
                {
                  ...(action.response.finalSessionId === undefined
                    ? {}
                    : { sessionId: action.response.finalSessionId }),
                  browserBinding,
                },
                true,
              );
            }
          }
        }
        const afterStream = turnDeadlineBreach(
          [managedDeadline(), browserDeadline()],
          Date.now(),
        );
        if (afterStream) throw new Error(afterStream.message);
        const outcome = turnStreamOutcome(stream, streamLimits);
        if (outcome.failure !== undefined) throw new Error(outcome.failure);
        flushDelta(agentId);
        await appendTranscript(
          createEntry(
            outcome.entry.kind,
            outcome.entry.answer,
            agentId,
            step,
            outcome.entry.eventType,
            outcome.entry.payload,
          ),
        );
        return {
          result: outcome.result,
          ...(outcome.capturedResponse === undefined
            ? {}
            : { capturedResponse: outcome.capturedResponse }),
        };
      };

      const isBrowserAgent = definitions[agentId]?.adapter.endsWith("-browser") === true;
      const structuredTurnToken = isBrowserAgent && programmaticAutoProvisioning && !managedBrowserTurn
        ? randomUUID()
        : undefined;
      // P3. The controller's own block, appended to whatever the preset asked for. A managed local
      // Lead is told which candidate it is judging, what the controller's checks said about it and
      // the exact shape its answer must take; a Worker the Lead rejected is told what the Lead
      // named and what the controller found, kept apart from each other.
      const managedControllerBlock = managedLeadReview
        ? managedLeadReviewPrompt({
            candidate: managedLeadReview.workspaceFingerprint,
            issues: managedLeadReview.issues,
            evidence: managedLeadReview.evidence,
          })
        : pendingLeadRevision
          ? managedWorkerRevisionPrompt(pendingLeadRevision)
          : undefined;
      const initialPrompt = managedBrowserTurn
        ? managedBrowserTurn.prompt
        : isBrowserAgent && programmaticAutoProvisioning
          ? [prompt, browserWorkspaceProtocolPrompt(options, structuredTurnToken!)].join("\n\n")
          : managedControllerBlock
            ? [prompt, managedControllerBlock].join("\n\n")
            : prompt;
      const initialAttachments = managedBrowserTurn
        ? attachments.filter(isSupportedBrowserAttachmentPath)
        : attachments;
      const initial = await sendTurn(initialPrompt, initialAttachments, "agent.prompt");
      let status = initial.result.status;
      let lastNaturalAnswer = initial.result.answer;
      const browserTurns = [initial.result.answer];
      const browserResponses: Array<CapturedResponse | undefined> = [
        initial.capturedResponse,
      ];
      let providerAssetsObserved = (initial.capturedResponse?.assets.length ?? 0) > 0;
      const recordBrowserTurn = (turn: AdapterTurnResult): void => {
        providerAssetsObserved ||= (turn.capturedResponse?.assets.length ?? 0) > 0;
        if (managedBrowserTurn) {
          browserTurns.splice(0, browserTurns.length, turn.result.answer);
          browserResponses.splice(0, browserResponses.length, turn.capturedResponse);
          return;
        }
        browserTurns.push(turn.result.answer);
        browserResponses.push(turn.capturedResponse);
      };
      const managedConversationLimitBytes = managedConversationMaxBytes(
        configuration().get<number>(
          "browserManagedConversationMaxBytes",
          MANAGED_CONVERSATION_DEFAULT_BYTES,
        ),
      );
      let managedConversationBytes = managedBrowserTurn
        ? Buffer.byteLength(initialPrompt, "utf8") + Buffer.byteLength(initial.result.answer, "utf8")
        : 0;
      let managedConversationRollovers = 0;
      const sendManagedContinuation = async (
        continuationPrompt: string,
        promptEventType: string,
      ): Promise<AdapterTurnResult> => {
        if (!managedBrowserOptions || !managedBrowserTurn) {
          return await sendTurn(continuationPrompt, [], promptEventType);
        }
        let effectivePrompt = continuationPrompt;
        if (
          managedConversationRolloverRequired(
            managedConversationBytes,
            Buffer.byteLength(continuationPrompt, "utf8"),
            managedConversationLimitBytes,
          )
        ) {
          managedConversationRollovers += 1;
          await ensureFreshManagedBrowserSession(
            agentId,
            managedRolloverTaskId(operationTaskId, managedConversationRollovers),
            controller.signal,
          );
          managedBrowserTurn = await prepareManagedBrowserTurn({
            ...managedBrowserOptions,
            taskHash: managedPairCheckpoint?.taskHash ?? managedBrowserTurn.taskHash,
            initialVerification: managedBrowserTurn.verification,
            initialUnresolved: managedPairCheckpoint?.unresolved ?? managedBrowserOptions.initialUnresolved,
            initialWorkspaceRevision: managedBrowserTurn.workspaceRevision,
            initialChangedFiles: managedBrowserTurn.changedFiles,
            initialDiff: managedBrowserTurn.diff,
            repositoryBaseline: managedBrowserTurn.repositoryBaseline,
          });
          effectivePrompt = composeManagedRolloverPrompt({
            preparedPrompt: managedBrowserTurn.prompt,
            continuationPrompt,
            maxBytes: managedConversationLimitBytes,
          });
          managedConversationBytes = 0;
          await appendTranscript(
            createEventEntry(
              "browser.managed.conversationRollover",
              `Opened fresh managed role conversation ${String(managedConversationRollovers)} after reaching the cumulative context budget.`,
              toJsonValue({
                managedConversationMaxBytes: managedConversationLimitBytes,
                workspaceRevision: managedBrowserTurn.workspaceRevision,
                workspaceFingerprint: managedBrowserTurn.workspaceFingerprint,
              }),
              agentId,
              step,
            ),
          );
        }
        const result = await sendTurn(effectivePrompt, [], promptEventType);
        managedConversationBytes += Buffer.byteLength(effectivePrompt, "utf8")
          + Buffer.byteLength(result.result.answer, "utf8");
        return result;
      };
      const browserRounds: BrowserActionRound[] = [];
      const seenFingerprints = new Set<string>();
      let capturedResponse = initial.capturedResponse;
      let actionCount = 0;
      let managedRepairAttempts = 0;
      const managedControllerEvidence: string[] = [];
      const maximumRounds = Math.min(
        100,
        Math.max(
          1,
          configuration().get<number>("browserActionMaxRounds", 32),
        ),
      );
      const maximumActions = Math.min(
        1_000,
        Math.max(
          1,
          configuration().get<number>("browserActionMaxActions", 64),
        ),
      );
      const semanticInterpreterEnabled = configuration().get<boolean>(
        "browserSemanticInterpreterEnabled",
        false,
      );
      const semanticInterpreterOptions = () => {
        const apiKeyEnvironment = configuration()
          .get<string>("browserSemanticInterpreterApiKeyEnvironment", "")
          .trim();
        return {
          backend: configuration().get<"auto" | "lmstudio" | "ollama">(
            "browserSemanticInterpreterBackend",
            "auto",
          ),
          endpoint: configuration().get<string>(
            "browserSemanticInterpreterEndpoint",
            "",
          ),
          model: configuration().get<string>(
            "browserSemanticInterpreterModel",
            "prism-ml/Bonsai-27B-mlx-1bit",
          ),
          apiKey: apiKeyEnvironment ? process.env[apiKeyEnvironment] : undefined,
          timeoutMs: Math.max(
            1_000,
            readTimeoutSetting(
              (settingKey, settingFallback) => configuration().get(settingKey, settingFallback),
              "browserSemanticInterpreterTimeoutMs",
              30_000,
            ),
          ),
          maxInputBytes: Math.max(
            16_384,
            configuration().get<number>(
              "browserSemanticInterpreterMaxInputBytes",
              262_144,
            ),
          ),
          allowRemote: configuration().get<boolean>(
            "browserSemanticInterpreterAllowRemote",
            false,
          ),
        };
      };

      for (
        let round = 1;
        capturedResponse &&
        status === "completed" &&
        round <= maximumRounds + 1 &&
        !controller.signal.aborted;
        round += 1
      ) {
        const terminalOnlyRound = round > maximumRounds;
        if (managedBrowserTurn && managedBrowserOptions) {
          const prospectiveEnvelope = extractBrowserControlEnvelopeFromCaptured(capturedResponse);
          if (terminalOnlyRound && (prospectiveEnvelope?.actions.length ?? 0) > 0) {
            await appendTranscript(
              createEventEntry(
                "browser.action.limit",
                `Managed browser action loop exhausted ${String(maximumRounds)} action rounds with unexecuted controller actions.`,
                toJsonValue({ maximumRounds, attemptedActions: prospectiveEnvelope?.actions.length ?? 0 }),
                agentId,
                step,
              ),
            );
            throw new Error(`Managed browser action round budget exhausted with unexecuted actions (${String(maximumRounds)} rounds)`);
          }
          if (prospectiveEnvelope && actionCount + prospectiveEnvelope.actions.length > maximumActions) {
            await appendTranscript(
              createEventEntry(
                "browser.action.limit",
                `Managed browser action loop stopped before exceeding ${String(maximumActions)} actions.`,
                toJsonValue({ maximumActions, attemptedActions: prospectiveEnvelope.actions.length }),
                agentId,
                step,
              ),
            );
            throw new Error(`Managed browser action budget exhausted before terminal controller state (${String(maximumActions)} actions)`);
          }
          let controlled = prospectiveEnvelope
            ? await executeManagedBrowserEnvelope(
                prospectiveEnvelope,
                managedBrowserTurn,
                managedBrowserOptions,
                (action) => managedBrowserActionApproval(agentId, action, workingDirectory),
              )
            : await executeManagedBrowserControl(
                capturedResponse.text,
                managedBrowserTurn,
                managedBrowserOptions,
                (action) => managedBrowserActionApproval(agentId, action, workingDirectory),
              );
          if (!controlled.recognized && semanticInterpreterEnabled && !terminalOnlyRound) {
            const interpreted = await interpretBrowserActions(
              capturedResponse.text,
              capturedResponse.segments,
              [],
              { ...semanticInterpreterOptions(), managedContextActions: true },
              controller.signal,
            );
            if (interpreted.warning) {
              await appendTranscript(
                createEventEntry(
                  "browser.managed.localInterpreter.warning",
                  interpreted.warning,
                  undefined,
                  agentId,
                  step,
                ),
              );
            }
            const contextActions: BrowserControlEnvelope["actions"] = [...interpreted.contextActions];
            for (const action of interpreted.actions) {
              if (action.kind === "workspace.list" && action.path) {
                contextActions.push({ kind: "context.list", path: action.path });
                continue;
              }
              if (action.kind === "workspace.read" && action.path) {
                contextActions.push({ kind: "context.readFile", path: action.path });
                continue;
              }
              if (action.kind === "workspace.search" && action.query) {
                contextActions.push({
                  kind: "context.search",
                  query: action.query,
                  ...(action.path && action.path !== "." ? { pathPrefix: action.path } : {}),
                });
              }
            }
            if (contextActions.length > 0) {
              if (actionCount + contextActions.length > maximumActions) {
                await appendTranscript(
                  createEventEntry(
                    "browser.action.limit",
                    `Managed local interpretation stopped before exceeding ${String(maximumActions)} actions.`,
                    toJsonValue({ maximumActions, attemptedActions: contextActions.length }),
                    agentId,
                    step,
                  ),
                );
                throw new Error(`Managed local interpreter action budget exhausted before terminal controller state (${String(maximumActions)} actions)`);
              }
              const localEnvelope: BrowserControlEnvelope = {
                protocol: "bachata-browser-turn-v1",
                status: "needContext",
                actions: contextActions,
                summary: "Local interpreter selected controller-generated read-only context requests.",
                objections: [],
                unresolved: [],
              };
              controlled = await executeManagedBrowserEnvelope(
                localEnvelope,
                managedBrowserTurn,
                managedBrowserOptions,
                (action) => managedBrowserActionApproval(agentId, action, workingDirectory),
              );
              if (controlled.recognized) {
                await appendTranscript(
                  createEventEntry(
                    "browser.managed.localInterpreter",
                    `Local interpreter selected ${String(contextActions.length)} read-only context action(s).`,
                    toJsonValue({ actionKinds: contextActions.map((action) => action.kind) }),
                    agentId,
                    step,
                  ),
                );
              }
            }
          }
          if (!controlled.recognized) {
            if (terminalOnlyRound) {
              await appendTranscript(
                createEventEntry(
                  "browser.action.limit",
                  `Managed browser action loop exhausted ${String(maximumRounds)} action rounds without a terminal controller response.`,
                  toJsonValue({ maximumRounds }),
                  agentId,
                  step,
                ),
              );
              throw new Error(`Managed browser action round budget exhausted before terminal controller state (${String(maximumRounds)} rounds)`);
            }
            if (managedRepairAttempts >= 1) {
              await appendTranscript(
                createEventEntry(
                  "browser.managed.invalidControl",
                  "Managed browser turn did not return a valid bachata-control envelope after one repair attempt.",
                  undefined,
                  agentId,
                  step,
                ),
              );
              throw new Error("Managed browser returned invalid control output after the repair attempt");
            }
            managedRepairAttempts += 1;
            const continuation = await sendManagedContinuation(
              [
                "Your previous response did not contain a valid managed control envelope. Do not emit executable prose. Return one valid final bachata-control object for the current task.",
                browserControlProtocolPrompt,
              ].join("\n\n"),
              "browser.managed.controlRepair",
            );
            status = continuation.result.status;
            lastNaturalAnswer = continuation.result.answer;
            recordBrowserTurn(continuation);
            capturedResponse = continuation.capturedResponse;
            continue;
          }
          managedRepairAttempts = 0;
          actionCount += controlled.envelope?.actions.length ?? 0;
          const activeManagedTurn = managedBrowserTurn;
          if (!activeManagedTurn) {
            throw new Error("Managed browser turn state is unavailable after control validation");
          }
          const verificationIssues = verificationProblems(
            managedBrowserOptions.verificationChecks,
            controlled.verification,
            activeManagedTurn.workspaceFingerprint,
          );
          const terminalObjections = managedTurnObjections(controlled.envelope);
          const verificationGate = verificationGateHolds({
            terminal: controlled.terminal,
            hasEnvelope: Boolean(controlled.envelope),
            envelopeStatus: controlled.envelope?.status,
            issues: verificationIssues,
            role: managedBrowserOptions.role,
            terminalObjections,
          });
          if (managedPairCheckpoint && controlled.envelope) {
            const envelope = controlled.envelope;
            const updateCheckpoint = async (event: Parameters<typeof advanceManagedPair>[1]): Promise<void> => {
              const nextCheckpoint = advanceManagedPair(managedPairCheckpoint!, event);
              await setManagedPairCheckpoint(operationTaskId, nextCheckpoint);
              managedPairCheckpoint = nextCheckpoint;
            };
            // EX-AUD-12. Which checkpoint events this turn produces, and in which order, is
            // decided in `managedTurn.ts`; attaching the evidence each one carries and
            // persisting it stays here.
            const checkpointSteps = managedCheckpointSteps({
              role: managedBrowserOptions.role,
              state: managedPairCheckpoint.state,
              envelope,
              anyActionCompleted: controlled.actionResults.some(
                (result) => result.status === "completed",
              ),
              isRevision: managedTurnIsRevisionWorker,
              terminal: controlled.terminal,
              verificationGateHolds: verificationGate,
            });
            for (const checkpointStep of checkpointSteps) {
              if (checkpointStep.event === "patchApplied" || checkpointStep.event === "revisionApplied") {
                await updateCheckpoint({
                  type: checkpointStep.event,
                  changedFiles: controlled.changedFiles,
                  diffSummary: activeManagedTurn.diff,
                  workspaceFingerprint: activeManagedTurn.workspaceFingerprint,
                  repositoryBaseline: activeManagedTurn.repositoryBaseline,
                });
                continue;
              }
              if (checkpointStep.event === "verificationCompleted") {
                const verification = controlled.verification.map((record) => {
                  if (record.workspaceFingerprint !== activeManagedTurn.workspaceFingerprint) {
                    throw new Error(`Managed verification result ${record.id} is missing or stale`);
                  }
                  return {
                    ...record,
                    workspaceFingerprint: record.workspaceFingerprint,
                  };
                });
                await updateCheckpoint({
                  type: "verificationCompleted",
                  verification,
                  workspaceFingerprint: activeManagedTurn.workspaceFingerprint,
                  repositoryBaseline: activeManagedTurn.repositoryBaseline,
                });
                continue;
              }
              if (checkpointStep.event === "blocked") {
                await updateCheckpoint({ type: "blocked", reason: checkpointStep.reason });
                continue;
              }
              if (checkpointStep.event === "leadRequestedRevision") {
                await updateCheckpoint({
                  type: "leadRequestedRevision",
                  objections: [...checkpointStep.objections],
                });
                continue;
              }
              await updateCheckpoint({ type: checkpointStep.event });
            }
          }
          const managedEvidence = {
            status: controlled.envelope?.status ?? "unknown",
            summary: controlled.envelope?.summary ?? "",
            objections: controlled.envelope?.objections ?? [],
            unresolved: controlled.envelope?.unresolved ?? [],
            actionResults: controlled.actionResults.map(sanitizedBrowserActionResult),
            changedFiles: controlled.changedFiles,
            verification: controlled.verification,
            verificationGate: verificationGate
              ? {
                  // The Lead is told which checks were required and what is wrong with each,
                  // by id and in the check's own words — not a rewritten summary of them.
                  requiredVerificationIds: managedBrowserOptions.verificationChecks.map(
                    (check) => check.id,
                  ),
                  issues: verificationIssues,
                }
              : undefined,
            checkpoint: managedPairCheckpoint
              ? {
                  state: managedPairCheckpoint.state,
                  workspaceRevision: managedPairCheckpoint.workspaceRevision,
                  revisionCycles: managedPairCheckpoint.revisionCycles,
                  unresolved: managedPairCheckpoint.unresolved,
                }
              : undefined,
          };
          managedControllerEvidence.push(JSON.stringify(managedEvidence, null, 2).slice(0, 65_536));
          await appendTranscript(
            createEventEntry(
              "browser.managed.control",
              `Managed browser status: ${controlled.envelope?.status ?? "unknown"}`,
              toJsonValue({
                envelope: controlled.envelope,
                actionResults: managedEvidence.actionResults,
                changedFiles: controlled.changedFiles,
                verification: controlled.verification,
              }),
              agentId,
              step,
            ),
          );
          // EX-AUD-12. What the agent is told next, and whether there is a next turn at all,
          // are decided in `managedTurn.ts`.
          const nextManagedPrompt = managedNextPrompt({
            verificationGateHolds: verificationGate,
            role: managedBrowserOptions.role,
            issues: verificationIssues,
            protocolPrompt: browserControlProtocolPrompt,
            ...(controlled.nextPrompt === undefined ? {} : { nextPrompt: controlled.nextPrompt }),
          });
          if (
            !nextManagedPrompt
            || !managedTurnContinues({
              terminal: controlled.terminal,
              verificationGateHolds: verificationGate,
              nextPrompt: nextManagedPrompt,
              aborted: controller.signal.aborted,
            })
          ) {
            break;
          }
          if (terminalOnlyRound) {
            await appendTranscript(
              createEventEntry(
                "browser.action.limit",
                `Managed browser action loop exhausted ${String(maximumRounds)} action rounds before reaching a terminal controller state.`,
                toJsonValue({ maximumRounds, status: controlled.envelope?.status ?? "unknown" }),
                agentId,
                step,
              ),
            );
            throw new Error(`Managed browser action round budget exhausted before terminal controller state (${String(maximumRounds)} rounds)`);
          }
          const continuation = await sendManagedContinuation(
            nextManagedPrompt,
            "browser.managed.resultsReinjected",
          );
          status = continuation.result.status;
          lastNaturalAnswer = continuation.result.answer;
          recordBrowserTurn(continuation);
          capturedResponse = continuation.capturedResponse;
          continue;
        }

        let detectedActions = extractBrowserActions(
          capturedResponse.text,
          capturedResponse.segments,
          structuredTurnToken,
        );
        if (semanticInterpreterEnabled && !terminalOnlyRound) {
          const interpreted = await interpretBrowserActions(
            capturedResponse.text,
            capturedResponse.segments,
            detectedActions,
            semanticInterpreterOptions(),
            controller.signal,
          );
          detectedActions = interpreted.actions;
          if (interpreted.warning) {
            await appendTranscript(
              createEventEntry(
                "browser.semantic.warning",
                interpreted.warning,
                undefined,
                agentId,
                step,
              ),
            );
          }
        }
        const actions = detectedActions.filter(
          (action) =>
            !seenFingerprints.has(`${workingDirectory}\0${action.fingerprint}`),
        );
        if (actions.length === 0) {
          if (detectedActions.length > 0) {
            await appendTranscript(
              createEventEntry(
                "browser.action.repeated",
                "Browser action loop repeated only actions that were already executed and did not provide a terminal response.",
                toJsonValue({ repeatedActions: detectedActions.length }),
                agentId,
                step,
              ),
            );
            throw new Error("Browser action loop repeated already executed actions without a terminal response");
          }
          break;
        }
        const budgetRefusal = browserActionBudgetRefusal({
          actionCount,
          pendingActions: actions.length,
          maximumActions,
          maximumRounds,
          terminalOnlyRound,
        });
        if (budgetRefusal) {
          await appendTranscript(
            createEventEntry(
              "browser.action.limit",
              budgetRefusal.event,
              toJsonValue(budgetRefusal.payload),
              agentId,
              step,
            ),
          );
          throw new Error(budgetRefusal.message);
        }
        actions.forEach((action) =>
          seenFingerprints.add(`${workingDirectory}\0${action.fingerprint}`),
        );
        actionCount += actions.length;
        const results: BrowserActionExecutionResult[] = [];
        let stopLoop = false;
        for (const action of actions) {
          await appendTranscript(
            createEventEntry(
              "browser.action.detected",
              describeBrowserAction(action),
              sanitizedBrowserAction(action),
              agentId,
              step,
            ),
          );
          const decision = await browserActionApproval(
            agentId,
            action,
            workingDirectory,
          );
          if (decision !== "approve") {
            const rejection = browserActionRejection(decision);
            const rejected = sanitizedBrowserActionResult(
              rejectedBrowserActionResult(action, rejection.reason),
            );
            results.push(rejected);
            await appendTranscript(
              createEventEntry(
                "browser.action.result",
                rejected.summary,
                toJsonValue({
                  action: sanitizedBrowserAction(action),
                  result: rejected,
                }),
                agentId,
                step,
              ),
            );
            if (rejection.stopLoop) {
              stopLoop = true;
              status = "interrupted";
              break;
            }
            continue;
          }
          const executeLocalAction = () => executeBrowserAction(action, {
            workingDirectory,
            signal: controller.signal,
            ...browserActionLimits({
              timeoutMs: readTimeoutSetting((settingKey, settingFallback) => configuration().get(settingKey, settingFallback), "browserActionTimeoutMs", 120_000),
              terminateGraceMs: readTimeoutSetting(
                (settingKey, settingFallback) => configuration().get(settingKey, settingFallback),
                "interruptGraceMs",
                5_000,
              ),
              maxOutputBytes: configuration().get<number>("browserActionMaxOutputBytes", 1_048_576),
              maxReadBytes: configuration().get<number>("browserActionMaxReadBytes", 1_048_576),
              maxSearchResults: configuration().get<number>("browserActionMaxSearchResults", 500),
            }),
            mutationContext: browserActionMutationContext({
              allowedPaths: options.allowedPaths,
              protectedPaths: options.protectedPaths,
              readOnly: options.readOnly,
            }),
          });
          const rawExecuted = action.risk === "readOnly"
            ? await executeLocalAction()
            : await withWorkspaceMutation(executeLocalAction);
          const executed = sanitizedBrowserActionResult(rawExecuted);
          results.push(executed);
          await appendTranscript(
            createEventEntry(
              "browser.action.result",
              executed.summary,
              toJsonValue({
                action: sanitizedBrowserAction(action),
                result: executed,
              }),
              agentId,
              step,
            ),
          );
        }
        browserRounds.push({ response: capturedResponse, actions, results });
        if (stopLoop || controller.signal.aborted) {
          break;
        }
        const resultPrompt = renderBrowserResultsPrompt(
          round,
          capturedResponse,
          actions,
          results,
          structuredTurnToken,
        );
        const continuation = await sendTurn(
          resultPrompt,
          [],
          "browser.results.reinjected",
        );
        status = continuation.result.status;
        lastNaturalAnswer = continuation.result.answer;
        recordBrowserTurn(continuation);
        capturedResponse = continuation.capturedResponse;
      }

      if (controller.signal.aborted && status === "completed") {
        status = "interrupted";
      }

      // P3. Controller-owned verification for a managed turn that is not a browser turn.
      //
      // The checks come from the run's immutable pipeline snapshot, they are executed by the
      // controller through the same code the browser turn uses, and their results are bound to
      // the workspace fingerprint they were produced against. Nothing here decides what a check
      // may run: that stays with `orchestrator/verificationPolicy.ts` and its existing approval.
      let controllerVerificationLines: ControllerEvidenceLine[] = [];
      let controllerVerificationIssues: string[] = [];
      let controllerVerificationBlocked = false;
      if (managedLeadReview && status === "completed") {
        // The Lead's pass ran before its turn, so it is not repeated here: what the Lead read is
        // what the run reasons about afterwards.
        controllerVerificationLines = managedLeadReview.evidence;
        controllerVerificationIssues = managedLeadReview.issues;
        controllerVerificationBlocked = !managedLeadReview.authorized;
      } else if (useLocalControllerVerification && managedTurnOptions && status === "completed") {
        let attemptsUsed = 0;
        for (;;) {
          if (resultIsStale({ operationTaskId, currentTaskId: state.taskId, aborted: controller.signal.aborted })) {
            return { status: "interrupted", answer: "" };
          }
          const pass = await runControllerVerificationPass(managedTurnOptions);
          controllerVerificationIssues = pass.issues;
          controllerVerificationLines = pass.evidence;
          const outcome = controllerVerificationOutcome({
            role: managedTurnOptions.role,
            authorized: pass.authorized,
            attemptsUsed,
            maxRevisionCycles: managedTurnOptions.maxRevisionCycles,
          });
          if (outcome.outcome === "advance") {
            break;
          }
          if (outcome.outcome === "blocked") {
            controllerVerificationBlocked = true;
            break;
          }
          attemptsUsed = outcome.attempt;
          const continuation = await sendTurn(
            controllerVerificationPrompt({
              role: managedTurnOptions.role,
              issues: pass.issues,
              evidence: pass.evidence,
            }),
            [],
            "verification.controller.revision",
          );
          status = continuation.result.status;
          lastNaturalAnswer = continuation.result.answer;
          if (status !== "completed") {
            break;
          }
        }
      }
      if (controllerVerificationBlocked && managedTurnOptions?.role === "worker") {
        throw new Error(
          `Managed Worker cannot finish: required verification is not passing (${controllerVerificationIssues.join(", ")})`,
        );
      }
      let controllerVerificationSendsBack = false;
      if (controllerVerificationBlocked && managedTurnOptions) {
        const used = managedTaskState.spendRevision(operationTaskId);
        if (used > Math.max(0, managedTurnOptions.maxRevisionCycles)) {
          throw new Error(
            `Managed Lead cannot approve: required verification is not passing after ${String(used - 1)} revision cycle(s) (${controllerVerificationIssues.join(", ")})`,
          );
        }
        controllerVerificationSendsBack = true;
      }
      // P3. What a managed local Lead's own answer does to the run.
      //
      // Reached only when the controller's checks already authorize the candidate: a Lead facing
      // failing checks has nothing to approve and is handled above. The verdict is structured,
      // validated and bound to the candidate the Lead was shown, and every way of not answering —
      // no JSON, invalid JSON, a verdict about a different candidate, an acceptance that lists
      // defects, a rejection that lists none — fails the task rather than advancing it. A Lead
      // that edited the tree fails here too, because the candidate it judged is no longer the
      // candidate that exists.
      if (managedLeadReview && managedTurnOptions && !controllerVerificationBlocked && status === "completed") {
        const currentCandidate = await managedWorkspaceFingerprint(
          controllerVerificationOptions(managedTurnOptions),
        );
        const decision = managedLeadDecision({
          answer: lastNaturalAnswer,
          candidate: managedLeadReview.workspaceFingerprint,
          currentCandidate,
        });
        await appendTranscript(
          createEventEntry(
            "review.managedLead",
            decision.decision === "invalid"
              ? `Managed Lead returned no usable verdict: ${decision.problems.join("; ")}`
              : decision.decision === "accept"
                ? "Managed Lead accepted the candidate."
                : `Managed Lead rejected the candidate with ${String(decision.defects.length)} defect(s).`,
            toJsonValue({
              decision: decision.decision,
              candidate: managedLeadReview.workspaceFingerprint,
              currentCandidate,
              ...(decision.decision === "invalid" ? { problems: decision.problems } : {}),
              ...(decision.decision === "reject"
                ? { defects: decision.defects.map((defect) => defect.id) }
                : {}),
            }),
            agentId,
            step,
          ),
        );
        if (decision.decision === "invalid") {
          throw new Error(
            `Managed Lead did not return a usable review verdict: ${decision.problems.join("; ")}`,
          );
        }
        if (decision.decision === "reject") {
          const used = managedTaskState.spendRevision(operationTaskId);
          if (used > Math.max(0, managedTurnOptions.maxRevisionCycles)) {
            throw new Error(
              `Managed Lead rejected the candidate after ${String(used - 1)} revision cycle(s), which is the whole revision budget: ${decision.defects.map((defect) => defect.id).join(", ")}`,
            );
          }
          managedTaskState.holdLeadRevision(operationTaskId, {
            candidate: managedLeadReview.workspaceFingerprint,
            summary: decision.summary,
            defects: decision.defects,
            evidence: managedLeadReview.evidence,
          });
          controllerVerificationSendsBack = true;
        }
      }

      if (managedBrowserOptions && managedPairCheckpoint && status === "completed") {
        if (managedPairCheckpoint.state === "BLOCKED") {
          throw new Error(`Managed pair is blocked: ${managedPairCheckpoint.unresolved.join("; ") || "unspecified reason"}`);
        }
        if (managedBrowserOptions.role === "worker") {
          const expectedState = managedPairCheckpoint.revisionCycles >= managedPairCheckpoint.policy.maxRevisionCycles
            ? "LEAD_FINAL_REVIEW"
            : "LEAD_REVIEW";
          if (managedPairCheckpoint.state !== expectedState) {
            throw new Error(`Managed Worker stopped before completing its controller transition: ${managedPairCheckpoint.state}`);
          }
        } else if (managedPairCheckpoint.state === "FINALIZE") {
          const completion = validateManagedCompletion(managedPairCheckpoint);
          if (!completion.valid) {
            throw new Error(`Managed Lead did not finalize successfully: ${completion.reasons.join(", ")}`);
          }
        } else if (managedPairCheckpoint.state !== "WORKER_REVISE") {
          throw new Error(`Managed Lead stopped before completing its controller transition: ${managedPairCheckpoint.state}`);
        }
      }

      const hasProviderAssets = providerAssetsObserved;
      // P3. The Lead reads the controller's own result, not a report of it: every required check
      // by id, the command that ran, its status, its exit information and its bounded output.
      const controllerVerificationAnswer = controllerVerificationLines.length > 0
        ? [
            "Bachata controller verification (authoritative, run by the controller against this candidate):",
            renderControllerVerificationEvidence(controllerVerificationLines),
          ].join("\n\n")
        : undefined;
      const answer = managedBrowserTurn && managedControllerEvidence.length > 0
        ? [
            lastNaturalAnswer,
            "Bachata managed controller evidence (authoritative execution state):",
            ...managedControllerEvidence,
          ].join("\n\n")
        : initial.capturedResponse &&
            (browserRounds.length > 0 || hasProviderAssets)
          ? renderAugmentedBrowserAnswer(
              browserTurns,
              browserRounds,
              browserResponses,
            )
          : lastNaturalAnswer;
      const finalBytes = Buffer.byteLength(answer, "utf8");
      if (finalBytes > maxStoredResponseBytes * 4) {
        throw new Error(
          `${agentId} augmented response exceeded ${String(maxStoredResponseBytes * 4)} bytes`,
        );
      }
      patchAgent(
        agentId,
        {
          status: status === "interrupted" ? "interrupted" : "idle",
          output: lastNaturalAnswer,
          ...(undefined === undefined ? {} : { error: undefined }),
        },
        true,
      );
      return {
        status,
        answer: controllerVerificationAnswer ? [answer, controllerVerificationAnswer].join("\n\n") : answer,
        ...(managedPairCheckpoint ? {
          managedState: {
            state: managedPairCheckpoint.state,
            revisionCycles: managedPairCheckpoint.revisionCycles,
            maxRevisionCycles: managedPairCheckpoint.policy.maxRevisionCycles,
          },
        } : {}),
        ...(controllerVerificationSendsBack && managedTurnOptions
          ? {
              managedState: {
                state: "WORKER_REVISE",
                revisionCycles: managedTaskState.revisionsUsed(operationTaskId),
                maxRevisionCycles: managedTurnOptions.maxRevisionCycles,
              },
            }
          : {}),
      };
    } catch (error) {
      flushDelta(agentId);
      if (managedPairCheckpoint && isProviderFailureError(error)) {
        const nextCheckpoint = advanceManagedPair(managedPairCheckpoint, {
          type: "providerFailed",
          agentId,
          code: error.failure.code,
          sideEffects: error.failure.sideEffects,
        });
        await setManagedPairCheckpoint(operationTaskId, nextCheckpoint);
        managedPairCheckpoint = nextCheckpoint;
      }
      // A protocol rejection or a refused read scope is not retried and not moved to another
      // provider. The human is told what happened and what they can do about it.
      const recovery = isProviderFailureError(error)
        ? providerRecovery(error.failure)
        : undefined;
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = recovery ? providerRecoveryStatement(recovery) : rawMessage;
      patchAgent(agentId, { status: "error", error: message }, true);
      // EX-UI-01. The failure is recorded where the step is, and the choices Bachata already
      // knows travel with it as data rather than as prose, so the reader is offered controls
      // beside the failure instead of a list of sentences describing controls. The raw provider
      // message travels too, for the disclosure that holds technical detail.
      await appendTranscriptAfterCommit(
        recovery
          ? createEntry("error", message, agentId, step, "provider.recovery", {
              title: recovery.title,
              statement: recovery.statement,
              provider: recovery.provider,
              code: recovery.code,
              detail: rawMessage,
              choices: recovery.choices.map((choice) => ({
                id: choice.id,
                label: choice.label,
                detail: choice.detail,
                ...(choice.setting === undefined ? {} : { setting: choice.setting }),
              })),
            })
          : createEntry("error", message, agentId, step),
        "This agent failure",
      );
      throw error;
    } finally {
      if (managedDeadlineTimer) clearTimeout(managedDeadlineTimer);
      if (browserOperationDeadlineTimer) clearTimeout(browserOperationDeadlineTimer);
      if (abortControllers.get(agentId)?.controller === controller) {
        abortControllers.delete(agentId);
      }
      if (activeCompletions.get(agentId)?.completion === completion) {
        activeCompletions.delete(agentId);
      }
      completeOperation();
      releaseAgents([agentId], ownerId);
      await recordCancelledApprovals(
        agentId,
        releasePendingApprovals(agentId),
        "cancelled",
      );
    }
  };

  const answerSemanticQuestionWithLead = async (
    originAgentId: string,
    request: {
      title: string;
      prompt: string;
      options: RuntimeInteractionOption[];
      allowFreeText: boolean;
    },
  ): Promise<RuntimeInteractionResponse> => {
    const leadAgentId = state.roles.lead;
    if (!leadAgentId || leadAgentId === originAgentId || !adapters[leadAgentId]) {
      return { selected: [], freeText: "", source: "timeout" };
    }
    const allowed = new Set(request.options.map((option) => option.id));
    const prompt = [
      "The user did not answer before the fallback deadline.",
      "Answer this task question as the configured Lead.",
      "Return JSON only: {\"selected\":[\"option-id\"],\"freeText\":\"optional text\"}.",
      "Use only listed option IDs. Use freeText only when needed.",
      `Title: ${request.title}`,
      `Question: ${request.prompt}`,
      `Options: ${JSON.stringify(request.options)}`,
      `Free text allowed: ${request.allowFreeText ? "yes" : "no"}`,
    ].join("\n\n");
    try {
      const result = await consume(
        leadAgentId,
        prompt,
        "Lead fallback",
        {
          permissionMode: "readOnly",
          approvalPolicy: definitions[leadAgentId]?.approvalPolicy,
        },
        [],
        state.taskId,
      );
      if (result.status !== "completed") {
        return { selected: [], freeText: "", source: "timeout" };
      }
      const parsed = parseJsonResponse(result.answer);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { selected: [], freeText: "", source: "timeout" };
      }
      const record = parsed as Record<string, JsonValue>;
      const selected = Array.isArray(record.selected)
        ? record.selected.filter(
            (value): value is string => typeof value === "string" && allowed.has(value),
          )
        : [];
      const freeText =
        request.allowFreeText && typeof record.freeText === "string"
          ? record.freeText
          : "";
      if (selected.length === 0 && !freeText.trim()) {
        return { selected: [], freeText: "", source: "timeout" };
      }
      return { selected, freeText, source: "lead" };
    } catch (error) {
      logOutput(
        `Lead fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { selected: [], freeText: "", source: "timeout" };
    }
  };

  const interruptAgents = async (agentIds: string[]): Promise<void> => {
    const unique = Array.from(new Set(agentIds)).filter(
      (agentId) => adapters[agentId],
    );
    const activeAgentIds: string[] = [];
    if (activeCodexInput && unique.includes(activeCodexInput.agentId)) {
      activeCodexInput.cancel();
    }
    const released = unique.map(
      (agentId) => [agentId, releasePendingApprovals(agentId)] as const,
    );
    for (const agentId of unique) {
      foregroundReservations.get(agentId)?.controller.abort();
      const active = abortControllers.get(agentId);
      if (active) {
        active.controller.abort();
        activeAgentIds.push(agentId);
      }
    }
    await Promise.allSettled(
      activeAgentIds.map((agentId) => adapterFor(agentId).interrupt()),
    );
    await Promise.all(
      released.map(([agentId, resolvers]) =>
        recordCancelledApprovals(agentId, resolvers, "agent interrupted"),
      ),
    );
    await Promise.allSettled([
      ...unique
        .map((agentId) => activeCompletions.get(agentId)?.completion)
        .filter((value): value is Promise<void> => Boolean(value)),
      ...unique
        .map((agentId) => foregroundReservations.get(agentId)?.completion)
        .filter((value): value is Promise<void> => Boolean(value)),
    ]);
  };

  const interruptOwnedAgents = async (
    ownerId: string,
    agentIds: string[],
  ): Promise<void> => {
    const unique = Array.from(new Set(agentIds)).filter(
      (agentId) =>
        adapters[agentId] &&
        (agentReservations.get(agentId) === ownerId ||
          abortControllers.get(agentId)?.ownerId === ownerId),
    );
    for (const agentId of unique) {
      await cancelAgentApprovals(agentId, "agent operation failed");
      const foreground = foregroundReservations.get(agentId);
      if (foreground?.ownerId === ownerId) {
        foreground.controller.abort();
      }
      const active = abortControllers.get(agentId);
      if (active?.ownerId === ownerId) {
        active.controller.abort();
        await adapterFor(agentId).interrupt().catch(() => undefined);
      }
    }
    await Promise.allSettled(
      unique
        .map((agentId) => {
          const active = activeCompletions.get(agentId);
          return active?.ownerId === ownerId ? active.completion : undefined;
        })
        .filter((value): value is Promise<void> => Boolean(value)),
    );
  };

  const trackForegroundOperation = async <T>(
    controllers: AbortController[],
    operation: Promise<T>,
  ): Promise<T> => {
    controllers.forEach((controller) => foregroundControllers.add(controller));
    const tracked = operation.then(() => undefined, () => undefined);
    foregroundOperations.add(tracked);
    try {
      return await operation;
    } finally {
      controllers.forEach((controller) => foregroundControllers.delete(controller));
      foregroundOperations.delete(tracked);
      scheduleQueueDrain();
    }
  };

  type DirectMessageRunOptions = {
    appendPrompt?: boolean;
    onAccepted?: () => Promise<void> | void;
  };

  const sendToRecipients = (
    recipients: string[],
    prompt: string,
    mode: InteractionMode,
    attachmentIds: string[],
    options: DirectMessageRunOptions = {},
  ): Promise<void> => {
    if (
      checkingAvailability ||
      pickingWorkingDirectory ||
      mutationActive ||
      gateDecisionActive
    ) {
      return Promise.reject(
        new Error("Wait for the current control operation to finish"),
      );
    }
    if (
      (activeWorkflow || workflowController || workflowActive) &&
      state.workflowStatus !== "paused"
    ) {
      return Promise.reject(
        new Error("Pause or interrupt the pipeline before sending a direct message"),
      );
    }

    const ownerId = randomUUID();
    let reserved: string[];
    try {
      reserved = reserveAgents(recipients, ownerId);
    } catch (error) {
      return Promise.reject(error);
    }
    const taskId = state.taskId;
    const controllers = new Map(
      reserved.map((agentId) => [agentId, new AbortController()]),
    );
    const completeForeground = new Map<string, () => void>();
    reserved.forEach((agentId) => {
      let complete: () => void = () => undefined;
      const completion = new Promise<void>((resolve) => {
        complete = resolve;
      });
      completeForeground.set(agentId, complete);
      foregroundReservations.set(agentId, {
        ownerId,
        controller: controllers.get(agentId) as AbortController,
        completion,
      });
    });
    activeForegroundOperations += 1;
    attachmentUseCount += 1;

    const operation = (async (): Promise<void> => {
      let releaseAttachments: (() => Promise<void>) | undefined;
      let deliveryFailure: unknown;
      try {
        const resolvedAttachments = await attachmentStore.resolvePaths(
          state.attachments,
          attachmentIds,
        );
        releaseAttachments = resolvedAttachments.dispose;
        const attachmentPaths = resolvedAttachments.paths;
        if (resultIsStale({ operationTaskId: taskId, currentTaskId: state.taskId })) {
          return;
        }
        if (options.appendPrompt !== false) {
          await appendTranscript(
            createEntry(
              "prompt",
              prompt,
              undefined,
              state.pendingGate?.stepName,
              "user.message",
              toJsonValue({ recipients: reserved, mode, attachmentIds }),
            ),
          );
          if (resultIsStale({ operationTaskId: taskId, currentTaskId: state.taskId })) {
            return;
          }
        }
        await options.onAccepted?.();
        if (resultIsStale({ operationTaskId: taskId, currentTaskId: state.taskId })) {
          return;
        }
        try {
          const results = await Promise.all(
            reserved.map(async (agentId) => {
              const controller = controllers.get(agentId) as AbortController;
              try {
                if (controller.signal.aborted) {
                  return undefined;
                }
                return {
                  agentId,
                  result: await consume(
                    agentId,
                    prompt,
                    state.pendingGate?.stepName,
                    directOptions(agentId, mode),
                    attachmentPaths,
                    taskId,
                    ownerId,
                  ),
                };
              } finally {
                completeForeground.get(agentId)?.();
              }
            }),
          );
          if (state.pendingGate) {
            for (const item of results) {
              if (!item || item.result.status !== "completed") {
                continue;
              }
              const intervention: PipelineIntervention = {
                id: randomUUID(),
                agentId: item.agentId,
                prompt,
                answer: item.result.answer,
                createdAt: new Date().toISOString(),
              };
              pendingGateInterventions.push(intervention);
              await appendTranscript(
                createEventEntry(
                  "gate.intervention",
                  `Intervention response from ${item.agentId}.`,
                  toJsonValue(intervention),
                  item.agentId,
                  state.pendingGate.stepName,
                ),
              );
            }
          }
        } catch (error) {
          await interruptOwnedAgents(ownerId, reserved);
          throw error;
        }
      } catch (error) {
        deliveryFailure = error;
        throw error;
      } finally {
        // Bookkeeping first: a snapshot that refuses to be removed must not also strand
        // agent reservations or foreground counters.
        reserved.forEach((agentId) => {
          completeForeground.get(agentId)?.();
          if (foregroundReservations.get(agentId)?.ownerId === ownerId) {
            foregroundReservations.delete(agentId);
          }
        });
        releaseAgents(reserved, ownerId);
        attachmentUseCount -= 1;
        activeForegroundOperations -= 1;
        await disposeWithPrimaryError(
          releaseAttachments,
          "this direct message",
          deliveryFailure,
        );
      }
    })();

    const tracked = trackForegroundOperation(
      Array.from(controllers.values()),
      operation,
    );
    return tracked;
  };

  const waitForExecutionChecklist = async (
    request: ExecutionChecklistRequest,
  ): Promise<ExecutionChecklistDecision> => {
    if (!options.requestInteraction) {
      throw new Error(`Step ${request.step.id} requires the managed interaction broker`);
    }
    patchRun(false, "paused", {
      activeStep: request.step.name,
      activeStepId: request.step.id,
    });
    const response = await options.requestInteraction({
      sourceKey: `execution-checklist:${state.taskId}:${request.step.id}`,
      kind: "executionChecklist",
      title: request.step.name,
      prompt: "Select work for execution. Generated paths are shown below. Verification commands come only from pipeline configuration.",
      options: request.issues.map((issue) => ({
        id: issue.id,
        label: issue.title,
        description: `${issue.details}\n\nPaths: ${issue.paths.join(", ")}`,
      })),
      allowFreeText: true,
      secret: false,
      ...(request.step.timeoutMs === undefined ? {} : { timeoutMs: request.step.timeoutMs }),
      checklistItems: request.issues,
    });
    return {
      selectedIssueIds: response.selected,
      userNote: response.freeText,
      source:
        response.source === "cancel"
          ? "cancel"
          : response.source === "timeout"
            ? "timeout"
            : "user",
    };
  };

  const waitForHumanGate = async (
    request: HumanGateRequest,
  ): Promise<HumanGateDecision> => {
    if (options.requestInteraction) {
      const pendingGate = pendingGateFrom(request);
      patchRun(false, "paused", {
        activeStep: request.step.name,
        activeStepId: request.step.id,
        ...(request.round === undefined ? {} : { consensusRound: request.round }),
        pendingGate,
      });
      const leadAgentId = state.roles.lead;
      const response = await options.requestInteraction(
        humanGateInteractionAsk(request, { taskId: state.taskId, leadAgentId }),
      );
      delete state.pendingGate;
      return humanGateDecisionFromResponse(response, {
        allowedActions: request.allowedActions,
        stepName: request.step.name,
        leadAgentId,
        interventionId: randomUUID(),
        now: new Date().toISOString(),
      });
    }
    if (gateResolver) {
      gateResolver.resolve({ action: "cancel" });
    }
    pendingGateInterventions = [];
    const pendingGate = pendingGateFrom(request);
    const opened = gateOpenedRecord(request);
    await appendTranscript(
      createEventEntry("gate.opened", opened.text, toJsonValue(opened.payload), undefined, opened.step),
    );
    patchRun(false, "paused", {
      activeStep: request.step.name,
      activeStepId: request.step.id,
      ...(request.round === undefined ? {} : { consensusRound: request.round }),
      pendingGate,
    });
    scheduleQueueDrain();
    return new Promise((resolve) => {
      gateResolver = {
        resolve: (decision) => {
          gateResolver = undefined;
          delete state.pendingGate;
          resolve(decision);
        },
      };
    });
  };

  const emptyPipelineResumeState = (): PipelineResumeState => ({
    version: 1,
    nextStepIndex: 0,
    snapshot: {
      roles: {},
      answers: {},
      latestAnswers: {},
      previousStepAnswers: { order: [], values: {} },
      latestInterventions: { order: [], values: {} },
    },
  });

  const setResumableWorkflow = async (
    value: PersistedResumableWorkflow | undefined,
  ): Promise<void> => {
    const stableValue = value ? structuredClone(value) : undefined;
    await persistStatePatch(
      { resumableWorkflow: stableValue },
      () => {
        resumableWorkflowData = stableValue;
        setOptionalProperty(
          state,
          "resumableWorkflow",
          stableValue ? resumableWorkflowSummary(stableValue) : undefined,
        );
      },
    );
    emitSnapshot();
  };

  const discardResumableWorkflow = async (
    eventType: string,
    text: string,
  ): Promise<void> => {
    const recovery = resumableWorkflowData;
    if (!recovery) {
      return;
    }
    await setResumableWorkflow(undefined);
    await appendTranscriptAfterCommit(
      createEventEntry(
        eventType,
        text,
        toJsonValue({
          pipelineId: recovery.pipelineId,
          nextStepIndex: recovery.nextStepIndex,
        }),
      ),
      eventType,
    );
  };

  type PipelineRunOptions = {
    pipelineId?: string | undefined;
    pipelineSnapshot?: PipelineSnapshot | undefined;
    resume?: PersistedResumableWorkflow | undefined;
    appendPrompt?: boolean | undefined;
    sourceQueueMessageId?: string | undefined;
    onAccepted?: (() => Promise<void> | void) | undefined;
    executeChecklist?: ((request: ExecuteChecklistRequest) => Promise<ExecuteChecklistResult>) | undefined;
    executionReserved?: boolean | undefined;
    requireCurrentCatalog?: boolean | undefined;
    allowedPaths?: string[] | undefined;
    writeScope?: WorkspaceWriteScope | undefined;
    commitMode?: "never" | "allow" | undefined;
    trackWorkspaceChanges?: boolean | undefined;
    composerAuthorized?: boolean | undefined;
  };

  const enabledChecklistPipelineIds = (
    pipeline: PipelineDefinition,
  ): string[] => Array.from(new Set(
    pipeline.steps.flatMap((step) =>
      step.enabled && step.type === "executeChecklist" ? [step.pipelineId] : [],
    ),
  ));

  const validateUnattendedPipelineSnapshot = async (
    pipelineSnapshot: PipelineDependencySnapshot,
  ): Promise<void> => {
    const pipeline = pipelineSnapshot.definition;
    if (enabledChecklistPipelineIds(pipeline).length > 0) {
      throw new Error(
        `Task pipeline ${pipeline.id} cannot contain executeChecklist steps`,
      );
    }
    const unsafe = unattendedPipelineSafetyErrors(pipeline);
    if (unsafe.length > 0) {
      throw new Error(
        `Task pipeline ${pipeline.id} is unsafe for unattended orchestration: ${unsafe.join("; ")}`,
      );
    }
    const topology = await buildAdapterTopology(
      pipeline,
      {},
      state.workingDirectory,
    );
    try {
      const capabilityErrors = validatePipelineCapabilities(
        pipeline,
        Object.fromEntries(
          Object.entries(topology.adapters).map(([agentId, adapter]) => [
            agentId,
            adapter.capabilities,
          ]),
        ),
        false,
      );
      if (capabilityErrors.length > 0) {
        throw new Error(
          `Task pipeline ${pipeline.id} capability validation failed: ${capabilityErrors.join("; ")}`,
        );
      }
    } finally {
      const cleanupFailures = await disposeTopology(topology);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          cleanupFailures,
          `Task pipeline ${pipeline.id} validation cleanup failed`,
        );
      }
    }
  };

  const reloadCurrentPipelineScope = async (): Promise<void> => {
    const scope = await resolvePipelineScope(
      state.workingDirectory,
      state.workspaceRoots,
    );
    await withPipelineCatalogMutation(scope, () => reloadPipelines(scope));
    refreshPipelineState();
    emitSnapshot();
    if (pipelineCatalogError) {
      throw new Error(pipelineCatalogError);
    }
  };

  const resolvePipelineSnapshotById = async (
    pipelineId: string,
    optionsValue: {
      requireCurrentCatalog?: boolean | undefined;
      unattended?: boolean | undefined;
      rejectChecklist?: boolean | undefined;
    } = {},
  ): Promise<PipelineSnapshot> => {
    if (optionsValue.requireCurrentCatalog !== false) {
      await reloadCurrentPipelineScope();
    }
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) {
      throw new Error(`Unknown pipeline: ${pipelineId}`);
    }
    const snapshot = snapshotForPipeline(pipeline);
    if (
      optionsValue.rejectChecklist &&
      enabledChecklistPipelineIds(pipeline).length > 0
    ) {
      throw new Error(
        `Pipeline ${pipeline.id} cannot be used as an unattended task pipeline because it contains executeChecklist`,
      );
    }
    if (optionsValue.unattended) {
      await validateUnattendedPipelineSnapshot(snapshot);
    }
    return snapshot;
  };

  const resolvePipelineSnapshotInScope = async (
    scopeRoot: string,
    pipelineId: string,
    optionsValue: {
      requireCurrentCatalog?: boolean | undefined;
      unattended?: boolean | undefined;
      rejectChecklist?: boolean | undefined;
    } = {},
  ): Promise<PipelineSnapshot> => {
    const scope = await resolveCanonicalPipelineScope({
      workingDirectory: scopeRoot,
      workspaceRoots: [scopeRoot],
      configuredRoot: scopeRoot,
      extensionDirectory: pipelineStorageDirectory,
    });
    if (scope.key === activePipelineScope.key) {
      return resolvePipelineSnapshotById(pipelineId, optionsValue);
    }
    await loadBuiltInPipelines();
    const catalog = await readScopedCustomCatalog(scope);
    if (catalog.error) {
      throw new Error(catalog.error);
    }
    const custom = catalog.loaded.find((entry) => entry.pipeline.id === pipelineId);
    const pipeline = custom?.pipeline ?? builtInPipelines.get(pipelineId);
    if (!pipeline) {
      throw new Error(`Unknown pipeline: ${pipelineId}`);
    }
    const snapshot = custom
      ? createPipelineSnapshot(pipeline, scope.key, scope.root)
      : createPipelineSnapshot(pipeline, "builtin");
    if (
      optionsValue.rejectChecklist &&
      enabledChecklistPipelineIds(pipeline).length > 0
    ) {
      throw new Error(
        `Pipeline ${pipeline.id} cannot be used as an unattended task pipeline because it contains executeChecklist`,
      );
    }
    if (optionsValue.unattended) {
      await validateUnattendedPipelineSnapshot(snapshot);
    }
    return snapshot;
  };

  const resolveExecutionPipelineSnapshot = async (
    rootSnapshot: PipelineSnapshot,
    requireCurrentCatalog: boolean,
  ): Promise<PipelineSnapshot> => {
    const dependencyIds = enabledChecklistPipelineIds(rootSnapshot.definition);
    if (dependencyIds.length === 0) {
      if (rootSnapshot.dependencies || rootSnapshot.bundleHash) {
        throw new Error(
          `Pipeline ${rootSnapshot.definition.id} has an unexpected task-pipeline dependency bundle`,
        );
      }
      return rootSnapshot;
    }
    if (rootSnapshot.dependencies || rootSnapshot.bundleHash) {
      if (!rootSnapshot.dependencies || !rootSnapshot.bundleHash) {
        throw new Error(
          `Pipeline ${rootSnapshot.definition.id} has an incomplete task-pipeline dependency bundle`,
        );
      }
      const providedIds = Object.keys(rootSnapshot.dependencies).sort();
      const expectedIds = [...dependencyIds].sort();
      if (
        providedIds.length !== expectedIds.length ||
        providedIds.some((id, index) => id !== expectedIds[index])
      ) {
        throw new Error(
          `Pipeline ${rootSnapshot.definition.id} task-pipeline dependency bundle does not match its executeChecklist steps`,
        );
      }
      const activeScope = await resolvePipelineScope(
        state.workingDirectory,
        state.workspaceRoots,
      );
      for (const dependencyId of expectedIds) {
        const dependency = rootSnapshot.dependencies[dependencyId];
        // `expectedIds` is derived from this snapshot's own dependency map.
        if (!dependency) {
          throw new Error(`Task pipeline ${dependencyId} is missing from its own snapshot`);
        }
        if (
          dependency.scopeKey !== "builtin" &&
          dependency.scopeKey !== activeScope.key
        ) {
          throw new Error(
            `Task pipeline ${dependencyId} belongs to a different workspace scope`,
          );
        }
        await validateUnattendedPipelineSnapshot(dependency);
      }
      return rootSnapshot;
    }
    if (!requireCurrentCatalog) {
      throw new Error(
        `Pipeline ${rootSnapshot.definition.id} predates immutable task-pipeline snapshots. Reselect and submit it again.`,
      );
    }
    await reloadCurrentPipelineScope();
    const dependencies: Record<string, PipelineDependencySnapshot> = {};
    for (const dependencyId of dependencyIds) {
      const dependencyPipeline = pipelines.get(dependencyId);
      if (!dependencyPipeline) {
        throw new Error(
          `Pipeline ${rootSnapshot.definition.id} references missing task pipeline ${dependencyId}`,
        );
      }
      const dependencySnapshot = snapshotForPipeline(dependencyPipeline);
      await validateUnattendedPipelineSnapshot(dependencySnapshot);
      dependencies[dependencyId] = dependencySnapshot;
    }
    return createPipelineExecutionSnapshot(rootSnapshot, dependencies);
  };

  const assertCurrentPipelineCatalogSelection = async (
    pipelineSnapshot: PipelineSnapshot,
  ): Promise<void> => {
    if (pipelineSnapshot.scopeKey === "builtin") {
      const current = builtInPipelines.get(pipelineSnapshot.definition.id);
      if (!current || pipelineDefinitionHash(current) !== pipelineSnapshot.hash) {
        throw new Error(
          `Pipeline ${pipelineSnapshot.definition.id} changed in this extension version. Reselect it before running.`,
        );
      }
      return;
    }
    const scope = await resolvePipelineScope(
      state.workingDirectory,
      state.workspaceRoots,
    );
    if (scope.key !== pipelineSnapshot.scopeKey) {
      throw new Error(
        "The selected custom pipeline belongs to a different workspace scope. Reselect it before running.",
      );
    }
    await withPipelineCatalogMutation(scope, () => reloadPipelines(scope));
    refreshPipelineState();
    emitSnapshot();
    if (pipelineCatalogError) {
      throw new Error(pipelineCatalogError);
    }
    const current = pipelines.get(pipelineSnapshot.definition.id);
    const currentHash = pipelineHashes.get(pipelineSnapshot.definition.id);
    if (
      !current ||
      !customPipelineIds.has(pipelineSnapshot.definition.id) ||
      currentHash !== pipelineSnapshot.hash
    ) {
      throw new Error(
        `Pipeline ${pipelineSnapshot.definition.id} changed on disk. Reselect it before running.`,
      );
    }
  };

  const checklistAllowedDirtyPaths = async (
    pipelineSnapshot: PipelineSnapshot,
  ): Promise<string[]> => {
    if (pipelineSnapshot.scopeKey === "builtin" || !pipelineSnapshot.scopeRoot) {
      return [];
    }
    const snapshotScope = await resolveCanonicalPipelineScope({
      workingDirectory: pipelineSnapshot.scopeRoot,
      workspaceRoots: [pipelineSnapshot.scopeRoot],
      configuredRoot: pipelineSnapshot.scopeRoot,
      extensionDirectory: pipelineStorageDirectory,
    });
    if (snapshotScope.key !== pipelineSnapshot.scopeKey) {
      throw new Error(
        `Pipeline ${pipelineSnapshot.definition.id} storage scope changed. Reselect it before running.`,
      );
    }
    return [snapshotScope.directory];
  };

  // Bachata observes only what a provider actually reports. Nothing here probes a provider or
  // installs anything; an unreported resource is recorded as unavailable, not assumed present.
  let lastResourceDependencyProvenance: ReturnType<typeof resourceDependencyProvenance> = [];

  const observeResourceAvailability = async (
    dependencies: readonly { id: string; kind: string; name: string }[],
  ): Promise<ResourceAvailability[]> => {
    const observed = await hostCallbacks.observeResourceDependencies?.(dependencies);
    if (observed) return observed;
    return dependencies.map((dependency) => ({
      id: dependency.id,
      available: false,
      detail: "no provider reported this resource",
    }));
  };

  const preflightPipeline = async (
    prompt: string,
    attachmentIds: string[],
    options: PipelineRunOptions = {},
  ): Promise<{
    pipeline: PipelineDefinition;
    pipelineSnapshot: PipelineSnapshot;
    attachmentPaths: string[];
    disposeAttachments: () => Promise<void>;
    allowedDirtyPaths: string[];
  }> => {
    if (!prompt.trim()) {
      throw new Error("Pipeline prompt is required");
    }
    if (
      activeWorkflow ||
      workflowActive ||
      anyAgentRunning() ||
      mutationActive ||
      activeForegroundOperations > (options.executionReserved ? 1 : 0)
    ) {
      throw new Error("Another pipeline or agent operation is active");
    }
    if (!options.resume && resumableWorkflowData) {
      throw new Error(
        "Resume or discard the interrupted workflow before starting another pipeline",
      );
    }
    const requestedPipelineSnapshot = options.resume?.pipelineSnapshot ??
      options.pipelineSnapshot ??
      selectedPipelineSnapshot;
    const pipeline = requestedPipelineSnapshot?.definition;
    if (!pipeline || !requestedPipelineSnapshot) {
      throw new Error("Select a pipeline before running it");
    }
    const parsedPipelineSnapshot = parsePipelineSnapshot(requestedPipelineSnapshot);
    if (
      !parsedPipelineSnapshot ||
      pipelineDefinitionHash(pipeline) !== requestedPipelineSnapshot.hash ||
      !pipelineSnapshotsEqual(parsedPipelineSnapshot, requestedPipelineSnapshot)
    ) {
      throw new Error("The selected pipeline snapshot is invalid");
    }
    if (hostCallbacks.unattendedOrchestration) {
      const unsafe = unattendedPipelineSafetyErrors(pipeline);
      if (unsafe.length > 0) {
        throw new Error(
          `Unattended orchestration rejects unsafe provider permissions: ${unsafe.join("; ")}`,
        );
      }
    }
    if (!pipelineSnapshotRootsEqual(selectedPipelineSnapshot, requestedPipelineSnapshot)) {
      throw new Error(
        `Pipeline ${pipeline.id} is not the immutable selection for this conversation`,
      );
    }
    if (options.requireCurrentCatalog) {
      await assertCurrentPipelineCatalogSelection(requestedPipelineSnapshot);
    }
    await refreshRepositoryPolicy();
    refreshReadiness();
    const policyRefusals = state.executionContract?.policyRefusals ?? [];
    if (policyRefusals.length > 0) {
      throw new Error(`This repository's ${REPOSITORY_POLICY_PATH} refuses this run: ${policyRefusals.join("; ")}`);
    }
    // A declared external resource is checked before the run starts. Provider-native
    // resources a model inherits are untouched by this; only declarations are enforced.
    if ((pipeline.resourceDependencies ?? []).length > 0) {
      const dependencyPreflight = preflightResourceDependencies(
        pipeline.resourceDependencies ?? [],
        await observeResourceAvailability(pipeline.resourceDependencies ?? []),
      );
      // Role binding is enforced where Bachata can actually enforce it: a required dependency
      // whose allowed roles never run in this pipeline is a contract that cannot hold.
      const running = new Set(
        pipeline.steps.flatMap((step) =>
          (step.type === "agent" || step.type === "checklist") && step.enabled
            ? step.participants
            : []),
      );
      const unusable = (pipeline.resourceDependencies ?? [])
        .filter((dependency) => dependency.required)
        .filter((dependency) => !dependency.allowedRoles?.some((role) =>
          roleMayUseDependency(dependency, role) && running.has(role)) &&
          dependency.allowedRoles !== undefined)
        .map((dependency) =>
          `${dependency.kind} ${dependency.name} is bound to roles that do not run in this workflow`);
      const refusals = [...dependencyPreflight.refusals, ...unusable];
      if (refusals.length > 0) {
        throw new Error(`Bachata refused this run: ${refusals.join("; ")}`);
      }
      lastResourceDependencyProvenance = resourceDependencyProvenance(dependencyPreflight.statuses);
    } else {
      lastResourceDependencyProvenance = [];
    }
    if (options.composerAuthorized) {
      const refreshedRefusal = pipelineRunRefusal();
      if (refreshedRefusal) {
        throw new Error(refreshedRefusal);
      }
    }
    const pipelineSnapshot = await resolveExecutionPipelineSnapshot(
      requestedPipelineSnapshot,
      options.requireCurrentCatalog !== false,
    );
    if (
      options.resume &&
      (options.resume.pipelineId !== pipeline.id ||
        options.resume.pipelineHash !== pipelineSnapshot.hash ||
        options.resume.checkpoint.nextStepIndex < 0 ||
        options.resume.checkpoint.nextStepIndex > pipeline.steps.length)
    ) {
      throw new Error(
        "The saved workflow checkpoint does not match the selected pipeline",
      );
    }
    const resolvedAttachments = await attachmentStore.resolvePaths(
      state.attachments,
      attachmentIds,
    );
    const attachmentPaths = resolvedAttachments.paths;
    const disposeAttachments = resolvedAttachments.dispose;
    let attachmentsTransferred = false;
    try {
      const capabilityErrors = validatePipelineCapabilities(
        pipeline,
        Object.fromEntries(
          Object.entries(adapters).map(([agentId, adapter]) => {
            if (definitions[agentId]?.adapter !== "generic-browser") {
              return [agentId, adapter.capabilities];
            }
            let session;
            try {
              session = bridge.resolveBoundSession(
                `${runtimeOwnerId}:${agentId}`,
                state.agents[agentId]?.browserBinding,
                state.agents[agentId]?.sessionId,
              );
            } catch {
              session = undefined;
            }
            if (!session) {
              const ready = state.browserBridge.sessions.filter(
                (candidate) => candidate.provider === "generic" && candidate.status === "ready",
              );
              if (ready.length === 1) session = ready[0];
            }
            const capabilities = session?.capabilities;
            const autonomous = Boolean(capabilities
              && capabilities.submission === "verifiedSend"
              && capabilities.completion === "verifiedLifecycle"
              && capabilities.interruption === "confirmed"
              && capabilities.conversationState === "confirmed");
            return [
              agentId,
              {
                ...adapter.capabilities,
                interrupt: capabilities?.interruption === "confirmed",
                passiveActionLoop: autonomous,
              },
            ];
          }),
        ),
        attachmentPaths.length > 0,
      );
      if (capabilityErrors.length > 0) {
        throw new Error(
          `Pipeline capability validation failed: ${capabilityErrors.join("; ")}`,
        );
      }
      const hasChecklistExecution = pipeline.steps.some(
        (step) => step.enabled && step.type === "executeChecklist",
      );
      const allowedDirtyPaths = hasChecklistExecution
        ? await checklistAllowedDirtyPaths(pipelineSnapshot)
        : [];
      if (hasChecklistExecution) {
        if (!state.workingDirectory) {
          throw new Error("Checklist execution requires a working directory");
        }
        if (!hostCallbacks.preflightChecklistExecution) {
          throw new Error("Checklist execution preflight is unavailable");
        }
        await hostCallbacks.preflightChecklistExecution({
          workingDirectory: await resolveAllowedDirectory(state.workingDirectory),
          allowedDirtyPaths,
        });
      }
      attachmentsTransferred = true;
      return { pipeline, pipelineSnapshot, attachmentPaths, disposeAttachments, allowedDirtyPaths };
    } finally {
      // The plaintext snapshot stays this function's responsibility until the caller
      // actually receives it: every failure between resolution and return disposes it.
      if (!attachmentsTransferred) {
        await disposeAttachments();
      }
    }
  };

  const runPipeline = async (
    prompt: string,
    attachmentIds: string[],
    options: PipelineRunOptions = {},
  ): Promise<void> => {
    const taskId = state.taskId;
    const controller = new AbortController();
    workflowController = controller;
    activeForegroundOperations += 1;
    attachmentUseCount += 1;
    let recoveryEstablished = false;
    let accepted = false;
    let releasePipelineAttachments: (() => Promise<void>) | undefined;
    let pipelineFailure: unknown;
    const operation = (async (): Promise<void> => {
      try {
        const {
          pipeline,
          pipelineSnapshot,
          attachmentPaths,
          disposeAttachments,
          allowedDirtyPaths,
        } = await preflightPipeline(
          prompt,
          attachmentIds,
          { ...options, executionReserved: true },
        );
        releasePipelineAttachments = disposeAttachments;
        if (resultIsStale({ operationTaskId: taskId, currentTaskId: state.taskId, aborted: controller.signal.aborted })) {
          return;
        }
        const workspaceRoot = state.workingDirectory;
        const workspaceBefore = options.trackWorkspaceChanges && workspaceRoot
          ? await captureManagedRepositoryBaseline(workspaceRoot, controller.signal)
          : undefined;
        if (options.appendPrompt !== false) {
          await appendTranscript(
            createEntry(
              "prompt",
              prompt,
              undefined,
              undefined,
              "user.message",
              toJsonValue({ pipelineId: pipeline.id, attachmentIds }),
            ),
          );
        } else if (options.resume) {
          await appendTranscript(
            createEventEntry(
              "workflow.resumed",
              `Resumed ${pipeline.name} from step ${String(
                options.resume.checkpoint.nextStepIndex + 1,
              )}.`,
              toJsonValue({
                pipelineId: pipeline.id,
                nextStepIndex: options.resume.checkpoint.nextStepIndex,
              }),
            ),
          );
        }
        if (resultIsStale({ operationTaskId: taskId, currentTaskId: state.taskId, aborted: controller.signal.aborted })) {
          return;
        }

        const initialCheckpoint =
          options.resume?.checkpoint ?? emptyPipelineResumeState();
        const runSettings = beginRunSettings(options.resume?.runSettings);
        refreshReadiness();
        const droppedSettings = droppedRunSettings(
          options.resume?.rejectedRunSettings,
          rejectedRecordedRunSettings,
        );
        rejectedRecordedRunSettings = [];
        const droppedNotice = droppedRunSettingsNotice(droppedSettings);
        if (droppedNotice !== undefined) {
          await appendTranscript(
            createEventEntry(
              "workflow.settingsRejected",
              droppedNotice,
              toJsonValue({ rejected: droppedSettings }),
            ),
          );
        }
        const runConstraints = resolvedRunConstraints({
          allowedPaths: options.allowedPaths,
          writeScope: options.writeScope,
          commitMode: options.commitMode,
          resume: options.resume,
        });
        const recovery = resumableWorkflowFrom({
          pipelineId: pipeline.id,
          pipelineName: pipeline.name,
          pipelineHash: pipelineSnapshot.hash,
          totalSteps: pipeline.steps.length,
          userPrompt: prompt,
          attachmentIds,
          checkpoint: initialCheckpoint,
          pipelineSnapshot,
          runSettings,
          constraints: runConstraints,
          updatedAt: new Date().toISOString(),
          sourceQueueMessageId: options.sourceQueueMessageId,
          resumeSourceQueueMessageId: options.resume?.sourceQueueMessageId,
        });
        await setResumableWorkflow(recovery);
        recoveryEstablished = true;
        await options.onAccepted?.();
        accepted = true;

        workflowActive = true;
        state.roles = { ...initialCheckpoint.snapshot.roles };
        patchRun(true, "running", { roles: state.roles });
        const result = await executePipeline(
          pipeline,
          prompt,
          attachmentPaths,
          (agentId, agentPrompt, step, agentOptions, stepAttachments) =>
            consume(
              agentId,
              agentPrompt,
              step.name,
              agentOptions,
              stepAttachments,
              taskId,
            ),
          {
            onStep: (step, _index, round) => {
              // Republish the contract at every step boundary. Pinned values do not move, but an
              // authority control the human changed since the run started must not keep being
              // reported, or recorded by the host, as the one the run began under.
              refreshReadiness();
              hostCallbacks.onPipelineStep?.({ step, index: _index, round });
              patchRun(true, "running", {
                activeStep: step.name,
                activeStepId: step.id,
                ...(round === undefined ? {} : { consensusRound: round }),
              });
            },
            onRoles: (roles) => {
              state.roles = roles;
              hostCallbacks.onRolesChanged?.({ ...roles });
              patchRun(true, "running", {
                ...(state.activeStep === undefined ? {} : { activeStep: state.activeStep }),
                ...(state.activeStepId === undefined ? {} : { activeStepId: state.activeStepId }),
                ...(state.consensusRound === undefined ? {} : { consensusRound: state.consensusRound }),
                roles,
              });
            },
            onOutput: (artifact) => {
              hostCallbacks.onPipelineOutput?.(artifact);
            },
            onDecision: (artifact) => {
              hostCallbacks.onPipelineDecision?.(artifact);
            },
            onCheckpoint: async (checkpoint) => {
              const current = resumableWorkflowData;
              if (
                !current ||
                !checkpointAppliesTo(current, {
                  pipelineId: pipeline.id,
                  pipelineHash: pipelineSnapshot.hash,
                })
              ) {
                return;
              }
              await setResumableWorkflow({
                ...current,
                nextStepIndex: checkpoint.nextStepIndex,
                updatedAt: new Date().toISOString(),
                checkpoint: compactPipelineCheckpoint(checkpoint),
              });
            },
            waitForHumanGate,
            waitForExecutionChecklist,
            executeChecklist: hostCallbacks.executeChecklist
              ? (request) => {
                  const dependency = pipelineSnapshot.dependencies?.[
                    request.step.pipelineId
                  ];
                  if (!dependency) {
                    throw new Error(
                      `Pipeline ${pipeline.id} has no immutable snapshot for task pipeline ${request.step.pipelineId}`,
                    );
                  }
                  return hostCallbacks.executeChecklist!({
                    ...request,
                    allowedDirtyPaths,
                    pipelineSnapshot: structuredClone(dependency),
                  });
                }
              : undefined,
          },
          controller.signal,
          options.resume ? initialCheckpoint : undefined,
          runConstraints,
        );
        const workspaceChange = result.status === "completed" && workspaceBefore && workspaceRoot
          ? workspaceChangeFrom({
              before: workspaceBefore,
              after: await captureManagedRepositoryBaseline(workspaceRoot, controller.signal),
            })
          : undefined;
        const completedResult = workspaceChange === undefined
          ? result
          : { ...result, ...workspaceChange };
        lastPipelineResult = structuredClone(completedResult);
        const terminal = pipelineTerminalPlan(completedResult.status);
        if (!terminal.keepResumable) await setResumableWorkflow(undefined);
        patchRun(false, terminal.runStatus, { roles: completedResult.roles });
        await appendTranscript(createEntry("status", terminal.statusText));
      } catch (error) {
        pipelineFailure = error;
        await interruptAgents(Object.keys(adapters));
        const failurePlan = pipelineFailurePlan({
          accepted,
          recoveryEstablished,
          resuming: options.resume !== undefined,
        });
        if (failurePlan.recordFailure) {
          patchRun(false, "error", {
            ...(state.activeStep === undefined ? {} : { activeStep: state.activeStep }),
            ...(state.activeStepId === undefined ? {} : { activeStepId: state.activeStepId }),
          });
          await appendTranscript(
            createEntry(
              "error",
              error instanceof Error ? error.message : String(error),
              undefined,
              state.activeStep,
            ),
          );
        }
        if (failurePlan.restoreResume && options.resume) {
          await setResumableWorkflow(options.resume);
        }
        throw error;
      } finally {
        // Bookkeeping first: a snapshot that refuses to be removed must not also leave
        // the workflow marked active or the foreground counters raised.
        workflowActive = false;
        // Whatever ended the run — completion, failure, an interruption, a cancelled gate — the
        // task it was running is over, and its revision budget and any undelivered Lead
        // directive end with it.
        managedTaskState.clear();
        endRunSettings();
        attachmentUseCount -= 1;
        activeForegroundOperations -= 1;
        if (workflowController === controller) {
          workflowController = undefined;
        }
        gateResolver = undefined;
        await disposeWithPrimaryError(
          releasePipelineAttachments,
          "this pipeline run",
          pipelineFailure,
        );
      }
    })();

    activeWorkflow = operation;
    try {
      await operation;
    } finally {
      if (activeWorkflow === operation) {
        activeWorkflow = undefined;
      }
      scheduleQueueDrain();
    }
  };

  const serializeQueueTransition = <T>(
    operation: () => Promise<T>,
  ): Promise<T> => {
    const next = queueTransitionQueue.then(operation, operation);
    queueTransitionQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  type QueueStateCommit = {
    queuedMessages: QueuedMessage[];
    queuePaused: boolean;
    queueStart: PersistedQueueStart | undefined;
    taskDirty: boolean;
  };

  const commitQueueState = async (
    value: QueueStateCommit,
  ): Promise<void> => {
    const stableMessages = structuredClone(value.queuedMessages);
    const stableStart = value.queueStart
      ? structuredClone(value.queueStart)
      : undefined;
    await persistStatePatch(
      {
        queuedMessages: stableMessages,
        queuePaused: value.queuePaused,
        // A patch merges over the persisted value, so an omitted key leaves the stored one
        // in place. Clearing the claim has to be written, not left out.
        queueStart: stableStart,
        taskDirty: value.taskDirty,
      },
      () => {
        state.queuedMessages = stableMessages;
        state.queuePaused = value.queuePaused;
        queueStartClaim = stableStart;
        taskDirty = value.taskDirty;
      },
    );
    emitSnapshot();
  };

  const pauseQueueSafely = async (
    reason: string,
    clearStartClaim: boolean,
  ): Promise<void> => {
    const paused = state.queuedMessages.length > 0;
    try {
      await serializeQueueTransition(() =>
        commitQueueState({
          queuedMessages: state.queuedMessages,
          queuePaused: paused,
          queueStart: clearStartClaim ? undefined : queueStartClaim,
          taskDirty,
        }),
      );
    } catch (error) {
      state.queuePaused = paused;
      emitSnapshot();
      logOutput(
        `The queue was paused in memory after ${reason}, but the pause could not be persisted: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const claimQueuedMessage = async (
    messageId: string,
  ): Promise<QueuedMessage | undefined> =>
    serializeQueueTransition(async () => {
      const current = state.queuedMessages.find((item) => item.id === messageId);
      if (!current) {
        return undefined;
      }
      if (
        queueStartClaim &&
        queueStartClaim.messageId !== messageId
      ) {
        throw new Error("Another queued request is being prepared");
      }
      const claim: PersistedQueueStart = {
        messageId,
        claimedAt: new Date().toISOString(),
      };
      await commitQueueState({
        queuedMessages: state.queuedMessages,
        queuePaused: state.queuePaused,
        queueStart: claim,
        taskDirty,
      });
      return structuredClone(current);
    });

  const finalizeQueuedMessage = async (
    messageId: string,
  ): Promise<boolean> => {
    const existing = await serializeQueueTransition(async () => {
      const current = state.queuedMessages.find((item) => item.id === messageId);
      const outcome = queueRemoval({
        kind: "completion",
        messageId,
        present: Boolean(current),
        remainingCount: state.queuedMessages.length - (current ? 1 : 0),
        claimedMessageId: queueStartClaim?.messageId,
        queuePaused: state.queuePaused,
        queueDraining,
      });
      if (!outcome.commit) {
        return undefined;
      }
      await commitQueueState({
        queuedMessages: state.queuedMessages.filter(
          (item) => item.id !== messageId,
        ),
        queuePaused: outcome.queuePaused,
        queueStart: outcome.clearClaim ? undefined : queueStartClaim,
        taskDirty,
      });
      return outcome.announce && current ? structuredClone(current) : undefined;
    });
    if (!existing) {
      return false;
    }
    await appendTranscriptAfterCommit(
      createEventEntry(
        "message.dequeued",
        existing.kind === "pipeline"
          ? "Queued pipeline request completed."
          : "Queued direct message completed.",
        toJsonValue({ messageId, kind: existing.kind }),
      ),
      "Queue completion",
    );
    return true;
  };

  const cancelQueuedMessage = async (
    messageId: string,
  ): Promise<boolean> => {
    const existing = await serializeQueueTransition(async () => {
      const current = state.queuedMessages.find((item) => item.id === messageId);
      const outcome = queueRemoval({
        kind: "cancellation",
        messageId,
        present: Boolean(current),
        remainingCount: state.queuedMessages.length - (current ? 1 : 0),
        claimedMessageId: queueStartClaim?.messageId,
        queuePaused: state.queuePaused,
        queueDraining,
      });
      if (!outcome.commit) {
        return undefined;
      }
      await commitQueueState({
        queuedMessages: state.queuedMessages.filter(
          (item) => item.id !== messageId,
        ),
        queuePaused: outcome.queuePaused,
        queueStart: outcome.clearClaim ? undefined : queueStartClaim,
        taskDirty,
      });
      return outcome.announce && current ? structuredClone(current) : undefined;
    });
    if (!existing) {
      return false;
    }
    await appendTranscriptAfterCommit(
      createEventEntry(
        "message.queue.cancelled",
        "Queued message cancelled.",
        toJsonValue({ messageId, kind: existing.kind }),
      ),
      "Queue cancellation",
    );
    return true;
  };

  const adoptQueuedRecovery = async (
    messageId: string,
  ): Promise<boolean> => {
    if (resumableWorkflowData?.sourceQueueMessageId !== messageId) {
      return false;
    }
    const existing = await serializeQueueTransition(async () => {
      const current = state.queuedMessages.find((item) => item.id === messageId);
      const remaining = state.queuedMessages.filter(
        (item) => item.id !== messageId,
      );
      const outcome = queueRemoval({
        kind: "recoveryAdoption",
        messageId,
        present: Boolean(current),
        remainingCount: remaining.length,
        claimedMessageId: queueStartClaim?.messageId,
        queuePaused: state.queuePaused,
        queueDraining,
      });
      if (!outcome.commit) {
        return undefined;
      }
      await commitQueueState({
        queuedMessages: remaining,
        queuePaused: outcome.queuePaused,
        queueStart: outcome.clearClaim ? undefined : queueStartClaim,
        taskDirty,
      });
      return outcome.announce && current ? structuredClone(current) : undefined;
    });
    if (!existing) {
      return false;
    }
    await appendTranscriptAfterCommit(
      createEventEntry(
        "message.dequeued",
        "Queued pipeline request was preserved as recoverable work.",
        toJsonValue({ messageId, kind: existing.kind, recoverable: true }),
      ),
      "Queue recovery adoption",
    );
    return true;
  };

  const supersedeClaimedQueuedMessage = async (
    messageId: string,
  ): Promise<void> => {
    const existing = await serializeQueueTransition(async () => {
      const current = state.queuedMessages.find((item) => item.id === messageId);
      const outcome = queueRemoval({
        kind: "supersession",
        messageId,
        present: Boolean(current),
        remainingCount: state.queuedMessages.length - (current ? 1 : 0),
        claimedMessageId: queueStartClaim?.messageId,
        queuePaused: state.queuePaused,
        queueDraining,
      });
      if (!outcome.commit) {
        return undefined;
      }
      await commitQueueState({
        queuedMessages: state.queuedMessages.filter(
          (item) => item.id !== messageId,
        ),
        queuePaused: outcome.queuePaused,
        queueStart: outcome.clearClaim ? undefined : queueStartClaim,
        taskDirty,
      });
      return outcome.announce && current ? structuredClone(current) : undefined;
    });
    if (!existing) {
      return;
    }
    await appendTranscriptAfterCommit(
      createEventEntry(
        "message.queue.superseded",
        "The interrupted queued request was superseded.",
        toJsonValue({ messageId, kind: existing.kind }),
      ),
      "Queue supersession",
    );
  };

  const reconcileQueueStartClaim = async (): Promise<void> => {
    const claim = queueStartClaim;
    if (!claim) {
      return;
    }
    if (await adoptQueuedRecovery(claim.messageId)) {
      return;
    }
    await serializeQueueTransition(() =>
      commitQueueState({
        queuedMessages: state.queuedMessages,
        queuePaused: state.queuedMessages.length > 0,
        queueStart: undefined,
        taskDirty,
      }),
    );
  };

  const enqueueQueuedMessage = async (
    message: Omit<QueuedMessage, "id" | "createdAt">,
    pauseQueue = false,
  ): Promise<QueuedMessage> => {
    const queued = await serializeQueueTransition(async () => {
      const problem = queueAdmissionProblem({
        maximum: Math.max(1, configuration().get<number>("maxQueuedMessages", 50)),
        queuedCount: state.queuedMessages.length,
        attachmentIds: message.attachmentIds,
        availableAttachmentIds: new Set(state.attachments.map((item) => item.id)),
        kind: message.kind,
        pipelineId: message.pipelineId,
        pipelineSnapshot: message.pipelineSnapshot,
        selectedPipelineSnapshot,
        recipients: message.recipients,
        knownAgentIds: new Set(Object.keys(adapters)),
      });
      if (problem) {
        throw new Error(problem);
      }
      const candidate: QueuedMessage = {
        ...message,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
      };
      await commitQueueState({
        queuedMessages: [...state.queuedMessages, candidate],
        queuePaused: pauseQueue || state.queuePaused,
        queueStart: queueStartClaim,
        taskDirty: true,
      });
      return structuredClone(candidate);
    });
    await appendTranscriptAfterCommit(
      createEntry(
        "prompt",
        queued.prompt,
        undefined,
        state.pendingGate?.stepName,
        "user.message",
        toJsonValue({
          queued: true,
          queueId: queued.id,
          kind: queued.kind,
          pipelineId: queued.pipelineId ?? null,
          recipients: queued.recipients,
          mode: queued.mode,
          attachmentIds: queued.attachmentIds,
          iterationCount: queued.iterationCount ?? 1,
          iterationMode: queued.iterationMode ?? "fixed",
          requiredCleanPasses: queued.requiredCleanPasses ?? 2,
        }),
      ),
      "Queue enqueue",
    );
    return queued;
  };

  const interruptCurrentExecution = async (): Promise<void> => {
    const workflow = activeWorkflow;
    workflowController?.abort();
    gateResolver?.resolve({ action: "cancel" });
    gateResolver = undefined;
    foregroundControllers.forEach((controller) => controller.abort());
    await interruptAgents(Object.keys(adapters));
    await Promise.allSettled([
      ...(workflow ? [workflow] : []),
      ...Array.from(foregroundOperations),
    ]);
  };

  const canStartQueuedMessage = (queued: QueuedMessage): boolean =>
    queuedMessageMayStart({
      kind: queued.kind,
      disposed,
      mutationActive,
      checkingAvailability,
      pickingWorkingDirectory,
      gateDecisionActive,
      claimHeld: queueStartClaim !== undefined,
      anyAgentRunning: anyAgentRunning(),
      foregroundOperations: foregroundOperations.size,
      activeForegroundOperations,
      pipelineOperationActive: Boolean(activeWorkflow || workflowActive || workflowController),
      workflowStatus: state.workflowStatus,
      resumableWorkflow: Boolean(resumableWorkflowData),
    });

  const drainQueue = async (): Promise<void> => {
    if (queueDraining || state.queuePaused || disposed) {
      return;
    }
    queueDraining = true;
    try {
      while (!state.queuePaused && state.queuedMessages.length > 0) {
        const [queued] = state.queuedMessages;
        // The loop condition proves the queue is not empty.
        if (!queued) {
          break;
        }
        const step = queueDrainStep({
          blockedReason: queued.blockedReason,
          canStart: canStartQueuedMessage(queued),
          recoveryIdle: Boolean(
            resumableWorkflowData && !activeWorkflow && !workflowActive && !workflowController,
          ),
        });
        if (step.action === "pause") {
          await pauseQueueSafely(step.reason, step.clearStart);
          if (step.log !== undefined) logOutput(step.log);
          break;
        }
        if (step.action === "stop") {
          break;
        }
        let accepted = false;
        let completionFinalized = false;
        let claimed: QueuedMessage | undefined;
        try {
          claimed = await claimQueuedMessage(queued.id);
          if (!claimed) {
            continue;
          }
          // Disposal can land while the claim is in flight. The claimed request stays queued and
          // the queue is paused rather than started against a runtime that is tearing down.
          if (disposed) {
            await pauseQueueSafely("runtime disposal", true);
            break;
          }
          const onAccepted = async (): Promise<void> => {
            accepted = true;
          };
          if (claimed.kind === "pipeline") {
            // EX-AUD-12. How many passes a run makes, and what ends it early, is decided in
            // `pipeline/stepTransitions.ts`; running a pass stays here.
            const plan = iterationPlan({
              ...(claimed.iterationCount === undefined ? {} : { iterationCount: claimed.iterationCount }),
              ...(claimed.requiredCleanPasses === undefined
                ? {}
                : { requiredCleanPasses: claimed.requiredCleanPasses }),
            });
            const iterationCount = plan.iterations;
            if (hostCallbacks.executeQueuedPipeline) {
              await hostCallbacks.executeQueuedPipeline(
                {
                  queueMessageId: claimed.id,
                  pipelineId: claimed.pipelineId as string,
                  pipelineSnapshot: claimed.pipelineSnapshot as PipelineSnapshot,
                  prompt: claimed.prompt,
                  attachmentIds: claimed.attachmentIds,
                  iterationCount,
                  ...(claimed.iterationMode === undefined ? {} : { iterationMode: claimed.iterationMode }),
                  ...(claimed.requiredCleanPasses === undefined ? {} : { requiredCleanPasses: claimed.requiredCleanPasses }),
                  ...(claimed.composerAuthorized ? { composerAuthorized: true } : {}),
                },
                onAccepted,
              );
            } else {
              let cleanPasses = 0;
              for (let index = 0; index < iterationCount; index += 1) {
                if (index > 0) await resetSession();
                await runPipeline(claimed.prompt, claimed.attachmentIds, {
                  ...(claimed.pipelineId === undefined ? {} : { pipelineId: claimed.pipelineId }),
                  ...(claimed.pipelineSnapshot === undefined ? {} : { pipelineSnapshot: claimed.pipelineSnapshot }),
                  sourceQueueMessageId: claimed.id,
                  onAccepted: index === 0 ? onAccepted : undefined,
                  appendPrompt: false,
                  trackWorkspaceChanges: claimed.iterationMode === "untilClean",
                  ...(claimed.composerAuthorized ? { composerAuthorized: true } : {}),
                });
                const outcome = iterationOutcome({
                  mode: claimed.iterationMode === "untilClean" ? "untilClean" : "fixed",
                  cleanPasses,
                  ...(lastPipelineResult?.workspaceChanged === undefined
                    ? {}
                    : { workspaceChanged: lastPipelineResult.workspaceChanged }),
                  targetCleanPasses: plan.targetCleanPasses,
                });
                cleanPasses = outcome.cleanPasses;
                if (outcome.exhausted) break;
              }
            }
          } else if (hostCallbacks.executeQueuedDirect) {
            await hostCallbacks.executeQueuedDirect(
              {
                queueMessageId: claimed.id,
                recipients: claimed.recipients,
                prompt: claimed.prompt,
                mode: claimed.mode,
                attachmentIds: claimed.attachmentIds,
              },
              onAccepted,
            );
          } else {
            await ensureAdaptersReady();
            await sendToRecipients(
              claimed.recipients,
              claimed.prompt,
              claimed.mode,
              claimed.attachmentIds,
              { onAccepted, appendPrompt: false },
            );
          }
          await onAccepted();
          completionFinalized = await finalizeQueuedMessage(claimed.id);
          if (!completionFinalized) {
            throw new Error("The queued message completion could not be committed");
          }
        } catch (originalError) {
          let failure: unknown = originalError;
          let recoveryAdopted = false;
          try {
            recoveryAdopted = await adoptQueuedRecovery(queued.id);
          } catch (recoveryError) {
            failure = queueFailureJoined(failure, recoveryError, QUEUE_FAILURE_MESSAGES.recovery);
          }
          if (queueFailureReconciliation({ accepted, completionFinalized, recoveryAdopted }).finalizeNow) {
            try {
              completionFinalized = await finalizeQueuedMessage(queued.id);
            } catch (finalizationError) {
              failure = queueFailureJoined(failure, finalizationError, QUEUE_FAILURE_MESSAGES.finalization);
            }
          }
          const { retainStartClaim } = queueFailureReconciliation({
            accepted,
            completionFinalized,
            recoveryAdopted,
          });
          await pauseQueueSafely("a queued request failure", !retainStartClaim);
          const record = queueFailureRecord({
            messageId: queued.id,
            failure,
            accepted,
            completionFinalized,
            recoveryAdopted,
          });
          await appendTranscriptAfterCommit(
            createEventEntry("message.queue.failed", record.text, toJsonValue(record.payload)),
            "Queue failure reporting",
          );
          break;
        }
      }
    } finally {
      queueDraining = false;
    }
  };

  scheduleQueueDrain = (): void => {
    queueMicrotask(() => {
      queueDrainOperation = drainQueue().catch((error) => {
        logOutput(
          `Failed to drain message queue: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  };

  const prepareInterruptDelivery = async (): Promise<void> => {
    const supersededMessageId = queueStartClaim?.messageId;
    await interruptCurrentExecution();
    if (supersededMessageId) {
      await supersedeClaimedQueuedMessage(supersededMessageId);
    }
    await discardResumableWorkflow(
      "workflow.superseded",
      "Interrupted workflow recovery discarded by a superseding message.",
    );
    await reconcileQueueStartClaim();
    await serializeQueueTransition(() =>
      commitQueueState({
        queuedMessages: state.queuedMessages,
        queuePaused: false,
        queueStart: undefined,
        taskDirty,
      }),
    );
  };

  const prepareCommittedInterruptDelivery = async (
    messageId: string,
  ): Promise<boolean> => {
    try {
      await prepareInterruptDelivery();
      return true;
    } catch (error) {
      await pauseQueueSafely("interrupt delivery preparation", false);
      await appendTranscriptAfterCommit(
        createEventEntry(
          "message.interrupt.failed",
          "The superseding request remains queued because the active work could not be interrupted safely.",
          toJsonValue({
            messageId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        "Interrupt delivery failure reporting",
      );
      state.transcriptError = `The request was queued, but interrupt preparation failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      emitSnapshot();
      logOutput(state.transcriptError);
      return false;
    }
  };

  const notifyQueuedAcceptance = async (
    messageId: string,
    onAccepted?: () => Promise<void> | void,
  ): Promise<void> => {
    if (!onAccepted) {
      return;
    }
    try {
      await onAccepted();
    } catch (error) {
      await appendTranscriptAfterCommit(
        createEventEntry(
          "message.acceptance.notification.failed",
          "The queued request was committed, but its acceptance callback failed.",
          toJsonValue({
            messageId,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        "Queued acceptance notification",
      );
      state.transcriptError = `The queued request was committed, but acceptance notification failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      emitSnapshot();
      logOutput(state.transcriptError);
    }
  };

  const deliverDirectMessage = async (
    recipients: string[],
    prompt: string,
    mode: InteractionMode,
    attachmentIds: string[],
    delivery: MessageDelivery,
  ): Promise<void> => {
    if (delivery === "immediate") {
      if (resumableWorkflowData && !activeWorkflow) {
        throw new Error(
          "Resume or discard the interrupted workflow before sending another message",
        );
      }
      await sendToRecipients(recipients, prompt, mode, attachmentIds);
      return;
    }
    const queued = await enqueueQueuedMessage(
      {
        kind: "direct",
        prompt,
        recipients,
        mode,
        attachmentIds,
      },
      delivery === "interrupt",
    );
    if (
      delivery === "interrupt" &&
      !(await prepareCommittedInterruptDelivery(queued.id))
    ) {
      return;
    }
    await drainQueue();
  };

  const disposeAttachmentSnapshot = async (
    dispose: (() => Promise<void>) | undefined,
    label: string,
  ): Promise<void> => {
    if (!dispose) return;
    try {
      await dispose();
      return;
    } catch (error) {
      try {
        await dispose();
        return;
      } catch (retryError) {
        const reason = retryError instanceof Error ? retryError.message : String(retryError);
        logOutput(
          `Attachment snapshot for ${label} could not be removed: ${reason}. Delete it by hand; it holds the exact bytes that were sent to providers.`,
        );
        throw new Error(
          `Attachment snapshot for ${label} could not be removed: ${reason}`,
          { cause: error },
        );
      }
    }
  };

  // A cleanup failure must never replace the failure that caused the run to end: the
  // primary error stays first inside an AggregateError, and a clean run surfaces the
  // disposal failure on its own.
  const disposeWithPrimaryError = async (
    dispose: (() => Promise<void>) | undefined,
    label: string,
    primaryError: unknown,
  ): Promise<void> => {
    try {
      await disposeAttachmentSnapshot(dispose, label);
    } catch (disposalError) {
      if (primaryError === undefined) throw disposalError;
      throw new AggregateError(
        [primaryError, disposalError],
        primaryError instanceof Error ? primaryError.message : String(primaryError),
      );
    }
  };

  const pipelineRunRefusal = (): string | undefined => {
    if (state.workingDirectory === undefined && state.workspaceRoots.length !== 1) {
      return state.workspaceRoots.length === 0
        ? "Open a VS Code workspace folder before starting a session"
        : "Select a working directory before starting a session in a multi-root workspace";
    }
    if (state.contractAcknowledgement?.acknowledgementRequired === true) {
      return "Read and acknowledge this run's execution contract before starting it";
    }
    return undefined;
  };

  const deliverPipelineRequest = async (
    prompt: string,
    attachmentIds: string[],
    delivery: MessageDelivery,
    iterationCount = 1,
    iterationMode: "fixed" | "untilClean" = "fixed",
    requiredCleanPasses = 2,
    onAccepted?: () => Promise<void> | void,
  ): Promise<void> => {
    const refusal = pipelineRunRefusal();
    if (refusal) {
      throw new Error(refusal);
    }
    // EX-AUD-12. Both bounds are decided in `pipeline/stepTransitions.ts`, so a queued run and
    // an immediate one cannot clamp them differently.
    const plan = iterationPlan({ iterationCount, requiredCleanPasses });
    const requestedIterations = plan.iterations;
    const pipelineSnapshot = selectedPipelineSnapshot
      ? structuredClone(selectedPipelineSnapshot)
      : undefined;
    if (!pipelineSnapshot) {
      throw new Error("Select a pipeline before running it");
    }
    if (delivery === "immediate") {
      await assertCurrentPipelineCatalogSelection(pipelineSnapshot);
      const executionSnapshot = await resolveExecutionPipelineSnapshot(
        pipelineSnapshot,
        true,
      );
      let cleanPasses = 0;
      for (let index = 0; index < requestedIterations; index += 1) {
        if (index > 0) await resetSession();
        await runPipeline(prompt, attachmentIds, {
          pipelineSnapshot: executionSnapshot,
          requireCurrentCatalog: true,
          composerAuthorized: true,
          onAccepted: index === 0 ? onAccepted : undefined,
          trackWorkspaceChanges: iterationMode === "untilClean",
        });
        const outcome = iterationOutcome({
          mode: iterationMode,
          cleanPasses,
          ...(lastPipelineResult?.workspaceChanged === undefined
            ? {}
            : { workspaceChanged: lastPipelineResult.workspaceChanged }),
          targetCleanPasses: plan.targetCleanPasses,
        });
        cleanPasses = outcome.cleanPasses;
        if (outcome.exhausted) break;
      }
      return;
    }
    const pipelineId = state.selectedPipelineId;
    if (!pipelineId) {
      throw new Error("Select a pipeline before queueing it");
    }
    await assertCurrentPipelineCatalogSelection(pipelineSnapshot);
    const executionSnapshot = await resolveExecutionPipelineSnapshot(
      pipelineSnapshot,
      true,
    );
    const queued = await enqueueQueuedMessage(
      {
        kind: "pipeline",
        pipelineId,
        pipelineSnapshot: executionSnapshot,
        prompt,
        recipients: [],
        mode: "implementation",
        attachmentIds,
        iterationCount: requestedIterations,
        iterationMode,
        requiredCleanPasses: plan.targetCleanPasses,
        composerAuthorized: true,
      },
      delivery === "interrupt",
    );
    await notifyQueuedAcceptance(queued.id, onAccepted);
    if (
      delivery === "interrupt" &&
      !(await prepareCommittedInterruptDelivery(queued.id))
    ) {
      return;
    }
    await drainQueue();
  };

  const checkAvailability = async (): Promise<void> => {
    if (checkingAvailability) {
      throw new Error("Availability check is already running");
    }
    if (
      workflowActive ||
      anyAgentRunning() ||
      activeForegroundOperations > 0 ||
      pickingWorkingDirectory
    ) {
      throw new Error("Wait for the active operation before checking agents");
    }
    checkingAvailability = true;
    try {
      const checkAgent = async (agentId: string): Promise<void> => {
        try {
          const version = await adapterFor(agentId).checkAvailability(
            agentStateFor(agentId).sessionId,
            agentStateFor(agentId).browserBinding,
          );
          patchAgent(
            agentId,
            {
              status: agentStateFor(agentId).sessionId ? "idle" : "available",
              version,
              ...(undefined === undefined ? {} : { error: undefined }),
            },
            true,
          );
        } catch (error) {
          patchAgent(
            agentId,
            {
              status: "error",
              error: error instanceof Error ? error.message : String(error),
            },
            true,
          );
        }
      };
      const localAgentIds = Object.keys(adapters).filter((agentId) => {
        const adapter = definitions[agentId]?.adapter;
        return adapter === "codex-app-server" || adapter === "claude-code" ||
          adapter === "zai-glm";
      });
      const browserAgentIds = Object.keys(adapters).filter(
        (agentId) => !localAgentIds.includes(agentId),
      );
      const concurrency = Math.min(
        localAgentIds.length,
        Math.max(1, configuration().get<number>("maxConcurrentLocalAgents", 4)),
      );
      let nextLocalIndex = 0;
      const localWorkers = Array.from({ length: concurrency }, async () => {
        while (nextLocalIndex < localAgentIds.length) {
          const agentId = localAgentIds[nextLocalIndex];
          nextLocalIndex += 1;
          // The loop bound proves the id is there.
          if (agentId === undefined) continue;
          await checkAgent(agentId);
        }
      });
      await Promise.all([
        ...browserAgentIds.map(checkAgent),
        ...localWorkers,
      ]);
    } finally {
      checkingAvailability = false;
    }
  };

  type TaskResetTransition = {
    pipeline: PipelineDefinition;
    pipelineSnapshot: PipelineSnapshot;
    topology: AdapterTopology;
    commit?: (() => Promise<void>) | undefined;
    rollback?: (() => Promise<void>) | undefined;
  };

  const resetTaskState = async (
    workingDirectory: string | undefined,
    transition?: TaskResetTransition,
  ): Promise<void> => {
    const runningWorkflow = activeWorkflow;
    const originalTaskId = state.taskId;
    const originalTopology = currentTopology();
    let effectiveTransition = transition;
    let previousState: PanelState | undefined;
    let previousResumableWorkflow: PersistedResumableWorkflow | undefined;
    let previousSelectedPipelineSnapshot: PipelineSnapshot | undefined;
    let previousQueueStart: PersistedQueueStart | undefined;
    let previousTaskDirty = taskDirty;
    let transcriptBackup: TranscriptEntry[] | undefined;
    let attachmentBackup: Awaited<ReturnType<typeof attachmentStore.backup>> | undefined;
    let destructivePhaseStarted = false;
    let transitionCommitted = false;
    let runtimeStatePersisted = false;
    const rollbackFailures: unknown[] = [];

    try {
      workflowController?.abort();
      gateResolver?.resolve({ action: "cancel" });
      gateResolver = undefined;
      pendingGateInterventions = [];
      await cancelAllApprovals("task reset");
      foregroundControllers.forEach((controller) => controller.abort());
      await interruptAgents(Object.keys(adapters));
      if (runningWorkflow) {
        await runningWorkflow.catch(() => undefined);
      }
      await Promise.allSettled(Array.from(foregroundOperations));

      if (!effectiveTransition) {
        const pipelineSnapshot = selectedPipelineSnapshot;
        const pipeline = pipelineSnapshot?.definition;
        if (!pipeline || !pipelineSnapshot) {
          throw new Error("No selected pipeline is available");
        }
        effectiveTransition = {
          pipeline,
          pipelineSnapshot: structuredClone(pipelineSnapshot),
          topology: await buildAdapterTopology(
            pipeline,
            resetAgentsFromState(),
            workingDirectory,
          ),
        };
      }

      await transcriptStore.flush();
      previousState = structuredClone(state);
      previousState.taskId = originalTaskId;
      previousResumableWorkflow = resumableWorkflowData
        ? structuredClone(resumableWorkflowData)
        : undefined;
      previousSelectedPipelineSnapshot = selectedPipelineSnapshot
        ? structuredClone(selectedPipelineSnapshot)
        : undefined;
      previousQueueStart = queueStartClaim
        ? structuredClone(queueStartClaim)
        : undefined;
      previousTaskDirty = taskDirty;
      transcriptBackup = await transcriptStore.load();
      attachmentBackup = await attachmentStore.backup(state.attachments);

      state.taskId = randomUUID();
      managedFreshSessionKeys.clear();
      managedTaskState.clear();
      destructivePhaseStarted = true;
      await transcriptStore.clear();
      await attachmentStore.clear(state.attachments);

      // EX-AUD-12. What a reset leaves behind, and which keys it removes rather than blanks,
      // is decided in `recoveryTransition.ts`; clearing the stores is still this function's.
      setOptionalProperty(state, "workingDirectory", workingDirectory);
      Object.assign(state, taskResetBaseline());
      taskResetClearedKeys.forEach((key) => {
        Reflect.deleteProperty(state, key);
      });
      queueStartClaim = undefined;
      resumableWorkflowData = undefined;
      taskDirty = false;

      installTopology(effectiveTransition.topology);
      selectedPipelineSnapshot = structuredClone(effectiveTransition.pipelineSnapshot);
      refreshPipelineState();
      bindBrowserAgents(effectiveTransition.topology);

      Object.values(state.agents).forEach((agent) => {
        const projection = resetAgentProjection(agent, state.browserBridge.sessions);
        agent.status = projection.status;
        if (!projection.keepsSession) {
          delete agent.sessionId;
        }
        agent.output = "";
        delete agent.error;
      });

      await persistRuntimeValue(persistedValueFromState, () => {
        runtimeStatePersisted = true;
      });
      await effectiveTransition.commit?.();
      transitionCommitted = true;
    } catch (error) {
      const rollback = taskResetRollbackPlan({
        destructivePhaseStarted,
        hasStateBackup: previousState !== undefined,
        hasStoreBackups: transcriptBackup !== undefined && attachmentBackup !== undefined,
        transitionPrepared: effectiveTransition !== undefined,
        transitionCommitted,
        runtimeStatePersisted,
      });
      if (rollback.restoreStores && previousState && transcriptBackup && attachmentBackup) {
        await transcriptStore.replace(transcriptBackup).catch((rollbackError) => {
          rollbackFailures.push(rollbackError);
        });
        await attachmentStore.restore(attachmentBackup).catch((rollbackError) => {
          rollbackFailures.push(rollbackError);
        });
        Object.assign(state, previousState);
        resumableWorkflowData = previousResumableWorkflow;
        selectedPipelineSnapshot = previousSelectedPipelineSnapshot;
        queueStartClaim = previousQueueStart;
        taskDirty = previousTaskDirty;
        installTopology({
          adapters: originalTopology.adapters,
          definitions: originalTopology.definitions,
          agents: state.agents,
        });
        bindBrowserAgents(currentTopology());
      }

      if (rollback.rollbackTransition && effectiveTransition) {
        await effectiveTransition.rollback?.().catch((rollbackError) => {
          rollbackFailures.push(rollbackError);
        });
        const cleanupFailures = await disposeTopology(effectiveTransition.topology);
        rollbackFailures.push(...cleanupFailures);
        bindBrowserAgents(currentTopology());
      }

      if (rollback.restoreTaskId) {
        state.taskId = originalTaskId;
      }
      if (rollback.persistAgain) {
        await persistNow().catch((rollbackError) => {
          rollbackFailures.push(rollbackError);
        });
      }
      refreshPipelineState();
      emitSnapshot();

      if (rollbackFailures.length > 0) {
        throw new AggregateError([error, ...rollbackFailures], TASK_RESET_ROLLBACK_INCOMPLETE);
      }
      throw error;
    }

    const cleanupFailures = await disposeTopology(originalTopology);
    bindBrowserAgents(effectiveTransition.topology);
    cleanupFailures.forEach((error) => {
      logOutput(
        `Failed to dispose a replaced provider adapter: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    refreshPipelineState();
    emitSnapshot();
  };

  const activatePipeline = async (
    pipeline: PipelineDefinition,
    candidate: AdapterTopology,
    values: Pick<TaskResetTransition, "commit" | "rollback"> & {
      pipelineSnapshot?: PipelineSnapshot | undefined;
    } = {},
  ): Promise<void> => {
    await resetTaskState(state.workingDirectory, {
      pipeline,
      pipelineSnapshot: values.pipelineSnapshot ?? snapshotForPipeline(pipeline),
      topology: candidate,
      ...(values.commit ? { commit: values.commit } : {}),
      ...(values.rollback ? { rollback: values.rollback } : {}),
    });
  };

  const selectPipeline = async (pipelineId: string): Promise<void> => {
    const reason = pipelineMutationReason();
    if (reason) {
      throw new Error(reason);
    }
    await reloadPipelines(activePipelineScope);
    const pipeline = pipelines.get(pipelineId);
    if (!pipeline) {
      throw new Error(`Unknown pipeline: ${pipelineId}`);
    }
    const candidate = await buildAdapterTopology(pipeline);
    await activatePipeline(pipeline, candidate, {
      pipelineSnapshot: snapshotForPipeline(pipeline),
    });
  };

  const resetForWorkingDirectory = async (
    workingDirectory: string | undefined,
    preferredPipelineId = selectedPipelineSnapshot?.definition.id,
    requirePreferredPipeline = false,
  ): Promise<void> => {
    const previousScope = activePipelineScope;
    const targetScope = await resolvePipelineScope(workingDirectory, state.workspaceRoots);
    const scopeChanged = targetScope.key !== previousScope.key;
    if (scopeChanged) {
      await reloadPipelines(targetScope);
    } else {
      await reloadPipelines(activePipelineScope);
    }
    const preferred = preferredPipelineId
      ? pipelines.get(preferredPipelineId)
      : undefined;
    if (requirePreferredPipeline && preferredPipelineId && !preferred) {
      if (scopeChanged) {
        await reloadPipelines(previousScope);
      }
      throw new Error(
        `Pipeline ${preferredPipelineId} is not available for the selected workspace root`,
      );
    }
    const pipeline = preferred ?? pipelines.get("review-only") ?? pipelines.values().next().value;
    if (!pipeline) {
      if (scopeChanged) {
        await reloadPipelines(previousScope);
      }
      throw new Error("No pipeline is available for the selected workspace root");
    }
    const pipelineSnapshot = snapshotForPipeline(pipeline);
    let candidate: AdapterTopology | undefined;
    try {
      candidate = await buildAdapterTopology(
        pipeline,
        resetAgentsFromState(),
        workingDirectory,
      );
      await resetTaskState(workingDirectory, {
        pipeline,
        pipelineSnapshot,
        topology: candidate,
      });
    } catch (error) {
      if (scopeChanged) {
        await reloadPipelines(previousScope).catch(() => undefined);
      }
      throw error;
    }
  };

  const resetForPipelineSnapshot = async (
    workingDirectory: string | undefined,
    pipelineSnapshot: PipelineSnapshot,
  ): Promise<void> => {
    const parsed = parsePipelineSnapshot(pipelineSnapshot);
    if (!parsed || !pipelineSnapshotsEqual(parsed, pipelineSnapshot)) {
      throw new Error("The configured pipeline snapshot is invalid");
    }
    const previousScope = activePipelineScope;
    const targetScope = await resolvePipelineScope(
      workingDirectory,
      state.workspaceRoots,
    );
    if (
      pipelineSnapshot.scopeKey !== "builtin" &&
      targetScope.key !== pipelineSnapshot.scopeKey
    ) {
      throw new Error(
        `Pipeline ${pipelineSnapshot.definition.id} belongs to a different workspace scope`,
      );
    }
    const scopeChanged = targetScope.key !== previousScope.key;
    try {
      await reloadPipelines(targetScope);
      const candidate = await buildAdapterTopology(
        pipelineSnapshot.definition,
        resetAgentsFromState(),
        workingDirectory,
      );
      await resetTaskState(workingDirectory, {
        pipeline: pipelineSnapshot.definition,
        pipelineSnapshot: structuredClone(pipelineSnapshot),
        topology: candidate,
      });
    } catch (error) {
      if (scopeChanged) {
        await reloadPipelines(previousScope).catch(() => undefined);
      }
      throw error;
    }
  };

  const assertPipelineCanChange = (): void => {
    const reason = pipelineMutationReason();
    if (reason) {
      throw new Error(reason);
    }
  };

  type PipelineSaveRequest = {
    mode: "create" | "update";
    scopeKey: string;
    sourcePipelineId?: string | undefined;
    expectedHash?: string | undefined;
  };

  const savePipeline = async (
    value: JsonValue,
    request: PipelineSaveRequest,
  ): Promise<void> => {
    assertPipelineCanChange();
    const pipeline = validatePipeline(value, "from the editor");
    const candidate = await buildAdapterTopology(pipeline);
    const scope = activePipelineScope;
    const serializedPipeline = `${JSON.stringify(pipeline, null, 2)}\n`;
    let activationStarted = false;
    try {
      await withPipelineCatalogMutation(scope, async () => {
        await reloadPipelines(scope);
        assertPipelineCanChange();
        const previousPipeline = pipelines.get(pipeline.id);
        const previousHash = pipelineHashes.get(pipeline.id);
        const previousCustom = customPipelineIds.has(pipeline.id);
        const previousFilePath = customPipelineFiles.get(pipeline.id);
        const target = previousFilePath ?? pipelineFilePath(scope.directory, pipeline.id);
        const previousFile = await readCatalogText(scope, target);
        // Every refusal in one place, judged once the file has been read: the catalog and the disk
        // can disagree, and which of them is wrong changes what the reader is told.
        const saveRefusal = pipelineSaveRefusal({
          mode: request.mode,
          pipelineId: pipeline.id,
          requestScopeKey: request.scopeKey,
          scopeKey: scope.key,
          activeScopeKey: activePipelineScope.key,
          existsInCatalog: pipelines.has(pipeline.id),
          isCustom: customPipelineIds.has(pipeline.id),
          sourcePipelineId: request.sourcePipelineId,
          expectedHash: request.expectedHash,
          currentHash: pipelineHashes.get(pipeline.id),
          fileExists: previousFile !== undefined,
        });
        if (saveRefusal !== undefined) {
          throw new Error(saveRefusal);
        }
        const nextSnapshot = createPipelineSnapshot(
          pipeline,
          scope.key,
          scope.root,
        );

        const restoreDefinition = async (): Promise<void> => {
          if (previousFile === undefined) {
            await withWorkspaceMutation(() =>
              removeCatalogTextIfUnchanged(scope, target, serializedPipeline)
            );
          } else {
            await withWorkspaceMutation(() =>
              writeCatalogTextIfUnchanged(
                scope,
                target,
                previousFile,
                serializedPipeline,
              )
            );
          }
          if (previousPipeline) {
            pipelines.set(pipeline.id, previousPipeline);
          } else {
            pipelines.delete(pipeline.id);
          }
          if (previousHash) {
            pipelineHashes.set(pipeline.id, previousHash);
          } else {
            pipelineHashes.delete(pipeline.id);
          }
          if (previousCustom) {
            customPipelineIds.add(pipeline.id);
          } else {
            customPipelineIds.delete(pipeline.id);
          }
          if (previousFilePath) {
            customPipelineFiles.set(pipeline.id, previousFilePath);
          } else {
            customPipelineFiles.delete(pipeline.id);
          }
        };

        try {
          await withWorkspaceMutation(() =>
            writeCatalogTextIfUnchanged(
              scope,
              target,
              serializedPipeline,
              previousFile,
            )
          );
          pipelines.set(pipeline.id, pipeline);
          pipelineHashes.set(pipeline.id, nextSnapshot.hash);
          customPipelineIds.add(pipeline.id);
          customPipelineFiles.set(pipeline.id, target);
          activationStarted = true;
          await activatePipeline(pipeline, candidate, {
            pipelineSnapshot: nextSnapshot,
            rollback: restoreDefinition,
          });
        } catch (error) {
          if (!activationStarted) {
            const rollbackFailures: unknown[] = [];
            const currentFile = await readCatalogText(scope, target).catch(() => undefined);
            if (currentFile === serializedPipeline) {
              await restoreDefinition().catch((rollbackError) => {
                rollbackFailures.push(rollbackError);
              });
            }
            if (rollbackFailures.length > 0) {
              throw new AggregateError(
                [error, ...rollbackFailures],
                `Pipeline ${pipeline.id} could not be saved and rollback was incomplete`,
              );
            }
          }
          refreshPipelineState();
          emitSnapshot();
          throw error;
        }
      });
    } catch (error) {
      if (!activationStarted) {
        const disposalFailures = await disposeTopology(candidate);
        if (disposalFailures.length > 0) {
          throw new AggregateError(
            [error, ...disposalFailures],
            `Pipeline ${pipeline.id} could not be saved and candidate cleanup was incomplete`,
          );
        }
      }
      throw new Error(
        `Pipeline ${pipeline.id} could not be saved or activated: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    await options.onPipelineCatalogChanged?.({
      ownerId: runtimeOwnerId,
      scopeKey: scope.key,
      pipelineId: pipeline.id,
    });
  };

  const deletePipeline = async (
    pipelineId: string,
    scopeKey: string,
    expectedHash: string,
  ): Promise<void> => {
    assertPipelineCanChange();
    const scope = activePipelineScope;
    await withPipelineCatalogMutation(scope, async () => {
      await reloadPipelines(scope);
      assertPipelineCanChange();
      const pipeline = pipelines.get(pipelineId);
      const customFile = customPipelineFiles.get(pipelineId);
      const previousFile = customFile === undefined
        ? undefined
        : await readCatalogText(scope, customFile);
      const deleteRefusal = pipelineDeleteRefusal({
        pipelineId,
        requestScopeKey: scopeKey,
        scopeKey: scope.key,
        activeScopeKey: activePipelineScope.key,
        isCustom: customPipelineIds.has(pipelineId),
        expectedHash,
        currentHash: pipelineHashes.get(pipelineId),
        existsInCatalog: pipeline !== undefined,
        hasCatalogFile: customFile !== undefined,
        fileExists: previousFile !== undefined,
      });
      if (deleteRefusal !== undefined || !pipeline || !customFile || previousFile === undefined) {
        throw new Error(deleteRefusal ?? `Unknown pipeline: ${pipelineId}`);
      }
      let tombstone: string | undefined;
      const restoreDefinition = async (): Promise<void> => {
        if (tombstone) {
          const stagedPath = tombstone;
          const stagedExists = await lstat(stagedPath).then(
            () => true,
            (error: unknown) => {
              if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return false;
              }
              throw error;
            },
          );
          if (stagedExists) {
            await withWorkspaceMutation(() =>
              restoreCatalogDeleteIfAbsent(scope, customFile, stagedPath)
            );
          } else {
            const currentFile = await readCatalogText(scope, customFile);
            if (currentFile === undefined) {
              await withWorkspaceMutation(() =>
                writeCatalogTextIfUnchanged(scope, customFile, previousFile, undefined)
              );
            } else if (currentFile !== previousFile) {
              throw new Error(
                `Pipeline ${pipelineId} changed while its deletion was rolling back`,
              );
            }
          }
          tombstone = undefined;
        }
        pipelines.set(pipelineId, pipeline);
        pipelineHashes.set(pipelineId, expectedHash);
        customPipelineIds.add(pipelineId);
        customPipelineFiles.set(pipelineId, customFile);
      };
      const removeDefinition = async (): Promise<void> => {
        if (!tombstone) {
          tombstone = `${customFile}.delete-${randomUUID()}`;
          await withWorkspaceMutation(() =>
            stageCatalogDeleteIfUnchanged(
              scope,
              customFile,
              previousFile,
              tombstone as string,
            )
          );
        }
        customPipelineIds.delete(pipelineId);
        pipelines.delete(pipelineId);
        pipelineHashes.delete(pipelineId);
        customPipelineFiles.delete(pipelineId);
        if (tombstone) {
          const stagedPath = tombstone;
          await withWorkspaceMutation(() =>
            finalizeCatalogDeleteIfAbsent(scope, customFile, stagedPath)
          );
          tombstone = undefined;
        }
      };

      if (selectedPipelineSnapshot?.definition.id !== pipelineId) {
        try {
          await removeDefinition();
        } catch (error) {
          const rollbackFailures: unknown[] = [];
          await restoreDefinition().catch((rollbackError) => {
            rollbackFailures.push(rollbackError);
          });
          if (rollbackFailures.length > 0) {
            throw new AggregateError(
              [error, ...rollbackFailures],
              `Pipeline ${pipelineId} deletion failed and rollback was incomplete`,
            );
          }
          throw error;
        }
        refreshPipelineState();
        emitSnapshot();
        return;
      }

      const replacement = pipelines.get("review-only") ??
        Array.from(pipelines.values()).find((value) => value.id !== pipelineId);
      if (!replacement) {
        throw new Error("No pipeline remains after deletion");
      }
      const candidate = await buildAdapterTopology(replacement);
      await activatePipeline(replacement, candidate, {
        pipelineSnapshot: snapshotForPipeline(replacement),
        commit: removeDefinition,
        rollback: restoreDefinition,
      });
    });
    await options.onPipelineCatalogChanged?.({
      ownerId: runtimeOwnerId,
      scopeKey: scope.key,
      pipelineId,
    });
  };

  const importPipeline = async (): Promise<PipelineDefinition | undefined> => {
    assertPipelineCanChange();
    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "Bachata pipeline": ["json"] },
      openLabel: "Import pipeline",
    });
    const filePath = selected?.at(0)?.fsPath;
    if (!filePath) {
      return undefined;
    }
    return validatePipeline(
      JSON.parse(await readFile(filePath, "utf8")) as unknown,
      filePath,
    );
  };

  const exportPipeline = async (
    pipelineId: string | undefined,
    draft: JsonValue | undefined,
  ): Promise<boolean> => {
    const pipeline = draft === undefined
      ? pipelineId
        ? pipelines.get(pipelineId)
        : undefined
      : validatePipeline(draft, "from the editor");
    if (!pipeline) {
      throw new Error(`Unknown pipeline: ${pipelineId ?? ""}`);
    }
    const selected = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(state.workingDirectory ?? storageDirectory, `${pipeline.id}.pipeline.json`),
      ),
      filters: { "Bachata pipeline": ["json"] },
      saveLabel: "Export pipeline",
    });
    if (!selected) {
      return false;
    }
    await atomicWriteText(selected.fsPath, `${JSON.stringify(pipeline, null, 2)}\n`);
    return true;
  };

  const selectBrowserSession = async (
    agentId: string,
    sessionId: string | undefined,
    options: { allowDuringActiveWorkflow?: boolean } = {},
  ): Promise<void> => {
    if (
      !options.allowDuringActiveWorkflow
      && (workflowActive || anyAgentRunning() || activeForegroundOperations > 0)
    ) {
      throw new Error("Wait for the active operation before changing browser conversations");
    }
    const agent = state.agents[agentId];
    if (!agent || !agent.adapterType.endsWith("-browser")) {
      throw new Error(`Agent ${agentId} is not a browser agent`);
    }
    const provider = browserProviderForAdapterType(agent.adapterType);
    if (!provider) {
      throw new Error(`Agent ${agentId} does not use a built-in browser provider`);
    }
    const session = sessionId
      ? state.browserBridge.sessions.find(
          (candidate) =>
            candidate.id === sessionId && candidate.provider === provider,
        )
      : undefined;
    if (sessionId && !session) {
      throw new Error("The selected browser conversation is unavailable");
    }
    if (session && session.status !== "ready") {
      throw new Error(`The selected browser conversation is ${session.status}`);
    }

    const ownerId = `${runtimeOwnerId}:${agentId}`;
    const previousSessionId = agent.sessionId;
    const previousBinding = agent.browserBinding
      ? structuredClone(agent.browserBinding)
      : undefined;
    let browserBinding: BrowserConversationBinding | undefined;
    try {
      browserBinding = session
        ? bridge.bindSession(ownerId, session.id)
        : undefined;
      if (!session) {
        bridge.releaseBinding(ownerId);
      }
      const nextAgents = persistedAgentsFromState();
      nextAgents[agentId] = {
        version: agent.version,
        sessionId,
        browserBinding,
      };
      await persistStatePatch(
        { agents: nextAgents },
        () => {
          Object.assign(agent, {
            sessionId,
            browserBinding,
            status: session ? "idle" : "available",
            error: undefined,
          });
        },
      );
    } catch (error) {
      try {
        bridge.releaseBinding(ownerId);
        if (previousBinding) {
          bridge.bindConversation(ownerId, previousBinding);
        } else if (previousSessionId) {
          bridge.bindSession(ownerId, previousSessionId);
        }
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "Browser conversation selection failed and its previous binding could not be restored",
        );
      }
      throw error;
    }

    patchAgent(
      agentId,
      {
        sessionId,
        browserBinding,
        status: session ? "idle" : "available",
        error: undefined,
      },
      false,
    );
    await appendTranscriptAfterCommit(
      createEventEntry(
        "browser.session.selected",
        session
          ? `${agent.name} bound to ${session.title ?? session.conversationUrl}`
          : `${agent.name} browser binding cleared`,
        toJsonValue({
          agentId,
          provider,
          sessionId: sessionId ?? null,
          conversationUrl: session?.conversationUrl ?? null,
          conversationIdentity: session?.conversationIdentity ?? null,
        }),
        agentId,
      ),
      "Browser conversation selection",
    );
  };

  const capturedAsset = async (
    assetId: string,
  ): Promise<CapturedAsset | undefined> =>
    findCapturedAsset(state.transcript, assetId) ??
    findCapturedAsset(await transcriptStore.load(), assetId);


  const saveBrowserAsset = async (assetId: string): Promise<void> => {
    const asset = await capturedAsset(assetId);
    const assetRefusal = browserAssetRefusal({
      present: asset !== undefined,
      downloadAvailable: asset?.downloadAvailable === true,
    });
    if (assetRefusal !== undefined || !asset) {
      throw new Error(assetRefusal ?? "The browser asset is not present in the transcript");
    }
    const workingDirectory = await requireWorkspace();
    const resolvedWorkingDirectory = await realpath(workingDirectory);
    // A response can link any https host, and the result is still listed as a provider asset.
    // Name the origin of that link before the user chooses where to put the bytes. Only a
    // canonical origin is shown, never a path, query, fragment, or full asset URL, and the
    // origin describes the linked source rather than a guaranteed final redirect host.
    const assetOrigin = isCanonicalHttpOrigin(asset.sourceOrigin)
      ? asset.sourceOrigin
      : undefined;
    const saveTitle = browserAssetSaveTitle(assetOrigin);
    const selected = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(resolvedWorkingDirectory, safeBrowserAssetName(asset.name)),
      ),
      saveLabel: "Save browser asset",
      ...(saveTitle === undefined ? {} : { title: saveTitle }),
    });
    if (!selected) {
      return;
    }
    const parent = await realpath(path.dirname(selected.fsPath));
    const destination = path.join(parent, path.basename(selected.fsPath));
    const existing = await lstat(destination).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? undefined : Promise.reject(error),
    );
    const destinationRefusal = browserAssetDestinationRefusal({
      parentInsideWorkspace: isInside(resolvedWorkingDirectory, parent),
      destinationInsideWorkspace: isInside(resolvedWorkingDirectory, destination),
      ...(existing === undefined ? {} : { existing: { isSymbolicLink: existing.isSymbolicLink() } }),
    });
    if (destinationRefusal !== undefined) {
      throw new Error(destinationRefusal);
    }
    const maximumBytes = browserAssetMaximumBytes(
      configuration().get<number>("maxBrowserAssetBytes", 52_428_800),
    );
    const controller = new AbortController();
    activeForegroundOperations += 1;
    const operation = (async (): Promise<void> => {
      const temporary = path.join(
        parent,
        `.${path.basename(destination)}.${randomUUID()}.bachata-download`,
      );
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(temporary, "wx", 0o600);
        let started = false;
        let expectedSequence = 0;
        let receivedBytes = 0;
        const digest = createHash("sha256");
        let transferredName = asset.name;
        let transferredMimeType = asset.mimeType;
        let declaredSize: number | undefined;
        let completed:
          | { size: number; sha256: string }
          | undefined;
        for await (const event of bridge.fetchAsset(
          asset.id,
          maximumBytes,
          controller.signal,
        )) {
          if (controller.signal.aborted) {
            throw new Error("Browser asset transfer was cancelled");
          }
          if (event.type === "start") {
            if (
              started ||
              event.assetId !== asset.id ||
              (event.size !== undefined && event.size > maximumBytes)
            ) {
              throw new Error("Browser asset transfer start is invalid");
            }
            started = true;
            transferredName = event.name;
            transferredMimeType = event.mimeType ?? transferredMimeType;
            declaredSize = event.size;
            continue;
          }
          if (event.type === "chunk") {
            if (
              !started ||
              event.assetId !== asset.id ||
              event.sequence !== expectedSequence ||
              receivedBytes + event.data.length > maximumBytes
            ) {
              throw new Error("Browser asset transfer chunk is invalid");
            }
            let offset = 0;
            while (offset < event.data.length) {
              const result = await handle.write(
                event.data,
                offset,
                event.data.length - offset,
              );
              if (result.bytesWritten <= 0) {
                throw new Error("Browser asset transfer could not write its data");
              }
              offset += result.bytesWritten;
            }
            digest.update(event.data);
            expectedSequence += 1;
            receivedBytes += event.data.length;
            continue;
          }
          if (
            !started ||
            event.assetId !== asset.id ||
            event.size !== receivedBytes ||
            (declaredSize !== undefined && declaredSize !== receivedBytes)
          ) {
            throw new Error("Browser asset transfer completion is invalid");
          }
          completed = { size: event.size, sha256: event.sha256 };
        }
        if (!started || !completed) {
          throw new Error("Browser asset transfer ended before completion");
        }
        const actualSha256 = digest.digest("hex");
        if (actualSha256 !== completed.sha256) {
          throw new Error("Browser asset checksum does not match the received bytes");
        }
        await handle.sync();
        await handle.close();
        handle = undefined;
        await link(temporary, destination);
        await rm(temporary, { force: true });
        const relativePath = path.relative(resolvedWorkingDirectory, destination);
        await appendTranscript(
          createEventEntry(
            "browser.asset.saved",
            `Saved ${transferredName} to ${relativePath || path.basename(destination)}.`,
            toJsonValue({
              assetId: asset.id,
              provider: asset.provider,
              kind: asset.kind,
              name: transferredName,
              mimeType: transferredMimeType ?? null,
              size: completed.size,
              sha256: completed.sha256,
              relativePath: relativePath || path.basename(destination),
            }),
          ),
        );
        await vscode.window.showInformationMessage(
          `Saved browser asset to ${relativePath || path.basename(destination)}`,
        );
      } catch (error) {
        await appendTranscript(
          createEventEntry(
            "browser.asset.error",
            error instanceof Error ? error.message : String(error),
            toJsonValue({ assetId: asset.id, provider: asset.provider }),
          ),
        ).catch(() => undefined);
        throw error;
      } finally {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    })();
    try {
      await trackForegroundOperation([controller], operation);
    } finally {
      activeForegroundOperations -= 1;
    }
  };

  const revealBrowserAsset = async (assetId: string): Promise<void> => {
    const asset = await capturedAsset(assetId);
    if (!asset) {
      throw new Error("The browser asset is not present in the transcript");
    }
    await bridge.revealAsset(asset.id);
    await appendTranscript(
      createEventEntry(
        "browser.asset.revealed",
        `Opened ${asset.name} in ${browserProviderName(asset.provider)}.`,
        toJsonValue({
          assetId: asset.id,
          provider: asset.provider,
          kind: asset.kind,
          downloadAvailable: asset.downloadAvailable,
        }),
      ),
    );
  };

  const exportTranscript = async (): Promise<void> => {
    const transcript = await transcriptStore.load();
    const defaultDirectory = state.workingDirectory ?? storageDirectory;
    const selected = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(
        path.join(defaultDirectory, `bachata-transcript-${state.taskId}.json`),
      ),
      filters: { JSON: ["json"] },
      saveLabel: "Export Bachata transcript",
    });
    if (!selected) {
      return;
    }
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      taskId: state.taskId,
      workingDirectory: state.workingDirectory,
      pipeline: state.selectedPipelineDefinition,
      roles: state.roles,
      agents: Object.fromEntries(
        Object.entries(state.agents).map(([agentId, agent]) => [
          agentId,
          {
            id: agent.id,
            name: agent.name,
            adapterType: agent.adapterType,
            version: agent.version,
            sessionId: agent.sessionId,
          },
        ]),
      ),
      transcript,
    };
    await atomicWriteText(selected.fsPath, `${JSON.stringify(payload, null, 2)}
`);
    await vscode.window.showInformationMessage(
      `Bachata transcript exported to ${selected.fsPath}`,
    );
  };

  const pickWorkingDirectory = async (): Promise<void> => {
    if (pickingWorkingDirectory) {
      throw new Error("Working-directory selection is already open");
    }
    if (
      workflowActive ||
      anyAgentRunning() ||
      activeForegroundOperations > 0 ||
      checkingAvailability
    ) {
      throw new Error("Wait for the active operation before changing the working directory");
    }
    pickingWorkingDirectory = true;
    try {
      const defaultDirectoryUri = state.workingDirectory
        ? vscode.Uri.file(state.workingDirectory)
        : vscode.workspace.workspaceFolders?.at(0)?.uri;
      const selected = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        ...(defaultDirectoryUri === undefined ? {} : { defaultUri: defaultDirectoryUri }),
        openLabel: "Use as Bachata working directory",
      });
      const candidate = selected?.at(0)?.fsPath;
      if (!candidate) {
        return;
      }
      const resolved = await resolveAllowedDirectory(candidate);
      if (resolved === state.workingDirectory) {
        return;
      }
      if (hasDurableTaskState() || state.workflowStatus !== "idle") {
        const answer = await vscode.window.showWarningMessage(
          "Changing the working directory will start a new Bachata task and remove queued or recoverable work from this run.",
          { modal: true },
          "Change and reset",
        );
        if (answer !== "Change and reset") {
          return;
        }
      }
      await resetForWorkingDirectory(resolved);
    } finally {
      pickingWorkingDirectory = false;
    }
  };

  const resetSession = async (agentId?: string): Promise<void> => {
    const targets = agentId ? [agentId] : Object.keys(adapters);
    targets.forEach((id) => {
      if (!adapters[id]) {
        throw new Error(`Unknown agent: ${id}`);
      }
    });
    if (
      workflowActive ||
      anyAgentRunning() ||
      activeForegroundOperations > 0
    ) {
      throw new Error("Wait for the active operation before resetting sessions");
    }
    const pipeline = state.selectedPipelineDefinition;
    if (!pipeline) {
      throw new Error("No selected pipeline is available");
    }
    const targetIds = new Set(targets);
    const previousTopology = currentTopology();
    const persistedAgents = Object.fromEntries(
      Object.entries(state.agents).map(([id, agent]) => [
        id,
        targetIds.has(id)
          ? {
              version: agent.version,
              ...(agent.browserBinding?.provider === "generic"
                ? { browserBinding: agent.browserBinding }
                : {}),
            }
          : {
              version: agent.version,
              sessionId: agent.sessionId,
              browserBinding: agent.browserBinding,
            },
      ]),
    );
    const candidate = await buildAdapterTopology(
      pipeline,
      persistedAgents,
      state.workingDirectory,
    );
    Object.keys(candidate.agents).forEach((id) => {
      if (!targetIds.has(id) && state.agents[id]) {
        candidate.agents[id] = structuredClone(state.agents[id]);
      }
    });
    let bindingsReleased = false;
    try {
      releaseBrowserBindings(previousTopology);
      bindingsReleased = true;
      await persistStatePatch(
        { agents: persistedAgentsFromTopology(candidate) },
        () => {
          installTopology(candidate);
        },
      );
    } catch (error) {
      if (bindingsReleased) {
        bindBrowserAgents(previousTopology);
      }
      const cleanupFailures = await disposeTopology(candidate);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Session reset failed and candidate cleanup was incomplete",
        );
      }
      throw error;
    }
    bindBrowserAgents(candidate);
    const cleanupFailures = await disposeTopology(previousTopology);
    cleanupFailures.forEach((error) => {
      logOutput(
        `Failed to dispose a replaced provider adapter: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    targets.forEach((id) => {
      post({ type: "agent.reset", agentId: id });
    });
    emitSnapshot();
  };

  const handleSessionMessage = async (
    message: Extract<WebviewToExtensionMessage, { type: "ready" | "availability.check" | "contract.acknowledge" | "session.reset" | "task.reset" | "workingDirectory.pick" }>,
  ): Promise<void> => {
    if (message.type === "ready") {
      emitSnapshot();
      return;
    }
    if (message.type === "availability.check") {
      await ensureAdaptersReady();
      await checkAvailability();
      return;
    }
    if (message.type === "contract.acknowledge") {
      acknowledgeContractAuthority(message.fingerprint);
      emitSnapshot();
      return;
    }
    if (message.type === "session.reset") {
      await resetSession(message.agentId);
      return;
    }
    if (message.type === "task.reset") {
      await resetForWorkingDirectory(state.workingDirectory);
      return;
    }
    if (message.type === "workingDirectory.pick") {
      await pickWorkingDirectory();
      return;
    }
    throw unsupportedWebviewMessage(message);
  };

  const handleConversationMessage = async (
    message: Extract<WebviewToExtensionMessage, { type: "message.send" }>,
  ): Promise<void> => {
    await ensureAdaptersReady();
    await deliverDirectMessage(
      message.recipients,
      message.prompt,
      message.mode,
      message.attachmentIds,
      message.delivery,
    );
  };

  const handleHumanGateDecision = async (
    message: Extract<WebviewToExtensionMessage, { type: "run.gate" }>,
  ): Promise<void> => {
      const resolver = gateResolver;
      const pendingGate = state.pendingGate;
      const taskId = state.taskId;
      const controller = workflowController;
      const busy = (): boolean => anyAgentRunning() || foregroundReservations.size > 0;
      const refusal = humanGateDecisionRefusal({
        waiting: resolver !== undefined,
        busy: busy(),
        pendingGate,
        action: message.action,
        targetStepId: message.targetStepId,
      });
      if (refusal !== undefined) {
        throw new Error(refusal);
      }
      if (!resolver || !pendingGate) {
        return;
      }
      if (
        continueNeedsInterventionConsent({
          action: message.action,
          interventionCount: pendingGateInterventions.length,
        })
      ) {
        const choice = await vscode.window.showWarningMessage(
          INTERVENTION_CONSENT.message,
          { modal: true },
          INTERVENTION_CONSENT.confirm,
        );
        if (choice !== INTERVENTION_CONSENT.confirm) {
          return;
        }
      }
      const lateRefusal = humanGateDecisionRefusal({
        waiting: true,
        busy: busy(),
        pendingGate,
        action: message.action,
        targetStepId: message.targetStepId,
      });
      if (lateRefusal !== undefined) {
        throw new Error(lateRefusal);
      }
      if (gateResolver !== resolver || resultIsStale({ operationTaskId: taskId, currentTaskId: state.taskId })) {
        return;
      }
      const interventions = [...pendingGateInterventions];
      gateDecisionActive = true;
      gateResolver = undefined;
      try {
        const decided = gateDecidedRecord({
          pendingGate,
          action: message.action,
          targetStepId: message.targetStepId,
          interventionIds: interventions.map((item) => item.id),
        });
        await appendTranscript(
          createEventEntry(
            "gate.decided",
            decided.text,
            toJsonValue(decided.payload),
            undefined,
            decided.step,
          ),
        );
        if (resultIsStale({ operationTaskId: taskId, currentTaskId: state.taskId, aborted: controller?.signal.aborted === true })) {
          resolver.resolve({ action: "cancel" });
          return;
        }
        pendingGateInterventions = [];
        patchRun(true, "running", {
          ...(state.activeStep === undefined ? {} : { activeStep: state.activeStep }),
          ...(state.activeStepId === undefined ? {} : { activeStepId: state.activeStepId }),
          ...(state.consensusRound === undefined ? {} : { consensusRound: state.consensusRound }),
        });
        resolver.resolve(humanGateResolution({
          action: message.action,
          targetStepId: message.targetStepId,
          interventions,
        }));
      } catch (error) {
        resolver.resolve({ action: "cancel" });
        throw error;
      } finally {
        gateDecisionActive = false;
      }
      return;
  };

  const handleRunMessage = async (
    message: Extract<WebviewToExtensionMessage, { type: "pipeline.run" | "run.interrupt" | "run.gate" | "workflow.resume" | "workflow.discard" }>,
  ): Promise<void> => {
    if (message.type === "pipeline.run") {
      await deliverPipelineRequest(
        message.prompt,
        message.attachmentIds,
        message.delivery,
        message.iterationCount ?? 1,
        message.iterationMode ?? "fixed",
        message.requiredCleanPasses ?? 2,
        () => postOperationResult(message.requestId, "pipeline.run", "accepted"),
      );
      return;
    }
    if (message.type === "run.interrupt") {
      const cancelsPipeline =
        !message.agentId ||
        (workflowActive && state.workflowStatus === "running");
      if (cancelsPipeline) {
        workflowController?.abort();
        gateResolver?.resolve({ action: "cancel" });
        gateResolver = undefined;
      }
      await interruptAgents(
        message.agentId ? [message.agentId] : Object.keys(adapters),
      );
      return;
    }
    if (message.type === "run.gate") {
      await handleHumanGateDecision(message);
      return;
    }
    if (message.type === "workflow.resume") {
      const queuedRecoveryMessageId =
        resumableWorkflowData?.sourceQueueMessageId;
      if (queuedRecoveryMessageId) {
        await adoptQueuedRecovery(queuedRecoveryMessageId);
      }
      await reconcileQueueStartClaim();
      const recovery = resumableWorkflowData;
      // EX-AUD-12. Whether a cancelled run may resume is decided in `recoveryTransition.ts`.
      const resumeProblem = resumeRefusal({
        ...(recovery ? { checkpoint: recovery } : {}),
        workflowActive: false,
      });
      if (resumeProblem === "already-completed") {
        await setResumableWorkflow(undefined);
        throw new Error("The saved workflow had already completed");
      }
      if (!recovery || resumeProblem) {
        throw new Error("No recoverable workflow is available");
      }
      await runPipeline(recovery.userPrompt, recovery.attachmentIds, {
        pipelineId: recovery.pipelineId,
        resume: recovery,
        appendPrompt: false,
      });
      return;
    }
    if (message.type === "workflow.discard") {
      if (activeWorkflow || workflowActive) {
        throw new Error("Interrupt the active workflow before discarding recovery");
      }
      await discardResumableWorkflow(
        "workflow.recoveryDiscarded",
        "Recoverable workflow checkpoint discarded.",
      );
      if (discardReturnsToIdle(state.workflowStatus)) {
        patchRun(false, "idle");
      }
      return;
    }
    throw unsupportedWebviewMessage(message);
  };

  const handleCatalogMessage = async (
    message: Extract<WebviewToExtensionMessage, { type: "pipeline.select" | "pipeline.validate" | "pipeline.save" | "pipeline.delete" | "pipeline.import" | "pipeline.fork" | "pipeline.export" }>,
  ): Promise<void> => {
    if (message.type === "pipeline.select") {
      await selectPipeline(message.pipelineId);
      postOperationResult(message.requestId, "pipeline.select", "completed");
      return;
    }
    if (message.type === "pipeline.validate") {
      const validation = validatePipelineDefinition(message.pipeline);
      if (validation.success === false) {
        postOperationResult(
          message.requestId,
          "pipeline.validate",
          "failed",
          { message: validation.errors.join("\n") },
        );
        return;
      }
      postOperationResult(
        message.requestId,
        "pipeline.validate",
        "completed",
        { pipeline: validation.data },
      );
      return;
    }
    if (message.type === "pipeline.save") {
      await savePipeline(message.pipeline, {
        mode: message.mode,
        scopeKey: message.scopeKey,
        ...(message.sourcePipelineId === undefined ? {} : { sourcePipelineId: message.sourcePipelineId }),
        ...(message.expectedHash === undefined ? {} : { expectedHash: message.expectedHash }),
      });
      postOperationResult(message.requestId, "pipeline.save", "completed");
      return;
    }
    if (message.type === "pipeline.delete") {
      await deletePipeline(
        message.pipelineId,
        message.scopeKey,
        message.expectedHash,
      );
      postOperationResult(message.requestId, "pipeline.delete", "completed");
      return;
    }
    if (message.type === "pipeline.import") {
      const imported = await importPipeline();
      postOperationResult(
        message.requestId,
        "pipeline.import",
        imported ? "completed" : "cancelled",
        imported ? { pipeline: imported } : {},
      );
      return;
    }
    if (message.type === "pipeline.fork") {
      assertPipelineCanChange();
      const source = pipelines.get(message.pipelineId);
      if (!source) throw new Error(`Unknown pipeline: ${message.pipelineId}`);
      const baseId = `${source.id}-fork`;
      let id = baseId;
      for (let index = 2; pipelines.has(id); index += 1) id = `${baseId}-${String(index)}`;
      const pipeline = forkPipelineDefinition(source, id, `${source.name} fork`);
      postOperationResult(message.requestId, "pipeline.fork", "completed", { pipeline });
      return;
    }
    if (message.type === "pipeline.export") {
      const exported = await exportPipeline(message.pipelineId, message.pipeline);
      postOperationResult(
        message.requestId,
        "pipeline.export",
        exported ? "completed" : "cancelled",
      );
      return;
    }
    throw unsupportedWebviewMessage(message);
  };

  const handleBrowserMessage = async (
    message: Extract<WebviewToExtensionMessage, { type: "browser.session.select" | "browser.asset.save" | "browser.asset.reveal" | "bridge.reset" | "bridge.discover" }>,
  ): Promise<void> => {
    if (message.type === "browser.session.select") {
      await selectBrowserSession(message.agentId, message.sessionId);
      return;
    }
    if (message.type === "browser.asset.save") {
      await saveBrowserAsset(message.assetId);
      return;
    }
    if (message.type === "browser.asset.reveal") {
      await revealBrowserAsset(message.assetId);
      return;
    }
    if (message.type === "bridge.reset") {
      await bridge.resetPairing();
      return;
    }
    if (message.type === "bridge.discover") {
      bridge.discover();
      return;
    }
    throw unsupportedWebviewMessage(message);
  };

  const handleTranscriptMessage = async (
    message: Extract<WebviewToExtensionMessage, { type: "transcript.export" | "transcript.loadOlder" }>,
  ): Promise<void> => {
    if (message.type === "transcript.export") {
      await exportTranscript();
      return;
    }
    if (message.type === "transcript.loadOlder") {
      const page = await transcriptStore.loadBefore(
        message.beforeId ?? state.transcript.at(0)?.id,
        Math.max(
          50,
          configuration().get<number>("transcriptWindowSize", 300),
        ),
      );
      post({
        type: "transcript.prepend",
        entries: page.entries,
        hasMore: page.hasMore,
        total: page.total,
      });
      return;
    }
    throw unsupportedWebviewMessage(message);
  };

  const handleQueueMessage = async (
    message: Extract<WebviewToExtensionMessage, { type: "queue.cancel" | "queue.resume" }>,
  ): Promise<void> => {
    if (message.type === "queue.cancel") {
      const queued = state.queuedMessages.find(
        (item) => item.id === message.messageId,
      );
      if (!queued) {
        throw new Error("The queued message no longer exists");
      }
      const removed = await cancelQueuedMessage(queued.id);
      if (!removed) {
        throw new Error("The queued message already started");
      }
      return;
    }
    if (message.type === "queue.resume") {
      if (resumableWorkflowData && !activeWorkflow) {
        throw new Error(
          "Resume or discard the interrupted workflow before resuming the queue",
        );
      }
      const blockedQueuedMessage = state.queuedMessages[0];
      if (blockedQueuedMessage?.blockedReason) {
        throw new Error(blockedQueuedMessage.blockedReason);
      }
      await reconcileQueueStartClaim();
      await serializeQueueTransition(() =>
        commitQueueState({
          queuedMessages: state.queuedMessages,
          queuePaused: false,
          queueStart: undefined,
          taskDirty,
        }),
      );
      return;
    }
    throw unsupportedWebviewMessage(message);
  };

  const handleApprovalMessage = async (
    message: Extract<WebviewToExtensionMessage, { type: "approval.respond" }>,
  ): Promise<void> => {
    await resolveApproval(
      message.agentId,
      message.requestId,
      message.choiceId,
    );
  };

  const handleAttachmentMessage = async (
    message: Extract<WebviewToExtensionMessage, { type: "attachment.add" | "attachment.remove" }>,
  ): Promise<void> => {
    if (message.type === "attachment.add") {
      refreshRuntimeLimits();
      if (resultIsStale({ operationTaskId: message.taskId, currentTaskId: state.taskId })) {
        throw new Error("Attachment belongs to a previous task");
      }
      if (state.attachments.length >= state.maxAttachmentCount) {
        throw new Error(`Task attachment limit is ${String(state.maxAttachmentCount)}`);
      }
      const currentBytes = state.attachments.reduce(
        (total, attachment) => total + attachment.size,
        0,
      );
      const remainingBytes = state.maxAttachmentTotalBytes - currentBytes;
      if (remainingBytes <= 0) {
        throw new Error(
          `Task attachments exceed the ${String(state.maxAttachmentTotalBytes)} byte limit`,
        );
      }
      const attachment = await attachmentStore.save({
        id: randomUUID(),
        name: message.name,
        mimeType: message.mimeType,
        dataBase64: message.dataBase64,
        maxBytes: Math.min(state.maxAttachmentBytes, remainingBytes),
      });
      state.attachments.push(attachment);
      taskDirty = true;
      schedulePersist();
      post({ type: "attachment.added", clientId: message.clientId, attachment });
      return;
    }
    if (attachmentUseCount > 0) {
      throw new Error("Wait for the active operation before removing attachments");
    }
    const referencedByQueue = state.queuedMessages.some((queued) =>
      queued.attachmentIds.includes(message.attachmentId),
    );
    const referencedByRecovery =
      resumableWorkflowData?.attachmentIds.includes(message.attachmentId) ?? false;
    if (referencedByQueue || referencedByRecovery) {
      throw new Error(
        "Cancel the queued message or discard workflow recovery before removing this attachment",
      );
    }
    const attachment = state.attachments.find(
      (item) => item.id === message.attachmentId,
    );
    if (!attachment) {
      throw new Error(`Unknown attachment: ${message.attachmentId}`);
    }
    await attachmentStore.remove(attachment);
    state.attachments = state.attachments.filter(
      (item) => item.id !== message.attachmentId,
    );
    schedulePersist();
    post({ type: "attachment.removed", attachmentId: message.attachmentId });
  };

  const handleMessageNow = async (raw: unknown): Promise<void> => {
    if (disposed) {
      throw new Error("Bachata runtime is disposed");
    }
    await awaitInitialization();
    if (disposed) {
      throw new Error("Bachata runtime is disposed");
    }
    const parsed = parseWebviewMessage(raw);
    if (parsed.success === false) {
      throw new Error(parsed.error);
    }
    const message = parsed.message;

    if (requiresWritableHost(message.type)) {
      hostCallbacks.assertWritable?.();
    }
    switch (message.type) {
      case "ready":
      case "availability.check":
      case "contract.acknowledge":
      case "session.reset":
      case "task.reset":
      case "workingDirectory.pick":
        return await handleSessionMessage(message);
      case "message.send":
        return await handleConversationMessage(message);
      case "pipeline.run":
      case "run.interrupt":
      case "run.gate":
      case "workflow.resume":
      case "workflow.discard":
        return await handleRunMessage(message);
      case "pipeline.select":
      case "pipeline.validate":
      case "pipeline.save":
      case "pipeline.delete":
      case "pipeline.import":
      case "pipeline.fork":
      case "pipeline.export":
        return await handleCatalogMessage(message);
      case "browser.session.select":
      case "browser.asset.save":
      case "browser.asset.reveal":
      case "bridge.reset":
      case "bridge.discover":
        return await handleBrowserMessage(message);
      case "transcript.export":
      case "transcript.loadOlder":
        return await handleTranscriptMessage(message);
      case "queue.cancel":
      case "queue.resume":
        return await handleQueueMessage(message);
      case "attachment.add":
      case "attachment.remove":
        return await handleAttachmentMessage(message);
      case "approval.respond":
        return await handleApprovalMessage(message);
      default:
        throw unsupportedWebviewMessage(message);
    }
  };

  const enqueueMutation = <T>(operation: () => Promise<T>): Promise<T> => {
    const guardedOperation = async (): Promise<T> => {
      mutationActive = true;
      let completed = false;
      try {
        const result = await operation();
        completed = true;
        return result;
      } finally {
        mutationActive = false;
        if (completed) {
          scheduleQueueDrain();
        }
      }
    };
    const link = chainSerially(mutationQueue, guardedOperation);
    mutationQueue = link.settled;
    return link.result;
  };

  const handleMessage = (raw: unknown): Promise<void> => {
    if (disposed) {
      return Promise.reject(new Error("Bachata runtime is disposed"));
    }
    const plan = webviewDispatchPlan(raw);
    const pending = plan.serialize
      ? enqueueMutation(() => handleMessageNow(raw))
      : handleMessageNow(raw);
    // EX-G6-17. The editor holds a request open until an `operation.result` comes back with its
    // id. A handler that throws before posting one — `pipeline.fork` refusing an unknown
    // pipeline, or refusing to change a pipeline while a run is in flight — left that request
    // pending for the life of the panel, with the error surfacing as an uncorrelated banner that
    // told the editor nothing about the operation it was waiting on. Every operation answers now,
    // and the failure still propagates to whoever called.
    const requestId = plan.requestId;
    const messageType = plan.messageType;
    if (!plan.settlesOnFailure || requestId === undefined || !isRuntimeOperation(messageType)) {
      return pending;
    }
    return pending.catch((error: unknown) => {
      postOperationResult(requestId, messageType, "failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  };

  const attachWebview = (webview: RuntimeWebview): vscode.Disposable => {
    webviews.add(webview);
    void awaitInitialization().then(emitSnapshot, (error) => {
      post({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return new vscode.Disposable(() => {
      webviews.delete(webview);
    });
  };

  const workspaceSubscription = vscode.workspace.onDidChangeWorkspaceFolders(
    () => {
      const operation = enqueueMutation(async (): Promise<void> => {
        state.workspaceRoots = getWorkspaceRoots();
        const invalidWorkingDirectory = Boolean(
          state.workingDirectory &&
            !(await isAllowedWorkspaceDirectory(state.workingDirectory)),
        );
        if (invalidWorkingDirectory) {
          const previousDirectory = state.workingDirectory;
          const targetScope = await resolvePipelineScope(undefined, state.workspaceRoots);
          await reloadPipelines(targetScope);
          const pipeline = pipelines.get("review-only") ?? pipelines.values().next().value;
          if (!pipeline) {
            throw new Error("No pipeline is available after the workspace changed");
          }
          const pipelineSnapshot = snapshotForPipeline(pipeline);
          const candidate = await buildAdapterTopology(
            pipeline,
            resetAgentsFromState(),
            undefined,
          );
          await resetTaskState(undefined, {
            pipeline,
            pipelineSnapshot,
            topology: candidate,
          });
          state.workflowStatus = "paused";
          await appendTranscript(
            createEventEntry(
              "workspace.invalidated",
              "The Bachata working directory left the active VS Code workspace. Sessions were reset.",
              toJsonValue({ previousDirectory: previousDirectory ?? null }),
            ),
          );
          emitSnapshot();
          schedulePersist();
          await vscode.window.showWarningMessage(
            "The Bachata working directory is no longer in this workspace. Agent sessions were reset. Select a new working directory before continuing.",
          );
          return;
        }
        const targetScope = await resolvePipelineScope(
          state.workingDirectory,
          state.workspaceRoots,
        );
        if (targetScope.key !== activePipelineScope.key && !pipelineMutationReason()) {
          if (state.workingDirectory) {
            await resetForWorkingDirectory(state.workingDirectory);
          } else {
            await reloadPipelines(targetScope);
            const pipeline = pipelines.get("review-only") ?? pipelines.values().next().value;
            if (!pipeline) {
              throw new Error("No pipeline is available after the workspace changed");
            }
            const pipelineSnapshot = snapshotForPipeline(pipeline);
            const candidate = await buildAdapterTopology(
              pipeline,
              resetAgentsFromState(),
              undefined,
            );
            await resetTaskState(undefined, {
              pipeline,
              pipelineSnapshot,
              topology: candidate,
            });
          }
          return;
        }
        emitSnapshot();
        schedulePersist();
      });
      workspaceChangeOperation = operation;
      void operation.catch((error) => {
        logOutput(
          `Failed to handle workspace change: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        if (workspaceChangeOperation === operation) {
          workspaceChangeOperation = undefined;
        }
      });
    },
  );

  const trustSubscription = vscode.workspace.onDidGrantWorkspaceTrust(() => {
    state.trusted = true;
    emitSnapshot();
  });

  const runtimeIsBusy = (): boolean =>
    workflowActive ||
    Boolean(activeWorkflow) ||
    activeForegroundOperations > 0 ||
    mutationActive ||
    checkingAvailability ||
    pickingWorkingDirectory ||
    gateDecisionActive ||
    queueDraining;

  const replaceWorkingDirectoryPreservingHistory = async (
    workingDirectory: string,
  ): Promise<void> => {
    const pipeline = state.selectedPipelineDefinition;
    if (!pipeline) {
      throw new Error("No selected pipeline is available");
    }
    const previousDirectory = state.workingDirectory;
    const previousTopology = currentTopology();
    const candidate = await buildAdapterTopology(
      pipeline,
      freshAgentsFromState(),
      workingDirectory,
    );
    let bindingsReleased = false;
    try {
      releaseBrowserBindings(previousTopology);
      bindingsReleased = true;
      await persistStatePatch(
        {
          workingDirectory,
          agents: persistedAgentsFromTopology(candidate),
        },
        () => {
          state.workingDirectory = workingDirectory;
          installTopology(candidate);
        },
      );
    } catch (error) {
      if (bindingsReleased) {
        bindBrowserAgents(previousTopology);
      }
      const cleanupFailures = await disposeTopology(candidate);
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Working-directory change failed and candidate cleanup was incomplete",
        );
      }
      throw error;
    }
    bindBrowserAgents(candidate);
    const cleanupFailures = await disposeTopology(previousTopology);
    cleanupFailures.forEach((error) => {
      logOutput(
        `Failed to dispose a replaced provider adapter: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    Object.keys(candidate.agents).forEach((agentId) => {
      post({ type: "agent.reset", agentId });
    });
    emitSnapshot();
    if (previousDirectory !== workingDirectory) {
      await appendTranscriptAfterCommit(
        createEventEntry(
          "workingDirectory.changed",
          "Working directory changed while preserving the conversation history.",
          toJsonValue({
            previousDirectory: previousDirectory ?? null,
            workingDirectory,
          }),
        ),
        "Working-directory change",
      );
    }
  };

  const configureProgrammatic = async (
    configurationValue: RuntimeConfiguration,
  ): Promise<void> => {
    await awaitInitialization();
    if (runtimeIsBusy()) {
      throw new Error("Wait for the active operation before configuring the run");
    }
    const configuredSnapshot = configurationValue.pipelineSnapshot
      ? parsePipelineSnapshot(configurationValue.pipelineSnapshot)
      : undefined;
    if (
      configurationValue.pipelineSnapshot &&
      (!configuredSnapshot ||
        !pipelineSnapshotsEqual(configuredSnapshot, configurationValue.pipelineSnapshot))
    ) {
      throw new Error("The configured pipeline snapshot is invalid");
    }
    if (
      configuredSnapshot &&
      configurationValue.pipelineId &&
      configuredSnapshot.definition.id !== configurationValue.pipelineId
    ) {
      throw new Error("Configured pipeline id does not match its immutable snapshot");
    }
    if (
      !configurationValue.pipelineId &&
      !configuredSnapshot &&
      !configurationValue.workingDirectory
    ) {
      throw new Error("Pipeline or working directory configuration is required");
    }
    let pipelineConfiguredWithDirectory = false;
    if (configurationValue.workingDirectory) {
      const resolved = await resolveAllowedDirectory(configurationValue.workingDirectory);
      if (state.workingDirectory !== resolved) {
        if (configurationValue.preserveHistory) {
          if (configuredSnapshot) {
            throw new Error(
              "An immutable pipeline snapshot cannot be changed while preserving history",
            );
          }
          if (
            state.queuedMessages.length > 0 ||
            queueStartClaim ||
            resumableWorkflowData
          ) {
            throw new Error(
              "Queued or recoverable work must finish before preserving history across a directory change",
            );
          }
          const targetScope = await resolvePipelineScope(resolved, state.workspaceRoots);
          if (targetScope.key !== activePipelineScope.key) {
            throw new Error(
              "Conversation history cannot move across pipeline workspace scopes",
            );
          }
          if (
            configurationValue.pipelineId &&
            configurationValue.pipelineId !== selectedPipelineSnapshot?.definition.id
          ) {
            throw new Error(
              "Pipeline and working directory cannot both change while preserving history",
            );
          }
          await replaceWorkingDirectoryPreservingHistory(resolved);
        } else if (configuredSnapshot) {
          await resetForPipelineSnapshot(resolved, configuredSnapshot);
          pipelineConfiguredWithDirectory = true;
        } else {
          await resetForWorkingDirectory(
            resolved,
            configurationValue.pipelineId ?? selectedPipelineSnapshot?.definition.id,
            configurationValue.pipelineId !== undefined,
          );
          pipelineConfiguredWithDirectory = configurationValue.pipelineId !== undefined;
        }
      }
    }
    if (
      configuredSnapshot &&
      !pipelineConfiguredWithDirectory &&
      !pipelineSnapshotsEqual(selectedPipelineSnapshot, configuredSnapshot)
    ) {
      await resetForPipelineSnapshot(state.workingDirectory, configuredSnapshot);
      pipelineConfiguredWithDirectory = true;
    }
    if (
      configurationValue.pipelineId &&
      !configuredSnapshot &&
      !pipelineConfiguredWithDirectory &&
      selectedPipelineSnapshot?.definition.id !== configurationValue.pipelineId
    ) {
      await selectPipeline(configurationValue.pipelineId);
    }
    await persistNow();
  };

  const ensureProgrammaticBrowserSession = async (
    agentId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    if (!programmaticAutoProvisioning) return;
    const agent = state.agents[agentId];
    const provider = agent ? browserProviderForAdapterType(agent.adapterType) : undefined;
    if (!agent || !provider) return;
    const ownerId = `${runtimeOwnerId}:${agentId}`;
    try {
      const current = bridge.resolveBoundSession(ownerId, agent.browserBinding, agent.sessionId);
      if (current?.status === "ready") {
        programmaticResetBindings.delete(agentId);
        return;
      }
    } catch {
      // EX-AUD-13. Resolution failing is not proof of a ready session, and only a ready
      // session short-circuits. Provisioning below is the answer for every other outcome.
    }
    const resetBinding = programmaticResetBindings.get(agentId);
    const preferredBinding = agent.browserBinding ?? resetBinding;
    const opened = await bridge.openConversation(
      provider,
      signal,
      preferredBinding,
      provider === "generic" || Boolean(resetBinding),
    );
    if (signal.aborted) throw new Error("Browser fallback provisioning was interrupted");
    await selectBrowserSession(agentId, opened.id, { allowDuringActiveWorkflow: true });
    programmaticResetBindings.delete(agentId);
  };

  const ensureFreshManagedBrowserSession = async (
    agentId: string,
    taskId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const key = managedFreshSessionKey(taskId, agentId);
    if (managedFreshSessionKeys.has(key)) return;
    const agent = state.agents[agentId];
    const provider = agent ? browserProviderForAdapterType(agent.adapterType) : undefined;
    if (!agent || !provider) return;
    const preferredBinding = agent.browserBinding ?? programmaticResetBindings.get(agentId);
    const opened = await bridge.openConversation(provider, signal, preferredBinding, true);
    if (signal.aborted) throw new Error("Opening a fresh managed browser conversation was interrupted");
    if (provider === "generic") {
      const capabilities = opened.capabilities;
      if (!capabilities
        || capabilities.submission !== "verifiedSend"
        || capabilities.completion !== "verifiedLifecycle"
        || capabilities.interruption !== "confirmed"
        || capabilities.conversationState !== "confirmed") {
        throw new Error("Fresh managed Generic conversation lacks verified Send, completion lifecycle, interruption, or conversation state");
      }
    }
    await selectBrowserSession(agentId, opened.id, { allowDuringActiveWorkflow: true });
    managedFreshSessionKeys.add(key);
  };

  const refreshProgrammaticPipelines = async (
    change?: PipelineCatalogChange,
  ): Promise<void> => {
    await awaitInitialization();
    if (change?.ownerId === runtimeOwnerId) {
      return;
    }
    await enqueueMutation(async () => {
      const scope = await resolvePipelineScope(state.workingDirectory, state.workspaceRoots);
      if (change && change.scopeKey !== scope.key) {
        return;
      }
      const previousSnapshot = selectedPipelineSnapshot
        ? structuredClone(selectedPipelineSnapshot)
        : undefined;
      await reloadPipelines(scope);
      const reason = pipelineMutationReason();
      if (reason) {
        refreshPipelineState();
        emitSnapshot();
        return;
      }
      const currentPipeline = previousSnapshot
        ? pipelines.get(previousSnapshot.definition.id)
        : undefined;
      const replacement = currentPipeline ?? pipelines.get("review-only") ?? pipelines.values().next().value;
      if (!replacement) {
        selectedPipelineSnapshot = undefined;
        refreshPipelineState();
        emitSnapshot();
        return;
      }
      const replacementSnapshot = snapshotForPipeline(replacement);
      if (previousSnapshot?.hash === replacementSnapshot.hash) {
        selectedPipelineSnapshot = replacementSnapshot;
        refreshPipelineState();
        emitSnapshot();
        return;
      }
      try {
        const candidate = await buildAdapterTopology(replacement);
        await activatePipeline(replacement, candidate, {
          pipelineSnapshot: replacementSnapshot,
        });
      } catch (error) {
        selectedPipelineSnapshot = previousSnapshot;
        refreshPipelineState();
        emitSnapshot();
        logOutput(
          `Pipeline catalog refreshed, but ${replacement.id} could not be activated: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    });
  };

  const preflightProgrammaticPipeline = async (
    prompt: string,
    attachmentIds: string[] = [],
    pipelineSnapshot?: PipelineSnapshot,
    options: { requireCurrentCatalog?: boolean; composerAuthorized?: boolean } = {},
  ): Promise<PipelineSnapshot> => {
    await awaitInitialization();
    await ensureAdaptersReady();
    const result = await preflightPipeline(prompt, attachmentIds, {
      pipelineSnapshot,
      requireCurrentCatalog: options.requireCurrentCatalog,
      composerAuthorized: options.composerAuthorized,
    });
    await disposeAttachmentSnapshot(result.disposeAttachments, "this preflight");
    return structuredClone(result.pipelineSnapshot);
  };

  const resetProgrammaticSessions = async (): Promise<void> => {
    await awaitInitialization();
    programmaticResetBindings.clear();
    managedFreshSessionKeys.clear();
    managedTaskState.clear();
    for (const [agentId, agent] of Object.entries(state.agents)) {
      if (agent.browserBinding) programmaticResetBindings.set(agentId, structuredClone(agent.browserBinding));
    }
    try {
      await resetSession();
    } catch (error) {
      programmaticResetBindings.clear();
      managedFreshSessionKeys.clear();
      managedTaskState.clear();
      throw error;
    }
  };

  const runProgrammaticPipeline = async (
    prompt: string,
    attachmentIds: string[] = [],
    options: {
      onAccepted?: (() => Promise<void> | void) | undefined;
      appendPrompt?: boolean | undefined;
      sourceQueueMessageId?: string | undefined;
      pipelineSnapshot?: PipelineSnapshot | undefined;
      requireCurrentCatalog?: boolean | undefined;
      allowedPaths?: string[] | undefined;
      commitMode?: "never" | "allow" | undefined;
      trackWorkspaceChanges?: boolean | undefined;
    } = {},
  ): Promise<PipelineRunResult> => {
    if (disposed) {
      throw new Error("Bachata runtime is disposed");
    }
    await awaitInitialization();
    await ensureAdaptersReady();
    const preflight = await preflightPipeline(prompt, attachmentIds, {
      ...(options.pipelineSnapshot === undefined ? {} : { pipelineSnapshot: options.pipelineSnapshot }),
      ...(options.requireCurrentCatalog === undefined ? {} : { requireCurrentCatalog: options.requireCurrentCatalog }),
    });
    await disposeAttachmentSnapshot(preflight.disposeAttachments, "this programmatic run");
    lastPipelineResult = undefined;
    programmaticAutoProvisioning = true;
    try {
      await runPipeline(prompt, attachmentIds, {
        ...(options.onAccepted === undefined ? {} : { onAccepted: options.onAccepted }),
        ...(options.appendPrompt === undefined ? {} : { appendPrompt: options.appendPrompt }),
        ...(options.sourceQueueMessageId === undefined ? {} : { sourceQueueMessageId: options.sourceQueueMessageId }),
        ...(preflight.pipelineSnapshot === undefined ? {} : { pipelineSnapshot: preflight.pipelineSnapshot }),
        requireCurrentCatalog: false,
        ...(options.allowedPaths === undefined ? {} : { allowedPaths: options.allowedPaths }),
        ...(options.commitMode === undefined ? {} : { commitMode: options.commitMode }),
        ...(options.trackWorkspaceChanges === undefined ? {} : { trackWorkspaceChanges: options.trackWorkspaceChanges }),
      });
    } finally {
      programmaticAutoProvisioning = false;
      programmaticResetBindings.clear();
      managedFreshSessionKeys.clear();
      managedTaskState.clear();
    }
    if (!lastPipelineResult) {
      throw new Error("Pipeline ended without a result");
    }
    return structuredClone(lastPipelineResult);
  };


  const resumeProgrammaticPipeline = async (
    options: { onAccepted?: () => Promise<void> | void } = {},
  ): Promise<PipelineRunResult> => {
    if (disposed) {
      throw new Error("Bachata runtime is disposed");
    }
    await awaitInitialization();
    await ensureAdaptersReady();
    const queuedRecoveryMessageId =
      resumableWorkflowData?.sourceQueueMessageId;
    if (queuedRecoveryMessageId) {
      await adoptQueuedRecovery(queuedRecoveryMessageId);
    }
    await reconcileQueueStartClaim();
    const recovery = resumableWorkflowData;
    const resumeProblem = resumeRefusal({
      ...(recovery ? { checkpoint: recovery } : {}),
      workflowActive: false,
    });
    if (resumeProblem === "already-completed") {
      await setResumableWorkflow(undefined);
      throw new Error("The saved workflow had already completed");
    }
    if (!recovery || resumeProblem) {
      throw new Error("No recoverable workflow is available");
    }
    lastPipelineResult = undefined;
    programmaticAutoProvisioning = true;
    try {
      await runPipeline(recovery.userPrompt, recovery.attachmentIds, {
        resume: recovery,
        appendPrompt: false,
        ...(recovery.sourceQueueMessageId === undefined ? {} : { sourceQueueMessageId: recovery.sourceQueueMessageId }),
        ...(options.onAccepted === undefined ? {} : { onAccepted: options.onAccepted }),
        ...(recovery.allowedPaths === undefined ? {} : { allowedPaths: recovery.allowedPaths }),
        ...(recovery.commitMode === undefined ? {} : { commitMode: recovery.commitMode }),
      });
    } finally {
      programmaticAutoProvisioning = false;
      programmaticResetBindings.clear();
      managedFreshSessionKeys.clear();
      managedTaskState.clear();
    }
    if (!lastPipelineResult) {
      throw new Error("Pipeline ended without a result");
    }
    return structuredClone(lastPipelineResult);
  };

  const interruptProgrammatic = async (): Promise<void> => {
    await awaitInitialization();
    workflowController?.abort();
    gateResolver?.resolve({ action: "cancel" });
    gateResolver = undefined;
    await interruptAgents(Object.keys(adapters));
    await activeWorkflow?.catch(() => undefined);
  };

  const shutdownIdleProviders = async (): Promise<void> => {
    await awaitInitialization();
    if (runtimeIsBusy()) {
      throw new Error("Cannot stop provider processes while the runtime is busy");
    }
    const currentAdapters = Object.values(adapters);
    if (currentAdapters.length === 0) {
      return;
    }
    const results = await Promise.allSettled(currentAdapters.map((adapter) => adapter.dispose()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
    adapters = {};
    definitions = {};
    Object.values(state.agents).forEach((agent) => {
      if (agent.status !== "error") {
        agent.status = agent.sessionId ? "idle" : "available";
      }
    });
    emitSnapshot();
  };

  return {
    handleMessage,
    attachWebview,
    getState: () => structuredClone(state),
    // With no explicit id, the answer is about the pipeline this runtime would actually
    // run, which is the selected snapshot.
    pipelineRequiresInitiative: (pipelineId?: string) =>
      (pipelineId === undefined
        ? selectedPipelineSnapshot?.definition.longitudinalIntent
        : pipelines.get(pipelineId)?.longitudinalIntent) === "initiativeRequired",
    getSelectedPipelineSnapshot: () => selectedPipelineSnapshot
      ? structuredClone(selectedPipelineSnapshot)
      : undefined,
    loadTranscript: () => transcriptStore.load(),
    inspectReadiness,
    refreshPipelines: refreshProgrammaticPipelines,
    configure: configureProgrammatic,
    getResourceDependencyProvenance: () => [...lastResourceDependencyProvenance],
    preflightPipeline: preflightProgrammaticPipeline,
    pipelineRunRefusal,
    resolvePipelineSnapshotInScope: async (scopeRoot, pipelineId, optionsValue = {}) => {
      await awaitInitialization();
      return structuredClone(
        await resolvePipelineSnapshotInScope(scopeRoot, pipelineId, optionsValue),
      );
    },
    resolvePipelineSnapshot: async (pipelineId, optionsValue = {}) => {
      await awaitInitialization();
      return structuredClone(
        await resolvePipelineSnapshotById(pipelineId, optionsValue),
      );
    },
    resetSessions: resetProgrammaticSessions,
    runPipeline: runProgrammaticPipeline,
    resumePipeline: resumeProgrammaticPipeline,
    interrupt: interruptProgrammatic,
    answerSemanticQuestionWithLead,
    isBusy: runtimeIsBusy,
    flush: async () => {
      await awaitInitialization();
      await queueTransitionQueue;
      await transcriptStore.flush();
      await persistNow();
      await persistence.drain();
    },
    shutdownIdleProviders,
    dispose: () => {
      if (disposeOperation) {
        return disposeOperation;
      }
      disposed = true;
      const shutdownTaskId = state.taskId;
      disposeOperation = (async (): Promise<void> => {
        let shutdownFailure: unknown;
        try {
          state.taskId = randomUUID();
          managedTaskState.clear();
          workspaceSubscription.dispose();
          trustSubscription.dispose();
          browserSelectorHealingConfigurationSubscription?.dispose();
          const workflow = activeWorkflow;
          workflowController?.abort();
          foregroundControllers.forEach((controller) => controller.abort());
          gateResolver?.resolve({
            action: "cancel",
            interventions: [...pendingGateInterventions],
          });
          gateResolver = undefined;
          pendingGateInterventions = [];
          activeCodexInput?.cancel();
          await initializePromise;
          // Recording a shutdown must not be able to prevent one. A failed audit write is held
          // and rethrown once the providers, the bridge and the persisted state are dealt with.
          try {
            await cancelAllApprovals("extension shutdown");
            await interruptAgents(Object.keys(adapters));
          } catch (error) {
            shutdownFailure = error;
            logOutput(
              `Failed to record the agent shutdown: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          if (workflow) {
            await workflow.catch(() => undefined);
          }
          if (queueDrainOperation) {
            await queueDrainOperation;
          }
          await Promise.allSettled(Array.from(foregroundOperations));
          await mutationQueue;
          await queueTransitionQueue;
          if (workspaceChangeOperation) {
            await workspaceChangeOperation.catch(() => undefined);
          }
          deltaTimers.forEach((timer) => clearTimeout(timer));
          deltaTimers.clear();
          const adapterResults = await Promise.allSettled(
            Object.values(adapters).map((adapter) => adapter.dispose()),
          );
          const adapterFailure = adapterResults.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          bridgeStatusSubscription?.dispose();
          let bridgeFailure: unknown;
          if (options.closeBridge ?? ownsBridge) {
            try {
              await bridge.close();
            } catch (error) {
              bridgeFailure = error;
            }
          }
          await transcriptStore.flush();
          state.taskId = shutdownTaskId;
          await persistNow();
          await persistence.drain();
          webviews.clear();
          if (adapterFailure) {
            throw adapterFailure.reason;
          }
          if (bridgeFailure) {
            throw bridgeFailure;
          }
        } finally {
          state.taskId = shutdownTaskId;
        }
        if (shutdownFailure) {
          throw shutdownFailure;
        }
      })();
      return disposeOperation;
    },
  };
};
